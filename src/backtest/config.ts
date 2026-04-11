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

/**
 * MC simulation 歷史窗口大小（hours of historical data）。
 *
 * 對齊 prod `runMCEngine`：每次 cycle 用最近 720 根 1H K 線當 Bootstrap 母體。
 * 若 cycleIdx < MC_WINDOW_HOURS，featureExtractor 直接輸出 null mc/regime/norm 欄位。
 */
export const MC_WINDOW_HOURS = 720;

/** Monte Carlo 每次模擬的 path 數（對齊 prod `config.MC_NUM_PATHS`） */
export const MC_NUM_PATHS = 10_000;

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
