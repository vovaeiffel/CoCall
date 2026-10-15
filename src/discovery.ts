// src/discovery.ts
// ============================================================
// Автопоиск комнат в вашей сети (домашняя сеть, Radmin VPN, Hamachi…).
//
// Хозяин открытой комнаты каждые несколько секунд рассылает по сети
// короткое объявление (UDP-«широковещательное» сообщение). Остальные
// приложения в той же сети слушают эти объявления и показывают комнаты
// на главном экране. Пароли не передаются — только название, имя хозяина,
// число людей и признак «есть пароль».
//
// Тем же способом работает «Чат сети» на главном экране: короткие сообщения и
// отметка «я в сети» рассылаются по той же сети. Сообщения хранятся только в памяти
// и пропадают при закрытии приложения. Видят их только те, кто в одной сети с вами.
// ============================================================
import dgram from 'dgram';
import os from 'os';

/** Порт для объявлений (не путать с портом комнаты 8080) */
export const DISCOVERY_PORT = 47831;
const ANNOUNCE_EVERY_MS = 3000;
const EXPIRE_AFTER_MS = 10000;
const MAX_ROOMS = 50;

// ---- Чат сети ----
/** Самое длинное сообщение (в символах). С запасом помещается в один сетевой пакет */
export const LOBBY_MAX_TEXT = 400;
const LOBBY_MAX_NAME = 32;
const LOBBY_HISTORY = 100;
const LOBBY_MAX_PEERS = 100;
/** Сколько своих сообщений можно отправить за окно времени */
const SEND_LIMIT = 5;
const SEND_WINDOW_MS = 5000;
/** Сколько сообщений принимаем от одного отправителя за окно времени (защита от спама из сети) */
const RECV_LIMIT = 8;
const RECV_WINDOW_MS = 10000;
const MAX_PACKET = 1400;

export interface LobbyMessage {
    seq: number;
    id: string;
    name: string;
    text: string;
    ts: number;
    own: boolean;
}

export interface LobbyPeer {
    id: string;
    name: string;
}

export interface LobbyState {
    messages: LobbyMessage[];
    peers: LobbyPeer[];
    seq: number;
}

/** Убирает управляющие символы и лишние пробелы, обрезает до нужной длины */
export function cleanLobbyText(raw: unknown, max: number): string {
    if (typeof raw !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const t = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim();
    return Array.from(t).slice(0, max).join('');
}

type LobbyPacket =
    | { kind: 'here'; id: string; name: string }
    | { kind: 'chat'; id: string; name: string; text: string; mid: string };

export interface RoomAnnouncement {
    /** Постоянный номер хозяина на время работы приложения (чтобы не показывать свою комнату самому себе) */
    id: string;
    name: string;
    host: string;
    port: number;
    hasPassword: boolean;
    members: number;
}

export interface NearbyRoom extends RoomAnnouncement {
    /** Адрес, по которому можно подключиться (IP хозяина в той сети, откуда пришло объявление) */
    address: string;
}

interface Seen {
    room: NearbyRoom;
    lastSeen: number;
}

function ipToInt(ip: string): number {
    return ip.split('.').reduce((acc, p) => ((acc << 8) | (parseInt(p, 10) & 255)) >>> 0, 0) >>> 0;
}

function intToIp(n: number): string {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Широковещательные адреса всех сетей этого компьютера (в том числе виртуальных, как Radmin) */
export function broadcastTargets(): string[] {
    const out = new Set<string>(['255.255.255.255']);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const i of ifaces[name] || []) {
            const isV4 = i.family === 'IPv4' || (i.family as unknown) === 4;
            if (!isV4 || i.internal || !i.netmask) continue;
            if (/^169\.254\./.test(i.address)) continue;
            const bc = (ipToInt(i.address) | (~ipToInt(i.netmask) >>> 0)) >>> 0;
            out.add(intToIp(bc));
        }
    }
    return Array.from(out);
}

function parseJson(buf: Buffer): Record<string, unknown> | null {
    if (buf.length > MAX_PACKET) return null;
    let m: unknown;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return null; }
    const o = m as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.app !== 'cocall' || o.v !== 1) return null;
    return o;
}

