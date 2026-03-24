/**
 * MonteCarloEngine — 歷史 Bootstrap 蒙地卡羅模擬引擎
 *
 * 核心思想：不假設任何理論分佈，直接從 720 根 1H K 線真實歷史報酬率（有放回抽樣）
 * 生成 10,000 條未來價格路徑，天生攜帶胖尾效應與市場相關性。
 *
 * P&L 計算採 Interpretation B（純 ETH HODL 基準）：
 *   PnL_ratio = (fees_token0 + V_LP_token0(P_T)) / capital - 1
 * 不受幣價漲跌影響，僅衡量流動性供給是否積累更多 ETH。
 *
 * 主要 exports：
 *   runMCSimulation(params)             — 單區間模擬 → MCSimResult（比率形式）
 *   calcCandidateRanges(capital, ...)   — ±1σ / ±2σ / ±3σ 三組候選區間 EV
 *   calcTranchePlan70_30(capital, ...)  — 70/30 分倉佈局完整計畫
 */

import { BBResult, MCSimResult, PoolStats, TranchePlan, CoreTranche, BufferTranche } from '../types';
import { config } from '../config';
import { fetchHistoricalReturns } from './BBEngine';
import { calculateCapitalEfficiency } from '../utils/math';
import { createServiceLogger } from '../utils/logger';
import {
    computeL,
    computeLpValueToken0,
} from './PositionCalculator';

const log = createServiceLogger('MC');

// ─── Internal simulation params ───────────────────────────────────────────────

interface MCSimParams {
    historicalReturns: number[]; // 歷史每小時 log 報酬率（Bootstrap 母體，720 根 1H K 線）
    P0: number;                  // 初始價格（token1/token0）
    Pa: number;                  // 區間下界
    Pb: number;                  // 區間上界
    capital: number;             // token0 單位資金（PnL 比率分母）
    dailyFeesToken0: number;     // 在範圍內時的每日費收（token0 單位）；內部除以 24 = 小時費收
    horizon: number;             // 模擬天數（內部轉換為 × 24 小時步進）
    numPaths: number;            // 路徑數
}

// ─── Single-path simulation ───────────────────────────────────────────────────

/**
 * 執行單條 Bootstrap 路徑模擬（每步 = 1 小時）。
 * 每小時從歷史報酬率池中隨機抽取一個報酬率（有放回），更新價格並累加費收。
 *
 * 採 Interpretation B：V_HODL = capital（純持幣不動），不需要 x0/y0。
 * PnL_ratio = (fees + V_LP_token0(P_T)) / capital - 1
 */
function runOnePath(
    returns: number[],
    P0: number,
    Pa: number,
    Pb: number,
    L: number,
    capital: number,
    hourlyFeesBase: number,
    horizonHours: number,
): { pnlRatio: number; hoursInRange: number } {
    let P = P0;
    let fees = 0;
    let hoursInRange = 0;
    const n = returns.length;

    for (let h = 0; h < horizonHours; h++) {
        // 有放回抽樣：隨機取一個歷史 1H 報酬率
        P *= Math.exp(returns[Math.floor(Math.random() * n)]);
        if (P > Pa && P < Pb) {
            fees += hourlyFeesBase;
            hoursInRange++;
        }
    }

    // LP 現值（token0 單位）
    const vlp = computeLpValueToken0(L, P, Pa, Pb);
    // PnL 比率：(費收 + LP 現值) / 初始資金 - 1
    const pnlRatio = (fees + vlp) / capital - 1;
    return { pnlRatio, hoursInRange };
}

// ─── Public: core simulation ──────────────────────────────────────────────────

/**
 * 執行 Bootstrap 蒙地卡羅模擬，回傳完整分佈統計（比率形式）。
 *
 * 通過條件：CVaR₉₅ > −(預期費收比率 × CVAR_SAFETY_FACTOR)
 * 歷史資料不足時直接回傳 go=false，不執行模擬。
 */
