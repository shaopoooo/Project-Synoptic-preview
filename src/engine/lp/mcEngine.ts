import { appState } from '../../infra/AppState';
import { createServiceLogger } from '../../infra/logger';
import { calcCandidateRanges, calcTranchePlan } from '../shared/MonteCarloEngine';
import { analyzeRegime, computeRangeGuards, computeRegimeVector, segmentByRegime } from '../shared/MarketRegimeAnalyzer';
import { config } from '../../config';
import { logCalc } from '../../infra/logger';
import type { OpeningStrategy, HourlyReturn, RangeGuards, RegimeGenome, MCEngineDiagnostic, PoolDiagnostic, MarketStats } from '../../types';
import { currentConstantsToGenome } from '../shared/ParameterGenome';

const log = createServiceLogger('MCEngine');

/**
 * 從歷史蠟燭推導 MarketStats（取代 BB 的 MarketSnapshot）。
 * sma = 最近 20 根 close 均值
 * stdDev1H = log return 的標準差
 * volatility30D = stdDev1H × √8760（年化）
 */
/**
 * 從歷史蠟燭推導 MarketStats。
 * 所有價格正規化為相對比率（close / meanClose），讓 sma ≈ 1.0。
 * 這樣 sma、stdDev1H、ATR 全部在同一個無單位空間，跨池可比較。
 * log return 不受正規化影響（ln(a/k / b/k) = ln(a/b)）。
 */
export function deriveMarketStats(rawReturns: HourlyReturn[]): (MarketStats & { normFactor: number }) | null {
    if (rawReturns.length < 20) return null;

    // 正規化因子：全部蠟燭的 close 均值
    const allCloses = rawReturns.map(c => c.close);
    const normFactor = allCloses.reduce((s, c) => s + c, 0) / allCloses.length;
    if (normFactor <= 0) return null;

    // sma = 最近 20 根正規化 close 的均值（≈ 1.0 附近）
    const recent = rawReturns.slice(-20);
    const sma = recent.reduce((s, c) => s + c.close / normFactor, 0) / recent.length;

    const returns = rawReturns.map(c => c.r);
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stdDev1H = Math.sqrt(variance);

    if (sma <= 0 || stdDev1H <= 0) return null;

    return {
        sma,
        stdDev1H,
        volatility30D: stdDev1H * Math.sqrt(8760),
        normFactor,
    };
}

const ATR_K_CANDIDATES = [1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.0];
const MAX_SIGMA = 1000;

function getAtrSigmaCandidates(atrHalfWidth: number, stdDev1H: number): number[] {
    if (atrHalfWidth <= 0 || stdDev1H <= 0) return [];
    return ATR_K_CANDIDATES
        .map(k => (k * atrHalfWidth) / stdDev1H)
        .filter(sigma => sigma <= MAX_SIGMA);
}

const UNIT_CAPITAL = 1.0;

