// src/theme.ts
// ============================================================
// Цветовые схемы: «Стандартная» (как раньше), «Светлая», «Тёмная» и «Своя».
// Все цвета в окне берутся из CSS-переменных (см. :root в index.html).
// Здесь мы либо оставляем стандартные, либо считаем новые из трёх цветов:
// фон, текст и акцент (остальные оттенки — панели, рамки, подсказки — выводятся из них).
// ============================================================
import { t } from './i18n';

export type ThemeId = 'default' | 'light' | 'dark' | 'custom';
export interface Palette { bg: string; text: string; accent: string }

const KEY = 'pd_theme';
const KEY_CUSTOM = 'pd_theme_custom';

/** Цвета стандартной схемы (для начальных значений «Своей») */
export const DEFAULT_PALETTE: Palette = { bg: '#151829', text: '#e9ebfa', accent: '#7b86ff' };

const PRESETS: Record<'light' | 'dark', Palette> = {
    light: { bg: '#eceef6', text: '#1a1d2e', accent: '#5560e8' },
    dark: { bg: '#0d0e12', text: '#ececf2', accent: '#7b86ff' },
};

const VARS = [
    '--bg', '--panel', '--panel-2', '--line', '--text', '--muted', '--accent', '--accent-hover',
    '--good', '--bad', '--accent-rgb', '--text-rgb', '--good-rgb', '--bad-rgb', '--warn-rgb',
    '--on-accent', '--on-good', '--on-bad', '--good-hover', '--bad-hover', '--warn', '--warn-text',
    '--hover', '--placeholder',
];

type RGB = [number, number, number];

