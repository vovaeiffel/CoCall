// src/preload.ts
// ============================================================
// Мост между окном (UI) и главным процессом (Node.js).
// Отдаёт в window.api только разрешённые функции.
// ============================================================
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
    getLocalIp: (): Promise<string> => ipcRenderer.invoke('get-local-ip'),
    announceRoom: (info: { id: string; name: string; host: string; port: number; hasPassword: boolean; members: number } | null): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('announce-room', info),
    getNearbyRooms: (): Promise<Array<{ id: string; name: string; host: string; port: number; hasPassword: boolean; members: number; address: string }>> =>
        ipcRenderer.invoke('get-nearby-rooms'),
    lobbyName: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('lobby-name', name),
    lobbySend: (text: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('lobby-send', text),
    lobbyPoll: (since: number): Promise<{ messages: Array<{ seq: number; id: string; name: string; text: string; ts: number; own: boolean }>; peers: Array<{ id: string; name: string }>; seq: number }> =>
        ipcRenderer.invoke('lobby-poll', since),
    getVpnIps: (): Promise<Array<{ label: string; ip: string }>> => ipcRenderer.invoke('get-vpn-ips'),
    getPublicIp: (): Promise<string | null> => ipcRenderer.invoke('get-public-ip'),
    startServer: (port: number): Promise<{ ok: boolean; message: string }> =>
        ipcRenderer.invoke('start-server', port),
    stopServer: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('stop-server'),
    setLanguage: (code: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('set-language', code),
    setTrayOnClose: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('set-tray-on-close', on),
    setHotkey: (accelerator: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('set-hotkey', accelerator),
    listScreenSources: (): Promise<Array<{ id: string; name: string; isScreen: boolean; thumb: string }>> =>
        ipcRenderer.invoke('list-screen-sources'),
    selectScreenSource: (id: string, audio: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('select-screen-source', id, audio),
    getVersion: (): Promise<string> => ipcRenderer.invoke('get-version'),
    checkUpdate: (): Promise<{ available: boolean; version?: string; url?: string; canAuto?: boolean }> => ipcRenderer.invoke('check-update'),
    downloadUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('download-update'),
    installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('install-update'),
    onUpdateEvent: (callback: (e: { type: 'progress'; percent: number } | { type: 'downloaded'; version: string } | { type: 'error'; message: string }) => void): void => {
        ipcRenderer.on('update-event', (_evt, payload) => callback(payload));
    },
    openReleases: (): Promise<void> => ipcRenderer.invoke('open-releases'),
    listSoundPacks: (): Promise<unknown> => ipcRenderer.invoke('list-sound-packs'),
    importSound: (kind: string): Promise<unknown> => ipcRenderer.invoke('import-sound', kind),
    removeCustomSound: (kind: string): Promise<unknown> => ipcRenderer.invoke('remove-custom-sound', kind),
    openSoundPacksFolder: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('open-sound-packs-folder'),
    onToggleMic: (callback: () => void): void => {
        ipcRenderer.on('toggle-mic', () => callback());
    },
});
