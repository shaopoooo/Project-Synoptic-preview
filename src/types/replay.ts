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

    /**
     * 當根 close 在 normFactor 空間（close / mean(window closes)）的座標。
     *
     * - 有足夠歷史窗口時：`close / normFactor`，跟 `PaNorm` / `PbNorm` 同空間
     * - 歷史不足（cycleIdx < MC_WINDOW_HOURS）或 normFactor 退化時：`null`
     *
     * **為什麼可為 null**：避免跟「真實 close 剛好等於歷史均值 → 1.0」的
     * 合法輸出混淆。下游 (replayDriver / outcomeCalculator) 看到 null 必須
     * 跳過 PositionAdvisor 呼叫（歷史不足無法做有意義的決策）。
     */
    currentPriceNorm: number | null;
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
    /** Unix seconds — 開倉時的 replay cycle 時間戳（對齊 `ReplayFeature.ts`） */
    openedAtTs: number;
    openPriceNorm: number;
    PaNorm: number;
    PbNorm: number;
    initialCapital: number;
    feesAccumulated: number;
    /**
     * **Unix milliseconds**（不是 seconds！），對齊 `positionAdvisor.shouldClose`
     * 的 grandfathered 契約（`Date.now() - outOfRangeSinceMs > 4h in ms`）。
     *
     * 本 interface 其他時間欄位（`openedAtTs`、`closedAtTs`）是 unix seconds，
     * 這個欄位**刻意用 ms**以免 replayDriver 呼叫 `shouldClose` 時每次都要轉換。
     * replayDriver 在讀取 `ReplayFeature.ts`（seconds）時要 `ts * 1000` 才能寫入此欄位。
     */
    outOfRangeSinceMs: number | null;
    closedAtCycle: number | null;
    /** Unix seconds — 關倉時的 replay cycle 時間戳 */
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
