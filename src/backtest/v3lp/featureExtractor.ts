/**
 * featureExtractor — 從 OHLCV replay 產出 per-pool per-cycle ReplayFeature[]。
 *
 * Stage 1 / PR 4 / Batch 2 — 對應 `.claude/plans/p0-backtest-verification.md`
 * Stage 1 Group B tasks 6-7。
 *
 * # 設計約束（Phase 0 / Phase 1 分離）
 *
 * 本模組為 **pure sync function**：無 I/O、無 async、無 await、無 fs、無網路。
 * 輸入為已解析的 `OhlcvStore[]`，輸出為 `ReplayFeature[]`。
 *
 * # Plan deviation（controller 授權，2026-04-12）
 *
 * Plan 原始簽名為：
 *   `extractFeatures(ohlcvFiles: string[]): Promise<ReplayFeature[]>`
 * 本實作改為：
 *   `extractFeatures(stores: OhlcvStore[]): ReplayFeature[]`
 *
 * 理由：
 * - 對齊 `.claude/rules/pipeline.md` Phase 0 / Phase 1 嚴格分離原則
 * - 避免測試需要 mock fs，大幅簡化 fixture 組裝
 * - 檔案讀取層（Batch 6 `runVerifyThresholds.ts` entry script）保留在
 *   「runner / entry script」邊界，featureExtractor 只負責純計算
 *
 * # 決定（Gap D / E / F / G）
 *
 * - Gap D（poolTvlProxy）：使用 `POOL_TVL_PROXY_DEFAULT = $1M` placeholder
 *   寫入每筆 feature。Task 19 跑過後由 tasks.md 雜項 follow-up 調真實值。
 * - Gap E（MC 歷史窗口）：`cycleIdx < MC_WINDOW_HOURS(720)` 直接 null 化 mc/regime/norm
 *   欄位，不呼叫 MC 引擎。有足夠歷史時取 `candles[cycleIdx - 720 .. cycleIdx - 1]`
 *   作為 Bootstrap 母體。
 * - Gap F（poolFeeTier）：從 `config.POOLS` 依 poolAddress 對應取得；若不在 POOLS
 *   （已淘汰或未啟用）fallback 至 0.003。
 * - Gap G（normFactor）：取 MC 歷史窗口內 close 的算術平均作為 normFactor，
 *   `currentPriceNorm = close / normFactor`，`PaNorm/PbNorm/atrHalfWidth` 同比尺度化。
 *   cycleIdx < 720 或 normFactor 退化時 `currentPriceNorm = null`（避免跟
 *   合法的「close == 歷史均值 → 1.0」輸出混淆，code review I2 修正）。
 */

import seedrandom from 'seedrandom';
import type { RawCandle, OhlcvStore } from '../../services/market/HistoricalDataService';
import type { ReplayFeature } from '../../types/replay';
import type { HourlyReturn, RegimeVector, Dex } from '../../types';
import { runMCSimulation } from '../../services/strategy/MonteCarloEngine';
import { computeRegimeVector, computeRangeGuards } from '../../services/strategy/MarketRegimeAnalyzer';
import { config } from '../../config';
import { createServiceLogger } from '../../utils/logger';
import {
    MC_WINDOW_HOURS,
    MC_NUM_PATHS,
    MC_HORIZON_DAYS,
    POOL_TVL_PROXY_DEFAULT,
    DEFAULT_REGIME_GENOME,
    INITIAL_CAPITAL,
} from '../config';

/**
 * Logger for per-pool progress reporting。
 *
 * extractFeatures 本質上是「計算性純函數」（deterministic output from same input），
 * 但因 backtest dev tool 需要 progress visibility，此處引入 logging side-effect。
 * 這不影響函數的計算正確性：相同輸入永遠產出相同 ReplayFeature[]。
 */
const log = createServiceLogger('FeatureExtractor');

// ─── pool config resolution ──────────────────────────────────────────────────

interface ResolvedPoolConfig {
    address: string;
    dex: Dex;
    fee: number;
}

/**
 * 從 `config.POOLS` 依 address 對應取得池子設定。
 * OHLCV 檔可能屬於歷史已淘汰池，此時 fallback 至 UniswapV3 / 0.003 fee。
 */
function resolvePoolConfig(address: string): ResolvedPoolConfig {
    const lower = address.toLowerCase();
    const match = config.POOLS.find(p => p.address.toLowerCase() === lower);
    if (match) {
        return { address: match.address, dex: match.dex, fee: match.fee };
    }
    return { address, dex: 'UniswapV3', fee: 0.003 };
}

