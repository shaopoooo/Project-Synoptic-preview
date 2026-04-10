/**
 * MarketRegimeAnalyzer — 市場狀態分析（純函式，無 I/O）
 *
 * 提供三軌驗證所需的指標計算：
 *   Track 1 用：CHOP 指數（震盪 vs 趨勢）、Hurst 指數（均值回歸 vs 趨勢延續）
 *   Track 2 用：ATR(14)（真實波動幅度下限）
 *   Track 3 用：Percentile P5/P95（歷史價格天花板）
 *
 * 所有函式輸入為 HourlyReturn[]（已有 high/low/close/r 欄位），不需要額外 API。
 */

import type { HourlyReturn, MarketRegime, RangeGuards, RegimeGenome, RegimeVector } from '../../types';

// ─── Track 1：CHOP 指數 ────────────────────────────────────────────────────────

/**
 * 計算 CHOP 指數（Choppiness Index）。
 *
 * 公式：100 × log10(Σ|HL_i|) / (Highest High − Lowest Low)) / log10(n)
 *   - Σ|HL_i|：最近 n 根蠟燭的 1H ATR 總和（high_i − low_i）
 *   - Highest High / Lowest Low：n 根內的最高/最低點
 *
 * 結果區間 [0, 100]：
 *   > 61.8 = 高度震盪（LP 友善）
 *   > 55   = 偏震盪
 *   < 45   = 偏趨勢
 *   < 38.2 = 強趨勢（LP 危險）
 */
function calculateCHOP(candles: HourlyReturn[], n = 14): number {
    if (candles.length < n) return 50;
    const recent = candles.slice(-n);

    const atrSum = recent.reduce((s, c) => s + (c.high - c.low), 0);
    const highestHigh = recent.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const lowestLow   = recent.reduce((m, c) => Math.min(m, c.low),   Infinity);
    const totalRange  = highestHigh - lowestLow;

    if (totalRange <= 0 || atrSum <= 0) return 50;
    return 100 * Math.log10(atrSum / totalRange) / Math.log10(n);
}

// ─── Track 1：Hurst 指數 ───────────────────────────────────────────────────────

/**
 * 以 R/S 分析（Rescaled Range）估算 Hurst 指數。
 *
 * 對 lag = 4..maxLag 各計算一組 R/S，再對 log(lag) vs log(R/S) 做線性回歸，
 * 斜率即為 Hurst 指數 H。
 *
 * H > 0.5：趨勢延續（價格有動量）
 * H < 0.5：均值回歸（LP 友善，價格傾向回中心）
 * H ≈ 0.5：隨機遊走
 */
function calculateHurst(returns: number[], maxLag = 20): number {
    const n = returns.length;
    if (n < maxLag * 2) return 0.5;

    const points: Array<{ x: number; y: number }> = [];

    for (let lag = 4; lag <= maxLag; lag++) {
        const chunks = Math.floor(n / lag);
        let rsSum = 0;
        let count = 0;

        for (let c = 0; c < chunks; c++) {
            const chunk = returns.slice(c * lag, (c + 1) * lag);
            const mean  = chunk.reduce((s, r) => s + r, 0) / lag;

            let cumDev = 0;
            let maxDev = -Infinity;
            let minDev =  Infinity;
            let varSum = 0;

            for (const r of chunk) {
                cumDev += r - mean;
                if (cumDev > maxDev) maxDev = cumDev;
                if (cumDev < minDev) minDev = cumDev;
                varSum += (r - mean) ** 2;
            }

            const R = maxDev - minDev;
            const S = Math.sqrt(varSum / lag);
            if (S > 0 && R > 0) { rsSum += R / S; count++; }
        }

        if (count > 0) points.push({ x: Math.log(lag), y: Math.log(rsSum / count) });
    }

    if (points.length < 2) return 0.5;

    // OLS 線性回歸斜率
    const m  = points.length;
    const sx = points.reduce((s, p) => s + p.x, 0);
    const sy = points.reduce((s, p) => s + p.y, 0);
    const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
    const sx2 = points.reduce((s, p) => s + p.x ** 2, 0);
    const H = (m * sxy - sx * sy) / (m * sx2 - sx ** 2);

    return Math.max(0, Math.min(1, H));
}

// ─── Track 2：ATR ─────────────────────────────────────────────────────────────

/**
 * 計算 ATR(n)（Average True Range，1H 蠟燭的平均高低差）。
 * 作為開倉區間半寬的最小值：確保開倉不比單根 K 線振幅還窄。
 */
function calculateATR(candles: HourlyReturn[], n = 14): number {
    if (candles.length < n) return 0;
    const recent = candles.slice(-n);
    return recent.reduce((s, c) => s + (c.high - c.low), 0) / n;
}

// ─── Track 3：Percentile ──────────────────────────────────────────────────────

/**
 * 從 close 陣列取第 pLow / pHigh 百分位，作為開倉區間的上下天花板。
 * 確保開倉不超過歷史上價格真正待過的範圍。
 */
function calculatePercentileRange(
    closes: number[],
    pLow = 5,
    pHigh = 95,
): { p5: number; p95: number } {
    if (closes.length === 0) return { p5: 0, p95: Infinity };
    const sorted = [...closes].sort((a, b) => a - b);
    const n = sorted.length;
    return {
        p5:  sorted[Math.floor(n * pLow  / 100)],
        p95: sorted[Math.floor(n * pHigh / 100)],
    };
}

// ─── Continuous Regime Vector ─────────────────────────────────────────────────

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

