import { MarketSnapshot, PoolStats, PositionRecord, AggregateInput, RawChainPosition, FetchedFees } from '../../types';
import { config } from '../../config';
import { createServiceLogger } from '../../infra/logger';
import { getTokenPrices } from '../TokenPriceService';
import { TickMath } from '@uniswap/v3-sdk';
import { tickToPrice, calculateCapitalEfficiency, normalizeAmount, normalizeRawAmount } from '../../infra/utils/math';
import { getTokenDecimals, getTokenSymbol } from '../../infra/utils/tokenInfo';

const FMT = config.FMT;
const log = createServiceLogger('PositionAggregator');

export class PositionAggregator {
    /**
     * Assembles a PositionRecord from raw on-chain data.
     * Scope: USD value calculation + fee normalisation only.
     * Business metrics (PnL, Risk, Rebalance) are computed by the pipeline
     * in index.ts after this returns.
     */
    static assemble(input: AggregateInput): PositionRecord {
        const {
            tokenId, dex, owner, depositorWallet, isStaked,
            position, poolAddress, poolStats, bb,
            unclaimed0, unclaimed1, unclaimed2, fees2USD, token2Symbol,
            feeTierForStats, openTimestampMs,
        } = input;

        const t0 = position.token0.toLowerCase();
        const t1 = position.token1.toLowerCase();
        const dec0 = getTokenDecimals(t0);
        const dec1 = getTokenDecimals(t1);

        const fee0Normalized = normalizeRawAmount(unclaimed0.toString(), dec0);
        const fee1Normalized = normalizeRawAmount(unclaimed1.toString(), dec1);

        // bb may be null on the very first startup scan (PositionScanner runs before PoolMarketService).
        // Fall back to getTokenPrices() which was already refreshed by runTokenPriceFetcher.
        const fallbackPrices = getTokenPrices();
        const wethPrice  = bb?.ethPrice   || fallbackPrices.ethPrice;
        const cbbtcPrice = bb?.cbbtcPrice || fallbackPrices.cbbtcPrice;
        const price0 = getTokenSymbol(t0) === 'cbBTC' ? cbbtcPrice : wethPrice;
        const price1 = getTokenSymbol(t1) === 'cbBTC' ? cbbtcPrice : wethPrice;

        const unclaimedFeesUSD = (fee0Normalized * price0) + (fee1Normalized * price1) + fees2USD;

        const tp = (tick: number) => tickToPrice(tick, dec0, dec1);
        const minPrice    = tp(Number(position.tickLower)).toFixed(FMT.PRICE);
        const maxPrice    = tp(Number(position.tickUpper)).toFixed(FMT.PRICE);
        const currentPrice = tp(poolStats.tick).toFixed(FMT.PRICE);

        const bbMinPrice = bb ? tp(bb.tickLower).toFixed(FMT.PRICE) : undefined;
        const bbMaxPrice = bb ? tp(bb.tickUpper).toFixed(FMT.PRICE) : undefined;

        // LP position value — Uniswap V3 sqrtPrice math
        const sqrtPriceCurrent = Number(poolStats.sqrtPriceX96) / (2 ** 96);
        const sqrtPriceLower = Number(TickMath.getSqrtRatioAtTick(Number(position.tickLower)).toString()) / (2 ** 96);
        const sqrtPriceUpper = Number(TickMath.getSqrtRatioAtTick(Number(position.tickUpper)).toString()) / (2 ** 96);
        const liq = Number(position.liquidity);

        let posAmount0Raw = 0;
        let posAmount1Raw = 0;
        if (sqrtPriceCurrent <= sqrtPriceLower) {
            posAmount0Raw = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
        } else if (sqrtPriceCurrent >= sqrtPriceUpper) {
            posAmount1Raw = liq * (sqrtPriceUpper - sqrtPriceLower);
        } else {
            posAmount0Raw = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
            posAmount1Raw = liq * (sqrtPriceCurrent - sqrtPriceLower);
        }

        const amount0 = normalizeAmount(posAmount0Raw, dec0);
        const amount1 = normalizeAmount(posAmount1Raw, dec1);
        const positionValueUSD = amount0 * price0 + amount1 * price1;

        // ilUSD / initialCapital / openedDays / openedHours / profitRate are filled by
        // runPositionScanner() in index.ts via PnlCalculator after aggregateAll() returns.
        // overlapPercent / breakevenDays / healthScore / rebalance are filled by runRiskManager().
        return {
            tokenId,
            dex,
            poolAddress,
            feeTier: feeTierForStats,
            token0Symbol: getTokenSymbol(t0),
            token1Symbol: getTokenSymbol(t1),
            ownerWallet: depositorWallet || owner,
            isStaked,
            liquidity: position.liquidity.toString(),
            tickLower: Number(position.tickLower),
            tickUpper: Number(position.tickUpper),
            minPrice,
            maxPrice,
            bbMinPrice,
            bbMaxPrice,
            currentTick: poolStats.tick,
            currentPriceStr: currentPrice,
            positionValueUSD,
            amount0,
            amount1,
            unclaimed0: unclaimed0.toString(),
            unclaimed1: unclaimed1.toString(),
            unclaimed2: unclaimed2.toString(),
            unclaimedFeesUSD,
            fees0USD: fee0Normalized * price0,
            fees1USD: fee1Normalized * price1,
            fees2USD,
            token2Symbol,
            rebalance:      undefined,
            overlapPercent: 0,
            ilUSD:          null,
            breakevenDays:  0,
            healthScore:    0,
            regime: bb?.regime ?? 'Unknown',
            lastUpdated: Date.now(),
            apr: poolStats.apr,
            inRangeApr: (() => {
                if (!bb || bb.isFallback || bb.sma <= 0) return undefined;
                const eff = calculateCapitalEfficiency(bb.upperPrice, bb.lowerPrice, bb.sma);
                return eff !== null ? poolStats.apr * eff : undefined;
            })(),
            volSource:   poolStats.volSource ?? 'unknown',
            priceSource: bb && !bb.isFallback ? 'The Graph / GeckoTerminal' : 'RPC (Fallback)',
            bbFallback:  bb ? !!bb.isFallback : true,
            openTimestampMs,
            initialCapital: null,
            openedDays:     undefined,
            openedHours:    undefined,
            profitRate:     null,
        };
    }

