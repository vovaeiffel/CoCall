// src/screenquality.ts
// ============================================================
// Три варианта качества трансляции экрана.
// ============================================================
import type { ScreenQuality } from './protocol';

export interface QualityInfo {
    label: string;
    width: number;
    height: number;
    fps: number;
    /** Потолок скорости передачи видео, бит/с (на одного зрителя) */
    bitrate: number;
    /** То же в мегабитах — для подсказки пользователю */
    mbps: number;
}

export const SCREEN_QUALITIES: Record<ScreenQuality, QualityInfo> = {
    '1080': { label: '1080p', width: 1920, height: 1080, fps: 30, bitrate: 12_000_000, mbps: 12 },
    '720': { label: '720p', width: 1280, height: 720, fps: 30, bitrate: 6_000_000, mbps: 6 },
    '480': { label: '480p', width: 854, height: 480, fps: 30, bitrate: 2_500_000, mbps: 2.5 },
};

export function isScreenQuality(v: unknown): v is ScreenQuality {
    return v === '1080' || v === '720' || v === '480';
}

/**
 * Подсказка видеокодеку: с какой скорости начинать и какой нижний предел.
 * Без неё картинка 10–20 секунд «разгоняется» из мыла в чёткую.
 * Значения в килобитах в секунду.
 */
export const START_BITRATE_KBPS = 2500;
export const MIN_BITRATE_KBPS = 400;
export const MAX_BITRATE_KBPS = 12000;
