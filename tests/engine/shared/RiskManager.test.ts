import { RiskManager } from '../../../src/engine/shared/RiskManager';
import { MarketSnapshot, PositionState } from '../../../src/types';

const makeBB = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
    sma: 0.03,
    upperPrice: 0.033,
    lowerPrice: 0.027,
    k: 2,
    volatility30D: 0.5,
    tickLower: -100,
    tickUpper: 100,
    ethPrice: 3000,
    cbbtcPrice: 60000,
    cakePrice: 2,
    aeroPrice: 1,
    minPriceRatio: 0.027,
    maxPriceRatio: 0.033,
    isFallback: false,
    regime: 'Low Vol (震盪市)',
    ...overrides,
});

const makeState = (overrides: Partial<PositionState> = {}): PositionState => ({
    capital: 10000,
    tickLower: -80,
    tickUpper: 80,
    unclaimedFees: 50,
    cumulativeIL: -20,
    ...overrides,
});

describe('RiskManager.calculateDrift', () => {
    it('returns 100 when position fully inside BB', () => {
        expect(RiskManager.calculateDrift(-50, 50, -100, 100)).toBe(100);
    });

    it('returns 0 when no overlap', () => {
        expect(RiskManager.calculateDrift(200, 300, -100, 100)).toBe(0);
    });

    it('returns 50 when half overlap', () => {
        // position [-100, 100], BB [0, 200] → overlap [0,100] = 100 ticks / 200 ticks = 50%
        expect(RiskManager.calculateDrift(-100, 100, 0, 200)).toBe(50);
    });

    it('returns 0 for zero-width position (no range to overlap)', () => {
        // overlapLower >= overlapUpper triggers before posRange===0 check
        expect(RiskManager.calculateDrift(50, 50, -100, 100)).toBe(0);
    });
});

describe('RiskManager.analyzePosition', () => {
    it('flags redAlert when breakevenDays > 30', () => {
        // cumulativeIL = -900, dailyFees = 1 → breakevenDays = 900 > 30
        const state = makeState({ cumulativeIL: -900, unclaimedFees: 10 });
        const result = RiskManager.analyzePosition(state, makeBB(), 1, 0.1, 0.1);
        expect(result.redAlert).toBe(true);
        expect(result.ilBreakevenDays).toBeGreaterThan(30);
    });

    it('does not flag redAlert with low IL', () => {
        const state = makeState({ cumulativeIL: -10, unclaimedFees: 10 });
        const result = RiskManager.analyzePosition(state, makeBB(), 10, 0.1, 0.1);
        expect(result.redAlert).toBe(false);
    });

    it('flags highVolatilityAvoid when bandwidth > 2x avg', () => {
        const result = RiskManager.analyzePosition(makeState(), makeBB(), 10, 0.05, 0.15);
        expect(result.highVolatilityAvoid).toBe(true);
    });

    it('signals compound when unclaimed exceeds EOQ threshold', () => {
        // threshold = sqrt(2 * 1000 * 1.5) = sqrt(3000) ≈ 54.77
        const state = makeState({ capital: 1000, unclaimedFees: 100 });
        const result = RiskManager.analyzePosition(state, makeBB(), 10, 0.1, 0.1, 1.5);
        expect(result.compoundSignal).toBe(true);
        expect(result.compoundThreshold).toBeCloseTo(Math.sqrt(2 * 1000 * 1.5), 4);
    });

    it('healthScore is 50 at breakeven', () => {
        const state = makeState({ unclaimedFees: 0, cumulativeIL: 0 });
        const result = RiskManager.analyzePosition(state, makeBB(), 10, 0.1, 0.1);
        expect(result.healthScore).toBe(50);
    });

    it('healthScore is clamped to [0, 100]', () => {
        const high = makeState({ unclaimedFees: 10000, cumulativeIL: 10000, capital: 100 });
        const low  = makeState({ unclaimedFees: 0, cumulativeIL: -10000, capital: 100 });
        expect(RiskManager.analyzePosition(high, makeBB(), 10, 0.1, 0.1).healthScore).toBe(100);
        expect(RiskManager.analyzePosition(low,  makeBB(), 10, 0.1, 0.1).healthScore).toBe(0);
    });

    it('driftWarning fires when overlap < 80%', () => {
        const bb = makeBB({ tickLower: 200, tickUpper: 400 });
        const result = RiskManager.analyzePosition(makeState({ tickLower: 0, tickUpper: 100 }), bb, 10, 0.1, 0.1);
        expect(result.driftWarning).toBe(true);
        expect(result.driftOverlapPct).toBe(0);
    });
});
