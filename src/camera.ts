// src/camera.ts
// ============================================================
// Веб-камера: включение, выключение, смена устройства и качества.
// Видео идёт напрямую между участниками (см. webrtc.ts), сервер только
// следит, у кого камера включена, и не пускает больше 4 камер сразу.
// ============================================================
import { state } from './state';
import type { SignalingMessage, MsgCameras } from './protocol';
import { CAMERA_QUALITIES, type CameraQuality } from './cameraquality';
import { updateCameraTracksInAllPeers, applyCameraQualityToAll } from './webrtc';
import { updateCameraUI, showScreenNotice } from './ui';
import { showError } from './errordialog';
import { explainCameraError } from './errors';
import { t } from './i18n';

function send(msg: SignalingMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function stopTracks(stream: MediaStream | null): void {
    stream?.getTracks().forEach((tr) => { try { tr.stop(); } catch { /* ignore */ } });
}

async function openCamera(): Promise<MediaStream> {
    const q = CAMERA_QUALITIES[state.cameraQuality];
    const video: MediaTrackConstraints = {
        width: { ideal: q.width },
        height: { ideal: q.height },
        frameRate: { ideal: q.fps, max: 30 },
    };
    if (state.cameraDeviceId) video.deviceId = { exact: state.cameraDeviceId };
    try {
        return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
        // Выбранной камеры больше нет — пробуем камеру по умолчанию
        const name = (err as { name?: string } | null)?.name;
        if (state.cameraDeviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
            state.cameraDeviceId = '';
            localStorage.removeItem('pd_camera_device');
            delete video.deviceId;
            return await navigator.mediaDevices.getUserMedia({ video, audio: false });
        }
        throw err;
    }
}

export async function startCamera(): Promise<void> {
    if (state.cameraStream || !state.inRoom) return;
    let stream: MediaStream;
    try {
        stream = await openCamera();
    } catch (err) {
        console.warn('Камера не включилась:', err);
        showError(explainCameraError(err));
        return;
    }
    if (!state.inRoom) { stopTracks(stream); return; }
    state.cameraStream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { void stopCamera(); });
    send({ type: 'camera-set', on: true });
    await updateCameraTracksInAllPeers();
    updateCameraUI();
}

export async function stopCamera(): Promise<void> {
    if (!state.cameraStream) return;
    stopTracks(state.cameraStream);
    state.cameraStream = null;
    send({ type: 'camera-set', on: false });
    await updateCameraTracksInAllPeers();
    updateCameraUI();
}

export async function toggleCamera(): Promise<void> {
    if (state.cameraStream) await stopCamera();
    else await startCamera();
}

/** Сервер прислал список включённых камер */
export function onCameras(msg: MsgCameras): void {
    state.cameraIds = Array.isArray(msg.ids) ? msg.ids : [];
    updateCameraUI();
}

/** Сервер не разрешил включить камеру (уже 4 камеры) */
export async function onCameraDenied(_message: string): Promise<void> {
    stopTracks(state.cameraStream);
    state.cameraStream = null;
    await updateCameraTracksInAllPeers();
    showScreenNotice(t('В комнате уже включено максимальное число камер (4). Подождите, пока кто-то выключит свою.'));
    updateCameraUI();
}

/** Выбрали другую камеру в настройках */
export async function changeCameraDevice(deviceId: string): Promise<void> {
    state.cameraDeviceId = deviceId;
    if (deviceId) localStorage.setItem('pd_camera_device', deviceId);
    else localStorage.removeItem('pd_camera_device');
    await restartCameraIfRunning();
}

/** Выбрали другое качество камеры */
export async function changeCameraQuality(q: CameraQuality): Promise<void> {
    state.cameraQuality = q;
    localStorage.setItem('pd_camera_quality', q);
    await restartCameraIfRunning();
    await applyCameraQualityToAll();
}

async function restartCameraIfRunning(): Promise<void> {
    if (!state.cameraStream) return;
    const old = state.cameraStream;
    try {
        const fresh = await openCamera();
        state.cameraStream = fresh;
        fresh.getVideoTracks()[0]?.addEventListener('ended', () => { void stopCamera(); });
        stopTracks(old);
        await updateCameraTracksInAllPeers();
        updateCameraUI();
    } catch (err) {
        console.warn('Не удалось сменить камеру:', err);
        showError(explainCameraError(err));
    }
}

/** Выход из комнаты: выключить камеру (серверу сообщать не нужно — он и так знает) */
export function resetCamera(): void {
    stopTracks(state.cameraStream);
    state.cameraStream = null;
    state.cameraIds = [];
    updateCameraUI();
}
