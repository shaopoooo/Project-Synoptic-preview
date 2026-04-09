/**
 * prefetch.ts — Phase 0：市場資料抓取
 *
 * 只抓 MC 引擎需要的：pools、token prices、BB bands、歷史報酬率。
 * 回傳 CycleData 供 mcEngine 使用。
 */
import { CycleData, HourlyReturn } from '../types';
import { PoolScanner } from '../services/market/PoolScanner';
import { PoolMarketService, fetchHistoricalReturns } from '../services/market/PoolMarketService';
import { loadOhlcvStore, type RawCandle } from '../services/market/HistoricalDataService';
import { fetchTokenPrices, getTokenPrices } from '../services/market/TokenPriceService';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { logCalc } from '../utils/logger';
import { appState, ucPoolList } from '../utils/AppState';
import { feeTierToTickSpacing } from '../utils/math';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('Prefetch');

type AlertFn = (key: string, msg: string) => Promise<void>;

export async function prefetchAll(sendCriticalAlert?: AlertFn): Promise<CycleData | null> {
    const warnings: string[] = [];

    const [pools, tokenPrices] = await Promise.all([
        fetchPools(sendCriticalAlert),
        fetchTokenPrices().catch(() => {
            const cached = getTokenPrices();
            return (cached.ethPrice > 0 && cached.cbbtcPrice > 0) ? cached : null;
        }),
    ]);

    if (!pools || !tokenPrices) return null;

    const { marketSnapshots, warnings: bbWarnings } = await fetchBBs(pools);
    warnings.push(...bbWarnings);

    const { returns: historicalReturns, warnings: hrWarnings } = await fetchHistoricalReturnsForPools(pools);
    warnings.push(...hrWarnings);

    return { pools, marketSnapshots, tokenPrices, historicalReturns, warnings };
}

// ── 內部輔助 ─────────────────────────────────────────────────────────────────

function ohlcvToHourlyReturnsFromRaw(candles: RawCandle[]): HourlyReturn[] {
    return candles.slice(1).map((c, i) => ({
        ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        r: Math.log(c.close / candles[i].close),
    }));
}

async function fetchPools(sendCriticalAlert?: AlertFn) {
    try {
        const pools = await PoolScanner.scanAllCorePools(ucPoolList(appState.userConfig));
        if (pools.length === 0) {
            await sendCriticalAlert?.('pool_scanner_empty', 'PoolScanner 無法取得任何池子資料');
            return null;
        }
        pools.sort((a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0)));
        log.info(`✅ pools(${pools.length})`);
        return pools;
    } catch (e) {
        log.error(`PoolScanner: ${e}`);
        return null;
    }
}

async function fetchHistoricalReturnsForPools(
    pools: NonNullable<Awaited<ReturnType<typeof fetchPools>>>,
): Promise<{ returns: Map<string, HourlyReturn[]>; warnings: string[] }> {
    const returns = new Map<string, HourlyReturn[]>();
    const warnings: string[] = [];

    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const poolKey = pool.id.toLowerCase();
        let usedLocal = false;

        try {
            const store = await loadOhlcvStore(poolKey);
            if (store && store.candles.length > 2) {
                const hrs = ohlcvToHourlyReturnsFromRaw(store.candles);
                if (hrs.length > 0) { returns.set(poolKey, hrs); usedLocal = true; }
            }
            if (!usedLocal) {
                const r = await fetchHistoricalReturns(pool.id, pool.dex);
                if (r.length > 0) returns.set(poolKey, r);
            }
        } catch (e) {
            warnings.push(`HistoricalReturns: pool ${pool.id.slice(0, 8)} 失敗: ${e}`);
        }

        if (!usedLocal && i < pools.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
        }
    }
    log.info(`✅ HistoricalReturns ${returns.size}/${pools.length}`);
    return { returns, warnings };
}

async function fetchBBs(
    pools: Awaited<ReturnType<typeof fetchPools>> & object,
): Promise<{ marketSnapshots: Record<string, import('../types').MarketSnapshot>; warnings: string[] }> {
    const marketSnapshots: Record<string, import('../types').MarketSnapshot> = { ...appState.marketSnapshots };
    const warnings: string[] = [];
    for (const poolData of pools) {
        const poolAddress = poolData.id.toLowerCase();
        const tickSpacing = feeTierToTickSpacing(poolData.feeTier);
        const avg30D = bandwidthTracker.getAvg(poolAddress);
        const bb = await PoolMarketService.computeDynamicBB(poolData.id, poolData.dex, tickSpacing, poolData.tick, avg30D);
        if (bb) {
            marketSnapshots[poolAddress] = bb;
        } else {
            warnings.push(`BB 失敗: ${poolData.dex} ${poolAddress.slice(0, 8)}`);
        }
    }
    return { marketSnapshots, warnings };
}