export function runMCSimulation(params: MCSimParams): MCSimResult {
    const { historicalReturns, P0, Pa, Pb, capital, dailyFeesToken0, horizon, numPaths } = params;

    if (historicalReturns.length < 2 || Pa <= 0 || Pb <= Pa || P0 <= 0 || capital <= 0) {
        return {
            numPaths: 0, horizon,
            mean: 0, median: 0, inRangeDays: 0,
            p5: 0, p25: 0, p50: 0, p75: 0, p95: 0,
            cvar95: 0, var95: 0,
            go: false,
            noGoReason: historicalReturns.length < 2
                ? '歷史報酬率資料不足，無法執行 Bootstrap 模擬'
                : '區間或資金參數無效',
        };
    }

    // 內部：以小時為步進單位
    const horizonHours = horizon * 24;
    const hourlyFees = dailyFeesToken0 / 24;

    // L 仍需計算（用於路徑末尾 V_LP 估算）
    const L = computeL(capital, P0, Pa, Pb);

    const pnlRatios: number[] = [];
    let totalHoursInRange = 0;

    for (let i = 0; i < numPaths; i++) {
        const { pnlRatio, hoursInRange } = runOnePath(
            historicalReturns, P0, Pa, Pb, L, capital, hourlyFees, horizonHours,
        );
        pnlRatios.push(pnlRatio);
        totalHoursInRange += hoursInRange;
    }

    pnlRatios.sort((a, b) => a - b);
    const n = pnlRatios.length;

    // CVaR₉₅：最差 5% 路徑的平均比率
    const worst5 = Math.max(1, Math.floor(n * 0.05));
    const cvar95 = pnlRatios.slice(0, worst5).reduce((s, v) => s + v, 0) / worst5;
    const var95 = pnlRatios[worst5 - 1];

    const mean = pnlRatios.reduce((s, v) => s + v, 0) / n;
    const median = n % 2 === 0
        ? (pnlRatios[n / 2 - 1] + pnlRatios[n / 2]) / 2
        : pnlRatios[Math.floor(n / 2)];
    const inRangeDays = totalHoursInRange / numPaths / 24;

    // 通過門檻（比率形式）：CVaR₉₅ > −(預期費收比率 × CVAR_SAFETY_FACTOR)
    const expectedFeesRatio = (dailyFeesToken0 / capital) * inRangeDays;
    const safetyFloor = Math.max(expectedFeesRatio, 1e-6);
    const cvarThreshold = -(safetyFloor * config.CVAR_SAFETY_FACTOR);
    const go = cvar95 > cvarThreshold;

    let noGoReason: string | undefined;
    if (!go) {
        const ratio = expectedFeesRatio > 0
            ? (Math.abs(cvar95) / expectedFeesRatio).toFixed(1)
            : '∞';
        noGoReason = `CVaR₉₅=${(cvar95 * 100).toFixed(2)}% 超出費收保護墊 ${ratio}× (門檻 ${config.CVAR_SAFETY_FACTOR}×)`;
    }

    return {
        numPaths: n,
        horizon,
        mean,
        median,
        inRangeDays,
        p5: pnlRatios[Math.floor(n * 0.05)],
        p25: pnlRatios[Math.floor(n * 0.25)],
        p50: pnlRatios[Math.floor(n * 0.50)],
        p75: pnlRatios[Math.floor(n * 0.75)],
        p95: pnlRatios[Math.floor(n * 0.95)],
        cvar95,
        var95,
        go,
        noGoReason,
    };
}

// ─── Public: three candidate ranges ──────────────────────────────────────────

/** 單組候選區間的 MC 評估結果 */
export interface RangeCandidateResult {
    sigma: number;
    lowerPrice: number;
    upperPrice: number;
    capitalEfficiency: number;
    dailyFeesToken0: number;
    mc: MCSimResult;
}

/**
 * 計算 ±1σ / ±2σ / ±3σ 三組候選區間的 EV（蒙地卡羅模擬）。
 * 三組全部 go=false → 建議空倉等待。
 *
 * @param capital   token0 單位資金
 * @param pool      池子資訊（APR、farmApr）
 * @param bb        BBResult（含 sma、stdDev1H）
 * @param sigmas    要評估的 σ 倍數陣列，預設 [1.0, 2.0, 3.0]
 */
