import { appState } from '../utils/AppState';
import { createServiceLogger } from '../utils/logger';
import { calcCandidateRanges, calcTranchePlan } from '../services/strategy/MonteCarloEngine';
import { analyzeRegime, computeRangeGuards } from '../services/strategy/MarketRegimeAnalyzer';
import { config } from '../config';
import { logCalc } from '../utils/logger';
import type { OpeningStrategy, HourlyReturn, RangeGuards, RegimeGenome, MCEngineDiagnostic, PoolDiagnostic } from '../types';
import { currentConstantsToGenome } from '../services/strategy/ParameterGenome';

const log = createServiceLogger('MCEngine');

/**
 * ATR 倍數候選集合（固定，與波動率無關）。
 * 搜尋空間以「實際觀測振幅的倍數」定義，每個倍數代表一個具體的 LP 區間半寬：
 *   halfWidth = k × ATR(14)
 *   σ = halfWidth / stdDev1H  （反推，供 calcCandidateRanges 使用）
 *
 * k=1：區間寬度 = ATR，最窄，高效率但容易穿倉
 * k=7：區間寬度 = 7×ATR，最寬，低效率但抗震盪
 */
const ATR_K_CANDIDATES = [1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.0];

/**
 * 將 ATR 倍數候選轉換為 sigma 值，供 calcCandidateRanges 使用。
 * sigma = (k × atrHalfWidth) / stdDev1H
 */
/** sigma 上限：超過此值代表 stdDev1H 塌縮至浮點精度極限，結果無意義。 */
const MAX_SIGMA = 1000;

function getAtrSigmaCandidates(atrHalfWidth: number, stdDev1H: number): number[] {
    if (atrHalfWidth <= 0 || stdDev1H <= 0) return [];
    return ATR_K_CANDIDATES
        .map(k => (k * atrHalfWidth) / stdDev1H)
        .filter(sigma => sigma <= MAX_SIGMA);
}

/** 用單位資本（1 token0）計算比率分數，/calc 依使用者資本縮放 */
const UNIT_CAPITAL = 1.0;

/**
 * 執行 Bootstrap Monte Carlo 策略引擎（純計算，無 I/O）。
 *
 * 對每個池子：
 *   1. calcCandidateRanges（同步）→ 6 組 sigma 候選
 *   2. 篩選 go=true 候選，以 Score = mean / |CVaR₉₅| 選最優 sigma
 *   3. calcTranchePlan（同步）→ 取得 buffer 區間
 *   4. 組裝 OpeningStrategy，寫入 appState.strategies[poolAddress]
 *
 * Kill Switch B：若某池全部 sigma 均 No-Go，刪除舊策略並推播告警。
 *
 * @param historicalReturns  由 prefetchAll 預先抓取的歷史報酬率（快取熱身後直接使用）
 * @param sendAlert          可選的告警回呼（Kill Switch B 使用）
 */
