// src/i18n.ts
// ============================================================
// Перевод интерфейса. Использование:
//   t('Привет')                              → «Hello» на английском
//   t('Вошёл {name}', { name: 'Вова' })      → «Vova joined»
// Язык выбирается кнопкой на главном экране и запоминается.
// ============================================================
import { LANGUAGES } from './lang';
import type { Language } from './lang/types';

const KEY = 'pd_lang';

function detect(): Language {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
    const byCode = LANGUAGES.find((l) => l.code === saved);
    if (byCode) return byCode;
    // Первый запуск: язык Windows, если он у нас есть; иначе английский (а для русских — русский)
    const nav = (typeof navigator !== 'undefined' ? navigator.language : 'ru').toLowerCase();
    const byNav = LANGUAGES.find((l) => nav === l.code || nav.startsWith(l.code + '-'));
    return byNav ?? LANGUAGES.find((l) => l.code === 'en') ?? LANGUAGES[0];
}

let current: Language = detect();

export function getLanguage(): Language { return current; }
export function getLanguages(): Language[] { return LANGUAGES; }
export function getLocale(): string { return current.locale; }

/** Выбрать язык (после этого окно нужно перезагрузить — это делает кнопка на главном экране) */
export function setLanguage(code: string): void {
    const l = LANGUAGES.find((x) => x.code === code);
    if (!l) return;
    try { localStorage.setItem(KEY, l.code); } catch { /* ignore */ }
    current = l;
}

const missing = new Set<string>();

/** Перевести фразу (по необходимости подставив значения вместо {имя}) */
export function t(text: string, params?: Record<string, string | number>): string {
    let out = current.strings[text];
    if (out === undefined) {
        out = text;
        if (current.code !== 'ru' && /[А-Яа-яЁё]/.test(text) && !missing.has(text)) {
            missing.add(text);
            (window as unknown as { __i18nMissing?: string[] }).__i18nMissing = Array.from(missing);
        }
    }
    if (params) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
    return out;
}

/** Пометка «этот текст надо перевести, но не сейчас»: нужна там, где фраза уходит другому участнику и переводится уже у него */
export function N(text: string): string { return text; }

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function normalize(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

/** Переводит все надписи, которые уже написаны в index.html (текст, подсказки, placeholder) */
export function translateStaticPage(): void {
    document.documentElement.lang = current.code;
    if (current.code === 'ru') return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = (n as Text).parentElement;
        if (!parent || parent.closest('script,style')) continue;
        nodes.push(n as Text);
    }
    for (const node of nodes) {
        const raw = node.nodeValue ?? '';
        const key = normalize(raw);
        if (!key || !/[А-Яа-яЁё]/.test(key)) continue;
        const tr = t(key);
        if (tr !== key) node.nodeValue = raw.replace(key, tr.replace(/\$/g, '$$$$'));
    }
    document.querySelectorAll<HTMLElement>('*').forEach((el) => {
        for (const a of ATTRS) {
            const v = el.getAttribute(a);
            if (v && /[А-Яа-яЁё]/.test(v)) el.setAttribute(a, t(normalize(v)));
        }
    });
    const title = normalize(document.title);
    if (title && /[А-Яа-яЁё]/.test(title)) document.title = t(title);
}
