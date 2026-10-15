// src/audio.ts
// ============================================================
// Работа со звуком:
//  - захват микрофона (с регулировкой громкости отправляемого звука)
//  - выбор микрофона и динамиков
//  - определение «говорит / молчит» (VAD) для подсветки аватара
//  - визуализатор (анализатор спектра)
//  - воспроизведение собеседников с индивидуальной громкостью
// ============================================================
import { getSoundVolume, soundsEnabled, getSoundInfo, getSelectedPack } from './soundpacks';
import { showError } from './errordialog';
import { explainMicError } from './errors';
import { state, thresholdFromSlider } from './state';
import { icon } from './icons';
import type { PeerState, NoiseMode } from './state';
import { createRnnoiseNode } from './rnnoise';
import type { RnnoiseNode } from './rnnoise';
import { updateLocalTracksInAllPeers } from './webrtc';
import { t } from './i18n';

// ============================================================
// Настройки определения речи (VAD)
// ============================================================
/** Сколько мс звук должен быть громким, чтобы считаться «начал говорить» */
const VAD_ATTACK_MS = 120;
/** Сколько мс должна быть тишина, чтобы считаться «закончил говорить» */
const VAD_RELEASE_MS = 450;
/** Как долго (мс) микрофон остаётся открытым после последнего громкого звука (чтобы не рубить концы слов) */
const GATE_HOLD_MS = 300;
/** Задержка звука перед «воротами» (сек): ворота успевают открыться до начала слова */
const GATE_LOOKAHEAD_S = 0.025;

let vadTimer: number | null = null;
let gateNode: GainNode | null = null;
let gateOpen = false;
let gateLoudAt = 0;
let vadSpeaking = false;
let vadAboveSince = 0;
let vadBelowSince = 0;

// ============================================================
// Кнопка микрофона
// ============================================================
function setMicButton(on: boolean): void {
    const micBtn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    if (!micBtn) return;
    micBtn.className = on ? 'control-btn mic-on' : 'control-btn mic-off';
    micBtn.innerHTML = icon(on ? 'mic' : 'mic-off', 24);
}

// ============================================================
// ВКЛ / ВЫКЛ микрофона
// ============================================================
let micBusy = false;

export async function toggleMic(): Promise<void> {
    if (micBusy) return; // защита от двойного клика
    micBusy = true;
    try {
        const wasOn = state.isMicEnabled;
        if (!wasOn) await startMic();
        else await stopMic();
        if (state.isMicEnabled !== wasOn) playRoomSound(state.isMicEnabled ? 'mic-on' : 'mic-off');
    } finally {
        micBusy = false;
    }
}

