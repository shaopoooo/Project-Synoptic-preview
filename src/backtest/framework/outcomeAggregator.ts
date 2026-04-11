/**
 * Outcome aggregator — 將一批 hypothetical position 的結算結果壓成三指標（A/C/D）
 * 與加權總分，供 grid search 比較 threshold 組合。
 *
 * 對應 plan：`.claude/plans/p0-backtest-verification.md`
 *   - Stage 1 Group A task 5
 *   - Eng brainstorming Decision 5（權重 0.4 / 0.3 / 0.3）
 *   - 絕對底線：A > 0 && D > 0 && C ≥ 0.5
 *
 * 指標定義（plan lines 720-722）：
 * - A = mean(outperformancePct)   ← 每筆倉位相對 HODL 的 outperformance 算術平均
 * - C = mean(hitRate)             ← 每筆倉位的達標率算術平均
 * - D = sum(lpNetProfit)          ← 所有倉位的 LP 淨利「總和」（不是平均），
 *                                   因為 D 是 absolute 金額指標，能反映部位規模差異。
 *
 * Weighted score：
 * - 本層只算 `0.4 * A + 0.3 * C + 0.3 * D`，**未正規化**。
 * - 原因：單筆 sweep 結果沒有比較基準無法做 min-max normalize。真正的正規化
 *   會在 gridSearcher 拿到整個 grid 的所有 AggregatedMetrics 之後才做。
 * - 本層提供的 weighted 只是便利欄位，gridSearcher 可選擇重新計算。
 *
 * Empty outcomes：回傳全 0 + `passesAbsoluteFloor=false`，避免 NaN 汙染下游。
 *
 * 這是純函數（pure function），無任何 I/O、async、全域狀態。
 */

import type { PositionOutcome } from '../../types/replay';

export interface AggregatedMetrics {
    /** mean(outperformancePct)；比率形式，例如 0.05 = +5% */
    A: number;
    /** mean(hitRate)；[0, 1] */
    C: number;
    /** sum(lpNetProfit)；USD 絕對金額 */
    D: number;
    /** 0.4*A + 0.3*C + 0.3*D；unnormalized，normalization 交給 gridSearcher */
    weighted: number;
    /** 絕對底線：A > 0 && D > 0 && C >= 0.5 */
    passesAbsoluteFloor: boolean;
}

const W_A = 0.4;
const W_C = 0.3;
const W_D = 0.3;

export function aggregateOutcomes(outcomes: PositionOutcome[]): AggregatedMetrics {
    if (outcomes.length === 0) {
        return { A: 0, C: 0, D: 0, weighted: 0, passesAbsoluteFloor: false };
    }

    let sumOutperformance = 0;
    let sumHitRate = 0;
    let sumLpNetProfit = 0;

    for (const o of outcomes) {
        sumOutperformance += o.outperformancePct;
        sumHitRate += o.hitRate;
        sumLpNetProfit += o.lpNetProfit;
    }

    const n = outcomes.length;
    const A = sumOutperformance / n;
    const C = sumHitRate / n;
    const D = sumLpNetProfit; // sum, not mean
    const weighted = W_A * A + W_C * C + W_D * D;
    const passesAbsoluteFloor = A > 0 && D > 0 && C >= 0.5;

    return { A, C, D, weighted, passesAbsoluteFloor };
}
