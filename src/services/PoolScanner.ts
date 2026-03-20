import { ethers } from 'ethers';
import axios from 'axios';
import { poolVolCache } from '../utils/cache';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay, nextProvider, geckoRequest } from '../utils/rpcProvider';
import { PoolStats, Dex } from '../types';
import { POOL_ADDRESS_RE, POOL_V4_ID_RE } from '../utils/validation';
import { getTokenPrices } from '../utils/tokenPrices';


const log = createServiceLogger('PoolScanner');


const VOL_CACHE_TTL_MS = config.POOL_VOL_CACHE_TTL_MS;

interface VolResult { daily: number; avg7d: number; source: string; }

/**
 * Fetch 7-day volume data for a pool.
 * Order: The Graph (DEX-specific) → GeckoTerminal → stale cache → zeros
 */
async function fetchPoolVolume(poolAddress: string, dex: Dex): Promise<VolResult> {
    const key = poolAddress.toLowerCase();
    const cached = poolVolCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached;

    const tag = poolAddress.slice(0, 10);
    const save = (daily: number, avg7d: number, src: string) => {
        const entry = { daily, avg7d, source: src, expiresAt: Date.now() + VOL_CACHE_TTL_MS };
        poolVolCache.set(key, entry);
        log.info(`💾 vol  ${tag}  $${daily.toFixed(0)}/24h  [${src}]`);
        return entry;
    };

    // Aerodrome 等無 subgraph 端點的 DEX，直接跳至 GeckoTerminal
    if (!config.SUBGRAPHS[dex]) {
        log.info(`⏭  no subgraph for ${dex}, skip to GeckoTerminal`);
    } else try {
        // 🔥 終極大招：同時查詢 Uniswap 舊格式與 Messari 新格式
        const query = `{
            uniswapFormat: poolDayDatas(first: 7, orderBy: date, orderDirection: desc, where: { pool: "${key}" }) {
                volumeUSD
            }
            messariFormat: liquidityPoolDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc, where: { pool: "${key}" }) {
                dailyVolumeUSD
            }
        }`;

        const res = await axios.post(config.SUBGRAPHS[dex], { query }, { timeout: 8000 });
        const data = res.data?.data || {};

        // 紀錄回傳內容方便 debug (移除 slice)
        // log.dev(`[PoolScanner] Subgraph Response for ${tag}: ${JSON.stringify(data, null, 2)}`);

        let vols: number[] = [];
        let sourceUsed = '';

        // 判斷哪個格式有回傳資料
        if (data.messariFormat && data.messariFormat.length > 0) {
            vols = data.messariFormat.map((d: any) => parseFloat(d.dailyVolumeUSD));
            sourceUsed = `The Graph (Messari Schema - ${dex})`;
        } else if (data.uniswapFormat && data.uniswapFormat.length > 0) {
            vols = data.uniswapFormat.map((d: any) => parseFloat(d.volumeUSD));
            sourceUsed = `The Graph (Native Schema - ${dex})`;
        }

        if (vols.length > 0) {
            const daily = vols[0];
            const avg7d = vols.reduce((s, v) => s + v, 0) / vols.length;
            return save(daily, avg7d, sourceUsed);
        } else {
            log.warn(`subgraph 0 days for ${tag} (${dex}), falling back to GeckoTerminal`);
        }
    } catch (e: any) {
        log.warn(`subgraph error  ${tag}: ${e.message}`);
    }

    // --- Try 2: GeckoTerminal OHLCV (with 3 retries, exponential backoff) ---
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const geckoRes = await geckoRequest(() => axios.get(
                `${config.API_URLS.GECKOTERMINAL_OHLCV}/${key}/ohlcv/day?limit=7`,
                { 
                  timeout: 8000,
                  headers: { 'User-Agent': config.USER_AGENT }
                }
            ));
            const ohlcvList: any[][] = geckoRes.data?.data?.attributes?.ohlcv_list ?? [];
            if (ohlcvList.length > 0) {
                const daily = parseFloat(ohlcvList[0][5]);
                const avg7d = ohlcvList.reduce((s, c) => s + parseFloat(c[5]), 0) / ohlcvList.length;
                return save(daily, avg7d, 'GeckoTerminal');
            }
            break; // Valid response but no data, don't retry
        } catch (e: any) {
            const is429 = e.response?.status === 429;
            const status = e.response?.status ?? 'err';
            if (attempt < 3) {
                const base = is429 ? 15000 : 5000;
                const backoff = base * attempt + Math.random() * 5000;
                log.warn(`GeckoTerminal ${status}  ${tag}  retry in ${(backoff / 1000).toFixed(1)}s (${attempt}/3)`);
                await delay(backoff);
            } else {
                log.error(`GeckoTerminal failed after 3 attempts  ${tag}: ${e.message}`);
            }
        }
    }

    // --- Fallback: stale cache or zeros ---
    const stale = poolVolCache.get(key);
    if (stale) {
        log.warn(`💾 stale vol cache  ${tag}`);
        return stale;
    }

    return { daily: 0, avg7d: 0, source: 'none' };
}



