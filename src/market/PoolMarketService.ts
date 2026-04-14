import axios from 'axios';
import { nearestUsableTick } from '@uniswap/v3-sdk';
import { tickToRatio } from '../infra/utils/math';
import { volatilityCache, historicalReturnsCache } from '../infra/utils/cache';
import { createServiceLogger } from '../infra/logger';
import { geckoRequest, reportGecko429 } from '../infra/rpcProvider';
import { config } from '../config';
import { getTokenPrices } from './TokenPriceService';
import { MarketPattern, MarketSnapshot, VolatilityEntry, Dex, HistoricalReturnsEntry, HourlyReturn } from '../types';
import { appState } from '../infra/AppState';

/** 快取資料老化超過此小時數時，推送 cycleWarning。 */
const CACHE_STALE_WARN_HOURS = 3;
import { detectBBPattern } from '../engine/shared/BollingerBands';


const log = createServiceLogger('PoolMarketService');

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
  const cached = volatilityCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.vol;

  const tag = poolAddress.slice(0, 10);
  const save = (vol: number) => {
    volatilityCache.set(key, { vol, expiresAt: Date.now() + config.BB_VOL_CACHE_TTL_MS });
    log.debug(`💾 30D vol  ${tag}  ${(vol * 100).toFixed(1)}%  (${config.BB_VOL_CACHE_TTL_MS / 3600000}h cache)`);
    return vol;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.debug(`🌐 30D vol  ${tag}  attempt ${attempt}/3`);
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
      if (is429) reportGecko429();
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
/** GeckoTerminal 原始蠟燭格式（內部使用） */
interface RawCandle {
    ts: number;     // c[0] Unix 秒
    open: number;   // c[1]
    high: number;   // c[2]
    low: number;    // c[3]
    close: number;  // c[4]
    volume: number; // c[5] USD 交易量
}

/**
 * 從 GeckoTerminal 抓取最近 N 根 1H K 線，保留全部 OHLCV 欄位（c[0]~c[5]）。
 * 回傳「舊→新」排序；失敗時回傳 null。
 */
async function fetchOHLCVWithTs(poolKey: string, hours: number): Promise<RawCandle[] | null> {
    const tag = poolKey.slice(0, 10);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await geckoRequest(() => axios.get(
                `${config.API_URLS.GECKOTERMINAL_OHLCV}/${poolKey}/ohlcv/hour?limit=${hours}`,
                { timeout: 12000, headers: { 'User-Agent': config.USER_AGENT } }
            ));
            const list: any[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
            if (list.length > 1) {
                // GeckoTerminal 格式：[timestamp, open, high, low, close, volume]，最新在前
                return list.map((c: any[]): RawCandle => ({
                    ts:     c[0] as number,
                    open:   parseFloat(c[1]),
                    high:   parseFloat(c[2]),
                    low:    parseFloat(c[3]),
                    close:  parseFloat(c[4]),
                    volume: parseFloat(c[5]),
                })).reverse(); // 轉為「舊→新」
            }
            return null;
        } catch (e: any) {
            const is429 = e.response?.status === 429;
            if (is429) reportGecko429();
            if (attempt < 3) {
                const base = is429 ? 15000 : 5000;
                const backoff = base * attempt + Math.random() * 5000;
                log.warn(`OHLCV ${is429 ? '429' : 'error'}  ${tag}  retry in ${(backoff / 1000).toFixed(1)}s`);
                await delay(backoff);
            } else {
                log.error(`OHLCV fetch 失敗  ${tag}: ${(e as Error).message}`);
            }
        }
    }
    return null;
}

/**
 * 將「舊→新」排序的 RawCandle[] 轉為 HourlyReturn[]。
 * r = ln(close_i / close_{i-1})；第 0 根蠟燭無前一根，故結果比輸入少 1 筆。
 */
function ohlcvToHourlyReturns(ohlcv: RawCandle[]): HourlyReturn[] {
    return ohlcv.slice(1).map((c, i) => ({
        ts:     c.ts,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume,
        r:      Math.log(c.close / ohlcv[i].close),
    }));
}

