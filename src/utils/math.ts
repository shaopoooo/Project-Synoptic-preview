/**
 * Fixed-point BigInt math utility to replace decimal.js
 */

/**
 * Normalize a float raw amount (from sqrtPrice math) by token decimals.
 * posAmountRaw is already a JS number, so standard division is sufficient.
 */
export function normalizeAmount(rawFloat: number, decimals: number): number {
    return rawFloat / Math.pow(10, decimals);
}

/**
 * Normalize a BigInt-string raw amount (e.g. unclaimed fees from contract) by token decimals.
 * Uses BigInt arithmetic to avoid precision loss before converting to float.
 * Result is a JS number (fine for display/USD calculation at this scale).
 */
export function normalizeRawAmount(rawStr: string, decimals: number): number {
    if (!rawStr || rawStr === '0') return 0;
    const raw = BigInt(rawStr);
    const scale = BigInt(10) ** BigInt(decimals);
    const whole = raw / scale;
    const frac  = raw % scale;
    return Number(whole) + Number(frac) / Math.pow(10, decimals);
}

/**
 * Map normalized feeTier (e.g. 0.0001, 0.003) to Uniswap V3-style tickSpacing.
 * Used by both runBBEngine (index.ts) and PositionScanner._fetchNpmData.
 */
export function feeTierToTickSpacing(feeTier: number): number {
    if (feeTier === 0.0001 || feeTier === 0.000085) return 1;
    if (feeTier === 0.003) return 60;
    return 10; // default: covers 0.05% and other pools
}

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


