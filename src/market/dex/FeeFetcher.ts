import pLimit from 'p-limit';
import { FetchedFees, RawChainPosition, PoolStats, MarketSnapshot } from '../../types';
import { FeeCalculator } from './FeeCalculator';
import { config } from '../../config';
import { appState, ucWalletAddresses } from '../../infra/AppState';
import { createServiceLogger } from '../../infra/logger';
import { getTokenPrices } from '../TokenPriceService';

const log = createServiceLogger('FeeFetcher');

export class FeeFetcher {

    /**
     * Phase 0b — 批次取得所有倉位的未領手續費與第三方獎勵。
     * 結果以 tokenId 為 key 回傳，供 PositionAggregator.aggregateAll 純計算使用。
     */
    static async fetchAll(
        rawPositions: RawChainPosition[],
        pools: PoolStats[],
        marketSnapshots: Record<string, MarketSnapshot>,
    ): Promise<{ feeMaps: Map<string, FetchedFees>; warnings: string[] }> {
        const limit = pLimit(config.AGGREGATE_CONCURRENCY);
        const feeMaps = new Map<string, FetchedFees>();
        const warnings: string[] = [];

        const tasks = rawPositions.map((raw) => limit(async () => {
            const poolKey = raw.poolAddress.toLowerCase();
            const poolStats = pools.find(p => p.id.toLowerCase() === poolKey && p.dex === raw.dex);
            if (!poolStats) {
                const msg = `#${raw.tokenId} 找不到對應 poolStats，跳過手續費抓取`;
                log.warn(msg);
                warnings.push(msg);
                return;
            }

            const bb = marketSnapshots[poolKey] ?? null;
            const npmAddress = config.NPM_ADDRESSES[raw.dex];
            const ownerIsWallet = ucWalletAddresses(appState.userConfig).some(
                w => w.toLowerCase() === raw.owner.toLowerCase()
            );

            try {
                // 巨量 Payload 傾印 (Trace)：查看 NonfungiblePositionManager 回傳的原始合約物件
                log.trace(`[FeeFetcher] Raw position payload for #${raw.tokenId}: %o`, raw);
                
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

                feeMaps.set(raw.tokenId, {
                    unclaimed0: feeResult.unclaimed0,
                    unclaimed1: feeResult.unclaimed1,
                    unclaimed2: rewardsResult.unclaimed2,
                    fees2USD: rewardsResult.fees2USD,
                    token2Symbol: rewardsResult.token2Symbol,
                    depositorWallet: rewardsResult.depositorWallet || feeResult.depositorWallet,
                    gaugeAddress: feeResult.gaugeAddress,
                });
            } catch (e) {
                const msg = `#${raw.tokenId} 手續費抓取失敗: ${e}`;
                log.error(msg);
                warnings.push(msg);
            }
        }));

        await Promise.allSettled(tasks);
        log.info(`✅ fees fetched: ${feeMaps.size}/${rawPositions.length} position(s)`);
        return { feeMaps, warnings };
    }
}
