/**
 * Token metadata helpers — decimal lookup and symbol inference.
 * Single source of truth; replaces inline ternaries and local TOKEN_DEC maps.
 */
import { config } from '../config';

const CBBTC_ADDR = config.TOKEN_ADDRESSES.CBBTC.toLowerCase();
// Uniswap V4 uses address(0) to represent native ETH (not WETH)
const ETH_NATIVE_ADDR = '0x0000000000000000000000000000000000000000';

/** Decimals keyed by canonical symbol (covers all tokens tracked by DexBot). */
export const TOKEN_DECIMALS: Record<string, number> = {
    WETH:  18,
    ETH:   18,
    cbBTC: 8,
    CAKE:  18,
    AERO:  18,
};

/**
 * Returns the ERC-20 decimal count for a token address.
 * Only CBBTC has 8; everything else (WETH, ETH, CAKE, AERO) is 18.
 */
export function getTokenDecimals(address: string): number {
    return address.toLowerCase() === CBBTC_ADDR ? 8 : 18;
}

/**
 * Returns the display symbol for a token address.
 * Handles V4 native ETH (address(0)), cbBTC, and WETH.
 */
export function getTokenSymbol(address: string): 'cbBTC' | 'WETH' | 'ETH' {
    const lower = address.toLowerCase();
    if (lower === CBBTC_ADDR) return 'cbBTC';
    if (lower === ETH_NATIVE_ADDR) return 'ETH';
    return 'WETH';
}
