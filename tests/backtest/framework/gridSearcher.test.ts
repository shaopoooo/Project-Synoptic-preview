/**
 * gridSearcher 單元測試 — 6 cases
 *
 * 使用 mock driver 避免真實 MC 模擬，確保測試快速（< 1 秒）且確定性。
 */

import {
    runCoarseGrid,
    selectTopCandidates,
    runFineGrid,
} from '../../../src/backtest/framework/gridSearcher';
import type { SweepResult } from '../../../src/backtest/framework/gridSearcher';
import type {
    ReplayFeature,
    ThresholdSet,
    GridSpace,
    PositionOutcome,
    HypotheticalPosition,
} from '../../../src/types/replay';
import type { IReplayDriver } from '../../../src/backtest/framework/gridSearcher';

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

/** 產生最小可用 ReplayFeature（只需 poolId / ts / cycleIdx） */
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

/**
 * Mock driver：根據 threshold 值回傳可預測的 outcomes。
 * sharpeOpen 越高 → outperformancePct 越高（方便驗證排序）。
 */
class MockReplayDriver implements IReplayDriver {
    tvlMultiplier = 1.0;

    setTvlMultiplier(m: number): void {
        this.tvlMultiplier = m;
    }

    run(threshold: ThresholdSet, _mode: 'raw' | 'full-state'): PositionOutcome[] {
        return [
            makeOutcome({
                outperformancePct: threshold.sharpeOpen * 0.5,
                hitRate: 0.7,
                lpNetProfit: threshold.sharpeOpen * 100,
            }),
        ];
    }
}

const DEFAULT_SPACE: GridSpace = {
    sharpeOpen: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    sharpeClose: [0.2, 0.3, 0.4],
    atrMultiplier: [1.5, 2.0, 2.5, 3.0],
};

