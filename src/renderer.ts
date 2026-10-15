// src/renderer.ts
// ============================================================
// Точка входа renderer-процесса (то, что работает внутри окна).
// Соединяет: UI ↔ WebSocket (сервер хоста) ↔ WebRTC (звук).
// ============================================================
import { state, SIGNALING_PORT } from './state';
import {
    initUI,
    showRoomScreen,
    leaveRoomUI,
    updateCameraUI,
    renderRooms,
    setNearbyRooms,
    updateParticipants,
    showHostAddress,
    showServerAddress,
    setParticipantSpeaking,
    addChatMessage,
    setChatHistory,
    addSystemMessage,
    updateScreenStage,
    showScreenNotice,
    showReconnectBar,
} from './ui';
import { rememberRoom, refreshKnownRooms } from './rooms';
import { handleSignalMessage, syncPeersWithParticipants, closeAllPeers, setScreenTrackHandler, setCameraTrackHandler } from './webrtc';
import { toggleCamera, onCameras, onCameraDenied, changeCameraDevice, changeCameraQuality, resetCamera } from './camera';
import { isCameraQuality } from './cameraquality';
import { startScreenShare, stopScreenShare, changeScreenQuality, onScreenShareMessage, onScreenViewers, onScreenDenied, resetScreen, watchScreen } from './screen';
import { offerFile, onChatMessage, handleFileMessage, downloadFile, syncParticipants, resetFiles } from './files';
import { startQualityMonitor } from './quality';
import { showError } from './errordialog';
import * as E from './errors';
import { getMyAvatar } from './avatar';
import { shutdownAudio, playRoomSound } from './audio';
import type { SignalingMessage, ScreenQuality, ChatMessage, MsgBackup } from './protocol';
import type { Participant } from './state';
import { t, getLanguage, translateStaticPage } from './i18n';
import { setupDiagnostics } from './diagnostics';
import { setupLobby } from './lobby';
import { applyStoredTheme, setupThemeSettings } from './theme';

/** Сколько ждём подключения к хосту, прежде чем сдаться */
const CONNECT_TIMEOUT_MS = 8000;

// ============================================================
// Старт
// ============================================================
// Цвета применяем сразу, чтобы окно не мигало стандартной схемой
applyStoredTheme();

document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 App start. selfId =', state.selfId.slice(0, 8));
    translateStaticPage();
    void window.api?.setLanguage?.(getLanguage().code);
    initUI();
    setupDiagnostics();
    setupLobby();
    setupThemeSettings();
    document.getElementById('open-diag')?.addEventListener('click', () => {
        (document.getElementById('close-settings') as HTMLButtonElement | null)?.click();
        window.dispatchEvent(new CustomEvent('ui:open-diagnostics'));
    });
    wireUiEvents();
    void setupUpdateNotice();
});

