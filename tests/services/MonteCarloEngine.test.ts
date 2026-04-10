import { runMCSimulation } from '../../src/services/strategy/MonteCarloEngine';
import seedrandom from 'seedrandom';

describe('MonteCarloEngine — Sharpe scoring', () => {
    it('should import seedrandom and runMCSimulation without errors', () => {
        expect(typeof seedrandom).toBe('function');
        expect(typeof runMCSimulation).toBe('function');
    });

    // Tests will be added in Task 2-6
});
