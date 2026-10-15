// src/diagnostics.ts
// ============================================================
// Экран «Диагностика»: проверяет то, из-за чего чаще всего «что-то не работает»,
// и простыми словами говорит, что не так и что делать.
// ============================================================
import { state, SIGNALING_PORT, ICE_SERVERS } from './state';
import { explainMicError, explainCameraError, explainConnectError } from './errors';
import { t } from './i18n';
import { icon } from './icons';

type Status = 'ok' | 'warn' | 'bad' | 'info';
interface Row { title: string; status: Status; text: string; hints?: string[] }

const MARK: Record<Status, string> = { ok: '✓', warn: '!', bad: '✗', info: 'i' };

function el<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

function renderRow(row: Row | { title: string; running: true }): HTMLElement {
    const div = document.createElement('div');
    if ('running' in row) {
        div.className = 'diag-row running';
        div.innerHTML = `<span class="diag-mark">…</span><div><div class="diag-title"></div><div class="diag-text">${t('Проверяю…')}</div></div>`;
        (div.querySelector('.diag-title') as HTMLElement).textContent = row.title;
        return div;
    }
    div.className = `diag-row ${row.status}`;
    const hints = (row.hints ?? []).map((h) => `<li></li>`).join('');
    div.innerHTML = `<span class="diag-mark">${MARK[row.status]}</span><div><div class="diag-title"></div><div class="diag-text"></div>${hints ? `<ul class="diag-hints">${hints}</ul>` : ''}</div>`;
    (div.querySelector('.diag-title') as HTMLElement).textContent = row.title;
    (div.querySelector('.diag-text') as HTMLElement).textContent = row.text;
    div.querySelectorAll('.diag-hints li').forEach((li, i) => { li.textContent = row.hints![i]; });
    return div;
}

// ---------- отдельные проверки ----------
async function checkVersion(): Promise<Row> {
    const title = t('Версия программы');
    try {
        const v = await window.api.getVersion();
        const info = await window.api.checkUpdate();
        if (info.available && info.version) {
            return { title, status: 'warn', text: t('Установлена {v}, но вышла новая: {n}.', { v, n: info.version }), hints: [t('Обновитесь: у друзей и у вас должны быть одинаковые версии, иначе чат, камеры и показ экрана могут работать по-разному.')] };
        }
        return { title, status: 'ok', text: t('Установлена версия {v}. Это последняя версия.', { v }) };
    } catch {
        return { title, status: 'info', text: t('Не удалось проверить наличие обновлений.') };
    }
}

async function checkMic(): Promise<Row> {
    const title = t('Микрофон');
    try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (!list.some((d) => d.kind === 'audioinput')) {
            const e = explainMicError({ name: 'NotFoundError' });
            return { title, status: 'bad', text: e.text, hints: e.hints };
        }
        if (state.localStream) return { title, status: 'ok', text: t('Микрофон работает (сейчас включён).') };
        const s = await navigator.mediaDevices.getUserMedia({ audio: state.inputDeviceId ? { deviceId: { exact: state.inputDeviceId } } : true });
        const label = s.getAudioTracks()[0]?.label ?? '';
        s.getTracks().forEach((tr) => tr.stop());
        return { title, status: 'ok', text: label ? t('Микрофон работает: {name}.', { name: label }) : t('Микрофон работает.') };
    } catch (err) {
        const e = explainMicError(err);
        return { title, status: 'bad', text: e.text, hints: e.hints };
    }
}

async function checkSpeakers(): Promise<Row> {
    const title = t('Динамики / наушники');
    try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const n = list.filter((d) => d.kind === 'audiooutput').length;
        if (n === 0) return { title, status: 'bad', text: t('Компьютер не видит устройств вывода звука.'), hints: [t('Подключите наушники или колонки и проверьте звук в настройках Windows.')] };
        return { title, status: 'ok', text: t('Найдено устройств вывода звука: {n}.', { n }) };
    } catch {
        return { title, status: 'info', text: t('Не удалось получить список устройств.') };
    }
}

async function checkCamera(): Promise<Row> {
    const title = t('Камера');
    try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (!list.some((d) => d.kind === 'videoinput')) return { title, status: 'info', text: t('Камера не найдена. Если она вам не нужна, всё в порядке.') };
        if (state.cameraStream) return { title, status: 'ok', text: t('Камера работает (сейчас включена).') };
        const s = await navigator.mediaDevices.getUserMedia({ video: state.cameraDeviceId ? { deviceId: { exact: state.cameraDeviceId } } : true });
        const label = s.getVideoTracks()[0]?.label ?? '';
        s.getTracks().forEach((tr) => tr.stop());
        return { title, status: 'ok', text: label ? t('Камера работает: {name}.', { name: label }) : t('Камера работает.') };
    } catch (err) {
        const e = explainCameraError(err);
        return { title, status: 'warn', text: e.text, hints: e.hints };
    }
}