function wireUiEvents(): void {
    window.addEventListener('ui:create-room', ((e: Event) => {
        const ev = e as CustomEvent<CreateRoomOptions>;
        void startHosting(ev.detail);
    }) as EventListener);

    window.addEventListener('ui:join-by-address', ((e: Event) => {
        const ev = e as CustomEvent<{ address: string; password?: string }>;
        void joinByAddress(ev.detail.address, ev.detail.password ?? '');
    }) as EventListener);

    // Сообщение в чат
    window.addEventListener('ui:chat-send', ((e: Event) => {
        const ev = e as CustomEvent<{ text: string; image?: string; file?: File }>;
        if (ev.detail.file) {
            const err = offerFile(ev.detail.file, ev.detail.text);
            if (err) addSystemMessage(err);
            return;
        }
        send({ type: 'chat-send', text: ev.detail.text, image: ev.detail.image });
    }) as EventListener);
    window.addEventListener('ui:avatar-changed', () => {
        if (state.inRoom) send({ type: 'set-avatar', avatar: getMyAvatar() });
    });
    startQualityMonitor();
    window.addEventListener('ui:file-download', ((e: Event) => {
        const d = (e as CustomEvent<{ fileId: string; from: string; name: string; size: number }>).detail;
        downloadFile(d.fileId, d.from, d.name, d.size);
    }) as EventListener);

    // Веб-камера
    setCameraTrackHandler(() => updateCameraUI());
    window.addEventListener('ui:camera-toggle', () => { void toggleCamera(); });
    window.addEventListener('ui:camera-device', ((e: Event) => { void changeCameraDevice(String((e as CustomEvent).detail ?? '')); }) as EventListener);
    window.addEventListener('ui:camera-quality', ((e: Event) => {
        const q = (e as CustomEvent).detail;
        if (isCameraQuality(q)) void changeCameraQuality(q);
    }) as EventListener);

    // Трансляция экрана
    setScreenTrackHandler(() => updateScreenStage());
    window.addEventListener('ui:screen-start', ((e: Event) => {
        const ev = e as CustomEvent<{ sourceId: string; quality: ScreenQuality; audio: boolean; priority?: 'motion' | 'detail' }>;
        void startScreenShare(ev.detail.sourceId, ev.detail.quality, ev.detail.audio, ev.detail.priority === 'detail' ? 'detail' : 'motion').then((err) => {
            if (err) showScreenNotice(err);
        });
    }) as EventListener);
    window.addEventListener('ui:screen-stop', () => { void stopScreenShare(); });
    window.addEventListener('ui:screen-watch', ((e: Event) => { watchScreen((e as CustomEvent<{ on: boolean }>).detail.on); }) as EventListener);
    window.addEventListener('ui:screen-quality', ((e: Event) => {
        void changeScreenQuality((e as CustomEvent<{ quality: ScreenQuality }>).detail.quality);
    }) as EventListener);

    window.addEventListener('ui:leave-room', ((e: Event) => {
        const keepOpen = (e as CustomEvent<{ keepOpen?: boolean }>).detail?.keepOpen === true;
        if (keepOpen && state.role === 'host') void stepOutOfOwnRoom();
        else void leaveRoom();
    }) as EventListener);
    window.addEventListener('ui:rejoin-own-room', () => { rejoinOwnRoom(); });
    window.addEventListener('ui:close-own-room', () => { void leaveRoom(); });

    // Комнаты, где вы уже были: раз в несколько секунд проверяем, открыты ли они
    const refreshRooms = async () => {
        if (state.inRoom || state.role === 'guest') return;
        if (await refreshKnownRooms(state.username, null)) renderRooms();
    };
    renderRooms();
    void refreshRooms().then(() => renderRooms());
    window.setInterval(() => { void refreshRooms(); }, 15000);

    // Автопоиск комнат в одной сети: объявляем свою (если хост и не скрыли) и слушаем чужие
    const syncDiscovery = async () => {
        try {
            const visible = localStorage.getItem('pd_room_visible') !== '0';
            if (state.role === 'host' && !hostedRemotely && state.currentRoom && visible) {
                const members = state.inRoom ? state.participants.length : (state.myRoom?.members ?? 0);
                window.api.announceRoom?.({ id: state.selfId, name: state.currentRoom, host: state.username, port: SIGNALING_PORT, hasPassword: hostHasPassword, members });
            } else {
                window.api.announceRoom?.(null);
            }
            if (!state.inRoom && state.role !== 'guest') {
                const list = (await window.api.getNearbyRooms?.()) ?? [];
                setNearbyRooms(list.filter((r) => r.id !== state.selfId));
            }
        } catch { /* автопоиск — удобство, а не необходимость */ }
    };
    void syncDiscovery();
    window.setInterval(() => { void syncDiscovery(); }, 3000);

    // Мы начали / закончили говорить (событие приходит из audio.ts)
    window.addEventListener('audio:speaking', ((e: Event) => {
        const ev = e as CustomEvent<{ speaking: boolean }>;
        // Сразу подсвечиваем свой аватар…
        setParticipantSpeaking(state.selfId, ev.detail.speaking);
        // …и сообщаем остальным участникам
        send({ type: 'speaking', from: state.selfId, speaking: ev.detail.speaking });
    }) as EventListener);
}

/** Защита от повторных нажатий, пока идёт подключение / выход */
let busy = false;

// ============================================================
// РЕЖИМ ХОСТА
// 1. Запускаем WebSocket-сервер на этом же ПК (через IPC).
// 2. Открываем WebSocket-клиент к самим себе (localhost).
// 3. Регистрируемся, создаём комнату.
// ============================================================
interface CreateRoomOptions {
    roomName: string;
    password?: string;
    /** 'local' — сервер запускается на этом компьютере, 'server' — комната создаётся на отдельном сервере */
    mode?: 'local' | 'server';
    serverAddress?: string;
    serverKey?: string;
}

/** true — наша комната живёт на чужом (арендованном) сервере, локальный сервер не запускали */
let hostedRemotely = false;
let avatarSent = false;
let hostHasPassword = false;
/** Пароль текущей комнаты (только в памяти): нужен, чтобы вернуться или поднять комнату у себя при переезде */
let roomPassword = '';
/** Адрес сервера, к которому мы подключены (куда возвращаться после обрыва) */
let sessionAddress = '';

