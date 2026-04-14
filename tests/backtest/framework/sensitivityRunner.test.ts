/**
 * sensitivityRunner 單元測試 — 3 cases
 *
 * 使用 mock driver + 可控的 tvlMultiplier 行為，確保測試快速確定。
 */

import { runSensitivity } from '../../../src/backtest/framework/sensitivityRunner';
import type { IReplayDriver } from '../../../src/backtest/framework/gridSearcher';
import type {
    ReplayFeature,
    ThresholdSet,
    GridSpace,
    PositionOutcome,
    HypotheticalPosition,
} from '../../../src/types/replay';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePosition(poolId: string, cycle: number): HypotheticalPosition {
    return {
        positionId: `${poolId}:${cycle}`,
        poolId,
        openedAtCycle: cycle,
        openedAtTs: cycle * 3600,
        openPriceNorm: 1.0,
        PaNorm: 0.95,
        PbNorm: 1.05,
        initialCapital: 1000,
        feesAccumulated: 0,
        outOfRangeSinceMs: null,
        closedAtCycle: cycle + 24,
        closedAtTs: (cycle + 24) * 3600,
        closeReason: 'timeout',
    };
}

function makeOutcome(overrides: Partial<PositionOutcome> = {}): PositionOutcome {
    return {
        position: makePosition('pool-a', 0),
        durationHours: 24,
        expectedReturnPct: 0,
        lpFinalValue: 1000,
        hodlFinalValue: 1000,
        outperformancePct: 0.05,
        hitRate: 0.6,
        feeIncome: 50,
        impermanentLoss: 10,
        gasCost: 0,
        lpNetProfit: 40,
        ...overrides,
    };
}

function makeFeature(cycleIdx: number): ReplayFeature {
    return {
        poolId: 'pool-a',
        poolLabel: 'ETH/USDC',
        ts: cycleIdx * 3600,
        cycleIdx,
        mcScore: 0.8,
        mcMean: 0.05,
        mcStd: 0.02,
        mcCvar95: -0.03,
        regime: { range: 0.5, trend: 0.3, neutral: 0.2 },
        PaNorm: 0.95,
        PbNorm: 1.05,
        atrHalfWidth: 0.05,
        currentPriceNorm: 1.0,
        candleVolume: 100000,
        poolTvlProxy: 1000000,
        poolFeeTier: 0.003,
    };
}

const SMALL_SPACE: GridSpace = {
    sharpeOpen: [0.3, 0.5, 0.8],
    sharpeClose: [0.2, 0.3],
    atrMultiplier: [2.0],
};

const DUMMY_FEATURES: ReplayFeature[] = [makeFeature(0), makeFeature(1)];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('sensitivityRunner', () => {
    it('test_runSensitivity_threeTvlMultipliers', () => {
        /**
         * Mock driver：所有 threshold 都回傳正面結果（通過 floor）。
         * tvlMultiplier 不影響排序（一致性測試在下面）。
         */
        const driver: IReplayDriver = {
            tvlMultiplier: 1.0,
            setTvlMultiplier(m: number) { this.tvlMultiplier = m; },
            run(threshold: ThresholdSet, _mode: 'raw' | 'full-state'): PositionOutcome[] {
                return [
                    makeOutcome({
                        outperformancePct: threshold.sharpeOpen * 0.5,
                        hitRate: 0.7,
                        lpNetProfit: threshold.sharpeOpen * 100,
                    }),
                ];
            },
        };

        const { results } = runSensitivity(DUMMY_FEATURES, driver, SMALL_SPACE);

        // 三個 TVL multiplier → 三個 SensitivityResult
        expect(results.length).toBe(3);
        expect(results[0].tvlMultiplier).toBe(0.5);
        expect(results[1].tvlMultiplier).toBe(1.0);
        expect(results[2].tvlMultiplier).toBe(2.0);

        // 每個結果都有 topThresholds
        for (const r of results) {
            expect(Array.isArray(r.topThresholds)).toBe(true);
        }
    });

    it('test_sensitivity_robust_sameTop3', () => {
        /**
         * Mock driver：無論 tvlMultiplier 為何，都產出相同排序。
         * sharpeOpen 越高 → weightedRaw 越高，所以 top-3 一致。
         */
        const driver: IReplayDriver = {
            tvlMultiplier: 1.0,
            setTvlMultiplier(m: number) { this.tvlMultiplier = m; },
            run(threshold: ThresholdSet, _mode: 'raw' | 'full-state'): PositionOutcome[] {
                return [
                    makeOutcome({
                        outperformancePct: threshold.sharpeOpen * 0.5,
                        hitRate: 0.7,
                        lpNetProfit: threshold.sharpeOpen * 100,
                    }),
                ];
            },
        };

        const { isRobust } = runSensitivity(DUMMY_FEATURES, driver, SMALL_SPACE);
        expect(isRobust).toBe(true);
    });

    it('test_sensitivity_notRobust_differentThresholds', () => {
        /**
         * Mock driver：依照 tvlMultiplier 值改變排序。
         * tvlMultiplier 低時偏好高 sharpeOpen，高時偏好低 sharpeOpen。
         */
        let callCount = 0;
        const multipliers = [0.5, 1.0, 2.0];
        let currentMultiplier = 1.0;

        const driver: IReplayDriver = {
            tvlMultiplier: 1.0,
            setTvlMultiplier(m: number) {
                this.tvlMultiplier = m;
                currentMultiplier = m;
            },
            run(threshold: ThresholdSet, _mode: 'raw' | 'full-state'): PositionOutcome[] {
                callCount++;
                // tvlMultiplier = 0.5 → 高 sharpeOpen 好
                // tvlMultiplier = 2.0 → 低 sharpeOpen 好（反轉排序）
                const factor = currentMultiplier <= 0.5
                    ? threshold.sharpeOpen
                    : currentMultiplier >= 2.0
                        ? (1.0 - threshold.sharpeOpen)
                        : threshold.sharpeOpen * 0.5;

                return [
                    makeOutcome({
                        outperformancePct: factor * 0.5,
                        hitRate: 0.7,
                        lpNetProfit: factor * 100,
                    }),
                ];
            },
        };

        const { isRobust } = runSensitivity(DUMMY_FEATURES, driver, SMALL_SPACE);
        expect(isRobust).toBe(false);
    });
});
