// src/ui.ts
// ============================================================
// Интерфейс: обработчики кнопок, показ списка комнат,
// показ своего адреса, показ участников, подсветка говорящего,
// контекстное меню, выбор устройств.
// ============================================================
import { state, SIGNALING_PORT, sliderFromLevel } from './state';
import type { NoiseMode } from './state';
import type { ChatMessage, ClientId, SignalingMessage } from './protocol';
import { icon, avatarColor, nameColor } from './icons';
import { EMOJI_CATEGORIES } from './emoji';
import { getKnownRooms, getRoomLive, forgetRoom } from './rooms';
import { isSafeImage, prepareChatImage } from './chatimage';
import { showError, setupErrorDialog } from './errordialog';
import * as E from './errors';
import { isSafeAvatar, getMyAvatar, saveMyAvatar, prepareAvatar } from './avatar';
import { signalHtml } from './quality';
import { fileExtension, DANGEROUS_EXTENSIONS, MAX_FILE_MB } from './filesettings';
import { formatSize } from './format';
import { t, getLocale, getLanguage, getLanguages, setLanguage } from './i18n';
import { SCREEN_QUALITIES, isScreenQuality } from './screenquality';
import { CAMERA_QUALITIES, type CameraQuality } from './cameraquality';
import { setupSoundSettings } from './soundsettings';
import type { ScreenQuality } from './protocol';
import {
    toggleMic,
    setLocalInputVolume,
    setMasterOutputVolume,
    setPeerVolume,
    setPeerMuted,
    changeInputDevice,
    changeOutputDevice,
    setNoiseMode,
    setMicThreshold,
} from './audio';

// ============================================================
// Вспомогательное: подпись + строка адреса с кнопкой «Копировать»
// ============================================================
function bindCopy(btn: HTMLButtonElement, getText: () => string): void {
    btn.addEventListener('click', () => {
        const text = getText();
        if (!text || text.includes('—') || text.includes('…')) return;
        void navigator.clipboard.writeText(text);
        btn.textContent = t('✓ Скопировано');
        setTimeout(() => { btn.textContent = t('Копировать'); }, 1500);
    });
}

function makeCaption(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.textContent = text;
    el.className = 'caption';
    return el;
}

// ============================================================
// Выбор устройств (микрофон / динамики) — поля добавляются в «Настройки голоса»
// ============================================================
function setupDeviceSelectors(settingsModal: HTMLElement): () => Promise<void> {
    const audioPane = settingsModal.querySelector('#settings-pane-audio') as HTMLElement;
    const videoPane = settingsModal.querySelector('#settings-pane-video') as HTMLElement;
    const firstItem = audioPane.querySelector('.setting-item');

    const makeSelect = (labelText: string, pane: HTMLElement = audioPane): HTMLSelectElement => {
        const wrap = document.createElement('div');
        wrap.className = 'setting-item';
        const label = document.createElement('label');
        label.textContent = labelText;
        const sel = document.createElement('select');
        sel.style.cssText = 'width:100%; padding:9px 10px; background:var(--bg); color:var(--text); ' +
            'border:1px solid var(--line); border-radius:10px; font:inherit; outline:none;';
        wrap.append(label, sel);
        if (pane === audioPane) pane.insertBefore(wrap, firstItem);
        else pane.append(wrap);
        return sel;
    };

    // Порядок на экране: микрофон, динамики, камера, качество камеры (поля вставляются перед первым пунктом)
    const camHead = document.createElement('div');
    camHead.className = 'settings-sub';
    camHead.textContent = t('Веб-камера');
    videoPane.append(camHead);
    const camSel = makeSelect(t('Камера'), videoPane);
    const camQSel = makeSelect(t('Качество камеры'), videoPane);
    setupStreamSettings(videoPane);
    const inSel = makeSelect(t('Микрофон'));
    const outSel = makeSelect(t('Динамики / наушники'));

    const fill = (sel: HTMLSelectElement, devices: MediaDeviceInfo[], current: string, fallbackName: string) => {
        sel.innerHTML = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = t('По умолчанию');
        sel.append(def);
        devices
            .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
            .forEach((d, i) => {
                const o = document.createElement('option');
                o.value = d.deviceId;
                o.textContent = d.label || `${fallbackName} ${i + 1}`;
                sel.append(o);
            });
        sel.value = Array.from(sel.options).some((o) => o.value === current) ? current : '';
    };

    const refresh = async (): Promise<void> => {
        try {
            const list = await navigator.mediaDevices.enumerateDevices();
            fill(inSel, list.filter((d) => d.kind === 'audioinput'), state.inputDeviceId, t('Микрофон'));
            fill(outSel, list.filter((d) => d.kind === 'audiooutput'), state.outputDeviceId, t('Устройство'));
            fill(camSel, list.filter((d) => d.kind === 'videoinput'), state.cameraDeviceId, t('Камера'));
        } catch (err) {
            console.warn('Не удалось получить список устройств:', err);
        }
    };

    // Шумоподавление: вместо старой галочки — выбор из трёх режимов
    const oldNs = document.getElementById('noise-suppression');
    const oldItem = oldNs?.closest('.setting-item') as HTMLElement | null;
    const nsSel = makeSelect(t('Шумоподавление'));
    const modes: Array<[NoiseMode, string]> = [
        ['rnnoise', t('RNNoise (нейросеть, лучшее)')],
        ['standard', t('Обычное (встроенное в браузер)')],
        ['off', t('Выключено')],
    ];
    for (const [value, text] of modes) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        nsSel.append(o);
    }
    nsSel.value = state.noiseMode;
    nsSel.addEventListener('change', () => { void setNoiseMode(nsSel.value as NoiseMode); });
    if (oldItem) oldItem.style.display = 'none';

    for (const q of Object.keys(CAMERA_QUALITIES) as CameraQuality[]) {
        const o = document.createElement('option');
        o.value = q;
        o.textContent = q + 'p' + (q === '360' ? t(' (экономно)') : q === '720' ? t(' (чётко, больше интернета)') : '');
        camQSel.append(o);
    }
    camQSel.value = state.cameraQuality;
    camSel.addEventListener('change', () => { window.dispatchEvent(new CustomEvent('ui:camera-device', { detail: camSel.value })); });
    camQSel.addEventListener('change', () => { window.dispatchEvent(new CustomEvent('ui:camera-quality', { detail: camQSel.value })); });
    inSel.addEventListener('change', () => { void changeInputDevice(inSel.value); });
    outSel.addEventListener('change', () => { changeOutputDevice(outSel.value); });
    navigator.mediaDevices.addEventListener('devicechange', () => { void refresh(); });
    void refresh();
    return refresh;
}

// ============================================================
// Видео → «Показ экрана»: настройки трансляции по умолчанию
// (те же значения предлагаются в окне выбора экрана)
// ============================================================
function setupStreamSettings(pane: HTMLElement): void {
    const head = document.createElement('div');
    head.className = 'settings-sub';
    head.textContent = t('Показ экрана');
    pane.append(head);

    const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

    // Качество
    const qItem = document.createElement('div');
    qItem.className = 'setting-item';
    const qLabel = document.createElement('label');
    qLabel.textContent = t('Качество');
    const qSeg = document.createElement('div');
    qSeg.className = 'seg';
    const qBtns = (Object.keys(SCREEN_QUALITIES) as ScreenQuality[]).sort((a, b) => Number(b) - Number(a)).map((q) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = q + 'p';
        b.addEventListener('click', () => { state.screenQuality = q; save('pd_screen_quality', q); mark(); });
        qSeg.append(b);
        return [q, b] as const;
    });
    qItem.append(qLabel, qSeg);

    // Что важнее
    const pItem = document.createElement('div');
    pItem.className = 'setting-item';
    const pLabel = document.createElement('label');
    pLabel.textContent = t('Что важнее');
    const pSeg = document.createElement('div');
    pSeg.className = 'seg';
    const pBtns = ([['motion', t('Плавность (игры)')], ['detail', t('Чёткость (текст, видео)')]] as const).map(([p, text]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', () => { state.screenPriority = p; save('pd_screen_priority', p); mark(); });
        pSeg.append(b);
        return [p, b] as const;
    });
    pItem.append(pLabel, pSeg);

    // Звук компьютера
    const aItem = document.createElement('div');
    aItem.className = 'setting-item';
    const aLabel = document.createElement('label');
    const aCheck = document.createElement('input');
    aCheck.type = 'checkbox';
    aCheck.checked = state.screenAudio;
    aCheck.addEventListener('change', () => { state.screenAudio = aCheck.checked; save('pd_screen_audio', aCheck.checked ? '1' : '0'); });
    aLabel.append(aCheck, ' ' + t('Передавать звук компьютера (например, игры)'));
    const aHint = document.createElement('div');
    aHint.className = 'hint';
    aHint.textContent = t('Если друзья слышат у себя эхо своего голоса, отключите эту галочку.');
    aItem.append(aLabel, aHint);

    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = t('Эти значения предлагаются при каждом показе экрана, их можно поменять в окне выбора экрана.');

    const mark = () => {
        qBtns.forEach(([q, b]) => b.classList.toggle('active', q === state.screenQuality));
        pBtns.forEach(([p, b]) => b.classList.toggle('active', p === state.screenPriority));
    };
    mark();
    pane.append(qItem, pItem, aItem, note);
}

