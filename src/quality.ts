// src/quality.ts
// ============================================================
// Индикатор качества связи (батарейка) рядом с каждым участником.
// Раз в пару секунд спрашиваем у браузера пинг и потери пакетов
// по соединению с каждым собеседником.
// ============================================================
import { state } from './state';
import { qualityLevel, qualityText, type QualityLevel } from './qualitylevel';
import type { ClientId } from './protocol';
import { t } from './i18n';

interface Info { level: QualityLevel; rtt: number | null; loss: number | null; text: string; }
const infos = new Map<ClientId, Info>();
const lastCounters = new Map<ClientId, { lost: number; recv: number }>();

/** Картинка-батарейка: 4 деления, цвет зависит от уровня */
export function batteryHtml(level: QualityLevel): string {
    const bars = [0, 1, 2, 3].map((i) => `<rect x="${2 + i * 4.5}" y="2.5" width="3.3" height="7" rx="0.8" class="${i < level ? 'on' : 'off'}"/>`).join('');
    return `<svg viewBox="0 0 24 12" width="22" height="11" aria-hidden="true"><rect x="0.6" y="0.6" width="20.6" height="10.8" rx="2.2" class="frame"/><rect x="21.8" y="3.8" width="1.6" height="4.4" rx="0.7" class="frame-fill"/>${bars}</svg>`;
}

/** Разметка индикатора для участника (кроме нас самих) */
export function signalHtml(clientId: ClientId): string {
    if (clientId === state.selfId) return '';
    const i = infos.get(clientId);
    const level = i?.level ?? 0;
    const text = i?.text ?? t('Измеряю связь…');
    return `<div class="signal q${level}" title="${text}">${batteryHtml(level)}</div>`;
}

function paint(clientId: ClientId): void {
    const i = infos.get(clientId);
    if (!i) return;
    document.querySelectorAll<HTMLElement>('.participant').forEach((card) => {
        if (card.dataset.clientId !== clientId) return;
        const el = card.querySelector('.signal') as HTMLElement | null;
        if (!el) return;
        el.className = `signal q${i.level}`;
        el.title = i.text;
        el.innerHTML = batteryHtml(i.level);
    });
}

async function measure(clientId: ClientId, pc: RTCPeerConnection): Promise<void> {
    let rtt: number | null = null;
    let loss: number | null = null;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        infos.set(clientId, { level: 1, rtt: null, loss: null, text: t('Нет связи') });
        paint(clientId);
        return;
    }
    if (pc.connectionState !== 'connected') {
        infos.set(clientId, { level: 0, rtt: null, loss: null, text: t('Подключаюсь…') });
        paint(clientId);
        return;
    }
    try {
        const stats = await pc.getStats();
        let remoteRtt: number | null = null;
        stats.forEach((r) => {
            if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && typeof r.currentRoundTripTime === 'number') {
                rtt = r.currentRoundTripTime * 1000;
            }
            if (r.type === 'remote-inbound-rtp' && r.kind === 'audio' && typeof r.roundTripTime === 'number') {
                remoteRtt = r.roundTripTime * 1000;
            }
            if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                const lost = Number(r.packetsLost) || 0;
                const recv = Number(r.packetsReceived) || 0;
                const prev = lastCounters.get(clientId);
                lastCounters.set(clientId, { lost, recv });
                if (prev) {
                    const dLost = Math.max(0, lost - prev.lost);
                    const dRecv = Math.max(0, recv - prev.recv);
                    if (dLost + dRecv > 0) loss = (dLost / (dLost + dRecv)) * 100;
                    else loss = infos.get(clientId)?.loss ?? 0;
                }
            }
        });
        if (rtt === null) rtt = remoteRtt;
    } catch { /* не вышло — оставим прошлые данные */ return; }
    const level = qualityLevel(rtt, loss);
    infos.set(clientId, { level, rtt, loss, text: qualityText(level, rtt, loss, t) });
    paint(clientId);
}

let timer = 0;
export function startQualityMonitor(): void {
    if (timer) return;
    timer = window.setInterval(() => {
        for (const id of Array.from(infos.keys())) {
            if (!state.peers.has(id)) { infos.delete(id); lastCounters.delete(id); }
        }
        for (const [id, peer] of state.peers) void measure(id, peer.pc);
    }, 2000);
}
