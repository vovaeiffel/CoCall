// src/main.ts
// ============================================================
// Главный процесс Electron.
// Его задачи:
//  1. Открыть окно приложения
//  2. Показать окну ваш адрес (в домашней сети и в интернете)
//  3. Запустить/остановить WebSocket-сервер по команде из окна
// ============================================================
import { app, BrowserWindow, screen, ipcMain, globalShortcut, shell, desktopCapturer, session, Menu, Tray, nativeImage, dialog } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { SignalingServer } from './signaling.js';
import { APP_NAME, GITHUB_REPO } from './config.js';
import { autoUpdater } from 'electron-updater';
import { Discovery } from './discovery.js';
import { LANGUAGES } from './lang/index.js';

const discovery = new Discovery();

// ============================================================
// Один экземпляр. В установленном приложении второй запуск не нужен:
// окно, которое уже открыто, просто выходит на передний план.
// А при запуске через npm start (из VS Code) можно открыть ещё одно приложение
// рядом с установленным — для проверки новых функций; у него отдельные настройки.
// ============================================================
let isSecondInstance = false;
if (app.isPackaged) {
    if (!app.requestSingleInstanceLock()) {
        isSecondInstance = true;
        app.quit();
    }
} else {
    app.setPath('userData', path.join(app.getPath('appData'), `${APP_NAME}-dev`));
}

let mainWindow: BrowserWindow | null = null;
let signalingServer: SignalingServer | null = null;

/**
 * Возвращает «лучший» локальный IPv4-адрес машины (например, 192.168.1.42).
 * Виртуальные адаптеры (VirtualBox, VMware, WSL, Hyper-V, Docker) и
 * служебные адреса 169.254.x.x отодвигаются в конец списка.
 */
function getLocalIp(): string {
    const ifaces = os.networkInterfaces();
    const candidates: Array<{ ip: string; score: number }> = [];

    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
            const isV4 = iface.family === 'IPv4' || (iface.family as unknown) === 4;
            if (!isV4 || iface.internal) continue;

            let score = 0;
            if (/^192\.168\./.test(iface.address)) score += 3;
            else if (/^10\./.test(iface.address)) score += 2;
            else if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) score += 1;
            if (/^169\.254\./.test(iface.address)) score -= 10;
            if (/virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|vpn|tap|tun/i.test(name)) score -= 5;

            candidates.push({ ip: iface.address, score });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length > 0 ? candidates[0].ip : '127.0.0.1';
}

/**
 * Адреса «виртуальных локальных сетей» (Radmin VPN, Hamachi, ZeroTier, Tailscale).
 * Друзья подключаются именно по такому адресу, когда играете через Radmin.
 */
function getVpnIps(): Array<{ label: string; ip: string }> {
    const ifaces = os.networkInterfaces();
    const found: Array<{ label: string; ip: string; rank: number }> = [];
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
            const isV4 = iface.family === 'IPv4' || (iface.family as unknown) === 4;
            if (!isV4 || iface.internal) continue;
            const a = iface.address;
            if (/radmin/i.test(name) || /^26\./.test(a)) found.push({ label: 'Radmin VPN', ip: a, rank: 0 });
            else if (/hamachi/i.test(name) || /^25\./.test(a)) found.push({ label: 'Hamachi', ip: a, rank: 1 });
            else if (/zerotier/i.test(name)) found.push({ label: 'ZeroTier', ip: a, rank: 2 });
            else if (/tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) found.push({ label: 'Tailscale', ip: a, rank: 3 });
        }
    }
    found.sort((x, y) => x.rank - y.rank);
    return found.map(({ label, ip }) => ({ label, ip }));
}

/** Узнаёт внешний (публичный) IP через сайт api.ipify.org. Если не вышло — null. */
async function getPublicIp(): Promise<string | null> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch('https://api.ipify.org', { signal: ctrl.signal });
        clearTimeout(timer);
        const text = (await res.text()).trim();
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? text : null;
    } catch {
        return null;
    }
}

