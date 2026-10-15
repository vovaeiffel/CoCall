// src/chatimage.ts
// ============================================================
// Подготовка картинки для чата: уменьшаем и сжимаем, чтобы она
// быстро доходила и не нагружала сервер.
// ============================================================

/** Максимальная длина готовой картинки в виде текста (≈ 500 КБ) */
export const MAX_IMAGE_CHARS = 700_000;

const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Безопасна ли строка как адрес картинки (защита от подмены) */
export function isSafeImage(src: unknown): src is string {
    return typeof src === 'string' && src.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(src);
}

function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('Не удалось прочитать файл'));
        r.readAsDataURL(blob);
    });
}

/**
 * Возвращает готовую к отправке картинку (data-адрес) или бросает понятную ошибку.
 */
export async function prepareChatImage(file: Blob): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('Это не картинка.');

    // GIF не пережимаем (иначе пропадёт анимация) — берём как есть, если влезает
    if (file.type === 'image/gif') {
        const gif = await readAsDataUrl(file);
        if (!isSafeImage(gif)) throw new Error('GIF слишком большой (допустимо около 500 КБ).');
        return gif;
    }

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error('Не удалось открыть эту картинку.');
    }

    // Пробуем сначала крупнее и качественнее, затем всё меньше и сильнее сжатое
    const attempts: Array<[number, number]> = [[1280, 0.82], [1280, 0.65], [960, 0.6], [720, 0.55], [480, 0.5]];
    for (const [maxSide, quality] of attempts) {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) break;
        ctx.fillStyle = '#ffffff'; // прозрачные места PNG станут белыми (JPEG прозрачности не имеет)
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        const url = canvas.toDataURL('image/jpeg', quality);
        if (isSafeImage(url)) {
            bitmap.close();
            return url;
        }
    }
    bitmap.close();
    throw new Error('Не удалось уменьшить картинку до нужного размера.');
}
