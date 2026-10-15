// src/files.ts
// ============================================================
// Отправка файлов в чате.
//
// Как это работает:
//  1. Отправитель выкладывает в чат «карточку» файла (имя и размер). Сам файл никуда не уходит.
//  2. Тот, кто нажал «Скачать», просит файл у отправителя.
//  3. Отправитель присылает файл порциями через сервер комнаты; получатель
//     подтверждает каждую порцию (так канал не забивается и голос не страдает).
//  4. Скачанный файл сохраняется обычным способом (диалог «Сохранить как»).
// Пока отправитель не вышел из комнаты, файл можно скачать. Истории файлов нет.
// ============================================================
import { state } from './state';
import { MAX_FILE_MB, FILE_CHUNK_BYTES, cleanFileName, fileExtension, DANGEROUS_EXTENSIONS } from './filesettings';
import { formatSize } from './format';
import { t, N } from './i18n';
import type { ChatMessage, ClientId, SignalingMessage } from './protocol';

const WINDOW = 6;                 // сколько порций может быть «в пути» без подтверждения
const STALL_MS = 30_000;          // нет новых порций столько времени — считаем, что передача оборвалась
const MAX_BUFFERED = 4 * 1024 * 1024;

function send(msg: SignalingMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

export type FileProgress = { fileId: string; status: 'loading' | 'done' | 'error'; percent: number; text: string };
function emit(p: FileProgress): void {
    window.dispatchEvent(new CustomEvent<FileProgress>('files:progress', { detail: p }));
}

// ---------- отправитель ----------
const pendingOffers: File[] = [];          // выбранные, но ещё не подтверждённые сервером
const offered = new Map<string, File>();   // id сообщения → файл
interface Outgoing { file: File; to: ClientId; fileId: string; seq: number; offset: number; inflight: number; busy: boolean; dead: boolean; }
const outgoing = new Map<string, Outgoing>();

/** Предложить файл в чат. Возвращает текст ошибки или null. */
export function offerFile(file: File, text = ''): string | null {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return t('Нет соединения с комнатой.');
    if (file.size < 1) return t('Файл пустой.');
    if (file.size > MAX_FILE_MB * 1024 * 1024) return t('Файл слишком большой: {size}. Допустимо до {max} МБ.', { size: formatSize(file.size), max: MAX_FILE_MB });
    const name = cleanFileName(file.name);
    if (!name) return t('У файла странное имя, отправить его нельзя.');
    pendingOffers.push(file);
    send({ type: 'chat-send', text, file: { name, size: file.size } });
    return null;
}

/** Сервер подтвердил наше предложение (оно пришло обратно как сообщение чата) */
export function onChatMessage(m: ChatMessage): void {
    if (!m.file || m.from !== state.selfId) return;
    const i = pendingOffers.findIndex((f) => cleanFileName(f.name) === m.file!.name && f.size === m.file!.size);
    if (i < 0) return;
    offered.set(m.id, pendingOffers.splice(i, 1)[0]);
}

function readChunk(file: File, start: number): Promise<{ data: string; length: number }> {
    const blob = file.slice(start, start + FILE_CHUNK_BYTES);
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve({ data: String(r.result).split(',')[1] ?? '', length: blob.size });
        r.onerror = () => reject(new Error('read'));
        r.readAsDataURL(blob);
    });
}

async function pump(o: Outgoing): Promise<void> {
    if (o.busy) return;
    o.busy = true;
    try {
        while (!o.dead && o.inflight < WINDOW && o.offset < o.file.size) {
            if (state.ws && state.ws.bufferedAmount > MAX_BUFFERED) {
                await new Promise((r) => setTimeout(r, 100));
                continue;
            }
            const { data, length } = await readChunk(o.file, o.offset);
            if (o.dead) return;
            o.offset += length;
            const last = o.offset >= o.file.size;
            send({ type: 'file-chunk', to: o.to, fileId: o.fileId, seq: o.seq++, data, last });
            o.inflight++;
            if (last) { outgoing.delete(`${o.fileId}|${o.to}`); o.dead = true; }
        }
    } catch {
        o.dead = true;
        outgoing.delete(`${o.fileId}|${o.to}`);
        send({ type: 'file-cancel', to: o.to, fileId: o.fileId, reason: N('Не удалось прочитать файл') });
    } finally {
        o.busy = false;
    }
}

// ---------- получатель ----------
interface Incoming { fileId: string; from: ClientId; name: string; size: number; parts: Blob[]; received: number; nextSeq: number; timer: number; }
const incoming = new Map<string, Incoming>();

export function isDangerousName(name: string): boolean {
    return DANGEROUS_EXTENSIONS.includes(fileExtension(name));
}

function armStall(inc: Incoming): void {
    window.clearTimeout(inc.timer);
    inc.timer = window.setTimeout(() => fail(inc.fileId, N('Передача оборвалась'), true), STALL_MS);
}