function createWindow() {
    // Окно сразу такого размера, чтобы главный экран с чатом сети был виден целиком (без растягивания и прокрутки).
    // На маленьком экране не больше доступной области.
    const area = screen.getPrimaryDisplay().workAreaSize;
    mainWindow = new BrowserWindow({
        width: Math.min(1280, area.width),
        height: Math.min(800, area.height),
        minWidth: Math.min(1080, area.width),
        minHeight: Math.min(640, area.height),
        center: true,
        title: APP_NAME,
        icon: path.join(__dirname, '../build/icon.png'),
        webPreferences: {
            // preload.js — единственный безопасный мост между окном и Node
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false, // preload использует require('electron')
            backgroundThrottling: false, // свёрнутое окно не должно «засыпать»: иначе голос и звуки могут подвисать
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../index.html'));
    if (!app.isPackaged) mainWindow.webContents.openDevTools(); // консоль разработчика — только при запуске из VS Code
    mainWindow.on('closed', () => { mainWindow = null; });
    // Крестик: вместо выхода прячем окно в трей (если это не отключено в настройках)
    mainWindow.on('close', (e) => {
        if (app.isPackaged && !isQuitting && trayOnClose && tray) {
            e.preventDefault();
            mainWindow?.hide();
        }
    });
}

// ============================================================
// Значок в трее: приложение (и открытая комната) продолжает работать, когда окно закрыто крестиком
// ============================================================
let tray: Tray | null = null;
let trayOnClose = true;
let isQuitting = false;

function showMainWindow(): void {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

/** Язык меню трея (выбирается в окне приложения и присылается сюда) */
let uiLang = 'ru';
function tr(text: string): string {
    return LANGUAGES.find((l) => l.code === uiLang)?.strings[text] ?? text;
}

function buildTrayMenu(): void {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: tr('Открыть {app}').replace('{app}', APP_NAME), click: () => showMainWindow() },
        { label: tr('Микрофон: включить / выключить'), click: () => mainWindow?.webContents.send('toggle-mic') },
        { type: 'separator' },
        { label: tr('Выйти полностью'), click: () => { isQuitting = true; app.quit(); } },
    ]));
}

function setupTray(): void {
    try {
        const img = nativeImage.createFromPath(path.join(__dirname, '../build/icon.png'));
        if (img.isEmpty()) return;
        tray = new Tray(img.resize({ width: 16, height: 16 }));
        tray.setToolTip(APP_NAME);
        buildTrayMenu();
        tray.on('click', () => {
            if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
            else showMainWindow();
        });
    } catch {
        tray = null; // без трея просто работаем как раньше (крестик закрывает приложение)
    }
}

ipcMain.handle('set-language', (_evt, code: string) => {
    if (typeof code === 'string' && LANGUAGES.some((l) => l.code === code)) {
        uiLang = code;
        buildTrayMenu();
    }
    return { ok: true };
});

ipcMain.handle('set-tray-on-close', (_evt, on: boolean) => {
    trayOnClose = on === true;
    return { ok: true };
});

// ============================================================
// IPC: окно может попросить:
//  - узнать мой IP (для показа друзьям)
//  - запустить сервер на порту
//  - остановить сервер
// ============================================================
/** Сравнивает версии вида 1.2.3: true, если a новее b */
function isNewer(a: string, b: string): boolean {
    const pa = a.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0;
    }
    return false;
}

/** Результат проверки обновления. canAuto — можно обновиться прямо из приложения */
type UpdateInfo = { available: boolean; version?: string; url?: string; canAuto?: boolean };

/** Запасной способ (запуск из VS Code): смотрит на GitHub, вышла ли новая версия. */
async function checkForUpdateViaGithub(): Promise<UpdateInfo> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO)) return { available: false };
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            signal: ctrl.signal,
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': APP_NAME },
        });
        clearTimeout(timer);
        if (!res.ok) return { available: false };
        const data = (await res.json()) as { tag_name?: string; html_url?: string };
        const tag = String(data.tag_name || '');
        if (!/^v?\d+(\.\d+){0,3}$/i.test(tag)) return { available: false };
        if (!isNewer(tag, app.getVersion())) return { available: false };
        return { available: true, version: tag.replace(/^v/i, ''), url: `https://github.com/${GITHUB_REPO}/releases/latest`, canAuto: false };
    } catch {
        return { available: false };
    }
}

// ============================================================
// Автообновление (только в установленном приложении).
// Программа сама скачивает новый установщик с GitHub (файлы релиза:
// CoCall-Setup-x.y.z.exe, .blockmap и latest.yml), показывает ход загрузки
// и по кнопке «Перезапустить и установить» ставит новую версию.
// ============================================================
let updaterReady = false;
function sendUpdateEvent(payload: { type: 'progress'; percent: number } | { type: 'downloaded'; version: string } | { type: 'error'; message: string }): void {
    mainWindow?.webContents.send('update-event', payload);
}

