/**
 * tokenPrices.ts — 獨立幣價快取
 *
 * 與 PoolMarketService 解耦，讓代幣價格可在 cron 任意位置刷新，
 * 不受 PoolMarketService 是否成功執行影響。
 */
import axios from 'axios';
import { config } from '../config';
import { createServiceLogger } from '../infra/logger';
import { TokenPrices } from '../types';

const log = createServiceLogger('TokenPrices');

let cache: TokenPrices | null = null;

export async function fetchTokenPrices(): Promise<TokenPrices> {
    if (cache && Date.now() < cache.fetchedAt + config.TOKEN_PRICE_CACHE_TTL_MS) {
        return cache;
    }

    const bestPrice = (pairs: any[]): number =>
        parseFloat(
            (pairs?.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0])?.priceUsd || '0'
        );

    const req = (addr: string) => axios.get(
        `${config.API_URLS.DEXSCREENER_TOKENS}/${addr}`,
        { timeout: 5000, headers: { 'User-Agent': config.USER_AGENT } }
    );
    const [wethRes, cbbtcRes, cakeRes, aeroRes] = await Promise.allSettled([
        req(config.TOKEN_ADDRESSES.WETH),
        req(config.TOKEN_ADDRESSES.CBBTC),
        req(config.TOKEN_ADDRESSES.CAKE),
        req(config.TOKEN_ADDRESSES.AERO),
    ]);

    const now = Date.now();
    const prev = cache ?? { ethPrice: 0, ethFetchedAt: 0, cbbtcPrice: 0, cbbtcFetchedAt: 0, cakePrice: 0, cakeFetchedAt: 0, aeroPrice: 0, aeroFetchedAt: 0, fetchedAt: 0 };

    // pick：API 回傳 price=0（空 pairs）與 API 失敗同等對待，均 fallback 到上一輪快取
    const pick = (r: PromiseSettledResult<any>, name: string, prevPrice: number, prevTs: number): { price: number; ts: number } => {
        if (r.status === 'fulfilled') {
            const price = bestPrice(r.value.data?.pairs);
            if (price > 0) return { price, ts: now };
            log.warn(`${name} price parsed as 0 (empty pairs?) — keeping ${prevPrice > 0 ? `$${prevPrice}` : 'no history'}`);
        } else {
            log.warn(`${name} price fetch failed: ${r.reason?.message} — keeping ${prevPrice > 0 ? `$${prevPrice}` : 'no history'}`);
        }
        return { price: prevPrice, ts: prevTs };
    };

    const eth   = pick(wethRes,  'WETH',  prev.ethPrice,   prev.ethFetchedAt);
    const btc   = pick(cbbtcRes, 'cbBTC', prev.cbbtcPrice, prev.cbbtcFetchedAt);
    const cake  = pick(cakeRes,  'CAKE',  prev.cakePrice,  prev.cakeFetchedAt);
    const aero  = pick(aeroRes,  'AERO',  prev.aeroPrice,  prev.aeroFetchedAt);
    cache = {
        ethPrice: eth.price,     ethFetchedAt: eth.ts,
        cbbtcPrice: btc.price,   cbbtcFetchedAt: btc.ts,
        cakePrice: cake.price,   cakeFetchedAt: cake.ts,
        aeroPrice: aero.price,   aeroFetchedAt: aero.ts,
        fetchedAt: now,
    };

    // ETH / cbBTC 為 USD 計算的關鍵幣價，任一為 0 代表資料完全不可用
    if (cache.ethPrice === 0 || cache.cbbtcPrice === 0) {
        throw new Error(
            `TokenPrices: 關鍵幣價為 0（ETH=$${cache.ethPrice} cbBTC=$${cache.cbbtcPrice}），` +
            `API 與歷史快取均無法提供有效價格`
        );
    }

    log.info(`💹 WETH $${cache.ethPrice.toFixed(0)}  cbBTC $${cache.cbbtcPrice.toFixed(0)}  CAKE $${cache.cakePrice.toFixed(3)}  AERO $${cache.aeroPrice.toFixed(3)}`);
    return cache;
}

/** 同步讀取快取（不觸發 API），無快取時回傳全零。 */
export function getTokenPrices(): TokenPrices {
    return cache ?? { ethPrice: 0, ethFetchedAt: 0, cbbtcPrice: 0, cbbtcFetchedAt: 0, cakePrice: 0, cakeFetchedAt: 0, aeroPrice: 0, aeroFetchedAt: 0, fetchedAt: 0 };
}
