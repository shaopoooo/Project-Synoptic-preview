import { RebalanceService } from '../src/services/rebalance';
import { BBResult } from '../src/services/BBEngine';
import { config } from '../src/config';

// Mock config for EOQ_THRESHOLD
jest.mock('../src/config', () => ({
    config: {
        EOQ_THRESHOLD: 5,
        INITIAL_INVESTMENT_USD: {
            'mock': 10000
        }
    }
}));

describe('RebalanceService', () => {

    const mockBB: BBResult = {
        sma: 1500,
        upperPrice: 2000,
        lowerPrice: 1000,
        k: 2.0,
        volatility30D: 0.5,
        tickLower: 1000,
        tickUpper: 2000,
        ethPrice: 2000,
        minPriceRatio: 1, // e.g. 1
        maxPriceRatio: 2, // e.g. 2
        regime: 'Unknown'
    };

    it('should return null if drift < 5%', () => {
        // Current price 1.5. Bounds 1-2. Inside. Drift = 0.
        const suggestion = RebalanceService.getRebalanceSuggestion(
            1.5, mockBB, 50, 10, 10000, 'WETH', 'USDC'
        );
        expect(suggestion).toBeNull();
    });

    it('should recommend WAIT if drift < 10% and breakeven < 15 days', () => {
        // max 2. currentPrice 2.1 => driftPercent = 5%. (5 >= 5 to bypass null, <10 to be wait)
        const suggestion = RebalanceService.getRebalanceSuggestion(
            2.1, mockBB, 50, 10, 10000, 'WETH', 'USDC'
        );
        expect(suggestion?.recommendedStrategy).toBe('wait');
        expect(suggestion?.strategyName).toBe('等待回歸');
    });

    it('should recommend DCA if drift < 20% but breakeven > 15 and unclaimed > threshold', () => {
        // To get driftPercent.
        // bbBounds = 1 to 2
        // max 2. currentPrice 2.3 => drift = 15%. (15 >= 10, < 20).
        const result = RebalanceService.getRebalanceSuggestion(
            2.3, mockBB,
            10, // Unclaimed Fees > 5 threshold
            20, // Breakeven Days > 15
            5000, // USD Value
            'Token0', 'Token1'
        );

        expect(result?.recommendedStrategy).toBe('dca');
        expect(result?.strategyName).toBe('DCA 定投平衡');
    });

    it('should recommend WithdrawSingleSide if drift > 20% or fees too low', () => {
        // bbBounds: 1 to 2
        // Current price: 3.0 (>30% out)
        const result = RebalanceService.getRebalanceSuggestion(
            3.0, mockBB,
            2, // Unclaimed fees < threshold
            50, // Breakeven Days > 15
            5000,
            'Token0', 'Token1'
        );

        expect(result?.recommendedStrategy).toBe('withdrawSingleSide');
        expect(result?.strategyName).toBe('撤資單邊建倉');
    });

    describe('DCA V3 Math logic', () => {
        it('calculates the right token value ratio target for DCA action tokens', () => {
            // currentPrice: 100
            // new min: 80
            // new max: 120
            // sqrtPrice returns some ratio.
            // In DCA, if value is 5000, we test that actionToken gets populated in notes
            // currentPrice 135 vs max 120 = 12.5% drift. >10% and <20%, hits DCA!
            const result = RebalanceService.getRebalanceSuggestion(
                135, { ...mockBB, minPriceRatio: 80, maxPriceRatio: 120, sma: 100 },
                10, 20, 5000, 'WETH', 'USDC'
            );
            expect(result?.recommendedStrategy).toBe('dca');
            expect(result?.notes).toContain('WETH'); // Just a sanity check for action token string replacing Token0/Token1
        });
    });

});
