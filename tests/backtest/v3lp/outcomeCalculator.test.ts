/**
 * outcomeCalculator — A/C/D 三指標結算 TDD 測試
 *
 * 對應 plan `.claude/plans/p0-backtest-verification.md` lines 749-755
 */
import { computeOutcome } from '../../../src/backtest/v3lp/outcomeCalculator';
import type { HypotheticalPosition, ReplayFeature } from '../../../src/types/replay';

// ─── Fixture Helpers ────────────────────────────────────────────────────────

function makeHypotheticalPosition(
    overrides: Partial<HypotheticalPosition> = {},
): HypotheticalPosition {
    return {
        positionId: 'pool1:1000',
        poolId: 'pool1',
        openedAtCycle: 0,
        openedAtTs: 1000,
        openPriceNorm: 1.0,
        PaNorm: 0.9,
        PbNorm: 1.1,
        initialCapital: 10_000,
        feesAccumulated: 0,
        outOfRangeSinceMs: null,
        closedAtCycle: 9,
        closedAtTs: 1009,
        closeReason: 'timeout',
        ...overrides,
    };
}

function makeFeature(overrides: Partial<ReplayFeature> = {}): ReplayFeature {
    return {
        poolId: 'pool1',
        poolLabel: 'WETH-USDC',
        ts: 1000,
        cycleIdx: 0,
        mcScore: null,
        mcMean: null,
        mcStd: null,
        mcCvar95: null,
        regime: null,
        PaNorm: 0.9,
        PbNorm: 1.1,
        atrHalfWidth: 0.05,
        currentPriceNorm: 1.0,
        candleVolume: 500_000,
        poolTvlProxy: 1_000_000,
        poolFeeTier: 0.003,
        ...overrides,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('outcomeCalculator — computeOutcome', () => {
    // 基本 fixture：10 cycle（hours），全部 in-range，價格不變
    const basePosition = makeHypotheticalPosition({
        openedAtCycle: 0,
        closedAtCycle: 9,
        openPriceNorm: 1.0,
        PaNorm: 0.9,
        PbNorm: 1.1,
        initialCapital: 10_000,
    });

    const baseFeaturesInRange: ReplayFeature[] = Array.from({ length: 10 }, (_, i) =>
        makeFeature({
            cycleIdx: i,
            ts: 1000 + i,
            currentPriceNorm: 1.0,
            candleVolume: 500_000,
            poolTvlProxy: 1_000_000,
            poolFeeTier: 0.003,
        }),
    );

    test('A 指標 = (LP final value - HODL final value) / HODL final value', () => {
        // 價格不變 → LP value ≈ capital, HODL = capital
        // A ≈ feeIncome / hodlFinalValue（因為 IL ≈ 0 when price unchanged）
        const result = computeOutcome(basePosition, baseFeaturesInRange, 1.0);

        // HODL: capital * (openPrice + closePrice) / (2 * openPrice)
        // = 10000 * (1.0 + 1.0) / (2 * 1.0) = 10000
        expect(result.hodlFinalValue).toBeCloseTo(10_000, 2);

        // LP final = lpValueAtClose + feeIncome
        // A = (lpFinal - hodl) / hodl
        expect(result.outperformancePct).toBeCloseTo(
            (result.lpFinalValue - result.hodlFinalValue) / result.hodlFinalValue,
            10,
        );
    });

    test('C 指標 = sum(in-range hours) / lifetime hours', () => {
        // 5 out of 10 features in range
        const mixedFeatures = Array.from({ length: 10 }, (_, i) =>
            makeFeature({
                cycleIdx: i,
                ts: 1000 + i,
                currentPriceNorm: i < 5 ? 1.0 : 1.2, // first 5 in range, last 5 out (>1.1)
            }),
        );

        const result = computeOutcome(basePosition, mixedFeatures, 1.0);
        // 5 in-range / 10 total with valid price = 0.5
        expect(result.hitRate).toBeCloseTo(0.5, 10);
    });

    test('D 指標 = fee_income - IL - gas_cost', () => {
        const result = computeOutcome(basePosition, baseFeaturesInRange, 1.0);

        // gasCost comes from position (always 0 in our fixture — no gas field,
        // so the function should use a reasonable default or 0)
        expect(result.lpNetProfit).toBeCloseTo(
            result.feeIncome - result.impermanentLoss - result.gasCost,
            10,
        );
    });

    test('fee_income = Σ(hourly_fee × in_range_multiplier), hourlyFee = volume × feeTier × (capital / (poolTvl × tvlMultiplier))', () => {
        const tvlMultiplier = 2.0;
        const result = computeOutcome(basePosition, baseFeaturesInRange, tvlMultiplier);

        // All 10 features in range
        // hourlyFee = 500_000 * 0.003 * (10_000 / (1_000_000 * 2.0))
        //           = 1500 * 0.005 = 7.5 per hour
        // feeIncome = 7.5 * 10 = 75
        expect(result.feeIncome).toBeCloseTo(75, 6);
    });

    test('IL 用 V3 constant product 公式（reuse computeL + computeLpValueToken0）', () => {
        // Price moves from 1.0 to 1.05 → some IL
        const positionPriceMoved = makeHypotheticalPosition({
            openPriceNorm: 1.0,
            PaNorm: 0.9,
            PbNorm: 1.1,
        });

        const featuresPriceMoved = Array.from({ length: 10 }, (_, i) =>
            makeFeature({
                cycleIdx: i,
                ts: 1000 + i,
                currentPriceNorm: 1.05, // close price = last feature price
            }),
        );

        const result = computeOutcome(positionPriceMoved, featuresPriceMoved, 1.0);

        // IL = capital - lpValueAtClose (positive means loss)
        // With price moving from 1.0 → 1.05 within range, there should be some IL > 0
        expect(result.impermanentLoss).toBeGreaterThan(0);

        // Verify LP value at close is less than initial capital (since IL > 0)
        // lpFinalValue = lpValueAtClose + feeIncome
        const lpValueAtClose = result.lpFinalValue - result.feeIncome;
        expect(lpValueAtClose).toBeLessThan(10_000);
    });

    test('HODL counterfactual 用 50/50 split + close price revalue', () => {
        // Open at 1.0, close at 1.1 (last feature price)
        const positionPriceUp = makeHypotheticalPosition({
            openPriceNorm: 1.0,
        });

        const featuresPriceUp = Array.from({ length: 10 }, (_, i) =>
            makeFeature({
                cycleIdx: i,
                ts: 1000 + i,
                currentPriceNorm: 1.1, // close price
            }),
        );

        const result = computeOutcome(positionPriceUp, featuresPriceUp, 1.0);

        // HODL = capital * (openPrice + closePrice) / (2 * openPrice)
        // = 10000 * (1.0 + 1.1) / (2 * 1.0) = 10000 * 1.05 = 10500
        expect(result.hodlFinalValue).toBeCloseTo(10_500, 2);
    });
});
