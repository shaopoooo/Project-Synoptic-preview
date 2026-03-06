import axios from 'axios';
import { nearestUsableTick } from '@uniswap/v3-sdk';
import { bbVolCache, BBVolEntry } from '../utils/cache';
import { createServiceLogger } from '../utils/logger';
import { config } from '../config';

const log = createServiceLogger('BBEngine');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface BBResult {
  sma: number;
  upperPrice: number;
  lowerPrice: number;
  k: number;
  volatility30D: number;
  tickLower: number;
  tickUpper: number;
  ethPrice: number;
  cbbtcPrice: number;
  minPriceRatio: number;
  maxPriceRatio: number;
  isFallback?: boolean;
  regime: string;
}

const VOL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PRICE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes（短於 5m cron，確保每個週期拿新價格）

let tokenPriceCache: { ethPrice: number; cbbtcPrice: number; expiresAt: number } | null = null;

/** Compute annualized vol from a list of prices (closes). */
function calcVol(prices: number[]): number {
  if (prices.length < 2) return 0.5;
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365);
}

/** Fetch 30-day annualized vol.
 *  Order: DEX-specific The Graph subgraph → GeckoTerminal → stale cache → 50% default
 *  Results are cached 2 hours to avoid hitting free-tier rate limits. */
async function fetchDailyVol(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'): Promise<number> {
  const key = poolAddress.toLowerCase();
  const cached = bbVolCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.vol;

  const tag = poolAddress.slice(0, 10);
  const save = (vol: number) => {
    bbVolCache.set(key, { vol, expiresAt: Date.now() + VOL_CACHE_TTL_MS });
    log.info(`💾 30D vol  ${tag}  ${(vol * 100).toFixed(1)}%  (12h cache)`);
    return vol;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info(`🌐 30D vol  ${tag}  attempt ${attempt}/3`);
      const res = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/base/pools/${key}/ohlcv/day?limit=30`,
        { timeout: 8000 }
      );

      const dailyList: any[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
      if (dailyList.length > 1) {
        // GeckoTerminal 返回格式: [timestamp, open, high, low, close, volume]
        const prices = dailyList.map(c => parseFloat(c[4])).reverse();
        return save(calcVol(prices));
      }
      break; // Valid response but no data, don't retry
    } catch (e: any) {
      if (attempt < 3) {
        const is429 = e.response?.status === 429;
        log.warn(`GeckoTerminal ${is429 ? '429 rate-limit' : 'error'}  ${tag}  retry in 10s (${attempt}/3)`);
        await delay(10000);
      } else {
        log.error(`30D vol fetch failed after 3 attempts  ${tag}: ${e.message}`);
      }
    }
  }

  log.warn(`vol fallback 50%  ${tag}`);
  return 0.5;
}

/**
 * In-memory Price Buffer to replace hourly GeckoTerminal calls.
 * Stores the close price for each hour.
 */
class PriceBuffer {
  // poolAddress -> { hourTimestamp: price }
  private buffer: Map<string, Map<number, number>> = new Map();

  // Add the current price for the current hour.
  // Only accepts valid tick-ratio prices (i.e. Math.pow(1.0001, tick)); rejects near-zero or
  // non-finite values that would corrupt SMA/variance calculations.
  public addPrice(poolAddress: string, price: number) {
    if (!Number.isFinite(price) || price <= 0) {
      log.warn(`addPrice: skipping invalid price ${price} for ${poolAddress.slice(0, 10)}`);
      return;
    }
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) {
      this.buffer.set(key, new Map());
    }

    // Get current hour timestamp (floor to nearest hour)
    const currentHour = Math.floor(Date.now() / (1000 * 60 * 60)) * (1000 * 60 * 60);
    const poolBuffer = this.buffer.get(key)!;

    // Always overwrite the current hour with the latest price (acts as the "close" if it's the last update in that hour)
    poolBuffer.set(currentHour, price);

    // Prune old hours (keep only last 24 hours to save memory)
    const cutoff = currentHour - (24 * 60 * 60 * 1000);
    for (const [hourTimestamp] of poolBuffer.entries()) {
      if (hourTimestamp < cutoff) {
        poolBuffer.delete(hourTimestamp);
      }
    }
  }

  // Backfill prices from GeckoTerminal if the buffer is empty
  public backfill(poolAddress: string, ohlcvList: any[][]) {
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) {
      this.buffer.set(key, new Map());
    }
    const poolBuffer = this.buffer.get(key)!;

    // ohlcvList is newest first: [timestamp, open, high, low, close, volume]
    // timestamp is in seconds from GeckoTerminal
    for (const candle of ohlcvList) {
      if (!candle || candle.length < 5) continue;
      const tsMs = candle[0] * 1000; // API returns seconds
      // Floor to hour just to be safe
      const hourTs = Math.floor(tsMs / (1000 * 60 * 60)) * (1000 * 60 * 60);
      const closePrice = parseFloat(candle[4]);

      // Only set if we don't have a newer live price for that hour
      if (!poolBuffer.has(hourTs)) {
        poolBuffer.set(hourTs, closePrice);
      }
    }
  }

  // Get the last 20 hourly closing prices (chronological: oldest to newest)
  public getPrices(poolAddress: string): number[] {
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) return [];

    const poolBuffer = this.buffer.get(key)!;
    // Sort by timestamp
    const sortedHours = Array.from(poolBuffer.entries()).sort((a, b) => a[0] - b[0]);

    // Take the last 20
    const last20 = sortedHours.slice(-20).map(entry => entry[1]);
    return last20;
  }

  /** Serialize to plain object for JSON persistence. */
  public serialize(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [pool, hours] of this.buffer.entries()) {
      out[pool] = Object.fromEntries(hours.entries());
    }
    return out;
  }

  /** Restore from a plain object snapshot, skipping invalid prices. */
  public restore(data: Record<string, Record<string, number>>) {
    this.buffer.clear();
    for (const [pool, hours] of Object.entries(data)) {
      const m = new Map<number, number>();
      for (const [ts, price] of Object.entries(hours)) {
        if (Number.isFinite(price) && price > 0) {
          m.set(Number(ts), price);
        }
      }
      if (m.size > 0) this.buffer.set(pool, m);
    }
  }
}

const globalPriceBuffer = new PriceBuffer();


export function getPriceBufferSnapshot(): Record<string, Record<string, number>> {
  return globalPriceBuffer.serialize();
}

export function restorePriceBuffer(data: Record<string, Record<string, number>>) {
  globalPriceBuffer.restore(data);
}

export class BBEngine {
  /**
   * Fetches historical OHLCV data from GeckoTerminal (Free API, requires no key)
   * Base Network ID is 'base'
   */
  static async computeDynamicBB(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome', tickSpacing: number, currentTick: number): Promise<BBResult | null> {
    try {
      const currentPrice = Math.pow(1.0001, currentTick);

      // 1. Update the price buffer with the current live price
      globalPriceBuffer.addPrice(poolAddress, currentPrice);

      // 價格單位說明：priceBuffer 只存 Math.pow(1.0001, tick) 的 tick-ratio 值（例如 WETH/cbBTC ≈ 0.029）。
      // GeckoTerminal hourly backfill 曾被移除，原因是它返回 USD 價格（例如 $70k），
      // 與 tick-ratio 單位完全不同，混用會導致 SMA/方差計算失真。
      const prices1H = globalPriceBuffer.getPrices(poolAddress);

      // 2. 先取得 30D 年化波動率（k 值與 stdDev fallback 都需要）
      const annualizedVol = await fetchDailyVol(poolAddress, dex);
      const k = annualizedVol < 0.50 ? 1.2 : 1.8;
      const regime = k <= 1.5 ? 'Low Vol (震盪市)' : 'High Vol (趨勢市)';

      // 3. SMA：用現有資料計算，不足時以當前價格替代
      const sma = prices1H.length > 0
        ? prices1H.reduce((sum: number, p: number) => sum + p, 0) / prices1H.length
        : currentPrice;

      // 4. stdDev：資料 >= 5 筆用 EWMA 平滑後計算；不足時從 30D 年化波動率換算 1H stdDev
      //    annualizedVol = hourlyStdDev × √(365 × 24)  →  hourlyStdDev = sma × annualizedVol / √8760
      let stdDev1H: number;
      if (prices1H.length >= 5) {
        let smoothedPrices = [...prices1H];
        for (let i = 1; i < smoothedPrices.length; i++) {
          smoothedPrices[i] = 0.3 * smoothedPrices[i] + 0.7 * smoothedPrices[i - 1];
        }
        const variance1H = smoothedPrices.reduce((sum: number, p: number) => sum + Math.pow(p - sma, 2), 0) / smoothedPrices.length;
        stdDev1H = Math.sqrt(variance1H);
      } else {
        // 冷啟動：用 30D vol 換算 1H stdDev，regime 仍有效
        stdDev1H = sma * annualizedVol / Math.sqrt(365 * 24);
        log.info(`📊 vol-derived stdDev  ${poolAddress.slice(0, 10)}  candles=${prices1H.length}/20  stdDev=${stdDev1H.toExponential(3)}`);
      }

      const maxOffset = sma * 0.10; // ±10% cap
      const upperPrice = Math.min(sma + maxOffset, sma + (k * stdDev1H));
      // 不使用絕對最小值（如 0.00000001），避免 tick-ratio 極小的幣對（如 WETH/cbBTC ≈ 2.9e-12）
      // 被 clamp 到遠大於 SMA 的下界，導致 tickOffsetLower 為負、tick 範圍倒置。
      // sma - maxOffset = 0.9 × sma 恆正，無需額外保護。
      const lowerPrice = Math.max(sma - maxOffset, sma - (k * stdDev1H));

      // Calculate the percentage offset of the bounds from the current price/SMA
      // Since price = 1.0001^tick, a % change in price corresponds to a constant tick offset
      // Delta Tick = log(Price2/Price1) / log(1.0001)
      const tickOffsetUpper = Math.round(Math.log(upperPrice / sma) / Math.log(1.0001));
      const tickOffsetLower = Math.round(Math.log(sma / lowerPrice) / Math.log(1.0001));

      // If price of Token0 is rising relative to Token1, tick usually increases.
      // E.g cbBTC vs WETH (Token0 is usually cbBTC).
      const tickUpperRaw = currentTick + tickOffsetUpper;
      const tickLowerRaw = currentTick - tickOffsetLower;

      const tickLower = nearestUsableTick(tickLowerRaw, tickSpacing);
      const tickUpper = nearestUsableTick(tickUpperRaw, tickSpacing);

      // Fetch current WETH and cbBTC prices from DexScreener（5分鐘快取，避免每個 pool 重複呼叫）
      let ethPrice = 0;
      let cbbtcPrice = 0;
      if (tokenPriceCache && Date.now() < tokenPriceCache.expiresAt) {
        ethPrice = tokenPriceCache.ethPrice;
        cbbtcPrice = tokenPriceCache.cbbtcPrice;
      } else {
        try {
          const [wethRes, cbbtcRes] = await Promise.all([
            axios.get('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006', { timeout: 5000 }),
            axios.get('https://api.dexscreener.com/latest/dex/tokens/0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', { timeout: 5000 }),
          ]);
          if (wethRes.data?.pairs?.length > 0)
            ethPrice = parseFloat(wethRes.data.pairs[0].priceUsd);
          if (cbbtcRes.data?.pairs?.length > 0)
            cbbtcPrice = parseFloat(cbbtcRes.data.pairs[0].priceUsd);
          tokenPriceCache = { ethPrice, cbbtcPrice, expiresAt: Date.now() + PRICE_CACHE_TTL_MS };
          log.info(`💹 WETH $${ethPrice.toFixed(0)}  cbBTC $${cbbtcPrice.toFixed(0)}`);
        } catch (e: any) {
          log.warn(`token price fetch failed: ${e.message}`);
          if (tokenPriceCache) { ethPrice = tokenPriceCache.ethPrice; cbbtcPrice = tokenPriceCache.cbbtcPrice; }
        }
      }

      const minPriceRatio = ethPrice > 0 ? ethPrice / upperPrice : 0;
      const maxPriceRatio = ethPrice > 0 ? ethPrice / lowerPrice : 0;

      return {
        sma,
        upperPrice,
        lowerPrice,
        k,
        volatility30D: annualizedVol,
        tickLower,
        tickUpper,
        ethPrice,
        cbbtcPrice,
        minPriceRatio,
        maxPriceRatio,
        regime
      };

    } catch (error) {
      log.error(`BB compute failed  ${poolAddress.slice(0, 10)} (${dex}): ${error}`);
      return BBEngine.createFallbackBB(currentTick, tickSpacing);
    }
  }

  /**
   * Generates a safe fallback BB block when external APIs fail.
   * Uses the current tick as the SMA and creates a standard 10% wide band.
   */
  private static createFallbackBB(currentTick: number, tickSpacing: number): BBResult {
    const k = 2.0;
    const volatility30D = 0.5;
    const currentPrice = Math.pow(1.0001, currentTick);

    // Arbitrary +/- 1000 ticks (~10%) for the fallback band
    const tickLowerRaw = currentTick - 1000;
    const tickUpperRaw = currentTick + 1000;

    return {
      sma: currentPrice,
      upperPrice: Math.pow(1.0001, tickUpperRaw),
      lowerPrice: Math.pow(1.0001, tickLowerRaw),
      k,
      volatility30D,
      tickLower: nearestUsableTick(tickLowerRaw, tickSpacing),
      tickUpper: nearestUsableTick(tickUpperRaw, tickSpacing),
      ethPrice: 0,
      cbbtcPrice: 0,
      minPriceRatio: 0,
      maxPriceRatio: 0,
      isFallback: true,
      regime: '資料累積中'
    };
  }
}