function setupUpdater(): void {
    if (!app.isPackaged || updaterReady) return;
    updaterReady = true;
    autoUpdater.autoDownload = false;          // качаем только после нажатия кнопки
    autoUpdater.autoInstallOnAppQuit = true;   // скачано, но не нажали — поставится при следующем выходе
    autoUpdater.on('download-progress', (p: { percent: number }) => {
        sendUpdateEvent({ type: 'progress', percent: Math.max(0, Math.min(100, Math.round(p.percent))) });
    });
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
        sendUpdateEvent({ type: 'downloaded', version: String(info.version) });
    });
    autoUpdater.on('error', (err: Error) => {
        sendUpdateEvent({ type: 'error', message: String(err && err.message ? err.message : err).slice(0, 300) });
    });
}

/** Проверка обновления: в установленном приложении — через electron-updater, иначе — через GitHub */
async function checkForUpdate(): Promise<UpdateInfo> {
    if (!app.isPackaged) return checkForUpdateViaGithub();
    try {
        setupUpdater();
        const res = await autoUpdater.checkForUpdates();
        const v = res && res.updateInfo ? String(res.updateInfo.version || '') : '';
        if (!v || !/^\d+(\.\d+){0,3}$/.test(v) || !isNewer(v, app.getVersion())) return { available: false };
        return { available: true, version: v, url: `https://github.com/${GITHUB_REPO}/releases/latest`, canAuto: true };
    } catch {
        // В релизе нет файла latest.yml или нет сети — пробуем хотя бы показать плашку со ссылкой
        return checkForUpdateViaGithub();
    }
}

// ============================================================
// Трансляция экрана: список окон/экранов и выбор источника.
// Окно само показывает красивый выбор, а сюда присылает номер выбранного.
// ============================================================
let pendingScreen: { id: string; audio: boolean } | null = null;

ipcMain.handle('list-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
    });
    return sources
        .filter((s) => !s.thumbnail.isEmpty())
        .map((s) => ({
            id: s.id,
            name: s.name,
            isScreen: s.id.startsWith('screen:'),
            thumb: s.thumbnail.toDataURL(),
        }));
});

ipcMain.handle('select-screen-source', (_evt: unknown, id: string, audio: boolean) => {
    pendingScreen = typeof id === 'string' && id ? { id, audio: audio === true } : null;
    return { ok: pendingScreen !== null };
});

function setupScreenCapture(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
        (_request, callback) => {
            // callback приводим к простому типу: так не зависим от версии типов Electron
            const cb = callback as unknown as (streams: Record<string, unknown>) => void;
            const sel = pendingScreen;
            pendingScreen = null;
            if (!sel) { cb({}); return; }
            desktopCapturer
                .getSources({ types: ['screen', 'window'] })
                .then((sources) => {
                    const src = sources.find((s) => s.id === sel.id);
                    if (!src) { cb({}); return; }
                    if (sel.audio) cb({ video: src, audio: 'loopback' });
                    else cb({ video: src });
                })
                .catch(() => cb({}));
        }
    );
}

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('check-update', () => checkForUpdate());
ipcMain.handle('download-update', async () => {
    if (!app.isPackaged) return { ok: false };
    try {
        setupUpdater();
        await autoUpdater.downloadUpdate();
        return { ok: true };
    } catch (e) {
        sendUpdateEvent({ type: 'error', message: String(e instanceof Error ? e.message : e).slice(0, 300) });
        return { ok: false };
    }
});
ipcMain.handle('install-update', () => {
    if (!app.isPackaged) return { ok: false };
    isQuitting = true;                          // закрываем по-настоящему, а не в трей
    if (signalingServer) void signalingServer.stop();
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
});
// Открыть только страницу загрузок нашего репозитория (больше ничего)
ipcMain.handle('open-releases', async () => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO)) return;
    await shell.openExternal(`https://github.com/${GITHUB_REPO}/releases/latest`);
});