// ============================================================
// Левое меню настроек: Аудио / Видео / Общее
// ============================================================
function setupSettingsTabs(settingsModal: HTMLElement): void {
    const buttons = Array.from(settingsModal.querySelectorAll<HTMLElement>('#settings-nav button'));
    const show = (tab: string) => {
        buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        settingsModal.querySelectorAll<HTMLElement>('.settings-pane').forEach((p) => p.classList.toggle('active', p.id === 'settings-pane-' + tab));
        try { localStorage.setItem('pd_settings_tab', tab); } catch { /* ignore */ }
    };
    buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab || 'audio')));
    let saved = 'audio';
    try { saved = localStorage.getItem('pd_settings_tab') || 'audio'; } catch { /* ignore */ }
    show(buttons.some((b) => b.dataset.tab === saved) ? saved : 'audio');
}

// ============================================================
// Порог микрофона: ползунок + живой индикатор уровня
// Полоска показывает, как громко вы говорите сейчас; белая черта — порог.
// Когда полоска зелёная (выше черты) — ваш голос уходит собеседникам.
// Возвращает функции «начать / закончить обновлять индикатор» (нужны, пока открыты настройки).
// ============================================================
function setupThresholdControl(settingsModal: HTMLElement): { start(): void; stop(): void; item: HTMLElement } {
    const content = settingsModal.querySelector('#settings-pane-audio') as HTMLElement;
    const outVol = document.getElementById('output-volume');
    const anchor = (outVol?.closest('.setting-item') as HTMLElement | null) ?? null;

    const item = document.createElement('div');
    item.className = 'setting-item';

    const label = document.createElement('label');
    label.textContent = t('Порог срабатывания микрофона ');
    const valueSpan = document.createElement('span');
    valueSpan.className = 'value';
    label.append(valueSpan);

    const meter = document.createElement('div');
    meter.style.cssText = 'position:relative; height:10px; margin:8px 0; background:var(--bg); border:1px solid var(--line); border-radius:6px; overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'position:absolute; left:0; top:0; bottom:0; width:0%; background:#6b7199;';
    const mark = document.createElement('div');
    mark.style.cssText = 'position:absolute; top:0; bottom:0; width:2px; background:var(--text);';
    meter.append(fill, mark);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '1';
    slider.max = '100';
    slider.value = String(state.micThresholdSlider);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px; color:var(--muted); margin-top:4px;';
    hint.textContent = t('Включите микрофон и скажите что-нибудь: поставьте белую черту чуть выше фонового шума. Всё, что тише черты, не передаётся.');

    item.append(label, meter, slider, hint);
    if (anchor) anchor.after(item);
    else content.append(item);

    const render = () => {
        valueSpan.textContent = String(state.micThresholdSlider);
        mark.style.left = `calc(${state.micThresholdSlider}% - 1px)`;
    };
    render();

    slider.addEventListener('input', () => {
        setMicThreshold(parseInt(slider.value, 10));
        render();
    });

    let raf: number | null = null;
    const tick = () => {
        const lvl = sliderFromLevel(state.micLevel);
        fill.style.width = lvl + '%';
        fill.style.background = lvl >= state.micThresholdSlider ? '#54d6a4' : '#6b7199';
        raf = requestAnimationFrame(tick);
    };
    return {
        item,
        start() { if (raf === null) tick(); },
        stop() {
            if (raf !== null) cancelAnimationFrame(raf);
            raf = null;
        },
    };
}

// ============================================================
// Горячая клавиша «микрофон вкл/выкл» (работает и когда окно свёрнуто)
// ============================================================
/** Превращает нажатие клавиш в запись для Electron: «Ctrl+Shift+M». Не подошло — null. */
function eventToAccelerator(e: KeyboardEvent): { acc: string | null; needModifier: boolean } {
    const c = e.code;
    const names: Record<string, string> = {
        Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
        Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
        Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    };
    let key: string | null = null;
    let plain = false; // клавиша, которую нельзя занимать без Ctrl/Alt/Shift (иначе нельзя будет печатать)
    if (/^Key[A-Z]$/.test(c)) { key = c.slice(3); plain = true; }
    else if (/^Digit\d$/.test(c)) { key = c.slice(5); plain = true; }
    else if (/^F\d{1,2}$/.test(c)) key = c;
    else if (/^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
    else if (names[c]) { key = names[c]; plain = !/^(Arrow|Insert|Delete|Home|End|Page)/.test(c); }
    if (!key) return { acc: null, needModifier: false };

    const mods: string[] = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (plain && mods.length === 0) return { acc: null, needModifier: true };
    return { acc: [...mods, key].join('+'), needModifier: false };
}

function setupHotkeyControl(settingsModal: HTMLElement, after: HTMLElement): void {
    const content = settingsModal.querySelector('#settings-pane-audio') as HTMLElement;

    const item = document.createElement('div');
    item.className = 'setting-item';
    const label = document.createElement('label');
    label.textContent = t('Горячая клавиша: микрофон вкл/выкл ');
    const valueSpan = document.createElement('span');
    valueSpan.className = 'value';
    label.append(valueSpan);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; margin-top:6px;';
    const setBtn = document.createElement('button');
    setBtn.className = 'btn btn-secondary';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-secondary';
    clearBtn.textContent = t('Сбросить');
    row.append(setBtn, clearBtn);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px; color:var(--muted); margin-top:6px;';
    item.append(label, row, hint);
    after.after(item);
    if (!after.isConnected) content.append(item);

    const baseHint = t('Работает даже когда приложение свёрнуто (например, в игре). Включение и выключение сопровождается коротким сигналом.');
    const render = () => {
        valueSpan.textContent = state.hotkey || t('не задана');
        setBtn.textContent = state.hotkey ? t('Изменить') : t('Назначить');
        clearBtn.style.display = state.hotkey ? '' : 'none';
    };
    render();
    hint.textContent = baseHint;

    const apply = async (acc: string): Promise<boolean> => {
        if (!window.api?.setHotkey) return false;
        const res = await window.api.setHotkey(acc);
        return !!res.ok;
    };

    // Восстанавливаем сохранённую клавишу при запуске
    if (state.hotkey) {
        void apply(state.hotkey).then((ok) => {
            if (!ok) hint.textContent = t('Не удалось занять «{key}» — возможно, её уже использует другая программа. Выберите другую.', { key: state.hotkey });
        });
    }

    let capturing: ((e: KeyboardEvent) => void) | null = null;
    const stopCapture = () => {
        if (capturing) window.removeEventListener('keydown', capturing, true);
        capturing = null;
        render();
    };

    setBtn.addEventListener('click', () => {
        if (capturing) { stopCapture(); hint.textContent = baseHint; return; }
        setBtn.textContent = t('Нажмите сочетание… (Esc — отмена)');
        hint.textContent = t('Нажмите нужную клавишу или сочетание, например Ctrl+Shift+M или F8.');
        capturing = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') { stopCapture(); hint.textContent = baseHint; return; }
            if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code)) return; // ждём основную клавишу
            const { acc, needModifier } = eventToAccelerator(e);
            if (!acc) {
                hint.textContent = needModifier
                    ? t('Для буквы, цифры или пробела добавьте Ctrl, Alt или Shift (иначе нельзя будет печатать).')
                    : t('Эта клавиша не подходит, попробуйте другую.');
                return;
            }
            stopCapture();
            void apply(acc).then((ok) => {
                if (ok) {
                    state.hotkey = acc;
                    localStorage.setItem('pd_hotkey', acc);
                    hint.textContent = baseHint;
                } else {
                    hint.textContent = t('Не удалось занять «{key}» — возможно, её уже использует другая программа. Попробуйте другую.', { key: acc });
                }
                render();
            });
        };
        window.addEventListener('keydown', capturing, true);
    });

    clearBtn.addEventListener('click', () => {
        stopCapture();
        state.hotkey = '';
        localStorage.removeItem('pd_hotkey');
        void apply('');
        hint.textContent = baseHint;
        render();
    });

    // Нажали горячую клавишу — переключаем микрофон (только если мы в комнате)
    window.api?.onToggleMic?.(() => {
        if (!state.inRoom) return;
        void toggleMic(); // звук включения/выключения проигрывает сама toggleMic
    });
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ UI (один раз при загрузке)
// ============================================================
/** Кнопка выбора языка в правом верхнем углу главного экрана */
function setupLanguageSwitch(): void {
    const btn = document.getElementById('lang-btn') as HTMLButtonElement | null;
    const menu = document.getElementById('lang-menu') as HTMLDivElement | null;
    if (!btn || !menu) return;
    btn.innerHTML = icon('globe', 16) + `<span>${escapeHtml(getLanguage().code.toUpperCase())}</span>`;
    btn.title = t('Язык интерфейса');
    for (const l of getLanguages()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'lang-item' + (l.code === getLanguage().code ? ' current' : '');
        item.dataset.code = l.code;
        item.textContent = l.name;
        item.addEventListener('click', () => {
            menu.classList.remove('show');
            if (l.code === getLanguage().code) return;
            setLanguage(l.code);
            window.location.reload(); // проще и надёжнее всего: окно перерисуется на новом языке
        });
        menu.append(item);
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('show'); });
    document.addEventListener('click', () => menu.classList.remove('show'));
}

