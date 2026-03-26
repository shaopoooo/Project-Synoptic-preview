import pLimit from 'p-limit';
import { FetchedFees, RawChainPosition, PoolStats, BBResult } from '../types';
import { FeeCalculator } from './FeeCalculator';
import { config } from '../config';
import { appState, ucWalletAddresses } from '../utils/AppState';
import { createServiceLogger } from '../utils/logger';
import { getTokenPrices } from '../utils/tokenPrices';

const log = createServiceLogger('FeeFetcher');

export class FeeFetcher {

    /**
     * Phase 0b — 批次取得所有倉位的未領手續費與第三方獎勵。
     * 結果以 tokenId 為 key 回傳，供 PositionAggregator.aggregateAll 純計算使用。
     */
    static async fetchAll(
        rawPositions: RawChainPosition[],
        pools: PoolStats[],
        bbs: Record<string, BBResult>,
    ): Promise<Map<string, FetchedFees>> {
        const limit = pLimit(config.AGGREGATE_CONCURRENCY);
        const results = new Map<string, FetchedFees>();

        const tasks = rawPositions.map((raw) => limit(async () => {
            const poolKey = raw.poolAddress.toLowerCase();
            const poolStats = pools.find(p => p.id.toLowerCase() === poolKey && p.dex === raw.dex);
            if (!poolStats) {
                log.warn(`#${raw.tokenId} no poolStats — skipping fee fetch`);
                return;
            }

            const bb = bbs[poolKey] ?? null;
            const npmAddress = config.NPM_ADDRESSES[raw.dex];
            const ownerIsWallet = ucWalletAddresses(appState.userConfig).some(
                w => w.toLowerCase() === raw.owner.toLowerCase()
            );

            try {
                const feeResult = await FeeCalculator.fetchUnclaimedFees(
                    raw.tokenId, raw.dex, raw.owner, ownerIsWallet, raw.poolAddress,
                    raw.position, poolStats.tick, raw.isStaked, npmAddress,
                );

                const fallback = getTokenPrices();
                const rewardsResult = await FeeCalculator.fetchThirdPartyRewards(
                    raw.tokenId, raw.dex, raw.owner, ownerIsWallet, raw.poolAddress,
                    raw.isStaked, feeResult.depositorWallet,
                    bb?.aeroPrice ?? fallback.aeroPrice,
                    bb?.cakePrice ?? fallback.cakePrice,
                    feeResult.gaugeAddress,
                );

                results.set(raw.tokenId, {
                    unclaimed0: feeResult.unclaimed0,
                    unclaimed1: feeResult.unclaimed1,
                    unclaimed2: rewardsResult.unclaimed2,
                    fees2USD: rewardsResult.fees2USD,
                    token2Symbol: rewardsResult.token2Symbol,
                    depositorWallet: rewardsResult.depositorWallet || feeResult.depositorWallet,
                    gaugeAddress: feeResult.gaugeAddress,
                });
            } catch (e) {
                log.error(`#${raw.tokenId} fee fetch failed: ${e}`);
            }
        }));

        await Promise.allSettled(tasks);
        log.info(`✅ fees fetched: ${results.size}/${rawPositions.length} position(s)`);
        return results;
    }
}
