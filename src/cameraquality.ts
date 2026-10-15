// src/cameraquality.ts
// ============================================================
// Качество веб-камеры. Видео идёт каждому участнику отдельно,
// поэтому по умолчанию — экономные 360p.
// ============================================================
export type CameraQuality = '360' | '480' | '720';

export interface CameraQualityInfo {
    width: number;
    height: number;
    fps: number;
    /** Потолок скорости, бит/с */
    bitrate: number;
    /** Примерно столько мегабит в секунду уходит каждому зрителю */
    mbps: number;
}

export const CAMERA_QUALITIES: Record<CameraQuality, CameraQualityInfo> = {
    '360': { width: 640, height: 360, fps: 24, bitrate: 500_000, mbps: 0.5 },
    '480': { width: 854, height: 480, fps: 24, bitrate: 900_000, mbps: 0.9 },
    '720': { width: 1280, height: 720, fps: 30, bitrate: 1_800_000, mbps: 1.8 },
};

export function isCameraQuality(v: unknown): v is CameraQuality {
    return v === '360' || v === '480' || v === '720';
}