async function startHosting(opts: CreateRoomOptions): Promise<void> {
    const roomName = opts.roomName;
    const password = opts.password ?? '';
    if (busy) return;
    busy = true;
    try {
        await leavePromise; // если ещё заканчивается выход из прошлой комнаты — дожидаемся
        if (state.hostAway) {
            showError(E.explainServerError('У вас уже есть открытая комната'));
            return;
        }
        if (state.role !== 'idle' || state.ws) return;

        // Режим «свой сервер»: ничего локально не запускаем, подключаемся к серверу и создаём комнату там
        if (opts.mode === 'server') {
            const address = normalizeAddress(opts.serverAddress ?? '');
            try {
                await openWebSocket(`ws://${address}`);
            } catch (err) {
                showError(E.explainConnectError(err, true));
                return;
            }
            hostedRemotely = true;
            roomPassword = password;
            sessionAddress = address;
            showServerAddress(address);
            state.role = 'host';
            state.currentRoom = roomName;
            send({ type: 'register', clientId: state.selfId, username: state.username });
            send({ type: 'create-room', roomName, password: password || undefined, createKey: opts.serverKey || undefined });
            console.log(`🏠 Создаём комнату «${roomName}» на сервере ${address}`);
            return;
        }

        hostHasPassword = !!password;
        roomPassword = password;
        sessionAddress = `127.0.0.1:${SIGNALING_PORT}`;
        localStorage.setItem('pd_room_visible', (document.getElementById('room-visible') as HTMLInputElement | null)?.checked === false ? '0' : '1');

        // 1. Стартуем сервер
        const res = await window.api.startServer(SIGNALING_PORT);
        if (!res.ok) {
            showError(E.explainStartServerError(res.message, SIGNALING_PORT));
            return;
        }

        showHostAddress(await window.api.getLocalIp());

        // 2. Открываем WS к самим себе
        try {
            await openWebSocket(`ws://127.0.0.1:${SIGNALING_PORT}`);
        } catch (err) {
            showError(E.explainConnectError(err, false));
            await window.api.stopServer();
            return;
        }

        // 3. Регистрируемся и создаём комнату
        state.role = 'host';
        state.currentRoom = roomName;
        send({ type: 'register', clientId: state.selfId, username: state.username });
        send({ type: 'create-room', roomName, password: password || undefined });
        // Экран комнаты откроется, когда сервер подтвердит список участников.
        console.log(`🏠 Хост: создаём комнату «${roomName}»`);
    } finally {
        busy = false;
    }
}

// ============================================================
// РЕЖИМ ГОСТЯ
// 1. Открываем WebSocket к хосту.
// 2. Регистрируемся — сервер пришлёт список комнат.
// 3. Входим в комнату (см. 'room-list' в onServerMessage).
// 4. Дальше соединения со всеми участниками создаются в webrtc.ts.
// ============================================================
/** Пароль, который гость ввёл для входа (живёт, пока идёт подключение) */
let joinPassword = '';
/** Сведения о комнате, в которую входим (чтобы запомнить её в списке) */
let pendingRoomMeta: { hasPassword: boolean } | null = null;

async function joinByAddress(rawAddress: string, password: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
        await leavePromise;
        if (state.hostAway) {
            showError(E.OWN_ROOM_OPEN);
            return;
        }
        if (state.role !== 'idle' || state.ws) return;
        const address = normalizeAddress(rawAddress);

        try {
            await openWebSocket(`ws://${address}`);
        } catch (err) {
            showError(E.explainConnectError(err, false));
            return;
        }

        joinPassword = password;
        sessionAddress = address;
        state.pendingJoin = true;
        state.hostAddress = address;
        send({ type: 'register', clientId: state.selfId, username: state.username });
    } finally {
        busy = false;
    }
}

/** «192.168.1.5» -> «192.168.1.5:8080»; убирает лишние пробелы и «ws://» */
function normalizeAddress(raw: string): string {
    let a = raw.trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
    if (!/:\d+$/.test(a)) a += `:${SIGNALING_PORT}`;
    return a;
}

