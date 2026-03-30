import { config } from '../../config';
import { MarketPattern } from '../../types';

/**
 * 根據當前帶寬與 30D 均值判斷 BB 型態。
 */
export function detectBBPattern(
    bandwidth: number,
    avg30DBandwidth: number,
    currentPrice: number,
    sma: number,
    upperPrice: number,
    lowerPrice: number,
): MarketPattern {
    if (bandwidth < avg30DBandwidth * config.BB_SQUEEZE_THRESHOLD) {
        return 'squeeze';
    }
    if (bandwidth > avg30DBandwidth * config.BB_EXPANSION_THRESHOLD) {
        const halfBand = (upperPrice - lowerPrice) / 2;
        const priceOffset = Math.abs(currentPrice - sma);
        return priceOffset > halfBand * config.BB_TRENDING_OFFSET_THRESHOLD
            ? 'trending'
            : 'expansion';
    }
    return 'normal';
}
