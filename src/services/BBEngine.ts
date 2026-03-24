import axios from 'axios';
import { nearestUsableTick } from '@uniswap/v3-sdk';
import { tickToRatio } from '../utils/math';
import { bbVolCache, historicalReturnsCache } from '../utils/cache';
import { createServiceLogger } from '../utils/logger';
import { geckoRequest } from '../utils/rpcProvider';
import { config } from '../config';
import { getTokenPrices } from '../utils/tokenPrices';
import { BBPattern, BBResult, BBVolEntry, Dex, HistoricalReturnsEntry } from '../types';
import { appState } from '../utils/AppState';


const log = createServiceLogger('BBEngine');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));



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
async function fetchDailyVol(poolAddress: string, dex: Dex): Promise<number> {
  const key = poolAddress.toLowerCase();
  const cached = bbVolCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.vol;

  const tag = poolAddress.slice(0, 10);
  const save = (vol: number) => {
    bbVolCache.set(key, { vol, expiresAt: Date.now() + config.BB_VOL_CACHE_TTL_MS });
    log.info(`💾 30D vol  ${tag}  ${(vol * 100).toFixed(1)}%  (${config.BB_VOL_CACHE_TTL_MS / 3600000}h cache)`);
    return vol;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info(`🌐 30D vol  ${tag}  attempt ${attempt}/3`);
      const res = await geckoRequest(() => axios.get(
        `${config.API_URLS.GECKOTERMINAL_OHLCV}/${key}/ohlcv/day?limit=30`,
        {
          timeout: 10000,
          headers: { 'User-Agent': config.USER_AGENT }
        }
      ));

      const dailyList: any[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
      if (dailyList.length > 1) {
        // GeckoTerminal 返回格式: [timestamp, open, high, low, close, volume]
        const prices = dailyList.map(c => parseFloat(c[4])).reverse();
        return save(calcVol(prices));
      }
      break; // Valid response but no data, don't retry
    } catch (e: any) {
      const is429 = e.response?.status === 429;
      if (attempt < 3) {
        // 指數退避 + jitter：429 → 15s/30s，其他錯誤 → 5s/10s
        const base = is429 ? 15000 : 5000;
        const backoff = base * attempt + Math.random() * 5000;
        log.warn(`GeckoTerminal ${is429 ? '429' : 'error'}  ${tag}  retry in ${(backoff / 1000).toFixed(1)}s (${attempt}/3)`);
        await delay(backoff);
      } else {
        log.error(`30D vol fetch failed after 3 attempts  ${tag}: ${e.message}`);
      }
    }
  }

  log.warn(`vol fallback ${(config.BB_FALLBACK_VOL * 100).toFixed(0)}%  ${tag}`);
  return config.BB_FALLBACK_VOL;
}

/**
 * In-memory Price Buffer to replace hourly GeckoTerminal calls.
 * Stores the close price for each hour.
 */
/**
 * 取得 720 根 1H K 線的歷史 log 報酬率（Bootstrap MC 引擎的抽樣母體，720H = 30 天）。
 * 呼叫 GeckoTerminal /ohlcv/hour?limit=720，TTL=24h。
 * 失敗時回傳空陣列——MC 引擎會將此視為「資料不足，不執行模擬」。
 */
export async function fetchHistoricalReturns(poolAddress: string, dex: Dex, hours = config.HISTORICAL_RETURNS_HOURS): Promise<number[]> {
    const key = poolAddress.toLowerCase();
    const cached = historicalReturnsCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.returns;

    const tag = poolAddress.slice(0, 10);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            log.info(`🌐 歷史報酬率  ${tag}  limit=${hours}H  attempt ${attempt}/3`);
            const res = await geckoRequest(() => axios.get(
                `${config.API_URLS.GECKOTERMINAL_OHLCV}/${key}/ohlcv/hour?limit=${hours}`,
                { timeout: 12000, headers: { 'User-Agent': config.USER_AGENT } }
            ));
            const dailyList: any[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
            if (dailyList.length > 1) {
                // GeckoTerminal 回傳「最新在前」，reverse 轉為「舊→新」
                const prices = dailyList.map((c: any[]) => parseFloat(c[4])).reverse();
                const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
                const entry: HistoricalReturnsEntry = {
                    returns,
                    expiresAt: Date.now() + config.HISTORICAL_RETURNS_CACHE_TTL_MS,
                };
                historicalReturnsCache.set(key, entry);
                log.info(`💾 歷史報酬率  ${tag}  ${returns.length} 筆  (24h 快取)`);
                return returns;
            }
            break; // 有效回應但無資料，不重試
        } catch (e: any) {
            const is429 = e.response?.status === 429;
            if (attempt < 3) {
                const base = is429 ? 15000 : 5000;
                const backoff = base * attempt + Math.random() * 5000;
                log.warn(`歷史報酬率 ${is429 ? '429' : 'error'}  ${tag}  retry in ${(backoff / 1000).toFixed(1)}s`);
                await delay(backoff);
            } else {
                log.error(`歷史報酬率 fetch 失敗  ${tag}: ${e.message}`);
            }
        }
    }
    return [];
}