async function startMic(): Promise<void> {
    let mode: NoiseMode = state.noiseMode;

    // RNNoise работает только на 48 000 Гц
    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume();

    // Нейросеть запускаем заранее; если не вышло — переходим на обычное шумоподавление
    let rn: RnnoiseNode | null = null;
    if (mode === 'rnnoise') {
        try {
            rn = await createRnnoiseNode(ctx);
        } catch (err) {
            console.error('RNNoise не запустился:', err);
            window.dispatchEvent(new CustomEvent('audio:notice', { detail: t('Шумоподавление нового типа (RNNoise) не запустилось, поэтому включено обычное. Голос продолжает работать.') }));
            mode = 'standard';
        }
    }

    // В режиме RNNoise шум убирает нейросеть, поэтому встроенное подавление браузера выключаем.
    // Эхоподавление оставляем, а авто-громкость в этом режиме выключаем: она раздувала
    // тихие шумы и перегружала нейросеть (отсюда искажения).
    const base: MediaTrackConstraints = {
        echoCancellation: mode !== 'off',
        noiseSuppression: mode === 'standard',
        autoGainControl: mode === 'standard',
    };

    let raw: MediaStream;
    try {
        try {
            raw = await navigator.mediaDevices.getUserMedia({
                audio: state.inputDeviceId ? { ...base, deviceId: { exact: state.inputDeviceId } } : base,
            });
        } catch (err) {
            // Выбранный микрофон пропал (например, выдернули из USB) — берём микрофон по умолчанию
            const name = (err as DOMException).name;
            if (state.inputDeviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
                state.inputDeviceId = '';
                localStorage.removeItem('pd_input_device');
                raw = await navigator.mediaDevices.getUserMedia({ audio: base });
            } else {
                throw err;
            }
        }
    } catch (error) {
        console.error('Ошибка микрофона:', error);
        showError(explainMicError(error));
        rn?.destroy();
        try { await ctx.close(); } catch { /* ignore */ }
        return;
    }

    // Цепочка: микрофон -> [RNNoise] -> регулятор громкости -> анализаторы
    //                                                       \-> ворота -> ограничитель -> выход в сеть

    const source = ctx.createMediaStreamSource(raw);
    const gain = ctx.createGain();
    const inputVol = parseInt((document.getElementById('input-volume') as HTMLInputElement).value);
    gain.gain.value = inputVol / 100;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;

    // Отдельный анализатор для VAD: ему нужно больше отсчётов, чтобы громкость не «скакала»
    const vadAnalyser = ctx.createAnalyser();
    vadAnalyser.fftSize = 1024;

    const dest = ctx.createMediaStreamDestination();

    // Шумоподавление стоит сразу после микрофона, до регулятора громкости
    if (rn) {
        source.connect(rn.node);
        rn.node.connect(gain);
        state.rnnoise = rn;
    } else {
        source.connect(gain);
    }
    gain.connect(analyser);
    gain.connect(vadAnalyser);
    // Ограничитель громкости перед отправкой: громкие крики не «обрезаются», а сжимаются
    const limiter = ctx.createDynamicsCompressor();
    // Ловит только самые громкие пики, обычную речь не трогает (иначе звук «качает»)
    limiter.threshold.value = -2;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    // Ворота: звук тише порога в сеть не уходит. Перед воротами — маленькая задержка,
    // чтобы начало слова не обрезалось.
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = GATE_LOOKAHEAD_S;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    gain.connect(delay);
    delay.connect(gate);
    gate.connect(limiter);
    limiter.connect(dest);
    // К динамикам (ctx.destination) НЕ подключаем — иначе будете слышать сами себя.

    state.localStream = raw;
    state.micCtx = ctx;
    state.localGainNode = gain;
    state.analyser = analyser;
    state.sendStream = dest.stream;
    state.isMicEnabled = true;

    startVisualizer();
    startVad(vadAnalyser, gate);
    setMicButton(true);

    // Подключаем микрофон ко всем текущим собеседникам
    await updateLocalTracksInAllPeers();
}

export async function stopMic(): Promise<void> {
    if (!state.isMicEnabled && !state.localStream && !state.micCtx) return;

    state.isMicEnabled = false;
    state.sendStream = null;
    state.analyser = null;
    state.localGainNode = null;
    stopVad(); // заодно «гасит» подсветку, если мы в этот момент говорили
    stopVisualizer();
    setMicButton(false);

    // Убираем звук у всех собеседников
    await updateLocalTracksInAllPeers();

    if (state.localStream) {
        state.localStream.getTracks().forEach((t) => t.stop());
        state.localStream = null;
    }
    if (state.rnnoise) {
        state.rnnoise.destroy();
        state.rnnoise = null;
    }
    if (state.micCtx) {
        const ctx = state.micCtx;
        state.micCtx = null;
        try { await ctx.close(); } catch { /* ignore */ }
    }
}

/** Если микрофон сейчас включён — перезапускаем его (после смены устройства или режима шумоподавления) */
async function restartMicIfRunning(): Promise<void> {
    if (!state.isMicEnabled || micBusy) return;
    micBusy = true;
    try {
        await stopMic();
        await startMic();
    } finally {
        micBusy = false;
    }
}

/** Сменить микрофон */
export async function changeInputDevice(deviceId: string): Promise<void> {
    state.inputDeviceId = deviceId;
    if (deviceId) localStorage.setItem('pd_input_device', deviceId);
    else localStorage.removeItem('pd_input_device');
    await restartMicIfRunning();
}

/** Сменить режим шумоподавления */
export async function setNoiseMode(mode: NoiseMode): Promise<void> {
    state.noiseMode = mode;
    localStorage.setItem('pd_noise_mode', mode);
    await restartMicIfRunning();
}

/** Короткий сигнал при включении/выключении микрофона (особенно полезен с горячей клавишей, когда окно свёрнуто) */
let beepCtx: AudioContext | null = null;
export function playMicBeep(on: boolean): void {
    try {
        if (!beepCtx) {
            beepCtx = new AudioContext();
            applyOutputDevice(beepCtx);
        }
        const ctx = beepCtx;
        if (ctx.state === 'suspended') void ctx.resume();
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const t = ctx.currentTime;
        osc.frequency.value = on ? 880 : 440;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.13);
    } catch { /* звук не критичен */ }
}

/**
 * Звуки «кто-то зашёл в комнату» / «кто-то вышел».
 * Берутся из файлов sounds/join.* и sounds/leave.* (mp3, wav, ogg).
 * Если файла нет — играет простой встроенный сигнал.
 */
