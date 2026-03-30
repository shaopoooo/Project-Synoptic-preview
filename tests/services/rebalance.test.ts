import { RebalanceService } from '../../src/services/strategy/rebalance';
import { MarketSnapshot } from '../../src/types';

const makeBB = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
    sma: 0.030,
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

describe('RebalanceService.getRebalanceSuggestion', () => {
    it('returns null when price within BB bounds (no drift)', () => {
        const result = RebalanceService.getRebalanceSuggestion(
            0.030, makeBB(), 100, 5, 10000, 'cbBTC', 'WETH', 1.5,
            0.027, 0.033
        );
        expect(result).toBeNull();
    });

    it('returns null when bbLower or bbUpper is 0', () => {
        const result = RebalanceService.getRebalanceSuggestion(
            0.040, makeBB(), 100, 5, 10000, 'cbBTC', 'WETH', 1.5,
            0, 0.033
        );
        expect(result).toBeNull();
    });

    it('driftPercent is positive for upward drift', () => {
        const bbUpper = 0.033;
        const currentPrice = bbUpper * 1.20; // 20% above
        const result = RebalanceService.getRebalanceSuggestion(
            currentPrice, makeBB(), 500, 5, 10000, 'cbBTC', 'WETH', 1.5,
            0.027, bbUpper
        );
        expect(result).not.toBeNull();
        expect(result!.driftPercent).toBeGreaterThan(0);
    });

    it('driftPercent is negative for downward drift', () => {
        const bbLower = 0.027;
        const currentPrice = bbLower * 0.80; // 20% below
        const result = RebalanceService.getRebalanceSuggestion(
            currentPrice, makeBB(), 500, 5, 10000, 'cbBTC', 'WETH', 1.5,
            bbLower, 0.033
        );
        expect(result).not.toBeNull();
        expect(result!.driftPercent).toBeLessThan(0);
    });

    it('downgrades to wait when gas exceeds unclaimed / 2', () => {
        // Large drift but tiny unclaimed → not worth rebalancing
        const bbUpper = 0.033;
        const currentPrice = bbUpper * 1.30;
        const result = RebalanceService.getRebalanceSuggestion(
            currentPrice, makeBB(), 3, 100, 10000, 'cbBTC', 'WETH', 5,
            0.027, bbUpper
        );
        expect(result).not.toBeNull();
        expect(result!.recommendedStrategy).toBe('wait');
    });

    it('returns a valid strategy for large upward drift with sufficient fees', () => {
        const bbUpper = 0.033;
        const currentPrice = bbUpper * 1.25;
        const result = RebalanceService.getRebalanceSuggestion(
            currentPrice, makeBB(), 500, 100, 10000, 'cbBTC', 'WETH', 1.5,
            0.027, bbUpper
        );
        expect(result).not.toBeNull();
        expect(['wait', 'dca', 'withdrawSingleSide']).toContain(result!.recommendedStrategy);
    });
});