export async function runMCEngine(
    historicalReturns: Map<string, HourlyReturn[]>,
    sendAlert?: (msg: string) => Promise<void>,
    genome?: RegimeGenome,
): Promise<MCEngineDiagnostic> {
    const pools = appState.pools;
    const marketSnapshots = appState.marketSnapshots;

    const poolDiagnostics: PoolDiagnostic[] = [];
    const activeGenome = genome ?? currentConstantsToGenome();

    if (pools.length === 0) {
        log.warn('runMCEngine: 無池子資料，跳過');
        return {
            poolResults: poolDiagnostics,
            summary: {
                totalPools: 0,
                goPools: 0,
                oldVersionSkipCount: 0,
                newVersionRecoveredCount: 0,
            },
        };
    }

    const noGoPools: string[] = [];
    const trendSkippedPools: string[] = [];

    for (const pool of pools) {
        const bb = marketSnapshots[pool.id.toLowerCase()];
        if (!bb || bb.isFallback || bb.isWarmup) {
            const reason = bb?.isWarmup ? 'warmup 資料不足' : 'API fallback';
            log.warn(`MCEngine: pool ${pool.dex} ${pool.id.slice(0, 8)}… BB 資料不可靠（${reason}），跳過`);
            // 清除舊策略，避免 /calc 提供過時建議
            delete appState.strategies[pool.id.toLowerCase()];
            poolDiagnostics.push({
                pool: pool.id.slice(0, 10),
                dex: pool.dex,
                regimeVector: null,
                hardSignal: 'range',
                wouldSkipInOldVersion: false,
                sigmaOpt: null,
                kBest: null,
                score: null,
                cvar95: null,
                go: false,
                goCandidateCount: 0,
            });
            continue;
        }

        const rawReturns = historicalReturns.get(pool.id.toLowerCase()) ?? [];
        const returns = rawReturns.map(hr => hr.r);
        if (returns.length < 2) {
            log.warn(`MCEngine: pool ${pool.dex} 歷史報酬率不足，跳過`);
            poolDiagnostics.push({
                pool: pool.id.slice(0, 10),
                dex: pool.dex,
                regimeVector: null,
                hardSignal: 'range',
                wouldSkipInOldVersion: false,
                sigmaOpt: null,
                kBest: null,
                score: null,
                cvar95: null,
                go: false,
                goCandidateCount: 0,
            });
            continue;
        }

        // ── 資料新鮮度驗證：末筆 ts 距今超過 3H 表示快取老化，CVaR 可能失準 ──
        const latestTs = rawReturns[rawReturns.length - 1]?.ts ?? 0;
        const dataAgeHours = (Date.now() / 1000 - latestTs) / 3600;
        if (dataAgeHours > 3) {
            log.warn(`MCEngine: pool ${pool.dex} 歷史報酬率老化 ${dataAgeHours.toFixed(1)}H，CVaR 計算結果可能失準`);
        }

        // ── Track 1：市場狀態過濾 + 動態 sigma ───────────────────────────────
        const regime = analyzeRegime(rawReturns, activeGenome);
        log.debug(`MCEngine: pool ${pool.dex} CHOP=${regime.chop.toFixed(1)} H=${regime.hurst.toFixed(2)} signal=${regime.signal}`);
        logCalc({
            phase: 'P1',
            layer: 'POOL',
            event: 'pool_regime',
            pool: pool.id.slice(0, 10),
            dex: pool.dex,
            chop: regime.chop,
            hurst: regime.hurst,
            atr: regime.atr,
            signal: regime.signal,
            returnCount: returns.length,
            volatility30D: bb.volatility30D,
        });

        const diagEntry: PoolDiagnostic = {
            pool: pool.id.slice(0, 10),
            dex: pool.dex,
            regimeVector: null,  // Phase 2 will fill this
            hardSignal: regime.signal,
            wouldSkipInOldVersion: regime.signal === 'trend',
            sigmaOpt: null,
            kBest: null,
            score: null,
            cvar95: null,
            go: false,
            goCandidateCount: 0,
        };

        if (regime.signal === 'trend') {
            log.warn(`MCEngine: pool ${pool.dex} 趨勢市場，跳過`);
            delete appState.strategies[pool.id.toLowerCase()];
            trendSkippedPools.push(`${pool.dex} ${pool.id.slice(0, 8)}… (CHOP=${regime.chop.toFixed(1)} H=${regime.hurst.toFixed(2)})`);
            poolDiagnostics.push(diagEntry);
            continue;
        }

        // 極端波動直接 No-Go（ATR 系統無法定義有意義的區間）
        if (bb.volatility30D > 1.0) {
            log.warn(`MCEngine: pool ${pool.dex} 極端波動（vol=${(bb.volatility30D * 100).toFixed(0)}%），No-Go`);
            delete appState.strategies[pool.id.toLowerCase()];
            noGoPools.push(`${pool.dex} ${pool.id.slice(0, 8)}… (extreme vol)`);
            poolDiagnostics.push(diagEntry);
            continue;
        }

        // ── Track 2+3：ATR 下限 + Percentile 天花板 ─────────────────────────
        const guards = computeRangeGuards(rawReturns, activeGenome);

        // ── 單位對齊：guards 由 OHLCV USD 蠟燭計算，bb.sma / stdDev1H 為 tick-ratio ──
        // 轉換因子 = bb.sma（tick-ratio）/ lastCloseUSD，將 USD 數值映射至 tick-ratio 空間。
        // 例如 WBTC/USDC 池：sma≈3e-12 tick-ratio，lastClose≈65000 USD，
        //   factor≈4.6e-17；ATR_USD=333 → ATR_tickRatio≈1.5e-14，與 stdDev1H≈6.7e-15 同階。
        const lastCloseUSD = rawReturns[rawReturns.length - 1]?.close ?? 0;
        const toTickRatio = (lastCloseUSD > 0 && bb.sma > 0) ? bb.sma / lastCloseUSD : null;

        if (toTickRatio === null) {
            log.warn(`MCEngine: pool ${pool.dex} 無法取得 lastCloseUSD，跳過`);
            poolDiagnostics.push(diagEntry);
            continue;
        }

        const guardsTR: RangeGuards = {
            atrHalfWidth: guards.atrHalfWidth * toTickRatio,
            p5:           guards.p5           * toTickRatio,
            p95:          guards.p95          * toTickRatio,
        };

        // ── Track 1（ATR 倍數反推 sigma）────────────────────────────────────
        const stdDev1H = bb.stdDev1H ?? (bb.sma * bb.volatility30D / Math.sqrt(8760));
        const sigmas = getAtrSigmaCandidates(guardsTR.atrHalfWidth, stdDev1H);
        if (sigmas.length === 0) {
            log.warn(`MCEngine: pool ${pool.dex} ATR 或 stdDev1H 無效，跳過`);
            poolDiagnostics.push(diagEntry);
            continue;
        }
        log.info(
            `MCEngine: pool ${pool.dex} ATR=${guards.atrHalfWidth.toExponential(3)}USD` +
            ` (${guardsTR.atrHalfWidth.toExponential(3)}TR)` +
            ` stdDev1H=${stdDev1H.toExponential(3)} ` +
            `k=[${ATR_K_CANDIDATES.join(',')}] σ=[${sigmas.map(s => s.toFixed(2)).join(',')}]`
        );

        try {
            // ── Step 1：候選區間評估（同步）─────────────────────────────────
            const candidates = calcCandidateRanges(UNIT_CAPITAL, pool, bb, returns, sigmas, guardsTR);
            candidates.forEach((c, i) => {
                logCalc({
                    phase: 'P1',
                    layer: 'CANDIDATE',
                    event: 'pool_mc_candidate',
                    pool: pool.id.slice(0, 10),
                    dex: pool.dex,
                    k: ATR_K_CANDIDATES[i],
                    sigma: c.sigma,
                    lowerPrice: c.lowerPrice,
                    upperPrice: c.upperPrice,
                    capitalEfficiency: c.capitalEfficiency,
                    dailyFeesToken0: c.dailyFeesToken0,
                    go: c.mc.go,
                    noGoReason: c.mc.noGoReason ?? null,
                    mean: c.mc.mean,
                    median: c.mc.median,
                    cvar95: c.mc.cvar95,
                    inRangeDays: c.mc.inRangeDays,
                    score: c.mc.go ? c.mc.mean / Math.abs(c.mc.cvar95) : null,
                });
            });
            
            // 深入傾印 (Trace) 完整分析結果
            log.trace(`MCEngine: pool ${pool.dex} candidates evaluated: %o`, candidates);
            
            const goCandidates = candidates.filter(c => c.mc.go);

            if (goCandidates.length === 0) {
                noGoPools.push(`${pool.dex} ${pool.id.slice(0, 8)}…`);
                log.warn(`MCEngine: pool ${pool.dex} 全部 sigma No-Go`);
                delete appState.strategies[pool.id.toLowerCase()];
                poolDiagnostics.push(diagEntry);
                continue;
            }

            // ── Step 2：Score = mean / |CVaR₉₅|，選最優 ─────────────────────
            const scored = goCandidates.map(c => ({
                c,
                score: c.mc.mean / Math.abs(c.mc.cvar95),
            }));
            scored.sort((a, b) => b.score - a.score);
            const { c: best, score: bestScore } = scored[0];

            // ── Step 3：分倉計畫（同步）──────────────────────────────────────
            const tranche = calcTranchePlan(UNIT_CAPITAL, pool, bb, returns);

            const coreRatio = appState.userConfig.trancheCore ?? config.TRANCHE_CORE_RATIO;

            const strategy: OpeningStrategy = {
                poolAddress: pool.id.toLowerCase(),
                sigmaOpt: best.sigma,
                score: bestScore,
                cvar95: best.mc.cvar95,
                coreBand: { lower: best.lowerPrice, upper: best.upperPrice },
                bufferBand: tranche
                    ? { lower: tranche.buffer.lowerPrice, upper: tranche.buffer.upperPrice }
                    : (bb.smaSlope ?? 0) >= 0
                        ? { lower: best.upperPrice, upper: best.upperPrice * 1.2 }   // 上升趨勢：buffer 在 core 上方
                        : { lower: best.lowerPrice * 0.8, upper: best.lowerPrice }, // 下降趨勢：buffer 在 core 下方
                trancheCore: coreRatio,
                trancheBuffer: 1 - coreRatio,
                marketRegime: regime,
                computedAt: Date.now(),
            };

            appState.strategies[pool.id.toLowerCase()] = strategy;
            const kBest = stdDev1H > 0 ? (best.sigma * stdDev1H / guards.atrHalfWidth).toFixed(2) : '?';
            diagEntry.kBest = parseFloat(kBest) || null;
            log.debug(
                `MCEngine: pool ${pool.dex} ` +
                `k=${kBest}×ATR σ=${best.sigma.toFixed(2)} ` +
                `score=${bestScore.toFixed(3)} CVaR=${(best.mc.cvar95 * 100).toFixed(2)}%`
            );
            logCalc({
                phase: 'P1',
                layer: 'POOL',
                event: 'pool_mc_result',
                pool: pool.id.slice(0, 10),
                dex: pool.dex,
                kBest: parseFloat(kBest) || null,
                sigmaOpt: best.sigma,
                coreLower: best.lowerPrice,
                coreUpper: best.upperPrice,
                bufferLower: strategy.bufferBand.lower,
                bufferUpper: strategy.bufferBand.upper,
                score: bestScore,
                cvar95: best.mc.cvar95,
                mean: best.mc.mean,
                median: best.mc.median,
                inRangeDays: best.mc.inRangeDays,
                capitalEfficiency: best.capitalEfficiency,
                goCandidateCount: goCandidates.length,
                trancheCore: strategy.trancheCore,
                trancheBuffer: strategy.trancheBuffer,
                atrHalfWidth: guards.atrHalfWidth,
                guardsP5: guards.p5,
                guardsP95: guards.p95,
                stdDev1H,
            });

            diagEntry.sigmaOpt = best.sigma;
            diagEntry.score = bestScore;
            diagEntry.cvar95 = best.mc.cvar95;
            diagEntry.go = true;
            diagEntry.goCandidateCount = goCandidates.length;
            poolDiagnostics.push(diagEntry);

        } catch (err) {
            log.error(`MCEngine: pool ${pool.id.slice(0, 8)} 計算失敗`, { err });
            poolDiagnostics.push(diagEntry);
        }
    }

    const goPools = poolDiagnostics.filter(d => d.go).length;
    const oldSkipCount = poolDiagnostics.filter(d => d.wouldSkipInOldVersion).length;
    const recoveredCount = poolDiagnostics.filter(d => d.wouldSkipInOldVersion && d.go).length;

    // ── Kill Switch B：CVaR 全部 No-Go ───────────────────────────────────────
    if (noGoPools.length > 0 && sendAlert) {
        await sendAlert(
            `🚫 <b>Kill Switch B — MC 全面 No-Go</b>\n\n` +
            `以下池子所有 σ 區間 CVaR 均不通過（風險過高）：\n` +
            noGoPools.map(p => `  • ${p}`).join('\n') + '\n\n' +
            `建議暫停開新倉，等待市場波動回落。`
        ).catch(() => { });
        log.warn(`Kill Switch B (CVaR No-Go) triggered for ${noGoPools.length} pool(s)`);
    }

    // ── 趨勢告警：獨立推播，避免與 CVaR No-Go 混淆 ──────────────────────────
    if (trendSkippedPools.length > 0 && sendAlert) {
        await sendAlert(
            `⚠️ <b>趨勢市場警告 — 策略暫停</b>\n\n` +
            `以下池子偵測到趨勢行情，LP 有偏移風險：\n` +
            trendSkippedPools.map(p => `  • ${p}`).join('\n') + '\n\n' +
            `市場回歸震盪後（CHOP>55 且 Hurst<0.52）將自動恢復計算。`
        ).catch(() => { });
        log.warn(`Trend skip triggered for ${trendSkippedPools.length} pool(s)`);
    }

    return {
        poolResults: poolDiagnostics,
        summary: {
            totalPools: poolDiagnostics.length,
            goPools,
            oldVersionSkipCount: oldSkipCount,
            newVersionRecoveredCount: recoveredCount,
        },
    };
}