// ============================================================
// WebSocket: открытие + общий обработчик входящих
// ============================================================
function openWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            reject(new Error('Неверный адрес: ' + url));
            return;
        }

        const timer = setTimeout(() => {
            try { ws.close(); } catch { /* ignore */ }
            reject(new Error('Хост не отвечает (прошло ' + CONNECT_TIMEOUT_MS / 1000 + ' сек): ' + url));
        }, CONNECT_TIMEOUT_MS);

        ws.addEventListener('open', () => {
            clearTimeout(timer);
            console.log('✅ WebSocket открыт:', url);
            state.ws = ws;
            lastServerMsg = Date.now();
            gotPing = false;
            resolve();
        });

        ws.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('Не удалось подключиться к ' + url));
        });

        ws.addEventListener('message', (e) => {
            let msg: SignalingMessage;
            try {
                msg = JSON.parse(e.data);
            } catch {
                return;
            }
            if (state.ws !== ws) return; // сообщение от уже закрытого соединения
            lastServerMsg = Date.now();
            if (msg.type === 'ping') { gotPing = true; return; }
            void onServerMessage(msg);
        });

        ws.addEventListener('close', () => {
            console.log('🔌 WebSocket закрыт');
            // Закрылось «само» (хост выключился, пропал интернет) — пробуем вернуться или переехать
            if (state.ws === ws) void onConnectionLost(ws);
        });
    });
}

// ============================================================
// Обработка сообщений от сервера
// ============================================================
async function onServerMessage(msg: SignalingMessage): Promise<void> {
    switch (msg.type) {
        case 'room-list':
            // Возвращаемся в комнату после обрыва связи
            if (rejoining) {
                rejoining = false;
                const room = msg.rooms[0];
                if (!room || (state.currentRoom && room.name !== state.currentRoom)) { joinWaiter?.(false); break; }
                send({ type: 'join-room', roomName: room.name, password: roomPassword || undefined });
                break;
            }
            // Хозяин вне комнаты: сервер присылает сведения о его открытой комнате
            if (state.hostAway && msg.rooms[0]) {
                state.myRoom = { name: msg.rooms[0].name, members: msg.rooms[0].memberCount ?? msg.rooms[0].guestCount };
                renderRooms();
            }
            if (state.pendingJoin && msg.rooms[0]) pendingRoomMeta = { hasPassword: msg.rooms[0].hasPassword };
            // Гость ждал список комнат, чтобы войти
            if (state.pendingJoin) {
                state.pendingJoin = false;
                if (msg.rooms.length === 0) {
                    showError(E.NO_ROOM_ON_HOST);
                    void leaveRoom();
                    break;
                }
                if (msg.rooms[0].hasPassword && !joinPassword) {
                    showError(E.PASSWORD_NEEDED, 'join-password-input');
                    void leaveRoom();
                    break;
                }
                state.role = 'guest';
                state.currentRoom = msg.rooms[0].name;
                send({ type: 'join-room', roomName: msg.rooms[0].name, password: joinPassword || undefined });
                roomPassword = joinPassword;
                joinPassword = '';
            }
            break;

        case 'ice-config':
            state.extraIceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
            break;

        case 'chat':
            chatLog.push(msg.message);
            if (chatLog.length > 100) chatLog.shift();
            onChatMessage(msg.message);
            addChatMessage(msg.message);
            if (msg.message.from !== state.selfId) playRoomSound('message');
            break;

        case 'file-request':
        case 'file-chunk':
        case 'file-ack':
        case 'file-cancel':
            handleFileMessage(msg);
            break;

        case 'chat-history':
            chatLog = msg.messages.slice(-100);
            setChatHistory(msg.messages);
            break;

        case 'screen-share':
            void onScreenShareMessage(msg);
            break;

        case 'screen-viewers':
            void onScreenViewers(msg);
            break;

        case 'backup':
            successors = (msg as MsgBackup).successors ?? [];
            break;

        case 'cameras':
            onCameras(msg);
            break;

        case 'camera-denied':
            void onCameraDenied(msg.message);
            break;

        case 'screen-denied':
            void onScreenDenied(msg.message);
            break;

        case 'participants':
            lastRealList = msg.participants;
            applyParticipants(mergeGrace(msg.participants), msg.roomName, Date.now() < graceUntil);
            joinWaiter?.(true);
            break;

        // Кто-то из участников начал / закончил говорить
        case 'speaking':
            setParticipantSpeaking(msg.from, msg.speaking);
            break;

        // Сигналинг WebRTC
        case 'offer':
        case 'answer':
        case 'ice-candidate':
            await handleSignalMessage(msg);
            break;

        // Хост ушёл
        case 'room-closed':
            showError(E.roomClosed());
            void leaveRoom();
            break;

        // Кик
        case 'kicked':
            showError(E.kicked(msg.reason));
            void leaveRoom();
            break;

        // Ошибки
        case 'error':
            if (joinWaiter) { joinWaiter(false); break; } // пока возвращаемся — решает цикл возвращения
            showError(E.explainServerError(msg.message), /парол/i.test(msg.message) ? 'join-password-input' : undefined);
            void leaveRoom();
            break;
    }
}

