/**
 * Fixed-point BigInt math utility to replace decimal.js
 */
import { constants as cfg } from '../../config/constants';

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
    return cfg.FEE_TIER_TICK_SPACING[feeTier] ?? cfg.FEE_TIER_TICK_SPACING_DEFAULT;
}

// ── BigInt fee-math helpers ───────────────────────────────────────────────────
// Constants are defined in config/constants.ts (MAX_UINT128, Q128, U256).
// Re-exported here for convenience so callers can import from a single math module.
export const { MAX_UINT128, Q128, U256 } = cfg;

/**
 * Unsigned 256-bit wrapping subtraction, equivalent to Solidity `unchecked { a - b }`.
 * Required when fee-growth values may wrap around the uint256 max.
 */
export function sub256(a: bigint, b: bigint): bigint {
    return ((a - b) % cfg.U256 + cfg.U256) % cfg.U256;
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


