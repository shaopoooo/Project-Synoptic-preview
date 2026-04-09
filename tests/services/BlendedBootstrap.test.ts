import { runMCSimulation } from '../../src/services/strategy/MonteCarloEngine';
import type { RegimeVector } from '../../src/types';
import type { RegimeSegment } from '../../src/services/strategy/MarketRegimeAnalyzer';

describe('Blended Bootstrap', () => {
    const baseParams = {
        historicalReturns: Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.02),
        P0: 1.0,
        Pa: 0.95,
        Pb: 1.05,
        capital: 1.0,
        dailyFeesToken0: 0.001,
        horizon: 7,
        numPaths: 1000,
    };

    it('should produce valid result without segments (backward compatible)', () => {
        const result = runMCSimulation(baseParams);
        expect(result.numPaths).toBe(1000);
        expect(Number.isFinite(result.mean)).toBe(true);
        expect(Number.isFinite(result.cvar95)).toBe(true);
        expect(result.inRangeDays).toBeGreaterThan(0);
    });

    it('should produce valid result with segments + regimeVector', () => {
        const segments: RegimeSegment[] = [
            { regime: 'range', returns: Array.from({ length: 100 }, () => (Math.random() - 0.5) * 0.01) },
            { regime: 'trend', returns: Array.from({ length: 100 }, () => (Math.random() - 0.5) * 0.03) },
            { regime: 'neutral', returns: Array.from({ length: 100 }, () => (Math.random() - 0.5) * 0.015) },
        ];
        const regimeVector: RegimeVector = { range: 0.5, trend: 0.3, neutral: 0.2 };

        const result = runMCSimulation({ ...baseParams, segments, regimeVector });
        expect(result.numPaths).toBe(1000);
        expect(Number.isFinite(result.mean)).toBe(true);
        expect(Number.isFinite(result.cvar95)).toBe(true);
    });

    it('should produce worse CVaR when trend-heavy vector is used', () => {
        // Range returns: low volatility
        const rangeReturns = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.005);
        // Trend returns: high volatility
        const trendReturns = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.04);

        const segments: RegimeSegment[] = [
            { regime: 'range', returns: rangeReturns },
            { regime: 'trend', returns: trendReturns },
            { regime: 'neutral', returns: rangeReturns },
        ];

        const rangeHeavy: RegimeVector = { range: 0.8, trend: 0.1, neutral: 0.1 };
        const trendHeavy: RegimeVector = { range: 0.1, trend: 0.8, neutral: 0.1 };

        // Run multiple times and average to reduce randomness
        let rangeCvar = 0, trendCvar = 0;
        const N = 5;
        for (let i = 0; i < N; i++) {
            rangeCvar += runMCSimulation({ ...baseParams, numPaths: 5000, segments, regimeVector: rangeHeavy }).cvar95;
            trendCvar += runMCSimulation({ ...baseParams, numPaths: 5000, segments, regimeVector: trendHeavy }).cvar95;
        }
        rangeCvar /= N;
        trendCvar /= N;

        // Trend-heavy should have worse (more negative) CVaR
        expect(trendCvar).toBeLessThan(rangeCvar);
    });
});
