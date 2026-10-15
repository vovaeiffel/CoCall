// src/webrtc.ts
// ============================================================
// Логика WebRTC: создание соединений, обмен SDP/ICE, приём аудио.
//
// Схема «каждый с каждым» (mesh): у каждого участника есть отдельное
// прямое соединение с КАЖДЫМ другим участником комнаты. Благодаря этому
// все слышат всех (а не только хоста).
//
// Чтобы два участника не начали соединяться одновременно и не
// столкнулись, действует простое правило: offer (приглашение) шлёт тот,
// у кого clientId «меньше» по алфавиту. Второй только отвечает.
// ============================================================
import { state, ICE_SERVERS } from './state';
import type { PeerState, Participant } from './state';
import type {
    ClientId,
    MsgAnswer,
    MsgIce,
    MsgOffer,
    SignalingMessage,
} from './protocol';
import { attachRemoteStream, detachRemoteStream, loadPeerVolume } from './audio';
import { CAMERA_QUALITIES } from './cameraquality';
import { SCREEN_QUALITIES, START_BITRATE_KBPS, MIN_BITRATE_KBPS, MAX_BITRATE_KBPS } from './screenquality';

// ============================================================
// Трансляция экрана
// В каждом соединении заранее есть три «слота»:
//   1) голос  2) видео экрана  3) звук экрана (звук компьютера).
// Благодаря этому показ экрана включается простой подменой трека —
// без нового согласования соединения.
// ============================================================
type ScreenTrackHandler = (peer: PeerState, kind: 'video' | 'audio') => void;
let screenTrackHandler: ScreenTrackHandler | null = null;
export function setScreenTrackHandler(fn: ScreenTrackHandler): void {
    screenTrackHandler = fn;
}

type CameraTrackHandler = (peer: PeerState) => void;
let cameraTrackHandler: CameraTrackHandler | null = null;
export function setCameraTrackHandler(fn: CameraTrackHandler): void {
    cameraTrackHandler = fn;
}

function videoTransceivers(pc: RTCPeerConnection): RTCRtpTransceiver[] {
    return pc.getTransceivers().filter((tr) => tr.receiver.track.kind === 'video');
}

function audioTransceivers(pc: RTCPeerConnection): RTCRtpTransceiver[] {
    return pc.getTransceivers().filter((tr) => tr.receiver.track.kind === 'audio');
}

function getVideoSender(pc: RTCPeerConnection): RTCRtpSender | null {
    const t = pc.getTransceivers().find((tr) => tr.receiver.track.kind === 'video');
    return t ? t.sender : null;
}

function getScreenAudioSender(pc: RTCPeerConnection): RTCRtpSender | null {
    const t = audioTransceivers(pc)[1];
    return t ? t.sender : null;
}

/**
 * Дописывает в описание соединения подсказку для видео: стартовая, минимальная и
 * максимальная скорость. Применяется к тому, что получено от собеседника, — то есть к тому,
 * как мы шлём ему видео. Если что-то пойдёт не так — возвращаем описание как было.
 */
function boostVideoSdp(sdp: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    try {
        if (!sdp.sdp) return sdp;
        const hint = `x-google-start-bitrate=${START_BITRATE_KBPS};x-google-min-bitrate=${MIN_BITRATE_KBPS};x-google-max-bitrate=${MAX_BITRATE_KBPS}`;
        const codecRe = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//;
        const lines = sdp.sdp.split('\r\n');

        // 1) какие номера кодеков относятся к видео
        const videoCodecs = new Set<string>();
        let inVideo = false;
        for (const line of lines) {
            if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
            const m = inVideo ? codecRe.exec(line) : null;
            if (m) videoCodecs.add(m[1]);
        }

        // 2) дописываем подсказку к существующим строкам fmtp
        const hasFmtp = new Set<string>();
        const step: string[] = [];
        inVideo = false;
        for (const line of lines) {
            if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
            const f = inVideo ? /^a=fmtp:(\d+) (.*)$/.exec(line) : null;
            if (f && videoCodecs.has(f[1])) {
                hasFmtp.add(f[1]);
                step.push(`${line};${hint}`);
            } else {
                step.push(line);
            }
        }

        // 3) для кодеков без fmtp (например VP8) добавляем свою строку
        const result: string[] = [];
        inVideo = false;
        for (const line of step) {
            result.push(line);
            if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
            const m = inVideo ? codecRe.exec(line) : null;
            if (m && !hasFmtp.has(m[1])) result.push(`a=fmtp:${m[1]} ${hint}`);
        }
        return { type: sdp.type, sdp: result.join('\r\n') };
    } catch {
        return sdp;
    }
}