function parseLobby(o: Record<string, unknown>): LobbyPacket | null {
    const { id, name } = o;
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    if (typeof name !== 'string') return null;
    const nm = cleanLobbyText(name, LOBBY_MAX_NAME).replace(/\n/g, ' ');
    if (!nm) return null;
    if (o.t === 'here') return { kind: 'here', id, name: nm };
    if (o.t === 'chat') {
        const text = cleanLobbyText(o.text, LOBBY_MAX_TEXT);
        const mid = o.mid;
        if (!text || typeof mid !== 'string' || !mid || mid.length > 64) return null;
        return { kind: 'chat', id, name: nm, text, mid };
    }
    return null;
}

function parse(o: Record<string, unknown>): RoomAnnouncement | null {
    if (o.t !== undefined) return null;
    const { id, name, host, port, hasPassword, members } = o;
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    if (typeof name !== 'string' || !name || name.length > 64) return null;
    if (typeof host !== 'string' || host.length > 32) return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    if (typeof hasPassword !== 'boolean') return null;
    if (typeof members !== 'number' || !Number.isInteger(members) || members < 0 || members > 99) return null;
    return { id, name, host, port, hasPassword, members };
}

export class Discovery {
    private socket: dgram.Socket | null = null;
    private timer: NodeJS.Timeout | null = null;
    private current: RoomAnnouncement | null = null;
    private seen = new Map<string, Seen>();
    private readonly targets: (() => string[]) | null;

    // Чат сети
    private lobbyId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    private lobbyName = '';
    private lobbySeq = 0;
    private lobbyMsgs: LobbyMessage[] = [];
    private lobbyPeers = new Map<string, { name: string; lastSeen: number }>();
    private seenMids = new Set<string>();
    private sentAt: number[] = [];
    private recvAt = new Map<string, number[]>();

    /** targets — только для проверок: куда слать вместо реальных сетей */
    constructor(opts?: { targets?: string[] }) {
        this.targets = opts?.targets ? () => opts.targets as string[] : null;
    }

