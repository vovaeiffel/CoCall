// src/lobby.ts
// ============================================================
// «Чат сети» на главном экране (справа).
// Сюда пишут все, кто сейчас в одной сети с вами: домашний Wi-Fi,
// Radmin VPN, Hamachi, ZeroTier. Через интернет и через Tailscale
// это не работает — только там, где доходит сетевая рассылка.
// Сами сообщения живут в главном процессе (discovery.ts), здесь — только окно.
// ============================================================
import { t, getLocale } from './i18n';
import { nameColor } from './icons';
import { playRoomSound } from './audio';
import { state } from './state';

const POLL_MS = 1500;
const MAX_LEN = 400;

interface Msg { seq: number; id: string; name: string; text: string; ts: number; own: boolean }

export function setupLobby(): void {
    const panel = document.getElementById('lobby-panel');
    const list = document.getElementById('lobby-messages');
    const input = document.getElementById('lobby-input') as HTMLTextAreaElement | null;
    const sendBtn = document.getElementById('lobby-send') as HTMLButtonElement | null;
    const online = document.getElementById('lobby-online');
    const status = document.getElementById('lobby-status');
    const mainScreen = document.getElementById('main-screen');
    if (!panel || !list || !input || !sendBtn || !online || !status || !mainScreen) return;

    if (!window.api.lobbyPoll || !window.api.lobbySend || !window.api.lobbyName) {
        panel.style.display = 'none'; // старая оболочка без поддержки
        return;
    }

    let since = 0;
    let firstLoad = true;
    let sentName: string | null = null;
    let lastSender = '';
    let lastTs = 0;
    let statusTimer = 0;
    let busy = false;

    const emptyEl = document.createElement('div');
    emptyEl.className = 'chat-empty';
    list.appendChild(emptyEl);

    const showStatus = (text: string): void => {
        status.textContent = text;
        window.clearTimeout(statusTimer);
        if (text) statusTimer = window.setTimeout(() => { status.textContent = ''; }, 4000);
    };

    const timeStr = (ts: number): string =>
        new Date(ts).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });

    const appendMessage = (m: Msg): void => {
        const cont = lastSender === m.id && m.ts - lastTs < 120000;
        lastSender = m.id;
        lastTs = m.ts;
        const el = document.createElement('div');
        el.className = 'chat-msg' + (cont ? ' cont' : '');
        if (!cont) {
            const meta = document.createElement('div');
            meta.className = 'meta';
            const who = document.createElement('span');
            who.className = 'who';
            who.style.color = nameColor(m.name);
            who.textContent = m.own ? t('Вы') : m.name;
            const time = document.createElement('span');
            time.className = 'time';
            time.textContent = timeStr(m.ts);
            meta.append(who, time);
            el.appendChild(meta);
        }
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = m.text; // только текст, без разметки — безопасно
        el.appendChild(text);
        list.appendChild(el);
    };

    const renderEmpty = (hasName: boolean, others: number, hasMessages: boolean): void => {
        if (hasMessages) { emptyEl.style.display = 'none'; return; }
        emptyEl.style.display = '';
        if (!hasName) emptyEl.textContent = t('Введите своё имя слева, чтобы видеть чат сети и писать в него.');
        else if (others === 0) emptyEl.textContent = t('Пока никого нет рядом. Сюда попадают те, кто в одной с вами сети (Radmin VPN, Hamachi, ZeroTier, домашний Wi-Fi).');
        else emptyEl.textContent = t('Напишите первое сообщение — его увидят все, кто сейчас в сети.');
    };

    const visible = (): boolean => mainScreen.style.display !== 'none' && panel.getClientRects().length > 0;

    const tick = async (): Promise<void> => {
        if (busy || !visible()) return;
        busy = true;
        try {
            const name = (state.username || '').trim();
            if (name !== sentName) {
                sentName = name;
                await window.api.lobbyName?.(name);
                input.disabled = !name;
                sendBtn.disabled = !name;
                input.placeholder = name ? t('Сообщение для сети…') : t('Сначала введите своё имя');
            }
            const res = await window.api.lobbyPoll?.(since);
            if (!res) return;
            const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
            let fromOthers = false;
            for (const m of res.messages) {
                appendMessage(m);
                if (!m.own) fromOthers = true;
            }
            since = res.seq;
            const count = list.querySelectorAll('.chat-msg').length;
            renderEmpty(!!name, res.peers.length, count > 0);
            // «В сети»: все остальные + вы сами
            const total = name ? res.peers.length + 1 : res.peers.length;
            online.textContent = t('В сети: {n}', { n: total });
            online.title = res.peers.map((p) => p.name).join(', ');
            if (res.messages.length && stick) list.scrollTop = list.scrollHeight;
            if (fromOthers && !firstLoad) playRoomSound('message');
            firstLoad = false;
        } catch { /* чат сети — удобство, а не необходимость */ }
        finally { busy = false; }
    };

    const send = async (): Promise<void> => {
        const text = input.value.trim();
        if (!text || input.disabled) return;
        const res = await window.api.lobbySend?.(text);
        if (res?.ok) {
            input.value = '';
            await tick();
            list.scrollTop = list.scrollHeight;
            return;
        }
        switch (res?.error) {
            case 'too-fast': showStatus(t('Слишком часто — подождите пару секунд.')); break;
            case 'too-long': showStatus(t('Сообщение слишком длинное.')); break;
            case 'offline': showStatus(t('Чат сети недоступен: не удалось открыть сетевой порт.')); break;
            case 'no-name': showStatus(t('Сначала введите своё имя.')); break;
            default: break;
        }
    };

    input.maxLength = MAX_LEN;
    sendBtn.addEventListener('click', () => { void send(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
    });
    renderEmpty(false, 0, false);
    void tick();
    window.setInterval(() => { void tick(); }, POLL_MS);
}
