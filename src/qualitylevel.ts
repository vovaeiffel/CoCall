// src/qualitylevel.ts
// Оценка качества связи по пингу и потерям пакетов. Чистая функция (без зависимостей), чтобы её было легко проверять.

export type QualityLevel = 0 | 1 | 2 | 3 | 4;

/** 4 — отлично, 3 — хорошо, 2 — так себе, 1 — плохо, 0 — нет данных / нет связи */
export function qualityLevel(rttMs: number | null, lossPercent: number | null): QualityLevel {
    if (rttMs === null && lossPercent === null) return 0;
    const rtt = rttMs ?? 0;
    const loss = lossPercent ?? 0;
    if (rtt < 90 && loss < 1) return 4;
    if (rtt < 170 && loss < 3) return 3;
    if (rtt < 320 && loss < 8) return 2;
    return 1;
}

export function qualityText(level: QualityLevel, rttMs: number | null, lossPercent: number | null, tr: (text: string, params?: Record<string, string | number>) => string = (x, p) => x.replace(/\{(\w+)\}/g, (m, k: string) => String(p?.[k] ?? m))): string {
    const names = [tr('Измеряю связь…'), tr('Связь плохая'), tr('Связь средняя'), tr('Связь хорошая'), tr('Связь отличная')];
    const parts = [names[level]];
    if (level > 0) {
        if (rttMs !== null) parts.push(tr('задержка {ms} мс', { ms: Math.round(rttMs) }));
        if (lossPercent !== null) parts.push(tr('потери {percent}%', { percent: lossPercent < 10 ? lossPercent.toFixed(1) : Math.round(lossPercent) }));
    }
    return parts.join(' · ');
}
