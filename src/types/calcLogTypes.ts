/**
 * calcLogTypes.ts — 結構化計算日誌的型別定義
 *
 * 每個 event 有獨立 interface，透過 discriminated union 在編譯期
 * 確保呼叫方不會傳入錯誤欄位或遺漏必填欄位。
 *
 * 分級架構（layer）：
 *   CYCLE     — 整個週期的全局資訊（最高，每週期一條）
 *   POOL      — 每個 pool 的市場 / 策略計算
 *   CANDIDATE — 每個 sigma 候選的 MC 評分（最細粒度）
 *   POSITION  — 每個倉位的風險計算
 *
 * Pipeline 階段（phase）：
 *   P0 — Phase 0 Prefetch（I/O 抓取）
 *   P1 — Phase 1 Compute / MCEngine（純計算）
 */

// ── CYCLE ─────────────────────────────────────────────────────────────────────

export interface CycleStartEvent {
    phase: 'P0';
    layer: 'CYCLE';
    event: 'cycle_start';
    poolCount: number;
    ethPrice: number;
    cbbtcPrice: number;
    cakePrice: number;
    aeroPrice: number;
    /** Unix ms，ETH 價格的實際抓取時間（非快取時間） */
    ethFetchedAt: number;
}

// ── POOL ──────────────────────────────────────────────────────────────────────

export interface PoolBBEvent {
    phase: 'P0';
    layer: 'POOL';
    event: 'pool_bb';
    pool: string;
    dex: string;
    feeTier: number;
    sma: number;
    upperPrice: number;
    lowerPrice: number;
    /** (upperPrice - lowerPrice) / sma；null 表示 sma <= 0 */
    bandwidth: number | null;
    volatility30D: number;
    stdDev1H: number | null;
    smaSlope: number | null;
    isFallback: boolean;
    isWarmup: boolean;
    /** 動態 BB 倍數 k */
    k: number | null;
}

export interface PoolRegimeEvent {
    phase: 'P1';
    layer: 'POOL';
    event: 'pool_regime';
    pool: string;
    dex: string;
    chop: number;
    hurst: number;
    /** 原始 ATR 值（價格單位） */
    atr: number;
    signal: 'range' | 'trend' | 'neutral';
    returnCount: number;
    volatility30D: number;
}

export interface PoolMCResultEvent {
    phase: 'P1';
    layer: 'POOL';
    event: 'pool_mc_result';
    pool: string;
    dex: string;
    /** 最優候選對應的 ATR 倍數 k（null = stdDev1H 無效） */
    kBest: number | null;
    sigmaOpt: number;
    coreLower: number;
    coreUpper: number;
    bufferLower: number;
    bufferUpper: number;
    score: number;
    cvar95: number;
    mean: number;
    median: number;
    inRangeDays: number;
    capitalEfficiency: number;
    goCandidateCount: number;
    trancheCore: number;
    trancheBuffer: number;
    atrHalfWidth: number;
    /** computeRangeGuards() 回傳的第 5 百分位數（下護欄） */
    guardsP5: number;
    /** computeRangeGuards() 回傳的第 95 百分位數（上護欄） */
    guardsP95: number;
    stdDev1H: number;
}

// ── CANDIDATE ─────────────────────────────────────────────────────────────────

export interface PoolMCCandidateEvent {
    phase: 'P1';
    layer: 'CANDIDATE';
    event: 'pool_mc_candidate';
    pool: string;
    dex: string;
    /** ATR 倍數（來自 ATR_K_CANDIDATES） */
    k: number;
    sigma: number;
    lowerPrice: number;
    upperPrice: number;
    capitalEfficiency: number;
    dailyFeesToken0: number;
    go: boolean;
    noGoReason: string | null;
    mean: number;
    median: number;
    cvar95: number;
    inRangeDays: number;
    /** mean / |cvar95|；go=false 時為 null */
    score: number | null;
}

// ── POSITION ──────────────────────────────────────────────────────────────────

export interface PositionRiskEvent {
    phase: 'P1';
    layer: 'POSITION';
    event: 'position_risk';
    tokenId: string;
    pool: string;
    dex: string;
    positionValueUSD: number;
    unclaimedFeesUSD: number;
    ilUSD: number | null;
    openedDays: number | null;
    profitRate: number | null;
    currentBandwidth: number;
    avg30DBandwidth: number;
    driftOverlapPct: number;
    driftWarning: boolean;
    ilBreakevenDays: number;
    healthScore: number;
    redAlert: boolean;
    highVolatilityAvoid: boolean;
    compoundSignal: boolean | null;
    compoundThreshold: number | null;
    compoundIntervalDays: number | null;
}

// ── Discriminated union ───────────────────────────────────────────────────────

export type CalcLogEntry =
    | CycleStartEvent
    | PoolBBEvent
    | PoolRegimeEvent
    | PoolMCCandidateEvent
    | PoolMCResultEvent
    | PositionRiskEvent;
