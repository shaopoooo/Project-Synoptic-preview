/**
 * regimeSignalAudit — 量化 regime engine 分類品質的 side-output。
 *
 * 對應：office-hours 2026-04-13 戰略 review observation #1
 * 「regime engine 是單點失敗，signal quality 從未被正式驗證」。
 *
 * 本模組為 **pure sync function**：無 I/O、無 async、無 fs。
 * 輸入為 featureExtractor 產出的 ReplayFeature[]（regime + price 已在其中），
 * 輸出為 RegimeAuditResult，由 summary formatter append 到 backtest report。
 *
 * 核心指標 `trendVsRangeRatio`：
 *   trend 期間的 avg |ratio move| / range 期間的 avg |ratio move|
 *   > 2.0 = 強 signal; 1.5-2.0 = 可用; 1.0-1.5 = 弱; < 1.0 = 反向
 */

import type { ReplayFeature } from '../../types/replay';

// ─── Public types ────────────────────────────────────────────────────────────

export interface RegimeAuditResult {
    totalValidCycles: number;

    // Transition statistics
    transitionCount: number;
    avgTrendDurationHours: number;
    avgRangeDurationHours: number;
    flipFlopCount: number;          // regime < threshold hours then reverts
    flipFlopRate: number;           // flipFlopCount / transitionCount (0-1)

    // Signal quality proxies
    trendRegime: {
        episodeCount: number;
        avgAbsMove24h: number;      // average |price change| in next 24h (%)
        avgAbsMove4h: number;       // average |price change| in next 4h (%)
    };
    rangeRegime: {
        episodeCount: number;
        avgAbsMove24h: number;
        pctWithinAtr24h: number;    // % of range episodes where price stayed in ATR band for 24h (0-1)
    };

    // Key derived metric
    trendVsRangeRatio: number;      // trendRegime.avgAbsMove24h / rangeRegime.avgAbsMove24h
}

type DominantRegime = 'trend' | 'range' | 'neutral';

