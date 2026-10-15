// src/rooms.ts
// ============================================================
// Комнаты, в которых вы уже бывали: список запоминается и показывается
// на главном экране. Раз в несколько секунд программа «стучится» по
// сохранённым адресам и узнаёт, открыта ли комната и сколько в ней людей.
// Пароли не запоминаются.
// ============================================================
import type { SignalingMessage } from './protocol';

const KEY = 'pd_known_rooms';
const MAX_KNOWN = 12;

export interface KnownRoom {
    address: string;
    name: string;
    host: string;
    hasPassword: boolean;
    lastJoined: number;
}

export type RoomStatus = 'unknown' | 'online' | 'closed' | 'offline';

export interface RoomLive {
    status: RoomStatus;
    members: number;
    hostPresent: boolean;
}

const live = new Map<string, RoomLive>();

function isKnown(v: unknown): v is KnownRoom {
    const r = v as KnownRoom;
    return !!r && typeof r.address === 'string' && typeof r.name === 'string' && typeof r.host === 'string';
}

export function getKnownRooms(): KnownRoom[] {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(isKnown)
            .map((r) => ({ address: r.address, name: r.name, host: r.host, hasPassword: !!r.hasPassword, lastJoined: Number(r.lastJoined) || 0 }))
            .sort((a, b) => b.lastJoined - a.lastJoined)
            .slice(0, MAX_KNOWN);
    } catch {
        return [];
    }
}

function save(list: KnownRoom[]): void {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_KNOWN))); } catch { /* ignore */ }
}

/** Запомнить комнату (или обновить запись о ней) */
export function rememberRoom(room: Omit<KnownRoom, 'lastJoined'>): void {
    const old = getKnownRooms();
    const rest = old.filter((r) => r.address !== room.address);
    const prev = old.find((r) => r.address === room.address);
    // если хоста сейчас нет в комнате, имя хоста берём из прошлой записи
    save([{ ...room, host: room.host || prev?.host || '', lastJoined: Date.now() }, ...rest]);
}

export function forgetRoom(address: string): void {
    save(getKnownRooms().filter((r) => r.address !== address));
    live.delete(address);
}

export function getRoomLive(address: string): RoomLive {
    return live.get(address) ?? { status: 'unknown', members: 0, hostPresent: false };
}

/** Спросить у адреса, есть ли там комната (подключаемся, регистрируемся, получаем список и отключаемся) */
type ProbeResult = { name: string; host: string; hasPassword: boolean; members: number; hostPresent: boolean } | 'closed' | null;

function probe(address: string, username: string, timeoutMs = 3500): Promise<ProbeResult> {
    return new Promise((resolve) => {
        let done = false;
        let ws: WebSocket;
        const finish = (v: ProbeResult): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* ignore */ }
            resolve(v);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
            ws = new WebSocket(`ws://${address}`);
        } catch {
            clearTimeout(timer);
            resolve(null);
            return;
        }
        ws.addEventListener('open', () => {
            const msg: SignalingMessage = { type: 'register', clientId: crypto.randomUUID(), username: username || 'проверка' };
            ws.send(JSON.stringify(msg));
        });
        ws.addEventListener('message', (e) => {
            try {
                const m = JSON.parse(e.data) as SignalingMessage;
                if (m.type !== 'room-list') return;
                const r = m.rooms[0];
                if (!r) { finish('closed'); return; }
                finish({
                    name: r.name,
                    host: r.host,
                    hasPassword: r.hasPassword,
                    members: r.memberCount ?? r.guestCount + 1,
                    hostPresent: r.hostPresent !== false,
                });
            } catch { /* ignore */ }
        });
        ws.addEventListener('error', () => finish(null));
        ws.addEventListener('close', () => finish(null));
    });
}

/** Проверить все сохранённые комнаты. Возвращает true, если что-то изменилось. */
export async function refreshKnownRooms(username: string, skipAddress?: string | null): Promise<boolean> {
    const rooms = getKnownRooms().filter((r) => r.address !== skipAddress);
    let changed = false;
    const results = await Promise.all(rooms.map(async (r) => ({ r, res: await probe(r.address, username) })));
    const list = getKnownRooms();
    for (const { r, res } of results) {
        const prev = live.get(r.address);
        let next: RoomLive;
        if (res === null) next = { status: 'offline', members: 0, hostPresent: false };
        else if (res === 'closed') next = { status: 'closed', members: 0, hostPresent: false };
        else {
            next = { status: 'online', members: res.members, hostPresent: res.hostPresent };
            // комната могла получить новое название / пароль — обновляем запись
            const rec = list.find((x) => x.address === r.address);
            if (rec && (rec.name !== res.name || rec.host !== res.host || rec.hasPassword !== res.hasPassword)) {
                rec.name = res.name;
                rec.host = res.host;
                rec.hasPassword = res.hasPassword;
                changed = true;
            }
        }
        if (!prev || prev.status !== next.status || prev.members !== next.members || prev.hostPresent !== next.hostPresent) changed = true;
        live.set(r.address, next);
    }
    if (changed) save(list);
    return changed;
}
