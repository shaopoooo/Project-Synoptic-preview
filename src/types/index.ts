// Central type definitions for DexBot.
// All shared interfaces live here.
import type { Log } from 'ethers';

export type Dex = 'UniswapV3' | 'UniswapV4' | 'PancakeSwapV3' | 'PancakeSwapV2' | 'Aerodrome';

export interface PoolStats {
    id: string;
    dex: Dex;
    feeTier: number;
    apr: number;
    farmApr?: number;       // CAKE/AERO emission APR (staking rewards), undefined if not applicable
    tvlUSD: number;
    dailyFeesUSD: number;
    tick: number;
    sqrtPriceX96: bigint;
    volSource: string;
}

export interface BBResult {
    sma: number;
    upperPrice: number;
    lowerPrice: number;
    k: number;
    volatility30D: number;
    tickLower: number;
    tickUpper: number;
    ethPrice: number;
    cbbtcPrice: number;
    cakePrice: number;
    aeroPrice: number;
    minPriceRatio: number;
    maxPriceRatio: number;
    isFallback?: boolean;
    regime: string;
}

export interface PositionState {
    capital: number;
    tickLower: number;
    tickUpper: number;
    unclaimedFees: number;
    cumulativeIL: number;
}

export interface RiskAnalysis {
    driftOverlapPct: number;
    driftWarning: boolean;
    compoundThreshold: number;
    compoundSignal: boolean;
    compoundIntervalDays: number | null; // 最佳複利間隔天數 = threshold / dailyFeesUSD；dailyFeesUSD=0 時為 null
    healthScore: number;
    ilBreakevenDays: number;
    redAlert: boolean;
    highVolatilityAvoid: boolean;
}

export interface RebalanceSuggestion {
    newMinPrice: number;
    newMaxPrice: number;
    recommendedStrategy: 'wait' | 'dca' | 'withdrawSingleSide' | 'avoidSwap';
    strategyName: string;
    driftPercent: number;
    estGasCost: number;
    notes: string;
}

/** 身份識別 + 鏈上快照（不含計算欄位） */
export interface PositionCore {
    tokenId: string;
    dex: Dex;
    poolAddress: string;
    feeTier: number;
    token0Symbol: string;
    token1Symbol: string;
    ownerWallet: string;
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    minPrice: string;
    maxPrice: string;
    bbMinPrice?: string;
    bbMaxPrice?: string;
    currentTick: number;
    currentPriceStr: string;
    positionValueUSD: number;
    amount0: number;  // normalized token0 amount in LP position
    amount1: number;  // normalized token1 amount in LP position
}

/** 手續費 + 未領取金額 */
export interface PositionFees {
    /** Raw BigInt string from contract; must normalize via normalizeRawAmount() before display */
    unclaimed0: string;
    /** Raw BigInt string from contract; must normalize via normalizeRawAmount() before display */
    unclaimed1: string;
    /** Raw BigInt string from contract; must normalize via normalizeRawAmount() before display */
    unclaimed2: string;
    unclaimedFeesUSD: number;
    fees0USD: number;
    fees1USD: number;
    fees2USD: number;
    token2Symbol: string;
}

/** 風險指標（RiskManager 計算產出） */
export interface PositionMetrics {
    overlapPercent: number;
    ilUSD: number | null;
    breakevenDays: number;
    healthScore: number;
    regime: string;
    riskAnalysis?: RiskAnalysis;
}

/** 顯示 / 元數據 */
export interface PositionMeta {
    lastUpdated: number;
    openTimestampMs?: number;
    apr?: number;
    inRangeApr?: number;
    volSource: string;
    priceSource: string;
    bbFallback: boolean;
    isStaked: boolean;
    rebalance?: RebalanceSuggestion;
    initialCapital?: number | null;
    openedDays?: number;
    openedHours?: number;
    profitRate?: number | null;
}

export type PositionRecord = PositionCore & PositionFees & PositionMetrics & PositionMeta;



/**
 * Shape of the NPM positions() return value (V3/V4/PancakeSwap/Aerodrome).
 * V3/PancakeSwap/Aerodrome: fee/tick/liquidity come as bigint from ethers v6.
 * V4: tick/fee are number (decoded from packed PositionInfo); liquidity is bigint.
 * Callers must use Number()/BigInt() for arithmetic to handle both cases.
 */
