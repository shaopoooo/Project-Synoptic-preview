/**
 * Sensitivity runner — 對不同 TVL multiplier 跑 grid search，
 * 檢驗最佳 threshold 組合的穩健性。
 *
 * 對應 plan：`.claude/plans/p0-backtest-verification.md` lines 608-619
 *
 * 純函數（除了 driver.setTvlMultiplier 的 mutation），無 I/O、無 async。
 *
 * @module
 */

import type { ReplayFeature, ThresholdSet, GridSpace } from '../../types/replay';
import type { IReplayDriver } from './gridSearcher';
import { runCoarseGrid, selectTopCandidates } from './gridSearcher';

// ─── 常數 ─────────────────────────────────────────────────────────────────

/** 敏感度分析使用的 TVL 乘數組合 */
const TVL_MULTIPLIERS: readonly number[] = [0.5, 1.0, 2.0];

/** 每次 grid search 取 top-N 作為穩健性比較基準 */
const TOP_N = 3;

// ─── Interface ───────────────────────────────────────────────────────────────

/** 單次 TVL 情境的結果 */
export interface SensitivityResult {
    tvlMultiplier: number;
    topThresholds: ThresholdSet[];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 對 TVL multiplier ∈ {0.5, 1.0, 2.0} 各跑一次 coarse grid search，
 * 取 top-3 thresholds，比較三次結果是否一致（isRobust）。
 *
 * @param features replay 特徵序列
 * @param driver   replay 驅動器（會透過 setTvlMultiplier 切換情境）
 * @param space    search space
 * @returns results（三個 SensitivityResult）+ isRobust（top-3 是否一致）
 */
export function runSensitivity(
    features: ReplayFeature[],
    driver: IReplayDriver,
    space: GridSpace,
): {
    results: SensitivityResult[];
    isRobust: boolean;
} {
    const results: SensitivityResult[] = [];

    for (const multiplier of TVL_MULTIPLIERS) {
        driver.setTvlMultiplier(multiplier);
        const sweepResults = runCoarseGrid(features, driver, space);
        const topThresholds = selectTopCandidates(sweepResults, TOP_N);
        results.push({ tvlMultiplier: multiplier, topThresholds });
    }

    const isRobust = checkRobustness(results);

    return { results, isRobust };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * 檢查所有情境的 top-N thresholds 是否完全一致。
 *
 * 比較方式：將每組 ThresholdSet[] 序列化後比較字串。
 * 空 topThresholds（全部不通過 floor）視為不一致。
 */
function checkRobustness(results: SensitivityResult[]): boolean {
    if (results.length === 0) return false;

    const serialized = results.map(r => serializeThresholds(r.topThresholds));

    // 所有情境的序列化結果必須相同
    const first = serialized[0];
    if (first === '[]') return false; // 空結果不算 robust

    return serialized.every(s => s === first);
}

/**
 * 將 ThresholdSet[] 序列化為可比較的字串。
 * 先排序確保順序無關。
 */
function serializeThresholds(thresholds: ThresholdSet[]): string {
    const sorted = [...thresholds].sort((a, b) => {
        if (a.sharpeOpen !== b.sharpeOpen) return a.sharpeOpen - b.sharpeOpen;
        if (a.sharpeClose !== b.sharpeClose) return a.sharpeClose - b.sharpeClose;
        return a.atrMultiplier - b.atrMultiplier;
    });

    return JSON.stringify(sorted.map(t => ({
        o: t.sharpeOpen.toFixed(4),
        c: t.sharpeClose.toFixed(4),
        a: t.atrMultiplier.toFixed(4),
    })));
}
