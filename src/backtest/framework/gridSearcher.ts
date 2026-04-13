/**
 * Grid search 模組 — coarse grid → top-N 篩選 → fine grid 鄰域展開
 *
 * 對應 plan：`.claude/plans/p0-backtest-verification.md` lines 567-580
 *
 * 純函數，無 I/O、無 async、無全域狀態。
 * 接受 duck-typed driver（`IReplayDriver` interface）以支援 mock 測試。
 *
 * @module
 */

import type {
    ReplayFeature,
    ThresholdSet,
    GridSpace,
    PositionOutcome,
} from '../../types/replay';
import type { AggregatedMetrics } from './outcomeAggregator';
import { aggregateOutcomes } from './outcomeAggregator';

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * Replay driver 最小介面（duck-typing，方便 mock）。
 *
 * 實作：`V3LpReplayDriver`
 * 測試：`MockReplayDriver`
 */
export interface IReplayDriver {
    tvlMultiplier: number;
    setTvlMultiplier(m: number): void;
    run(threshold: ThresholdSet, mode: 'raw' | 'full-state'): PositionOutcome[];
}

/** 單次 sweep（一組 threshold + 聚合後指標） */
export interface SweepResult {
    threshold: ThresholdSet;
    metrics: AggregatedMetrics;
}

// ─── Fine grid 鄰域步長 ─────────────────────────────────────────────────────

/** sharpeOpen / sharpeClose 的 fine grid 步長 */
const FINE_STEP_SHARPE = 0.05;

/** atrMultiplier 的 fine grid 步長 */
const FINE_STEP_ATR = 0.25;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 粗掃 grid search：遍歷 space 中所有 threshold 組合，以 driver.run('raw') 產出
 * outcomes 再聚合成 AggregatedMetrics。
 *
 * @param features replay 特徵序列（傳給 driver — 但 driver 已持有，此處保留以便未來擴展）
 * @param driver   replay 驅動器（duck-typed）
 * @param space    search space（每軸離散候選值）
 * @returns 所有 threshold 組合的 SweepResult[]
 */
export function runCoarseGrid(
    features: ReplayFeature[],
    driver: IReplayDriver,
    space: GridSpace,
): SweepResult[] {
    const results: SweepResult[] = [];

    for (const sharpeOpen of space.sharpeOpen) {
        for (const sharpeClose of space.sharpeClose) {
            for (const atrMultiplier of space.atrMultiplier) {
                const threshold: ThresholdSet = { sharpeOpen, sharpeClose, atrMultiplier };
                const outcomes = driver.run(threshold, 'raw');
                const metrics = aggregateOutcomes(outcomes);
                results.push({ threshold, metrics });
            }
        }
    }

    return results;
}

/**
 * 從 SweepResult[] 中篩選通過 absolute floor 的結果，
 * 按 weightedRaw 降序排序後取 top-N 的 ThresholdSet[]。
 *
 * 若沒有任何結果通過 floor，回傳空陣列（不 throw）。
 *
 * @param results sweep 結果
 * @param topN    取前 N 名
 * @returns 通過 floor 且排序後的 top-N ThresholdSet[]
 */
export function selectTopCandidates(
    results: SweepResult[],
    topN: number,
): ThresholdSet[] {
    const passing = results
        .filter(r => r.metrics.passesAbsoluteFloor)
        .sort((a, b) => b.metrics.weightedRaw - a.metrics.weightedRaw);

    return passing.slice(0, topN).map(r => r.threshold);
}

/**
 * 細掃 grid search：對每個 top candidate 展開 ±1 格鄰域（3^3 = 27），
 * 去重後以 driver.run('full-state') 產出 outcomes。
 *
 * 步長：sharpeOpen ±0.05、sharpeClose ±0.05、atrMultiplier ±0.25。
 *
 * @param features replay 特徵序列
 * @param driver   replay 驅動器
 * @param topCandidates 粗掃後篩出的 top-N ThresholdSet[]
 * @returns 去重後的 SweepResult[]
 */
export function runFineGrid(
    features: ReplayFeature[],
    driver: IReplayDriver,
    topCandidates: ThresholdSet[],
): SweepResult[] {
    const seen = new Set<string>();
    const results: SweepResult[] = [];

    for (const candidate of topCandidates) {
        const neighbors = expandNeighborhood(candidate);

        for (const threshold of neighbors) {
            const key = thresholdKey(threshold);
            if (seen.has(key)) continue;
            seen.add(key);

            const outcomes = driver.run(threshold, 'full-state');
            const metrics = aggregateOutcomes(outcomes);
            results.push({ threshold, metrics });
        }
    }

    return results;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * 將 ThresholdSet 轉為字串 key（用於去重）。
 * 使用 toFixed(4) 避免浮點精度問題。
 */
function thresholdKey(t: ThresholdSet): string {
    return `${t.sharpeOpen.toFixed(4)}|${t.sharpeClose.toFixed(4)}|${t.atrMultiplier.toFixed(4)}`;
}

/**
 * 展開鄰域：每軸 {-1, 0, +1} 格，共 3^3 = 27 組（含自身）。
 */
function expandNeighborhood(center: ThresholdSet): ThresholdSet[] {
    const offsets = [-1, 0, 1];
    const neighbors: ThresholdSet[] = [];

    for (const dOpen of offsets) {
        for (const dClose of offsets) {
            for (const dAtr of offsets) {
                neighbors.push({
                    sharpeOpen: round4(center.sharpeOpen + dOpen * FINE_STEP_SHARPE),
                    sharpeClose: round4(center.sharpeClose + dClose * FINE_STEP_SHARPE),
                    atrMultiplier: round4(center.atrMultiplier + dAtr * FINE_STEP_ATR),
                });
            }
        }
    }

    return neighbors;
}

/** 四捨五入到小數 4 位，避免浮點累積 */
function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}
