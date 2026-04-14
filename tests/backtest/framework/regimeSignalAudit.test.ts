/**
 * regimeSignalAudit tests
 *
 * 驗證 regime engine signal quality 的量化 metrics。
 * 使用合成 fixture（不依賴真實 OHLCV data）。
 */

import { auditRegimeSignal, RegimeAuditResult } from '../../../src/backtest/framework/regimeSignalAudit';
import type { ReplayFeature } from '../../../src/types/replay';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** 產生 n 個 cycle 的 ReplayFeature，每 cycle = 1 hour */
function makeFeatures(
    count: number,
    opts: {
        /** regime 產生器：cycle index → { range, trend, neutral } */
        regime: (i: number) => { range: number; trend: number; neutral: number } | null;
        /** price 產生器：cycle index → normalized price */
        price: (i: number) => number | null;
        /** ATR half width（固定值） */
        atr?: number;
        /** 起始 timestamp (unix seconds) */
        startTs?: number;
    },
): ReplayFeature[] {
    const startTs = opts.startTs ?? 1700000000; // arbitrary
    return Array.from({ length: count }, (_, i) => ({
        poolId: '0xtest',
        poolLabel: 'TEST/POOL',
        ts: startTs + i * 3600,  // 1 hour per cycle
        cycleIdx: i,
        mcScore: null,
        mcMean: null,
        mcStd: null,
        mcCvar95: null,
        regime: opts.regime(i),
        PaNorm: null,
        PbNorm: null,
        atrHalfWidth: opts.atr ?? 0.02,
        currentPriceNorm: opts.price(i),
        candleVolume: 100,
        poolTvlProxy: 1_000_000,
        poolFeeTier: 3000,
    }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('regimeSignalAudit', () => {

    test('明確 trending 期間 — trendVsRangeRatio 應顯著 > 1', () => {
        // 前 100h = range (price 1.0 ± 0.001 noise)
        // 後 100h = trend (price 從 1.0 漲到 1.10 = +10%)
        const features = makeFeatures(200, {
            regime: (i) => i < 100
                ? { range: 0.7, trend: 0.2, neutral: 0.1 }
                : { range: 0.2, trend: 0.7, neutral: 0.1 },
            price: (i) => i < 100
                ? 1.0 + Math.sin(i * 0.3) * 0.003  // range: small sine noise (~0.3%)
                : 1.0 + (i - 100) * 0.001,           // trend: steady climb (+10% over 100h)
        });

        const result = auditRegimeSignal(features);

        expect(result.totalValidCycles).toBe(200);
        expect(result.transitionCount).toBeGreaterThanOrEqual(1);
        expect(result.trendRegime.episodeCount).toBeGreaterThanOrEqual(1);
        expect(result.rangeRegime.episodeCount).toBeGreaterThanOrEqual(1);
        // Trend period 的 24h move 應遠大於 range period
        expect(result.trendVsRangeRatio).toBeGreaterThan(1.5);
    });

    test('明確 range 期間 — pctWithinAtr24h 應 > 80%', () => {
        // 全部 range，price 在 1.0 ± 0.005 小幅震盪，ATR = 0.02
        const features = makeFeatures(200, {
            regime: () => ({ range: 0.8, trend: 0.1, neutral: 0.1 }),
            price: (i) => 1.0 + Math.sin(i * 0.1) * 0.005,
            atr: 0.02,
        });

        const result = auditRegimeSignal(features);

        expect(result.rangeRegime.episodeCount).toBeGreaterThanOrEqual(1);
        expect(result.rangeRegime.pctWithinAtr24h).toBeGreaterThan(0.8);
        expect(result.flipFlopCount).toBe(0);
    });

    test('flip-flop — 頻繁切換 regime 應被計數', () => {
        // 每 2 小時切一次 regime（遠低於 4h threshold）
        const features = makeFeatures(100, {
            regime: (i) => Math.floor(i / 2) % 2 === 0
                ? { range: 0.7, trend: 0.2, neutral: 0.1 }
                : { range: 0.2, trend: 0.7, neutral: 0.1 },
            price: (i) => 1.0 + i * 0.0001, // slight drift, doesn't matter
        });

        const result = auditRegimeSignal(features);

        expect(result.flipFlopCount).toBeGreaterThan(10);
        expect(result.flipFlopRate).toBeGreaterThan(0.5);
    });

    test('空 / 短 input — 不 throw，回傳 fallback', () => {
        const empty = auditRegimeSignal([]);
        expect(empty.totalValidCycles).toBe(0);
        expect(empty.trendVsRangeRatio).toBe(0);

        // 全 null regime
        const nullRegime = makeFeatures(50, {
            regime: () => null,
            price: (i) => 1.0 + i * 0.001,
        });
        const result = auditRegimeSignal(nullRegime);
        expect(result.totalValidCycles).toBe(0);
    });
});