export function initUI(): void {
    setupLanguageSwitch();
    setupErrorDialog();
    window.addEventListener('audio:notice', ((e: Event) => showScreenNotice(String((e as CustomEvent).detail))) as EventListener);
    const usernameInput = document.getElementById('username-input') as HTMLInputElement;
    const createRoomBtn = document.getElementById('create-room-btn') as HTMLButtonElement;
    const joinRoomBtn = document.getElementById('join-room-btn') as HTMLButtonElement;
    const hostAddressInput = document.getElementById('host-address-input') as HTMLInputElement;
    const myAddressSpan = document.getElementById('my-address') as HTMLSpanElement;
    const copyAddressBtn = document.getElementById('copy-address-btn') as HTMLButtonElement;

    const createModal = document.getElementById('create-modal') as HTMLDivElement;
    const settingsModal = document.getElementById('settings-modal') as HTMLDivElement;
    const contextMenu = document.getElementById('context-menu') as HTMLDivElement;

    const roomNameInput = document.getElementById('room-name-input') as HTMLInputElement;
    const roomPasswordInput = document.getElementById('room-password-input') as HTMLInputElement;
    const roomModeSelect = document.getElementById('room-mode') as HTMLSelectElement;
    const serverFields = document.getElementById('server-fields') as HTMLDivElement;
    const serverAddressInput = document.getElementById('server-address-input') as HTMLInputElement;
    const serverKeyInput = document.getElementById('server-key-input') as HTMLInputElement;

    // Способ создания комнаты: запоминаем выбор и адрес сервера
    roomModeSelect.value = localStorage.getItem('pd_room_mode') === 'server' ? 'server' : 'local';
    serverAddressInput.value = localStorage.getItem('pd_server_address') || '';
    const visibleGroup = document.getElementById('visible-group') as HTMLDivElement;
    const visibleBox = document.getElementById('room-visible') as HTMLInputElement;
    visibleBox.checked = localStorage.getItem('pd_room_visible') !== '0';
    visibleBox.addEventListener('change', () => localStorage.setItem('pd_room_visible', visibleBox.checked ? '1' : '0'));
    const syncModeFields = () => {
        serverFields.style.display = roomModeSelect.value === 'server' ? '' : 'none';
        visibleGroup.style.display = roomModeSelect.value === 'server' ? 'none' : '';
    };
    syncModeFields();
    roomModeSelect.addEventListener('change', () => {
        localStorage.setItem('pd_room_mode', roomModeSelect.value);
        syncModeFields();
    });
    const joinPasswordInput = document.getElementById('join-password-input') as HTMLInputElement;
    const confirmCreateBtn = document.getElementById('confirm-create') as HTMLButtonElement;
    const cancelCreateBtn = document.getElementById('cancel-create') as HTMLButtonElement;

    const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
    const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
    const leaveBtn = document.getElementById('leave-btn') as HTMLButtonElement;
    const closeSettingsBtn = document.getElementById('close-settings') as HTMLButtonElement;

    // Иконки: места под них в index.html помечены data-icon
    document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
        el.innerHTML = icon(el.dataset.icon || '', parseInt(el.dataset.size || '18', 10));
    });
    settingsBtn.innerHTML = icon('sliders', 22);
    leaveBtn.innerHTML = icon('log-out', 18) + ' ' + t('Выйти');
    (document.getElementById('chat-send') as HTMLButtonElement).innerHTML = icon('send', 18);
    (document.getElementById('context-mute') as HTMLDivElement).innerHTML = icon('volume-x', 18) + ' ' + t('Заглушить');
    (document.getElementById('context-kick') as HTMLDivElement).innerHTML = icon('user-x', 18) + ' ' + t('Выгнать');

    const camBtn = document.getElementById('camera-btn') as HTMLButtonElement;
    camBtn.innerHTML = icon('camera-off', 24);
    camBtn.title = t('Включить камеру');
    camBtn.addEventListener('click', () => { window.dispatchEvent(new CustomEvent('ui:camera-toggle')); });

    // Микрофон по умолчанию выключен
    micBtn.className = 'control-btn mic-off';
    micBtn.innerHTML = icon('mic-off', 24);
    setupChat();
    setupScreenUI();
    renderRooms();

    // Имя пользователя
    usernameInput.value = state.username;
    usernameInput.addEventListener('input', () => {
        state.username = usernameInput.value.trim();
        localStorage.setItem('pd_username', state.username);
    });

    // ---- Свой адрес: два варианта (дома / через интернет) ----
    const addrRow = myAddressSpan.parentElement as HTMLElement;
    const addrGroup = addrRow.parentElement as HTMLElement;

    const localCaption = makeCaption(t('В одной сети с вами (Wi-Fi / кабель):'));
    addrGroup.insertBefore(localCaption, addrRow);

    const publicRow = document.createElement('div');
    publicRow.className = 'address-row';
    const publicSpan = document.createElement('span');
    publicSpan.className = 'address-value';
    publicSpan.id = 'my-public-address';
    publicSpan.textContent = t('определяю…');
    const publicCopyBtn = document.createElement('button');
    publicCopyBtn.className = 'btn btn-secondary';
    publicCopyBtn.type = 'button';
    publicCopyBtn.textContent = t('Копировать');
    publicRow.append(publicSpan, publicCopyBtn);
    addrGroup.append(makeCaption(t('Через интернет (нужно открыть порт на роутере):')), publicRow);

    myAddressSpan.textContent = t('определяю…');
    void window.api.getLocalIp().then((ip) => {
        myAddressSpan.textContent = `${ip}:${SIGNALING_PORT}`;
    });
    void window.api.getPublicIp().then((ip) => {
        publicSpan.textContent = ip ? `${ip}:${SIGNALING_PORT}` : t('не удалось определить');
    });

    // Виртуальные сети (Radmin VPN и т. п.): показываем их адреса первыми — по ним играют с друзьями
    void (window.api.getVpnIps?.() ?? Promise.resolve([])).then((list) => {
        for (const v of list) {
            const row = document.createElement('div');
            row.className = 'address-row';
            const span = document.createElement('span');
            span.className = 'address-value';
            span.textContent = `${v.ip}:${SIGNALING_PORT}`;
            const copy = document.createElement('button');
            copy.className = 'btn btn-secondary';
            copy.type = 'button';
            copy.textContent = t('Копировать');
            row.append(span, copy);
            addrGroup.insertBefore(makeCaption(t('Адрес в сети {name} (дайте его друзьям):', { name: v.label })), localCaption);
            addrGroup.insertBefore(row, localCaption);
            bindCopy(copy, () => span.textContent || '');
        }
    }).catch(() => { /* адреса виртуальных сетей — необязательная подсказка */ });

    bindCopy(copyAddressBtn, () => myAddressSpan.textContent || '');
    bindCopy(publicCopyBtn, () => publicSpan.textContent || '');

    // Создание комнаты
    createRoomBtn.addEventListener('click', () => {
        if (!state.username) { showError(E.NEED_NAME, 'username-input'); return; }
        createModal.classList.add('active');
    });
    cancelCreateBtn.addEventListener('click', () => {
        createModal.classList.remove('active');
        roomNameInput.value = '';
        roomPasswordInput.value = '';
    });
    confirmCreateBtn.addEventListener('click', () => {
        const roomName = roomNameInput.value.trim();
        if (!roomName) { showError(E.NEED_ROOM_NAME, 'room-name-input'); return; }
        const password = roomPasswordInput.value;
        const mode = roomModeSelect.value === 'server' ? 'server' : 'local';
        const serverAddress = serverAddressInput.value.trim();
        if (mode === 'server' && !serverAddress) { showError(E.NEED_SERVER_ADDRESS, 'server-address-input'); return; }
        if (mode === 'server') localStorage.setItem('pd_server_address', serverAddress);
        const serverKey = serverKeyInput.value;
        createModal.classList.remove('active');
        roomNameInput.value = '';
        roomPasswordInput.value = '';
        serverKeyInput.value = '';

        // Сама логика создания комнаты — в renderer.ts
        window.dispatchEvent(new CustomEvent('ui:create-room', { detail: { roomName, password, mode, serverAddress, serverKey } }));
    });

    // Подключение по IP
    joinRoomBtn.addEventListener('click', () => {
        if (!state.username) { showError(E.NEED_NAME, 'username-input'); return; }
        const addr = hostAddressInput.value.trim();
        if (!addr) { showError(E.NEED_HOST_ADDRESS, 'host-address-input'); return; }
        window.dispatchEvent(new CustomEvent('ui:join-by-address', { detail: { address: addr, password: joinPasswordInput.value } }));
    });

    // Управление в комнате
    micBtn.addEventListener('click', () => { void toggleMic(); });
    const refreshDevices = setupDeviceSelectors(settingsModal);
    setupSoundSettings(settingsModal.querySelector('#settings-pane-sounds') as HTMLElement);
    setupSettingsTabs(settingsModal);
    const thresholdMeter = setupThresholdControl(settingsModal);
    setupHotkeyControl(settingsModal, thresholdMeter.item);
    settingsBtn.addEventListener('click', () => {
        void refreshDevices(); // названия устройств появляются после первого включения микрофона
        settingsModal.classList.add('active');
        thresholdMeter.start();
    });
    closeSettingsBtn.addEventListener('click', () => {
        settingsModal.classList.remove('active');
        thresholdMeter.stop();
    });
    const leaveModal = document.getElementById('leave-modal') as HTMLElement;
    leaveBtn.addEventListener('click', () => {
        if (state.role === 'host') leaveModal.classList.add('active'); // хозяин выбирает: оставить комнату или закрыть
        else window.dispatchEvent(new CustomEvent('ui:leave-room', { detail: { keepOpen: false } }));
    });
    document.getElementById('leave-cancel')?.addEventListener('click', () => leaveModal.classList.remove('active'));
    document.getElementById('leave-keep')?.addEventListener('click', () => {
        leaveModal.classList.remove('active');
        window.dispatchEvent(new CustomEvent('ui:leave-room', { detail: { keepOpen: true } }));
    });
    document.getElementById('leave-close-room')?.addEventListener('click', () => {
        leaveModal.classList.remove('active');
        window.dispatchEvent(new CustomEvent('ui:leave-room', { detail: { keepOpen: false } }));
    });

    // Аватар
    const avPreview = document.getElementById('my-avatar-preview') as HTMLElement | null;
    const avFile = document.getElementById('avatar-file') as HTMLInputElement | null;
    const avErr = document.getElementById('avatar-error') as HTMLElement | null;
    const renderMyAvatar = () => {
        if (!avPreview) return;
        const a = getMyAvatar();
        const name = state.username || '?';
        if (a) { avPreview.className = 'participant-avatar has-img small'; avPreview.style.backgroundColor = ''; avPreview.innerHTML = `<img src="${a}" alt="">`; }
        else { avPreview.className = 'participant-avatar small'; avPreview.style.backgroundColor = avatarColor(name); avPreview.textContent = name.charAt(0).toUpperCase(); }
    };
    const avClear = document.getElementById('avatar-clear') as HTMLElement | null;
    const renderAll = () => { renderMyAvatar(); if (avClear) avClear.style.display = getMyAvatar() ? '' : 'none'; };
    renderAll();
    document.getElementById('username-input')?.addEventListener('input', renderAll);
    document.getElementById('avatar-pick')?.addEventListener('click', () => avFile?.click());
    avPreview?.addEventListener('click', () => avFile?.click());
    avFile?.addEventListener('change', async () => {
        const f = avFile.files?.[0];
        avFile.value = '';
        if (!f) return;
        try {
            saveMyAvatar(await prepareAvatar(f));
            if (avErr) avErr.textContent = '';
            renderAll();
            window.dispatchEvent(new CustomEvent('ui:avatar-changed'));
        } catch (err) {
            if (avErr) avErr.textContent = (err as Error).message;
        }
    });
    document.getElementById('avatar-clear')?.addEventListener('click', () => {
        saveMyAvatar(null);
        if (avErr) avErr.textContent = '';
        renderAll();
        window.dispatchEvent(new CustomEvent('ui:avatar-changed'));
    });

    // Крестик → трей
    const trayBox = document.getElementById('tray-on-close') as HTMLInputElement | null;
    if (trayBox) {
        trayBox.checked = localStorage.getItem('pd_tray_on_close') !== '0';
        void window.api?.setTrayOnClose?.(trayBox.checked);
        trayBox.addEventListener('change', () => {
            localStorage.setItem('pd_tray_on_close', trayBox.checked ? '1' : '0');
            void window.api?.setTrayOnClose?.(trayBox.checked);
        });
    }

    // Громкость микрофона (то, что слышат собеседники)
    document.getElementById('input-volume')!.addEventListener('input', (e) => {
        const val = parseInt((e.target as HTMLInputElement).value);
        (document.getElementById('input-vol-value') as HTMLSpanElement).textContent = val + '%';
        setLocalInputVolume(val);
    });

    // Общая громкость собеседников
    document.getElementById('output-volume')!.addEventListener('input', () => { window.setTimeout(updateScreenStage, 0); });
    document.getElementById('output-volume')!.addEventListener('input', (e) => {
        const val = parseInt((e.target as HTMLInputElement).value);
        (document.getElementById('output-vol-value') as HTMLSpanElement).textContent = val + '%';
        setMasterOutputVolume(val);
    });

    // Контекстное меню — закрытие по клику мимо
    document.addEventListener('click', (e: MouseEvent) => {
        if (!contextMenu.contains(e.target as Node)) {
            contextMenu.classList.remove('active');
            state.selectedParticipant = null;
        }
    });

    // Громкость выбранного собеседника
    const ctxSlider = document.getElementById('context-volume-slider') as HTMLInputElement;
    const ctxValue = document.getElementById('context-volume-value') as HTMLSpanElement;
    ctxSlider.addEventListener('input', () => {
        const val = parseInt(ctxSlider.value);
        ctxValue.textContent = val + '%';
        if (state.selectedParticipant) setPeerVolume(state.selectedParticipant, val);
    });

    // Мьют выбранного собеседника
    const ctxMute = document.getElementById('context-mute') as HTMLDivElement;
    ctxMute.addEventListener('click', () => {
        const peer = state.selectedParticipant ? state.peers.get(state.selectedParticipant) : null;
        if (!peer) return;
        setPeerMuted(peer.clientId, !peer.muted);
        updateScreenStage();
        contextMenu.classList.remove('active');
    });

    // Кик участника (только хост)
    const ctxKick = document.getElementById('context-kick') as HTMLDivElement;
    ctxKick.addEventListener('click', () => {
        if (!state.selectedParticipant || state.role !== 'host') return;
        const msg: SignalingMessage = {
            type: 'kick',
            targetClientId: state.selectedParticipant,
        };
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify(msg));
        }
        contextMenu.classList.remove('active');
    });
}