/** 將 resolved pool config 轉成 ReplayFeature.poolLabel（簡短可讀形式）。 */
function formatPoolLabel(pc: ResolvedPoolConfig): string {
    return `${pc.dex} ${pc.address.slice(0, 6)}...${pc.address.slice(-4)}`;
}

// ─── candle → HourlyReturn 轉換 ──────────────────────────────────────────────

/**
 * 將 RawCandle[] 轉為 HourlyReturn[]，計算 log return `r = ln(close_i / close_{i-1})`。
 *
 * i = 0 的 r 設為 0（無前一根可參照）。非正 close（<= 0）會使 log 變成 -Infinity / NaN，
 * 此處刻意不攔截，交由後段的 regime engine NaN guard 處理。
 */
function toHourlyReturns(candles: RawCandle[]): HourlyReturn[] {
    const result: HourlyReturn[] = [];
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const prevClose = i === 0 ? c.close : candles[i - 1].close;
        const r = prevClose > 0 && c.close > 0 ? Math.log(c.close / prevClose) : 0;
        result.push({
            ts: c.ts,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            r,
        });
    }
    return result;
}

// ─── null-feature builder ────────────────────────────────────────────────────

/**
 * 早期 cycle（歷史不足）專用：mc / regime / norm 欄位全 null，只填 candle-level 欄位。
 */
function buildNullFeature(
    candle: RawCandle,
    cycleIdx: number,
    poolConfig: ResolvedPoolConfig,
    poolLabel: string,
): ReplayFeature {
    return {
        poolId: poolConfig.address,
        poolLabel,
        ts: candle.ts,
        cycleIdx,
        mcScore: null,
        mcMean: null,
        mcStd: null,
        mcCvar95: null,
        regime: null,
        PaNorm: null,
        PbNorm: null,
        atrHalfWidth: null,
        // 歷史不足 → null（非 1.0 fallback，避免與合法「close == 歷史均值」混淆）
        currentPriceNorm: null,
        candleVolume: candle.volume,
        poolTvlProxy: POOL_TVL_PROXY_DEFAULT,
        poolFeeTier: poolConfig.fee,
    };
}

// ─── regime engine 包裝 ──────────────────────────────────────────────────────

/**
 * 包裝 `computeRegimeVector` + NaN guard + try/catch。
 * 失敗（拋錯或任一維度 NaN / Infinity）時回傳 null，featureExtractor 會將 regime
 * 欄位寫成 null 但繼續處理其他 cycle。
 */
function safeComputeRegime(window: HourlyReturn[]): RegimeVector | null {
    try {
        const v = computeRegimeVector(window, DEFAULT_REGIME_GENOME);
        if (
            !Number.isFinite(v.range) ||
            !Number.isFinite(v.trend) ||
            !Number.isFinite(v.neutral)
        ) {
            return null;
        }
        return v;
    } catch {
        return null;
    }
}

// ─── 主 extractor ────────────────────────────────────────────────────────────

/**
 * 逐 pool × 逐 hour 產生 ReplayFeature[]。
 *
 * 每個 cycleIdx 都會產出一筆 feature：
 * - cycleIdx < MC_WINDOW_HOURS：buildNullFeature（歷史不足）
 * - 否則：
 *   1. 取 `returns[cycleIdx - 720 .. cycleIdx - 1]` 作為 MC / regime 窗口
 *   2. 固定 seed = cycleIdx 呼叫 `runMCSimulation` → mcScore/Mean/Std/Cvar95
 *   3. 呼叫 `safeComputeRegime` → regime（失敗時 null）
 *   4. 呼叫 `computeRangeGuards` → atrHalfWidth / p5 / p95
 *   5. normFactor = mean(window closes)，將 Pa/Pb/atrHalfWidth/currentPrice 尺度化
 *
 * 此函數為純同步 + 純計算：無 I/O、無 async、不觸碰 AppState。
 */