// ============================================================
// Список участников (с «льготным окном» после переезда комнаты)
// ============================================================
let lastRealList: Participant[] | null = null;
let graceUntil = 0;
let graceTimer: number | null = null;
let lostHostId = '';

/** Пока комната переезжает, новые участники подтягиваются по одному: старых не выбрасываем сразу */
function mergeGrace(list: Participant[]): Participant[] {
    if (Date.now() >= graceUntil) return list;
    const ids = new Set(list.map((p) => p.clientId));
    const extra = state.participants.filter((p) => !ids.has(p.clientId) && p.clientId !== lostHostId);
    return [...list, ...extra.map((p) => ({ ...p, isHost: false }))];
}

function applyParticipants(list: Participant[], roomName: string, quiet: boolean): void {
    syncParticipants(list.map((p) => p.clientId));
    if (state.inRoom && !quiet) {
        // Строки «зашёл / вышел» в чате
        const before = new Set(state.participants.map((p) => p.clientId));
        const after = new Set(list.map((p) => p.clientId));
        let someoneJoined = false;
        let someoneLeft = false;
        for (const p of list) {
            if (!before.has(p.clientId) && p.clientId !== state.selfId) {
                addSystemMessage(t('В комнате новый участник: {name}', { name: p.username }));
                someoneJoined = true;
            }
        }
        for (const p of state.participants) {
            if (!after.has(p.clientId)) {
                addSystemMessage(t('Из комнаты ушёл участник: {name}', { name: p.username }));
                someoneLeft = true;
            }
        }
        if (someoneJoined) playRoomSound('join');
        else if (someoneLeft) playRoomSound('leave');
    }
    state.participants = list;
    if (!state.inRoom) {
        state.inRoom = true;
        showRoomScreen(state.currentRoom ?? roomName);
        // Гость: запоминаем комнату, чтобы потом заходить в неё с главного экрана
        if (state.role === 'guest' && state.hostAddress) {
            const hostName = list.find((p) => p.isHost)?.username ?? '';
            rememberRoom({ address: state.hostAddress, name: roomName, host: hostName, hasPassword: pendingRoomMeta?.hasPassword ?? false });
            pendingRoomMeta = null;
        }
    }
    updateParticipants(list);
    updateScreenStage();
    // Один раз за вход в комнату отправляем свой аватар
    if (state.inRoom && !avatarSent) {
        avatarSent = true;
        const av = getMyAvatar();
        if (av) send({ type: 'set-avatar', avatar: av });
    }
    // Создаём/закрываем соединения со всеми участниками
    syncPeersWithParticipants(list);
}

// ============================================================
// ПОТЕРЯ СВЯЗИ: возвращаемся в комнату, а если хоста нет — комната переезжает
//
// Голос и камеры идут напрямую между участниками, поэтому разговор
// продолжается, пока мы ищем сервер. Порядок такой:
//  1) 15 секунд пробуем вернуться к прежнему серверу (мигнул интернет);
//  2) если не вышло и сервер был у кого-то из участников — по списку «запасных
//     хостов» (в порядке входа) первый поднимает комнату у себя, остальные
//     подключаются к нему;
//  3) если не вышло ничего — выходим на главный экран.
// ============================================================
let lastServerMsg = Date.now();
let gotPing = false;
let reconnecting = false;
let recoverToken = 0;
let rejoining = false;
let joinWaiter: ((ok: boolean) => void) | null = null;
let successors: MsgBackup['successors'] = [];
let chatLog: ChatMessage[] = [];

const RETRY_SAME_SERVER_MS = 15_000;
const WAIT_FOR_SUCCESSOR_MS = 25_000;
const RETRY_REMOTE_TOTAL_MS = 120_000;
const MIGRATION_GRACE_MS = 20_000;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function awaitJoin(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => { joinWaiter = null; resolve(false); }, ms);
        joinWaiter = (ok) => { window.clearTimeout(timer); joinWaiter = null; resolve(ok); };
    });
}