// ============================================================
// Экраны
// ============================================================
export function showRoomScreen(roomName: string): void {
    (document.getElementById('main-screen') as HTMLDivElement).style.display = 'none';
    (document.getElementById('room-screen') as HTMLDivElement).classList.add('active');
    (document.getElementById('current-room-name') as HTMLHeadingElement).textContent = roomName;
}

export function leaveRoomUI(): void {
    const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
    micBtn.className = 'control-btn mic-off';
    micBtn.innerHTML = icon('mic-off', 24);
    resetChat();

    state.speakingIds.clear();
    state.pinnedId = null;
    document.getElementById('participants-list')?.classList.remove('pinning');
    (document.getElementById('participants-list') as HTMLDivElement).innerHTML = '';
    (document.getElementById('room-screen') as HTMLDivElement).classList.remove('active');
    (document.getElementById('main-screen') as HTMLDivElement).style.display = 'flex';
    (document.getElementById('context-menu') as HTMLDivElement).classList.remove('active');
}

/** Показать адрес арендованного сервера (его надо дать друзьям) */
export function showServerAddress(address: string): void {
    const el = document.getElementById('my-address') as HTMLSpanElement;
    if (el) el.textContent = address;
}

export function showHostAddress(ip: string): void {
    const el = document.getElementById('my-address') as HTMLSpanElement;
    if (el) el.textContent = `${ip}:${SIGNALING_PORT}`;
}

// ============================================================
// Список комнат (показывает, что нашлось на сервере хоста)
// ============================================================
export function updateRoomList(): void {
    renderRooms();
}

/**
 * Список на главном экране: наша открытая комната (если мы из неё вышли)
 * и комнаты, в которых мы уже бывали.
 */
export interface NearbyView { id: string; name: string; host: string; port: number; hasPassword: boolean; members: number; address: string; }
let nearbyRooms: NearbyView[] = [];
export function setNearbyRooms(list: NearbyView[]): void {
    const key = (l: NearbyView[]) => JSON.stringify(l.map((r) => [r.id, r.name, r.members, r.address, r.port, r.hasPassword]));
    if (key(list) === key(nearbyRooms)) return;
    nearbyRooms = list;
    renderRooms();
}

