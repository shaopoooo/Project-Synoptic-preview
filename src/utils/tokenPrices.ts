/**
 * tokenPrices.ts — 獨立幣價快取
 *
 * 與 BBEngine 解耦，讓代幣價格可在 cron 任意位置刷新，
 * 不受 BBEngine 是否成功執行影響。
 */
import axios from 'axios';
import { config } from '../config';
import { createServiceLogger } from './logger';
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
    const pick = (r: PromiseSettledResult<any>, name: string, prevPrice: number, prevTs: number): { price: number; ts: number } => {
        if (r.status === 'fulfilled') return { price: bestPrice(r.value.data?.pairs), ts: now };
        log.warn(`${name} price fetch failed: ${r.reason?.message} — keeping ${prevPrice > 0 ? `$${prevPrice}` : 'zero'}`);
        return { price: prevPrice, ts: prevTs };
    };

    const prev = cache ?? { ethPrice: 0, ethFetchedAt: 0, cbbtcPrice: 0, cbbtcFetchedAt: 0, cakePrice: 0, cakeFetchedAt: 0, aeroPrice: 0, aeroFetchedAt: 0, fetchedAt: 0 };
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
    log.info(`💹 WETH $${cache.ethPrice.toFixed(0)}  cbBTC $${cache.cbbtcPrice.toFixed(0)}  CAKE $${cache.cakePrice.toFixed(3)}  AERO $${cache.aeroPrice.toFixed(3)}`);

    return cache ?? { ethPrice: 0, ethFetchedAt: 0, cbbtcPrice: 0, cbbtcFetchedAt: 0, cakePrice: 0, cakeFetchedAt: 0, aeroPrice: 0, aeroFetchedAt: 0, fetchedAt: 0 };
}

/** 同步讀取快取（不觸發 API），無快取時回傳全零。 */
export function getTokenPrices(): TokenPrices {
    return cache ?? { ethPrice: 0, ethFetchedAt: 0, cbbtcPrice: 0, cbbtcFetchedAt: 0, cakePrice: 0, cakeFetchedAt: 0, aeroPrice: 0, aeroFetchedAt: 0, fetchedAt: 0 };
}
