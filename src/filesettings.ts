// src/filesettings.ts
// ============================================================
// Настройки отправки файлов в чате. Можно менять.
// ============================================================

/** Максимальный размер файла, МБ */
export const MAX_FILE_MB = 50;

/** Размер одной порции при передаче (байт). Менять не нужно. */
export const FILE_CHUNK_BYTES = 192 * 1024;

/** Расширения, которые могут запускать программы: при скачивании показываем предупреждение */
export const DANGEROUS_EXTENSIONS = [
    'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'lnk', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
    'ps1', 'psm1', 'jar', 'reg', 'hta', 'cpl', 'dll', 'sys', 'apk', 'appimage', 'sh', 'app', 'dmg', 'iso',
];

/** Расширение имени в нижнем регистре (без точки) */
export function fileExtension(name: string): string {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Безопасное имя файла: без путей и управляющих символов, не длиннее 120 знаков */
export function cleanFileName(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    let n = raw.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/[\\/]+/g, '_').trim();
    n = n.replace(/^\.+/, '');
    if (n.length > 120) {
        const ext = fileExtension(n);
        n = n.slice(0, 110) + (ext && ext.length <= 8 ? '.' + ext : '');
    }
    return n;
}
