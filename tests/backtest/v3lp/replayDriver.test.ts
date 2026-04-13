/**
 * V3LpReplayDriver — TDD 測試（Stage 1 / Group D / Batch 4）
 *
 * 對應 plan `.claude/plans/p0-backtest-verification.md` lines 740-747
 * 7 個 test cases 驗證 replay driver 的核心邏輯。
 */
import { V3LpReplayDriver } from '../../../src/backtest/v3lp/replayDriver';
import type { ReplayFeature, ThresholdSet, HypotheticalPosition } from '../../../src/types/replay';

// ─── Fixture Helpers ────────────────────────────────────────────────────────

/** 預設 threshold：sharpeOpen=0.6, sharpeClose=0.3, atrMultiplier=1.0 */
const DEFAULT_THRESHOLD: ThresholdSet = {
    sharpeOpen: 0.6,
    sharpeClose: 0.3,
    atrMultiplier: 1.0,
};

/** 產生高分 regime（range-dominant，非 trend） */
function rangeRegime() {
    return { range: 0.7, trend: 0.2, neutral: 0.1 };
}

/** 產生趨勢 regime（trend > 0.6 觸發 trend_shift close） */
function trendRegime() {
    return { range: 0.1, trend: 0.8, neutral: 0.1 };
}

const BASE_TS = 1_700_000_000; // 基準 Unix seconds