export function renderRooms(): void {
    const box = document.getElementById('room-list') as HTMLDivElement;
    if (!box) return;
    box.textContent = '';

    // 1) Наша комната
    if (state.hostAway && state.myRoom) {
        const titleEl = document.createElement('div');
        titleEl.className = 'room-list-title';
        titleEl.textContent = t('Ваша комната');
        const item = document.createElement('div');
        item.className = 'room-item mine';
        const info = document.createElement('div');
        info.className = 'room-info';
        const h3 = document.createElement('h3');
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = state.myRoom.name;
        h3.append(nm);
        const p = document.createElement('p');
        const dot = document.createElement('span');
        dot.className = 'status-dot online';
        p.append(dot, t('Открыта · в ней сейчас: {count}. Закроется вместе с приложением.', { count: state.myRoom.members }));
        info.append(h3, p);
        const act = document.createElement('div');
        act.className = 'room-actions';
        const enter = document.createElement('button');
        enter.className = 'btn btn-primary';
        enter.type = 'button';
        enter.textContent = t('Зайти');
        enter.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ui:rejoin-own-room')));
        const close = document.createElement('button');
        close.className = 'btn btn-secondary';
        close.type = 'button';
        close.textContent = t('Закрыть комнату');
        close.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ui:close-own-room')));
        act.append(enter, close);
        item.append(info, act);
        box.append(titleEl, item);
    }

    // 2) Комнаты в той же сети (находятся автоматически)
    const knownAddrs = new Set(getKnownRooms().map((r) => r.address));
    const near = nearbyRooms.filter((r) => !state.hostAway || r.name !== state.myRoom?.name);
    if (near.length) {
        const titleEl = document.createElement('div');
        titleEl.className = 'room-list-title';
        titleEl.textContent = t('Комнаты в вашей сети');
        box.append(titleEl);
    }
    for (const r of near) {
        const addr = `${r.address}:${r.port}`;
        const item = document.createElement('div');
        item.className = 'room-item';
        const info = document.createElement('div');
        info.className = 'room-info';
        const h3 = document.createElement('h3');
        if (r.hasPassword) h3.insertAdjacentHTML('beforeend', icon('lock', 16));
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = r.name;
        h3.append(nm);
        const p = document.createElement('p');
        const dot = document.createElement('span');
        dot.className = 'status-dot online';
        p.append(dot, t('Открыта · в ней: {count} · хост: {host} · {addr}', { count: r.members, host: r.host || '—', addr }) + (knownAddrs.has(addr) ? t(' · вы тут бывали') : ''));
        info.append(h3, p);
        const act = document.createElement('div');
        act.className = 'room-actions';
        const go = document.createElement('button');
        go.className = 'btn btn-primary';
        go.type = 'button';
        go.textContent = t('Подключиться');
        go.addEventListener('click', () => {
            if (!state.username) { showError(E.NEED_NAME, 'username-input'); return; }
            const pw = document.getElementById('join-password-input') as HTMLInputElement;
            (document.getElementById('host-address-input') as HTMLInputElement).value = addr;
            if (r.hasPassword && !pw.value) {
                pw.focus();
                showScreenNotice(t('У комнаты есть пароль: введите его в поле «Пароль комнаты» и нажмите «Подключиться».'));
                return;
            }
            window.dispatchEvent(new CustomEvent('ui:join-by-address', { detail: { address: addr, password: pw.value } }));
        });
        act.append(go);
        item.append(info, act);
        box.append(item);
    }

    // 3) Комнаты, где уже бывали
    const known = getKnownRooms();
    if (known.length) {
        const titleEl = document.createElement('div');
        titleEl.className = 'room-list-title';
        titleEl.textContent = t('Комнаты, где вы уже были');
        box.append(titleEl);
    }
    for (const r of known) {
        const lv = getRoomLive(r.address);
        const item = document.createElement('div');
        item.className = 'room-item';
        const info = document.createElement('div');
        info.className = 'room-info';
        const h3 = document.createElement('h3');
        if (r.hasPassword) h3.insertAdjacentHTML('beforeend', icon('lock', 16));
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = r.name;
        h3.append(nm);
        const p = document.createElement('p');
        const dot = document.createElement('span');
        dot.className = 'status-dot ' + (lv.status === 'unknown' ? '' : lv.status);
        const label =
            lv.status === 'online' ? t('Открыта · в ней: {count}', { count: lv.members }) + (lv.hostPresent ? '' : t(' (хоста сейчас нет)'))
            : lv.status === 'closed' ? t('Хост в сети, но комнаты нет')
            : lv.status === 'offline' ? t('Не отвечает')
            : t('Проверяю…');
        p.append(dot, `${label} · ${t('хост: {host}', { host: r.host || '—' })} · ${r.address}`);
        info.append(h3, p);
        const act = document.createElement('div');
        act.className = 'room-actions';
        const go = document.createElement('button');
        go.className = 'btn btn-primary';
        go.type = 'button';
        go.textContent = t('Подключиться');
        go.disabled = lv.status === 'offline' || lv.status === 'closed';
        go.addEventListener('click', () => {
            if (!state.username) { showError(E.NEED_NAME, 'username-input'); return; }
            const pw = document.getElementById('join-password-input') as HTMLInputElement;
            (document.getElementById('host-address-input') as HTMLInputElement).value = r.address;
            if (r.hasPassword && !pw.value) {
                pw.focus();
                showScreenNotice(t('У комнаты есть пароль: введите его в поле «Пароль комнаты» и нажмите «Подключиться».'));
                return;
            }
            window.dispatchEvent(new CustomEvent('ui:join-by-address', { detail: { address: r.address, password: pw.value } }));
        });
        const del = document.createElement('button');
        del.className = 'btn btn-secondary small';
        del.type = 'button';
        del.title = t('Убрать из списка');
        del.innerHTML = icon('x', 16);
        del.addEventListener('click', () => { forgetRoom(r.address); renderRooms(); });
        act.append(go, del);
        item.append(info, act);
        box.append(item);
    }

    if (!state.hostAway && !known.length && !near.length) {
        box.innerHTML = '<p class="room-empty">' + escapeHtml(t('Здесь появятся комнаты, в которых вы уже были.')) + '</p>';
    }
}

// ============================================================
// Участники комнаты
// ============================================================
export function updateParticipants(
    participants: Array<{ clientId: ClientId; username: string; isHost: boolean; avatar?: string }>
): void {
    const list = document.getElementById('participants-list') as HTMLDivElement;
    if (!list) return;

    // Те, кого уже нет в комнате, больше не «говорят»
    const present = new Set(participants.map((p) => p.clientId));
    for (const id of Array.from(state.speakingIds)) {
        if (!present.has(id)) state.speakingIds.delete(id);
    }

    if (state.pinnedId && !present.has(state.pinnedId)) state.pinnedId = null;
    const card = (p: { clientId: ClientId; username: string; isHost: boolean; avatar?: string }): string => `
        <div class="participant${state.speakingIds.has(p.clientId) ? ' speaking' : ''}${p.clientId === state.pinnedId ? ' pinned' : ''}" data-client-id="${escapeHtml(p.clientId)}" title="${escapeHtml(p.clientId === state.pinnedId ? t('Нажмите, чтобы открепить') : t('Нажмите, чтобы закрепить'))}">
            ${signalHtml(p.clientId)}
            ${p.clientId === state.pinnedId ? `<div class="pin-badge">${icon('pin', 14)}</div>` : ''}
            ${isSafeAvatar(p.avatar)
                ? `<div class="participant-avatar has-img"><img src="${p.avatar}" alt=""></div>`
                : `<div class="participant-avatar" style="background-color:${avatarColor(p.username)}">${escapeHtml(p.username.charAt(0).toUpperCase())}</div>`}
            <div class="participant-info">
                <h4>${escapeHtml(p.username)}</h4>
                <p>${p.isHost ? icon('crown', 13) + escapeHtml(t('Хост')) : ''}${p.isHost && p.clientId === state.selfId ? ' · ' : ''}${p.clientId === state.selfId ? escapeHtml(t('Вы')) : (p.isHost ? '' : escapeHtml(t('В комнате')))}</p>
            </div>
        </div>
    `;
    const pinned = state.pinnedId ? participants.find((p) => p.clientId === state.pinnedId) : undefined;
    list.classList.toggle('pinning', !!pinned);
    list.innerHTML = pinned
        ? `<div class="pin-stage">${card(pinned)}</div><div class="pin-strip">${participants.filter((p) => p !== pinned).map(card).join('')}</div>`
        : participants.map(card).join('');

    // Нажатие на карточку закрепляет участника крупно (а повторное — открепляет)
    list.querySelectorAll<HTMLElement>('.participant').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.dataset.clientId as ClientId | undefined;
            if (!id || document.querySelector('.room-main.has-stream')) return; // пока идёт показ экрана, карточки и так в ленте
            state.pinnedId = state.pinnedId === id ? null : id;
            updateParticipants(state.participants);
        });
    });

    // Контекстное меню по правой кнопке
    list.querySelectorAll('.participant').forEach((el) => {
        el.addEventListener('contextmenu', (e: Event) => {
            e.preventDefault();
            const me = e as MouseEvent;
            const target = me.currentTarget as HTMLDivElement;
            const clientId = target.dataset.clientId;
            if (!clientId || clientId === state.selfId) return;

            state.selectedParticipant = clientId;
            const menu = document.getElementById('context-menu') as HTMLDivElement;
            menu.style.left = me.clientX + 'px';
            menu.style.top = me.clientY + 'px';
            menu.classList.add('active');

            const peer = state.peers.get(clientId);
            const vol = peer ? Math.round(peer.volume * 100) : 100;
            (document.getElementById('context-volume-slider') as HTMLInputElement).value = String(vol);
            (document.getElementById('context-volume-value') as HTMLSpanElement).textContent = vol + '%';

            (document.getElementById('context-mute') as HTMLDivElement).innerHTML = peer?.muted
                ? icon('volume-2', 18) + ' ' + t('Включить звук')
                : icon('volume-x', 18) + ' ' + t('Заглушить');

            const kickEl = document.getElementById('context-kick') as HTMLDivElement;
            kickEl.style.display = state.role === 'host' ? 'flex' : 'none';
        });
    });
    updateCameraUI();
}