export interface NpmPositionData {
    token0: string;
    token1: string;
    fee: number | bigint;
    tickLower: number | bigint;
    tickUpper: number | bigint;
    liquidity: number | bigint;
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
}

/** Result from FeeCalculator.fetchUnclaimedFees() */
export interface FeeQueryResult {
    unclaimed0: bigint;
    unclaimed1: bigint;
    depositorWallet: string;
    source: string;
    gaugeAddress?: string;  // Aerodrome staked 時快取，供 fetchThirdPartyRewards 重用避免重複 RPC
}

/** Result from FeeCalculator.fetchThirdPartyRewards() */
export interface RewardsQueryResult {
    unclaimed2: bigint;
    fees2USD: number;
    token2Symbol: string;
    depositorWallet: string;
}

/** Input for PositionAggregator.assemble() */
export interface AggregateInput {
    tokenId: string;
    dex: Dex;
    owner: string;
    depositorWallet: string;
    isStaked: boolean;
    position: NpmPositionData;
    poolAddress: string;
    poolStats: PoolStats;
    bb: BBResult | null;
    unclaimed0: bigint;
    unclaimed1: bigint;
    unclaimed2: bigint;
    fees2USD: number;
    token2Symbol: string;
    feeTierForStats: number;
    openTimestampMs?: number;
}

/** Raw NPM chain data — fetched by PositionScanner, consumed by PositionAggregator */
export interface RawChainPosition {
    tokenId: string;
    dex: Dex;
    ownerWallet: string;       // original wallet (from syncFromChain / manual)
    owner: string;             // ownerOf() result — may be a gauge contract
    isStaked: boolean;
    position: NpmPositionData; // NPM positions() return value
    poolAddress: string;
    feeTier: number;           // raw NPM fee field (e.g. 100, 500, 85, 1)
    feeTierForStats: number;   // normalized (e.g. 0.000085 for Aerodrome)
    tickSpacing: number;
    openTimestampMs?: number;
}

/** Sort criteria for Telegram reports */
export type SortBy = 'size' | 'apr' | 'unclaimed' | 'health';

// ─── UserConfig types ─────────────────────────────────────────────────────────

export interface WalletPosition {
    tokenId: string;
    dexType: Dex;
    initial: number;        // 初始本金 USD；0 = 未設定
    externalStake: boolean; // true = 鎖倉（不在錢包 NFT balance 中，如 Gauge）
    openTimestamp?: number; // NFT mint 時間戳 ms；-1 = 查詢放棄（N/A）；undefined = 待查
    closed?: boolean;       // true = liquidity=0 已確認關閉，跳過所有 RPC 查詢
}

export interface WalletEntry {
    address: string;
    positions: WalletPosition[];  // 此錢包已知的所有倉位（含配置 + 開倉時間）
}

export interface PoolConfig {
    address: string;
    dex: Dex;
    fee: number;
}

/** 使用者配置（由 Telegram 指令動態管理，持久化於 state.json）。 */
export interface UserConfig {
    wallets: WalletEntry[];
    pools?: PoolConfig[];   // 若未設定，fallback 至 config.POOLS
    sortBy?: SortBy;        // 倉位排序鍵，預設 'size'
    intervalMinutes?: number; // 掃描間隔（分鐘），預設由 config.DEFAULT_INTERVAL_MINUTES
    flashIntervalMinutes?: number;  // 快訊推播間隔（分鐘），預設 60；必須 > intervalMinutes 且為 10 倍數
    fullReportIntervalMinutes?: number; // 完整報告間隔（分鐘），預設 1440；必須 ≥ flashIntervalMinutes 且為 10 倍數
    bbKLowVol?: number;     // BB k 值（低波動市），預設由 config.BB_K_LOW_VOL
    bbKHighVol?: number;    // BB k 值（高波動市），預設由 config.BB_K_HIGH_VOL
    compactMode?: boolean;  // 簡化訊息模式，開啟時每倉位壓縮為約 2 行
}

// ─── Report snapshots ─────────────────────────────────────────────────────────

/** 每次送完整報告後記錄的倉位快照，用於下次完整報告計算差異（不持久化）。 */
export interface FullReportSnapshot {
    positionValueUSD: number;
    unclaimedFeesUSD: number;
    ilUSD: number | null;
}

// ─── Cache entry types ────────────────────────────────────────────────────────

export interface BBVolEntry {
    vol: number;
    expiresAt: number;
}

export interface PoolVolEntry {
    daily: number;
    avg7d: number;
    source: string;
    expiresAt: number;
}