const ROOM_SOUND_EXTS = ['mp3', 'wav', 'ogg'];
const roomSoundSrc: Record<string, string | null | undefined> = {};

export type SoundKind = 'join' | 'leave' | 'stream-start' | 'stream-stop' | 'message' | 'mic-on' | 'mic-off';

/** Встроенные сигналы на случай, если своего файла нет: частоты, шаг между нотами, длительность, громкость */
const FALLBACK_TONES: Record<SoundKind, { freqs: number[]; step: number; dur: number; vol: number }> = {
    'join':         { freqs: [523, 784],      step: 0.11, dur: 0.14, vol: 0.07 },
    'leave':        { freqs: [784, 523],      step: 0.11, dur: 0.14, vol: 0.07 },
    'stream-start': { freqs: [440, 587, 880], step: 0.09, dur: 0.12, vol: 0.06 },
    'stream-stop':  { freqs: [880, 587, 440], step: 0.09, dur: 0.12, vol: 0.06 },
    'message':      { freqs: [1175],          step: 0,    dur: 0.09, vol: 0.05 },
    'mic-on':       { freqs: [880],           step: 0,    dur: 0.12, vol: 0.08 },
    'mic-off':      { freqs: [440],           step: 0,    dur: 0.12, vol: 0.08 },
};

function playFallbackTone(kind: SoundKind): void {
    try {
        if (!beepCtx) {
            beepCtx = new AudioContext();
            applyOutputDevice(beepCtx);
        }
        const ctx = beepCtx;
        if (ctx.state === 'suspended') void ctx.resume();
        const cfg = FALLBACK_TONES[kind];
        const vol = cfg.vol * Math.min(1, state.masterVolume) * (getSoundVolume() / 0.7);
        cfg.freqs.forEach((f, i) => {
            const t = ctx.currentTime + i * cfg.step;
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + cfg.dur);
            osc.connect(g);
            g.connect(ctx.destination);
            osc.start(t);
            osc.stop(t + cfg.dur + 0.01);
        });
    } catch { /* звук не критичен */ }
}

function soundCandidates(kind: SoundKind): string[] {
    const list: string[] = [];
    const custom = getSoundInfo().custom[kind];
    if (custom) list.push(custom.url);
    const pack = getSelectedPack();
    if (pack && pack.files[kind]) list.push(pack.base + encodeURIComponent(pack.files[kind]));
    for (const ext of ROOM_SOUND_EXTS) list.push(`sounds/${kind}.${ext}`);
    return list;
}

/** Выбрали другой набор или свой звук — забываем, какие файлы нашлись раньше */
export function resetSoundCache(): void {
    for (const k of Object.keys(roomSoundSrc)) delete roomSoundSrc[k];
}

let lastMessageSoundAt = 0;

/** Проиграть звук события: свой файл из папки sounds (mp3 / wav / ogg) или встроенный сигнал */
export function playRoomSound(kind: SoundKind, force = false): void {
    if (!force && !soundsEnabled()) return;
    if (kind === 'message' && !force) { // чтобы быстрая переписка не превращалась в трещотку
        const now = Date.now();
        if (now - lastMessageSoundAt < 1200) return;
        lastMessageSoundAt = now;
    }
    const start = (src: string, onError?: () => void): void => {
        const el = new Audio(src);
        el.volume = Math.max(0, Math.min(1, getSoundVolume() * state.masterVolume));
        const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
        if (state.outputDeviceId && typeof sink.setSinkId === 'function') sink.setSinkId(state.outputDeviceId).catch(() => { /* ignore */ });
        if (onError) el.addEventListener('error', onError, { once: true });
        el.play().then(() => { roomSoundSrc[kind] = src; }).catch(() => { /* ошибка загрузки придёт в событии error */ });
    };
    // Порядок: свой звук для этого события → выбранный набор → стандартные файлы → встроенный сигнал
    const candidates = soundCandidates(kind);
    const tryPlay = (idx: number): void => {
        if (idx >= candidates.length) {
            roomSoundSrc[kind] = null; // файлов нет — дальше сразу встроенный сигнал
            playFallbackTone(kind);
            return;
        }
        start(candidates[idx], () => tryPlay(idx + 1));
    };
    const known = roomSoundSrc[kind];
    if (known === null) { playFallbackTone(kind); return; }
    if (known) { start(known); return; }
    tryPlay(0);
}

/** Сменить порог срабатывания микрофона (1..100) */
export function setMicThreshold(slider: number): void {
    state.micThresholdSlider = Math.max(1, Math.min(100, Math.round(slider)));
    localStorage.setItem('pd_mic_threshold', String(state.micThresholdSlider));
}

