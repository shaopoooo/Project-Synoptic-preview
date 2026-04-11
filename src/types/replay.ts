/**
 * Replay 型別定義（Stage 1 / PR 4 offline backtest harness 專用）
 *
 * 本檔案僅宣告 type，無任何 runtime 邏輯。對應 plan：
 *   `.claude/plans/p0-backtest-verification.md`（Interfaces 段）
 *
 * 使用範圍：
 * - `src/backtest/framework/*`：walk-forward split、outcome aggregator、grid search
 * - `src/backtest/replay/*`：feature extractor、decision sweep、threshold 驗證
 *
 * 與 `src/types/index.ts` 的既有 `RegimeVector` 共用；不 re-export。
 */

import type { RegimeVector } from './index';

/**
 * Stage 1 用：從 OHLCV replay 產出的 per-pool per-cycle 特徵。
 * 對應 plan Decisions：feature extractor 固定 seed = cycleIdx，確保可重現。
 */
export interface ReplayFeature {
    poolId: string;
    poolLabel: string;
    ts: number;                  // unix seconds
    cycleIdx: number;            // 從 0 開始

    // mcEngine 產出（固定 seed = cycleIdx）
    mcScore: number | null;
    mcMean: number | null;
    mcStd: number | null;
    mcCvar95: number | null;

    // regime engine 產出
    regime: RegimeVector | null;

    // 範圍候選
    PaNorm: number | null;
    PbNorm: number | null;
    atrHalfWidth: number | null;

    // 當下市場狀態
    currentPriceNorm: number;
    candleVolume: number;
    poolTvlProxy: number;
    poolFeeTier: number;
}

/**
 * Decision sweep 時用：hypothetical position 的生命週期追蹤。
 * 不對應鏈上真實倉位，只是 replay harness 內部記帳。
 */
export interface HypotheticalPosition {
    positionId: string;          // `${poolId}:${openTs}`
    poolId: string;
    openedAtCycle: number;
    openedAtTs: number;
    openPriceNorm: number;
    PaNorm: number;
    PbNorm: number;
    initialCapital: number;
    feesAccumulated: number;
    outOfRangeSinceMs: number | null;
    closedAtCycle: number | null;
    closedAtTs: number | null;
    closeReason:
        | 'trend_shift'
        | 'il_threshold'
        | 'opportunity_lost'
        | 'timeout'
        | 'hard_cap_7d'
        | null;
}

/**
 * A / C / D 三指標的結算結果（單筆 hypothetical position）。
 * A = 相對 HODL 的 outperformance（比率）
 * C = hit rate（expected vs actual 的達標率）
 * D = LP 淨利（費收 − IL − gas，USD）
 */
export interface PositionOutcome {
    position: HypotheticalPosition;
    durationHours: number;
    expectedReturnPct: number;   // 開倉時 mcEngine 的 expected return

    // A 指標
    lpFinalValue: number;
    hodlFinalValue: number;
    outperformancePct: number;

    // C 指標
    hitRate: number;

    // D 指標
    feeIncome: number;
    impermanentLoss: number;
    gasCost: number;
    lpNetProfit: number;
}

/**
 * Threshold 三軸組合（grid search 掃描單位）。
 * 對應 PositionAdvisor 的 sharpeOpen / sharpeClose / atrMultiplier。
 */
export interface ThresholdSet {
    sharpeOpen: number;
    sharpeClose: number;
    atrMultiplier: number;
}

/**
 * Grid search 的 search space；每軸為離散候選值。
 * readonly tuple 方便編譯期 immutable guarantee。
 */
export interface GridSpace {
    sharpeOpen: readonly number[];
    sharpeClose: readonly number[];
    atrMultiplier: readonly number[];
}