export function extractFeatures(stores: OhlcvStore[]): ReplayFeature[] {
    const features: ReplayFeature[] = [];

    for (let poolIdx = 0; poolIdx < stores.length; poolIdx++) {
        const store = stores[poolIdx];
        const poolConfig = resolvePoolConfig(store.poolAddress);
        const poolLabel = formatPoolLabel(poolConfig);
        const hourlyReturns = toHourlyReturns(store.candles);

        const lateCycles = Math.max(0, hourlyReturns.length - MC_WINDOW_HOURS);
        const startMs = Date.now();
        log.info(`[${poolIdx + 1}/${stores.length}] ${poolLabel} — ${hourlyReturns.length} candles, ${lateCycles} late cycles 需跑 MC...`);

        const poolFeaturesBefore = features.length;

        for (let cycleIdx = 0; cycleIdx < hourlyReturns.length; cycleIdx++) {
            const candle = store.candles[cycleIdx];

            if (cycleIdx < MC_WINDOW_HOURS) {
                features.push(buildNullFeature(candle, cycleIdx, poolConfig, poolLabel));
                continue;
            }

            // 取 [cycleIdx - 720, cycleIdx) 作為歷史窗口（不含當前 candle）
            const window = hourlyReturns.slice(cycleIdx - MC_WINDOW_HOURS, cycleIdx);
            const windowCloses = window.map(c => c.close);
            const normFactor =
                windowCloses.reduce((s, v) => s + v, 0) / windowCloses.length;

            if (!Number.isFinite(normFactor) || normFactor <= 0) {
                // 窗口 close 異常（全 0 或 NaN）→ 無法 normalize，fallback 成 null-feature
                features.push(buildNullFeature(candle, cycleIdx, poolConfig, poolLabel));
                continue;
            }

            // ── regime engine ────────────────────────────────────────────────
            const regime = safeComputeRegime(window);

            // ── range guards（ATR / percentile，raw close space）─────────────
            const guards = computeRangeGuards(window, DEFAULT_REGIME_GENOME);

            // ── MC simulation（固定 seed = cycleIdx）────────────────────────
            const historicalReturns = window.map(c => c.r);
            const rng = seedrandom(String(cycleIdx));

            // 用 guards.p5 / p95 作為 Pa / Pb（與 prod 的 Track 3 percentile 一致）
            const Pa = guards.p5;
            const Pb = guards.p95;

            let mcMean: number | null = null;
            let mcStd: number | null = null;
            let mcScore: number | null = null;
            let mcCvar95: number | null = null;

            if (Pa > 0 && Pb > Pa && candle.close > 0) {
                // dailyFeesToken0 計算：
                //   candle.volume 是「小時」成交量（GeckoTerminal hour timeframe），
                //   × 24 還原成日均量後再 × fee × share，交給 runMCSimulation
                //   （其內部會 / 24 回到小時費收）。
                //   code review C1 修正：原本漏 × 24，導致 MC mean/cvar95 系統性
                //   低估 24 倍。修正後 mcScore / mcMean 與 prod 量級對齊。
                //
                // TODO(Gap D / I3，tasks.md POOL_TVL_PROXY follow-up)：
                //   candle.volume 的實際單位是 quote-token（通常 USD），而
                //   INITIAL_CAPITAL 的語意是 token0 單位。ratio
                //   `INITIAL_CAPITAL / POOL_TVL_PROXY_DEFAULT` 當成 share of pool
                //   成立的前提是兩者同單位（USD）。Task 19 跑過後由人工
                //   tuning POOL_TVL_PROXY_DEFAULT 時一併釐清此單位對齊。
                const dailyFeesToken0 =
                    candle.volume * 24 * poolConfig.fee * (INITIAL_CAPITAL / POOL_TVL_PROXY_DEFAULT);

                const mcResult = runMCSimulation({
                    historicalReturns,
                    P0: candle.close,
                    Pa,
                    Pb,
                    capital: INITIAL_CAPITAL,
                    dailyFeesToken0,
                    horizon: MC_HORIZON_DAYS,
                    numPaths: MC_NUM_PATHS,
                    rng,
                });

                if (mcResult.numPaths > 0) {
                    mcMean = mcResult.mean;
                    mcStd = mcResult.std;
                    mcScore = mcResult.score;
                    mcCvar95 = mcResult.cvar95;
                }
            }

            // ── normalize range / ATR 到 normFactor 空間 ────────────────────
            const PaNorm = Pa > 0 ? Pa / normFactor : null;
            const PbNorm = Pb > 0 ? Pb / normFactor : null;
            const atrHalfWidthNorm =
                Number.isFinite(guards.atrHalfWidth) && guards.atrHalfWidth > 0
                    ? guards.atrHalfWidth / normFactor
                    : null;

            features.push({
                poolId: poolConfig.address,
                poolLabel,
                ts: candle.ts,
                cycleIdx,
                mcScore,
                mcMean,
                mcStd,
                mcCvar95,
                regime,
                PaNorm,
                PbNorm,
                atrHalfWidth: atrHalfWidthNorm,
                currentPriceNorm: candle.close / normFactor,
                candleVolume: candle.volume,
                poolTvlProxy: POOL_TVL_PROXY_DEFAULT,
                poolFeeTier: poolConfig.fee,
            });
        }

        const poolFeatureCount = features.length - poolFeaturesBefore;
        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        log.info(`[${poolIdx + 1}/${stores.length}] ${poolLabel} — ${poolFeatureCount} features extracted (${elapsedSec}s)`);
    }

    return features;
}
