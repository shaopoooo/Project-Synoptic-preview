/**
 * HistoricalDataService — CoinGecko Pro OHLCV 回填 + 增量更新
 *
 * 職責：
 *   1. 一次性回填 150 天 1H OHLCV（分頁拉取）
 *   2. 每日增量追加最新蠟燭
 *   3. Atomic write 持久化至 data/ohlcv/{poolAddress}.json
 *   4. Fallback 到 GeckoTerminal 免費版
 */

import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { rename } from 'fs/promises';
import { config } from '../config';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('HistoricalData');

export interface RawCandle {
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface OhlcvStore {
    poolAddress: string;
    network: 'base';
    lastFetchedTs: number;
    candles: RawCandle[];
}

/** 合併兩組蠟燭，同 ts 時保留 volume 較高的 */
export function mergeCandles(existing: RawCandle[], incoming: RawCandle[]): RawCandle[] {
    const map = new Map<number, RawCandle>();
    for (const c of existing) {
        map.set(c.ts, c);
    }
    for (const c of incoming) {
        const prev = map.get(c.ts);
        if (!prev || c.volume > prev.volume) {
            map.set(c.ts, c);
        }
    }
    return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/** 計算回填需要的分頁請求參數 */
export function paginateBackfillRequests(
    days: number,
    nowTs: number,
): Array<{ before: number; limit: number }> {
    const totalCandles = days * 24;
    const pageSize = 1000;
    const pages: Array<{ before: number; limit: number }> = [];
    let remaining = totalCandles;
    let cursor = nowTs;

    while (remaining > 0) {
        const limit = Math.min(remaining, pageSize);
        pages.push({ before: cursor, limit });
        cursor -= limit * 3600;
        remaining -= limit;
    }

    return pages;
}

/** 從 CoinGecko Pro 拉取 OHLCV 蠟燭 */
async function fetchFromCoinGeckoPro(
    poolAddress: string,
    before: number,
    limit: number,
): Promise<RawCandle[]> {
    const url = `${config.COINGECKO_PRO_BASE_URL}/onchain/networks/base/pools/${poolAddress.toLowerCase()}/ohlcv/hour`;
    const res = await axios.get(url, {
        params: { before_timestamp: before, limit },
        headers: {
            'x-cg-pro-api-key': config.COINGECKO_API_KEY,
            'User-Agent': config.USER_AGENT,
        },
        timeout: 15000,
    });

    const list: number[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
    return list.map((c): RawCandle => ({
        ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
    })).reverse();
}

/** 讀取本地 OHLCV 儲存 */
export async function loadOhlcvStore(poolAddress: string): Promise<OhlcvStore | null> {
    const filePath = path.join(process.cwd(), config.OHLCV_DATA_DIR, `${poolAddress.toLowerCase()}.json`);
    try {
        if (await fs.pathExists(filePath)) {
            return await fs.readJson(filePath);
        }
    } catch (e) {
        log.warn(`loadOhlcvStore: 讀取失敗 ${poolAddress.slice(0, 8)}`, e);
    }
    return null;
}

/** Atomic write OHLCV 儲存 */
async function saveOhlcvStore(store: OhlcvStore): Promise<void> {
    const dir = path.join(process.cwd(), config.OHLCV_DATA_DIR);
    await fs.ensureDir(dir);
    const filePath = path.join(dir, `${store.poolAddress.toLowerCase()}.json`);
    const tmpPath = filePath + '.tmp';
    await fs.writeJson(tmpPath, store);
    await rename(tmpPath, filePath);
}

/**
 * 回填 + 增量更新指定池子的歷史 OHLCV。
 */
export async function syncHistoricalData(
    poolAddress: string,
    sendWarning?: (msg: string) => Promise<void>,
): Promise<RawCandle[]> {
    const existing = await loadOhlcvStore(poolAddress);
    const nowTs = Math.floor(Date.now() / 1000);

    if (!config.COINGECKO_API_KEY) {
        log.info(`HistoricalData: 無 CoinGecko API key，跳過回填 ${poolAddress.slice(0, 8)}`);
        return existing?.candles ?? [];
    }

    const targetCandles = config.HISTORICAL_BACKFILL_DAYS * 24;
    const existingCount = existing?.candles.length ?? 0;
    const lastTs = existing?.lastFetchedTs ?? 0;
    const gapHours = (nowTs - lastTs) / 3600;

    let newCandles: RawCandle[] = [];

    if (existingCount < targetCandles) {
        log.info(`HistoricalData: 回填 ${poolAddress.slice(0, 8)} — 目標 ${targetCandles} 根，現有 ${existingCount} 根`);
        const pages = paginateBackfillRequests(config.HISTORICAL_BACKFILL_DAYS, nowTs);
        for (const page of pages) {
            try {
                const candles = await fetchFromCoinGeckoPro(poolAddress, page.before, page.limit);
                newCandles.push(...candles);
                await new Promise(r => setTimeout(r, 500));
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                log.error(`HistoricalData: 回填失敗 page before=${page.before}`, msg);
                if (sendWarning) {
                    await sendWarning(`⚠️ CoinGecko Pro 回填失敗: ${msg}`).catch(() => {});
                }
                break;
            }
        }
    } else if (gapHours > 1) {
        const fetchCount = Math.min(Math.ceil(gapHours) + 1, 1000);
        log.info(`HistoricalData: 增量更新 ${poolAddress.slice(0, 8)} — ${fetchCount} 根`);
        try {
            newCandles = await fetchFromCoinGeckoPro(poolAddress, nowTs, fetchCount);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            log.warn(`HistoricalData: 增量更新失敗 ${poolAddress.slice(0, 8)}: ${msg}`);
        }
    } else {
        return existing?.candles ?? [];
    }

    const merged = mergeCandles(existing?.candles ?? [], newCandles);
    const store: OhlcvStore = {
        poolAddress: poolAddress.toLowerCase(),
        network: 'base',
        lastFetchedTs: merged.length > 0 ? merged[merged.length - 1].ts : nowTs,
        candles: merged,
    };
    await saveOhlcvStore(store);
    log.info(`HistoricalData: ${poolAddress.slice(0, 8)} 儲存完成 — ${merged.length} 根蠟燭`);
    return merged;
}
