/**
 * prefetch.ts — Phase 0：所有鏈上 / API 非同步呼叫集中於此
 *
 * Phase 0a（市場資料）：token 價格、pool stats、BB bands
 * Phase 0b（倉位資料）：raw positions、fees、gas cost
 *
 * 回傳 CycleData 供 compute.ts 純計算使用；
 * 若 pool 資料取得失敗（critical），回傳 null 中止本週期。
 */
import { CycleData, HourlyReturn } from '../types';
import { PoolScanner } from '../services/market/PoolScanner';
import { PoolMarketService, fetchHistoricalReturns, refreshPriceBuffer } from '../services/market/PoolMarketService';
import { loadOhlcvStore, type RawCandle } from '../services/market/HistoricalDataService';
import { FeeFetcher } from '../services/dex/FeeFetcher';
import { positionScanner } from '../services/position/PositionScanner';
import { fetchTokenPrices, getTokenPrices } from '../services/market/TokenPriceService';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { logCalc } from '../utils/logger';
import { appState, ucPoolList } from '../utils/AppState';
import { feeTierToTickSpacing } from '../utils/math';
import { fetchGasCostUSD } from '../utils/rpcProvider';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('Prefetch');

type AlertFn = (key: string, msg: string) => Promise<void>;

export async function prefetchAll(sendCriticalAlert?: AlertFn): Promise<CycleData | null> {
    const warnings: string[] = [];

    // ── Phase 0a：市場資料（可並行）────────────────────────────────────────────
    const [pools, tokenPricesResult] = await Promise.all([
        fetchPools(sendCriticalAlert),
        fetchTokenPrices().catch((e: any) => {
            const msg = `TokenPrices 取得失敗: ${e}`;
            log.fatal(msg);
            warnings.push(msg);
            // 優先使用模組內上一輪快取（單幣 API 失敗時已在 TokenPriceService 內 fallback）
            const cached = getTokenPrices();
            if (cached.ethPrice > 0 && cached.cbbtcPrice > 0) {
                log.warn(`TokenPrices: 使用上一輪快取繼續本週期（ETH $${cached.ethPrice} cbBTC $${cached.cbbtcPrice}）`);
                return cached;
            }
            return null; // 連快取也沒有，本週期無法繼續
        }),
    ]);

    if (!pools) return null; // pool 資料缺失，中止本週期

    if (!tokenPricesResult) {
        await sendCriticalAlert?.('token_prices_unavailable',
            'TokenPrices 抓取失敗且無歷史快取，本週期中止。USD 計算（PnL / IL / 費用）將完全錯誤，拒絕執行。');
        return null;
    }
    const tokenPrices = tokenPricesResult;

    // ── cycle_start log ───────────────────────────────────────────────────────
    logCalc({
        phase: 'P0',
        layer: 'CYCLE',
        event: 'cycle_start',
        poolCount: pools.length,
        ethPrice: tokenPrices.ethPrice,
        cbbtcPrice: tokenPrices.cbbtcPrice,
        cakePrice: tokenPrices.cakePrice,
        aeroPrice: tokenPrices.aeroPrice,
        ethFetchedAt: tokenPrices.ethFetchedAt,
    });

    // ── Phase 0a：BB bands（需要 pools + 上一輪 positions）─────────────────────
    const { marketSnapshots, warnings: bbWarnings } = await fetchBBs(pools);
    warnings.push(...bbWarnings);

    // ── Phase 0b：倉位資料（需要 pools + marketSnapshots 決定費率）──────────────────────────
    const [rawPositions, gasCostUSD] = await Promise.all([
        positionScanner.fetchAll().catch((e) => {
            const msg = `RawPositions 取得失敗: ${e}`;
            log.error(msg);
            warnings.push(msg);
            return [];
        }),
        fetchGasCostUSD().catch((e) => {
            warnings.push(`GasCost 取得失敗，使用預設值: ${e}`);
            return config.DEFAULT_GAS_COST_USD;
        }),
    ]);

    // ── Phase 0b：手續費（需要 pools + marketSnapshots 計算 aeroPrice / cakePrice）──────────
    const { feeMaps, warnings: feeWarnings } = await FeeFetcher.fetchAll(rawPositions, pools, marketSnapshots);
    warnings.push(...feeWarnings);

    // ── Phase 0a：更新 bandwidth tracker（BB 已就緒，Phase 1 不得再寫 tracker）──
    const bandwidthAvg30D = updateBandwidthAvg(marketSnapshots);

    // ── Phase 0b：歷史報酬率（MC 引擎用，序列＋ jitter 避免 GeckoTerminal 429）───
    const { returns: historicalReturns, warnings: hrWarnings } = await fetchHistoricalReturnsForPools(pools);
    warnings.push(...hrWarnings);

    return { pools, marketSnapshots, tokenPrices, rawPositions, feeMaps, gasCostUSD, historicalReturns, bandwidthAvg30D, warnings };
}

// ── 內部輔助函式 ──────────────────────────────────────────────────────────────

