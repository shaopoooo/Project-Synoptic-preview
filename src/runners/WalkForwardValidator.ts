/**
 * WalkForwardValidator — 4 窗口滾動驗證
 *
 * 將 150 天歷史數據切成 4 個時序單調的 train/validate 窗口：
 *   Window 1: [Day 0-75] train  → [Day 75-95] validate
 *   Window 2: [Day 20-95] train → [Day 95-115] validate
 *   Window 3: [Day 40-115] train → [Day 115-135] validate
 *   Window 4: [Day 60-135] train → [Day 135-150] validate
 *
 * Fitness = mean(4 windows Sharpe)
 * Hard gate: any window maxDD > 30% → fitness = 0
 */

import type { RegimeGenome, HourlyReturn } from '../types';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('WalkForward');

export interface WalkForwardWindow {
    trainStart: number;
    trainEnd: number;
    validateStart: number;
    validateEnd: number;
}

export interface WalkForwardResult {
    fitness: number;
    maxDrawdown: number;
    windowResults: Array<{ sharpe: number; maxDrawdown: number }>;
}

/** 預設 4 窗口配置（150 天數據） */
export const DEFAULT_WINDOWS: WalkForwardWindow[] = [
    { trainStart: 0,  trainEnd: 75,  validateStart: 75,  validateEnd: 95 },
    { trainStart: 20, trainEnd: 95,  validateStart: 95,  validateEnd: 115 },
    { trainStart: 40, trainEnd: 115, validateStart: 115, validateEnd: 135 },
    { trainStart: 60, trainEnd: 135, validateStart: 135, validateEnd: 150 },
];

/** 按天數切割 HourlyReturn 陣列 */
function sliceByDays(candles: HourlyReturn[], startDay: number, endDay: number): HourlyReturn[] {
    const startIdx = startDay * 24;
    const endIdx = Math.min(endDay * 24, candles.length);
    return candles.slice(startIdx, endIdx);
}

/**
 * 在單一 validate 窗口上計算 Sharpe 和 maxDrawdown。
 */
function evaluateWindow(
    validateReturns: number[],
): { sharpe: number; maxDrawdown: number } {
    if (validateReturns.length < 2) {
        return { sharpe: 0, maxDrawdown: 0 };
    }

    const mean = validateReturns.reduce((s, r) => s + r, 0) / validateReturns.length;
    const variance = validateReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / validateReturns.length;
    const std = Math.sqrt(variance);

    const sharpe = std > 0 ? (mean / std) * Math.sqrt(8760) : 0;

    let peak = 0;
    let cumulative = 0;
    let maxDD = 0;
    for (const r of validateReturns) {
        cumulative += r;
        if (cumulative > peak) peak = cumulative;
        const dd = peak - cumulative;
        if (dd > maxDD) maxDD = dd;
    }

    return { sharpe, maxDrawdown: maxDD };
}

/**
 * 執行 4 窗口 walk-forward validation。
 */
export function walkForwardValidate(
    genome: RegimeGenome,
    candles: HourlyReturn[],
    windows = DEFAULT_WINDOWS,
): WalkForwardResult {
    const windowResults: Array<{ sharpe: number; maxDrawdown: number }> = [];
    let worstDD = 0;

    log.debug(`[${genome.id}] 開始 walk-forward 驗證，candles=${candles.length}，窗口數=${windows.length}`);

    for (const w of windows) {
        const validateCandles = sliceByDays(candles, w.validateStart, w.validateEnd);
        const validateReturns = validateCandles.map(c => c.r);

        const result = evaluateWindow(validateReturns);
        windowResults.push(result);
        if (result.maxDrawdown > worstDD) worstDD = result.maxDrawdown;

        log.debug(
            `[${genome.id}] 窗口 validate[${w.validateStart}d-${w.validateEnd}d] ` +
            `sharpe=${result.sharpe.toFixed(3)} maxDD=${(result.maxDrawdown * 100).toFixed(2)}%`,
        );
    }

    if (worstDD > 0.30) {
        log.debug(`[${genome.id}] 觸發 maxDD hard gate（worstDD=${(worstDD * 100).toFixed(2)}%）→ fitness=0`);
        return { fitness: 0, maxDrawdown: worstDD, windowResults };
    }

    const meanSharpe = windowResults.reduce((s, r) => s + r.sharpe, 0) / windowResults.length;

    if (!Number.isFinite(meanSharpe)) {
        log.debug(`[${genome.id}] meanSharpe 非有限數 → fitness=0`);
        return { fitness: 0, maxDrawdown: worstDD, windowResults };
    }

    log.debug(`[${genome.id}] fitness=${meanSharpe.toFixed(3)} maxDD=${(worstDD * 100).toFixed(2)}%`);
    return { fitness: meanSharpe, maxDrawdown: worstDD, windowResults };
}