function fail(fileId: string, reason: string, notifyOwner: boolean): void {
    const inc = incoming.get(fileId);
    if (!inc) return;
    window.clearTimeout(inc.timer);
    incoming.delete(fileId);
    if (notifyOwner) send({ type: 'file-cancel', to: inc.from, fileId, reason });
    emit({ fileId, status: 'error', percent: 0, text: t(reason) });
}

/** Пользователь нажал «Скачать» */
export function downloadFile(fileId: string, from: ClientId, name: string, size: number): void {
    if (incoming.has(fileId)) return;
    if (isDangerousName(name) &&
        !confirm(t('«{name}» — программа или скрипт: такие файлы могут запускать что угодно на вашем компьютере.\n\nСкачивайте, только если доверяете отправителю. Скачать?', { name }))) return;
    const inc: Incoming = { fileId, from, name, size, parts: [], received: 0, nextSeq: 0, timer: 0 };
    incoming.set(fileId, inc);
    armStall(inc);
    emit({ fileId, status: 'loading', percent: 0, text: t('Запрашиваю…') });
    send({ type: 'file-request', to: from, fileId });
}

function saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function decode(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
}

/** Все сообщения протокола передачи файлов */
export function handleFileMessage(msg: SignalingMessage): void {
    switch (msg.type) {
        case 'file-request': {
            const from = msg.from;
            const file = offered.get(msg.fileId);
            if (!from) return;
            if (!file) { send({ type: 'file-cancel', to: from, fileId: msg.fileId, reason: N('Файл больше недоступен') }); return; }
            const key = `${msg.fileId}|${from}`;
            if (outgoing.has(key)) return;
            const o: Outgoing = { file, to: from, fileId: msg.fileId, seq: 0, offset: 0, inflight: 0, busy: false, dead: false };
            outgoing.set(key, o);
            void pump(o);
            return;
        }
        case 'file-ack': {
            const o = msg.from ? outgoing.get(`${msg.fileId}|${msg.from}`) : undefined;
            if (!o) return;
            o.inflight = Math.max(0, o.inflight - 1);
            void pump(o);
            return;
        }
        case 'file-cancel': {
            if (msg.from) {
                const o = outgoing.get(`${msg.fileId}|${msg.from}`);
                if (o) { o.dead = true; outgoing.delete(`${msg.fileId}|${msg.from}`); }
            }
            const inc = incoming.get(msg.fileId);
            if (inc && (!msg.from || msg.from === inc.from)) fail(msg.fileId, msg.reason || N('Отправитель отменил передачу'), false);
            return;
        }
        case 'file-chunk': {
            const inc = incoming.get(msg.fileId);
            if (!inc || msg.from !== inc.from) return;
            if (msg.seq !== inc.nextSeq || typeof msg.data !== 'string') { fail(msg.fileId, N('Ошибка передачи'), true); return; }
            let bytes: Uint8Array<ArrayBuffer>;
            try { bytes = decode(msg.data); } catch { fail(msg.fileId, N('Ошибка передачи'), true); return; }
            if (inc.received + bytes.length > inc.size) { fail(msg.fileId, N('Размер файла не совпал'), true); return; }
            inc.parts.push(new Blob([bytes]));
            inc.received += bytes.length;
            inc.nextSeq++;
            if (msg.last) {
                window.clearTimeout(inc.timer);
                incoming.delete(msg.fileId);
                if (inc.received !== inc.size) { emit({ fileId: msg.fileId, status: 'error', percent: 0, text: t('Файл пришёл не полностью') }); return; }
                saveBlob(new Blob(inc.parts), inc.name);
                emit({ fileId: msg.fileId, status: 'done', percent: 100, text: t('Скачано') });
                return;
            }
            send({ type: 'file-ack', to: inc.from, fileId: msg.fileId, seq: msg.seq });
            armStall(inc);
            emit({ fileId: msg.fileId, status: 'loading', percent: Math.floor(inc.received / inc.size * 100), text: t('Скачивается… {percent}%', { percent: Math.floor(inc.received / inc.size * 100) }) });
            return;
        }
        default:
            return;
    }
}

/** Участники комнаты изменились: отменяем загрузки у тех, кто ушёл */
export function syncParticipants(ids: ClientId[]): void {
    for (const inc of Array.from(incoming.values())) {
        if (!ids.includes(inc.from)) fail(inc.fileId, N('Отправитель вышел из комнаты'), false);
    }
    for (const [k, o] of Array.from(outgoing)) {
        if (!ids.includes(o.to)) { o.dead = true; outgoing.delete(k); }
    }
}

/** Мы вышли из комнаты — забываем всё */
export function resetFiles(): void {
    for (const inc of incoming.values()) window.clearTimeout(inc.timer);
    incoming.clear();
    for (const o of outgoing.values()) o.dead = true;
    outgoing.clear();
    offered.clear();
    pendingOffers.length = 0;
}