export async function calcCandidateRanges(
    capital: number,
    pool: PoolStats,
    bb: BBResult,
    sigmas = [1.0, 2.0, 3.0],
): Promise<RangeCandidateResult[]> {
    const { sma, stdDev1H: rawStdDev, volatility30D } = bb;
    if (!sma || sma <= 0) return [];

    const stdDev = rawStdDev ?? (sma * volatility30D / Math.sqrt(365 * 24));
    if (stdDev <= 0) return [];

    const maxOffset = sma * config.BB_MAX_OFFSET_PCT;
    const totalApr = pool.apr + (pool.farmApr ?? 0);

    const returns = await fetchHistoricalReturns(pool.id, pool.dex);
    const baseParams = {
        historicalReturns: returns,
        horizon: config.MC_HORIZON_DAYS,
        numPaths: config.MC_NUM_PATHS,
        P0: sma,
        capital,
    };

    return sigmas.map(sigma => {
        const lowerPrice = Math.max(sma - maxOffset, sma - sigma * stdDev);
        const upperPrice = Math.min(sma + maxOffset, sma + sigma * stdDev);
        const capitalEfficiency = calculateCapitalEfficiency(upperPrice, lowerPrice, sma) ?? 1;
        const dailyFeesToken0 = capital * (totalApr / 365) * capitalEfficiency;

        const mc = runMCSimulation({
            ...baseParams,
            Pa: lowerPrice,
            Pb: upperPrice,
            dailyFeesToken0,
        });

        return { sigma, lowerPrice, upperPrice, capitalEfficiency, dailyFeesToken0, mc };
    });
}

// ─── Public: 70/30 tranche plan ───────────────────────────────────────────────

/**
 * 計算 70/30 分倉佈局完整計畫。
 *
 * Core (70%)：±TRANCHE_CORE_SIGMA × stdDev1H，緊貼現價，高 APR 主力倉。
 * Buffer (30%)：單邊防禦深水區，依 smaSlope 決定方向（預設下方）。
 *   - 平時完全 OTM（不在 range，不消耗 rebalance Gas）
 *   - 主倉被打穿後才被動進入 range，自動接落刀
 *
 * Buffer MC 說明：
 *   - P0 = sma（高於 buffer range），L 以「純 token0 初始化」公式計算
 *   - 大多數路徑中 buffer 不在 range（fees ≈ 0）
 *   - 僅極端下跌路徑才觸發 buffer，CVaR 反映真實最壞情境
 */
