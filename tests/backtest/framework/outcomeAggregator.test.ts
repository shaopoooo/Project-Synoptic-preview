import { aggregateOutcomes } from '../../../src/backtest/framework/outcomeAggregator';
import type { PositionOutcome, HypotheticalPosition } from '../../../src/types/replay';

function makePosition(poolId: string, openedAtCycle: number): HypotheticalPosition {
    return {
        positionId: `${poolId}:${openedAtCycle}`,
        poolId,
        openedAtCycle,
        openedAtTs: openedAtCycle * 3600,
        openPriceNorm: 1,
        PaNorm: 0.95,
        PbNorm: 1.05,
        initialCapital: 1000,
        feesAccumulated: 0,
        outOfRangeSinceMs: null,
        closedAtCycle: openedAtCycle + 24,
        closedAtTs: (openedAtCycle + 24) * 3600,
        closeReason: 'timeout',
    };
}

function makeOutcome(overrides: {
    outperformancePct?: number;
    hitRate?: number;
    lpNetProfit?: number;
}): PositionOutcome {
    return {
        position: makePosition('pool-a', 0),
        durationHours: 24,
        expectedReturnPct: 0,
        lpFinalValue: 0,
        hodlFinalValue: 0,
        outperformancePct: overrides.outperformancePct ?? 0,
        hitRate: overrides.hitRate ?? 0,
        feeIncome: 0,
        impermanentLoss: 0,
        gasCost: 0,
        lpNetProfit: overrides.lpNetProfit ?? 0,
    };
}

describe('aggregateOutcomes', () => {
    it('A 指標 = outperformancePct 的算術平均', () => {
        const outcomes = [
            makeOutcome({ outperformancePct: 0.05 }),
            makeOutcome({ outperformancePct: 0.10 }),
            makeOutcome({ outperformancePct: -0.02 }),
        ];
        const result = aggregateOutcomes(outcomes);
        expect(result.A).toBeCloseTo((0.05 + 0.10 - 0.02) / 3, 10);
    });

    it('C 指標 = hitRate 的算術平均', () => {
        const outcomes = [
            makeOutcome({ hitRate: 0.4 }),
            makeOutcome({ hitRate: 0.6 }),
            makeOutcome({ hitRate: 0.8 }),
        ];
        const result = aggregateOutcomes(outcomes);
        expect(result.C).toBeCloseTo((0.4 + 0.6 + 0.8) / 3, 10);
    });

    it('D 指標 = lpNetProfit 的總和（非平均）', () => {
        const outcomes = [
            makeOutcome({ lpNetProfit: 10 }),
            makeOutcome({ lpNetProfit: 25 }),
            makeOutcome({ lpNetProfit: -5 }),
        ];
        const result = aggregateOutcomes(outcomes);
        expect(result.D).toBeCloseTo(30, 10);
    });

    it('絕對底線：A>0 && D>0 && C>=0.5 才算 pass', () => {
        const passing = aggregateOutcomes([
            makeOutcome({ outperformancePct: 0.01, hitRate: 0.51, lpNetProfit: 1 }),
        ]);
        expect(passing.passesAbsoluteFloor).toBe(true);

        const failing = aggregateOutcomes([
            makeOutcome({ outperformancePct: -0.01, hitRate: 0.51, lpNetProfit: 1 }),
        ]);
        expect(failing.passesAbsoluteFloor).toBe(false);
    });

    it('weighted score = 0.4*A + 0.3*C + 0.3*D（unnormalized，normalization 交給 gridSearcher）', () => {
        // 單筆 outcome，讓 A=0.1、C=0.6、D=2.0
        const result = aggregateOutcomes([
            makeOutcome({ outperformancePct: 0.1, hitRate: 0.6, lpNetProfit: 2.0 }),
        ]);
        expect(result.A).toBeCloseTo(0.1, 10);
        expect(result.C).toBeCloseTo(0.6, 10);
        expect(result.D).toBeCloseTo(2.0, 10);
        expect(result.weighted).toBeCloseTo(0.4 * 0.1 + 0.3 * 0.6 + 0.3 * 2.0, 10);
    });
});