/** Сервер молчит слишком долго (хотя соединение «формально» открыто) — считаем, что связь потеряна */
window.setInterval(() => {
    const ws = state.ws;
    if (ws && gotPing && state.inRoom && !reconnecting && Date.now() - lastServerMsg > 16_000) {
        console.warn('⏱ Сервер молчит больше 16 секунд — считаем связь потерянной');
        void onConnectionLost(ws);
    }
}, 3000);

async function onConnectionLost(ws: WebSocket): Promise<void> {
    if (state.ws !== ws) return;
    if (reconnecting) {
        // Обрыв во время попыток вернуться: цикл возвращения разберётся сам
        state.ws = null;
        joinWaiter?.(false);
        return;
    }
    const recoverable = state.inRoom && (state.role === 'guest' || (state.role === 'host' && hostedRemotely));
    if (!recoverable) {
        showError(E.connectionLost());
        void leaveRoom();
        return;
    }
    state.ws = null;
    try { ws.close(); } catch { /* ignore */ }
    await recoverConnection();
}

async function tryRejoin(address: string, timeoutMs = 8000): Promise<boolean> {
    try {
        await openWebSocket(`ws://${address}`);
    } catch {
        return false;
    }
    const ws = state.ws;
    rejoining = true;
    const waiter = awaitJoin(timeoutMs);
    send({ type: 'register', clientId: state.selfId, username: state.username });
    const ok = await waiter;
    rejoining = false;
    if (!ok && ws && state.ws === ws) {
        state.ws = null;
        try { ws.close(); } catch { /* ignore */ }
    }
    return ok;
}

/** Мы следующий по списку: поднимаем комнату у себя */
async function becomeHost(): Promise<boolean> {
    const roomName = state.currentRoom;
    if (!roomName) return false;
    console.log('👑 Хост пропал — поднимаем комнату у себя');
    const res = await window.api.startServer(SIGNALING_PORT);
    if (!res.ok) { console.warn('Не удалось запустить сервер при переезде:', res.message); return false; }
    try {
        await openWebSocket(`ws://127.0.0.1:${SIGNALING_PORT}`);
    } catch {
        await window.api.stopServer();
        return false;
    }
    const wasRole = state.role;
    state.role = 'host';
    hostedRemotely = false;
    hostHasPassword = !!roomPassword;
    sessionAddress = `127.0.0.1:${SIGNALING_PORT}`;
    state.hostAddress = null;
    const waiter = awaitJoin(8000);
    send({ type: 'register', clientId: state.selfId, username: state.username });
    send({ type: 'create-room', roomName, password: roomPassword || undefined, history: chatLog });
    const ok = await waiter;
    if (!ok) {
        const ws = state.ws;
        state.ws = null;
        state.role = wasRole;
        if (ws) try { ws.close(); } catch { /* ignore */ }
        await window.api.stopServer();
        return false;
    }
    try { showHostAddress(await window.api.getLocalIp()); } catch { /* ignore */ }
    return true;
}

/** Ищем нового хоста по списку запасных. true — комната найдена или поднята */
async function migrate(token: number): Promise<boolean> {
    const list = successors.filter((x) => x.clientId !== lostHostId);
    if (list.length === 0) return false;
    for (const cand of list) {
        if (token !== recoverToken) return false;
        if (cand.clientId === state.selfId) {
            if (await becomeHost()) return true;
            continue;
        }
        const address = `${cand.address}:${SIGNALING_PORT}`;
        const until = Date.now() + WAIT_FOR_SUCCESSOR_MS;
        while (Date.now() < until && token === recoverToken) {
            if (await tryRejoin(address, 6000)) {
                sessionAddress = address;
                state.hostAddress = address;
                return true;
            }
            await sleep(1500);
        }
    }
    return false;
}

async function recoverConnection(): Promise<void> {
    const token = ++recoverToken;
    reconnecting = true;
    lostHostId = state.participants.find((p) => p.isHost)?.clientId ?? '';
    const oldAddress = sessionAddress;
    const remote = hostedRemotely;
    showReconnectBar(t('Связь с комнатой потеряна. Разговор продолжается, пробую вернуться…'));
    console.log('📡 Связь потеряна, пробуем вернуться к', oldAddress);

    let recovered = false;
    let migrated = false;
    const t0 = Date.now();
    while (token === recoverToken && Date.now() - t0 < RETRY_SAME_SERVER_MS) {
        if (await tryRejoin(oldAddress)) { recovered = true; break; }
        await sleep(1500);
    }
    if (!recovered && token === recoverToken) {
        if (remote || state.role === 'host' || successors.length === 0) {
            // Арендованный сервер (или переезжать некуда): просто продолжаем пробовать подольше
            while (token === recoverToken && Date.now() - t0 < RETRY_REMOTE_TOTAL_MS) {
                if (await tryRejoin(oldAddress)) { recovered = true; break; }
                await sleep(2500);
            }
        } else {
            showReconnectBar(t('Хост пропал. Комната переезжает к другому участнику…'));
            graceUntil = Date.now() + RETRY_REMOTE_TOTAL_MS; // пока комната переезжает, не выбрасываем участников из списка
            migrated = recovered = await migrate(token);
        }
    }
    if (token !== recoverToken) return; // пока пытались, человек сам вышел из комнаты

    reconnecting = false;
    if (!recovered) {
        graceUntil = 0;
        showReconnectBar(null);
        showError(E.connectionLost());
        void leaveRoom();
        return;
    }
    showReconnectBar(null);
    afterRecovered(migrated);
}