interface Episode {
    regime: DominantRegime;
    startIdx: number;
    endIdx: number;             // inclusive
    durationHours: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDominant(rv: { range: number; trend: number; neutral: number }): DominantRegime {
    if (rv.trend > rv.range && rv.trend > rv.neutral) return 'trend';
    if (rv.range > rv.neutral) return 'range';
    return 'neutral';
}

/**
 * |price change %| from features[fromIdx] to features[toIdx].
 * Returns null if either price is null or indices out of range.
 */
function absMovePct(features: ReplayFeature[], fromIdx: number, toIdx: number): number | null {
    if (toIdx >= features.length) return null;
    const p0 = features[fromIdx].currentPriceNorm;
    const p1 = features[toIdx].currentPriceNorm;
    if (p0 == null || p1 == null || p0 === 0) return null;
    return Math.abs((p1 - p0) / p0) * 100;
}

/**
 * Check if price stayed within ±atrHalfWidth of starting price for `hours` cycles.
 * Returns null if data insufficient.
 */
function stayedWithinAtr(
    features: ReplayFeature[],
    startIdx: number,
    hours: number,
): boolean | null {
    const atr = features[startIdx].atrHalfWidth;
    const p0 = features[startIdx].currentPriceNorm;
    if (atr == null || p0 == null) return null;

    for (let i = startIdx + 1; i <= startIdx + hours && i < features.length; i++) {
        const p = features[i].currentPriceNorm;
        if (p == null) continue; // skip null cycles
        if (Math.abs(p - p0) > atr) return false;
    }
    // If we didn't have enough data to check full window
    if (startIdx + hours >= features.length) return null;
    return true;
}

// ─── Main function ───────────────────────────────────────────────────────────

export function auditRegimeSignal(
    features: ReplayFeature[],
    flipFlopThresholdHours = 4,
): RegimeAuditResult {
    // Filter to valid cycles (regime + price both non-null)
    const valid = features.filter(f => f.regime != null && f.currentPriceNorm != null);

    if (valid.length < 2) {
        return {
            totalValidCycles: valid.length,
            transitionCount: 0,
            avgTrendDurationHours: 0,
            avgRangeDurationHours: 0,
            flipFlopCount: 0,
            flipFlopRate: 0,
            trendRegime: { episodeCount: 0, avgAbsMove24h: 0, avgAbsMove4h: 0 },
            rangeRegime: { episodeCount: 0, avgAbsMove24h: 0, pctWithinAtr24h: 0 },
            trendVsRangeRatio: 0,
        };
    }

    // ── Build episodes ───────────────────────────────────────────────────────
    const episodes: Episode[] = [];
    let epStart = 0;
    let currentRegime = getDominant(valid[0].regime!);

    for (let i = 1; i < valid.length; i++) {
        const regime = getDominant(valid[i].regime!);
        if (regime !== currentRegime) {
            const durationHours = (valid[i].ts - valid[epStart].ts) / 3600;
            episodes.push({ regime: currentRegime, startIdx: epStart, endIdx: i - 1, durationHours });
            epStart = i;
            currentRegime = regime;
        }
    }
    // Last episode
    const lastDuration = (valid[valid.length - 1].ts - valid[epStart].ts) / 3600;
    episodes.push({ regime: currentRegime, startIdx: epStart, endIdx: valid.length - 1, durationHours: lastDuration });

    // ── Transition stats ─────────────────────────────────────────────────────
    const transitionCount = Math.max(0, episodes.length - 1);

    const trendEps = episodes.filter(e => e.regime === 'trend');
    const rangeEps = episodes.filter(e => e.regime === 'range');

    const avgTrendDuration = trendEps.length > 0
        ? trendEps.reduce((s, e) => s + e.durationHours, 0) / trendEps.length
        : 0;
    const avgRangeDuration = rangeEps.length > 0
        ? rangeEps.reduce((s, e) => s + e.durationHours, 0) / rangeEps.length
        : 0;

    // Flip-flop: episode duration < threshold
    let flipFlopCount = 0;
    for (const ep of episodes) {
        if (ep.durationHours < flipFlopThresholdHours && ep.durationHours > 0) {
            flipFlopCount++;
        }
    }
    const flipFlopRate = transitionCount > 0 ? flipFlopCount / transitionCount : 0;

    // ── Signal quality: trend ────────────────────────────────────────────────
    const trend24hMoves: number[] = [];
    const trend4hMoves: number[] = [];
    for (const ep of trendEps) {
        const m24 = absMovePct(valid, ep.startIdx, ep.startIdx + 24);
        if (m24 != null) trend24hMoves.push(m24);
        const m4 = absMovePct(valid, ep.startIdx, ep.startIdx + 4);
        if (m4 != null) trend4hMoves.push(m4);
    }
    const avgTrend24h = trend24hMoves.length > 0
        ? trend24hMoves.reduce((s, v) => s + v, 0) / trend24hMoves.length
        : 0;
    const avgTrend4h = trend4hMoves.length > 0
        ? trend4hMoves.reduce((s, v) => s + v, 0) / trend4hMoves.length
        : 0;

    // ── Signal quality: range ────────────────────────────────────────────────
    const range24hMoves: number[] = [];
    let rangeWithinAtrCount = 0;
    let rangeWithinAtrTotal = 0;
    for (const ep of rangeEps) {
        const m24 = absMovePct(valid, ep.startIdx, ep.startIdx + 24);
        if (m24 != null) range24hMoves.push(m24);

        const within = stayedWithinAtr(valid, ep.startIdx, 24);
        if (within != null) {
            rangeWithinAtrTotal++;
            if (within) rangeWithinAtrCount++;
        }
    }
    const avgRange24h = range24hMoves.length > 0
        ? range24hMoves.reduce((s, v) => s + v, 0) / range24hMoves.length
        : 0;
    const pctWithinAtr = rangeWithinAtrTotal > 0
        ? rangeWithinAtrCount / rangeWithinAtrTotal
        : 0;

    // ── Key metric ───────────────────────────────────────────────────────────
    const trendVsRangeRatio = avgRange24h > 0 ? avgTrend24h / avgRange24h : 0;

    return {
        totalValidCycles: valid.length,
        transitionCount,
        avgTrendDurationHours: Math.round(avgTrendDuration * 10) / 10,
        avgRangeDurationHours: Math.round(avgRangeDuration * 10) / 10,
        flipFlopCount,
        flipFlopRate: Math.round(flipFlopRate * 1000) / 1000,
        trendRegime: {
            episodeCount: trendEps.length,
            avgAbsMove24h: Math.round(avgTrend24h * 100) / 100,
            avgAbsMove4h: Math.round(avgTrend4h * 100) / 100,
        },
        rangeRegime: {
            episodeCount: rangeEps.length,
            avgAbsMove24h: Math.round(avgRange24h * 100) / 100,
            pctWithinAtr24h: Math.round(pctWithinAtr * 1000) / 1000,
        },
        trendVsRangeRatio: Math.round(trendVsRangeRatio * 100) / 100,
    };
}
