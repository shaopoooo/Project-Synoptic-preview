import { positionScanner } from '../services/PositionScanner';
import { PositionAggregator } from '../services/PositionAggregator';
import { RiskManager } from '../services/RiskManager';
import { RebalanceService } from '../services/rebalance';
import { PnlCalculator } from '../services/PnlCalculator';
import { fetchGasCostUSD } from '../utils/rpcProvider';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { appState } from '../utils/AppState';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import type { PositionState } from '../types';

const log = createServiceLogger('Positions');

type AlertFn = (key: string, msg: string) => Promise<void>;

export async function runPositionScanner(sendCriticalAlert?: AlertFn): Promise<void> {
    try {
        const rawPositions = await positionScanner.fetchAll();
        const assembled = await PositionAggregator.aggregateAll(rawPositions, appState.bbs, appState.pools);

        // PnL enrichment — computed here because assembler is scope-limited to USD values
        for (const rec of assembled) {
            rec.initialCapital = PnlCalculator.getInitialCapital(rec.tokenId);
            const exactIL = PnlCalculator.calculateAbsolutePNL(rec.tokenId, rec.positionValueUSD, rec.unclaimedFeesUSD);
            rec.ilUSD = exactIL;
            const openInfo = PnlCalculator.calculateOpenInfo(rec.tokenId, rec.openTimestampMs, exactIL);
            if (openInfo) {
                rec.openedDays = openInfo.days;
                rec.openedHours = openInfo.hours;
                rec.profitRate = openInfo.profitRate;
            }
        }

        positionScanner.updatePositions(assembled);

        const positions = positionScanner.getTrackedPositions();
        appState.positions = positions.filter((p) => Number(p.liquidity) > 0);
        appState.lastUpdated.positionScanner = Date.now();
        log.info(`✅ positions  active ${appState.positions.length}/${positions.length} tracked`);

        appState.pruneStaleBBs();
    } catch (error) {
        log.error(`PositionScanner: ${error}`);
        await sendCriticalAlert?.('position_scanner_failed', `所有倉位掃描失敗，本週期資料未更新。\n錯誤: ${error}`);
    }
}

export async function runRiskManager(): Promise<void> {
    try {
        const gasCostUSD = await fetchGasCostUSD().catch(() => config.DEFAULT_GAS_COST_USD);
        for (const pos of appState.positions) {
            const poolData = appState.pools.find(
                (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
            );
            if (!poolData) continue;

            const bb = appState.bbs[poolData.id.toLowerCase()];
            if (!bb) continue;

            const poolKey = poolData.id.toLowerCase();
            const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
            const avg30DBandwidth = bandwidthTracker.update(poolKey, currentBandwidth);

            const positionState: PositionState = {
                capital: pos.positionValueUSD,
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                unclaimedFees: pos.unclaimedFeesUSD,
                cumulativeIL: pos.ilUSD ?? 0,
            };

            const risk = RiskManager.analyzePosition(
                positionState, bb, poolData.dailyFeesUSD, avg30DBandwidth, currentBandwidth, gasCostUSD, poolData.tvlUSD
            );

            pos.riskAnalysis = risk;
            pos.overlapPercent = risk.driftOverlapPct;
            pos.breakevenDays = risk.ilBreakevenDays;
            pos.healthScore = risk.healthScore;

            // Rebalance — computed after risk so breakevenDays is the correct analysed value
            const rb = RebalanceService.getRebalanceSuggestion(
                parseFloat(pos.currentPriceStr),
                bb,
                pos.unclaimedFeesUSD,
                pos.breakevenDays,
                pos.positionValueUSD,
                pos.token0Symbol,
                pos.token1Symbol,
                gasCostUSD,
                parseFloat(pos.bbMinPrice || '0'),
                parseFloat(pos.bbMaxPrice || '0'),
            );
            pos.rebalance = rb ?? undefined;
        }
        appState.lastUpdated.riskManager = Date.now();
        log.info(`✅ risk analysis updated for ${appState.positions.length} position(s)`);

        // Log snapshots after both BBEngine and RiskManager have enriched positions
        const bbForLog = appState.positions[0]
            ? (appState.bbs[appState.positions[0].poolAddress.toLowerCase()] ?? null)
            : null;
        await positionScanner.logSnapshots(appState.positions, bbForLog, appState.bbKLowVol, appState.bbKHighVol);
    } catch (error) {
        log.error(`RiskManager: ${error}`);
    }
}
