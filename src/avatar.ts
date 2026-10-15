// src/avatar.ts
// ============================================================
// Аватар пользователя: выбираем картинку, вырезаем квадрат из центра и
// сильно уменьшаем (128×128), чтобы она быстро доходила всем в комнате.
// Хранится только на вашем компьютере (и временно у участников комнаты).
// ============================================================

/** Макс. длина готового аватара в виде текста (сервер проверяет то же самое) */
export const MAX_AVATAR_CHARS = 30_000;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
import { t } from './i18n';
const KEY = 'pd_avatar';

export function isSafeAvatar(v: unknown): v is string {
    return typeof v === 'string' && v.length <= MAX_AVATAR_CHARS && AVATAR_RE.test(v);
}

export function getMyAvatar(): string | null {
    try {
        const v = localStorage.getItem(KEY);
        return isSafeAvatar(v) ? v : null;
    } catch { return null; }
}

export function saveMyAvatar(v: string | null): void {
    try {
        if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY);
    } catch { /* не критично */ }
}

/** Готовит аватар из выбранной картинки или бросает понятную ошибку */
export async function prepareAvatar(file: Blob): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error(t('Это не картинка.'));
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error(t('Не удалось открыть эту картинку.')); }
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    for (const [size, q] of [[128, 0.85], [128, 0.7], [96, 0.7], [96, 0.55], [64, 0.5]] as Array<[number, number]>) {
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        if (!ctx) break;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
        const url = c.toDataURL('image/jpeg', q);
        if (isSafeAvatar(url)) return url;
    }
    throw new Error(t('Не получилось уменьшить картинку. Попробуйте другую.'));
}