/** Связь вернулась: заново сообщаем серверу, чем мы заняты */
function afterRecovered(migrated: boolean): void {
    if (migrated) {
        // Комната на новом сервере: чужие показы экрана и камеры прежнего сервера больше не действуют
        if (state.screen && state.screen.sharerId !== state.selfId) resetScreen();
        state.cameraIds = state.cameraStream ? [state.selfId] : [];
        updateCameraUI();
        graceUntil = Date.now() + MIGRATION_GRACE_MS;
        if (graceTimer) window.clearTimeout(graceTimer);
        graceTimer = window.setTimeout(() => {
            graceTimer = null;
            if (state.inRoom && lastRealList) applyParticipants(lastRealList, state.currentRoom ?? '', false);
        }, MIGRATION_GRACE_MS + 200);
    }
    avatarSent = true;
    const av = getMyAvatar();
    if (av) send({ type: 'set-avatar', avatar: av });
    if (state.screenStream && state.screen?.sharerId === state.selfId) send({ type: 'screen-start', quality: state.screen.quality });
    else if (state.watchingScreen) send({ type: 'screen-watch', watching: true });
    if (state.cameraStream) send({ type: 'camera-set', on: true });
    addSystemMessage(migrated ? t('Комната переехала. Теперь хост — {name}.', { name: state.participants.find((p) => p.isHost)?.username ?? '' }) : t('Связь восстановлена.'));
    console.log(migrated ? '✅ Комната переехала' : '✅ Связь восстановлена');
}

// ============================================================
// Отправка сообщения на сервер
// ============================================================
function send(msg: SignalingMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(msg));
    }
}

// ============================================================
// Выход из комнаты
// ============================================================
function closeSocket(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        const t = setTimeout(resolve, 500);
        ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
        try { ws.close(); } catch { clearTimeout(t); resolve(); }
    });
}

/** Выполняется ли сейчас выход из комнаты (чтобы новые действия подождали его конца) */
let leavePromise: Promise<void> | null = null;

function leaveRoom(): Promise<void> {
    if (leavePromise) return leavePromise;
    const p = doLeaveRoom().finally(() => { leavePromise = null; });
    leavePromise = p;
    return p;
}

/** Хозяин выходит из голосовой комнаты, но комната остаётся открытой (пока работает приложение) */
async function stepOutOfOwnRoom(): Promise<void> {
    if (state.role !== 'host' || !state.inRoom) return;
    send({ type: 'leave-room' });
    avatarSent = false;
    state.inRoom = false;
    state.hostAway = true;
    state.myRoom = { name: state.currentRoom ?? '', members: Math.max(0, state.participants.length - 1) };
    state.participants = [];
    state.selectedParticipant = null;
    resetScreen();
    resetCamera();
    closeAllPeers();
    leaveRoomUI();
    renderRooms();
    await shutdownAudio();
}

/** Хозяин возвращается в свою открытую комнату */
function rejoinOwnRoom(): void {
    if (!state.hostAway || !state.currentRoom) return;
    state.hostAway = false;
    state.myRoom = null;
    // Экран комнаты откроется, когда сервер пришлёт список участников
    send({ type: 'join-room', roomName: state.currentRoom });
}

