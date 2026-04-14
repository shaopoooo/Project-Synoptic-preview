/**
 * outcomeCalculator — V3 LP 結果計算器（A / C / D 三指標）
 *
 * 給定一筆 hypothetical position 與其生命週期內的 ReplayFeature[]，
 * 計算三個核心指標：
 *
 * - **A 指標（outperformance）**：`(LP final value - HODL final value) / HODL final value`
 *   衡量相對於 50/50 HODL 的超額報酬率。
 *
 * - **C 指標（hit rate）**：`sum(in-range hours) / lifetime hours`
 *   衡量價格落在 [Pa, Pb] 區間內的比率（僅計算 currentPriceNorm !== null 的 cycle）。
 *
 * - **D 指標（LP 淨利）**：`feeIncome - IL - gasCost`
 *   絕對值衡量，fee 收入扣除 impermanent loss 與 gas 成本。
 *
 * ## 公式推導
 *
 * ### Fee Income
 * ```
 * hourlyFee_i = candleVolume_i × poolFeeTier_i × (initialCapital / (poolTvlProxy_i × tvlMultiplier))
 * feeIncome   = Σ hourlyFee_i × inRange_i
 * ```
 * 其中 `inRange_i = 1` 當 `currentPriceNorm_i ∈ [PaNorm, PbNorm]`，否則 0。
 *
 * ### Impermanent Loss（V3 concentrated liquidity）
 * ```
 * L              = computeL(capital, openPriceNorm, PaNorm, PbNorm)
 * lpValueAtClose = computeLpValueToken0(L, closePriceNorm, PaNorm, PbNorm)
 * IL             = capital - lpValueAtClose   （正值代表損失）
 * ```
 * 使用 PositionCalculator 的 `computeL` 與 `computeLpValueToken0` 純函數。
 *
 * ### HODL Counterfactual（50/50 split）
 * ```
 * hodlFinalValue = capital × (openPriceNorm + closePriceNorm) / (2 × openPriceNorm)
 * ```
 * 假設開倉時 50% token0 + 50% token1，再用 close price 重新計價。
 *
 * @module
 */

import type { HypotheticalPosition, ReplayFeature, PositionOutcome } from '../../types/replay';
import { computeL, computeLpValueToken0 } from '../../engine/lp/PositionCalculator';

/**
 * 計算單筆 hypothetical position 的 A / C / D 三指標結算。
 *
 * @param position           假設倉位（含 open/close 參數、range boundary）
 * @param featuresInLifecycle 倉位生命週期內的 per-cycle 特徵序列
 * @param tvlMultiplier      TVL 乘數（用於 fee 計算的 pool TVL 調整）
 * @returns PositionOutcome  結算結果
 */
export function computeOutcome(
    position: HypotheticalPosition,
    featuresInLifecycle: ReplayFeature[],
    tvlMultiplier: number,
): PositionOutcome {
    const { openPriceNorm, PaNorm, PbNorm, initialCapital } = position;

    // ── Close price：取最後一筆有效 currentPriceNorm ──────────────────────────
    const lastFeatureWithPrice = findLastFeatureWithPrice(featuresInLifecycle);
    const closePriceNorm = lastFeatureWithPrice?.currentPriceNorm ?? openPriceNorm;

    // ── C 指標：hit rate ─────────────────────────────────────────────────────
    const { inRangeCount, validCount } = countInRange(featuresInLifecycle, PaNorm, PbNorm);
    const hitRate = validCount > 0 ? inRangeCount / validCount : 0;

    // ── Fee Income ───────────────────────────────────────────────────────────
    const feeIncome = computeFeeIncome(
        featuresInLifecycle,
        PaNorm,
        PbNorm,
        initialCapital,
        tvlMultiplier,
    );

    // ── IL（V3 concentrated liquidity formula）────────────────────────────────
    const L = computeL(initialCapital, openPriceNorm, PaNorm, PbNorm);
    const lpValueAtClose = computeLpValueToken0(L, closePriceNorm, PaNorm, PbNorm);
    const impermanentLoss = initialCapital - lpValueAtClose;

    // ── LP final value & HODL ────────────────────────────────────────────────
    const lpFinalValue = lpValueAtClose + feeIncome;

    // HODL: 50/50 split at open, revalue at close
    const hodlFinalValue =
        initialCapital * (openPriceNorm + closePriceNorm) / (2 * openPriceNorm);

    // ── A 指標：outperformance ───────────────────────────────────────────────
    const outperformancePct = hodlFinalValue !== 0
        ? (lpFinalValue - hodlFinalValue) / hodlFinalValue
        : 0;

    // ── D 指標：LP net profit ────────────────────────────────────────────────
    const gasCost = 0; // gas 由 replayDriver 在 position 層追蹤，此處為 0
    const lpNetProfit = feeIncome - impermanentLoss - gasCost;

    // ── Duration ─────────────────────────────────────────────────────────────
    const durationHours = featuresInLifecycle.length;

    // ── Expected return（開倉時 mcEngine 的 expected return）─────────────────
    const openFeature = featuresInLifecycle[0];
    const expectedReturnPct = openFeature?.mcMean ?? 0;

    return {
        position,
        durationHours,
        expectedReturnPct,
        lpFinalValue,
        hodlFinalValue,
        outperformancePct,
        hitRate,
        feeIncome,
        impermanentLoss,
        gasCost,
        lpNetProfit,
    };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * 找到最後一筆 currentPriceNorm !== null 的 feature。
 */
function findLastFeatureWithPrice(
    features: readonly ReplayFeature[],
): ReplayFeature | undefined {
    for (let i = features.length - 1; i >= 0; i--) {
        if (features[i].currentPriceNorm !== null) {
            return features[i];
        }
    }
    return undefined;
}

/**
 * 計算 in-range 與 valid（有價格）的 cycle 數量。
 */
function countInRange(
    features: readonly ReplayFeature[],
    PaNorm: number,
    PbNorm: number,
): { inRangeCount: number; validCount: number } {
    let inRangeCount = 0;
    let validCount = 0;

    for (const f of features) {
        if (f.currentPriceNorm === null) continue;
        validCount++;
        if (f.currentPriceNorm >= PaNorm && f.currentPriceNorm <= PbNorm) {
            inRangeCount++;
        }
    }

    return { inRangeCount, validCount };
}

/**
 * 計算累計 fee income（僅 in-range cycle 貢獻）。
 *
 * ```
 * hourlyFee = candleVolume × poolFeeTier × (initialCapital / (poolTvlProxy × tvlMultiplier))
 * ```
 */
function computeFeeIncome(
    features: readonly ReplayFeature[],
    PaNorm: number,
    PbNorm: number,
    initialCapital: number,
    tvlMultiplier: number,
): number {
    let total = 0;

    for (const f of features) {
        if (f.currentPriceNorm === null) continue;
        if (f.currentPriceNorm < PaNorm || f.currentPriceNorm > PbNorm) continue;

        const denominator = f.poolTvlProxy * tvlMultiplier;
        if (denominator <= 0) continue;

        const hourlyFee = f.candleVolume * f.poolFeeTier * (initialCapital / denominator);
        total += hourlyFee;
    }

    return total;
}
