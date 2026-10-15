// src/soundsettings.ts
// ============================================================
// Настройки → «Звуки»: включить/выключить, громкость, набор звуков,
// а также свой звук для любого события.
// ============================================================
import { t } from './i18n';
import {
    loadSoundInfo, setSoundInfo, getSoundInfo, soundsEnabled, setSoundsEnabled,
    getSoundVolume, setSoundVolume, getSelectedPackId, setSelectedPackId,
} from './soundpacks';
import { playRoomSound, resetSoundCache, type SoundKind } from './audio';
import { icon } from './icons';

const EVENTS: Array<{ kind: SoundKind; label: () => string }> = [
    { kind: 'join', label: () => t('Кто-то зашёл в комнату') },
    { kind: 'leave', label: () => t('Кто-то вышел из комнаты') },
    { kind: 'message', label: () => t('Новое сообщение в чате') },
    { kind: 'stream-start', label: () => t('Началась трансляция экрана') },
    { kind: 'stream-stop', label: () => t('Трансляция экрана закончилась') },
    { kind: 'mic-on', label: () => t('Вы включили микрофон') },
    { kind: 'mic-off', label: () => t('Вы выключили микрофон') },
];

export function setupSoundSettings(pane: HTMLElement): void {
    const item = (): HTMLElement => { const d = document.createElement('div'); d.className = 'setting-item'; return d; };

    // Вкл/выкл
    const onItem = item();
    const onLabel = document.createElement('label');
    const onCheck = document.createElement('input');
    onCheck.type = 'checkbox';
    onCheck.checked = soundsEnabled();
    onCheck.addEventListener('change', () => setSoundsEnabled(onCheck.checked));
    onLabel.append(onCheck, ' ' + t('Звуки уведомлений (вход и выход, чат, трансляция, микрофон)'));
    onItem.append(onLabel);

    // Громкость
    const volItem = item();
    const volLabel = document.createElement('label');
    const volValue = document.createElement('span');
    volValue.className = 'value';
    volLabel.append(t('Громкость звуков') + ' ', volValue);
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.value = String(Math.round(getSoundVolume() * 100));
    volValue.textContent = vol.value + '%';
    vol.addEventListener('input', () => { volValue.textContent = vol.value + '%'; setSoundVolume(Number(vol.value)); });
    vol.addEventListener('change', () => playRoomSound('join', true));
    volItem.append(volLabel, vol);

    // Набор
    const packItem = item();
    const packLabel = document.createElement('label');
    packLabel.textContent = t('Набор звуков');
    const packSel = document.createElement('select');
    packSel.style.cssText = 'width:100%; padding:9px 10px; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:10px; font:inherit; outline:none;';
    const folderRow = document.createElement('div');
    folderRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;';
    const folderBtn = document.createElement('button');
    folderBtn.type = 'button';
    folderBtn.className = 'btn btn-secondary';
    folderBtn.textContent = t('Открыть папку с наборами');
    folderBtn.addEventListener('click', () => { void window.api?.openSoundPacksFolder?.(); });
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-secondary';
    refreshBtn.textContent = t('Обновить список');
    folderRow.append(folderBtn, refreshBtn);
    const packHint = document.createElement('div');
    packHint.className = 'hint';
    packHint.textContent = t('Свой набор — это папка с файлами join.mp3, leave.mp3, message.mp3 и т. д. Положите её в открывшуюся папку и нажмите «Обновить список».');
    packItem.append(packLabel, packSel, folderRow, packHint);

    // События
    const head = document.createElement('div');
    head.className = 'settings-sub';
    head.textContent = t('Свои звуки для событий');
    const table = document.createElement('div');
    table.className = 'sound-table';
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = t('Свой звук важнее набора. Подходят mp3, wav и ogg до 3 МБ; лучше короткие, до 2 секунд.');
    const err = document.createElement('div');
    err.className = 'hint';
    err.style.color = 'var(--bad)';

    pane.append(onItem, volItem, packItem, head, table, note, err);

    const fillPacks = () => {
        packSel.innerHTML = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = t('Стандартный');
        packSel.append(def);
        for (const p of getSoundInfo().packs) {
            const o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.builtin ? p.name : p.name + ' ' + t('(мой)');
            packSel.append(o);
        }
        const cur = getSelectedPackId();
        packSel.value = Array.from(packSel.options).some((o) => o.value === cur) ? cur : '';
    };

    const renderTable = () => {
        table.innerHTML = '';
        const custom = getSoundInfo().custom;
        for (const ev of EVENTS) {
            const row = document.createElement('div');
            row.className = 'sound-row';
            const name = document.createElement('div');
            name.className = 'sound-name';
            const title = document.createElement('div');
            title.textContent = ev.label();
            name.append(title);
            const c = custom[ev.kind];
            if (c) {
                const f = document.createElement('div');
                f.className = 'hint';
                f.textContent = c.name;
                name.append(f);
            }
            const play = document.createElement('button');
            play.type = 'button';
            play.className = 'chat-tool';
            play.title = t('Прослушать');
            play.innerHTML = icon('play', 16);
            play.addEventListener('click', () => playRoomSound(ev.kind, true));
            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'btn btn-secondary';
            pick.textContent = c ? t('Заменить…') : t('Свой звук…');
            pick.addEventListener('click', async () => {
                err.textContent = '';
                const res = await window.api?.importSound?.(ev.kind);
                if (!res) return;
                setSoundInfo(res);
                resetSoundCache();
                if (res.ok) playRoomSound(ev.kind, true);
                else if (res.error === 'too-big') err.textContent = t('Файл слишком большой (больше 3 МБ).');
                else if (res.error === 'bad-type') err.textContent = t('Подходят только mp3, wav и ogg.');
                else if (res.error && res.error !== 'cancel') err.textContent = t('Не удалось добавить звук.');
                renderTable();
            });
            row.append(name, play, pick);
            if (c) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'chat-tool';
                del.title = t('Убрать свой звук');
                del.innerHTML = icon('x', 16);
                del.addEventListener('click', async () => {
                    const res = await window.api?.removeCustomSound?.(ev.kind);
                    if (res) setSoundInfo(res);
                    resetSoundCache();
                    renderTable();
                });
                row.append(del);
            }
            table.append(row);
        }
    };

    packSel.addEventListener('change', () => {
        setSelectedPackId(packSel.value);
        resetSoundCache();
        playRoomSound('join', true);
    });
    refreshBtn.addEventListener('click', async () => {
        await loadSoundInfo();
        resetSoundCache();
        fillPacks();
        renderTable();
    });

    fillPacks();
    renderTable();
    void loadSoundInfo().then(() => { resetSoundCache(); fillPacks(); renderTable(); });
}