/**
 * 去重：同一 ts 保留 |r| 最大的那筆，清除 GeckoTerminal 補零蠟燭。
 *
 * GeckoTerminal 偶爾對時間缺口插入重複 ts、r=0 的佔位蠟燭，
 * 這些零報酬率會低估波動率並使 CVaR 計算失準。
 * 保留 |r| 最大者（實際真實波動），確保風險計算不被人為壓低。
 * 最後依 ts 重新排序，維持「舊→新」順序。
 */
function deduplicateByTs(returns: HourlyReturn[]): HourlyReturn[] {
    const best = new Map<number, HourlyReturn>();
    for (const hr of returns) {
        const prev = best.get(hr.ts);
        if (!prev || Math.abs(hr.r) > Math.abs(prev.r)) {
            best.set(hr.ts, hr);
        }
    }
    return Array.from(best.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * 從 log return 陣列計算衍生統計量（mean、stdHourly、annualizedVol、skewness、kurtosis）。
 * 結果直接存入 HistoricalReturnsEntry，供外部查詢無需重算。
 */
function computeReturnStats(rs: number[]): Pick<HistoricalReturnsEntry, 'mean' | 'stdHourly' | 'annualizedVol' | 'skewness' | 'kurtosis'> {
    const n = rs.length;
    if (n < 2) return { mean: 0, stdHourly: 0, annualizedVol: 0, skewness: 0, kurtosis: 0 };
    const mean = rs.reduce((s, r) => s + r, 0) / n;
    const diffs = rs.map(r => r - mean);
    const variance = diffs.reduce((s, d) => s + d * d, 0) / n;
    const std = Math.sqrt(variance);
    const m3 = diffs.reduce((s, d) => s + d ** 3, 0) / n;
    const m4 = diffs.reduce((s, d) => s + d ** 4, 0) / n;
    return {
        mean,
        stdHourly: std,
        annualizedVol: std * Math.sqrt(8760),
        skewness: std > 0 ? m3 / std ** 3 : 0,
        kurtosis: std > 0 ? m4 / std ** 4 - 3 : 0,
    };
}

/**
 * 取得歷史 log 報酬率（Bootstrap MC 引擎的抽樣母體）。
 *
 * 快取策略（三段式）：
 *   < 1H 老：直接回傳快取，無 API 請求。
 *   1H ~ 24H：增量更新——只抓新的 N 小時 + 1 重疊根，與快取合併後滑動視窗。
 *   > 24H 或無快取：全量抓取 hours 根 K 線重建陣列。
 *
 * 失敗時回傳舊快取或空陣列——MC 引擎視資料不足為 No-Go。
 */
export async function fetchHistoricalReturns(poolAddress: string, _dex: Dex, hours = config.HISTORICAL_RETURNS_HOURS): Promise<HourlyReturn[]> {
    const key = poolAddress.toLowerCase();
    const cached = historicalReturnsCache.get(key);
    const now = Date.now();

    if (cached && cached.returns.length >= 2) {
        // 以快取末筆的實際時間戳判斷新鮮度，避免重啟後時間基準跑掉
        const latestTsMs = cached.returns[cached.returns.length - 1].ts * 1000;
        const ageMs = now - latestTsMs;

        // ── 資料新鮮（末筆距今 < 1H）→ 直接回傳 ────────────────────────────
        if (ageMs < 3_600_000) return cached.returns;

        // ── 增量補齊：從末筆 ts 往後只抓缺少的小時數 ────────────────────────
        const hoursNeeded = Math.ceil(ageMs / 3_600_000) + 1; // +1 確保至少 1 根重疊（修正未完結蠟燭）
        const ohlcv = await fetchOHLCVWithTs(key, hoursNeeded);
        if (ohlcv && ohlcv.length >= 2) {
            const freshReturns = deduplicateByTs(ohlcvToHourlyReturns(ohlcv));
            // 以 ts 去重：新資料覆蓋舊快取中相同 ts（修正未完結蠟燭），保留其餘舊資料
            const freshTsSet = new Set(freshReturns.map(hr => hr.ts));
            const kept = cached.returns.filter(hr => !freshTsSet.has(hr.ts));
            const merged = [...kept, ...freshReturns].slice(-hours);
            const stats = computeReturnStats(merged.map(hr => hr.r));
            const entry: HistoricalReturnsEntry = {
                returns: merged, ...stats,
                fetchedAt: now,
                expiresAt: cached.expiresAt,
            };
            historicalReturnsCache.set(key, entry);
            log.debug(`📈 增量更新  ${key.slice(0, 10)}  +${hoursNeeded - 1}H  共 ${merged.length} 筆  vol=${(stats.annualizedVol * 100).toFixed(1)}%`);
            return merged;
        }

        // 增量失敗 → 沿用現有快取（不丟棄已有資料）
        log.warn(`增量更新失敗  ${key.slice(0, 10)}  使用現有快取（${cached.returns.length} 筆）`);
        const cacheAgeHours = cached.returns.length > 0
            ? (now / 1000 - cached.returns[cached.returns.length - 1].ts) / 3600
            : Infinity;
        if (cacheAgeHours > CACHE_STALE_WARN_HOURS) {
            const msg = `歷史報酬率快取老化 ${key.slice(0, 10)}（${cacheAgeHours.toFixed(1)}H 舊），CVaR 計算可能失準`;
            appState.cycleWarnings.push(msg);
            log.warn(msg);
        }
        return cached.returns;
    }

    // ── 快取不存在或資料不足 → 全量抓取 ─────────────────────────────────────
    const tag = key.slice(0, 10);
    log.debug(`🌐 歷史報酬率全量抓取  ${tag}  limit=${hours}H`);
    const ohlcv = await fetchOHLCVWithTs(key, hours);
    if (ohlcv && ohlcv.length >= 2) {
        const returns = deduplicateByTs(ohlcvToHourlyReturns(ohlcv));
        const stats = computeReturnStats(returns.map(hr => hr.r));
        const entry: HistoricalReturnsEntry = {
            returns, ...stats,
            fetchedAt: now,
            expiresAt: now + config.HISTORICAL_RETURNS_CACHE_TTL_MS,
        };
        historicalReturnsCache.set(key, entry);
        log.debug(`💾 歷史報酬率  ${tag}  ${returns.length} 筆  vol=${(stats.annualizedVol * 100).toFixed(1)}%  skew=${stats.skewness.toFixed(2)}  kurt=${stats.kurtosis.toFixed(2)}`);
        return returns;
    }

    if (cached) {
        log.warn(`全量抓取失敗  ${tag}  使用過期快取（${cached.returns.length} 筆）`);
        const staleAgeHours = cached.returns.length > 0
            ? (Date.now() / 1000 - cached.returns[cached.returns.length - 1].ts) / 3600
            : Infinity;
        if (staleAgeHours > CACHE_STALE_WARN_HOURS) {
            const msg = `歷史報酬率過期快取 ${tag}（${staleAgeHours.toFixed(1)}H 舊），CVaR 計算可能失準`;
            appState.cycleWarnings.push(msg);
            log.warn(msg);
        }
        return cached.returns;
    }
    return [];
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
  return PoolMarketService._priceBuffer.serialize();
}

export function restorePriceBuffer(data: Record<string, Record<string, number>>) {
  PoolMarketService._priceBuffer.restore(data);
}

/** 在 runPoolScanner 後、runPoolMarketService 前呼叫，確保 buffer 有最新當前小時 entry。 */
export function refreshPriceBuffer(poolAddress: string, currentTick: number) {
  const price = tickToRatio(currentTick);
  PoolMarketService._priceBuffer.addPrice(poolAddress, price);
}

export class PoolMarketService {
  /** @internal Exposed for dependency injection in tests. */
  static _priceBuffer = new PriceBuffer();

  /** Replace the price buffer with a test double. */
  static _setPriceBuffer(pb: PriceBuffer) { PoolMarketService._priceBuffer = pb; }
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
  ): Promise<MarketSnapshot | null> {
    try {
      const currentPrice = tickToRatio(currentTick);

      // 1. Update the price buffer with the current live price
      PoolMarketService._priceBuffer.addPrice(poolAddress, currentPrice);

      // 價格單位說明：priceBuffer 只存 tickToRatio(tick) 的 tick-ratio 值（例如 WETH/cbBTC ≈ 0.029）。
      // GeckoTerminal hourly backfill 曾被移除，原因是它返回 USD 價格（例如 $70k），
      // 與 tick-ratio 單位完全不同，混用會導致 SMA/方差計算失真。
      const prices1H = PoolMarketService._priceBuffer.getPrices(poolAddress);

      // 2. 先取得 30D 年化波動率（k 值與 stdDev fallback 都需要）
      const annualizedVol = await fetchDailyVol(poolAddress, dex);
      const k = annualizedVol < config.BB_VOL_THRESHOLD ? appState.marketKLowVol : appState.marketKHighVol;
      const regime = k <= appState.marketKLowVol ? 'Low Vol (震盪市)' : 'High Vol (趨勢市)';

      // 3. SMA：用現有資料計算，不足時以當前價格替代
      const sma = prices1H.length > 0
        ? prices1H.reduce((sum: number, p: number) => sum + p, 0) / prices1H.length
        : currentPrice;

      // 4. stdDev：資料 >= 5 筆用 EWMA 平滑後計算；不足時從 30D 年化波動率換算 1H stdDev
      //    annualizedVol = hourlyStdDev × √(365 × 24)  →  hourlyStdDev = sma × annualizedVol / √8760
      let stdDev1H: number;
      let isWarmupFallback = false;
      if (prices1H.length >= config.MIN_CANDLES_FOR_EWMA) {
        // 直接使用原始價格計算變異數，不再進行事前 EWMA 平滑（平滑會人為消除波動導致塌縮）
        const variance1H = prices1H.reduce((sum: number, p: number) => sum + Math.pow(p - sma, 2), 0) / prices1H.length;
        const rawStdDev = Math.sqrt(variance1H);
        
        // 以 30D 年化波動率換算的值作為下限，保護避開極端平靜的亞洲時段導致 BB 帶寬過窄
        const volDerivedFloor = sma * annualizedVol / Math.sqrt(8760);
        stdDev1H = Math.max(rawStdDev, volDerivedFloor);
        if (rawStdDev < volDerivedFloor) {
          log.debug(`stdDev1H 短期波動較低（${rawStdDev.toExponential(3)} < floor ${volDerivedFloor.toExponential(3)}），採用 vol-derived 下限保護  ${poolAddress.slice(0, 10)}`);
        }
      } else {
        // 冷啟動：用 30D vol 換算 1H stdDev；標記 isFallback 讓 UI 顯示「資料累積中」
        stdDev1H = sma * annualizedVol / Math.sqrt(365 * 24); // √(365×24) = √8760 hourly annualization
        isWarmupFallback = true;
        log.debug(`📊 vol-derived stdDev  ${poolAddress.slice(0, 10)}  candles=${prices1H.length}/${config.MIN_CANDLES_FOR_EWMA}  stdDev=${stdDev1H.toExponential(3)} (warmup)`);
      }

      const R = 1 + (k * stdDev1H / sma);
      const upperPrice = sma * R;
      const lowerPrice = sma / R;

      // Convert BB price bounds directly to ticks: tick = log(price) / log(1.0001)
      // This anchors the band to the SMA, not currentTick, so all positions on the
      // same pool always see the same BB regardless of when they are scanned.
      const tickUpperRaw = Math.round(Math.log(upperPrice) / Math.log(1.0001));
      const tickLowerRaw = Math.round(Math.log(lowerPrice) / Math.log(1.0001));

      const tickLower = nearestUsableTick(tickLowerRaw, tickSpacing);
      const tickUpper = nearestUsableTick(tickUpperRaw, tickSpacing);

      // 幣價由獨立的 tokenPrices 模組管理，PoolMarketService 只讀快取
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
        isFallback: false,
        isWarmup: isWarmupFallback,
        regime: isWarmupFallback ? '資料累積中' : regime,
        bandwidth,
        stdDev1H,
        smaSlope,
        bbPattern,
      };

    } catch (error) {
      log.error(`BB compute failed  ${poolAddress.slice(0, 10)} (${dex}): ${error}`);
      return PoolMarketService.createFallbackBB(currentTick, tickSpacing);
    }
  }

  /**
   * Generates a safe fallback BB block when external APIs fail.
   * Uses the current tick as the SMA and creates a standard 10% wide band.
   */
  private static createFallbackBB(currentTick: number, tickSpacing: number): MarketSnapshot {
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