/**
 * 根據當前帶寬與 30D 均值判斷 BB 型態。
 * 可從 BBEngine.computeDynamicBB 內部呼叫，或在 index.ts 寫回 BBResult 時呼叫。
 */
export function detectBBPattern(
    bandwidth: number,
    avg30DBandwidth: number,
    currentPrice: number,
    sma: number,
    upperPrice: number,
    lowerPrice: number,
): BBPattern {
    if (bandwidth < avg30DBandwidth * config.BB_SQUEEZE_THRESHOLD) {
        return 'squeeze';
    }
    if (bandwidth > avg30DBandwidth * config.BB_EXPANSION_THRESHOLD) {
        // trending：帶寬放大且價格緊貼上/下軌
        const halfBand = (upperPrice - lowerPrice) / 2;
        const priceOffset = Math.abs(currentPrice - sma);
        return priceOffset > halfBand * config.BB_TRENDING_OFFSET_THRESHOLD
            ? 'trending'
            : 'expansion';
    }
    return 'normal';
}

export class PriceBuffer {
  // poolAddress -> { hourTimestamp: price }
  private buffer: Map<string, Map<number, number>> = new Map();

  // Add the current price for the current hour.
  // Only accepts valid tick-ratio prices (i.e. tickToRatio(tick)); rejects near-zero or
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
    const currentHour = Math.floor(Date.now() / config.ONE_HOUR_MS) * config.ONE_HOUR_MS;
    const poolBuffer = this.buffer.get(key)!;

    // Always overwrite the current hour with the latest price (acts as the "close" if it's the last update in that hour)
    poolBuffer.set(currentHour, price);

    // Prune old hours (keep only last 24 hours to save memory)
    const cutoff = currentHour - config.ONE_DAY_MS;
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

    const last20 = sortedHours.slice(-config.BB_HOURLY_WINDOW).map(entry => entry[1]);
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

export function getPriceBufferSnapshot(): Record<string, Record<string, number>> {
  return BBEngine._priceBuffer.serialize();
}

export function restorePriceBuffer(data: Record<string, Record<string, number>>) {
  BBEngine._priceBuffer.restore(data);
}

/** 在 runPoolScanner 後、runBBEngine 前呼叫，確保 buffer 有最新當前小時 entry。 */
export function refreshPriceBuffer(poolAddress: string, currentTick: number) {
  const price = tickToRatio(currentTick);
  BBEngine._priceBuffer.addPrice(poolAddress, price);
}

export class BBEngine {
  /** @internal Exposed for dependency injection in tests. */
  static _priceBuffer = new PriceBuffer();

