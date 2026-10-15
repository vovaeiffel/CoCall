// src/format.ts
import { t } from './i18n';

/** Размер файла для людей: «1.2 МБ» / «1.2 MB» */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} ${t('Б')}`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} ${t('КБ')}`;
    return `${(bytes / 1024 / 1024).toFixed(1)} ${t('МБ')}`;
}
