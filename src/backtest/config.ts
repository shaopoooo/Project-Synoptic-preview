/**
 * Backtest-specific configuration constants（Stage 1 / PR 4）。
 *
 * 這些值由 `.claude/plans/p0-backtest-verification.md` 的 Decisions 段落
 * 與 Gap D / E 決定而來。部分值為經驗值 placeholder，PR 4 Task 19
 * 實際執行 `backtest:verify-thresholds` 時由使用者 hand-tune。
 *
 * 本檔案為純 constants module，無任何 runtime 邏輯、無 I/O。
 */

import type { RegimeGenome } from '../types';
import type { GridSpace } from '../types/replay';

/**
 * MC simulation 歷史窗口大小（hours of historical data）。
 *
 * 對齊 prod `runMCEngine`：每次 cycle 用最近 720 根 1H K 線當 Bootstrap 母體。
 * 若 cycleIdx < MC_WINDOW_HOURS，featureExtractor 直接輸出 null mc/regime/norm 欄位。
 */
export const MC_WINDOW_HOURS = 720;

/**
 * Monte Carlo path 數 — backtest 專用，降至 1,000 節省 10× 運算量。
 *
 * Prod 使用 10,000 paths（`config.MC_NUM_PATHS`），但 backtest threshold selection
 * 不需要那麼高精度：
 * - grid search 比較的是 threshold 組合間的**相對排序**，不是絕對 score
 * - sensitivity analysis × 3 runs 已 catch 隨機噪音
 * - 1,000 paths 的 score 估算 standard error ≈ σ/√1000，足夠 ranking
 *
 * 若 Task 19 執行後發現 ranking 不穩定，提高至 2,000-3,000 即可。
 */
export const MC_NUM_PATHS = 1_000;

/** Simulation horizon（天數；MC engine 內部會乘 24 轉小時步進） */
export const MC_HORIZON_DAYS = 14;

/**
 * TVL proxy（USD）用於 fee income 公式，當 pool TVL 無法從 OHLCV 觀察時使用。
 *
 * 目前所有池子統一用 $1M 作為 placeholder（Gap D decision，controller 授權）。
 * 真實 per-pool TVL 將於 Task 19 執行 `backtest:verify-thresholds` 後補上。
 *
 * TODO(tasks.md 雜項)：Task 19 跑完後補真實 per-pool POOL_TVL_PROXY 覆蓋此 default。
 */
export const POOL_TVL_PROXY_DEFAULT = 1_000_000;

/**
 * featureExtractor 呼叫 `computeRegimeVector` 時使用的 baseline genome。
 * 值對齊 `MarketRegimeAnalyzer.analyzeRegime` 的 optional genome 預設值，
 * 確保 backtest 與 prod neutral baseline 行為一致。
 */
export const DEFAULT_REGIME_GENOME: RegimeGenome = {
    id: 'backtest-baseline',
    chopRangeThreshold: 55,
    chopTrendThreshold: 45,
    chopWindow: 14,
    hurstRangeThreshold: 0.52,
    hurstTrendThreshold: 0.65,
    hurstMaxLag: 20,
    sigmoidTemp: 1.0,
    atrWindow: 14,
    cvarSafetyFactor: 1.5,
};

/**
 * Hypothetical position 開倉資金（token0 單位）。
 * 對齊 legacy BacktestEngine 的 INITIAL_CAPITAL = 10000，方便 A 指標比對直覺。
 */
export const INITIAL_CAPITAL = 10_000;

// ─── Temporal split boundaries（plan Decision #16，硬編碼） ──────────────────

/** Train window 起始（Unix seconds）— 2025-11-10T00:00:00Z */
export const TRAIN_START_TS = Math.floor(new Date('2025-11-10T00:00:00Z').getTime() / 1000);

/** Train window 結束 / Val window 起始（Unix seconds）— 2026-01-22T00:00:00Z */
export const VAL_START_TS = Math.floor(new Date('2026-01-22T00:00:00Z').getTime() / 1000);

/** Val window 結束 / Test window 起始（Unix seconds）— 2026-03-01T00:00:00Z */
export const TEST_START_TS = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);

/** Test window 結束（Unix seconds）— 2026-04-10T00:00:00Z */
export const TEST_END_TS = Math.floor(new Date('2026-04-10T00:00:00Z').getTime() / 1000);

// ─── Grid search space（plan Decisions #12-14） ──────────────────────────────

/**
 * 粗 grid：6 × 5 × 4 = 120 組合。
 *
 * sharpeClose 從原 plan 的 {0.20, 0.30, 0.40} 擴展至 {0.05, 0.10, 0.15, 0.20, 0.30}，
 * 原因：Task 19 首次跑發現 sharpeClose ≥ 0.2 時所有組合都因 opportunity_lost churn
 * 而 FAIL（倉位平均只撐 2-9 小時就被關掉，累積不了足夠 fees）。
 * MC score 小時級自然波動大，sharpeClose 需要降到 0.05-0.15 讓倉位有足夠存活時間。
 * 0.40 移除（過高，無診斷價值）。
 */
export const COARSE_GRID: GridSpace = {
    sharpeOpen: [0.30, 0.40, 0.50, 0.60, 0.70, 0.80],
    sharpeClose: [0.05, 0.10, 0.15, 0.20, 0.30],
    atrMultiplier: [1.5, 2.0, 2.5, 3.0],
};

/** 細 grid top-N 候選數（進 fine grid 鄰域展開） */
export const FINE_GRID_TOP_N = 5;

/** Gas cost per rebalance on Base (~$0.5) */
export const GAS_COST_USD = 0.5;