  /** Replace the price buffer with a test double. */
  static _setPriceBuffer(pb: PriceBuffer) { BBEngine._priceBuffer = pb; }
  /**
   * Fetches historical OHLCV data from GeckoTerminal (Free API, requires no key)
   * Base Network ID is 'base'
   */
  /**
   * @param avg30DBandwidth 上一週期的 30D 帶寬均值（由 bandwidthTracker.getAvg() 提供）。
   *   傳入時啟用 bbPattern 偵測；未傳（啟動初期）則 bbPattern = undefined。
   */
  static async computeDynamicBB(
    poolAddress: string,
    dex: Dex,
    tickSpacing: number,
    currentTick: number,
    avg30DBandwidth?: number | null,
  ): Promise<BBResult | null> {
    try {
      const currentPrice = tickToRatio(currentTick);

      // 1. Update the price buffer with the current live price
      BBEngine._priceBuffer.addPrice(poolAddress, currentPrice);

      // 價格單位說明：priceBuffer 只存 tickToRatio(tick) 的 tick-ratio 值（例如 WETH/cbBTC ≈ 0.029）。
      // GeckoTerminal hourly backfill 曾被移除，原因是它返回 USD 價格（例如 $70k），
      // 與 tick-ratio 單位完全不同，混用會導致 SMA/方差計算失真。
      const prices1H = BBEngine._priceBuffer.getPrices(poolAddress);

      // 2. 先取得 30D 年化波動率（k 值與 stdDev fallback 都需要）
      const annualizedVol = await fetchDailyVol(poolAddress, dex);
      const k = annualizedVol < config.BB_VOL_THRESHOLD ? appState.bbKLowVol : appState.bbKHighVol;
      const regime = k <= appState.bbKLowVol ? 'Low Vol (震盪市)' : 'High Vol (趨勢市)';

      // 3. SMA：用現有資料計算，不足時以當前價格替代
      const sma = prices1H.length > 0
        ? prices1H.reduce((sum: number, p: number) => sum + p, 0) / prices1H.length
        : currentPrice;

      // 4. stdDev：資料 >= 5 筆用 EWMA 平滑後計算；不足時從 30D 年化波動率換算 1H stdDev
      //    annualizedVol = hourlyStdDev × √(365 × 24)  →  hourlyStdDev = sma × annualizedVol / √8760
      let stdDev1H: number;
      let isWarmupFallback = false;
      if (prices1H.length >= config.MIN_CANDLES_FOR_EWMA) {
        let smoothedPrices = [...prices1H];
        for (let i = 1; i < smoothedPrices.length; i++) {
          smoothedPrices[i] = config.EWMA_ALPHA * smoothedPrices[i] + config.EWMA_BETA * smoothedPrices[i - 1];
        }
        const variance1H = smoothedPrices.reduce((sum: number, p: number) => sum + Math.pow(p - sma, 2), 0) / smoothedPrices.length;
        stdDev1H = Math.sqrt(variance1H);
      } else {
        // 冷啟動：用 30D vol 換算 1H stdDev；標記 isFallback 讓 UI 顯示「資料累積中」
        stdDev1H = sma * annualizedVol / Math.sqrt(365 * 24); // √(365×24) = √8760 hourly annualization
        isWarmupFallback = true;
        log.info(`📊 vol-derived stdDev  ${poolAddress.slice(0, 10)}  candles=${prices1H.length}/${config.MIN_CANDLES_FOR_EWMA}  stdDev=${stdDev1H.toExponential(3)} (warmup)`);
      }

      const maxOffset = sma * config.BB_MAX_OFFSET_PCT;
      const upperPrice = Math.min(sma + maxOffset, sma + (k * stdDev1H));
      // 不使用絕對最小值（如 0.00000001），避免 tick-ratio 極小的幣對（如 WETH/cbBTC ≈ 2.9e-12）
      // 被 clamp 到遠大於 SMA 的下界，導致 tickOffsetLower 為負、tick 範圍倒置。
      // sma - maxOffset = 0.9 × sma 恆正，無需額外保護。
      const lowerPrice = Math.max(sma - maxOffset, sma - (k * stdDev1H));

      // Convert BB price bounds directly to ticks: tick = log(price) / log(1.0001)
      // This anchors the band to the SMA, not currentTick, so all positions on the
      // same pool always see the same BB regardless of when they are scanned.
      const tickUpperRaw = Math.round(Math.log(upperPrice) / Math.log(1.0001));
      const tickLowerRaw = Math.round(Math.log(lowerPrice) / Math.log(1.0001));

      const tickLower = nearestUsableTick(tickLowerRaw, tickSpacing);
      const tickUpper = nearestUsableTick(tickUpperRaw, tickSpacing);

      // 幣價由獨立的 tokenPrices 模組管理，BBEngine 只讀快取
      const { ethPrice, cbbtcPrice, cakePrice, aeroPrice } = getTokenPrices();

      const minPriceRatio = ethPrice > 0 ? ethPrice / upperPrice : 0;
      const maxPriceRatio = ethPrice > 0 ? ethPrice / lowerPrice : 0;

      // ── 新增欄位（Step 2）─────────────────────────────────────────────────
      const bandwidth = (upperPrice - lowerPrice) / sma;

      // SMA 斜率：最後 5H 均值 vs 前 5H 均值的相對變化
      let smaSlope = 0;
      if (prices1H.length >= 10) {
        const recent = prices1H.slice(-5).reduce((s, p) => s + p, 0) / 5;
        const older  = prices1H.slice(-10, -5).reduce((s, p) => s + p, 0) / 5;
        smaSlope = older > 0 ? (recent - older) / older : 0;
      }

      // BB 型態：需要上一週期的 avg30DBandwidth
      const bbPattern = (avg30DBandwidth && avg30DBandwidth > 0)
        ? detectBBPattern(bandwidth, avg30DBandwidth, currentPrice, sma, upperPrice, lowerPrice)
        : undefined;

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
        cakePrice,
        aeroPrice,
        minPriceRatio,
        maxPriceRatio,
        isFallback: isWarmupFallback,
        regime: isWarmupFallback ? '資料累積中' : regime,
        bandwidth,
        stdDev1H,
        smaSlope,
        bbPattern,
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
    const k = config.BB_FALLBACK_K;
    const volatility30D = config.BB_FALLBACK_VOL;
    const currentPrice = tickToRatio(currentTick);

    const tickLowerRaw = currentTick - config.BB_FALLBACK_TICK_OFFSET;
    const tickUpperRaw = currentTick + config.BB_FALLBACK_TICK_OFFSET;

    const upperPrice = tickToRatio(tickUpperRaw);
    const lowerPrice = tickToRatio(tickLowerRaw);
    const sma = currentPrice;
    // fallback stdDev1H：從 30D vol 換算（與 warmup 路徑一致）
    const stdDev1H = sma * volatility30D / Math.sqrt(365 * 24);

    return {
      sma,
      upperPrice,
      lowerPrice,
      k,
      volatility30D,
      tickLower: nearestUsableTick(tickLowerRaw, tickSpacing),
      tickUpper: nearestUsableTick(tickUpperRaw, tickSpacing),
      ethPrice: 0,
      cbbtcPrice: 0,
      cakePrice: 0,
      aeroPrice: 0,
      minPriceRatio: 0,
      maxPriceRatio: 0,
      isFallback: true,
      regime: '資料累積中',
      bandwidth: (upperPrice - lowerPrice) / sma,
      stdDev1H,
      smaSlope: 0,
      bbPattern: undefined,
    };
  }
}
