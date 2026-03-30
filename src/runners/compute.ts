/**
 * compute.ts — Phase 1：純計算，禁止任何 await / RPC / API
 *
 * 接收 CycleData（Phase 0 輸出），回傳 CycleResult。
 * 計算順序：aggregate → PnL → Risk → Rebalance
 */
import { CycleData, CycleResult, PositionState } from '../types';
import { PositionAggregator } from '../services/position/PositionAggregator';
import { RiskManager } from '../services/strategy/RiskManager';
import { RebalanceService } from '../services/strategy/rebalance';
import { PnlCalculator } from '../services/strategy/PnlCalculator';
import { createServiceLogger } from '../utils/logger';
import { logCalc } from '../utils/logger';
import { appState } from '../utils/AppState';

const log = createServiceLogger('Compute');

export function computeAll(data: CycleData): CycleResult {
    const assembled = PositionAggregator.aggregateAll(data.rawPositions, data.feeMaps, data.marketSnapshots, data.pools);

    for (const rec of assembled) {
        // ── PnL ──────────────────────────────────────────────────────────────
        rec.initialCapital = PnlCalculator.getInitialCapital(rec.tokenId);
        const exactIL = PnlCalculator.calculateAbsolutePNL(rec.tokenId, rec.positionValueUSD, rec.unclaimedFeesUSD);
        rec.ilUSD = exactIL;
        const openInfo = PnlCalculator.calculateOpenInfo(rec.tokenId, rec.openTimestampMs, exactIL);
        if (openInfo) {
            rec.openedDays = openInfo.days;
            rec.openedHours = openInfo.hours;
            rec.profitRate = openInfo.profitRate;
        }

        // ── Risk + Rebalance（需要 poolData + bb）────────────────────────────
        const poolData = appState.findPool(rec.poolAddress, rec.dex)
            ?? data.pools.find(p => p.id.toLowerCase() === rec.poolAddress.toLowerCase() && p.dex === rec.dex);
        if (!poolData) {
            data.warnings.push(`compute: #${rec.tokenId} 找不到 poolData，跳過 Risk/Rebalance`);
            continue;
        }
        const bb = data.marketSnapshots[poolData.id.toLowerCase()];
        if (!bb) continue;

        const poolKey = poolData.id.toLowerCase();
        const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
        const avg30DBandwidth = data.bandwidthAvg30D.get(poolKey) ?? currentBandwidth;

        const positionState: PositionState = {
            capital: rec.positionValueUSD,
            tickLower: rec.tickLower,
            tickUpper: rec.tickUpper,
            unclaimedFees: rec.unclaimedFeesUSD,
            cumulativeIL: rec.ilUSD ?? 0,
        };

        const risk = RiskManager.analyzePosition(
            positionState, bb, poolData.dailyFeesUSD, avg30DBandwidth, currentBandwidth, data.gasCostUSD, poolData.tvlUSD
        );
        rec.riskAnalysis = risk;
        rec.overlapPercent = risk.driftOverlapPct;
        rec.breakevenDays = risk.ilBreakevenDays;
        rec.healthScore = risk.healthScore;

        logCalc({
            phase: 'P1',
            layer: 'POSITION',
            event: 'position_risk',
            tokenId: rec.tokenId,
            pool: rec.poolAddress.slice(0, 10),
            dex: rec.dex,
            positionValueUSD: rec.positionValueUSD,
            unclaimedFeesUSD: rec.unclaimedFeesUSD,
            ilUSD: rec.ilUSD ?? null,
            openedDays: rec.openedDays ?? null,
            profitRate: rec.profitRate ?? null,
            currentBandwidth,
            avg30DBandwidth,
            driftOverlapPct: risk.driftOverlapPct,
            driftWarning: risk.driftWarning,
            ilBreakevenDays: risk.ilBreakevenDays,
            healthScore: risk.healthScore,
            redAlert: risk.redAlert,
            highVolatilityAvoid: risk.highVolatilityAvoid,
            compoundSignal: risk.compoundSignal ?? null,
            compoundThreshold: risk.compoundThreshold ?? null,
            compoundIntervalDays: risk.compoundIntervalDays ?? null,
        });

        const rb = RebalanceService.getRebalanceSuggestion(
            parseFloat(rec.currentPriceStr),
            bb,
            rec.unclaimedFeesUSD,
            rec.breakevenDays,
            rec.positionValueUSD,
            rec.token0Symbol,
            rec.token1Symbol,
            data.gasCostUSD,
            parseFloat(rec.bbMinPrice ?? '0'),
            parseFloat(rec.bbMaxPrice ?? '0'),
        );
        rec.rebalance = rb ?? undefined;
    }

    log.info(`✅ compute done: ${assembled.length} position(s) enriched`);
    return { positions: assembled };
}