/** Ограничить скорость и размер видео под выбранное качество */
async function applyVideoParams(sender: RTCRtpSender | null): Promise<void> {
    if (!sender || !sender.track) return;
    const q = SCREEN_QUALITIES[state.screen?.quality ?? state.screenQuality];
    try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        const srcH = sender.track.getSettings().height || q.height;
        params.encodings[0].maxBitrate = q.bitrate;
        params.encodings[0].maxFramerate = q.fps;
        params.encodings[0].scaleResolutionDownBy = Math.max(1, srcH / q.height);
        // «Плавность» — при нехватке интернета держим кадры; «чёткость» — держим разрешение
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
            state.screenPriority === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
        await sender.setParameters(params);
    } catch {
        /* соединение ещё не готово — повторим, когда оно подключится */
    }
}

/** Подставить (или убрать) наш экран и его звук в одном соединении */
async function attachScreenTracks(peer: PeerState): Promise<void> {
    const vSender = getVideoSender(peer.pc);
    const aSender = getScreenAudioSender(peer.pc);
    // Видео уходит только тем, кто нажал «Смотреть»
    const allowed = state.screenViewers.includes(peer.clientId);
    const vt = allowed ? state.screenStream?.getVideoTracks()[0] ?? null : null;
    const at = allowed ? state.screenStream?.getAudioTracks()[0] ?? null : null;
    try {
        if (vSender) await vSender.replaceTrack(vt);
        if (aSender) await aSender.replaceTrack(at);
    } catch (err) {
        console.warn('screen replaceTrack error:', err);
    }
    if (vt) await applyVideoParams(vSender);
}

// ============================================================
// Веб-камера: четвёртый «слот» соединения (второе видео).
// У старых версий приложения его нет — они просто не увидят камеру.
// ============================================================
function getCameraSender(pc: RTCPeerConnection): RTCRtpSender | null {
    const t = videoTransceivers(pc)[1];
    return t ? t.sender : null;
}

async function applyCameraParams(sender: RTCRtpSender | null): Promise<void> {
    if (!sender || !sender.track) return;
    const q = CAMERA_QUALITIES[state.cameraQuality];
    try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        const srcH = sender.track.getSettings().height || q.height;
        params.encodings[0].maxBitrate = q.bitrate;
        params.encodings[0].maxFramerate = q.fps;
        params.encodings[0].scaleResolutionDownBy = Math.max(1, srcH / q.height);
        await sender.setParameters(params);
    } catch {
        /* соединение ещё не готово — повторим при подключении */
    }
}

async function attachCameraTrack(peer: PeerState): Promise<void> {
    const sender = getCameraSender(peer.pc);
    if (!sender) return;
    const track = state.cameraStream?.getVideoTracks()[0] ?? null;
    try {
        await sender.replaceTrack(track);
    } catch (err) {
        console.warn('camera replaceTrack error:', err);
    }
    if (track) await applyCameraParams(sender);
}

/** Включили / выключили / сменили камеру — обновить все соединения */
export async function updateCameraTracksInAllPeers(): Promise<void> {
    for (const peer of state.peers.values()) await attachCameraTrack(peer);
}

/** Сменили качество камеры во время работы */
export async function applyCameraQualityToAll(): Promise<void> {
    for (const peer of state.peers.values()) await applyCameraParams(getCameraSender(peer.pc));
}

/** Начали / закончили показ экрана — обновить все соединения */
export async function updateScreenTracksInAllPeers(): Promise<void> {
    for (const peer of state.peers.values()) await attachScreenTracks(peer);
}

/** Сменили качество во время показа */
export async function applyScreenQualityToAll(): Promise<void> {
    for (const peer of state.peers.values()) await applyVideoParams(getVideoSender(peer.pc));
}


// ============================================================
// Отправка сообщения на сервер
// ============================================================
function sendToServer(msg: SignalingMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(msg));
    }
}

// ============================================================
// Вспомогательное: «отправитель» звука в данном соединении
// ============================================================
function getAudioSender(pc: RTCPeerConnection): RTCRtpSender | null {
    const t = pc.getTransceivers().find((tr) => tr.receiver.track.kind === 'audio');
    return t ? t.sender : null;
}