/** Сменить динамики/наушники для голосов собеседников */
export function changeOutputDevice(deviceId: string): void {
    state.outputDeviceId = deviceId;
    if (deviceId) localStorage.setItem('pd_output_device', deviceId);
    else localStorage.removeItem('pd_output_device');
    applyOutputDevice(state.playbackCtx);
}

function applyOutputDevice(ctx: AudioContext | null): void {
    const c = ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!c || typeof c.setSinkId !== 'function') return;
    c.setSinkId(state.outputDeviceId).catch((err: unknown) => {
        console.warn('Не удалось выбрать устройство вывода:', err);
    });
}

/** Полностью остановить звук (при выходе из комнаты) */
export async function shutdownAudio(): Promise<void> {
    await stopMic();
    if (state.playbackCtx) {
        const ctx = state.playbackCtx;
        state.playbackCtx = null;
        try { await ctx.close(); } catch { /* ignore */ }
    }
}

// ============================================================
// Определение речи (VAD): «говорит» / «молчит»
// Только слушает громкость и сообщает о смене состояния событием
// 'audio:speaking' — сам звук при этом не меняется.
// ============================================================
function setSpeaking(speaking: boolean): void {
    if (vadSpeaking === speaking) return;
    vadSpeaking = speaking;
    state.isSpeaking = speaking;
    window.dispatchEvent(new CustomEvent('audio:speaking', { detail: { speaking } }));
}

function startVad(analyser: AnalyserNode, gate: GainNode): void {
    stopVad();
    gateNode = gate;
    gateOpen = false;
    gateLoudAt = 0;
    vadSpeaking = false;
    vadAboveSince = 0;
    vadBelowSince = 0;
    state.isSpeaking = false;

    const data = new Float32Array(analyser.fftSize);

    // Используем таймер, а не requestAnimationFrame: когда окно свёрнуто,
    // анимация останавливается, а определение речи должно работать.
    vadTimer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(data);

        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        const threshold = thresholdFromSlider(state.micThresholdSlider);
        state.micLevel = rms;

        // Ворота: открываем сразу, закрываем после паузы GATE_HOLD_MS
        if (gateNode) {
            const t = gateNode.context.currentTime;
            if (rms >= threshold) {
                gateLoudAt = now;
                if (!gateOpen) {
                    gateOpen = true;
                    gateNode.gain.setTargetAtTime(1, t, 0.005);
                }
            } else if (gateOpen && now - gateLoudAt >= GATE_HOLD_MS) {
                gateOpen = false;
                gateNode.gain.setTargetAtTime(0, t, 0.03);
            }
        }

        if (rms >= threshold) {
            vadBelowSince = 0;
            if (!vadSpeaking) {
                if (vadAboveSince === 0) vadAboveSince = now;
                if (now - vadAboveSince >= VAD_ATTACK_MS) setSpeaking(true);
            }
        } else {
            vadAboveSince = 0;
            if (vadSpeaking) {
                if (vadBelowSince === 0) vadBelowSince = now;
                if (now - vadBelowSince >= VAD_RELEASE_MS) setSpeaking(false);
            }
        }
    }, 20);
}

function stopVad(): void {
    gateNode = null;
    gateOpen = false;
    state.micLevel = 0;
    if (vadTimer !== null) {
        clearInterval(vadTimer);
        vadTimer = null;
    }
    // Если мы выключили микрофон во время речи — подсветка должна сразу погаснуть
    if (vadSpeaking) setSpeaking(false);
    else state.isSpeaking = false;
    vadAboveSince = 0;
    vadBelowSince = 0;
}

// ============================================================
// Визуализатор
// ============================================================
export function startVisualizer(): void {
    stopVisualizer();
    const canvas = document.getElementById('frequency-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
        if (!state.analyser) return;
        const bufferLength = state.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        state.analyser.getByteFrequencyData(dataArray);

        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#151829';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const barWidth = (canvas.width / bufferLength) * 2.5;
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * canvas.height;
            const hue = 235 - (dataArray[i] / 255) * 75; // от сине-фиолетового к мятному
            ctx.fillStyle = `hsl(${hue}, 75%, 62%)`;
            ctx.fillRect(i * barWidth, canvas.height - barHeight, barWidth, barHeight);
        }
        state.animationId = requestAnimationFrame(draw);
    };
    draw();
}

