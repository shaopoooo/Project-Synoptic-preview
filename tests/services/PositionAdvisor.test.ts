import {
  recommendOpen,
  classifyExit,
  shouldClose,
} from '../../src/services/strategy/positionAdvisor';
import type {
  OpeningStrategy,
  RegimeVector,
  PositionRecord,
  MCSimResult,
} from '../../src/types';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeStrategy(overrides: Partial<OpeningStrategy> = {}): OpeningStrategy {
  return {
    poolAddress: '0xpool',
    sigmaOpt: 1.5,
    score: 0.6,
    cvar95: -0.02,
    mean: 0.05,
    std: 0.08,
    coreBand: { lower: 0.029, upper: 0.033 },
    bufferBand: { lower: 0.024, upper: 0.029 },
    trancheCore: 0.7,
    trancheBuffer: 0.3,
    computedAt: Date.now(),
    ...overrides,
  };
}

function makeRegime(overrides: Partial<RegimeVector> = {}): RegimeVector {
  return {
    range: 0.6,
    trend: 0.2,
    neutral: 0.2,
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    tokenId: '12345',
    dex: 'UniswapV3',
    poolAddress: '0xpool',
    feeTier: 500,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    ownerWallet: '0xowner',
    liquidity: '1000000',
    tickLower: -1000,
    tickUpper: 1000,
    minPrice: '0.029',
    maxPrice: '0.033',
    currentTick: 0,
    currentPriceStr: '0.031',
    positionValueUSD: 10000,
    amount0: 1,
    amount1: 3100,
    unclaimed0: '0',
    unclaimed1: '0',
    unclaimed2: '0',
    unclaimedFeesUSD: 0,
    fees0USD: 0,
    fees1USD: 0,
    fees2USD: 0,
    token2Symbol: '',
    overlapPercent: 100,
    ilUSD: null,
    breakevenDays: 0,
    healthScore: 1,
    regime: 'range',
    lastUpdated: Date.now(),
    volSource: 'test',
    priceSource: 'test',
    bbFallback: false,
    isStaked: false,
    ...overrides,
  };
}

function makeMCResult(overrides: Partial<MCSimResult> = {}): MCSimResult {
  return {
    numPaths: 10000,
    horizon: 14,
    mean: 0.05,
    median: 0.04,
    std: 0.08,
    score: 0.6,
    inRangeDays: 10,
    p5: -0.05,
    p25: 0,
    p50: 0.04,
    p75: 0.08,
    p95: 0.15,
    cvar95: -0.02,
    var95: -0.05,
    go: true,
    ...overrides,
  };
}

// ─── recommendOpen() ─────────────────────────────────────────────────────────

describe('PositionAdvisor.recommendOpen', () => {
  it('test_recommendOpen_scoreAboveThreshold_returnsAdvice', () => {
    const strategy = makeStrategy({ score: 0.6, mean: 0.05, cvar95: -0.02 });
    const regime = makeRegime({ range: 0.6, trend: 0.2, neutral: 0.2 });
    const advice = recommendOpen(strategy, regime, 'UniswapV3 0xpool...');
    expect(advice).not.toBeNull();
    expect(advice!.score).toBe(0.6);
    expect(advice!.expectedReturnPct).toBeCloseTo(5, 6);
    expect(advice!.cvar95Pct).toBeCloseTo(-2, 6);
  });

  it('test_recommendOpen_scoreInGrayZone_returnsNull', () => {
    const strategy = makeStrategy({ score: 0.4 });
    const regime = makeRegime();
    expect(recommendOpen(strategy, regime, 'UniswapV3 0xpool...')).toBeNull();
  });

  it('test_recommendOpen_scoreBelowMin_returnsNull', () => {
    const strategy = makeStrategy({ score: 0.2 });
    const regime = makeRegime();
    expect(recommendOpen(strategy, regime, 'UniswapV3 0xpool...')).toBeNull();
  });

  it('test_recommendOpen_nullStrategy_returnsNull', () => {
    const regime = makeRegime();
    expect(recommendOpen(null, regime, 'UniswapV3 0xpool...')).toBeNull();
  });

  it('test_recommendOpen_trendRegime_stillReturnsAdvice', () => {
    // Advisor 只依數字判斷，regime gating 由 caller 處理
    const strategy = makeStrategy({ score: 0.55 });
    const regime = makeRegime({ range: 0.1, trend: 0.7, neutral: 0.2 });
    const advice = recommendOpen(strategy, regime, 'UniswapV3 0xpool...');
    expect(advice).not.toBeNull();
  });

  it('test_recommendOpen_computedAtZero_returnsNull', () => {
    const strategy = makeStrategy({ score: 0.6, computedAt: 0 });
    const regime = makeRegime();
    expect(recommendOpen(strategy, regime, 'UniswapV3 0xpool...')).toBeNull();
  });
});

// ─── classifyExit() ──────────────────────────────────────────────────────────