export function isHex(s: unknown): s is string {
    return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

function toRgb(hex: string): RGB {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function toHex(c: RGB): string {
    return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Смешать два цвета: k = 0 → a, k = 1 → b */
function mix(a: string, b: string, k: number): string {
    const x = toRgb(a), y = toRgb(b);
    return toHex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}

/** Яркость цвета от 0 (чёрный) до 1 (белый) */
export function luminance(hex: string): number {
    const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = toRgb(hex);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Контрастность двух цветов (1 — одинаковые, 21 — чёрное на белом). Читать удобно от 4,5 */
export function contrast(a: string, b: string): number {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const rgbStr = (hex: string): string => toRgb(hex).join(', ');

/** Из трёх выбранных цветов получаем все переменные окна */
export function buildVars(p: Palette): Record<string, string> {
    const light = luminance(p.bg) > 0.4;
    const panel = light ? mix(p.bg, '#ffffff', 0.6) : mix(p.bg, p.text, 0.05);
    const panel2 = light ? mix(p.bg, p.text, 0.06) : mix(p.bg, p.text, 0.1);
    const good = light ? '#12a073' : '#54d6a4';
    const bad = light ? '#d6334a' : '#ff6f7f';
    const warn = light ? '#b86e0a' : '#f2a74e';
    return {
        '--bg': p.bg,
        '--panel': panel,
        '--panel-2': panel2,
        '--line': mix(p.bg, p.text, light ? 0.18 : 0.17),
        '--text': p.text,
        '--muted': mix(p.text, p.bg, 0.42),
        '--accent': p.accent,
        '--accent-hover': light ? mix(p.accent, '#000000', 0.12) : mix(p.accent, '#ffffff', 0.15),
        '--good': good,
        '--bad': bad,
        '--accent-rgb': rgbStr(p.accent),
        '--text-rgb': rgbStr(p.text),
        '--good-rgb': rgbStr(good),
        '--bad-rgb': rgbStr(bad),
        '--warn-rgb': rgbStr(warn),
        '--on-accent': luminance(p.accent) > 0.4 ? '#10122a' : '#ffffff',
        '--on-good': light ? '#ffffff' : '#0c2a20',
        '--on-bad': light ? '#ffffff' : '#2b0b11',
        '--good-hover': light ? '#0e8a62' : '#6fe3b6',
        '--bad-hover': light ? '#bd2a3f' : '#ff8a97',
        '--warn': warn,
        '--warn-text': light ? '#8a5100' : '#f2c98a',
        '--hover': mix(panel2, p.text, 0.08),
        '--placeholder': mix(p.text, p.bg, 0.55),
    };
}

export function getTheme(): ThemeId {
    try {
        const v = localStorage.getItem(KEY);
        if (v === 'light' || v === 'dark' || v === 'custom') return v;
    } catch { /* ignore */ }
    return 'default';
}

export function getCustomPalette(): Palette {
    try {
        const raw = localStorage.getItem(KEY_CUSTOM);
        if (raw) {
            const o = JSON.parse(raw) as Partial<Palette>;
            if (isHex(o.bg) && isHex(o.text) && isHex(o.accent)) return { bg: o.bg, text: o.text, accent: o.accent };
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_PALETTE };
}

function paletteOf(id: ThemeId): Palette | null {
    if (id === 'light' || id === 'dark') return PRESETS[id];
    if (id === 'custom') return getCustomPalette();
    return null; // стандартная: остаются цвета из index.html
}

/** Применить схему к окну (ничего не сохраняет) */
export function applyTheme(id: ThemeId, custom?: Palette): void {
    const root = document.documentElement;
    const pal = id === 'custom' && custom ? custom : paletteOf(id);
    for (const v of VARS) root.style.removeProperty(v);
    if (!pal) {
        root.removeAttribute('data-theme');
        root.style.colorScheme = 'dark';
        return;
    }
    const vars = buildVars(pal);
    for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
    root.setAttribute('data-theme', id);
    root.style.colorScheme = luminance(pal.bg) > 0.4 ? 'light' : 'dark';
}

/** При запуске: применить сохранённую схему */
export function applyStoredTheme(): void {
    applyTheme(getTheme());
}

function saveTheme(id: ThemeId): void {
    try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
}

function saveCustom(p: Palette): void {
    try { localStorage.setItem(KEY_CUSTOM, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Блок «Цветовая схема» в настройках → «Общее» */
export function setupThemeSettings(): void {
    const box = document.getElementById('theme-options');
    const customBox = document.getElementById('theme-custom');
    const warn = document.getElementById('theme-warn');
    if (!box || !customBox || !warn) return;

    const items: Array<{ id: ThemeId; label: string; sample: Palette }> = [
        { id: 'default', label: t('Стандартная'), sample: DEFAULT_PALETTE },
        { id: 'light', label: t('Светлая'), sample: PRESETS.light },
        { id: 'dark', label: t('Тёмная'), sample: PRESETS.dark },
        { id: 'custom', label: t('Своя'), sample: getCustomPalette() },
    ];
    const cards = new Map<ThemeId, HTMLButtonElement>();
    const swatch = (p: Palette): string => {
        const v = buildVars(p);
        return `background:${v['--bg']};border-color:${v['--line']}`;
    };

    const fields: Array<{ key: keyof Palette; label: string }> = [
        { key: 'bg', label: t('Фон') },
        { key: 'text', label: t('Текст') },
        { key: 'accent', label: t('Акцент (кнопки)') },
    ];
    const inputs = new Map<keyof Palette, HTMLInputElement>();
    for (const f of fields) {
        const row = document.createElement('label');
        row.className = 'theme-color-row';
        const span = document.createElement('span');
        span.textContent = f.label;
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = getCustomPalette()[f.key];
        row.append(span, inp);
        customBox.insertBefore(row, warn);
        inputs.set(f.key, inp);
    }
    const resetBtn = document.getElementById('theme-reset') as HTMLButtonElement | null;
    if (resetBtn) resetBtn.textContent = t('Сбросить цвета');

    const readCustom = (): Palette => ({
        bg: inputs.get('bg')!.value,
        text: inputs.get('text')!.value,
        accent: inputs.get('accent')!.value,
    });

    const refresh = (): void => {
        const cur = getTheme();
        for (const [id, el] of cards) {
            el.classList.toggle('active', id === cur);
            el.setAttribute('aria-pressed', id === cur ? 'true' : 'false');
        }
        customBox.style.display = cur === 'custom' ? '' : 'none';
        if (cur === 'custom') {
            const p = readCustom();
            warn.textContent = contrast(p.bg, p.text) < 4.5 ? t('Текст плохо виден на таком фоне — выберите более контрастные цвета.') : '';
            const card = cards.get('custom');
            const sw = card?.querySelector('.theme-swatch') as HTMLElement | null;
            if (sw) sw.setAttribute('style', swatch(p));
        }
    };

    for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-card';
        b.dataset.theme = it.id;
        const sw = document.createElement('span');
        sw.className = 'theme-swatch';
        sw.setAttribute('style', swatch(it.sample));
        const dot = document.createElement('i');
        dot.style.background = buildVars(it.sample)['--accent'];
        sw.appendChild(dot);
        const name = document.createElement('span');
        name.textContent = it.label;
        b.append(sw, name);
        b.addEventListener('click', () => {
            saveTheme(it.id);
            if (it.id === 'custom') saveCustom(readCustom());
            applyTheme(it.id);
            refresh();
        });
        box.appendChild(b);
        cards.set(it.id, b);
    }

    for (const inp of inputs.values()) {
        inp.addEventListener('input', () => {
            const p = readCustom();
            saveCustom(p);
            saveTheme('custom');
            applyTheme('custom', p);
            refresh();
        });
    }
    resetBtn?.addEventListener('click', () => {
        for (const f of fields) inputs.get(f.key)!.value = DEFAULT_PALETTE[f.key];
        const p = readCustom();
        saveCustom(p);
        saveTheme('custom');
        applyTheme('custom', p);
        refresh();
    });

    refresh();
}
