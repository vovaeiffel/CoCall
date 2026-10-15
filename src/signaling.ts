// src/signaling.ts
// ============================================================
// WebSocket-сервер сигналинга. Запускается ТОЛЬКО на хосте.
// Его задачи:
//  - держать список подключённых клиентов
//  - держать одну комнату и её участников
//  - пересылать offer/answer/ice-кандидаты между участниками
//    (сам звук через этот сервер НЕ идёт — он идёт напрямую)
//  - раздавать всем отметки «кто сейчас говорит»
// ============================================================
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { MAX_FILE_MB, FILE_CHUNK_BYTES, cleanFileName } from './filesettings';
import type { ChatMessage, ClientId, SignalingMessage } from './protocol';

const MAX_PARTICIPANTS = 8; // включая хоста
const MAX_PASSWORD_LENGTH = 64;
/** Чат: длина сообщения, размер истории, защита от спама */
const MAX_CHAT_LENGTH = 500;
const CHAT_HISTORY_SIZE = 100;
const CHAT_BURST = 5;          // не больше 5 сообщений…
const CHAT_BURST_MS = 3000;    // …за 3 секунды
/** Картинки: размер (символов в data:-адресе ≈ 700 КБ), сколько картинок хранится в истории, частота */
const MAX_IMAGE_CHARS = 700_000;
const IMAGES_IN_HISTORY = 5;
const IMAGE_BURST = 3;          // не больше 3 картинок…
const IMAGE_BURST_MS = 10_000;  // …за 10 секунд
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+\/=]+$/;
/** Сколько раз можно ошибиться с паролем, прежде чем адрес заблокируют */
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_FILE_OFFERS_PER_CLIENT = 5;
const MAX_FILE_OFFERS_TOTAL = 100;
const MAX_CHUNK_CHARS = Math.ceil(FILE_CHUNK_BYTES / 3) * 4 + 16;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const MAX_AVATAR_CHARS = 30_000;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const MAX_PASSWORD_ATTEMPTS = 5;
/** На сколько миллисекунд блокируется адрес после слишком многих ошибок */
const PASSWORD_BLOCK_MS = 60_000;

interface Client {
    ws: WebSocket;
    clientId: ClientId;
    username: string;
    isHost: boolean;
    /** true — клиент уже вошёл в комнату (а не просто подключился к серверу) */
    joined: boolean;
    /** IP-адрес, с которого подключился клиент */
    ip: string;
    /** Время последних сообщений чата (защита от спама) */
    chatTimes: number[];
    imageTimes: number[];
    /** Аватар: маленькая картинка (data:-адрес) */
    avatar?: string;
    avatarAt?: number;
    /** Связь оборвалась (не «выход»): место в комнате держим GHOST_MS, вдруг вернётся */
    ghost?: boolean;
    ghostTimer?: ReturnType<typeof setTimeout>;
}

/** Сколько миллисекунд держим место участника, у которого оборвалась связь */
const GHOST_MS = 25_000;
/** Как часто проверяем, что соединения живы */
const HEARTBEAT_MS = 5_000;

/** «::ffff:26.1.2.3» -> «26.1.2.3»; адрес самого компьютера хоста -> «127.0.0.1» */
function normalizeIp(ip: string): string {
    const v4 = ip.replace(/^::ffff:/i, '');
    return v4 === '::1' ? '127.0.0.1' : v4;
}

/** Сколько веб-камер может работать одновременно (видео идёт каждому с каждой камеры) */
const MAX_CAMERAS = 4;

/** Необязательные настройки сервера (нужны, когда он запущен на отдельном сервере в интернете) */
export interface SignalingOptions {
    /** Рассылать участникам список «запасных хостов» (переезд комнаты, если хост пропал). По умолчанию включено. */
    migration?: boolean;
    /** Если задан — создавать комнаты могут только те, кто знает этот ключ */
    createKey?: string;
    /** TURN/STUN-серверы, которые сервер раздаёт участникам при входе в комнату */
    iceServers?: RTCIceServer[];
}

export class SignalingServer {
    private wss: WebSocketServer | null = null;
    /** Файлы, предложенные в чате: id → владелец и размер (сами файлы на сервере не хранятся) */
    private fileOffers = new Map<string, { owner: ClientId; size: number }>();
    /** Идущие передачи: «файл|получатель» → сколько байт уже передано */
    private fileFlows = new Map<string, number>();
    private resetFiles(): void { this.fileOffers.clear(); this.fileFlows.clear(); }
    private readonly port: number;
    private stopping = false;
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    /** clientId -> Client */
    private clients = new Map<ClientId, Client>();

    /** Обратный индекс: WebSocket -> Client (чтобы быстро найти при disconnect) */
    private wsToClient = new Map<WebSocket, Client>();