describe('PositionAdvisor.classifyExit', () => {
  const PaNorm = 0.029;
  const PbNorm = 0.033;
  const atrHalfWidth = 0.002;

  it('test_classifyExit_inRange_returnsNull', () => {
    const position = makePosition();
    const regime = makeRegime();
    const result = classifyExit(position, 0.031, PaNorm, PbNorm, atrHalfWidth, regime);
    expect(result).toBeNull();
  });

  it('test_classifyExit_shallowLowerPenetration_rangeRegime_hold', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.7, trend: 0.1, neutral: 0.2 });
    const result = classifyExit(position, 0.026, PaNorm, PbNorm, atrHalfWidth, regime);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('hold');
    expect(result!.penetrationDepthAtr).toBeCloseTo(1.5, 6);
  });

  it('test_classifyExit_shallowLowerPenetration_weakRange_rebalance', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.4, trend: 0.3, neutral: 0.3 });
    const result = classifyExit(position, 0.026, PaNorm, PbNorm, atrHalfWidth, regime);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('rebalance');
  });

  it('test_classifyExit_deepLowerPenetration_rangeRegime_rebalance', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.7, trend: 0.1, neutral: 0.2 });
    const result = classifyExit(position, 0.023, PaNorm, PbNorm, atrHalfWidth, regime);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('rebalance');
    expect(result!.penetrationDepthAtr).toBeCloseTo(3, 6);
  });

  it('test_classifyExit_shallowUpperPenetration_rangeRegime_hold', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.7, trend: 0.1, neutral: 0.2 });
    const result = classifyExit(position, 0.036, PaNorm, PbNorm, atrHalfWidth, regime);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('hold');
    expect(result!.penetrationDepthAtr).toBeCloseTo(1.5, 6);
  });

  it('test_classifyExit_zeroAtr_avoidsDivideByZero_rebalance', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.7, trend: 0.1, neutral: 0.2 });
    const result = classifyExit(position, 0.026, PaNorm, PbNorm, 0, regime);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('rebalance');
  });
});

// ─── shouldClose() ───────────────────────────────────────────────────────────

describe('PositionAdvisor.shouldClose', () => {
  // Baseline fixture：所有 trigger 都在閾值下
  const baseRegime = (): RegimeVector => ({ range: 0.6, trend: 0.3, neutral: 0.1 });
  const baseMc = (): MCSimResult => makeMCResult({ score: 0.6 });

  it('test_shouldClose_trendShift_returnsTrendShift', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.2, trend: 0.7, neutral: 0.1 });
    const result = shouldClose(position, baseMc(), regime, null, 0.01);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('trend_shift');
  });

  it('test_shouldClose_lowScore_returnsOpportunityLost', () => {
    const position = makePosition();
    const mc = makeMCResult({ score: 0.2 });
    const result = shouldClose(position, mc, baseRegime(), null, 0.01);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('opportunity_lost');
  });

  it('test_shouldClose_outOfRangeTooLong_returnsTimeout', () => {
    const position = makePosition();
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    const result = shouldClose(position, baseMc(), baseRegime(), fiveHoursAgo, 0.01);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('timeout');
  });

  it('test_shouldClose_highIL_returnsIlThreshold', () => {
    const position = makePosition();
    const result = shouldClose(position, baseMc(), baseRegime(), null, 0.06);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('il_threshold');
  });

  it('test_shouldClose_trendAndIlBoth_priorityTrendWins', () => {
    const position = makePosition();
    const regime = makeRegime({ range: 0.2, trend: 0.7, neutral: 0.1 });
    const result = shouldClose(position, baseMc(), regime, null, 0.06);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('trend_shift');
  });

  it('test_shouldClose_nullOutOfRange_doesNotBlockOtherReasons', () => {
    const position = makePosition();
    // (a) null timeout 不阻擋其他 reason
    const regime = makeRegime({ range: 0.2, trend: 0.7, neutral: 0.1 });
    const hit = shouldClose(position, baseMc(), regime, null, 0.01);
    expect(hit).not.toBeNull();
    expect(hit!.reason).toBe('trend_shift');
    // (b) null timeout + 其他都沒中 → null
    const miss = shouldClose(position, baseMc(), baseRegime(), null, 0.01);
    expect(miss).toBeNull();
  });

  it('test_shouldClose_nullIl_doesNotBlockOtherReasons', () => {
    const position = makePosition();
    // (a) null IL 不阻擋 trend_shift
    const regime = makeRegime({ range: 0.2, trend: 0.7, neutral: 0.1 });
    const hit = shouldClose(position, baseMc(), regime, null, null);
    expect(hit).not.toBeNull();
    expect(hit!.reason).toBe('trend_shift');
    // (b) null IL + 其他都沒中 → null
    const miss = shouldClose(position, baseMc(), baseRegime(), null, null);
    expect(miss).toBeNull();
  });
});