/** Подставить в соединение наш текущий микрофон (или тишину, если он выключен) */
async function attachLocalTrack(peer: PeerState): Promise<void> {
    const sender = getAudioSender(peer.pc);
    if (!sender) return;
    const track = state.sendStream?.getAudioTracks()[0] ?? null;
    try {
        await sender.replaceTrack(track);
    } catch (err) {
        console.warn('replaceTrack error:', err);
    }
}

// ============================================================
// Создание соединения с одним собеседником
// ============================================================
function createPeer(clientId: ClientId, username: string, initiator: boolean): PeerState {
    const audioEl = new Audio();
    audioEl.autoplay = true;

    const pc = new RTCPeerConnection({ iceServers: [...ICE_SERVERS, ...state.extraIceServers] });

    const peer: PeerState = {
        clientId,
        username,
        pc,
        initiator,
        remoteStream: null,
        gainNode: null,
        sourceNode: null,
        audioEl,
        makingOffer: false,
        volume: loadPeerVolume(username),
        muted: false,
        screenVideoStream: null,
        screenAudioStream: null,
        cameraStream: null,
    };
    state.peers.set(clientId, peer);

    // Приём удалённого звука
    pc.ontrack = (ev) => {
        // Видео и звук трансляции экрана — отдельно от голоса
        if (ev.track.kind === 'video') {
            const videos = videoTransceivers(pc);
            if (videos.length > 1 && (ev.transceiver === videos[1] || (ev.transceiver.mid !== null && ev.transceiver.mid === videos[1].mid))) {
                peer.cameraStream = new MediaStream([ev.track]);
                cameraTrackHandler?.(peer);
                return;
            }
            peer.screenVideoStream = new MediaStream([ev.track]);
            screenTrackHandler?.(peer, 'video');
            return;
        }
        const audios = audioTransceivers(pc);
        if (audios.length > 1 && (ev.transceiver === audios[1] || (ev.transceiver.mid !== null && ev.transceiver.mid === audios[1].mid))) {
            peer.screenAudioStream = new MediaStream([ev.track]);
            screenTrackHandler?.(peer, 'audio');
            return;
        }
        console.log(`🎧 [${peer.username}] получили удалённый звук`);
        // Если у отправителя нет «потока» (так бывает) — оборачиваем трек в свой поток
        peer.remoteStream = ev.streams[0] ?? new MediaStream([ev.track]);
        attachRemoteStream(peer);
    };

    // ICE-кандидаты (варианты сетевых путей) — шлём собеседнику через сервер
    pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const msg: MsgIce = {
            type: 'ice-candidate',
            to: clientId,
            from: state.selfId,
            candidate: ev.candidate.toJSON(),
        };
        sendToServer(msg);
    };

    pc.onconnectionstatechange = () => {
        console.log(`[${peer.username}] соединение: ${pc.connectionState}`);
        // Подключились — применяем ограничения качества, если мы сейчас показываем экран
        if (pc.connectionState === 'connected' && state.screenStream) void applyVideoParams(getVideoSender(pc));
        if (pc.connectionState === 'connected' && state.cameraStream) void applyCameraParams(getCameraSender(pc));
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[${peer.username}] ICE: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed' && peer.initiator) {
            console.warn(`[${peer.username}] ICE не удался — пробуем заново`);
            pc.restartIce();
        }
    };

    if (initiator) {
        // Мы начинаем: создаём «слот» для двустороннего звука.
        // Он нужен сразу — даже если микрофон ещё выключен, чтобы мы слышали собеседника
        // и могли потом включить микрофон без нового согласования.
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        // «Слоты» для экрана: видео и звук компьютера (используются, когда кто-то показывает экран)
        pc.addTransceiver('video', { direction: 'sendrecv' });
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        // «Слот» для веб-камеры
        pc.addTransceiver('video', { direction: 'sendrecv' });

        pc.onnegotiationneeded = async () => {
            try {
                peer.makingOffer = true;
                await pc.setLocalDescription();
                const msg: MsgOffer = {
                    type: 'offer',
                    to: clientId,
                    from: state.selfId,
                    sdp: pc.localDescription!.toJSON(),
                };
                sendToServer(msg);
            } catch (err) {
                console.error('negotiationneeded error:', err);
            } finally {
                peer.makingOffer = false;
            }
        };

        void attachLocalTrack(peer);
        void attachScreenTracks(peer);
        void attachCameraTrack(peer);
    }

    return peer;
}

/** Правило: кто шлёт offer первым */
function shouldInitiate(otherId: ClientId): boolean {
    return state.selfId < otherId;
}