    /** Начать слушать объявления других */
    start(): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                s.on('error', () => { /* автопоиск — необязательная возможность */ });
                s.on('message', (buf, rinfo) => this.onMessage(buf, rinfo.address));
                s.once('error', () => resolve(false));
                s.bind(DISCOVERY_PORT, () => {
                    try { s.setBroadcast(true); } catch { /* ignore */ }
                    this.socket = s;
                    this.timer = setInterval(() => this.tick(), ANNOUNCE_EVERY_MS);
                    resolve(true);
                });
            } catch {
                resolve(false);
            }
        });
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        try { this.socket?.close(); } catch { /* ignore */ }
        this.socket = null;
        this.current = null;
        this.seen.clear();
        this.lobbyPeers.clear();
    }

    /** Объявлять нашу комнату (null — перестать) */
    announce(room: RoomAnnouncement | null): void {
        this.current = room;
        if (room) this.tick();
    }

    /** Комнаты других, которые сейчас видны */
    nearby(): NearbyRoom[] {
        const now = Date.now();
        const out: NearbyRoom[] = [];
        for (const [id, s] of this.seen) {
            if (now - s.lastSeen > EXPIRE_AFTER_MS) this.seen.delete(id);
            else out.push(s.room);
        }
        return out;
    }

    private onMessage(buf: Buffer, address: string): void {
        const o = parseJson(buf);
        if (!o) return;
        if (o.t !== undefined) { this.onLobbyPacket(o); return; }
        const a = parse(o);
        if (!a) return;
        const prev = this.seen.get(a.id);
        if (!prev && this.seen.size >= MAX_ROOMS) return;
        // Пока объявления идут с того же адреса — не меняем его; если пропали — берём новый
        const keepAddr = prev && Date.now() - prev.lastSeen <= EXPIRE_AFTER_MS ? prev.room.address : address;
        this.seen.set(a.id, { room: { ...a, address: keepAddr }, lastSeen: Date.now() });
    }

    private tick(): void {
        const c = this.current;
        if (c) this.broadcast({ app: 'cocall', v: 1, ...c });
        if (this.lobbyName) this.broadcast({ app: 'cocall', v: 1, t: 'here', id: this.lobbyId, name: this.lobbyName });
        const now = Date.now();
        for (const [id, p] of this.lobbyPeers) if (now - p.lastSeen > EXPIRE_AFTER_MS) this.lobbyPeers.delete(id);
        for (const [id, arr] of this.recvAt) {
            if (!arr.length || now - arr[arr.length - 1] > RECV_WINDOW_MS) this.recvAt.delete(id);
        }
    }

    private broadcast(obj: Record<string, unknown>): void {
        const s = this.socket;
        if (!s) return;
        const data = Buffer.from(JSON.stringify(obj), 'utf8');
        if (data.length > MAX_PACKET) return;
        const targets = this.targets ? this.targets() : broadcastTargets();
        for (const t of targets) {
            try { s.send(data, DISCOVERY_PORT, t, () => { /* ошибки сети не важны */ }); } catch { /* ignore */ }
        }
    }

    // ------------------------------------------------------------
    // Чат сети
    // ------------------------------------------------------------

    /** Задать своё имя в чате сети (пустое — выйти из чата: не показываться и не писать) */
    setLobbyName(name: unknown): void {
        const nm = cleanLobbyText(name, LOBBY_MAX_NAME).replace(/\n/g, ' ');
        const was = this.lobbyName;
        this.lobbyName = nm;
        if (nm && nm !== was) this.tick(); // сразу сообщить сети, что мы здесь
    }

    /** Отправить сообщение всем в сети. Возвращает причину отказа, если не вышло */
    sendLobby(text: unknown): { ok: boolean; error?: 'no-name' | 'empty' | 'too-fast' | 'too-long' | 'offline' } {
        if (!this.lobbyName) return { ok: false, error: 'no-name' };
        if (!this.socket) return { ok: false, error: 'offline' };
        const clean = cleanLobbyText(text, LOBBY_MAX_TEXT);
        if (!clean) return { ok: false, error: 'empty' };
        const now = Date.now();
        const mid = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const packet = { app: 'cocall', v: 1, t: 'chat', id: this.lobbyId, name: this.lobbyName, text: clean, mid };
        // Сообщение должно поместиться в один сетевой пакет (много эмодзи занимают больше места)
        if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > MAX_PACKET) return { ok: false, error: 'too-long' };
        this.sentAt = this.sentAt.filter((x) => now - x < SEND_WINDOW_MS);
        if (this.sentAt.length >= SEND_LIMIT) return { ok: false, error: 'too-fast' };
        this.sentAt.push(now);
        this.pushMessage({ id: this.lobbyId, name: this.lobbyName, text: clean, own: true });
        this.broadcast(packet);
        return { ok: true };
    }

    /** Новые сообщения (с номером больше since) и кто сейчас в сети */
    lobby(since: number): LobbyState {
        const now = Date.now();
        const peers: LobbyPeer[] = [];
        for (const [id, p] of this.lobbyPeers) {
            if (now - p.lastSeen <= EXPIRE_AFTER_MS) peers.push({ id, name: p.name });
        }
        const s = Number.isFinite(since) ? since : 0;
        return { messages: this.lobbyMsgs.filter((m) => m.seq > s), peers, seq: this.lobbySeq };
    }

    private pushMessage(m: { id: string; name: string; text: string; own: boolean }): void {
        this.lobbyMsgs.push({ seq: ++this.lobbySeq, id: m.id, name: m.name, text: m.text, ts: Date.now(), own: m.own });
        if (this.lobbyMsgs.length > LOBBY_HISTORY) this.lobbyMsgs.splice(0, this.lobbyMsgs.length - LOBBY_HISTORY);
    }

    private onLobbyPacket(o: Record<string, unknown>): void {
        const pk = parseLobby(o);
        if (!pk) return;
        if (pk.id === this.lobbyId) return; // своё же эхо из сети
        if (!this.lobbyName) return;        // мы не в чате — ничего не принимаем
        const now = Date.now();
        if (!this.lobbyPeers.has(pk.id) && this.lobbyPeers.size >= LOBBY_MAX_PEERS) return;
        this.lobbyPeers.set(pk.id, { name: pk.name, lastSeen: now });
        if (pk.kind !== 'chat') return;
        const key = `${pk.id}:${pk.mid}`;
        if (this.seenMids.has(key)) return;   // одно и то же сообщение пришло по нескольким сетям
        const arr = (this.recvAt.get(pk.id) || []).filter((x) => now - x < RECV_WINDOW_MS);
        if (arr.length >= RECV_LIMIT) { this.recvAt.set(pk.id, arr); return; }
        arr.push(now);
        this.recvAt.set(pk.id, arr);
        this.seenMids.add(key);
        if (this.seenMids.size > 500) {
            const first = this.seenMids.values().next().value;
            if (first !== undefined) this.seenMids.delete(first);
        }
        this.pushMessage({ id: pk.id, name: pk.name, text: pk.text, own: false });
    }
}
