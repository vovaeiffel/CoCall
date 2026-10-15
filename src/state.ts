// src/state.ts
// ============================================================
// Глобальное состояние приложения.
// Всё, что меняется во время работы, живёт здесь.
// ============================================================
import type { ClientId, ScreenQuality } from './protocol';
import { isScreenQuality } from './screenquality';
import type { CameraQuality } from './cameraquality';

/** Порт, на котором хост запускает свой сервер */
export const SIGNALING_PORT = 8080;

/** Роль текущего экземпляра приложения */
export type Role = 'idle' | 'host' | 'guest';

/** Режим шумоподавления: выкл / обычное (встроенное в браузер) / нейросеть RNNoise */
export type NoiseMode = 'off' | 'standard' | 'rnnoise';

function loadNoiseMode(): NoiseMode {
    const v = localStorage.getItem('pd_noise_mode');
    return v === 'off' || v === 'standard' || v === 'rnnoise' ? v : 'rnnoise';
}

/** Порог микрофона: положение ползунка (1..100) -> громкость (0.001 .. 0.3, шкала логарифмическая, как децибелы) */
export function thresholdFromSlider(v: number): number {
    return 0.001 * Math.pow(300, Math.max(0, Math.min(100, v)) / 100);
}

/** Обратное: громкость (0..1) -> положение на шкале 0..100 (для индикатора уровня) */
export function sliderFromLevel(level: number): number {
    if (level <= 0.001) return 0;
    return Math.min(100, (100 * Math.log(level / 0.001)) / Math.log(300));
}

/** Участник комнаты (как его описывает сервер) */
export interface Participant {
    clientId: ClientId;
    username: string;
    isHost: boolean;
    avatar?: string;
}

/** Состояние одного удалённого пира (собеседника) */
export interface PeerState {
    /** ID собеседника (совпадает с clientId на его стороне) */
    clientId: ClientId;
    /** Имя собеседника */
    username: string;
    /** RTCPeerConnection для этого собеседника */
    pc: RTCPeerConnection;
    /** true — это мы начинаем соединение (шлём offer), false — мы только отвечаем */
    initiator: boolean;
    /** Полученный от него аудиопоток */
    remoteStream: MediaStream | null;
    /** Узел усиления (итоговая громкость этого собеседника) */
    gainNode: GainNode | null;
    /** Медиа-источник (чтобы потом отключить) */
    sourceNode: MediaStreamAudioSourceNode | null;
    /** Скрытый <audio>: нужен Chrome, чтобы удалённый звук вообще пошёл в Web Audio */
    audioEl: HTMLAudioElement;
    /** Флаг: прямо сейчас идёт создание offer'а */
    makingOffer: boolean;
    /** Личная громкость собеседника: 0..2 (1 = 100%) */
    volume: number;
    /** Личный «мьют» собеседника */
    muted: boolean;
    /** Видео его трансляции экрана (приходит, только пока он показывает экран) */
    screenVideoStream: MediaStream | null;
    /** Звук его трансляции экрана (звук компьютера) */
    screenAudioStream: MediaStream | null;
    /** Видео его веб-камеры (приходит, пока камера включена) */
    cameraStream: MediaStream | null;
}

