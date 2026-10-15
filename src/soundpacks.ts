// src/soundpacks.ts
// ============================================================
// Наборы звуков и свои звуки: что доступно и что выбрано.
// Список наборов даёт главный процесс (он умеет читать папки), здесь он хранится
// и используется при воспроизведении (audio.ts) и в настройках (soundsettings.ts).
// ============================================================
export interface SoundPack {
    id: string;
    name: string;
    /** Адрес папки набора (относительный для встроенных, file:// для пользовательских) */
    base: string;
    /** событие -> имя файла */
    files: Record<string, string>;
    builtin: boolean;
}
export type CustomSounds = Record<string, { name: string; url: string }>;
export interface SoundInfo { packs: SoundPack[]; custom: CustomSounds }

let info: SoundInfo = { packs: [], custom: {} };

export function setSoundInfo(next: Partial<SoundInfo> | null | undefined): void {
    info = { packs: Array.isArray(next?.packs) ? next!.packs! : [], custom: next?.custom && typeof next.custom === 'object' ? next.custom : {} };
}

export async function loadSoundInfo(): Promise<void> {
    try {
        setSoundInfo(await window.api?.listSoundPacks?.());
    } catch {
        setSoundInfo(null);
    }
}

export function getSoundInfo(): SoundInfo { return info; }

function read(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

/** Звуки уведомлений включены? */
export function soundsEnabled(): boolean { return read('pd_sound_on') !== '0'; }
export function setSoundsEnabled(on: boolean): void { write('pd_sound_on', on ? '1' : '0'); }

/** Громкость звуков уведомлений: 0..1 (по умолчанию 0,7, как было раньше) */
export function getSoundVolume(): number {
    const v = parseInt(read('pd_sound_volume') ?? '70', 10);
    return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 70)) / 100;
}
export function setSoundVolume(percent: number): void { write('pd_sound_volume', String(Math.max(0, Math.min(100, Math.round(percent))))); }

/** Выбранный набор ('' — стандартный) */
export function getSelectedPackId(): string { return read('pd_sound_pack') ?? ''; }
export function setSelectedPackId(id: string): void { write('pd_sound_pack', id); }

export function getSelectedPack(): SoundPack | null {
    const id = getSelectedPackId();
    return id ? info.packs.find((p) => p.id === id) ?? null : null;
}