// ─── Token prices ─────────────────────────────────────────────────────────────

export interface TokenPrices {
    ethPrice: number;    ethFetchedAt: number;
    cbbtcPrice: number;  cbbtcFetchedAt: number;
    cakePrice: number;   cakeFetchedAt: number;
    aeroPrice: number;   aeroFetchedAt: number;
    fetchedAt: number;   // 最近一次 fetch 嘗試時間（用於 TTL 判斷）
}

// ─── PnL / Portfolio ──────────────────────────────────────────────────────────

export interface OpenInfo {
    days: number;
    hours: number;
    timeStr: string;           // e.g. "3天2小時" or "5小時"
    profitRate: number | null; // percentage, e.g. 9.17 (null if no capital set)
}

export interface PortfolioSummary {
    positionCount: number;
    walletCount: number;
    totalPositionUSD: number;
    totalUnclaimedUSD: number;
    totalInitialCapital: number;   // sum of configured initial investments across all positions
    totalPnL: number | null;       // null if no positions have capital configured
    totalPnLPct: number | null;    // totalPnL / totalInitialCapital × 100
}

// ─── ChainEventScanner ────────────────────────────────────────────────────────

export interface ScanRequest {
    tokenId: string;
    npmAddress: string;
    dex: string;
    openTimestampMs?: number;
}

export interface ScanHandler {
    name: string;
    topic0: string;
    /** Which topics[] index holds the tokenId in matching logs */
    tokenIdTopicIndex: 1 | 2 | 3;
    /** Additional topic filters inserted between topic0 and the tokenId OR filter */
    extraTopics?: (string | string[] | null)[];
    stopOnFirstMatch: boolean;
    needsBlockTimestamp: boolean;
    /** Return the fromBlock for this request. Return currentBlock+1 to skip scanning. */
    getFromBlock(req: ScanRequest, currentBlock: number): number;
    processLog(log: Log, req: ScanRequest, blockTimestamp?: number): Promise<void>;
    /** Called after EACH successful getLogs chunk. */
    onChunkSuccess?(requests: ScanRequest[], chunkFromBlock: number): void;
    /**
     * Called after the scan loop for each NPM group.
     * @param successfullyScanned tokenIds included in at least one successful getLogs chunk
     * @param lowestScannedBlock  lowest fromBlock of any successful chunk (undefined if all failed)
     */
    onBatchComplete(
        npmAddress: string,
        group: ScanRequest[],
        currentBlock: number,
        successfullyScanned: Set<string>,
        lowestScannedBlock?: number,
    ): void;
}

// ─── State persistence types ──────────────────────────────────────────────────

/** Legacy position format — kept only for loadState() migration reads. */
export interface DiscoveredPosition {
    tokenId: string;
    dex: Dex;
    ownerWallet: string;
}

export interface PersistedState {
    volCacheBB:   Record<string, BBVolEntry>;
    volCachePool: Record<string, PoolVolEntry>;
    priceBuffer:  Record<string, Record<string, number>>;  // poolAddr → hourTs → price
    bandwidthWindows?: Record<string, number[]>;            // poolAddr → rolling 30D bandwidth window
    stakeDiscoveryLastBlock?: Record<string, number>;       // wallet → 最後一次質押偵測掃到的 block，用於增量掃描
    userConfig?: UserConfig;                                // 錢包 + 倉位配置（含 openTimestamp、sortBy、intervalMinutes、bbK、closedTokenIds）

    // ── 舊版欄位（僅供 loadState 遷移讀取，新版不再寫入） ──
    /** @deprecated 已合併至 userConfig.closedTokenIds */
    closedTokenIds?: string[];
    /** @deprecated 已合併至 userConfig */
    sortBy?: string;
    /** @deprecated 已合併至 userConfig.intervalMinutes */
    intervalMinutes?: number;
    /** @deprecated 已合併至 userConfig.bbKLowVol */
    bbKLowVol?: number;
    /** @deprecated 已合併至 userConfig.bbKHighVol */
    bbKHighVol?: number;
    /** @deprecated 已合併至 userConfig.wallets[].positions[].openTimestamp */
    openTimestamps?: Record<string, number>;
    /** @deprecated 已合併至 userConfig.wallets[].positions[] */
    discoveredPositions?: DiscoveredPosition[];
    /** @deprecated 已從 userConfig.wallets[].address 衍生 */
    syncedWallets?: string[];
}
