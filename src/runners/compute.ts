/**
 * compute.ts — Phase 1：純計算，禁止任何 await / RPC / API
 *
 * 接收 CycleData（Phase 0 輸出），回傳 CycleResult。
 * 計算順序：aggregate → PnL → Risk → Rebalance
 */
import { CycleData, CycleResult, PositionState } from '../types';
import { PositionAggregator } from '../services/PositionAggregator';
import { RiskManager } from '../services/RiskManager';
import { RebalanceService } from '../services/rebalance';
import { PnlCalculator } from '../services/PnlCalculator';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('Compute');

export function computeAll(data: CycleData): CycleResult {
    const assembled = PositionAggregator.aggregateAll(data.rawPositions, data.feeMaps, data.bbs, data.pools);

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
        const poolData = data.pools.find(
            p => p.id.toLowerCase() === rec.poolAddress.toLowerCase() && p.dex === rec.dex
        );
        if (!poolData) continue;
        const bb = data.bbs[poolData.id.toLowerCase()];
        if (!bb) continue;

        const poolKey = poolData.id.toLowerCase();
        const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
        const avg30DBandwidth = bandwidthTracker.update(poolKey, currentBandwidth);

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
