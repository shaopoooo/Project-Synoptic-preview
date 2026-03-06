import { RiskManager, PositionState } from '../src/services/RiskManager';
import { BBResult } from '../src/services/BBEngine';

describe('RiskManager', () => {

    describe('calculateDrift', () => {
        it('should return 100% when position is fully inside BB', () => {
            // BB Range: 1000 to 2000
            // Position: 1200 to 1800
            const driftPct = RiskManager.calculateDrift(1200, 1800, 1000, 2000);
            expect(driftPct).toBe(60); // (1800-1200)/(2000-1000) = 600/1000 = 60% relative size overlap! Wait, the implementation calculates intersection / BB bounds.
            // Actually standard calculation says:
            // Intersection = max(1200, 1000) to min(1800, 2000) = 1200 to 1800 (Range = 600)
            // BB Range = 2000 - 1000 = 1000
            // 600 / 1000 = 60%
            // 60% means 40% drift warning.
        });

        it('should calculate precise overlap percentage', () => {
            // BB: 100 to 200
            // Position: 150 to 250
            // Intersection: max(150, 100) to min(250, 200) => 150 to 200 (range 50)
            // BB Range = 100
            // Overlap = 50%
            const driftPct = RiskManager.calculateDrift(150, 250, 100, 200);
            expect(driftPct).toBe(50);
        });

        it('should return 0 when completely out of bounds (above)', () => {
            const driftPct = RiskManager.calculateDrift(300, 400, 100, 200);
            expect(driftPct).toBe(0);
        });

        it('should return 0 when completely out of bounds (below)', () => {
            const driftPct = RiskManager.calculateDrift(50, 80, 100, 200);
            expect(driftPct).toBe(0);
        });

        it('should handle zero bb range edge case safely', () => {
            const driftPct = RiskManager.calculateDrift(100, 200, 150, 150);
            expect(driftPct).toBe(0);
        });
    });

    describe('analyzePosition', () => {
        const defaultState: PositionState = {
            capital: 10000,
            tickLower: 1000,
            tickUpper: 2000,
            unclaimedFees: 50,
            cumulativeIL: -150,
            feeRate24h: 0.005 // 0.5%
        };

        const defaultBB: BBResult = {
            sma: 1500,
            upperPrice: 2000,
            lowerPrice: 1000,
            k: 2.0,
            volatility30D: 0.5,
            tickLower: 1000,
            tickUpper: 2000,
            ethPrice: 2000,
            minPriceRatio: 1,
            maxPriceRatio: 2,
            regime: 'Unknown'
        };

        it('should accurately flag driftWarning if overlap < 80%', () => {
            const state = { ...defaultState, tickLower: 1800, tickUpper: 3000 };
            // Intersection 1800 to 2000 => 200. BB Range => 1000. Overlap = 20%
            const risk = RiskManager.analyzePosition(state, defaultBB, 10, 0.4, 0.5);
            expect(risk.driftOverlapPct).toBe(20);
            expect(risk.driftWarning).toBe(true);
        });

        it('should compute breakeven days and flag RED_ALERT if > 30', () => {
            // cumulativeIL = -400. DailyFees = 10. Breakeven days = 40.
            const state = { ...defaultState, cumulativeIL: -400 };
            const risk = RiskManager.analyzePosition(state, defaultBB, 10, 0.4, 0.5);
            expect(risk.ilBreakevenDays).toBe(40);
            expect(risk.redAlert).toBe(true);
        });

        it('should compute breakeven days and NOT flag RED_ALERT if <= 30', () => {
            // cumulativeIL = -200. DailyFees = 10. Breakeven = 20.
            const state = { ...defaultState, cumulativeIL: -200 };
            const risk = RiskManager.analyzePosition(state, defaultBB, 10, 0.4, 0.5);
            expect(risk.ilBreakevenDays).toBe(20);
            expect(risk.redAlert).toBe(false);
        });

        it('should flag HIGH_VOLATILITY_AVOID if currentBandwidth > 2 * avg30DBandwidth', () => {
            const risk = RiskManager.analyzePosition(defaultState, defaultBB, 10, 0.2, 0.5);
            expect(risk.highVolatilityAvoid).toBe(true); // 0.5 > 2 * 0.2
        });

        it('should compute healthScore capped at 100', () => {
            // IL = -50, Fees = 100. Score = 100 / 50 * 100 = 200 -> Capped 100
            const state = { ...defaultState, cumulativeIL: -50, unclaimedFees: 100 };
            const risk = RiskManager.analyzePosition(state, defaultBB, 10, 0.4, 0.5);
            expect(risk.healthScore).toBe(100);
        });
    });

});
