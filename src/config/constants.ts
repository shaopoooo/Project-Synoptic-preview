import { env } from './env';

export const constants = {
    // RPC
    RPC_FALLBACKS: [
        'https://base-rpc.publicnode.com',
        'https://1rpc.io/base',
    ],

    // Subgraph Endpoints – free public endpoints (no API key)
    SUBGRAPHS: {
        // Uniswap: `https://gateway.thegraph.com/api/${env.SUBGRAPH_API_KEY}/subgraphs/id/FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS`,
        // PancakeSwap: `https://gateway.thegraph.com/api/${env.SUBGRAPH_API_KEY}/subgraphs/id/84ADrft27B8Jo46mdknbJ3PHoJ5wK5YeNBrYTD19WnaH`
    } as Record<string, string>,

    // Cache TTLs
    BB_VOL_CACHE_TTL_MS: 6 * 60 * 60 * 1000, // 6 hours
    POOL_VOL_CACHE_TTL_MS: 30 * 60 * 1000,   // 30 minutes

    // Core Pools (Base Network)
    POOLS: {
        PANCAKE_WETH_CBBTC_0_01: '0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3',
        PANCAKE_WETH_CBBTC_0_05: '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
        UNISWAP_WETH_CBBTC_0_05: '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
        UNISWAP_WETH_CBBTC_0_3: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
        AERO_WETH_CBBTC_0_0085: '0x22aee3699b6a0fed71490c103bd4e5f3309891d5', // Aerodrome Slipstream, fee=85 (0.0085%), tickSpacing=1
    },

    // Math config
    DECIMAL_PRECISION: 18n,

    // Position tracking list
    EOQ_THRESHOLD: 5,  // Unclaimed fees threshold in USD
    CAPITAL: 20000,      // Total deployed capital in USD for scaling calculations

    // Contract Addresses on Base
    AERO_VOTER_ADDRESS: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5', // Aerodrome Voter on Base

    NPM_ADDRESSES: {
        Uniswap: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // Uniswap V3 NPM on Base
        PancakeSwap: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', // PancakeSwap V3 NPM on Base
        Aerodrome: '0x827922686190790b37229fd06084350E74485b72', // Aerodrome Slipstream NPM on Base
    } as Record<string, string>,
};
