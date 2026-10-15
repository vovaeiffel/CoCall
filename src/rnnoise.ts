// src/rnnoise.ts
// ============================================================
// Нейросетевое шумоподавление RNNoise.
// Берёт звук с микрофона, убирает шум (клавиатура, вентилятор, гул)
// и оставляет голос. Работает полностью на вашем компьютере.
//
// Вся обработка идёт в отдельном аудио-потоке (AudioWorklet), поэтому
// не зависит от того, чем занято окно приложения, и не даёт щелчков.
// RNNoise обрабатывает звук кусочками по 480 отсчётов при 48 000 Гц
// (10 мс); браузер отдаёт по 128, поэтому внутри есть буферы-переходники.
// ============================================================
import { RNNOISE_WASM_BASE64 } from './rnnoise/rnnoise-wasm';

/** Код, который работает внутри аудио-потока */
const WORKLET_SOURCE = `
class RnnoiseProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const FRAME = 480;
        const RING = 8192;
        const self = this;
        this.FRAME = FRAME;
        this.RING = RING;
        this.mem = null;
        const imports = { a: {
            // увеличить память wasm
            a: function (req) {
                try {
                    const cur = self.mem.buffer.byteLength;
                    if (req > 2147483648) return 0;
                    self.mem.grow(Math.ceil((req - cur) / 65536));
                    return 1;
                } catch (e) { return 0; }
            },
            // копирование памяти
            b: function (d, s, n) {
                new Uint8Array(self.mem.buffer).copyWithin(d, s, s + n);
            },
        } };
        const inst = new WebAssembly.Instance(options.processorOptions.module, imports);
        const ex = inst.exports;
        this.ex = ex;
        this.mem = ex.c;
        ex.d(); // инициализация модуля
        this.inPtr = ex.e(FRAME * 4);
        this.outPtr = ex.e(FRAME * 4);
        this.st = ex.h(0);
        this.f32 = new Float32Array(this.mem.buffer);
        this.inRing = new Float32Array(RING);
        this.outRing = new Float32Array(RING);
        this.inW = 0; this.inR = 0;
        this.outW = FRAME; // 10 мс тишины в запасе, чтобы выход никогда не «не успевал»
        this.outR = 0;
        this.enabled = true;
        this.dead = false;
        this.port.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'enabled') this.enabled = !!m.value;
            if (m.type === 'destroy' && !this.dead) {
                this.dead = true;
                ex.i(this.st);
                ex.f(this.inPtr);
                ex.f(this.outPtr);
            }
        };
    }

    process(inputs, outputs) {
        if (this.dead) return false;
        const out = outputs[0];
        if (!out || !out.length) return true;
        const o = out[0];
        const input = inputs[0] && inputs[0][0];
        const n = o.length;

        if (!input) {
            o.fill(0);
        } else if (!this.enabled) {
            o.set(input);
        } else {
            const FRAME = this.FRAME, RING = this.RING, M = RING - 1;
            const inRing = this.inRing, outRing = this.outRing;
            for (let i = 0; i < n; i++) inRing[(this.inW + i) & M] = input[i];
            this.inW += n;

            while (this.inW - this.inR >= FRAME) {
                if (this.f32.buffer !== this.mem.buffer) this.f32 = new Float32Array(this.mem.buffer);
                const heap = this.f32;
                const ii = this.inPtr >> 2, oi = this.outPtr >> 2;
                for (let i = 0; i < FRAME; i++) heap[ii + i] = inRing[(this.inR + i) & M] * 32768;
                this.inR += FRAME;
                this.ex.j(this.st, this.outPtr, this.inPtr);
                for (let i = 0; i < FRAME; i++) {
                    // Мягкое ограничение: громкие пики плавно сглаживаются, а не обрезаются
                    const y = heap[oi + i] / 32768;
                    const ay = y < 0 ? -y : y;
                    outRing[this.outW & M] = ay <= 0.7 ? y : (y < 0 ? -1 : 1) * (0.7 + 0.3 * Math.tanh((ay - 0.7) / 0.3));
                    this.outW++;
                }
            }
            for (let i = 0; i < n; i++) {
                o[i] = this.outR < this.outW ? outRing[this.outR++ & M] : 0;
            }
        }
        for (let c = 1; c < out.length; c++) out[c].set(o);
        return true;
    }
}
registerProcessor('rnnoise-processor', RnnoiseProcessor);
`;

let modulePromise: Promise<WebAssembly.Module> | null = null;

/** Компилирует wasm-модуль нейросети (один раз за запуск приложения) */
export function loadRnnoise(): Promise<WebAssembly.Module> {
    if (!modulePromise) {
        modulePromise = (async () => {
            const bin = atob(RNNOISE_WASM_BASE64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return WebAssembly.compile(bytes);
        })();
        modulePromise.catch(() => { modulePromise = null; }); // при ошибке можно попробовать снова
    }
    return modulePromise;
}

export interface RnnoiseNode {
    /** Узел, который нужно вставить в цепочку обработки звука */
    node: AudioWorkletNode;
    /** Включить/выключить подавление (выключено — звук проходит как есть) */
    setEnabled(enabled: boolean): void;
    /** Освободить память */
    destroy(): void;
}

/**
 * Создаёт узел шумоподавления для AudioContext.
 * AudioContext должен быть с частотой 48000 Гц.
 */
export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseNode> {
    const mod = await loadRnnoise();
    // Через data:-адрес: из локального файла (file://) загрузка через blob: браузер запрещает
    const url = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SOURCE);
    await ctx.audioWorklet.addModule(url);

    const node = new AudioWorkletNode(ctx, 'rnnoise-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { module: mod },
    });
    node.onprocessorerror = () => console.error('RNNoise: ошибка в аудио-потоке');

    return {
        node,
        setEnabled(v: boolean) { node.port.postMessage({ type: 'enabled', value: v }); },
        destroy() {
            node.port.postMessage({ type: 'destroy' });
            try { node.disconnect(); } catch { /* ignore */ }
        },
    };
}