    /** Кто сейчас показывает экран (не больше одного человека за раз) */
    private screenSharer: { clientId: ClientId; quality: '1080' | '720' | '480' } | null = null;

    /** Кто из участников сейчас смотрит трансляцию экрана */
    private screenViewers = new Set<ClientId>();

    /** У кого сейчас включена веб-камера (не больше MAX_CAMERAS одновременно) */
    private cameras = new Set<ClientId>();

    /** Состояние комнаты (у хоста она одна) */
    private roomName: string | null = null;
    private hostId: ClientId | null = null;
    /** Пароль комнаты хранится не открытым текстом, а в виде хеша (null — пароля нет) */
    /** Ошибки пароля по IP-адресам (защита от перебора) */
    private badPasswords = new Map<string, { count: number; blockedUntil: number }>();
    private wsToIp = new Map<WebSocket, string>();
    private chatHistory: ChatMessage[] = [];
    private passwordHash: Buffer | null = null;
    private passwordSalt: Buffer | null = null;

    private readonly options: SignalingOptions;

    constructor(port: number, options: SignalingOptions = {}) {
        this.port = port;
        this.options = options;
    }

    private sameSecret(a: string, b: string): boolean {
        const ha = createHash('sha256').update(a, 'utf8').digest();
        const hb = createHash('sha256').update(b, 'utf8').digest();
        return timingSafeEqual(ha, hb);
    }

    /** Защита от перебора: адрес, который много раз ошибся, на минуту блокируется */
    private isBlocked(ip: string): boolean {
        const rec = this.badPasswords.get(ip);
        return !!rec && Date.now() < rec.blockedUntil;
    }

    private registerFail(ip: string): void {
        const rec = this.badPasswords.get(ip) ?? { count: 0, blockedUntil: 0 };
        rec.count++;
        if (rec.count >= MAX_PASSWORD_ATTEMPTS) {
            rec.blockedUntil = Date.now() + PASSWORD_BLOCK_MS;
            rec.count = 0;
        }
        this.badPasswords.set(ip, rec);
    }

    private sendIceConfig(ws: WebSocket): void {
        if (this.options.iceServers && this.options.iceServers.length > 0) {
            this.sendRaw(ws, { type: 'ice-config', iceServers: this.options.iceServers });
        }
    }

    /** Запуск сервера. Promise: resolve при успехе, reject при EADDRINUSE и т.п. */
    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            // maxPayload — защита: никто не сможет прислать огромное сообщение
            const wss = new WebSocketServer({ port: this.port, maxPayload: 1024 * 1024 });
            let settled = false;

            wss.once('listening', () => {
                settled = true;
                this.wss = wss;
                this.stopping = false;
                console.log(`🚀 Signaling-сервер слушает порт ${this.port}`);
                this.heartbeat = setInterval(() => this.beat(wss), HEARTBEAT_MS);
                resolve();
            });