export async function runMCEngine(
    historicalReturns: Map<string, HourlyReturn[]>,
    sendAlert?: (msg: string) => Promise<void>,
    genome?: RegimeGenome,
): Promise<MCEngineDiagnostic> {
    const pools = appState.pools;
    const poolDiagnostics: PoolDiagnostic[] = [];
    const activeGenome = genome ?? currentConstantsToGenome();

    if (pools.length === 0) {
        log.warn('runMCEngine: 無池子資料，跳過');
        return { poolResults: poolDiagnostics, summary: { totalPools: 0, goPools: 0, oldVersionSkipCount: 0, newVersionRecoveredCount: 0 } };
    }

    const noGoPools: string[] = [];

    for (const pool of pools) {
        const rawReturns = historicalReturns.get(pool.id.toLowerCase()) ?? [];
        const returns = rawReturns.map(hr => hr.r);

        const emptyDiag: PoolDiagnostic = {
            pool: pool.id.slice(0, 10), dex: pool.dex, regimeVector: null,
            hardSignal: 'neutral', wouldSkipInOldVersion: false,
            sigmaOpt: null, kBest: null, score: null, cvar95: null, go: false, goCandidateCount: 0,
        };

        if (returns.length < 20) {
            log.warn(`MCEngine: pool ${pool.dex} 歷史報酬率不足（${returns.length}），跳過`);
            poolDiagnostics.push(emptyDiag);
            continue;
        }

        // ── 從歷史蠟燭推導市場統計 ───────────────────────────────────────────
        const stats = deriveMarketStats(rawReturns);
        if (!stats) {
            log.warn(`MCEngine: pool ${pool.dex} 無法推導 MarketStats，跳過`);
            poolDiagnostics.push(emptyDiag);
            continue;
        }

        // 極端波動 gate
        if (stats.volatility30D > 1.0) {
            log.warn(`MCEngine: pool ${pool.dex} 極端波動（vol=${(stats.volatility30D * 100).toFixed(0)}%），No-Go`);
            noGoPools.push(`${pool.dex} ${pool.id.slice(0, 8)}…`);
            poolDiagnostics.push(emptyDiag);
            continue;
        }

        // ── Regime + Guards ──────────────────────────────────────────────────
        const regime = analyzeRegime(rawReturns, activeGenome);
        const regimeVector = computeRegimeVector(rawReturns, activeGenome);
        const segments = segmentByRegime(rawReturns);
        const guardsUSD = computeRangeGuards(rawReturns, activeGenome);

        const diagEntry: PoolDiagnostic = {
            ...emptyDiag,
            hardSignal: regime.signal,
            wouldSkipInOldVersion: regime.signal === 'trend',
            regimeVector,
        };

        // guards 從 USD 轉正規化空間（除以 normFactor）
        const guards: RangeGuards = {
            atrHalfWidth: guardsUSD.atrHalfWidth / stats.normFactor,
            p5: guardsUSD.p5 / stats.normFactor,
            p95: guardsUSD.p95 / stats.normFactor,
        };

        log.info(
            `MCEngine: ${pool.dex} ${pool.id.slice(0, 8)} | ` +
            `sma=${stats.sma.toFixed(4)} σ1H=${stats.stdDev1H.toExponential(3)} vol=${(stats.volatility30D * 100).toFixed(1)}% | ` +
            `R=${regimeVector.range.toFixed(2)} T=${regimeVector.trend.toFixed(2)} N=${regimeVector.neutral.toFixed(2)} | ` +
            `apr=${((pool.apr + (pool.farmApr ?? 0)) * 100).toFixed(1)}% ATR=${guards.atrHalfWidth.toExponential(3)}`
        );
        const sigmas = getAtrSigmaCandidates(guards.atrHalfWidth, stats.stdDev1H);
        if (sigmas.length === 0) {
            log.warn(`MCEngine: pool ${pool.dex} ATR=${guardsUSD.atrHalfWidth.toFixed(2)}USD atrRatio=${guards.atrHalfWidth.toExponential(3)} stdDev1H=${stats.stdDev1H.toExponential(3)} — sigma 候選為空`);
            poolDiagnostics.push(diagEntry);
            continue;
        }

        try {
            const candidates = calcCandidateRanges(UNIT_CAPITAL, pool, stats, returns, sigmas, guards, segments, regimeVector);
            // 不論 go/no-go 都輸出每個候選的關鍵參數
            for (const c of candidates) {
                log.info(
                    `  σ=${c.sigma.toFixed(2)} [${c.lowerPrice.toPrecision(5)}~${c.upperPrice.toPrecision(5)}] ` +
                    `mean=${(c.mc.mean * 100).toFixed(2)}% CVaR=${(c.mc.cvar95 * 100).toFixed(2)}% ` +
                    `inRange=${c.mc.inRangeDays.toFixed(1)}d ${c.mc.go ? '✅' : `🚫 ${c.mc.noGoReason ?? ''}`}`
                );
            }

            const goCandidates = candidates.filter(c => c.mc.go);

            if (goCandidates.length === 0) {
                noGoPools.push(`${pool.dex} ${pool.id.slice(0, 8)}…`);
                log.warn(`MCEngine: pool ${pool.dex} 全部 sigma No-Go`);
                delete appState.strategies[pool.id.toLowerCase()];
                poolDiagnostics.push(diagEntry);
                continue;
            }

            const scored = goCandidates.map(c => ({ c, score: c.mc.score }));
            scored.sort((a, b) => b.score - a.score);
            const { c: best, score: bestScore } = scored[0];

            const tranche = calcTranchePlan(UNIT_CAPITAL, pool, stats, returns, segments, regimeVector);
            const coreRatio = appState.userConfig.trancheCore ?? config.TRANCHE_CORE_RATIO;

            const strategy: OpeningStrategy = {
                poolAddress: pool.id.toLowerCase(),
                sigmaOpt: best.sigma,
                score: bestScore,
                cvar95: best.mc.cvar95,
                mean: best.mc.mean,
                std: best.mc.std,
                coreBand: { lower: best.lowerPrice, upper: best.upperPrice },
                bufferBand: tranche
                    ? { lower: tranche.buffer.lowerPrice, upper: tranche.buffer.upperPrice }
                    : { lower: best.lowerPrice * 0.8, upper: best.lowerPrice },
                trancheCore: coreRatio,
                trancheBuffer: 1 - coreRatio,
                marketRegime: regime,
                computedAt: Date.now(),
            };

            appState.strategies[pool.id.toLowerCase()] = strategy;
            const kBest = stats.stdDev1H > 0 ? (best.sigma * stats.stdDev1H / guards.atrHalfWidth).toFixed(2) : '?';

            diagEntry.sigmaOpt = best.sigma;
            diagEntry.kBest = parseFloat(kBest) || null;
            diagEntry.score = bestScore;
            diagEntry.cvar95 = best.mc.cvar95;
            diagEntry.go = true;
            diagEntry.goCandidateCount = goCandidates.length;
            poolDiagnostics.push(diagEntry);

            log.info(`MCEngine: pool ${pool.dex} k=${kBest}×ATR σ=${best.sigma.toFixed(2)} score=${bestScore.toFixed(3)} CVaR=${(best.mc.cvar95 * 100).toFixed(2)}%`);

        } catch (err) {
            log.error(`MCEngine: pool ${pool.id.slice(0, 8)} 計算失敗`, { err });
            poolDiagnostics.push(diagEntry);
        }
    }

    const goPools = poolDiagnostics.filter(d => d.go).length;
    const oldSkipCount = poolDiagnostics.filter(d => d.wouldSkipInOldVersion).length;
    const recoveredCount = poolDiagnostics.filter(d => d.wouldSkipInOldVersion && d.go).length;

    if (noGoPools.length > 0 && sendAlert) {
        await sendAlert(
            `🚫 <b>Kill Switch B — MC 全面 No-Go</b>\n\n` +
            noGoPools.map(p => `  • ${p}`).join('\n')
        ).catch(() => { });
    }

    return {
        poolResults: poolDiagnostics,
        summary: { totalPools: poolDiagnostics.length, goPools, oldVersionSkipCount: oldSkipCount, newVersionRecoveredCount: recoveredCount },
    };
}