// ============================================================
// Веб-камеры: кнопка и видео в карточках участников (вместо аватара)
// ============================================================
export function updateCameraUI(): void {
    const camBtn = document.getElementById('camera-btn') as HTMLButtonElement | null;
    if (camBtn) {
        const on = !!state.cameraStream;
        camBtn.className = 'control-btn ' + (on ? 'cam-on' : 'settings');
        camBtn.innerHTML = icon(on ? 'camera' : 'camera-off', 24);
        const label = on ? t('Выключить камеру') : t('Включить камеру');
        camBtn.title = label;
        camBtn.setAttribute('aria-label', label);
    }
    const list = document.getElementById('participants-list');
    if (!list) return;
    list.querySelectorAll<HTMLElement>('.participant').forEach((card) => {
        const id = card.dataset.clientId as ClientId;
        const self = id === state.selfId;
        const stream = self ? state.cameraStream : (state.cameraIds.includes(id) ? state.peers.get(id)?.cameraStream ?? null : null);
        let tile = card.querySelector<HTMLElement>('.cam-tile');
        if (!stream) {
            tile?.remove();
            card.classList.remove('has-cam');
            return;
        }
        if (!tile) {
            tile = document.createElement('div');
            tile.className = 'cam-tile';
            const v = document.createElement('video');
            v.autoplay = true;
            v.muted = true;
            v.playsInline = true;
            tile.append(v);
            const info = card.querySelector('.participant-info');
            card.insertBefore(tile, info);
        }
        tile.classList.toggle('mirror', self);
        card.classList.add('has-cam');
        const video = tile.querySelector('video') as HTMLVideoElement;
        if (video.srcObject !== stream) {
            video.srcObject = stream;
            void video.play().catch(() => { /* автозапуск без звука разрешён */ });
        }
    });
}

// ============================================================
// Подсветка говорящего: аватар плавно становится зелёным
// ============================================================
export function setParticipantSpeaking(clientId: ClientId, speaking: boolean): void {
    if (speaking) state.speakingIds.add(clientId);
    else state.speakingIds.delete(clientId);

    const list = document.getElementById('participants-list');
    if (!list) return;
    list.querySelectorAll<HTMLElement>('.participant').forEach((el) => {
        if (el.dataset.clientId === clientId) el.classList.toggle('speaking', speaking);
    });
}

// ============================================================
// Утилита: экранирование HTML (защита от XSS через имя)
// ============================================================
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] as string));
}


// ============================================================
// Чат комнаты
// ============================================================
let chatLastFrom = '';
let chatLastTs = 0;
let chatUnread = false;

function chatEls() {
    return {
        panel: document.getElementById('chat-panel') as HTMLElement,
        list: document.getElementById('chat-messages') as HTMLElement,
        badge: document.getElementById('chat-badge') as HTMLElement,
        toggle: document.getElementById('chat-toggle') as HTMLElement,
    };
}

function chatIsOpen(): boolean {
    return !chatEls().panel.classList.contains('hidden');
}

function showChatEmpty(): void {
    const { list } = chatEls();
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = t('Здесь пока тихо. Напишите первым.');
    list.append(empty);
}

function removeChatEmpty(): void {
    chatEls().list.querySelector('.chat-empty')?.remove();
}

/** Прокручивает чат вниз, если пользователь и так был внизу (чтобы не сбивать чтение старых сообщений) */
function appendToChat(el: HTMLElement, forceScroll: boolean): void {
    const { list } = chatEls();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(el);
    if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
}

function markUnread(): void {
    if (chatIsOpen()) return;
    chatUnread = true;
    chatEls().badge.classList.add('show');
}

function openLightbox(src: string): void {
    const box = document.getElementById('lightbox') as HTMLElement;
    (box.querySelector('img') as HTMLImageElement).src = src;
    box.classList.add('show');
}

/** Маленький аватар рядом с именем в чате (картинка, если человек сейчас в комнате и выбрал её) */
function chatAvatar(m: ChatMessage): HTMLElement {
    const el = document.createElement('span');
    el.className = 'chat-ava';
    const av = m.from === state.selfId ? getMyAvatar() : state.participants.find((p) => p.clientId === m.from)?.avatar;
    if (isSafeAvatar(av)) {
        const img = document.createElement('img');
        img.src = av;
        img.alt = '';
        el.append(img);
    } else {
        el.textContent = m.username.charAt(0).toUpperCase();
        el.style.backgroundColor = avatarColor(m.username);
    }
    return el;
}

function renderChatMessage(m: ChatMessage): HTMLElement {
    const el = document.createElement('div');
    const cont = chatLastFrom === m.from && m.ts - chatLastTs < 60_000;
    el.className = 'chat-msg' + (cont ? ' cont' : '');
    if (!cont) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.append(chatAvatar(m));
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = m.username;
        who.style.color = nameColor(m.username);
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = new Date(m.ts).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
        meta.append(who, time);
        el.append(meta);
    }
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = m.text; // textContent: чужой текст не может внедрить HTML
    if (m.text) el.append(text);
    if (m.image && isSafeImage(m.image)) {
        const img = document.createElement('img');
        img.className = 'pic';
        img.src = m.image;
        img.alt = t('Картинка из чата');
        img.addEventListener('click', () => openLightbox(m.image as string));
        el.append(img);
    } else if (m.imageExpired) {
        const gone = document.createElement('span');
        gone.className = 'gone';
        gone.textContent = t('Картинка больше недоступна');
        el.append(gone);
    }
    if (m.file && typeof m.file.name === 'string' && Number.isFinite(m.file.size)) {
        el.append(renderFileCard(m));
    }
    chatLastFrom = m.from;
    chatLastTs = m.ts;
    return el;
}

/** Карточка файла в чате */
function renderFileCard(m: ChatMessage): HTMLElement {
    const f = m.file!;
    const mine = m.from === state.selfId;
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.fileId = m.id;
    const ic = document.createElement('div');
    ic.className = 'file-ic';
    ic.innerHTML = icon('paperclip', 20);
    const info = document.createElement('div');
    info.className = 'file-info';
    const nm = document.createElement('div');
    nm.className = 'file-name';
    nm.textContent = f.name;
    nm.title = f.name;
    const meta = document.createElement('div');
    meta.className = 'file-status';
    const dangerous = DANGEROUS_EXTENSIONS.includes(fileExtension(f.name));
    meta.textContent = formatSize(f.size) + (mine ? t(' · доступен, пока вы в комнате') : '');
    info.append(nm, meta);
    if (dangerous) {
        const w = document.createElement('div');
        w.className = 'file-warn';
        w.textContent = t('Программа или скрипт: скачивайте, только если доверяете отправителю');
        info.append(w);
    }
    card.append(ic, info);
    if (!mine) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary small file-btn';
        btn.textContent = t('Скачать');
        btn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('ui:file-download', { detail: { fileId: m.id, from: m.from, name: f.name, size: f.size } }));
        });
        card.append(btn);
    }
    return card;
}

function setupFileProgress(): void {
    window.addEventListener('files:progress', ((e: Event) => {
        const d = (e as CustomEvent<{ fileId: string; status: string; percent: number; text: string }>).detail;
        document.querySelectorAll<HTMLElement>('.file-card').forEach((card) => {
            if (card.dataset.fileId !== d.fileId) return;
            const st = card.querySelector('.file-status') as HTMLElement | null;
            const btn = card.querySelector('.file-btn') as HTMLButtonElement | null;
            if (st) st.textContent = d.text;
            card.classList.toggle('error', d.status === 'error');
            if (btn) {
                btn.disabled = d.status === 'loading';
                btn.textContent = d.status === 'done' ? t('Скачать ещё раз') : d.status === 'error' ? t('Повторить') : t('Скачать');
            }
        });
    }) as EventListener);
}

export function addChatMessage(m: ChatMessage): void {
    removeChatEmpty();
    appendToChat(renderChatMessage(m), m.from === state.selfId);
    if (m.from !== state.selfId) markUnread();
}

export function setChatHistory(messages: ChatMessage[]): void {
    resetChat();
    removeChatEmpty();
    for (const m of messages) chatEls().list.append(renderChatMessage(m));
    const { list } = chatEls();
    list.scrollTop = list.scrollHeight;
}

export function addSystemMessage(text: string): void {
    removeChatEmpty();
    const el = document.createElement('div');
    el.className = 'chat-system';
    el.textContent = text;
    appendToChat(el, false);
    chatLastFrom = ''; // после системной строки следующее сообщение снова с именем
}

export function resetChat(): void {
    chatLastFrom = '';
    chatLastTs = 0;
    chatUnread = false;
    chatEls().badge.classList.remove('show');
    showChatEmpty();
}