const DUMMY_FEATURES: ReplayFeature[] = [makeFeature(0), makeFeature(1)];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('gridSearcher', () => {
    const driver = new MockReplayDriver();

    describe('runCoarseGrid', () => {
        it('test_runCoarseGrid_72Combinations', () => {
            const results = runCoarseGrid(DUMMY_FEATURES, driver, DEFAULT_SPACE);

            // 6 × 3 × 4 = 72 組合
            expect(results.length).toBe(72);

            // 每個 result 都有 threshold 與 metrics
            for (const r of results) {
                expect(r.threshold).toBeDefined();
                expect(r.threshold.sharpeOpen).toBeDefined();
                expect(r.threshold.sharpeClose).toBeDefined();
                expect(r.threshold.atrMultiplier).toBeDefined();
                expect(r.metrics).toBeDefined();
                expect(typeof r.metrics.A).toBe('number');
                expect(typeof r.metrics.C).toBe('number');
                expect(typeof r.metrics.D).toBe('number');
                expect(typeof r.metrics.weightedRaw).toBe('number');
                expect(typeof r.metrics.passesAbsoluteFloor).toBe('boolean');
            }
        });
    });

    describe('selectTopCandidates', () => {
        it('test_selectTopCandidates_top5ByWeightedScore', () => {
            const results = runCoarseGrid(DUMMY_FEATURES, driver, DEFAULT_SPACE);
            const top5 = selectTopCandidates(results, 5);

            expect(top5.length).toBe(5);

            // MockDriver 中 sharpeOpen 越高 → weightedRaw 越高
            // 所以 top-5 應該都是 sharpeOpen = 0.8（最高），然後按其他軸排序
            // 驗證 top-5 中的 sharpeOpen 全為最高值
            for (const t of top5) {
                expect(t.sharpeOpen).toBe(0.8);
            }
        });

        it('test_absoluteFloorFiltering', () => {
            // 建構一組 results：部分通過 floor、部分不通過
            const passing: SweepResult[] = [
                {
                    threshold: { sharpeOpen: 0.5, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: 0.1, C: 0.6, D: 100, weightedRaw: 30.22, passesAbsoluteFloor: true },
                },
                {
                    threshold: { sharpeOpen: 0.6, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: 0.2, C: 0.7, D: 50, weightedRaw: 15.29, passesAbsoluteFloor: true },
                },
            ];
            const failing: SweepResult[] = [
                {
                    // A <= 0 → fails floor
                    threshold: { sharpeOpen: 0.9, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: -0.01, C: 0.8, D: 200, weightedRaw: 60.236, passesAbsoluteFloor: false },
                },
                {
                    // D <= 0 → fails floor
                    threshold: { sharpeOpen: 0.8, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: 0.3, C: 0.7, D: -10, weightedRaw: -2.79, passesAbsoluteFloor: false },
                },
                {
                    // C < 0.5 → fails floor
                    threshold: { sharpeOpen: 0.7, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: 0.1, C: 0.4, D: 50, weightedRaw: 15.16, passesAbsoluteFloor: false },
                },
            ];

            const all = [...passing, ...failing];
            const top5 = selectTopCandidates(all, 5);

            // 只有 2 個通過 floor
            expect(top5.length).toBe(2);
            // 排序應該按 weightedRaw 降序：第一個 30.22 > 第二個 15.29
            expect(top5[0].sharpeOpen).toBe(0.5);
            expect(top5[1].sharpeOpen).toBe(0.6);
        });

        it('test_noFeasibleThreshold_emptyResult', () => {
            // 所有結果都不通過 absolute floor
            const results: SweepResult[] = Array.from({ length: 72 }, (_, i) => ({
                threshold: { sharpeOpen: 0.3 + (i % 6) * 0.1, sharpeClose: 0.2, atrMultiplier: 1.5 },
                metrics: { A: -0.01, C: 0.3, D: -10, weightedRaw: -3.094, passesAbsoluteFloor: false },
            }));

            const top = selectTopCandidates(results, 5);
            expect(top).toEqual([]);
        });

        it('test_weightedScore_normalization', () => {
            // 驗證 weightedRaw 正確用於排序
            // Result A: A=0.1, C=0.6, D=100 → weightedRaw = 0.4*0.1 + 0.3*0.6 + 0.3*100 = 0.04 + 0.18 + 30 = 30.22
            // Result B: A=0.2, C=0.8, D=10  → weightedRaw = 0.4*0.2 + 0.3*0.8 + 0.3*10  = 0.08 + 0.24 + 3  = 3.32
            const results: SweepResult[] = [
                {
                    threshold: { sharpeOpen: 0.5, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: 0.1, C: 0.6, D: 100, weightedRaw: 30.22, passesAbsoluteFloor: true },
                },
                {
                    threshold: { sharpeOpen: 0.6, sharpeClose: 0.3, atrMultiplier: 2.0 },
                    metrics: { A: 0.2, C: 0.8, D: 10, weightedRaw: 3.32, passesAbsoluteFloor: true },
                },
            ];

            const top = selectTopCandidates(results, 5);
            expect(top.length).toBe(2);
            // 30.22 > 3.32 → 第一個排在前面
            expect(top[0].sharpeOpen).toBe(0.5);
            expect(top[1].sharpeOpen).toBe(0.6);
        });
    });

    describe('runFineGrid', () => {
        it('test_runFineGrid_neighborhoodExpansion', () => {
            const topCandidates: ThresholdSet[] = [
                { sharpeOpen: 0.5, sharpeClose: 0.3, atrMultiplier: 2.0 },
                { sharpeOpen: 0.6, sharpeClose: 0.3, atrMultiplier: 2.5 },
                { sharpeOpen: 0.7, sharpeClose: 0.4, atrMultiplier: 3.0 },
                { sharpeOpen: 0.4, sharpeClose: 0.2, atrMultiplier: 1.5 },
                { sharpeOpen: 0.8, sharpeClose: 0.3, atrMultiplier: 2.0 },
            ];

            const results = runFineGrid(DUMMY_FEATURES, driver, topCandidates);

            // 每個 candidate → 3^3 = 27 鄰域（含自身），5 個 → 135 上限
            // 但有去重，所以 results.length <= 135 且 >= 5
            expect(results.length).toBeGreaterThanOrEqual(5);
            expect(results.length).toBeLessThanOrEqual(135);

            // 每個結果都有 threshold + metrics
            for (const r of results) {
                expect(r.threshold).toBeDefined();
                expect(r.metrics).toBeDefined();
            }

            // 驗證去重：不應有相同 threshold 的重複 entry
            const keys = results.map(
                r => `${r.threshold.sharpeOpen}|${r.threshold.sharpeClose}|${r.threshold.atrMultiplier}`,
            );
            const unique = new Set(keys);
            expect(unique.size).toBe(results.length);
        });
    });
});