export function stopVisualizer(): void {
    if (state.animationId !== null) {
        cancelAnimationFrame(state.animationId);
        state.animationId = null;
    }
    const canvas = document.getElementById('frequency-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#151829';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ============================================================
// Воспроизведение собеседников
// ============================================================
function getPlaybackCtx(): AudioContext {
    if (!state.playbackCtx || state.playbackCtx.state === 'closed') {
        state.playbackCtx = new AudioContext();
        applyOutputDevice(state.playbackCtx);
    }
    if (state.playbackCtx.state === 'suspended') void state.playbackCtx.resume();
    return state.playbackCtx;
}

/** Итоговая громкость собеседника = личная * общая (или 0, если заглушен) */
export function applyPeerGain(peer: PeerState): void {
    if (!peer.gainNode) return;
    peer.gainNode.gain.value = peer.muted ? 0 : peer.volume * state.masterVolume;
}

function disconnectNodes(peer: PeerState): void {
    try { peer.sourceNode?.disconnect(); } catch { /* ignore */ }
    try { peer.gainNode?.disconnect(); } catch { /* ignore */ }
    peer.sourceNode = null;
    peer.gainNode = null;
}

/** «Ограничитель»: при громкости выше 100 % не даёт звуку трещать и хрипеть на пиках */
let limiterCtx: AudioContext | null = null;
let limiterNode: DynamicsCompressorNode | null = null;
function getLimiter(ctx: AudioContext): AudioNode {
    if (limiterNode && limiterCtx === ctx) return limiterNode;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.003;
    lim.release.value = 0.12;
    lim.connect(ctx.destination);
    limiterCtx = ctx;
    limiterNode = lim;
    return lim;
}

export function attachRemoteStream(peer: PeerState): void {
    if (!peer.remoteStream) return;
    disconnectNodes(peer);

    // ВАЖНО: Chrome «не отдаёт» удалённый звук в Web Audio, пока этот же поток
    // не подключён к какому-нибудь <audio>. Подключаем его (без звука — звук
    // пойдёт уже через наш регулятор громкости ниже).
    peer.audioEl.srcObject = peer.remoteStream;
    peer.audioEl.muted = true;
    void peer.audioEl.play().catch(() => { /* ignore */ });

    const ctx = getPlaybackCtx();
    const source = ctx.createMediaStreamSource(peer.remoteStream);
    const gain = ctx.createGain();

    source.connect(gain);
    gain.connect(getLimiter(ctx));

    peer.sourceNode = source;
    peer.gainNode = gain;
    applyPeerGain(peer);
}

export function detachRemoteStream(peer: PeerState): void {
    disconnectNodes(peer);
    try { peer.audioEl.pause(); } catch { /* ignore */ }
    peer.audioEl.srcObject = null;
    peer.remoteStream = null;
}

// ============================================================
// Громкость
// ============================================================
/** Громкость конкретного собеседника (0..200 %) */
export function setPeerVolume(clientId: string, value0to400: number): void {
    const peer = state.peers.get(clientId);
    if (!peer) return;
    peer.volume = Math.max(0, Math.min(4, value0to400 / 100));
    applyPeerGain(peer);
    savePeerVolume(peer.username, peer.volume);
}

/** Запомненная громкость собеседников (по имени), чтобы не настраивать каждый раз заново */
const PEER_VOLUMES_KEY = 'pd_peer_volumes';
function readPeerVolumes(): Record<string, number> {
    try {
        const v = JSON.parse(localStorage.getItem(PEER_VOLUMES_KEY) || '{}');
        return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
}
export function loadPeerVolume(username: string): number {
    const v = readPeerVolumes()[username];
    return typeof v === 'number' && v >= 0 && v <= 4 ? v : 1;
}
function savePeerVolume(username: string, vol: number): void {
    try {
        const all = readPeerVolumes();
        if (Math.abs(vol - 1) < 0.01) delete all[username]; else all[username] = Math.round(vol * 100) / 100;
        const keys = Object.keys(all);
        if (keys.length > 100) delete all[keys[0]];
        localStorage.setItem(PEER_VOLUMES_KEY, JSON.stringify(all));
    } catch { /* не критично */ }
}

/** «Мьют» конкретного собеседника */
export function setPeerMuted(clientId: string, muted: boolean): void {
    const peer = state.peers.get(clientId);
    if (!peer) return;
    peer.muted = muted;
    applyPeerGain(peer);
}

/** Общая громкость всех собеседников (0..200 %) */
export function setMasterOutputVolume(value0to400: number): void {
    state.masterVolume = value0to400 / 100;
    for (const peer of state.peers.values()) applyPeerGain(peer);
}

/** Громкость вашего микрофона (0..200 %) — влияет на то, что слышат собеседники */
export function setLocalInputVolume(value0to200: number): void {
    if (state.localGainNode) {
        state.localGainNode.gain.value = value0to200 / 100;
    }
}