// ============================================================
// Главная функция «mesh»: подгоняем соединения под список участников
//  - для новых участников создаём соединение
//  - для ушедших закрываем
// ============================================================
export function syncPeersWithParticipants(participants: Participant[]): void {
    const ids = new Set(participants.map((p) => p.clientId));

    for (const p of participants) {
        if (p.clientId === state.selfId) continue;
        const existing = state.peers.get(p.clientId);
        if (existing) {
            existing.username = p.username;
        } else {
            console.log(`👥 Новый участник: ${p.username}`);
            createPeer(p.clientId, p.username, shouldInitiate(p.clientId));
        }
    }

    for (const id of Array.from(state.peers.keys())) {
        if (!ids.has(id)) removePeer(id);
    }
}

// ============================================================
// Обработка входящих сигнальных сообщений.
// Сообщения обрабатываются строго по очереди — иначе ICE-кандидат
// может «обогнать» offer и потеряться.
// ============================================================
let signalChain: Promise<void> = Promise.resolve();

export function handleSignalMessage(msg: SignalingMessage): Promise<void> {
    signalChain = signalChain
        .then(() => processSignal(msg))
        .catch((err) => console.error('Ошибка обработки сигнала:', err));
    return signalChain;
}

async function processSignal(msg: SignalingMessage): Promise<void> {
    switch (msg.type) {
        case 'offer':
            await onRemoteOffer(msg);
            break;
        case 'answer':
            await onRemoteAnswer(msg);
            break;
        case 'ice-candidate':
            await onRemoteIce(msg);
            break;
    }
}

async function onRemoteOffer(msg: MsgOffer): Promise<void> {
    let peer = state.peers.get(msg.from);
    if (!peer) {
        // Offer пришёл раньше, чем мы узнали об участнике — берём его из списка
        const info = state.participants.find((p) => p.clientId === msg.from);
        if (!info) {
            console.warn(`offer от неизвестного участника ${msg.from}`);
            return;
        }
        peer = createPeer(info.clientId, info.username, false);
    }
    if (peer.initiator) {
        console.warn('Получили offer от того, кому мы сами должны слать offer — игнорируем');
        return;
    }
    const pc = peer.pc;

    await pc.setRemoteDescription(boostVideoSdp(msg.sdp));

    // Разрешаем и принимать, и отправлять звук в этом соединении
    for (const t of pc.getTransceivers()) {
        if (t.mid !== null && t.direction !== 'sendrecv') {
            t.direction = 'sendrecv';
        }
    }
    await attachLocalTrack(peer);
    await attachScreenTracks(peer);
    await attachCameraTrack(peer);

    await pc.setLocalDescription();
    const answer: MsgAnswer = {
        type: 'answer',
        to: msg.from,
        from: state.selfId,
        sdp: pc.localDescription!.toJSON(),
    };
    sendToServer(answer);
}

async function onRemoteAnswer(msg: MsgAnswer): Promise<void> {
    const peer = state.peers.get(msg.from);
    if (!peer) return;
    if (peer.pc.signalingState !== 'have-local-offer') {
        console.warn('answer в неверном состоянии:', peer.pc.signalingState);
        return;
    }
    await peer.pc.setRemoteDescription(boostVideoSdp(msg.sdp));
}

async function onRemoteIce(msg: MsgIce): Promise<void> {
    const peer = state.peers.get(msg.from);
    if (!peer) return;
    try {
        await peer.pc.addIceCandidate(msg.candidate);
    } catch (err) {
        console.warn('addIceCandidate error:', err);
    }
}

// ============================================================
// Убираем одного собеседника
// ============================================================
export function removePeer(clientId: ClientId): void {
    const peer = state.peers.get(clientId);
    if (!peer) return;
    closePeer(peer);
    state.peers.delete(clientId);
}

function closePeer(peer: PeerState): void {
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    try { peer.pc.close(); } catch { /* ignore */ }
    detachRemoteStream(peer);
    peer.screenVideoStream = null;
    peer.screenAudioStream = null;
    peer.cameraStream = null;
}

// ============================================================
// Закрыть все соединения (при выходе из комнаты)
// ============================================================
export function closeAllPeers(): void {
    for (const peer of state.peers.values()) closePeer(peer);
    state.peers.clear();
}

// ============================================================
// Микрофон включили/выключили — обновляем звук во ВСЕХ соединениях.
// Это не требует нового согласования: мы просто подменяем трек.
// ============================================================
export async function updateLocalTracksInAllPeers(): Promise<void> {
    for (const peer of state.peers.values()) {
        await attachLocalTrack(peer);
    }
}