ipcMain.handle('get-local-ip', () => getLocalIp());
// Автопоиск комнат в сети
ipcMain.handle('announce-room', (_evt: unknown, info: unknown) => {
    const o = info as { id?: unknown; name?: unknown; host?: unknown; port?: unknown; hasPassword?: unknown; members?: unknown } | null;
    if (!o || typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.host !== 'string' ||
        typeof o.port !== 'number' || typeof o.hasPassword !== 'boolean' || typeof o.members !== 'number') {
        discovery.announce(null);
        return { ok: true };
    }
    discovery.announce({
        id: o.id.slice(0, 64),
        name: o.name.slice(0, 64),
        host: o.host.slice(0, 32),
        port: Math.floor(o.port),
        hasPassword: o.hasPassword,
        members: Math.max(0, Math.min(99, Math.floor(o.members))),
    });
    return { ok: true };
});
ipcMain.handle('get-nearby-rooms', () => discovery.nearby());
// Чат сети (главный экран)
ipcMain.handle('lobby-name', (_evt: unknown, name: unknown) => { discovery.setLobbyName(name); return { ok: true }; });
ipcMain.handle('lobby-send', (_evt: unknown, text: unknown) => discovery.sendLobby(text));
ipcMain.handle('lobby-poll', (_evt: unknown, since: unknown) => discovery.lobby(typeof since === 'number' ? since : 0));
ipcMain.handle('get-vpn-ips', () => getVpnIps());
ipcMain.handle('get-public-ip', () => getPublicIp());

// ============================================================
// Звуки: наборы и свои файлы
//  - наборы, которые идут вместе с программой: папки внутри sounds/ (join.mp3, leave.mp3 …)
//  - наборы пользователя: папка «sound-packs» в данных программы (кнопка «Открыть папку» в настройках)
//  - свои звуки для отдельных событий: папка «custom-sounds» в данных программы
// ============================================================
const SOUND_KINDS = ['join', 'leave', 'stream-start', 'stream-stop', 'message', 'mic-on', 'mic-off'];
const SOUND_EXTS = ['.mp3', '.wav', '.ogg'];
const MAX_SOUND_BYTES = 3 * 1024 * 1024;

function builtinSoundsDir(): string { return path.join(__dirname, '..', 'sounds'); }
function userPacksDir(): string { return path.join(app.getPath('userData'), 'sound-packs'); }
function customSoundsDir(): string { return path.join(app.getPath('userData'), 'custom-sounds'); }

interface SoundPackInfo { id: string; name: string; base: string; files: Record<string, string>; builtin: boolean }

/** Папки-наборы внутри dir: в каждой должен быть хотя бы один файл с именем события */
function scanPacks(dir: string, builtin: boolean): SoundPackInfo[] {
    const result: SoundPackInfo[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folder = path.join(dir, entry.name);
        let names: string[] = [];
        try { names = fs.readdirSync(folder); } catch { continue; }
        const files: Record<string, string> = {};
        for (const kind of SOUND_KINDS) {
            const f = names.find((n) => SOUND_EXTS.includes(path.extname(n).toLowerCase()) && path.basename(n, path.extname(n)).toLowerCase() === kind);
            if (f) files[kind] = f;
        }
        if (Object.keys(files).length === 0) continue;
        let name = entry.name;
        try {
            const first = fs.readFileSync(path.join(folder, 'pack.txt'), 'utf8').split(/\r?\n/)[0].trim();
            if (first) name = first.slice(0, 40);
        } catch { /* названия нет — берём имя папки */ }
        result.push({
            id: (builtin ? 'b:' : 'u:') + entry.name,
            name,
            base: builtin ? 'sounds/' + encodeURIComponent(entry.name) + '/' : pathToFileURL(folder).href + '/',
            files,
            builtin,
        });
    }
    return result;
}

function readCustomSounds(): Record<string, { name: string; url: string }> {
    const result: Record<string, { name: string; url: string }> = {};
    let names: Record<string, string> = {};
    try { names = JSON.parse(fs.readFileSync(path.join(customSoundsDir(), 'names.json'), 'utf8')); } catch { /* имён нет */ }
    let files: string[] = [];
    try { files = fs.readdirSync(customSoundsDir()); } catch { return result; }
    for (const kind of SOUND_KINDS) {
        const f = files.find((n) => SOUND_EXTS.includes(path.extname(n).toLowerCase()) && path.basename(n, path.extname(n)) === kind);
        if (f) result[kind] = { name: typeof names[kind] === 'string' ? names[kind] : f, url: pathToFileURL(path.join(customSoundsDir(), f)).href };
    }
    return result;
}

