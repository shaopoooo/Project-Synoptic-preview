/**
 * PositionCalculator — 開倉試算器
 * 計算在特定池子、指定區間、指定資金量下的 IL（以 token0 為本位）與回本天數
 */
import { appState } from '../utils/AppState';
import { calculateCapitalEfficiency } from '../utils/math';
import type { PoolStats, BBResult } from '../types';

export interface CalcScenario {
    label: string;
    price: number;
    priceChangePct: number;   // 相對 P0 的價格變化 %（負為下跌）
    ilToken0: number;         // IL in token0 units（負為損失）
    breakevenDays: number | null;
}

export interface CalcResult {
    poolRank: number;
    pool: PoolStats;
    bb: BBResult | null;
    rangeSource: 'BB' | 'user' | 'fallback';
    capital: number;          // token0 units
    currentPrice: number;     // token1 / token0
    lowerPrice: number;
    upperPrice: number;
    capitalEfficiency: number;
    dailyFeesToken0: number;  // 估算每日手續費（token0 units）
    downScenarios: CalcScenario[];
    upScenarios: CalcScenario[];
}

// ─── V3 IL Math ───────────────────────────────────────────────────────────────

/**
 * 給定 capital（token0）與區間 [Pa, Pb] 及當前價格 P0，計算 V3 流動性參數 L
 */
function computeL(capital: number, P0: number, Pa: number, Pb: number): number {
    const sqP0 = Math.sqrt(P0);
    const sqPa = Math.sqrt(Pa);
    const sqPb = Math.sqrt(Pb);
    // capital = x0 + y0/P0 = L*(1/sqP0 - 1/sqPb) + L*(sqP0 - sqPa)/P0
    const denom = (1 / sqP0 - 1 / sqPb) + (sqP0 - sqPa) / P0;
    if (denom <= 0) return 0;
    return capital / denom;
}

/**
 * 計算初始 token 數量
 */
function computeInitialAmounts(L: number, P0: number, Pa: number, Pb: number): { x0: number; y0: number } {
    const sqP0 = Math.sqrt(P0);
    const sqPa = Math.sqrt(Pa);
    const sqPb = Math.sqrt(Pb);
    return {
        x0: L * (1 / sqP0 - 1 / sqPb),
        y0: L * (sqP0 - sqPa),
    };
}

/**
 * 計算 LP 在價格 P 時的價值（token0 單位）
 */
function computeLpValueToken0(L: number, P: number, Pa: number, Pb: number): number {
    if (P <= Pa) {
        // 全部是 token0
        return L * (1 / Math.sqrt(Pa) - 1 / Math.sqrt(Pb));
    } else if (P >= Pb) {
        // 全部是 token1，換算回 token0
        return L * (Math.sqrt(Pb) - Math.sqrt(Pa)) / P;
    } else {
        // 在範圍內
        const sqP = Math.sqrt(P);
        return L * (1 / sqP - 1 / Math.sqrt(Pb)) + L * (sqP - Math.sqrt(Pa)) / P;
    }
}

/**
 * 計算 HODL 在價格 P 時的價值（token0 單位）
 */
function computeHodlValueToken0(x0: number, y0: number, P: number): number {
    return x0 + y0 / P;
}

// ─── Main Calculator ──────────────────────────────────────────────────────────

/**
 * 取得 pools 按 APR（含 farmApr）排序後的索引
 */
function sortedPoolsByApr(): { pool: PoolStats; bb: BBResult | null; originalIdx: number }[] {
    return appState.pools
        .map((pool, originalIdx) => {
            const bbKey = pool.id.toLowerCase();
            const bb = appState.bbs[bbKey] ?? null;
            return { pool, bb, originalIdx };
        })
        .sort((a, b) => {
            const aprA = a.pool.apr + (a.pool.farmApr ?? 0);
            const aprB = b.pool.apr + (b.pool.farmApr ?? 0);
            return aprB - aprA;
        });
}

/**
 * 計算開倉試算
 * @param capital  資金量（token0 單位，通常為 ETH）
 * @param rank     APR 排名，從 1 開始（1 = 最高 APR）；預設 1
 * @param lowerPct 下限百分比，e.g. 5 = -5% from current；null = 使用 BB
 * @param upperPct 上限百分比，e.g. 5 = +5% from current；null = 使用 BB
 */
export function calcOpenPosition(
    capital: number,
    rank = 1,
    lowerPct: number | null = null,
    upperPct: number | null = null,
): CalcResult | null {
    const sorted = sortedPoolsByApr();
    if (sorted.length === 0) return null;

    const idx = Math.max(0, Math.min(rank - 1, sorted.length - 1));
    const { pool, bb, originalIdx } = sorted[idx];

    // 決定當前價格
    const P0 = bb ? bb.sma : Math.pow(1.0001, pool.tick);

    // 決定區間
    let Pa: number;
    let Pb: number;
    let rangeSource: CalcResult['rangeSource'];
    if (lowerPct !== null && upperPct !== null) {
        Pa = P0 * (1 - lowerPct / 100);
        Pb = P0 * (1 + upperPct / 100);
        rangeSource = 'user';
    } else if (bb) {
        Pa = bb.lowerPrice;
        Pb = bb.upperPrice;
        rangeSource = 'BB';
    } else {
        // fallback ±5%
        Pa = P0 * 0.95;
        Pb = P0 * 1.05;
        rangeSource = 'fallback';
    }

    if (Pa <= 0 || Pb <= Pa || P0 <= 0) return null;

    const capitalEff = calculateCapitalEfficiency(Pb, Pa, P0) ?? 1;
    const totalApr = pool.apr + (pool.farmApr ?? 0);
    // 每日費收（token0 單位）= 資金 × (APR/365) × 資金效率
    const dailyFeesToken0 = capital * (totalApr / 365) * capitalEff;

    const L = computeL(capital, P0, Pa, Pb);
    const { x0, y0 } = computeInitialAmounts(L, P0, Pa, Pb);

    // 產生場景
    function makeScenario(label: string, P: number): CalcScenario {
        const vlp = computeLpValueToken0(L, P, Pa, Pb);
        const vhodl = computeHodlValueToken0(x0, y0, P);
        const ilToken0 = vlp - vhodl;
        const priceChangePct = ((P - P0) / P0) * 100;
        const breakevenDays = (ilToken0 < 0 && dailyFeesToken0 > 0)
            ? Math.abs(ilToken0) / dailyFeesToken0
            : null;
        return { label, price: P, priceChangePct, ilToken0, breakevenDays };
    }

    // 下跌場景：Pa（觸及下界）、Pa * (Pa/P0)（再跌同比例）、Pa * (Pa/P0)^2
    const ratioDown = Pa / P0;
    const downScenarios: CalcScenario[] = [
        makeScenario('觸及下界', Pa),
        makeScenario('下界 ×2', P0 * Math.pow(ratioDown, 2)),
        makeScenario('下界 ×3', P0 * Math.pow(ratioDown, 3)),
    ];

    // 上漲場景
    const ratioUp = Pb / P0;
    const upScenarios: CalcScenario[] = [
        makeScenario('觸及上界', Pb),
        makeScenario('上界 ×2', P0 * Math.pow(ratioUp, 2)),
        makeScenario('上界 ×3', P0 * Math.pow(ratioUp, 3)),
    ];

    return {
        poolRank: idx + 1,
        pool,
        bb,
        rangeSource,
        capital,
        currentPrice: P0,
        lowerPrice: Pa,
        upperPrice: Pb,
        capitalEfficiency: capitalEff,
        dailyFeesToken0,
        downScenarios,
        upScenarios,
    };
}