    /**
     * Phase 1 純計算：接收 feeMaps（由 FeeFetcher 於 Phase 0 取得），
     * 查找 poolStats / BB，組裝基礎 PositionRecord。
     * 禁止任何 await / RPC / API。
     */
    static aggregateAll(
        rawPositions: RawChainPosition[],
        feeMaps: Map<string, FetchedFees>,
        latestBBs: Record<string, MarketSnapshot>,
        latestPools: PoolStats[],
    ): PositionRecord[] {
        const results: PositionRecord[] = [];

        for (const raw of rawPositions) {
            const poolKey = raw.poolAddress.toLowerCase();
            const poolStats = latestPools.find(
                p => p.id.toLowerCase() === poolKey && p.dex === raw.dex
            );
            if (!poolStats) {
                log.warn(`#${raw.tokenId} no poolStats (${raw.poolAddress.slice(0, 10)}) — skipping`);
                continue;
            }

            const fees = feeMaps.get(raw.tokenId);
            if (!fees) {
                log.warn(`#${raw.tokenId} no fee data in feeMaps — skipping`);
                continue;
            }

            const bb = latestBBs[poolKey] ?? null;
            const rec = this.assemble({
                tokenId: raw.tokenId,
                dex: raw.dex,
                owner: raw.owner,
                depositorWallet: fees.depositorWallet,
                isStaked: raw.isStaked,
                position: raw.position,
                poolAddress: raw.poolAddress,
                poolStats,
                bb,
                unclaimed0: fees.unclaimed0,
                unclaimed1: fees.unclaimed1,
                unclaimed2: fees.unclaimed2,
                fees2USD: fees.fees2USD,
                token2Symbol: fees.token2Symbol,
                feeTierForStats: raw.feeTierForStats,
                openTimestampMs: raw.openTimestampMs,
            });
            results.push(rec);
        }

        return results;
    }
}