function soundState() {
    return { packs: [...scanPacks(builtinSoundsDir(), true), ...scanPacks(userPacksDir(), false)], custom: readCustomSounds() };
}

function removeCustomFiles(kind: string): void {
    try {
        for (const n of fs.readdirSync(customSoundsDir())) {
            if (path.basename(n, path.extname(n)) === kind) fs.unlinkSync(path.join(customSoundsDir(), n));
        }
    } catch { /* папки ещё нет */ }
}

ipcMain.handle('list-sound-packs', () => soundState());

ipcMain.handle('import-sound', async (_evt: unknown, kind: string) => {
    if (typeof kind !== 'string' || !SOUND_KINDS.includes(kind)) return { ok: false, error: 'bad-kind', ...soundState() };
    const filters = [{ name: 'Audio (mp3, wav, ogg)', extensions: ['mp3', 'wav', 'ogg'] }];
    const res = mainWindow
        ? await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters })
        : await dialog.showOpenDialog({ properties: ['openFile'], filters });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'cancel', ...soundState() };
    const src = res.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!SOUND_EXTS.includes(ext)) return { ok: false, error: 'bad-type', ...soundState() };
    try {
        if (fs.statSync(src).size > MAX_SOUND_BYTES) return { ok: false, error: 'too-big', ...soundState() };
        fs.mkdirSync(customSoundsDir(), { recursive: true });
        removeCustomFiles(kind);
        fs.copyFileSync(src, path.join(customSoundsDir(), kind + ext));
        let names: Record<string, string> = {};
        try { names = JSON.parse(fs.readFileSync(path.join(customSoundsDir(), 'names.json'), 'utf8')); } catch { /* ignore */ }
        names[kind] = path.basename(src).slice(0, 80);
        fs.writeFileSync(path.join(customSoundsDir(), 'names.json'), JSON.stringify(names));
    } catch {
        return { ok: false, error: 'copy', ...soundState() };
    }
    return { ok: true, ...soundState() };
});

ipcMain.handle('remove-custom-sound', (_evt: unknown, kind: string) => {
    if (typeof kind === 'string' && SOUND_KINDS.includes(kind)) removeCustomFiles(kind);
    return { ok: true, ...soundState() };
});

ipcMain.handle('open-sound-packs-folder', async () => {
    try {
        fs.mkdirSync(userPacksDir(), { recursive: true });
        await shell.openPath(userPacksDir());
    } catch { /* ignore */ }
    return { ok: true };
});

// Глобальная горячая клавиша «микрофон вкл/выкл» (работает, даже когда окно свёрнуто)
let currentHotkey = '';
ipcMain.handle('set-hotkey', (_evt, accelerator: string) => {
    if (currentHotkey) {
        try { globalShortcut.unregister(currentHotkey); } catch { /* ignore */ }
        currentHotkey = '';
    }
    if (!accelerator) return { ok: true };
    try {
        const ok = globalShortcut.register(accelerator, () => {
            mainWindow?.webContents.send('toggle-mic');
        });
        if (ok) currentHotkey = accelerator;
        return { ok };
    } catch {
        return { ok: false };
    }
});

ipcMain.handle('start-server', async (_evt, port: number) => {
    if (signalingServer) {
        return { ok: true, message: 'Сервер уже запущен' };
    }
    try {
        const server = new SignalingServer(port);
        await server.start(); // асинхронный запуск
        signalingServer = server;
        return { ok: true, message: `Сервер запущен на порту ${port}` };
    } catch (err: any) {
        signalingServer = null;
        return { ok: false, message: err?.message ?? String(err) };
    }
});

ipcMain.handle('stop-server', async () => {
    if (signalingServer) {
        const server = signalingServer;
        signalingServer = null;
        await server.stop();
    }
    return { ok: true };
});

app.on('second-instance', () => {
    showMainWindow();
});

app.whenReady().then(() => {
    if (isSecondInstance) return;
    if (app.isPackaged) Menu.setApplicationMenu(null); // у готового приложения без лишнего меню сверху
    setupScreenCapture();
    void discovery.start();
    setupTray();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    discovery.stop();
    globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
    isQuitting = true;
    if (signalingServer) void signalingServer.stop();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