            wss.on('error', (err: Error) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                } else {
                    console.error('❌ Ошибка сервера после запуска:', err.message);
                }
            });

            wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
        });
    }

    public stop(): Promise<void> {
        return new Promise((resolve) => {
            const wss = this.wss;
            if (!wss) return resolve();
            this.wss = null;
            this.stopping = true;
            if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }

            // Небольшая пауза, чтобы последние сообщения (например «комната закрыта»)
            // успели дойти до гостей, потом принудительно закрываем все соединения.
            setTimeout(() => {
                wss.clients.forEach((c) => c.terminate());
                wss.close(() => {
                    console.log('🛑 Сервер остановлен');
                    this.clients.forEach((c) => { if (c.ghostTimer) clearTimeout(c.ghostTimer); });
                    this.clients.clear();
                    this.wsToClient.clear();
                    this.roomName = null;
                    this.hostId = null;
                    this.passwordHash = null;
                    this.chatHistory = [];
            this.resetFiles();
                    resolve();
                });
            }, 100);
        });
    }

    // ==========================================================
    // Обработка соединений
    // ==========================================================
    private onConnection(ws: WebSocket, req: IncomingMessage): void {
        this.wsToIp.set(ws, req.socket.remoteAddress ?? 'unknown');
        ws.on('message', (raw: Buffer) => {
            let msg: SignalingMessage;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                console.error('Не JSON:', raw.toString().slice(0, 100));
                return;
            }
            if (!msg || typeof msg !== 'object' || typeof (msg as any).type !== 'string') return;
            try {
                this.handleMessage(ws, msg);
            } catch (err) {
                console.error('Ошибка обработки сообщения:', err);
            }
        });

        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
        ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });
        ws.on('close', (code: number) => { this.handleDisconnect(ws, code); this.wsToIp.delete(ws); });
        ws.on('error', (err) => console.error('WS error:', err.message));
    }

    /** Раз в несколько секунд: убираем «мёртвые» соединения и даём клиентам сигнал, что сервер жив */
    private beat(wss: WebSocketServer): void {
        wss.clients.forEach((c) => {
            const w = c as WebSocket & { isAlive?: boolean };
            if (w.isAlive === false) { c.terminate(); return; }
            w.isAlive = false;
            try { c.ping(); } catch { /* ignore */ }
            this.sendRaw(c, { type: 'ping' });
        });
    }

    private handleMessage(ws: WebSocket, msg: SignalingMessage): void {
        switch (msg.type) {
            case 'register':
                this.onRegister(ws, msg.clientId, msg.username);
                break;
            case 'create-room':
                this.onCreateRoom(ws, msg.roomName, msg.password, msg.createKey, msg.history);
                break;
            case 'join-room':
                this.onJoinRoom(ws, msg.roomName, msg.password);
                break;
            case 'leave-room': {
                const sender = this.wsToClient.get(ws);
                if (sender) this.onHostStepOut(sender);
                break;
            }
            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                // Пересылаем только от вошедших в комнату и подписываем настоящим отправителем
                // (чтобы нельзя было выдать себя за другого).
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                this.routeTo(msg.to, { ...msg, from: sender.clientId });
                break;
            }
            case 'chat-send': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                this.onChat(sender, msg.text, msg.image, msg.file);
                break;
            }
            case 'set-avatar': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                const now = Date.now();
                if (sender.avatarAt && now - sender.avatarAt < 1500) return; // не чаще раза в 1,5 с
                const a = msg.avatar;
                if (a === null) sender.avatar = undefined;
                else if (typeof a === 'string' && a.length <= MAX_AVATAR_CHARS && AVATAR_RE.test(a)) sender.avatar = a;
                else return;
                sender.avatarAt = now;
                this.broadcastParticipants();
                break;
            }
            case 'file-request':
            case 'file-chunk':
            case 'file-ack':
            case 'file-cancel': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                this.onFileMessage(sender, msg);
                break;
            }
            case 'kick':
                this.onKick(ws, msg.targetClientId);
                break;
            case 'speaking': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                // Не доверяем clientId из сообщения: сервер сам знает, кто отправитель.
                this.broadcastSpeaking(sender.clientId, msg.speaking === true);
                break;
            }
            case 'camera-set': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                this.onCameraSet(sender, (msg as { on?: unknown }).on === true);
                break;
            }
            case 'screen-start': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                this.onScreenStart(sender, msg.quality);
                break;
            }
            case 'screen-watch': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                this.onScreenWatch(sender, msg.watching === true);
                break;
            }
            case 'screen-stop': {
                const sender = this.wsToClient.get(ws);
                if (!sender || !sender.joined) return;
                if (this.screenSharer?.clientId === sender.clientId) this.clearScreenShare();
                break;
            }
            default:
                // прочие типы сервер не принимает от клиентов — игнорируем
                break;
        }
    }

    // ==========================================================
    // Команды от клиентов
    // ==========================================================
    private onRegister(ws: WebSocket, clientId: ClientId, username: string): void {
        if (typeof clientId !== 'string' || !clientId) return;
        const name = String(username ?? '').trim().slice(0, 32) || 'Без имени';

        // Вернулся участник, у которого оборвалась связь: отдаём ему его место
        const ghost = this.clients.get(clientId);
        if (ghost && ghost.ghost) {
            if (ghost.ghostTimer) clearTimeout(ghost.ghostTimer);
            ghost.ghost = false;
            ghost.ghostTimer = undefined;
            ghost.ws = ws;
            ghost.username = name;
            ghost.ip = this.wsToIp.get(ws) ?? ghost.ip;
            this.wsToClient.set(ws, ghost);
            console.log(`🔁 ${name} вернулся после обрыва связи`);
            this.sendRoomListTo(ws);
            return;
        }

        // Если такой клиент уже был (переподключение) — старое соединение выбрасываем
        const old = this.clients.get(clientId);
        if (old && old.ws !== ws) {
            this.wsToClient.delete(old.ws);
            this.clients.delete(clientId);
            if (clientId === this.hostId) {
                this.roomName = null;
                this.hostId = null;
                this.passwordHash = null;
                this.chatHistory = [];
            this.resetFiles();
            }
            try { old.ws.terminate(); } catch { /* ignore */ }
        }

        const client: Client = { ws, clientId, username: name, isHost: false, joined: false, ip: this.wsToIp.get(ws) ?? 'unknown', chatTimes: [], imageTimes: [] };
        this.clients.set(clientId, client);
        this.wsToClient.set(ws, client);
        console.log(`👤 Зарегистрирован: ${name} (${clientId.slice(0, 8)})`);
        this.sendRoomListTo(ws);
    }

    private hashPassword(password: string, salt: Buffer): Buffer {
        return createHash('sha256').update(salt).update(password, 'utf8').digest();
    }

    private onCreateRoom(ws: WebSocket, roomName: string, password?: string, createKey?: string, history?: unknown): void {
        const client = this.wsToClient.get(ws);
        if (!client) return;

        if (this.options.createKey) {
            if (this.isBlocked(client.ip)) {
                this.sendError(ws, 'Слишком много неверных попыток. Подождите минуту.');
                return;
            }
            if (typeof createKey !== 'string' || !this.sameSecret(createKey, this.options.createKey)) {
                this.registerFail(client.ip);
                console.log(`🔒 ${client.username} (${client.ip}): неверный ключ создания комнаты`);
                this.sendError(ws, 'Неверный ключ создания комнаты');
                return;
            }
        }

        if (this.hostId === client.clientId) {
            this.sendError(ws, 'У вас уже есть открытая комната');
            return;
        }
        if (this.roomName !== null) {
            this.sendError(ws, 'Комната уже создана на этом сервере');
            return;
        }

        const name = String(roomName ?? '').trim().slice(0, 64);
        if (!name) {
            this.sendError(ws, 'Пустое название комнаты');
            return;
        }

        this.roomName = name;
        this.hostId = client.clientId;
        const pw = typeof password === 'string' ? password.slice(0, MAX_PASSWORD_LENGTH) : '';
        if (pw) {
            this.passwordSalt = randomBytes(16);
            this.passwordHash = this.hashPassword(pw, this.passwordSalt);
        } else {
            this.passwordSalt = null;
            this.passwordHash = null;
        }
        this.chatHistory = [];
        this.resetFiles();
        // Комната «переехала» на нового хоста: он приносит с собой переписку, чтобы она не пропала
        if (Array.isArray(history)) {
            for (const m of history.slice(-CHAT_HISTORY_SIZE)) {
                const r = m as Partial<ChatMessage> | null;
                if (!r || typeof r.id !== 'string' || typeof r.from !== 'string' || typeof r.username !== 'string' || typeof r.text !== 'string' || typeof r.ts !== 'number') continue;
                const keep: ChatMessage = { id: r.id.slice(0, 64), from: r.from.slice(0, 64), username: r.username.slice(0, 32), text: r.text.slice(0, MAX_CHAT_LENGTH), ts: r.ts };
                if (typeof r.image === 'string' && r.image.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(r.image)) keep.image = r.image;
                else if (r.imageExpired || r.image) keep.imageExpired = true;
                this.chatHistory.push(keep);
            }
        }
        client.isHost = true;
        client.joined = true;
        this.sendIceConfig(ws);
        console.log(`🏠 Комната «${name}» создана${this.passwordHash ? ' (с паролем)' : ''}. Хост: ${client.username}`);

        this.broadcastParticipants();
    }

    private onJoinRoom(ws: WebSocket, roomName: string, password?: string): void {
        const client = this.wsToClient.get(ws);
        if (!client) return;

        if (this.roomName === null || this.roomName !== roomName || this.hostId === null) {
            this.sendError(ws, 'Комната не найдена');
            return;
        }

        if (client.joined) {
            // Повторный вход после обрыва связи: просто пересылаем текущее состояние комнаты
            this.sendIceConfig(ws);
            this.sendChatHistory(ws);
            this.sendScreenStateTo(ws);
            this.sendCamerasTo(ws);
            this.broadcastParticipants();
            return;
        }

        // Хозяин комнаты возвращается к себе: пароль и лимит ему не нужны
        if (client.clientId === this.hostId) {
            client.joined = true;
            this.sendIceConfig(ws);
            this.sendChatHistory(ws);
            this.sendScreenStateTo(ws);
            this.sendCamerasTo(ws);
            console.log(`🏠 ${client.username} (хост) вернулся в комнату`);
            this.broadcastParticipants();
            return;
        }

        // Проверка пароля (если комната им защищена)
        if (this.passwordHash && this.passwordSalt) {
            if (this.isBlocked(client.ip)) {
                this.sendError(ws, 'Слишком много неверных попыток. Подождите минуту.');
                return;
            }
            const given = typeof password === 'string' ? password.slice(0, MAX_PASSWORD_LENGTH) : '';
            const ok = timingSafeEqual(this.hashPassword(given, this.passwordSalt), this.passwordHash);
            if (!ok) {
                this.registerFail(client.ip);
                console.log(`🔒 ${client.username} (${client.ip}): неверный пароль`);
                this.sendError(ws, 'Неверный пароль');
                return;
            }
            this.badPasswords.delete(client.ip);
        }

        if (this.joinedCount() >= MAX_PARTICIPANTS) {
            this.sendError(ws, 'Комната заполнена');
            return;
        }

        client.joined = true;
        this.sendIceConfig(ws);
        this.sendChatHistory(ws);
        this.sendScreenStateTo(ws);
        this.sendCamerasTo(ws);
        console.log(`🚪 ${client.username} вошёл в комнату`);

        // Все (включая нового участника) получают свежий список.
        // Дальше клиенты сами соединяются друг с другом по этому списку.
        this.broadcastParticipants();
    }

    private onChat(sender: Client, rawText: unknown, rawImage?: unknown, rawFile?: unknown): void {
        const text = typeof rawText === 'string'
            ? rawText.replace(/\r\n?/g, '\n').trim().slice(0, MAX_CHAT_LENGTH)
            : '';

        // Картинка: только настоящие png / jpeg / webp / gif и не больше лимита
        let image: string | undefined;
        if (rawImage !== undefined && rawImage !== null) {
            if (typeof rawImage !== 'string' || rawImage.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(rawImage)) return;
            image = rawImage;
        }
        // Файл: имя и размер проверяем; сам файл через сервер не хранится
        let file: { name: string; size: number } | undefined;
        if (rawFile !== undefined && rawFile !== null) {
            const f = rawFile as { name?: unknown; size?: unknown };
            const name = cleanFileName(f.name);
            const size = f.size;
            if (!name || typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES) return;
            file = { name, size };
            image = undefined;
        }
        if (!text && !image && !file) return;

        // Защита от спама: не больше CHAT_BURST сообщений за CHAT_BURST_MS (и отдельно — картинок)
        const now = Date.now();
        sender.chatTimes = sender.chatTimes.filter((t) => now - t < CHAT_BURST_MS);
        if (sender.chatTimes.length >= CHAT_BURST) return;
        if (image) {
            sender.imageTimes = sender.imageTimes.filter((t) => now - t < IMAGE_BURST_MS);
            if (sender.imageTimes.length >= IMAGE_BURST) return;
            sender.imageTimes.push(now);
        }
        sender.chatTimes.push(now);

        const message: ChatMessage = {
            id: randomBytes(6).toString('hex'),
            from: sender.clientId,
            username: sender.username,
            text,
            ts: now,
            ...(image ? { image } : {}),
            ...(file ? { file } : {}),
        };

        // Всем участникам — сообщение целиком
        this.clients.forEach((c) => {
            if (c.joined) this.sendRaw(c.ws, { type: 'chat', message });
        });

        // Файлы в историю не попадают («без истории»): предложение живёт, пока отправитель в комнате
        if (file) {
            let mine = 0;
            for (const [id, o] of this.fileOffers) {
                if (o.owner === sender.clientId && ++mine >= MAX_FILE_OFFERS_PER_CLIENT) { this.fileOffers.delete(id); mine--; break; }
            }
            if (this.fileOffers.size >= MAX_FILE_OFFERS_TOTAL) {
                const first = this.fileOffers.keys().next().value;
                if (first !== undefined) this.fileOffers.delete(first);
            }
            this.fileOffers.set(message.id, { owner: sender.clientId, size: file.size });
            return;
        }

        // В историю — копия; у старых картинок сами картинки удаляем (чтобы не копить память)
        this.chatHistory.push({ ...message });
        if (this.chatHistory.length > CHAT_HISTORY_SIZE) this.chatHistory.shift();
        let kept = 0;
        for (let i = this.chatHistory.length - 1; i >= 0; i--) {
            const m = this.chatHistory[i];
            if (!m.image) continue;
            kept++;
            if (kept > IMAGES_IN_HISTORY) {
                delete m.image;
                m.imageExpired = true;
            }
        }
    }

    /** Передача файла между участниками (сервер только пересылает порции и следит за правилами) */
    private onFileMessage(sender: Client, msg: SignalingMessage): void {
        if (msg.type !== 'file-request' && msg.type !== 'file-chunk' && msg.type !== 'file-ack' && msg.type !== 'file-cancel') return;
        if (typeof msg.to !== 'string' || typeof msg.fileId !== 'string') return;
        const offer = this.fileOffers.get(msg.fileId);
        const target = this.clients.get(msg.to);
        if (!target || !target.joined) {
            if (msg.type === 'file-request') {
                this.sendRaw(sender.ws, { type: 'file-cancel', to: sender.clientId, from: msg.to, fileId: msg.fileId, reason: 'Отправитель сейчас не в комнате' });
            }
            return;
        }
        const fail = (reason: string) => {
            // Прекращаем передачу и сообщаем обеим сторонам
            this.fileFlows.delete(`${msg.fileId}|${msg.to}`);
            this.sendRaw(target.ws, { type: 'file-cancel', to: target.clientId, from: sender.clientId, fileId: msg.fileId, reason });
            this.sendRaw(sender.ws, { type: 'file-cancel', to: sender.clientId, from: target.clientId, fileId: msg.fileId, reason });
        };
        const owner = offer?.owner;
        switch (msg.type) {
            case 'file-request':
                // просить можно только у владельца, и только то, что он предложил
                if (!offer || offer.owner !== msg.to || sender.clientId === msg.to) {
                    this.sendRaw(sender.ws, { type: 'file-cancel', to: sender.clientId, from: msg.to, fileId: msg.fileId, reason: 'Файл больше недоступен' });
                    return;
                }
                this.fileFlows.set(`${msg.fileId}|${sender.clientId}`, 0);
                this.sendRaw(target.ws, { type: 'file-request', to: msg.to, from: sender.clientId, fileId: msg.fileId });
                return;
            case 'file-chunk': {
                if (!offer || owner !== sender.clientId) return;
                const key = `${msg.fileId}|${msg.to}`;
                const sent = this.fileFlows.get(key);
                if (sent === undefined) return; // получатель не просил
                if (typeof msg.data !== 'string' || msg.data.length > MAX_CHUNK_CHARS || !BASE64_RE.test(msg.data)
                    || !Number.isInteger(msg.seq) || msg.seq < 0) { fail('Ошибка передачи'); return; }
                const total = sent + Math.floor(msg.data.length * 3 / 4);
                if (total > offer.size + 3) { fail('Размер файла не совпал'); return; }
                if (msg.last === true) this.fileFlows.delete(key); else this.fileFlows.set(key, total);
                this.sendRaw(target.ws, { type: 'file-chunk', to: msg.to, from: sender.clientId, fileId: msg.fileId, seq: msg.seq, data: msg.data, last: msg.last === true });
                return;
            }
            case 'file-ack':
                if (!offer || owner !== msg.to) return;
                this.sendRaw(target.ws, { type: 'file-ack', to: msg.to, from: sender.clientId, fileId: msg.fileId, seq: Number(msg.seq) || 0 });
                return;
            case 'file-cancel':
                this.fileFlows.delete(`${msg.fileId}|${sender.clientId === owner ? msg.to : sender.clientId}`);
                this.sendRaw(target.ws, { type: 'file-cancel', to: msg.to, from: sender.clientId, fileId: msg.fileId, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 100) : undefined });
                return;
        }
    }

    /** Хост вышел из голосовой комнаты, но сам остался подключённым: комната открыта */
    private onHostStepOut(client: Client): void {
        if (client.clientId !== this.hostId || !client.joined) return;
        client.joined = false;
        if (this.screenSharer?.clientId === client.clientId) this.clearScreenShare();
        else if (this.screenViewers.delete(client.clientId)) this.broadcastScreenViewers();
        this.dropCamera(client.clientId);
        console.log(`🏠 ${client.username} (хост) вышел из комнаты, комната остаётся открытой`);
        this.broadcastParticipants();
    }

    // ==========================================================
    // Трансляция экрана: показывать может один человек за раз.
    // Сам видеопоток идёт напрямую между участниками, сервер только
    // следит, кто сейчас показывает.
    // ==========================================================
    private onScreenStart(sender: Client, rawQuality: unknown): void {
        const quality = rawQuality === '1080' || rawQuality === '480' ? rawQuality : '720';
        if (this.screenSharer && this.screenSharer.clientId !== sender.clientId) {
            const other = this.clients.get(this.screenSharer.clientId);
            this.sendRaw(sender.ws, {
                type: 'screen-denied',
                message: `Сейчас экран показывает ${other ? other.username : 'другой участник'}. Подождите, пока он закончит.`,
            });
            return;
        }
        const isNew = !this.screenSharer;
        this.screenSharer = { clientId: sender.clientId, quality };
        if (isNew) {
            this.screenViewers.clear(); // новая трансляция — пока никто не смотрит
            console.log(`🖥️ ${sender.username} показывает экран (${quality}p)`);
        }
        this.broadcastScreenShare(sender.clientId, sender.username, true, quality);
        if (isNew) this.broadcastScreenViewers();
    }

    private clearScreenShare(): void {
        const cur = this.screenSharer;
        if (!cur) return;
        this.screenSharer = null;
        this.screenViewers.clear();
        const c = this.clients.get(cur.clientId);
        console.log(`🖥️ ${c ? c.username : 'участник'} закончил показ экрана`);
        this.broadcastScreenShare(cur.clientId, c ? c.username : '', false);
    }

    private broadcastScreenShare(from: ClientId, username: string, sharing: boolean, quality?: '1080' | '720' | '480'): void {
        const msg = { type: 'screen-share', sharing, from, username, ...(quality ? { quality } : {}) };
        this.clients.forEach((c) => {
            if (c.joined) this.sendRaw(c.ws, msg);
        });
    }

    private onScreenWatch(sender: Client, watching: boolean): void {
        const cur = this.screenSharer;
        if (!cur || cur.clientId === sender.clientId) return;
        const had = this.screenViewers.has(sender.clientId);
        if (watching === had) return;
        if (watching) this.screenViewers.add(sender.clientId);
        else this.screenViewers.delete(sender.clientId);
        this.broadcastScreenViewers();
    }

    private broadcastScreenViewers(): void {
        const msg = { type: 'screen-viewers', viewers: Array.from(this.screenViewers) };
        this.clients.forEach((c) => {
            if (c.joined) this.sendRaw(c.ws, msg);
        });
    }

    /** Вошедшему: рассказать, показывает ли уже кто-то экран */
    private sendScreenStateTo(ws: WebSocket): void {
        const cur = this.screenSharer;
        if (!cur) return;
        const c = this.clients.get(cur.clientId);
        if (!c) return;
        this.sendRaw(ws, { type: 'screen-share', sharing: true, from: cur.clientId, username: c.username, quality: cur.quality });
        this.sendRaw(ws, { type: 'screen-viewers', viewers: Array.from(this.screenViewers) });
    }

    // ==========================================================
    // Веб-камеры: видео идёт напрямую между участниками, сервер только
    // следит, у кого камера включена, и не даёт включить больше MAX_CAMERAS.
    // ==========================================================
    private onCameraSet(sender: Client, on: boolean): void {
        const had = this.cameras.has(sender.clientId);
        if (on) {
            if (!had && this.cameras.size >= MAX_CAMERAS) {
                this.sendRaw(sender.ws, {
                    type: 'camera-denied',
                    message: `В комнате уже включено ${MAX_CAMERAS} камеры — это максимум. Подождите, пока кто-то выключит.`,
                });
                this.sendRaw(sender.ws, { type: 'cameras', ids: Array.from(this.cameras) });
                return;
            }
            this.cameras.add(sender.clientId);
        } else {
            this.cameras.delete(sender.clientId);
        }
        if (on !== had) this.broadcastCameras();
    }

    private dropCamera(id: ClientId): void {
        if (this.cameras.delete(id)) this.broadcastCameras();
    }

    private broadcastCameras(): void {
        const msg = { type: 'cameras', ids: Array.from(this.cameras) };
        this.clients.forEach((c) => {
            if (c.joined) this.sendRaw(c.ws, msg);
        });
    }

    private sendCamerasTo(ws: WebSocket): void {
        if (this.cameras.size > 0) this.sendRaw(ws, { type: 'cameras', ids: Array.from(this.cameras) });
    }

    private sendChatHistory(ws: WebSocket): void {
        if (this.chatHistory.length > 0) {
            this.sendRaw(ws, { type: 'chat-history', messages: this.chatHistory });
        }
    }

    private onKick(ws: WebSocket, targetClientId: ClientId): void {
        const requester = this.wsToClient.get(ws);
        if (!requester || !requester.isHost) return; // только хост может

        const target = this.clients.get(targetClientId);
        if (!target || target === requester) return;

        this.sendRaw(target.ws, { type: 'kicked', reason: 'Вас выгнал хост' });
        target.ws.close();
    }

    // ==========================================================
    // Роутинг сообщений
    // ==========================================================
    /** Отправить сообщение конкретному clientId */
    private routeTo(to: ClientId, msg: SignalingMessage): void {
        const target = this.clients.get(to);
        if (!target || !target.joined) return;
        this.sendRaw(target.ws, msg);
    }

    /** Передать состояние «говорит / молчит» всем участникам комнаты, кроме самого отправителя */
    private broadcastSpeaking(from: ClientId, speaking: boolean): void {
        this.clients.forEach((c) => {
            if (c.joined && c.clientId !== from) {
                this.sendRaw(c.ws, { type: 'speaking', from, speaking });
            }
        });
    }

    private sendRaw(ws: WebSocket, msg: object): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    private sendError(ws: WebSocket, message: string): void {
        this.sendRaw(ws, { type: 'error', message });
    }

    /** Сколько гостей (без хоста) сейчас в комнате */
    private guestCount(): number {
        let n = 0;
        this.clients.forEach((c) => { if (c.joined && c.clientId !== this.hostId) n++; });
        return n;
    }

    private joinedCount(): number {
        let n = 0;
        this.clients.forEach((c) => { if (c.joined) n++; });
        return n;
    }

    // ==========================================================
    // Отключения
    // ==========================================================
    private handleDisconnect(ws: WebSocket, code = 1005): void {
        if (this.stopping) return;
        const client = this.wsToClient.get(ws);
        if (!client) return;

        this.wsToClient.delete(ws);
        // Обрыв связи (код 1006), а не нормальный выход: держим место, вдруг человек сейчас вернётся
        if (client.joined && code === 1006 && this.clients.get(client.clientId) === client) {
            client.ghost = true;
            console.log(`📡 У ${client.username} оборвалась связь, ждём возвращения (${GHOST_MS / 1000} с)`);
            client.ghostTimer = setTimeout(() => { client.ghost = false; this.finalizeDisconnect(client); }, GHOST_MS);
            return;
        }
        this.finalizeDisconnect(client);
    }

    private finalizeDisconnect(client: Client): void {
        if (this.stopping) return;
        if (this.clients.get(client.clientId) === client) {
            this.clients.delete(client.clientId);
        }

        if (client.clientId === this.hostId) {
            // Хост ушёл — комната закрывается
            this.passwordHash = null;
            this.chatHistory = [];
            this.resetFiles();
            this.screenSharer = null;
            this.screenViewers.clear();
            this.cameras.clear();
            console.log('🏠 Хост отключился, комната закрыта');
            const closedName = this.roomName;
            this.roomName = null;
            this.hostId = null;
            this.clients.forEach((c) => {
                if (c.joined) {
                    c.joined = false;
                    this.sendRaw(c.ws, { type: 'room-closed', roomName: closedName });
                }
            });
        } else if (client.joined) {
            if (this.screenSharer?.clientId === client.clientId) this.clearScreenShare();
            else if (this.screenViewers.delete(client.clientId)) this.broadcastScreenViewers();
            this.dropCamera(client.clientId);
            console.log(`🚪 ${client.username} отключился`);
            this.broadcastParticipants();
        }
    }

    // ==========================================================
    // Списки
    // ==========================================================
    private sendRoomListTo(ws: WebSocket): void {
        if (!this.roomName || this.hostId === null) {
            this.sendRaw(ws, { type: 'room-list', rooms: [] });
            return;
        }
        const host = this.clients.get(this.hostId);
        this.sendRaw(ws, {
            type: 'room-list',
            rooms: [{
                name: this.roomName,
                host: host?.username ?? 'Unknown',
                guestCount: this.guestCount(),
                memberCount: this.joinedCount(),
                hostPresent: !!host?.joined,
                hasPassword: this.passwordHash !== null,
            }],
        });
    }

    private broadcastParticipants(): void {
        if (!this.roomName || this.hostId === null) return;

        const host = this.clients.get(this.hostId);
        if (!host) return;

        // Хост в списке только пока он сам в комнате; если вышел — комната открыта, но без него
        const participants: Array<{ clientId: ClientId; username: string; isHost: boolean; avatar?: string }> = [];
        if (host.joined) participants.push({ clientId: host.clientId, username: host.username, isHost: true, ...(host.avatar ? { avatar: host.avatar } : {}) });
        this.clients.forEach((c) => {
            if (c.joined && c.clientId !== this.hostId) {
                participants.push({ clientId: c.clientId, username: c.username, isHost: false, ...(c.avatar ? { avatar: c.avatar } : {}) });
            }
        });

        const msg = JSON.stringify({
            type: 'participants',
            roomName: this.roomName,
            participants,
        } satisfies SignalingMessage);

        this.clients.forEach((c) => {
            if (c.joined && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
        });

        // Хост, который вышел из комнаты, видит на главном экране, сколько людей в ней сейчас
        if (!host.joined) this.sendRoomListTo(host.ws);
        this.broadcastBackup();
    }

    /**
     * Участникам: «запасные хосты» по порядку входа и их адреса. Если хост пропадёт
     * (нет интернета, выключили свет), первый из списка поднимет комнату у себя.
     */
    private broadcastBackup(): void {
        if (this.options.migration === false || this.hostId === null) return;
        const successors: Array<{ clientId: ClientId; username: string; address: string }> = [];
        this.clients.forEach((c) => {
            if (!c.joined || c.ghost || c.clientId === this.hostId) return;
            successors.push({ clientId: c.clientId, username: c.username, address: normalizeIp(c.ip) });
        });
        const msg = JSON.stringify({ type: 'backup', successors });
        this.clients.forEach((c) => {
            if (c.joined && !c.ghost && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
        });
    }
}