/** 將 HistoricalDataService 的 RawCandle[] 轉為 HourlyReturn[] */
function ohlcvToHourlyReturnsFromRaw(candles: RawCandle[]): HourlyReturn[] {
    return candles.slice(1).map((c, i) => ({
        ts:     c.ts,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume,
        r:      Math.log(c.close / candles[i].close),
    }));
}

async function fetchPools(sendCriticalAlert?: AlertFn) {
    try {
        const pools = await PoolScanner.scanAllCorePools(ucPoolList(appState.userConfig));
        if (pools.length === 0) {
            log.fatal('no pools returned — subgraph or RPC error');
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

async function fetchHistoricalReturnsForPools(
    pools: NonNullable<Awaited<ReturnType<typeof fetchPools>>>,
): Promise<{ returns: Map<string, HourlyReturn[]>; warnings: string[] }> {
    const returns = new Map<string, HourlyReturn[]>();
    const warnings: string[] = [];

    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const poolKey = pool.id.toLowerCase();
        let usedLocalOhlcv = false;

        try {
            // 優先讀取本地 OHLCV（Phase 0.5 回填的數據）
            const store = await loadOhlcvStore(poolKey);
            if (store && store.candles.length > 2) {
                const hrs = ohlcvToHourlyReturnsFromRaw(store.candles);
                if (hrs.length > 0) {
                    returns.set(poolKey, hrs);
                    log.debug(`HistoricalReturns: pool ${pool.dex} ${poolKey.slice(0, 8)} — 從本地 OHLCV 讀取 ${hrs.length} 筆`);
                    usedLocalOhlcv = true;
                }
            }

            if (!usedLocalOhlcv) {
                // Fallback: GeckoTerminal API
                const r = await fetchHistoricalReturns(pool.id, pool.dex);
                if (r.length > 0) returns.set(poolKey, r);
                else warnings.push(`HistoricalReturns: pool ${pool.dex} ${pool.id.slice(0, 8)} 回傳空陣列`);
            }
        } catch (e) {
            const msg = `HistoricalReturns: pool ${pool.id.slice(0, 8)} 抓取失敗: ${e}`;
            log.warn(msg);
            warnings.push(msg);
        }

        // GeckoTerminal fallback 才需要 jitter（本地讀取不需要延遲）
        if (!usedLocalOhlcv && i < pools.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
        }
    }
    log.info(`✅ HistoricalReturns fetched for ${returns.size}/${pools.length} pool(s)`);
    return { returns, warnings };
}

function updateBandwidthAvg(
    marketSnapshots: Record<string, import('../types').MarketSnapshot>,
): Map<string, number> {
    const result = new Map<string, number>();
    for (const [poolKey, bb] of Object.entries(marketSnapshots)) {
        if (!bb.sma || bb.sma <= 0) continue;
        const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
        const avg = bandwidthTracker.update(poolKey, currentBandwidth);
        result.set(poolKey, avg);
    }
    return result;
}

async function fetchBBs(
    pools: Awaited<ReturnType<typeof fetchPools>> & object,
): Promise<{ marketSnapshots: Record<string, import('../types').MarketSnapshot>; warnings: string[] }> {
    const marketSnapshots: Record<string, import('../types').MarketSnapshot> = { ...appState.marketSnapshots };
    const warnings: string[] = [];
    try {
        // 對所有已設定的池子計算 BB，不限於有倉位的池子
        for (const poolData of pools) {
            const poolAddress = poolData.id.toLowerCase();
            const tickSpacing = feeTierToTickSpacing(poolData.feeTier);
            const avg30D = bandwidthTracker.getAvg(poolAddress);
            const bb = await PoolMarketService.computeDynamicBB(poolData.id, poolData.dex, tickSpacing, poolData.tick, avg30D);
            if (bb) {
                marketSnapshots[poolAddress] = bb;
                logCalc({
                    phase: 'P0',
                    layer: 'POOL',
                    event: 'pool_bb',
                    pool: poolAddress.slice(0, 10),
                    dex: poolData.dex,
                    feeTier: poolData.feeTier,
                    sma: bb.sma,
                    upperPrice: bb.upperPrice,
                    lowerPrice: bb.lowerPrice,
                    bandwidth: bb.sma > 0 ? (bb.upperPrice - bb.lowerPrice) / bb.sma : null,
                    volatility30D: bb.volatility30D,
                    stdDev1H: bb.stdDev1H ?? null,
                    smaSlope: bb.smaSlope ?? null,
                    isFallback: bb.isFallback ?? false,
                    isWarmup: bb.isWarmup ?? false,
                    k: bb.k ?? null,
                });
            } else {
                const msg = `BB bands 計算失敗: pool ${poolData.dex} ${poolAddress.slice(0, 8)}`;
                log.warn(msg);
                warnings.push(msg);
            }
        }
        log.info(`✅ BB bands computed for ${pools.length} pool(s)`);
    } catch (e) {
        const msg = `PoolMarketService 例外: ${e}`;
        log.error(msg);
        warnings.push(msg);
    }
    return { marketSnapshots, warnings };
}