async function checkNetwork(): Promise<Row> {
    const title = t('Сеть и виртуальная сеть (Radmin и т. п.)');
    try {
        const ip = await window.api.getLocalIp();
        const vpn = (await window.api.getVpnIps?.()) ?? [];
        if (vpn.length > 0) {
            return { title, status: 'ok', text: t('Найдена виртуальная сеть: {list}. Друзья подключаются по этому адресу.', { list: vpn.map((v) => `${v.label} ${v.ip}`).join(', ') }) };
        }
        return { title, status: 'info', text: t('Виртуальная сеть не найдена. Адрес в вашей сети: {ip}. Если вы играете с друзьями через Radmin или ZeroTier, проверьте, что программа запущена и вы подключены к сети.', { ip: ip || '—' }) };
    } catch {
        return { title, status: 'info', text: t('Не удалось определить адреса компьютера.') };
    }
}

/** Достучаться до публичного STUN-сервера: показывает, есть ли выход в интернет для звонков (UDP) */
async function checkInternet(): Promise<Row> {
    const title = t('Интернет для звонков (UDP)');
    let pc: RTCPeerConnection | null = null;
    try {
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.createDataChannel('diag');
        let found = false;
        const done = new Promise<void>((resolve) => {
            pc!.onicecandidate = (e) => {
                if (e.candidate && /\styp srflx\s/.test(e.candidate.candidate)) { found = true; resolve(); }
                if (!e.candidate) resolve();
            };
            window.setTimeout(resolve, 5000);
        });
        await pc.setLocalDescription(await pc.createOffer());
        await done;
        if (found) return { title, status: 'ok', text: t('Выход в интернет есть, звонки через интернет возможны.') };
        return {
            title, status: 'warn',
            text: t('Не получилось связаться с внешним сервером. Внутри вашей виртуальной сети звонки работать будут, а через интернет — возможно, нет.'),
            hints: [t('Проверьте, что интернет подключён.'), t('Брандмауэр или антивирус могут блокировать программу: разрешите CoCall выход в сеть.')],
        };
    } catch {
        return { title, status: 'warn', text: t('Проверить не удалось.') };
    } finally {
        try { pc?.close(); } catch { /* ignore */ }
    }
}

async function checkPeers(): Promise<Row> {
    const title = t('Связь с участниками комнаты');
    if (!state.inRoom) return { title, status: 'info', text: t('Вы сейчас не в комнате. Зайдите в комнату и запустите проверку ещё раз, чтобы увидеть связь с каждым участником.') };
    if (state.peers.size === 0) return { title, status: 'info', text: t('Кроме вас, в комнате пока никого нет.') };
    const lines: string[] = [];
    let worst: Status = 'ok';
    for (const peer of state.peers.values()) {
        let rtt: number | null = null;
        try {
            const stats = await peer.pc.getStats();
            stats.forEach((r) => {
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') rtt = Math.round(r.currentRoundTripTime * 1000);
            });
        } catch { /* ignore */ }
        const st = peer.pc.connectionState;
        let word: string;
        if (st === 'connected') {
            word = rtt !== null ? t('связь есть, задержка {ms} мс', { ms: rtt }) : t('связь есть');
            if (rtt !== null && rtt > 250 && worst === 'ok') worst = 'warn';
        } else if (st === 'connecting' || st === 'new') {
            word = t('подключаюсь…');
            if (worst === 'ok') worst = 'warn';
        } else {
            word = t('нет связи');
            worst = 'bad';
        }
        lines.push(`${peer.username}: ${word}`);
    }
    return {
        title, status: worst, text: lines.join('\n'),
        hints: worst === 'ok' ? undefined : [t('Если у кого-то нет связи, попросите его выйти из комнаты и зайти снова.'), t('Если у вас «подключаюсь…» долго, возможно, фаервол блокирует программу.')],
    };
}