function setupChat(): void {
    setupFileProgress();
    const { panel, toggle, badge } = chatEls();
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const input = document.getElementById('chat-input') as HTMLInputElement;

    const applyOpen = (open: boolean) => {
        panel.classList.toggle('hidden', !open);
        toggle.classList.toggle('active', open);
        localStorage.setItem('pd_chat_open', open ? '1' : '0');
        if (open) {
            chatUnread = false;
            badge.classList.remove('show');
            const { list } = chatEls();
            list.scrollTop = list.scrollHeight;
        }
    };
    // На узком окне чат по умолчанию свёрнут
    const saved = localStorage.getItem('pd_chat_open');
    applyOpen(saved === null ? window.innerWidth > 760 : saved === '1');
    toggle.addEventListener('click', () => applyOpen(panel.classList.contains('hidden')));

    // ---------- картинки ----------
    const fileInput = document.getElementById('chat-file') as HTMLInputElement;
    const attachBtn = document.getElementById('chat-attach') as HTMLButtonElement;
    const emojiBtn = document.getElementById('chat-emoji') as HTMLButtonElement;
    const preview = document.getElementById('chat-attach-preview') as HTMLElement;
    const previewImg = document.getElementById('chat-attach-img') as HTMLImageElement;
    const clearBtn = document.getElementById('chat-attach-clear') as HTMLButtonElement;
    const popup = document.getElementById('emoji-popup') as HTMLElement;
    const lightbox = document.getElementById('lightbox') as HTMLElement;
    attachBtn.innerHTML = icon('paperclip', 18);
    emojiBtn.innerHTML = icon('smile', 18);
    clearBtn.innerHTML = icon('x', 16);

    const previewText = preview.querySelector('span') as HTMLElement;
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    let attached: string | null = null;
    let attachedDoc: File | null = null;
    const setAttached = (v: string | null) => {
        attached = v;
        attachedDoc = null;
        previewImg.style.display = '';
        previewText.textContent = t('Картинка будет отправлена вместе с сообщением');
        preview.classList.toggle('show', !!v);
        if (v) previewImg.src = v; else previewImg.removeAttribute('src');
    };
    const setAttachedDoc = (f: File) => {
        if (f.size > MAX_FILE_MB * 1024 * 1024) { addSystemMessage(t('Файл слишком большой: {size}. Допустимо до {max} МБ.', { size: formatSize(f.size), max: MAX_FILE_MB })); return; }
        if (f.size < 1) { addSystemMessage(t('Файл пустой.')); return; }
        attached = null;
        attachedDoc = f;
        previewImg.removeAttribute('src');
        previewImg.style.display = 'none';
        previewText.textContent = t('Файл «{name}» ({size}): друзья смогут скачать его, пока вы в комнате', { name: f.name, size: formatSize(f.size) });
        preview.classList.add('show');
    };
    const attachFile = async (file: File) => {
        try {
            if (!IMAGE_TYPES.includes(file.type)) { setAttachedDoc(file); input.focus(); return; }
            setAttached(await prepareChatImage(file));
            input.focus();
        } catch (err) {
            addSystemMessage((err as Error).message);
        }
    };
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (f) void attachFile(f);
    });
    clearBtn.addEventListener('click', () => setAttached(null));
    input.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const it of Array.from(items)) {
            if (it.kind === 'file' && it.type.startsWith('image/')) {
                const f = it.getAsFile();
                if (f) { e.preventDefault(); void attachFile(f); return; }
            }
        }
    });
    panel.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); panel.classList.add('dragover'); }
    });
    panel.addEventListener('dragleave', (e) => {
        if (e.target === panel) panel.classList.remove('dragover');
    });
    panel.addEventListener('drop', (e) => {
        e.preventDefault();
        panel.classList.remove('dragover');
        const f = e.dataTransfer?.files?.[0];
        if (f) void attachFile(f);
    });
    // просмотр картинки во весь экран
    lightbox.addEventListener('click', () => lightbox.classList.remove('show'));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { lightbox.classList.remove('show'); popup.classList.remove('show'); }
    });

    // ---------- эмодзи ----------
    const RECENT_KEY = 'pd_emoji_recent';
    const loadRecent = (): string[] => {
        try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 24) : []; } catch { return []; }
    };
    const insertEmoji = (em: string) => {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const next = input.value.slice(0, start) + em + input.value.slice(end);
        if (next.length > input.maxLength) return;
        input.value = next;
        const pos = start + em.length;
        input.setSelectionRange(pos, pos);
        input.focus();
        try { localStorage.setItem(RECENT_KEY, JSON.stringify([em, ...loadRecent().filter((x) => x !== em)].slice(0, 24))); } catch { /* ignore */ }
    };
    let emojiBuilt = false;
    const buildPopup = () => {
        popup.textContent = '';
        const tabs = document.createElement('div');
        tabs.className = 'emoji-tabs';
        const grid = document.createElement('div');
        grid.className = 'emoji-grid';
        const cats = [{ icon: '🕘', title: t('Недавние'), items: loadRecent() }, ...EMOJI_CATEGORIES];
        const show = (idx: number) => {
            tabs.querySelectorAll('.emoji-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
            grid.textContent = '';
            if (!cats[idx].items.length) {
                const e = document.createElement('div');
                e.className = 'chat-empty';
                e.textContent = t('Пока пусто');
                grid.append(e);
            }
            for (const em of cats[idx].items) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'emoji-item';
                b.textContent = em;
                b.addEventListener('click', () => insertEmoji(em));
                grid.append(b);
            }
        };
        cats.forEach((c, i) => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'emoji-tab';
            tab.title = t(c.title);
            tab.textContent = c.icon;
            tab.addEventListener('click', () => show(i));
            tabs.append(tab);
        });
        popup.append(tabs, grid);
        show(loadRecent().length ? 0 : 1);
        emojiBuilt = true;
    };
    emojiBtn.addEventListener('click', () => {
        const open = !popup.classList.contains('show');
        if (open) buildPopup();
        popup.classList.toggle('show', open);
    });
    document.addEventListener('mousedown', (e) => {
        const t = e.target as Node;
        if (popup.classList.contains('show') && !popup.contains(t) && !emojiBtn.contains(t)) popup.classList.remove('show');
    });
    void emojiBuilt;

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text && !attached && !attachedDoc) return;
        const image = attached ?? undefined;
        const file = attachedDoc ?? undefined;
        input.value = '';
        setAttached(null);
        popup.classList.remove('show');
        window.dispatchEvent(new CustomEvent('ui:chat-send', { detail: { text, image, file } }));
    });

    showChatEmpty();
    void chatUnread;
}

// ============================================================
// Трансляция экрана
// ============================================================
let toastTimer: number | undefined;

/** Короткое всплывающее сообщение (и строка в чате) */
export function showScreenNotice(text: string): void {
    const el = document.getElementById('toast');
    if (el) {
        el.textContent = text;
        el.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => el.classList.remove('show'), 4500);
    }
    addSystemMessage(text);
}

/** Полоса «связь потеряна» над списком участников (null — убрать) */
export function showReconnectBar(text: string | null): void {
    const el = document.getElementById('reconnect-bar');
    if (!el) return;
    if (text === null) { el.classList.remove('show'); return; }
    el.textContent = text;
    el.classList.add('show');
}

