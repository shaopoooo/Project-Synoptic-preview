import { PoolScanner } from '../services/PoolScanner';
import { BBEngine } from '../services/BBEngine';
import { fetchTokenPrices } from '../utils/tokenPrices';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { appState, ucPoolList } from '../utils/AppState';
import { feeTierToTickSpacing } from '../utils/math';
import { createServiceLogger } from '../utils/logger';
import type { PoolStats } from '../types';

const log = createServiceLogger('MarketData');

type AlertFn = (key: string, msg: string) => Promise<void>;

export async function runTokenPriceFetcher(): Promise<void> {
    try {
        await fetchTokenPrices();
    } catch (e) {
        log.error(`TokenPriceFetcher: ${e}`);
    }
}

export async function runPoolScanner(sendCriticalAlert?: AlertFn): Promise<void> {
    try {
        const pools = await PoolScanner.scanAllCorePools(ucPoolList(appState.userConfig));
        if (pools.length === 0) {
            log.warn('no pools returned — subgraph or RPC error');
            await sendCriticalAlert?.('pool_scanner_empty', 'PoolScanner 無法取得任何池子資料，請確認 RPC / DexScreener 連線狀態。');
            return;
        }
        pools.sort((a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0)));
        appState.pools = pools;
        appState.lastUpdated.poolScanner = Date.now();
        const top = appState.pools[0];
        const topTvl = top.tvlUSD >= 1000 ? `$${(top.tvlUSD / 1000).toFixed(0)}K` : `$${top.tvlUSD.toFixed(0)}`;
        log.info(`✅ pools(${appState.pools.length})  top: ${top.dex} ${(top.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}% — APR ${(top.apr * 100).toFixed(1)}%  TVL ${topTvl}`);
    } catch (error) {
        log.error(`PoolScanner: ${error}`);
    }
}

export async function runBBEngine(): Promise<void> {
    try {
        const poolsToProcess = new Map<string, PoolStats>();

        for (const pos of appState.positions) {
            const poolData = appState.pools.find(
                (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
            );
            if (poolData) poolsToProcess.set(poolData.id.toLowerCase(), poolData);
        }

        for (const [poolAddress, poolData] of poolsToProcess.entries()) {
            const posTickSpacing = feeTierToTickSpacing(poolData.feeTier);
            const avg30D = bandwidthTracker.getAvg(poolAddress);
            const bb = await BBEngine.computeDynamicBB(poolData.id, poolData.dex, posTickSpacing, poolData.tick, avg30D);
            if (bb) appState.bbs[poolAddress] = bb;
        }
        appState.lastUpdated.bbEngine = Date.now();
        log.info(`✅ BB bands computed for ${poolsToProcess.size} pool(s)`);
    } catch (error) {
        log.error(`BBEngine: ${error}`);
    }
}