/** Проверка адреса хоста: отвечает ли он и есть ли у него комната (в комнату не заходим) */
async function checkHost(raw: string): Promise<Row> {
    const title = t('Хост {address}', { address: raw });
    let address = raw.trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
    if (!address) return { title: t('Хост'), status: 'info', text: t('Введите адрес хоста, например 26.12.34.56:8080.') };
    if (!/:\d+$/.test(address)) address += `:${SIGNALING_PORT}`;
    return new Promise<Row>((resolve) => {
        let ws: WebSocket;
        let finished = false;
        const finish = (row: Row) => {
            if (finished) return;
            finished = true;
            window.clearTimeout(timer);
            try { ws.close(); } catch { /* ignore */ }
            resolve(row);
        };
        try { ws = new WebSocket(`ws://${address}`); } catch {
            const e = explainConnectError(new Error('Неверный адрес'), false);
            resolve({ title, status: 'bad', text: e.text, hints: e.hints });
            return;
        }
        const timer = window.setTimeout(() => {
            const e = explainConnectError(new Error('Хост не отвечает'), false);
            finish({ title, status: 'bad', text: e.text, hints: e.hints });
        }, 6000);
        ws.addEventListener('error', () => {
            const e = explainConnectError(new Error('Не удалось подключиться'), false);
            finish({ title, status: 'bad', text: e.text, hints: e.hints });
        });
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'register', clientId: crypto.randomUUID(), username: t('Проверка связи') }));
        });
        ws.addEventListener('message', (ev) => {
            let msg: { type?: string; rooms?: Array<{ name: string; hasPassword: boolean; memberCount?: number; guestCount?: number }> };
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type !== 'room-list') return;
            const room = msg.rooms?.[0];
            if (!room) finish({ title, status: 'warn', text: t('Хост отвечает, но комнату он ещё не создал.'), hints: [t('Попросите хоста нажать «Создать комнату».')] });
            else finish({
                title, status: 'ok',
                text: t('Хост отвечает. Комната «{name}», участников: {n}{pw}.', { name: room.name, n: room.memberCount ?? room.guestCount ?? 0, pw: room.hasPassword ? t(', нужен пароль') : '' }),
            });
        });
    });
}

// ---------- окно ----------
let lastReport = '';

export function setupDiagnostics(): void {
    const modal = el<HTMLElement>('diag-modal');
    const list = el<HTMLElement>('diag-list');
    const runBtn = el<HTMLButtonElement>('diag-run');
    const copyBtn = el<HTMLButtonElement>('diag-copy');
    const addr = el<HTMLInputElement>('diag-address');
    const hostBtn = el<HTMLButtonElement>('diag-host');
    if (!modal) return;
    el<HTMLElement>('diag-title-icon').innerHTML = icon('activity', 20);

    let running = false;
    const collect = () => {
        lastReport = Array.from(list.querySelectorAll('.diag-row:not(.running)')).map((r) => {
            const mark = (r.querySelector('.diag-mark') as HTMLElement).textContent;
            const title = (r.querySelector('.diag-title') as HTMLElement).textContent;
            const text = (r.querySelector('.diag-text') as HTMLElement).textContent;
            const hints = Array.from(r.querySelectorAll('.diag-hints li')).map((li) => '   - ' + li.textContent).join('\n');
            return `[${mark}] ${title}: ${text}${hints ? '\n' + hints : ''}`;
        }).join('\n');
    };
    const runOne = async (title: string, fn: () => Promise<Row>, replace?: HTMLElement) => {
        const placeholder = renderRow({ title, running: true });
        if (replace) replace.replaceWith(placeholder); else list.append(placeholder);
        list.scrollTop = list.scrollHeight;
        const row = await fn();
        const done = renderRow(row);
        placeholder.replaceWith(done);
        list.scrollTop = list.scrollHeight;
        return done;
    };

    const runAll = async () => {
        if (running) return;
        running = true;
        runBtn.disabled = true;
        list.textContent = '';
        const version = await window.api.getVersion().catch(() => '');
        const head = document.createElement('div');
        head.className = 'hint';
        const ev = /Electron\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
        head.textContent = `CoCall ${version}${ev ? ' · ' + ev : ''}`;
        list.append(head);
        await runOne(t('Версия программы'), checkVersion);
        await runOne(t('Микрофон'), checkMic);
        await runOne(t('Динамики / наушники'), checkSpeakers);
        await runOne(t('Камера'), checkCamera);
        await runOne(t('Сеть и виртуальная сеть (Radmin и т. п.)'), checkNetwork);
        await runOne(t('Интернет для звонков (UDP)'), checkInternet);
        await runOne(t('Связь с участниками комнаты'), checkPeers);
        collect();
        copyBtn.disabled = false;
        runBtn.disabled = false;
        running = false;
    };

    const open = () => {
        modal.classList.add('active');
        void runAll();
    };
    document.getElementById('diag-btn')?.addEventListener('click', open);
    window.addEventListener('ui:open-diagnostics', open);
    runBtn.addEventListener('click', () => { void runAll(); });
    hostBtn.addEventListener('click', async () => {
        hostBtn.disabled = true;
        await runOne(t('Хост'), () => checkHost(addr.value));
        collect();
        copyBtn.disabled = false;
        hostBtn.disabled = false;
    });
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') hostBtn.click(); });
    copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(lastReport); copyBtn.textContent = t('Скопировано'); } catch { copyBtn.textContent = t('Не удалось скопировать'); }
        window.setTimeout(() => { copyBtn.textContent = t('Скопировать отчёт'); }, 1800);
    });
    el<HTMLButtonElement>('diag-close').addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) modal.classList.remove('active'); });
}