/** Перерисовать всё, что связано с показом экрана, по текущему состоянию */
export function updateScreenStage(): void {
    const stage = document.getElementById('stream-stage');
    const main = document.querySelector('.room-main');
    const btn = document.getElementById('screen-btn');
    if (!stage || !main || !btn) return;
    const video = document.getElementById('stream-video') as HTMLVideoElement;
    const audio = document.getElementById('stream-audio') as HTMLAudioElement;
    const invite = document.getElementById('stream-invite') as HTMLElement;
    const preview = document.getElementById('share-preview') as HTMLElement;
    const previewVideo = document.getElementById('share-preview-video') as HTMLVideoElement;
    const sc = state.screen;
    const mine = !!sc && sc.sharerId === state.selfId;

    btn.classList.toggle('sharing', mine);
    btn.classList.toggle('busy', !!sc && !mine);
    btn.title = mine ? t('Остановить показ экрана') : sc ? t('Экран уже показывает {name}', { name: sc.username }) : t('Показать экран');

    // Панель «Вы показываете экран» + маленькое окно «как видят зрители»
    const bar = document.getElementById('sharing-bar') as HTMLElement;
    bar.classList.toggle('show', mine);
    preview.classList.toggle('show', mine);
    if (mine && sc) {
        const names = state.screenViewers
            .map((id) => state.participants.find((p) => p.clientId === id)?.username)
            .filter((n): n is string => !!n);
        const who = names.length ? t('Смотрят: {names}', { names: names.join(', ') }) : t('Пока никто не смотрит');
        (document.getElementById('sharing-text') as HTMLElement).textContent = `${t('Вы показываете экран')} · ${SCREEN_QUALITIES[sc.quality].label} · ${who}`;
        (document.getElementById('share-preview-text') as HTMLElement).textContent = names.length ? t('Смотрят: {names}', { names: names.length }) : t('Так видят ваш экран');
        document.querySelectorAll<HTMLElement>('#sharing-quality button').forEach((b) => b.classList.toggle('active', b.dataset.q === sc.quality));
        const vt = state.screenStream?.getVideoTracks()[0];
        const want = vt ? new MediaStream([vt]) : null; // только картинка: звук в окошко не нужен
        const cur = previewVideo.srcObject as MediaStream | null;
        if (want && (!cur || cur.getVideoTracks()[0] !== vt)) {
            previewVideo.srcObject = want;
            void previewVideo.play().catch(() => { /* ignore */ });
        }
    } else if (previewVideo.srcObject) {
        previewVideo.srcObject = null;
    }

    // Чужая трансляция: сначала приглашение «Смотреть», после нажатия — окно просмотра
    const other = sc && !mine ? sc : null;
    const watching = !!other && state.watchingScreen;
    invite.classList.toggle('show', !!other && !watching);
    if (other && !watching) {
        (document.getElementById('invite-text') as HTMLElement).textContent = `${t('{name} показывает экран', { name: other.username })} · ${SCREEN_QUALITIES[other.quality].label}`;
    }
    main.classList.toggle('has-stream', watching);
    if (!watching || !other) {
        stage.classList.remove('show', 'loading');
        video.srcObject = null;
        audio.srcObject = null;
        if (document.fullscreenElement === stage) void document.exitFullscreen();
        return;
    }
    const peer = state.peers.get(other.sharerId);
    (document.getElementById('stream-title') as HTMLElement).textContent = `${t('{name} показывает экран', { name: other.username })} · ${SCREEN_QUALITIES[other.quality].label}`;
    const vs = peer?.screenVideoStream ?? null;
    if (video.srcObject !== vs) {
        video.srcObject = vs;
        stage.classList.add('loading'); // пока не пришёл первый кадр
        void video.play().catch(() => { /* ignore */ });
    }
    const as = peer?.screenAudioStream ?? null;
    if (audio.srcObject !== as) {
        audio.srcObject = as;
        void audio.play().catch(() => { /* ignore */ });
    }
    audio.muted = !!peer?.muted;
    audio.volume = Math.max(0, Math.min(1, (state.screenVolume / 100) * Math.min(1, state.masterVolume)));
    const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof sink.setSinkId === 'function' && audio.dataset.sink !== state.outputDeviceId) {
        audio.dataset.sink = state.outputDeviceId;
        sink.setSinkId(state.outputDeviceId).catch(() => { /* ignore */ });
    }
    stage.classList.add('show');
}

function setupScreenUI(): void {
    const btn = document.getElementById('screen-btn') as HTMLButtonElement;
    const modal = document.getElementById('screen-modal') as HTMLElement;
    const sourcesBox = document.getElementById('screen-sources') as HTMLElement;
    const goBtn = document.getElementById('screen-go') as HTMLButtonElement;
    const cancelBtn = document.getElementById('screen-cancel') as HTMLButtonElement;
    const audioCheck = document.getElementById('screen-audio') as HTMLInputElement;
    const hint = document.getElementById('screen-quality-hint') as HTMLElement;
    const stage = document.getElementById('stream-stage') as HTMLElement;
    btn.innerHTML = icon('monitor', 24);
    (document.getElementById('stream-full') as HTMLButtonElement).innerHTML = icon('maximize', 18);

    let selectedId = '';
    let quality: ScreenQuality = state.screenQuality;
    let priority: 'motion' | 'detail' = state.screenPriority;
    const markPriority = () => {
        document.querySelectorAll<HTMLElement>('#screen-priority button').forEach((b) => b.classList.toggle('active', b.dataset.p === priority));
    };
    document.querySelectorAll<HTMLElement>('#screen-priority button').forEach((b) => {
        b.addEventListener('click', () => { priority = b.dataset.p === 'detail' ? 'detail' : 'motion'; markPriority(); });
    });

    const showHint = () => {
        const q = SCREEN_QUALITIES[quality];
        const viewers = Math.max(0, state.participants.length - 1);
        const total = Math.round(q.mbps * viewers * 10) / 10;
        hint.textContent = t('До {mbps} Мбит/с исходящего интернета на каждого зрителя. Сейчас зрителей: {viewers}', { mbps: q.mbps, viewers }) +
            (viewers > 0 ? t(' — примерно {total} Мбит/с.', { total }) : '.') +
            (total > 15 ? t(' Если интернет слабый, выберите качество пониже.') : '');
    };
    const markQuality = () => {
        document.querySelectorAll<HTMLElement>('#screen-quality button').forEach((b) => b.classList.toggle('active', b.dataset.q === quality));
        showHint();
    };
    document.querySelectorAll<HTMLElement>('#screen-quality button').forEach((b) => {
        b.addEventListener('click', () => { if (isScreenQuality(b.dataset.q)) { quality = b.dataset.q; markQuality(); } });
    });

    const closeModal = () => modal.classList.remove('active');
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

    const addGroup = (title: string, items: Array<{ id: string; name: string; thumb: string }>) => {
        if (!items.length) return;
        const t = document.createElement('div');
        t.className = 'source-title';
        t.textContent = title;
        const grid = document.createElement('div');
        grid.className = 'source-grid';
        for (const s of items) {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'source-card';
            card.dataset.id = s.id;
            const img = document.createElement('img');
            img.src = s.thumb;
            img.alt = '';
            const name = document.createElement('span');
            name.textContent = s.name;
            name.title = s.name;
            card.append(img, name);
            card.addEventListener('click', () => {
                selectedId = s.id;
                sourcesBox.querySelectorAll('.source-card').forEach((c) => c.classList.toggle('selected', c === card));
                goBtn.disabled = false;
            });
            grid.append(card);
        }
        sourcesBox.append(t, grid);
    };

    const openPicker = async () => {
        selectedId = '';
        goBtn.disabled = true;
        quality = state.screenQuality;
        priority = state.screenPriority;
        markPriority();
        audioCheck.checked = state.screenAudio;
        markQuality();
        sourcesBox.textContent = t('Загружаю список экранов и окон…');
        modal.classList.add('active');
        try {
            const list = (await window.api.listScreenSources()).filter((s) => s.name !== document.title);
            sourcesBox.textContent = '';
            addGroup(t('Экраны'), list.filter((s) => s.isScreen));
            addGroup(t('Окна'), list.filter((s) => !s.isScreen));
            if (!list.length) sourcesBox.textContent = t('Не нашёл ни одного экрана или окна.');
        } catch {
            sourcesBox.textContent = t('Не удалось получить список экранов.');
        }
    };

    btn.addEventListener('click', () => {
        const sc = state.screen;
        if (sc && sc.sharerId === state.selfId) {
            window.dispatchEvent(new CustomEvent('ui:screen-stop'));
        } else if (sc) {
            showScreenNotice(t('Сейчас экран показывает {name}. Подождите, пока он закончит.', { name: sc.username }));
        } else {
            void openPicker();
        }
    });
    goBtn.addEventListener('click', () => {
        if (!selectedId) return;
        closeModal();
        window.dispatchEvent(new CustomEvent('ui:screen-start', { detail: { sourceId: selectedId, quality, audio: audioCheck.checked, priority } }));
    });

    // Приглашение «Смотреть» и «Перестать смотреть»
    document.getElementById('invite-watch')?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ui:screen-watch', { detail: { on: true } })));
    (document.getElementById('stream-close') as HTMLButtonElement).innerHTML = icon('x', 18);
    document.getElementById('stream-close')?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ui:screen-watch', { detail: { on: false } })));
    // Первый кадр пришёл — убираем надпись «Подключаюсь…»
    const streamVideo = document.getElementById('stream-video') as HTMLVideoElement;
    ['loadeddata', 'playing', 'resize'].forEach((ev) => streamVideo.addEventListener(ev, () => { if (streamVideo.videoWidth > 0) stage.classList.remove('loading'); }));
    // Маленькое окно у стримера: свернуть / показать
    const previewBox = document.getElementById('share-preview') as HTMLElement;
    const previewHide = document.getElementById('share-preview-hide') as HTMLButtonElement;
    previewHide.addEventListener('click', () => {
        const c = previewBox.classList.toggle('collapsed');
        previewHide.textContent = c ? t('Показать') : t('Скрыть');
    });

    // Панель «Вы показываете экран»
    document.getElementById('sharing-stop')?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ui:screen-stop')));
    document.querySelectorAll<HTMLElement>('#sharing-quality button').forEach((b) => {
        b.addEventListener('click', () => {
            if (isScreenQuality(b.dataset.q)) window.dispatchEvent(new CustomEvent('ui:screen-quality', { detail: { quality: b.dataset.q } }));
        });
    });

    // Окно просмотра: громкость и во весь экран
    const vol = document.getElementById('stream-volume') as HTMLInputElement;
    vol.value = String(state.screenVolume);
    vol.addEventListener('input', () => {
        state.screenVolume = parseInt(vol.value, 10) || 0;
        try { localStorage.setItem('pd_screen_volume', String(state.screenVolume)); } catch { /* ignore */ }
        updateScreenStage();
    });
    const toggleFull = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void stage.requestFullscreen().catch(() => { /* ignore */ });
    };
    document.getElementById('stream-full')?.addEventListener('click', toggleFull);
    document.getElementById('stream-video')?.addEventListener('dblclick', toggleFull);
}