function makeFeature(overrides: Partial<ReplayFeature> = {}): ReplayFeature {
    return {
        poolId: 'pool1',
        poolLabel: 'WETH-USDC',
        ts: BASE_TS,
        cycleIdx: 0,
        mcScore: 0.8,
        mcMean: 0.05,
        mcStd: 0.02,
        mcCvar95: -0.03,
        regime: rangeRegime(),
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

/**
 * 產生一段連續的 feature 序列（以 1 小時間距）。
 * cycleIdx 從 startCycle 開始遞增，ts 從 startTs 以 3600s 間距遞增。
 */
function makeFeatureSequence(
    count: number,
    overrides: Partial<ReplayFeature> = {},
    startCycle = 0,
    startTs = BASE_TS,
): ReplayFeature[] {
    return Array.from({ length: count }, (_, i) =>
        makeFeature({
            cycleIdx: startCycle + i,
            ts: startTs + i * 3600,
            ...overrides,
        }),
    );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('V3LpReplayDriver', () => {

    // ── Test 1: raw mode 立即觸發（不需 hysteresis） ──────────────────────
    test('test_replayDriver_rawMode_immediateOnScoreThreshold', () => {
        // score=0.8 > sharpeOpen=0.6 → 第一個 cycle 即可觸發 open
        // 需要足夠 features 讓 position 最終被 force settle
        const features = makeFeatureSequence(5, { mcScore: 0.8 });
        const driver = new V3LpReplayDriver(features);
        const outcomes = driver.run(DEFAULT_THRESHOLD, 'raw');

        // 應至少有一個 outcome（位置在第一個有效 cycle 開倉，最後 force settle）
        expect(outcomes.length).toBeGreaterThanOrEqual(1);
        // 第一個 outcome 的 position 應在 cycleIdx=0 開倉
        expect(outcomes[0].position.openedAtCycle).toBe(0);
    });

    // ── Test 2: full-state mode 需要 2 連續 cycle 才觸發 ─────────────────
    test('test_replayDriver_fullStateMode_hysteresisRequired', () => {
        // 只給 1 cycle 高分 → 不開倉
        const singleHighFeatures = [
            makeFeature({ cycleIdx: 0, ts: BASE_TS, mcScore: 0.8 }),
            makeFeature({ cycleIdx: 1, ts: BASE_TS + 3600, mcScore: 0.2 }), // 低分中斷
            makeFeature({ cycleIdx: 2, ts: BASE_TS + 7200, mcScore: 0.2 }),
        ];
        const driver1 = new V3LpReplayDriver(singleHighFeatures);
        const outcomes1 = driver1.run(DEFAULT_THRESHOLD, 'full-state');
        expect(outcomes1.length).toBe(0); // 只有 1 cycle 高分，不觸發

        // 2 連續 cycle 高分 → 開倉
        const twoHighFeatures = [
            makeFeature({ cycleIdx: 0, ts: BASE_TS, mcScore: 0.8 }),
            makeFeature({ cycleIdx: 1, ts: BASE_TS + 3600, mcScore: 0.8 }),
            makeFeature({ cycleIdx: 2, ts: BASE_TS + 7200, mcScore: 0.8 }),
        ];
        const driver2 = new V3LpReplayDriver(twoHighFeatures);
        const outcomes2 = driver2.run(DEFAULT_THRESHOLD, 'full-state');
        expect(outcomes2.length).toBeGreaterThanOrEqual(1);
        // 在第 2 個連續高分 cycle（cycleIdx=1）時觸發開倉
        expect(outcomes2[0].position.openedAtCycle).toBe(1);
    });

    // ── Test 3: open advice 建立 hypothetical position ───────────────────
    test('test_replayDriver_openAdvice_createsHypotheticalPosition', () => {
        const features = makeFeatureSequence(3, {
            mcScore: 0.8,
            PaNorm: 0.92,
            PbNorm: 1.08,
            currentPriceNorm: 1.0,
        });
        const driver = new V3LpReplayDriver(features);
        const outcomes = driver.run(DEFAULT_THRESHOLD, 'raw');

        expect(outcomes.length).toBeGreaterThanOrEqual(1);
        const pos = outcomes[0].position;

        // positionId 格式：`${poolId}:${openTs}`
        expect(pos.positionId).toBe(`pool1:${BASE_TS}`);
        expect(pos.poolId).toBe('pool1');
        expect(pos.openPriceNorm).toBe(1.0);
        expect(pos.PaNorm).toBe(0.92);
        expect(pos.PbNorm).toBe(1.08);
        expect(pos.initialCapital).toBe(10_000);
        expect(pos.openedAtTs).toBe(BASE_TS);
    });

    // ── Test 4: close condition 結算 position ────────────────────────────
    test('test_replayDriver_closeCondition_settlesPosition', () => {
        // cycle 0: 開倉（score > sharpeOpen）
        // cycle 1: trend_shift 觸發關倉（trend > 0.6）
        const features = [
            makeFeature({
                cycleIdx: 0, ts: BASE_TS,
                mcScore: 0.8, regime: rangeRegime(),
            }),
            makeFeature({
                cycleIdx: 1, ts: BASE_TS + 3600,
                mcScore: 0.8, regime: trendRegime(), // trend=0.8 > 0.6 → trend_shift
            }),
        ];
        const driver = new V3LpReplayDriver(features);
        const outcomes = driver.run(DEFAULT_THRESHOLD, 'raw');

        expect(outcomes.length).toBe(1);
        const pos = outcomes[0].position;
        expect(pos.closedAtCycle).toBe(1);
        expect(pos.closedAtTs).toBe(BASE_TS + 3600);
        expect(pos.closeReason).toBe('trend_shift');
    });

    // ── Test 5: hard cap 7d（168 小時）強制結算 ──────────────────────────
    test('test_replayDriver_hardCap7d_forcedSettlement', () => {
        // 開倉後持續 170 cycle（超過 168h hard cap），無 close trigger
        const features = makeFeatureSequence(170, {
            mcScore: 0.8,
            regime: rangeRegime(), // 無 trend_shift
        });
        const driver = new V3LpReplayDriver(features);
        const outcomes = driver.run(DEFAULT_THRESHOLD, 'raw');

        expect(outcomes.length).toBeGreaterThanOrEqual(1);
        const pos = outcomes[0].position;
        // 應該在 cycle 168 被 hard cap 關閉
        expect(pos.closeReason).toBe('hard_cap_7d');
        expect(pos.closedAtCycle).toBe(168);
    });

    // ── Test 6: rebalance = close old + open new ─────────────────────────
    test('test_replayDriver_rebalance_closeAndReopen', () => {
        // cycle 0: 開倉
        // cycle 1: 價格穿出 band 很深（penetration > 2×ATR），regime trend
        //          → classifyExit = rebalance → close old + open new
        // cycle 2: 新倉位繼續存在
        const features = [
            makeFeature({
                cycleIdx: 0, ts: BASE_TS,
                mcScore: 0.8, currentPriceNorm: 1.0,
                PaNorm: 0.95, PbNorm: 1.05, atrHalfWidth: 0.02,
                regime: rangeRegime(),
            }),
            makeFeature({
                cycleIdx: 1, ts: BASE_TS + 3600,
                mcScore: 0.8,
                currentPriceNorm: 1.20, // 遠超 PbNorm=1.05，深度 penetration
                PaNorm: 0.95, PbNorm: 1.05, atrHalfWidth: 0.02,
                regime: { range: 0.3, trend: 0.5, neutral: 0.2 }, // range < 0.5 → rebalance
            }),
            makeFeature({
                cycleIdx: 2, ts: BASE_TS + 7200,
                mcScore: 0.8, currentPriceNorm: 1.20,
                PaNorm: 0.95, PbNorm: 1.05, atrHalfWidth: 0.02,
                regime: rangeRegime(),
            }),
        ];
        const driver = new V3LpReplayDriver(features);
        const outcomes = driver.run(DEFAULT_THRESHOLD, 'raw');

        // 至少 2 個 outcomes：old position closed by rebalance + new position force settled
        expect(outcomes.length).toBeGreaterThanOrEqual(2);
        // 第一個被 rebalance 關倉（closeReason 應為非標準 — 用 null 或自訂）
        const firstPos = outcomes[0].position;
        expect(firstPos.closedAtCycle).toBe(1);
        // 第二個是 rebalance 後重開的倉
        const secondPos = outcomes[1].position;
        expect(secondPos.openedAtCycle).toBe(1);
    });

    // ── Test 7: replay 結束時 force settle 所有 open positions ──────────
    test('test_replayDriver_endOfReplay_forceSettleOpenPositions', () => {
        // 3 cycle，無 close trigger → 倉位在 replay 結束時 force settle
        const features = makeFeatureSequence(3, {
            mcScore: 0.8,
            regime: rangeRegime(),
        });
        const driver = new V3LpReplayDriver(features);
        const outcomes = driver.run(DEFAULT_THRESHOLD, 'raw');

        expect(outcomes.length).toBe(1);
        const pos = outcomes[0].position;
        // 在最後一個 feature 時 force settle
        expect(pos.closedAtCycle).toBe(2); // last cycleIdx
        expect(pos.closedAtTs).toBe(BASE_TS + 2 * 3600);
        expect(pos.closeReason).toBe('hard_cap_7d');
    });
});
