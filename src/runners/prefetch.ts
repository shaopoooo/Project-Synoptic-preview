/**
 * prefetch.ts — Phase 0：所有鏈上 / API 非同步呼叫集中於此
 *
 * Phase 0a（市場資料）：token 價格、pool stats、BB bands
 * Phase 0b（倉位資料）：raw positions、fees、gas cost
 *
 * 回傳 CycleData 供 compute.ts 純計算使用；
 * 若 pool 資料取得失敗（critical），回傳 null 中止本週期。
 */
import { CycleData } from '../types';
import { PoolScanner } from '../services/PoolScanner';
import { BBEngine, refreshPriceBuffer } from '../services/BBEngine';
import { FeeFetcher } from '../services/FeeFetcher';
import { positionScanner } from '../services/PositionScanner';
import { fetchTokenPrices } from '../utils/tokenPrices';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { appState, ucPoolList } from '../utils/AppState';
import { feeTierToTickSpacing } from '../utils/math';
import { fetchGasCostUSD } from '../utils/rpcProvider';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('Prefetch');

type AlertFn = (key: string, msg: string) => Promise<void>;

export async function prefetchAll(sendCriticalAlert?: AlertFn): Promise<CycleData | null> {

    // ── Phase 0a：市場資料（可並行）────────────────────────────────────────────
    const [pools] = await Promise.all([
        fetchPools(sendCriticalAlert),
        fetchTokenPrices().catch(e => log.error(`TokenPrices: ${e}`)),
    ]);

    if (!pools) return null; // pool 資料缺失，中止本週期

    // ── Phase 0a：BB bands（需要 pools + 上一輪 positions）─────────────────────
    const bbs = await fetchBBs(pools);

    // ── Phase 0b：倉位資料（需要 pools + bbs 決定費率）──────────────────────────
    const [rawPositions, gasCostUSD] = await Promise.all([
        positionScanner.fetchAll().catch((e) => { log.error(`RawPositions: ${e}`); return []; }),
        fetchGasCostUSD().catch(() => config.DEFAULT_GAS_COST_USD),
    ]);

    // ── Phase 0b：手續費（需要 pools + bbs 計算 aeroPrice / cakePrice）──────────
    const feeMaps = await FeeFetcher.fetchAll(rawPositions, pools, bbs);

    return { pools, bbs, rawPositions, feeMaps, gasCostUSD };
}

// ── 內部輔助函式 ──────────────────────────────────────────────────────────────

async function fetchPools(sendCriticalAlert?: AlertFn) {
    try {
        const pools = await PoolScanner.scanAllCorePools(ucPoolList(appState.userConfig));
        if (pools.length === 0) {
            log.warn('no pools returned — subgraph or RPC error');
            await sendCriticalAlert?.('pool_scanner_empty', 'PoolScanner 無法取得任何池子資料，請確認 RPC / DexScreener 連線狀態。');
            return null;
        }
        pools.sort((a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0)));
        const top = pools[0];
        const topTvl = top.tvlUSD >= 1000 ? `$${(top.tvlUSD / 1000).toFixed(0)}K` : `$${top.tvlUSD.toFixed(0)}`;
        log.info(`✅ pools(${pools.length})  top: ${top.dex} ${(top.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}% — APR ${(top.apr * 100).toFixed(1)}%  TVL ${topTvl}`);
        return pools;
    } catch (e) {
        log.error(`PoolScanner: ${e}`);
        return null;
    }
}

async function fetchBBs(pools: Awaited<ReturnType<typeof fetchPools>> & object) {
    const bbs: Record<string, import('../types').BBResult> = { ...appState.bbs };
    try {
        const poolsToProcess = new Map<string, typeof pools[number]>();
        for (const pos of appState.positions) {
            const poolData = pools.find(
                p => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
            );
            if (poolData) poolsToProcess.set(poolData.id.toLowerCase(), poolData);
        }
        for (const [poolAddress, poolData] of poolsToProcess.entries()) {
            const posTickSpacing = feeTierToTickSpacing(poolData.feeTier);
            const avg30D = bandwidthTracker.getAvg(poolAddress);
            const bb = await BBEngine.computeDynamicBB(poolData.id, poolData.dex, posTickSpacing, poolData.tick, avg30D);
            if (bb) bbs[poolAddress] = bb;
        }
        log.info(`✅ BB bands computed for ${poolsToProcess.size} pool(s)`);
    } catch (e) {
        log.error(`BBEngine: ${e}`);
    }
    return bbs;
}
