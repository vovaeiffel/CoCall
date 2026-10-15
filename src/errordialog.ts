// src/errordialog.ts
// ============================================================
// Окно с понятным сообщением об ошибке (вместо серого системного alert).
// ============================================================
import type { FriendlyError } from './errors';

let current: FriendlyError | null = null;

function el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

export function hideError(): void {
    el('error-modal')?.classList.remove('active');
    current = null;
}

/** Показать ошибку. focusId — поле, которое нужно подсветить после закрытия окна */
export function showError(e: FriendlyError, focusId?: string): void {
    console.warn('Ошибка для пользователя:', e.title, '—', e.text);
    window.dispatchEvent(new CustomEvent('app:error', { detail: `${e.title}. ${e.text}${e.hints?.length ? ' ' + e.hints.join(' ') : ''}` }));
    const modal = el('error-modal');
    if (!modal) { alert(`${e.title}\n\n${e.text}`); return; }
    current = e;
    el('error-title')!.textContent = e.title;
    el('error-text')!.textContent = e.text;
    const list = el('error-hints')!;
    const wrap = el('error-hints-wrap')!;
    list.textContent = '';
    for (const h of e.hints ?? []) {
        const li = document.createElement('li');
        li.textContent = h;
        list.append(li);
    }
    wrap.style.display = e.hints?.length ? '' : 'none';
    modal.dataset.focus = focusId ?? '';
    modal.classList.add('active');
    el('error-ok')?.focus();
}

export function setupErrorDialog(): void {
    const close = () => {
        const modal = el('error-modal');
        const focus = modal?.dataset.focus;
        hideError();
        if (focus) {
            const f = document.getElementById(focus) as HTMLInputElement | null;
            f?.focus();
            f?.classList.add('flash');
            window.setTimeout(() => f?.classList.remove('flash'), 1200);
        }
    };
    el('error-ok')?.addEventListener('click', close);
    el('error-modal')?.addEventListener('click', (ev) => { if (ev.target === el('error-modal')) close(); });
    document.addEventListener('keydown', (ev) => {
        if (current && (ev.key === 'Escape' || ev.key === 'Enter')) { ev.preventDefault(); close(); }
    });
}
