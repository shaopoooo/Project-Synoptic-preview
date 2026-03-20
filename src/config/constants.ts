import { env } from './env';
import { SortBy, Dex } from '../types';

export const constants = {
    // ── Network ────────────────────────────────────────────────────────────
    BASE_CHAIN_ID: 8453,

    // ── RPC ────────────────────────────────────────────────────────────────
    RPC_FALLBACKS: [
        'https://base-rpc.publicnode.com'
    ],
    RPC_STALL_TIMEOUT_MS: 3000,

    // ── Subgraph Endpoints ─────────────────────────────────────────────────
    SUBGRAPHS: {
        // UniswapV3: `https://gateway.thegraph.com/api/${env.SUBGRAPH_API_KEY}/subgraphs/id/FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS`,
        // PancakeSwapV3: `https://gateway.thegraph.com/api/${env.SUBGRAPH_API_KEY}/subgraphs/id/84ADrft27B8Jo46mdknbJ3PHoJ5wK5YeNBrYTD19WnaH`
    } as Record<string, string>,

    // ── API Endpoints ──────────────────────────────────────────────────────
    USER_AGENT: 'DexBot/1.0',
    API_URLS: {
        GECKOTERMINAL_OHLCV: 'https://api.geckoterminal.com/api/v2/networks/base/pools',
        DEXSCREENER_PAIRS: 'https://api.dexscreener.com/latest/dex/pairs/base',
        DEXSCREENER_TOKENS: 'https://api.dexscreener.com/latest/dex/tokens',
    },

    // ── Token Addresses (Base Network) ─────────────────────────────────────
    TOKEN_ADDRESSES: {
        WETH: '0x4200000000000000000000000000000000000006',
        CBBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
        CAKE: '0x3055913c90Fcc1A6CE9a358911721eEb942013A1',
        AERO: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
    },

    // ── Cache TTLs (ms) ───────────────────────────────────────────────────
    BB_VOL_CACHE_TTL_MS: 6 * 60 * 60 * 1000, // 6 hours
    POOL_VOL_CACHE_TTL_MS: 30 * 60 * 1000,      // 30 minutes
    TOKEN_PRICE_CACHE_TTL_MS: 2 * 60 * 1000,    // 2 minutes
    GAS_COST_CACHE_TTL_MS: 5 * 60 * 1000,     // 5 minutes

    // ── Time Constants (ms) ───────────────────────────────────────────────
    ONE_HOUR_MS: 60 * 60 * 1000,
    ONE_DAY_MS: 24 * 60 * 60 * 1000,

    // ── Block Scanning ────────────────────────────────────────────────────
    // 公共節點（publicnode / 1rpc）對複雜 topics filter 有 block range 限制，
    // 500 blocks/chunk 可避免 -32002 timeout；付費節點可調高至 2000。
    BLOCK_SCAN_CHUNK: 500,
    // 25M → 3M（約 70 天）：stopOnFirstMatch 從新往舊掃，近期建倉幾乎立即命中；
    // 超過 70 天的舊倉位開倉時間會顯示 N/A，建議手動設定 INITIAL_INVESTMENT_<tokenId>。
    BLOCK_LOOKBACK: 3_000_000,
    BASE_BLOCK_TIME_MS: 2_000,
    COLLECTED_FEES_MAX_FAILURES: 3,   // 連續失敗上限，超過即中止本次掃描
    COLLECTED_FEES_CHUNK_DELAY_MS: 200,  // 500-block chunk 數量增加，delay 略拉長降低 rate-limit 風險

    // ── BB Engine Parameters ──────────────────────────────────────────────
    BB_K_LOW_VOL: 1.8,   // 震盪市 (vol < threshold)
    BB_K_HIGH_VOL: 2.5,   // 趨勢市 (vol >= threshold)
    BB_VOL_THRESHOLD: 0.50,  // 年化波動率分界
    BB_MAX_OFFSET_PCT: 0.15, // 帶寬上限 ±15%
    BB_HOURLY_WINDOW: 20,    // getPrices 最後 N 小時
    BB_FALLBACK_K: 2.0,
    BB_FALLBACK_VOL: 0.5,
    BB_FALLBACK_TICK_OFFSET: 1000,
    EWMA_ALPHA: 0.3,         // 短期平滑係數
    EWMA_BETA: 0.7,         // 長期平滑係數
    MIN_CANDLES_FOR_EWMA: 5,
    BANDWIDTH_WINDOW_MAX: 30 * 24 * 12, // 30D × 288 cycles/day (5-min interval) = 8640

    // ── Scheduler ─────────────────────────────────────────────────────────────
    DEFAULT_INTERVAL_MINUTES: 10, // 預設排程間隔（分鐘），可透過 /interval 修改
    TIMESTAMP_MAX_FAILURES: 3,    // mint timestamp 查詢失敗上限，超過後標記 N/A 停止重試

    // ── Gas ───────────────────────────────────────────────────────────────
    GAS_UNITS_COMPOUND: 300_000n,  // Base 上 collect + reinvest 估算用 gas
    DEFAULT_GAS_COST_USD: 1.5,     // Gas oracle 失敗時的 fallback

    // ── Uniswap V4 Contracts (Base Network) ──────────────────────────────
    V4_POOL_MANAGER: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    V4_POSITION_MANAGER: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
    V4_STATE_VIEW: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',

    // ── Core Pools (Base Network) ─────────────────────────────────────────
    // 新增池子只需在此加一筆；PoolScanner 與 PositionScanner 均從這裡讀取。
    POOLS: [
        { address: '0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3', dex: 'PancakeSwapV3' as const, fee: 0.0001  },
        { address: '0xd974d59e30054cf1abeded0c9947b0d8baf90029', dex: 'PancakeSwapV3' as const, fee: 0.0005  },
        { address: '0x7aea2e8a3843516afa07293a10ac8e49906dabd1', dex: 'UniswapV3'     as const, fee: 0.0005  },
        { address: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5', dex: 'UniswapV3'     as const, fee: 0.003   },
        { address: '0x22aee3699b6a0fed71490c103bd4e5f3309891d5', dex: 'Aerodrome'     as const, fee: 0.000085 }, // tickSpacing=1
        { address: '0xe6195a1f1c8f5d0bcf0a880db26738a1df4f6863017700a8f6377a72d45366f2', dex: 'UniswapV4' as const, fee: 0.003   },
        { address: '0x8fe985a6a484e89af85189f7efc20de0183d0c3415bf2a9ceefa5a7d1af879e5', dex: 'UniswapV4' as const, fee: 0.00009 },
    ] as { address: string; dex: Dex; fee: number }[],

    // ── Token Decimals ────────────────────────────────────────────────────
    // Single source of truth for ERC-20 decimal places.
    // All normalization (raw BigInt → float) must read from here.
    TOKEN_DECIMALS: {
        WETH:  18,
        ETH:   18,
        cbBTC: 8,
        CAKE:  18,
        AERO:  18,
    } as Record<string, number>,

    // ── Display Precision ─────────────────────────────────────────────────
    // Centralised toFixed() values — all display formatting must read from here.
    FMT: {
        PRICE:         8,   // tick → price string (minPrice, maxPrice, BB bounds, rebalance ratios)
        TOKEN_AMOUNT:  6,   // normalised token qty in log lines (CAKE, AERO, etc.)
        USD_WHOLE:     0,   // large USD rounded   (position value, TVL, capital, ETH/BTC price)
        USD_TENTH:     1,   // USD to $0.1         (PnL, unclaimed total, APR log)
        USD_CENTS:     2,   // USD to $0.01        (fee detail per token, gas cost, investment)
        USD_MILLI:     3,   // USD to $0.001       (small reward fees, CAKE/AERO price)
        PCT_TENTH:     1,   // % to 0.1            (APR log, drift %, efficiency multiplier)
        PCT_HUNDREDTH: 2,   // % to 0.01           (Telegram APR ranking, ROI / profit rate)
        FEE_TIER:      4,   // fee tier display    ("0.0085%")
    },

    // ── Math Config ───────────────────────────────────────────────────────
    DECIMAL_PRECISION: 18n,
    /** 2^128 - 1  (max value of a uint128, used in collect.staticCall amount caps) */
    MAX_UINT128: 2n ** 128n - 1n,
    /** 2^128  (fixed-point denominator for X128 fee-growth values) */
    Q128: 2n ** 128n,
    /** 2^256  (modulus for unsigned 256-bit wrapping subtraction) */
    U256: 2n ** 256n,

    // ── Position Tracking ─────────────────────────────────────────────────
    EOQ_THRESHOLD: 5,  // Unclaimed fees threshold in USD
    DRIFT_WARNING_PCT: 80,          // Overlap % below which to show drift warning
    RED_ALERT_BREAKEVEN_DAYS: 30,   // IL Breakeven Days 超過此值觸發 RED_ALERT
    HIGH_VOLATILITY_FACTOR: 2,      // currentBandwidth > factor × avg30D 觸發 HIGH_VOLATILITY_AVOID

    // ── Concurrency ───────────────────────────────────────────────────────
    AGGREGATE_CONCURRENCY: 4,  // aggregateAll 並行 RPC 請求上限

    // ── Contract Addresses on Base ────────────────────────────────────────
    AERO_VOTER_ADDRESS: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
    // PancakeSwap V3 MasterChef — 質押 LP NFT 取得 CAKE 獎勵（Base 已驗證地址）
    PANCAKE_MASTERCHEF_V3: env.PANCAKE_MASTERCHEF_V3,
    // cakePerSecond scaling: getLatestPeriodInfo 回傳值需除以 1e30 才是實際 CAKE/s
    MASTERCHEF_CAKE_PER_SEC_PRECISION: BigInt('1000000000000000000000000000000'), // 1e30

    NPM_ADDRESSES: {
        UniswapV3: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
        UniswapV4: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
        PancakeSwapV3: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
        // PancakeSwapV2 uses ERC-20 LP tokens (not ERC-721 NFTs) — different tracking mechanism
        // PancakeSwapV2: '',  // TODO: add when V2 position tracking is implemented
        Aerodrome: '0x827922686190790b37229fd06084350E74485b72',
    } as Record<string, string>,

    // ── Fee Tier → Tick Spacing mapping ──────────────────────────────────
    // Source of truth for all feeTier → tickSpacing conversions.
    // Used by feeTierToTickSpacing() in utils/math.ts.
    FEE_TIER_TICK_SPACING: {
        0.000085: 1,
        0.00009:  1,
        0.0001:   1,
        0.003:    60,
    } as Record<number, number>,
    FEE_TIER_TICK_SPACING_DEFAULT: 10,   // covers 0.05% and other pools

    // ── Rebalance Thresholds ──────────────────────────────────────────────
    REBALANCE_DRIFT_MIN_PCT: 5,          // 觸發再平衡的最小偏離 %
    REBALANCE_WAIT_DRIFT_PCT: 10,        // 偏離 < 此值 → 等待回歸策略
    REBALANCE_WAIT_BREAKEVEN_DAYS: 15,   // 等待策略的 breakeven 門檻（天）
    REBALANCE_DCA_DRIFT_PCT: 20,         // 偏離 < 此值 → DCA 策略
    REBALANCE_PRICE_UPPER_MARGIN: 0.9999, // 單邊建倉：上限安全邊際
    REBALANCE_PRICE_LOWER_MARGIN: 1.0001, // 單邊建倉：下限安全邊際
    REBALANCE_GAS_COST_USD: 0.1,         // 單次 rebalance 估算 Gas（USD）
    REBALANCE_SD_OFFSET_RATIO: 0.3,      // SD offset 係數（單邊建倉中心點偏移量）
    REBALANCE_GAS_THRESHOLD_MULTIPLE: 2, // Gas 降級門檻乘數（unclaimed × 此值 > gas 才執行）

    // ── Telegram Bot ──────────────────────────────────────────────────────
    SORT_LABELS: {
        size: '倉位大小',
        apr: '年化報酬',
        unclaimed: '可領取',
        health: '健康值',
    } as Record<SortBy, string>,

    /** 允許透過 Telegram 指令輸入的 DEX 值 */
    VALID_DEXES: ['UniswapV3', 'UniswapV4', 'PancakeSwapV3', 'Aerodrome'] as Dex[],

    /** 舊版 DEX 命名 → 新版命名遷移表（loadState migration 使用） */
    DEX_MIGRATION: { Uniswap: 'UniswapV3', PancakeSwap: 'PancakeSwapV3' } as Record<string, string>,
};