export class PoolScanner {
    /**
     * Fetch 24h stats for a given pool using On-Chain RPC and DexScreener for Volume.
     * For UniswapV4, poolAddress is the bytes32 poolId; slot0 is read from StateView.
     */
    static async fetchPoolStats(
        poolAddress: string,
        dex: Dex,
        feeTierVal: number
    ): Promise<PoolStats | null> {
        if (!POOL_ADDRESS_RE.test(poolAddress) && !POOL_V4_ID_RE.test(poolAddress)) {
            log.error(`Invalid pool address/id rejected: ${poolAddress}`);
            return null;
        }

        if (dex === 'UniswapV4') {
            return this._fetchV4PoolStats(poolAddress, feeTierVal);
        }

        try {
            // 1. Fetch On-Chain Tick and SqrtPrice
            // Aerodrome Slipstream 的 slot0() 無 feeProtocol 欄位，需使用專屬 ABI
            const poolAbi = dex === 'Aerodrome' ? config.AERO_POOL_ABI : config.POOL_ABI;
            const poolContract = new ethers.Contract(poolAddress, poolAbi, nextProvider());
            const slot0 = await rpcRetry(
                () => poolContract.slot0(),
                `slot0(${poolAddress})`
            );

            const tick = Number(slot0.tick);
            const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);

            // 2. Fetch Volume and TVL from DexScreener API as a free fallback
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/base/${poolAddress}`, { 
                timeout: 8000,
                headers: { 'User-Agent': config.USER_AGENT }
            });

            let tvlUSD = 0;
            let dailyVolumeUSD = 0;
            let apr = 0;
            let dailyFeesUSD = 0;

            if (dexRes.data && dexRes.data.pairs && dexRes.data.pairs.length > 0) {
                const pairData = dexRes.data.pairs[0];
                tvlUSD = parseFloat(pairData.liquidity?.usd || '0');
                dailyVolumeUSD = parseFloat(pairData.volume?.h24 || '0');
            } else {
                log.warn(`DexScreener no pair data  ${poolAddress.slice(0, 10)}`);
            }

            // Aerodrome: DexScreener under-reports TVL (~5x); use on-chain token balances instead
            if (dex === 'Aerodrome') {
                const onChainTVL = await PoolScanner._fetchAerodromeTVL(poolAddress);
                if (onChainTVL !== null && onChainTVL > 0) tvlUSD = onChainTVL;
            }

            // 3. Fetch Volume from The Graph / GeckoTerminal with fallback and caching
            const volData = await fetchPoolVolume(poolAddress, dex);
            const geckoDailyVol = volData.daily;
            const gecko7DVol = volData.avg7d;
            const volSource = volData.source;

            // 4. Volume source: GeckoTerminal OHLCV is primary (covers full DEX activity).
            // DexScreener h24 frequently under-counts volume for concentrated liquidity pools
            // and is only used as last resort when GeckoTerminal returns nothing.
            const verified24hVol = geckoDailyVol > 0 ? geckoDailyVol : dailyVolumeUSD;

            // 5. Blend with 7D average when available
            const avgDailyVolume = gecko7DVol > 0
                ? (verified24hVol + gecko7DVol) / 2
                : verified24hVol;
            dailyFeesUSD = avgDailyVolume * feeTierVal;

            if (tvlUSD > 0) {
                apr = (dailyFeesUSD / tvlUSD) * 365;
            } else {
                log.warn(`TVL=0  ${poolAddress.slice(0, 10)}  APR skipped`);
            }

            // 6. Farm APR (PancakeSwap only — CAKE emissions via MasterChef V3)
            const farmApr = dex === 'PancakeSwapV3' && tvlUSD > 0
                ? await this._fetchPancakeFarmApr(poolAddress, tvlUSD)
                : undefined;

            return {
                id: poolAddress.toLowerCase(),
                dex,
                feeTier: feeTierVal,
                apr,
                farmApr,
                tvlUSD,
                dailyFeesUSD,
                tick,
                sqrtPriceX96,
                volSource,
            };
        } catch (error) {
            log.error(`fetchPoolStats failed  ${poolAddress.slice(0, 10)} (${dex}): ${error}`);
            return null;
        }
    }

    /**
     * Fetch CAKE emission APR for a PancakeSwap V3 pool via MasterChef V3.
     * cakePerSecond from getLatestPeriodInfo is scaled by 1e30.
     * Returns undefined if no active period or contract call fails.
     */
    private static async _fetchPancakeFarmApr(
        poolAddress: string,
        tvlUSD: number,
    ): Promise<number | undefined> {
        try {
            const mc = new ethers.Contract(
                config.PANCAKE_MASTERCHEF_V3,
                config.PANCAKE_MASTERCHEF_V3_ABI,
                nextProvider(),
            );
            const info = await rpcRetry(
                () => mc.getLatestPeriodInfo(poolAddress),
                `getLatestPeriodInfo(${poolAddress.slice(0, 10)})`,
            );
            const endTime = Number(info.endTime);
            if (endTime < Date.now() / 1000) {
                log.info(`🍰 farmApr=0  ${poolAddress.slice(0, 10)}  period expired`);
                return 0;
            }
            // cakePerSecond is stored scaled by 1e30
            const cakePerSec = Number(info.cakePerSecond) / Number(config.MASTERCHEF_CAKE_PER_SEC_PRECISION);
            const { cakePrice } = await import('../utils/tokenPrices').then(m => m.getTokenPrices());
            const farmApr = (cakePerSec * 86400 * 365 * cakePrice) / tvlUSD;
            log.info(`🍰 farmApr  ${poolAddress.slice(0, 10)}  cps=${cakePerSec.toFixed(6)} cake/s  apr=${(farmApr * 100).toFixed(2)}%`);
            return farmApr;
        } catch (e: any) {
            log.warn(`farmApr fetch failed  ${poolAddress.slice(0, 10)}: ${e.message}`);
            return undefined;
        }
    }

    /**
     * Fetch Aerodrome pool TVL from on-chain token balances.
     * DexScreener reports only gauge-staked TVL (~5x lower than actual pool TVL).
     * Reads token0/token1 balances directly from the pool contract instead.
     * Returns null if token prices are unavailable (non-WETH/cbBTC pools).
     */
    private static async _fetchAerodromeTVL(
        poolAddress: string,
    ): Promise<number | null> {
        try {
            const poolInfoAbi = [
                'function token0() view returns (address)',
                'function token1() view returns (address)',
            ];
            const erc20Abi = [
                'function balanceOf(address) view returns (uint256)',
                'function decimals() view returns (uint8)',
            ];
            const poolInfo = new ethers.Contract(poolAddress, poolInfoAbi, nextProvider());
            const [token0Addr, token1Addr]: [string, string] = await Promise.all([
                rpcRetry(() => poolInfo.token0(), 'aero.token0'),
                rpcRetry(() => poolInfo.token1(), 'aero.token1'),
            ]);
            const t0 = new ethers.Contract(token0Addr, erc20Abi, nextProvider());
            const t1 = new ethers.Contract(token1Addr, erc20Abi, nextProvider());
            // Use hardcoded decimals for known tokens to avoid CALL_EXCEPTION on public nodes
            const knownDec = (addr: string): number | null => {
                const a = addr.toLowerCase();
                if (a === config.TOKEN_ADDRESSES.WETH.toLowerCase())  return config.TOKEN_DECIMALS.WETH;
                if (a === config.TOKEN_ADDRESSES.CBBTC.toLowerCase()) return config.TOKEN_DECIMALS.cbBTC;
                return null;
            };
            const [bal0, dec0, bal1, dec1] = await Promise.all([
                rpcRetry(() => t0.balanceOf(poolAddress), 'erc20.bal0'),
                knownDec(token0Addr) ?? rpcRetry(() => t0.decimals(), 'erc20.dec0'),
                rpcRetry(() => t1.balanceOf(poolAddress), 'erc20.bal1'),
                knownDec(token1Addr) ?? rpcRetry(() => t1.decimals(), 'erc20.dec1'),
            ]);
            const prices = await getTokenPrices();
            const priceMap: Record<string, number> = {
                [config.TOKEN_ADDRESSES.WETH.toLowerCase()]:  prices.ethPrice,
                [config.TOKEN_ADDRESSES.CBBTC.toLowerCase()]: prices.cbbtcPrice,
            };
            const p0 = priceMap[token0Addr.toLowerCase()];
            const p1 = priceMap[token1Addr.toLowerCase()];
            if (p0 === undefined || p1 === undefined) return null;
            const amount0 = Number(BigInt(bal0)) / Math.pow(10, Number(dec0));
            const amount1 = Number(BigInt(bal1)) / Math.pow(10, Number(dec1));
            const tvl = amount0 * p0 + amount1 * p1;
            log.info(`Aerodrome on-chain TVL  ${poolAddress.slice(0, 10)}  $${tvl.toFixed(0)}`);
            return tvl;
        } catch (e: any) {
            log.warn(`Aerodrome on-chain TVL failed  ${poolAddress.slice(0, 10)}: ${e.message}`);
            return null;
        }
    }

    /**
     * Fetch pool stats for a Uniswap V4 pool.
     * poolId is a bytes32 (64 hex chars + 0x prefix).
     * Uses StateView for on-chain tick/price; DexScreener + GeckoTerminal for volume.
     */
    private static async _fetchV4PoolStats(poolId: string, feeTierVal: number): Promise<PoolStats | null> {
        const tag = poolId.slice(0, 10);
        try {
            // 1. Read slot0 from StateView
            const stateView = new ethers.Contract(config.V4_STATE_VIEW, config.V4_STATE_VIEW_ABI, nextProvider());
            const slot0 = await rpcRetry(
                () => stateView.getSlot0(poolId),
                `V4.getSlot0(${tag})`
            );
            const tick = Number(slot0.tick);
            const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);

            // 2. Volume/TVL from DexScreener (V4 poolId may or may not be indexed)
            let tvlUSD = 0;
            let dailyVolumeUSD = 0;
            try {
                const dexRes = await axios.get(
                    `https://api.dexscreener.com/latest/dex/pairs/base/${poolId}`,
                    { 
                        timeout: 8000,
                        headers: { 'User-Agent': config.USER_AGENT }
                    }
                );
                if (dexRes.data?.pairs?.length > 0) {
                    const p = dexRes.data.pairs[0];
                    tvlUSD = parseFloat(p.liquidity?.usd || '0');
                    dailyVolumeUSD = parseFloat(p.volume?.h24 || '0');
                } else {
                    log.warn(`DexScreener no V4 pair data  ${tag}`);
                }
            } catch (e: any) {
                log.warn(`DexScreener V4 fetch failed  ${tag}: ${e.message}`);
            }

            // 3. GeckoTerminal OHLCV by poolId
            const volData = await fetchPoolVolume(poolId, 'UniswapV4');
            const geckoDailyVol = volData.daily;
            const gecko7DVol = volData.avg7d;
            const volSource = volData.source;

            // 4. Volume source: GeckoTerminal OHLCV is primary; DexScreener h24 as last resort
            const verified24hVol = geckoDailyVol > 0 ? geckoDailyVol : dailyVolumeUSD;

            // 5. Blend with 7D average when available
            const avgDailyVolume = gecko7DVol > 0
                ? (verified24hVol + gecko7DVol) / 2
                : verified24hVol;
            const dailyFeesUSD = avgDailyVolume * feeTierVal;
            const apr = tvlUSD > 0 ? (dailyFeesUSD / tvlUSD) * 365 : 0;

            log.info(`🌐 V4 pool  ${tag}  tick=${tick}  tvl=$${tvlUSD.toFixed(0)}  apr=${(apr * 100).toFixed(1)}%`);

            return {
                id: poolId.toLowerCase(),
                dex: 'UniswapV4',
                feeTier: feeTierVal,
                apr,
                tvlUSD,
                dailyFeesUSD,
                tick,
                sqrtPriceX96,
                volSource,
            };
        } catch (error) {
            log.error(`V4 fetchPoolStats failed  ${tag}: ${error}`);
            return null;
        }
    }

    /**
     * Scan all core pools and format the output
     */
    static async scanAllCorePools(pools = config.POOLS): Promise<PoolStats[]> {
        // GeckoTerminal 呼叫由 geckoLimiter 限制並發數 ≤ 2；slot0 RPC 與 DexScreener 可安全平行
        const settled = await Promise.allSettled(
            pools.map(p => this.fetchPoolStats(p.address, p.dex, p.fee))
        );

        return settled
            .filter((r): r is PromiseFulfilledResult<PoolStats> => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);
    }
}
