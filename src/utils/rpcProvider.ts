import { ethers } from 'ethers';
import axios from 'axios';
import { config } from '../config';
import { createServiceLogger } from './logger';

const log = createServiceLogger('RPC');

/**
 * Creates a FallbackProvider using the primary RPC_URL and multiple fallback RPCs.
 * If only one URL is available, returns a simple JsonRpcProvider.
 */
const baseNetwork = new ethers.Network('base', 8453);
const allUrls = [config.RPC_URL, ...config.RPC_FALLBACKS];

// 各節點獨立 provider，供 round-robin 使用
const rrProviders: ethers.JsonRpcProvider[] = allUrls.map(url =>
    new ethers.JsonRpcProvider(url, baseNetwork, { staticNetwork: baseNetwork })
);
let rrIndex = 0;

/**
 * Round-robin provider：每次呼叫輪換至下一個節點。
 * 在串行 RPC 流程中使用，分散負載避免單節點 rate-limit。
 */
export function nextProvider(): ethers.JsonRpcProvider {
    const p = rrProviders[rrIndex % rrProviders.length];
    rrIndex++;
    return p;
}

function createProvider(): ethers.JsonRpcProvider | ethers.FallbackProvider {
    if (allUrls.length === 1) {
        return rrProviders[0];
    }

    const providers = rrProviders.map((provider, i) => ({
        provider,
        priority: i + 1,
        stallTimeout: 3000,
        weight: 1
    }));

    log.info(`Initialized FallbackProvider with ${allUrls.length} RPC endpoints`);

    return new ethers.FallbackProvider(providers, baseNetwork, {
        quorum: 1,
        eventQuorum: 1
    });
}

export const rpcProvider = createProvider();

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Gas oracle: estimated gas for a compound (collect + reinvest) on Base
const GAS_UNITS_COMPOUND = 300_000n;
let gasCostCache: { usd: number; expiresAt: number } | null = null;

/**
 * Fetch estimated USD cost of a compound transaction.
 * Uses live maxFeePerGas from RPC × ETH price from DexScreener.
 * Caches result for 5 minutes. Falls back to $1.5 on error.
 */
export async function fetchGasCostUSD(): Promise<number> {
    if (gasCostCache && Date.now() < gasCostCache.expiresAt) return gasCostCache.usd;
    try {
        const [feeData, ethRes] = await Promise.all([
            rpcProvider.getFeeData(),
            axios.get(
                'https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006',
                { timeout: 5000 }
            ),
        ]);
        const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
        const ethPrice = parseFloat(ethRes.data?.pairs?.[0]?.priceUsd ?? '0');
        if (maxFee > 0n && ethPrice > 0) {
            const gasCostETH = Number(maxFee * GAS_UNITS_COMPOUND) / 1e18;
            const usd = gasCostETH * ethPrice;
            gasCostCache = { usd, expiresAt: Date.now() + 5 * 60 * 1000 };
            log.info(`⛽ gas $${usd.toFixed(4)} (${(Number(maxFee) / 1e9).toFixed(4)} gwei × ${GAS_UNITS_COMPOUND} units)`);
            return usd;
        }
    } catch (e: any) {
        log.warn(`gas oracle failed: ${e.message}`);
    }
    return 1.5; // fallback
}

/** Retry wrapper for RPC calls that may fail due to rate limiting or transient server errors */
export async function rpcRetry<T>(fn: () => Promise<T>, label: string, retries = 3, backoffMs = 2000): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            const errMsg = (error?.message || '').toLowerCase();
            const infoMsg = (error?.info?.error?.message || '').toLowerCase();

            const isRetryable =
                // Rate-limit signals
                (error.code === 'CALL_EXCEPTION' && error.data === null) ||
                errMsg.includes('rate limit') ||
                errMsg.includes('too many requests') ||
                infoMsg.includes('rate limit') ||
                // Transient infrastructure errors (502, 503)
                error.code === 'SERVER_ERROR' ||
                errMsg.includes('502') ||
                errMsg.includes('503') ||
                errMsg.includes('bad gateway') ||
                errMsg.includes('service unavailable');

            if (isRetryable && attempt < retries) {
                const wait = backoffMs * attempt;
                log.warn(`RPC transient error on ${label} (attempt ${attempt}/${retries}), retry in ${wait}ms: ${error.message.slice(0, 80)}`);
                await delay(wait);
            } else {
                log.error(`RPC failed permanently on ${label}: ${error.message} (code: ${error.code})`);
                throw error;
            }
        }
    }
    throw new Error(`rpcRetry exhausted for ${label}`);
}