export async function calcTranchePlan70_30(
    totalCapital: number,
    pool: PoolStats,
    bb: BBResult,
): Promise<TranchePlan | null> {
    const { sma, stdDev1H: rawStdDev, volatility30D } = bb;
    if (!sma || sma <= 0) return null;

    const stdDev = rawStdDev ?? (sma * volatility30D / Math.sqrt(365 * 24));
    if (stdDev <= 0) return null;

    const maxOffset = sma * config.BB_MAX_OFFSET_PCT;
    const totalApr = pool.apr + (pool.farmApr ?? 0);

    // ── Core Tranche (70%) ────────────────────────────────────────────────────
    const coreCapital = totalCapital * config.TRANCHE_CORE_RATIO;
    const coreLower = Math.max(sma - maxOffset, sma - config.TRANCHE_CORE_SIGMA * stdDev);
    const coreUpper = Math.min(sma + maxOffset, sma + config.TRANCHE_CORE_SIGMA * stdDev);
    const coreEff = calculateCapitalEfficiency(coreUpper, coreLower, sma) ?? 1;
    const coreDailyFees = coreCapital * (totalApr / 365) * coreEff;

    // ── Buffer Tranche (30%) ──────────────────────────────────────────────────
    const bufferCapital = totalCapital * (1 - config.TRANCHE_CORE_RATIO);

    // 方向判斷：SMA 上升趨勢 → 防守上方；其餘 → 防守下方（預設）
    const direction: 'down' | 'up' = (bb.smaSlope ?? 0) >= config.SMA_SLOPE_TREND_THRESHOLD
        ? 'up'
        : 'down';

    let bufferLower: number;
    let bufferUpper: number;
    if (direction === 'down') {
        bufferUpper = sma - config.TRANCHE_BUFFER_SIGMA_NEAR * stdDev;
        bufferLower = sma - config.TRANCHE_BUFFER_SIGMA_FAR * stdDev;
    } else {
        bufferLower = sma + config.TRANCHE_BUFFER_SIGMA_NEAR * stdDev;
        bufferUpper = sma + config.TRANCHE_BUFFER_SIGMA_FAR * stdDev;
    }
    // 安全下限：確保 bufferLower 不為負
    if (bufferLower <= 0) bufferLower = sma * 0.001;

    // Buffer active efficiency：以 buffer 中點模擬「啟動後」的資金效率
    const bufferMid = (bufferLower + bufferUpper) / 2;
    const bufferEff = calculateCapitalEfficiency(bufferUpper, bufferLower, bufferMid) ?? 0;
    // Buffer 平時 OTM，每日費收以「啟動態」計算供 MC 使用
    const bufferDailyFees = bufferCapital * (totalApr / 365) * bufferEff;

    // ── Fetch historical returns (可能有網路延遲) ─────────────────────────────
    const returns = await fetchHistoricalReturns(pool.id, pool.dex);
    if (returns.length < 2) {
        log.warn(`calcTranchePlan70_30: 歷史報酬率不足（${returns.length} 筆），無法執行 MC`);
    }

    const baseParams = {
        historicalReturns: returns,
        horizon: config.MC_HORIZON_DAYS,
        numPaths: config.MC_NUM_PATHS,
    };

    // ── Simulations ───────────────────────────────────────────────────────────
    log.info(`MC: Core [${coreLower.toFixed(8)}, ${coreUpper.toFixed(8)}]  Buffer dir=${direction}`);

    const coreMC = runMCSimulation({
        ...baseParams,
        P0: sma,
        Pa: coreLower, Pb: coreUpper,
        capital: coreCapital, dailyFeesToken0: coreDailyFees,
    });

    // Buffer：P0 = sma（高於 buffer range），OTM 初始化
    const bufferMC = runMCSimulation({
        ...baseParams,
        P0: sma,
        Pa: bufferLower, Pb: bufferUpper,
        capital: bufferCapital, dailyFeesToken0: bufferDailyFees,
    });

    log.info(`MC: Core go=${coreMC.go} CVaR=${(coreMC.cvar95 * 100).toFixed(2)}%  Buffer go=${bufferMC.go} CVaR=${(bufferMC.cvar95 * 100).toFixed(2)}%`);

    // ── Assemble ──────────────────────────────────────────────────────────────
    const coreTranche: CoreTranche = {
        capital: coreCapital,
        ratio: config.TRANCHE_CORE_RATIO,
        sigma: config.TRANCHE_CORE_SIGMA,
        lowerPrice: coreLower,
        upperPrice: coreUpper,
        capitalEfficiency: coreEff,
        dailyFeesToken0: coreDailyFees,
        mc: coreMC,
    };

    const bufferTranche: BufferTranche = {
        capital: bufferCapital,
        ratio: 1 - config.TRANCHE_CORE_RATIO,
        direction,
        sigmaRange: [config.TRANCHE_BUFFER_SIGMA_NEAR, config.TRANCHE_BUFFER_SIGMA_FAR],
        lowerPrice: bufferLower,
        upperPrice: bufferUpper,
        capitalEfficiency: bufferEff,
        mc: bufferMC,
    };

    // 整體 Go/No-Go 由主倉決定（buffer 是防禦性質，不要求獨立通過）
    const cvar95Combined =
        coreMC.cvar95 * config.TRANCHE_CORE_RATIO +
        bufferMC.cvar95 * (1 - config.TRANCHE_CORE_RATIO);

    return {
        core: coreTranche,
        buffer: bufferTranche,
        combined: {
            totalDailyFees: coreDailyFees, // buffer 平時 OTM，不計入正常日費
            cvar95: cvar95Combined,
            go: coreMC.go,
            noGoReason: coreMC.go ? undefined : coreMC.noGoReason,
        },
    };
}