async function doLeaveRoom(): Promise<void> {
    {
        const wasHost = state.role === 'host';
        const remote = hostedRemotely;
        recoverToken++;
        reconnecting = false;
        rejoining = false;
        joinWaiter?.(false);
        showReconnectBar(null);
        graceUntil = 0;
        lastRealList = null;
        successors = [];
        chatLog = [];
        roomPassword = '';
        sessionAddress = '';
        lostHostId = '';
        hostedRemotely = false;
        state.extraIceServers = [];
        const ws = state.ws;

        // Сразу приводим состояние и экран в порядок…
        resetFiles();
        avatarSent = false;
        void window.api.announceRoom?.(null); // комната закрыта — убираем объявление сразу
        state.ws = null; // (чтобы обработчик «close» не решил, что соединение потеряно)
        state.role = 'idle';
        state.currentRoom = null;
        state.inRoom = false;
        state.pendingJoin = false;
        state.hostAway = false;
        state.myRoom = null;
        state.hostAddress = null;
        joinPassword = '';
        pendingRoomMeta = null;
        state.participants = [];
        state.selectedParticipant = null;
        resetScreen();
        resetCamera();
        closeAllPeers();
        leaveRoomUI();
        renderRooms();

        // …и затем спокойно закрываем всё остальное
        await shutdownAudio();
        if (ws) await closeSocket(ws);
        if (wasHost && !remote) await window.api.stopServer(); // хост уходит — его сервер тоже выключаем
    }
}

// ============================================================
// Уведомление о новой версии
// ============================================================
async function setupUpdateNotice(): Promise<void> {
    try {
        const version = await window.api.getVersion();
        const label = document.getElementById('app-version');
        if (label) label.textContent = t('CoCall · версия {version}', { version });

        const info = await window.api.checkUpdate();
        if (!info.available || !info.version) return;
        if (localStorage.getItem('pd_update_dismissed') === info.version) return;

        const banner = document.getElementById('update-banner') as HTMLElement;
        const text = document.getElementById('update-text') as HTMLElement;
        const btn = document.getElementById('update-open') as HTMLButtonElement;
        text.textContent =
            t('Доступна новая версия CoCall {new} (у вас {old}). Чтобы чат и картинки работали у всех одинаково, обновитесь.', { new: info.version, old: version });
        // Кнопки «Диагностика» и языка закреплены сверху — сдвигаем их под плашку, чтобы не перекрывали её кнопки
        const syncBannerHeight = (): void => {
            document.documentElement.style.setProperty('--banner-h', banner.classList.contains('show') ? `${banner.offsetHeight}px` : '0px');
        };
        banner.classList.add('show');
        syncBannerHeight();
        window.addEventListener('resize', syncBannerHeight);
        new MutationObserver(syncBannerHeight).observe(text, { childList: true, characterData: true, subtree: true });
        document.getElementById('update-close')?.addEventListener('click', () => {
            banner.classList.remove('show');
            syncBannerHeight();
            localStorage.setItem('pd_update_dismissed', info.version as string);
        });

        // Запасной вариант: просто открыть страницу загрузок
        const openPage = () => { void window.api.openReleases(); };
        const canAuto = info.canAuto === true && !!window.api.downloadUpdate && !!window.api.installUpdate;
        if (!canAuto) {
            btn.textContent = t('Скачать');
            btn.addEventListener('click', openPage);
            return;
        }

        // Обновление прямо из приложения: скачать → перезапустить и установить
        type Phase = 'ready' | 'loading' | 'downloaded' | 'failed';
        let phase: Phase = 'ready';
        btn.textContent = t('Скачать и установить');
        btn.addEventListener('click', () => {
            if (phase === 'ready') {
                phase = 'loading';
                btn.disabled = true;
                btn.textContent = t('Загрузка… {n}%', { n: 0 });
                void window.api.downloadUpdate?.();
            } else if (phase === 'downloaded') {
                btn.disabled = true;
                btn.textContent = t('Перезапуск…');
                void window.api.installUpdate?.();
            } else if (phase === 'failed') {
                openPage();
            }
        });
        window.api.onUpdateEvent?.((e) => {
            if (e.type === 'progress' && phase === 'loading') {
                btn.textContent = t('Загрузка… {n}%', { n: e.percent });
            } else if (e.type === 'downloaded') {
                phase = 'downloaded';
                btn.disabled = false;
                btn.textContent = t('Перезапустить и установить');
                text.textContent = t('Обновление {new} скачано. Нажмите кнопку — CoCall перезапустится уже новой версией. Если вы в комнате, вы выйдете из неё.', { new: e.version });
            } else if (e.type === 'error' && phase !== 'downloaded') {
                phase = 'failed';
                btn.disabled = false;
                btn.textContent = t('Скачать вручную');
                text.textContent = t('Не удалось обновиться автоматически. Скачайте новую версию вручную со страницы загрузок.');
            }
        });
    } catch {
        /* проверка обновлений не должна мешать работе */
    }
}