/** Главный объект состояния */
export const state = {
    /** Роль приложения: idle (не подключён никуда), host (создал комнату), guest (зашёл в чужую) */
    role: 'idle' as Role,

    /** Имя текущего пользователя */
    username: localStorage.getItem('pd_username') || '',

    /** Уникальный ID текущего клиента (генерируется один раз за запуск) */
    selfId: crypto.randomUUID() as ClientId,

    /** Название текущей комнаты (если в комнате) */
    currentRoom: null as string | null,

    /** Мы уже в комнате (сервер подтвердил, что мы в списке участников) */
    inRoom: false,

    /** Мы хозяин комнаты, но сейчас вышли из неё (комната остаётся открытой, пока приложение работает) */
    hostAway: false,

    /** Сведения о нашей открытой комнате (приходят от сервера, пока мы вне комнаты) */
    myRoom: null as { name: string; members: number } | null,

    /** Гость подключился к серверу и ждёт список комнат, чтобы войти */
    pendingJoin: false,

    /** Активное WebSocket-соединение (есть, пока мы в комнате) */
    ws: null as WebSocket | null,

    /** Последний список участников от сервера */
    participants: [] as Participant[],

    /** Карта собеседников: key = clientId, value = PeerState */
    peers: new Map<ClientId, PeerState>(),

    /** Сырой поток с микрофона (нужен, чтобы потом выключить микрофон) */
    localStream: null as MediaStream | null,

    /** Поток, который реально уходит собеседникам (микрофон после регулировки громкости) */
    sendStream: null as MediaStream | null,

    /** Включён ли микрофон */
    isMicEnabled: false,

    /** Мы сейчас говорим (по данным определителя речи) */
    isSpeaking: false,

    /** Кто сейчас говорит (clientId всех участников, включая нас) — для подсветки аватаров */
    speakingIds: new Set<ClientId>(),

    /** AudioContext для микрофона (громкость + визуализатор) */
    micCtx: null as AudioContext | null,

    /** AudioContext для воспроизведения собеседников (отдельный, чтобы выключение микрофона не глушило их) */
    playbackCtx: null as AudioContext | null,

    /** Узел усиления для микрофона (регулирует исходящую громкость) */
    localGainNode: null as GainNode | null,

    /** Анализатор для визуализатора микрофона */
    analyser: null as AnalyserNode | null,

    /** ID анимации requestAnimationFrame */
    animationId: null as number | null,

    /** Закреплённый участник (показан крупно, остальные лентой); null — никто */
    pinnedId: null as ClientId | null,

    /** Участник, выбранный в контекстном меню */
    selectedParticipant: null as ClientId | null,

    /** Адрес хоста, к которому мы подключены (для гостя) */
    hostAddress: null as string | null,

    /** Общая громкость всех собеседников: 0..2 (1 = 100%) */
    masterVolume: 1,

    /** Режим шумоподавления (по умолчанию — RNNoise) */
    noiseMode: loadNoiseMode(),

    /** Узел RNNoise в цепочке микрофона (пока микрофон включён в этом режиме) */
    rnnoise: null as { destroy(): void } | null,

    /** Порог срабатывания микрофона: положение ползунка 1..100 (по умолчанию 30 ≈ 0.005) */
    micThresholdSlider: Math.max(1, Math.min(100, parseInt(localStorage.getItem('pd_mic_threshold') || '30', 10) || 30)),

    /** Текущая громкость микрофона 0..1 (для индикатора в настройках), 0 — микрофон выключен */
    micLevel: 0,

    /** Горячая клавиша «микрофон вкл/выкл» в формате Electron (например «Ctrl+Shift+M»); пусто — не задана */
    hotkey: localStorage.getItem('pd_hotkey') || '',

    /** Дополнительные TURN/STUN-серверы, которые прислал сервер комнаты */
    extraIceServers: [] as RTCIceServer[],

    /** Кто сейчас показывает экран (по данным сервера); null — никто */
    screen: null as { sharerId: ClientId; username: string; quality: ScreenQuality } | null,

    /** Кто из участников сейчас смотрит трансляцию (по данным сервера) */
    screenViewers: [] as ClientId[],

    /** Мы сами нажали «Смотреть» на чужой трансляции */
    watchingScreen: false,

    /** Что важнее при показе: плавность (игры) или чёткость (текст, видео) */
    screenPriority: (localStorage.getItem('pd_screen_priority') === 'detail' ? 'detail' : 'motion') as 'motion' | 'detail',

    /** Наш захват экрана, пока мы его показываем */
    screenStream: null as MediaStream | null,

    /** Выбранное качество трансляции */
    screenQuality: (isScreenQuality(localStorage.getItem('pd_screen_quality')) ? localStorage.getItem('pd_screen_quality') : '720') as ScreenQuality,

    /** Передавать ли звук компьютера вместе с экраном */
    screenAudio: localStorage.getItem('pd_screen_audio') !== '0',

    /** Громкость чужой трансляции: 0..100 */
    screenVolume: Math.max(0, Math.min(100, parseInt(localStorage.getItem('pd_screen_volume') || '100', 10) || 0)),

    /** У кого сейчас включена веб-камера (по данным сервера, включая нас) */
    cameraIds: [] as ClientId[],

    /** Наша камера (пока она включена) */
    cameraStream: null as MediaStream | null,

    /** Выбранная камера ('' = по умолчанию) */
    cameraDeviceId: localStorage.getItem('pd_camera_device') || '',

    /** Качество камеры: высота картинки (по умолчанию 360p — экономно для интернета) */
    cameraQuality: (['360', '480', '720'].includes(localStorage.getItem('pd_camera_quality') || '') ? localStorage.getItem('pd_camera_quality') : '360') as CameraQuality,

    /** Выбранный микрофон ('' = по умолчанию) */
    inputDeviceId: localStorage.getItem('pd_input_device') || '',

    /** Выбранные динамики/наушники ('' = по умолчанию) */
    outputDeviceId: localStorage.getItem('pd_output_device') || '',
};

/** Максимум участников в комнате (включая хоста) */
export const MAX_PARTICIPANTS = 8;

/** Публичные STUN-серверы Google (помогают узнать внешний адрес для прямого соединения) */
export const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