/**
 * 計算 continuous regime vector（sigmoid + softmax）。
 * 結果為三分量機率向量：range + trend + neutral = 1。
 */
export function computeRegimeVector(candles: HourlyReturn[], genome: RegimeGenome): RegimeVector {
    const chop = calculateCHOP(candles, genome.chopWindow);
    const hurst = calculateHurst(candles.map(c => c.r), genome.hurstMaxLag);
    const T = genome.sigmoidTemp;

    // 計算各維度的原始分數（以閾值為基準的有符號距離之和）
    //   range  = CHOP 高於 chopRangeThreshold + Hurst 低於 hurstRangeThreshold
    //   trend  = CHOP 低於 chopTrendThreshold + Hurst 高於 hurstTrendThreshold
    //   neutral = 固定基準 0（中立狀態）
    //
    // 使用整體 CHOP 範圍 [0,100] 和 Hurst 範圍 [0,1] 正規化，
    // 確保分數在 [-2, 2] 之間，與閾值參數的隨機搜索空間無關。
    const rangeScore = (chop - genome.chopRangeThreshold) / 100
                     + (genome.hurstRangeThreshold - hurst) / 1;

    const trendScore = (genome.chopTrendThreshold - chop) / 100
                     + (hurst - genome.hurstTrendThreshold) / 1;

    const neutralScore = 0.0;

    // Softmax with temperature（T→0 one-hot，T→∞ 均勻分佈），減 max 防溢位
    const maxScore = Math.max(rangeScore, trendScore, neutralScore);
    const er = Math.exp((rangeScore   - maxScore) / T);
    const et = Math.exp((trendScore   - maxScore) / T);
    const en = Math.exp((neutralScore - maxScore) / T);
    const sum = er + et + en;

    return {
        range:   er / sum,
        trend:   et / sum,
        neutral: en / sum,
    };
}

/** 歷史數據分段標記結構 */
export interface RegimeSegment {
    regime: 'range' | 'trend' | 'neutral';
    returns: number[];
}

/**
 * 用硬分類器對歷史數據打標，產生 regime-segmented 抽樣池。
 * < 50 samples 的 segment 併入 neutral。
 */
export function segmentByRegime(candles: HourlyReturn[], windowSize = 168): RegimeSegment[] {
    if (candles.length < windowSize) {
        return [{ regime: 'neutral', returns: candles.map(c => c.r) }];
    }

    const buckets: Record<'range' | 'trend' | 'neutral', number[]> = {
        range: [],
        trend: [],
        neutral: [],
    };

    for (let i = 0; i < candles.length; i++) {
        const start = Math.max(0, i - windowSize + 1);
        const window = candles.slice(start, i + 1);
        if (window.length < 14) {
            buckets.neutral.push(candles[i].r);
        } else {
            const regime = analyzeRegime(window);
            buckets[regime.signal].push(candles[i].r);
        }
    }

    // < 50 samples 的併入 neutral
    const segments: RegimeSegment[] = [];
    for (const regime of ['range', 'trend'] as const) {
        if (buckets[regime].length >= 50) {
            segments.push({ regime, returns: buckets[regime] });
        } else if (buckets[regime].length > 0) {
            buckets.neutral.push(...buckets[regime]);
        }
    }

    if (buckets.neutral.length > 0) {
        segments.push({ regime: 'neutral', returns: buckets.neutral });
    }

    return segments.length > 0 ? segments : [{ regime: 'neutral', returns: candles.map(c => c.r) }];
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * 分析市場狀態：計算 CHOP + Hurst，回傳 signal。
 *
 * signal 判斷規則（保守版，優先保護資金）：
 *   'range'  = CHOP > 55 且 Hurst < 0.52（雙重確認震盪才開倉）
 *   'trend'  = CHOP < 45 或  Hurst > 0.65（任一觸發趨勢警告）
 *   'neutral'= 其餘
 */
export function analyzeRegime(candles: HourlyReturn[], genome?: RegimeGenome): MarketRegime {
    const chopWindow = genome?.chopWindow ?? 14;
    const hurstMaxLag = genome?.hurstMaxLag ?? 20;
    const atrWindow = genome?.atrWindow ?? 14;
    const chopRangeThreshold = genome?.chopRangeThreshold ?? 55;
    const chopTrendThreshold = genome?.chopTrendThreshold ?? 45;
    const hurstRangeThreshold = genome?.hurstRangeThreshold ?? 0.52;
    const hurstTrendThreshold = genome?.hurstTrendThreshold ?? 0.65;

    const returns = candles.map(c => c.r);
    const chop  = calculateCHOP(candles, chopWindow);
    const hurst = calculateHurst(returns, hurstMaxLag);
    const atr   = calculateATR(candles, atrWindow);

    let signal: MarketRegime['signal'];
    if (chop > chopRangeThreshold && hurst < hurstRangeThreshold) {
        signal = 'range';
    } else if (chop < chopTrendThreshold || hurst > hurstTrendThreshold) {
        signal = 'trend';
    } else {
        signal = 'neutral';
    }

    return { chop, hurst, atr, signal };
}

/**
 * 產生三軌驗證的邊界參數（Track 2 + Track 3）。
 * 由 mcEngine 呼叫後傳入 calcCandidateRanges。
 */
export function computeRangeGuards(candles: HourlyReturn[], genome?: RegimeGenome): RangeGuards {
    const atrWindow = genome?.atrWindow ?? 14;
    const atrHalfWidth = calculateATR(candles, atrWindow);
    const closes       = candles.map(c => c.close);
    const { p5, p95 }  = calculatePercentileRange(closes);
    return { atrHalfWidth, p5, p95 };
}
