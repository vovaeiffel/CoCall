// src/global.d.ts
// ============================================================
// Объявляем глобальные типы для window.api (используется в окне).
// Этот файл НЕ модуль (нет import/export) — так декларации глобальные.
// ============================================================

interface Window {
    api: {
        getLocalIp: () => Promise<string>;
        announceRoom?: (info: { id: string; name: string; host: string; port: number; hasPassword: boolean; members: number } | null) => Promise<{ ok: boolean }>;
        getNearbyRooms?: () => Promise<Array<{ id: string; name: string; host: string; port: number; hasPassword: boolean; members: number; address: string }>>;
        lobbyName?: (name: string) => Promise<{ ok: boolean }>;
        lobbySend?: (text: string) => Promise<{ ok: boolean; error?: string }>;
        lobbyPoll?: (since: number) => Promise<{ messages: Array<{ seq: number; id: string; name: string; text: string; ts: number; own: boolean }>; peers: Array<{ id: string; name: string }>; seq: number }>;
        getVpnIps?: () => Promise<Array<{ label: string; ip: string }>>;
        getPublicIp: () => Promise<string | null>;
        startServer: (port: number) => Promise<{ ok: boolean; message: string }>;
        stopServer: () => Promise<{ ok: boolean }>;
        setLanguage?: (code: string) => Promise<{ ok: boolean }>;
        setTrayOnClose?: (on: boolean) => Promise<{ ok: boolean }>;
        setHotkey: (accelerator: string) => Promise<{ ok: boolean }>;
        listScreenSources: () => Promise<Array<{ id: string; name: string; isScreen: boolean; thumb: string }>>;
        selectScreenSource: (id: string, audio: boolean) => Promise<{ ok: boolean }>;
        getVersion: () => Promise<string>;
        checkUpdate: () => Promise<{ available: boolean; version?: string; url?: string; canAuto?: boolean }>;
        downloadUpdate?: () => Promise<{ ok: boolean }>;
        installUpdate?: () => Promise<{ ok: boolean }>;
        onUpdateEvent?: (callback: (e: { type: 'progress'; percent: number } | { type: 'downloaded'; version: string } | { type: 'error'; message: string }) => void) => void;
        openReleases: () => Promise<void>;
        listSoundPacks?: () => Promise<{ packs: Array<{ id: string; name: string; base: string; files: Record<string, string>; builtin: boolean }>; custom: Record<string, { name: string; url: string }> }>;
        importSound?: (kind: string) => Promise<{ ok: boolean; error?: string; packs: Array<{ id: string; name: string; base: string; files: Record<string, string>; builtin: boolean }>; custom: Record<string, { name: string; url: string }> }>;
        removeCustomSound?: (kind: string) => Promise<{ ok: boolean; packs: Array<{ id: string; name: string; base: string; files: Record<string, string>; builtin: boolean }>; custom: Record<string, { name: string; url: string }> }>;
        openSoundPacksFolder?: () => Promise<{ ok: boolean }>;
        onToggleMic: (callback: () => void) => void;
    };
}
