import { appState } from '../utils/AppState';
import { createServiceLogger } from '../utils/logger';
import { calcCandidateRanges, calcTranchePlan } from '../services/strategy/MonteCarloEngine';
import { analyzeRegime, computeRangeGuards } from '../services/strategy/MarketRegimeAnalyzer';
import { config } from '../config';
import { logCalc } from '../utils/logger';
import type { OpeningStrategy, HourlyReturn } from '../types';

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
function getAtrSigmaCandidates(atrHalfWidth: number, stdDev1H: number): number[] {
    if (atrHalfWidth <= 0 || stdDev1H <= 0) return [];
    return ATR_K_CANDIDATES.map(k => (k * atrHalfWidth) / stdDev1H);
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
): Promise<void> {
    const pools = appState.pools;
    const marketSnapshots = appState.marketSnapshots;

    if (pools.length === 0) {
        log.warn('runMCEngine: 無池子資料，跳過');
        return;
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
            continue;
        }

        const rawReturns = historicalReturns.get(pool.id.toLowerCase()) ?? [];
        const returns = rawReturns.map(hr => hr.r);
        if (returns.length < 2) {
            log.warn(`MCEngine: pool ${pool.dex} 歷史報酬率不足，跳過`);
            continue;
        }

        // ── Track 1：市場狀態過濾 + 動態 sigma ───────────────────────────────
        const regime = analyzeRegime(rawReturns);
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

        if (regime.signal === 'trend') {
            log.warn(`MCEngine: pool ${pool.dex} 趨勢市場，跳過`);
            delete appState.strategies[pool.id.toLowerCase()];
            trendSkippedPools.push(`${pool.dex} ${pool.id.slice(0, 8)}… (CHOP=${regime.chop.toFixed(1)} H=${regime.hurst.toFixed(2)})`);
            continue;
        }

        // 極端波動直接 No-Go（ATR 系統無法定義有意義的區間）
        if (bb.volatility30D > 1.0) {
            log.warn(`MCEngine: pool ${pool.dex} 極端波動（vol=${(bb.volatility30D * 100).toFixed(0)}%），No-Go`);
            delete appState.strategies[pool.id.toLowerCase()];
            noGoPools.push(`${pool.dex} ${pool.id.slice(0, 8)}… (extreme vol)`);
            continue;
        }

        // ── Track 2+3：ATR 下限 + Percentile 天花板 ─────────────────────────
        const guards = computeRangeGuards(rawReturns);

        // ── Track 1（ATR 倍數反推 sigma）────────────────────────────────────
        const stdDev1H = bb.stdDev1H ?? (bb.sma * bb.volatility30D / Math.sqrt(8760));
        const sigmas = getAtrSigmaCandidates(guards.atrHalfWidth, stdDev1H);
        if (sigmas.length === 0) {
            log.warn(`MCEngine: pool ${pool.dex} ATR 或 stdDev1H 無效，跳過`);
            continue;
        }
        log.info(
            `MCEngine: pool ${pool.dex} ATR=${guards.atrHalfWidth.toExponential(3)} ` +
            `stdDev1H=${stdDev1H.toExponential(3)} ` +
            `k=[${ATR_K_CANDIDATES.join(',')}] σ=[${sigmas.map(s => s.toFixed(2)).join(',')}]`
        );

        try {
            // ── Step 1：候選區間評估（同步）─────────────────────────────────
            const candidates = calcCandidateRanges(UNIT_CAPITAL, pool, bb, returns, sigmas, guards);
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

        } catch (err) {
            log.error(`MCEngine: pool ${pool.id.slice(0, 8)} 計算失敗`, { err });
        }
    }

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
}
