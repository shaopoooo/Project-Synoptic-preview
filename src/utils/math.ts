/**
 * Fixed-point BigInt math utility to replace decimal.js
 */

export function tickToRatio(tick: number): number {
    return Math.pow(1.0001, tick);
}

/** Convert a Uniswap V3 tick to a human-readable price ratio, adjusted for token decimals. */
export function tickToPrice(tick: number, dec0: number, dec1: number): number {
    return tickToRatio(tick) * Math.pow(10, dec0 - dec1);
}

/**
 * Concentrated liquidity capital efficiency multiplier vs full-range.
 * Formula: 1 / (√(upperPrice/sma) - √(lowerPrice/sma))
 * Returns null if inputs are invalid or denominator ≤ 0.
 * Capped at 100× to prevent extreme values near range boundary.
 */
export function calculateCapitalEfficiency(
    upperPrice: number,
    lowerPrice: number,
    sma: number
): number | null {
    if (sma <= 0 || lowerPrice <= 0 || upperPrice <= lowerPrice) return null;
    const denom = Math.sqrt(upperPrice / sma) - Math.sqrt(lowerPrice / sma);
    if (denom <= 0) return null;
    return Math.min(1 / denom, 100);
}


