// src/screen.ts
// ============================================================
// Трансляция экрана: запуск, остановка, смена качества.
// Видео идёт напрямую между участниками (см. webrtc.ts),
// сервер только следит, кто сейчас показывает экран (он один за раз).
// ============================================================
import { state } from './state';
import type { ScreenQuality, SignalingMessage, MsgScreenShare, MsgScreenViewers } from './protocol';
import { SCREEN_QUALITIES } from './screenquality';
import { updateScreenTracksInAllPeers, applyScreenQualityToAll } from './webrtc';
import { updateScreenStage, showScreenNotice } from './ui';
import { playRoomSound } from './audio';
import { explainScreenError } from './errors';
import { t } from './i18n';

/** Захват экрана, пока сервер не подтвердил, что мы можем показывать */
let capture: MediaStream | null = null;

function send(msg: SignalingMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function stopTracks(stream: MediaStream | null): void {
    stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
}

/** Начать показ. Возвращает текст ошибки или null, если всё хорошо. */
export async function startScreenShare(sourceId: string, quality: ScreenQuality, withAudio: boolean, priority: 'motion' | 'detail' = state.screenPriority): Promise<string | null> {
    if (state.screen && state.screen.sharerId !== state.selfId) {
        return t('Сейчас экран показывает {name}. Подождите, пока он закончит.', { name: state.screen.username });
    }
    if (state.screenStream || capture) await stopScreenShare();

    const q = SCREEN_QUALITIES[quality];
    state.screenQuality = quality;
    state.screenAudio = withAudio;
    state.screenPriority = priority;
    try {
        localStorage.setItem('pd_screen_priority', priority);
        localStorage.setItem('pd_screen_quality', quality);
        localStorage.setItem('pd_screen_audio', withAudio ? '1' : '0');
    } catch { /* ignore */ }

    let stream: MediaStream;
    try {
        await window.api.selectScreenSource(sourceId, withAudio);
        const audioConstraints = withAudio
            ? ({
                suppressLocalAudioPlayback: true, // не включать в трансляцию звук самого приложения (голоса друзей)
                restrictOwnAudio: true,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            } as MediaTrackConstraints)
            : false;
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } },
            audio: audioConstraints,
        });
    } catch (err) {
        console.warn('getDisplayMedia error:', err);
        return explainScreenError(err);
    }

    const vt = stream.getVideoTracks()[0];
    if (!vt) {
        stopTracks(stream);
        return t('Не удалось получить изображение экрана.');
    }
    try { vt.contentHint = priority; } catch { /* ignore */ }
    // Окно, которое показывали, закрыли — заканчиваем трансляцию
    vt.addEventListener('ended', () => { void stopScreenShare(); });
    capture = stream;
    // Ждём подтверждения от сервера (вдруг кто-то успел начать раньше)
    send({ type: 'screen-start', quality });
    return null;
}

/** Закончить показ */
export async function stopScreenShare(): Promise<void> {
    const wasSharing = !!capture || !!state.screenStream;
    stopTracks(capture);
    stopTracks(state.screenStream);
    capture = null;
    state.screenStream = null;
    if (wasSharing) {
        send({ type: 'screen-stop' });
        await updateScreenTracksInAllPeers();
    }
    if (state.screen?.sharerId === state.selfId) {
        // Сервер потом пришлёт «показ закончен», но к тому времени мы уже обнулили state.screen
        // и звук в onScreenShareMessage не сыграет — поэтому играем его здесь, сами.
        state.screen = null;
        playRoomSound('stream-stop');
    } else if (wasSharing) {
        playRoomSound('stream-stop'); // показ ещё не подтвердился сервером, но был остановлен
    }
    state.screenViewers = [];
    updateScreenStage();
}

/** Сменить качество, пока показываем экран */
export async function changeScreenQuality(quality: ScreenQuality): Promise<void> {
    state.screenQuality = quality;
    try { localStorage.setItem('pd_screen_quality', quality); } catch { /* ignore */ }
    if (!state.screenStream) return;
    if (state.screen) state.screen.quality = quality;
    send({ type: 'screen-start', quality });
    const q = SCREEN_QUALITIES[quality];
    const vt = state.screenStream.getVideoTracks()[0];
    try { await vt?.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } }); } catch { /* ignore */ }
    await applyScreenQualityToAll();
    updateScreenStage();
}

/** Сервер сообщает: кто-то начал / закончил показ */
export async function onScreenShareMessage(msg: MsgScreenShare): Promise<void> {
    if (msg.sharing) {
        const quality = msg.quality ?? '720';
        const wasSharer = state.screen?.sharerId;
        if (wasSharer !== msg.from) {
            // другая (новая) трансляция: смотреть заново нужно по желанию
            state.watchingScreen = false;
            state.screenViewers = [];
        }
        state.screen = { sharerId: msg.from, username: msg.username, quality };
        if (wasSharer !== msg.from) playRoomSound('stream-start');
        if (msg.from === state.selfId) {
            if (capture) {
                // сервер подтвердил — теперь отправляем картинку собеседникам
                state.screenStream = capture;
                capture = null;
                await updateScreenTracksInAllPeers();
            } else if (state.screenStream) {
                await applyScreenQualityToAll(); // просто сменилось качество
            }
        } else if (wasSharer !== msg.from) {
            showScreenNotice(t('{name} показывает экран — нажмите «Смотреть»', { name: msg.username }));
        }
    } else if (state.screen?.sharerId === msg.from) {
        playRoomSound('stream-stop');
        state.screen = null;
        state.watchingScreen = false;
        state.screenViewers = [];
        if (msg.from === state.selfId) {
            stopTracks(state.screenStream);
            state.screenStream = null;
            await updateScreenTracksInAllPeers();
        }
    }
    updateScreenStage();
}

/** Нажали «Смотреть» / «Перестать смотреть» */
export function watchScreen(on: boolean): void {
    if (on) {
        if (!state.screen || state.screen.sharerId === state.selfId) return;
        state.watchingScreen = true;
        send({ type: 'screen-watch', watching: true });
    } else {
        if (state.watchingScreen) send({ type: 'screen-watch', watching: false });
        state.watchingScreen = false;
    }
    updateScreenStage();
}

/** Сервер сообщает, кто сейчас смотрит трансляцию: видео отправляем только им */
export async function onScreenViewers(msg: MsgScreenViewers): Promise<void> {
    state.screenViewers = Array.isArray(msg.viewers) ? msg.viewers : [];
    if (state.screen?.sharerId === state.selfId) await updateScreenTracksInAllPeers();
    updateScreenStage();
}

/** Сервер не разрешил показ (уже показывает другой) */
export async function onScreenDenied(message: string): Promise<void> {
    stopTracks(capture);
    capture = null;
    showScreenNotice(message);
    updateScreenStage();
}

/** Выход из комнаты: прекратить всё, что связано с экраном */
export function resetScreen(): void {
    stopTracks(capture);
    stopTracks(state.screenStream);
    capture = null;
    state.screenStream = null;
    state.screen = null;
    state.watchingScreen = false;
    state.screenViewers = [];
    updateScreenStage();
}
