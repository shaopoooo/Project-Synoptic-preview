/**
 * featureExtractor（Stage 1 / PR 4 / Batch 2）— TDD 測試。
 *
 * 對應 `.claude/plans/p0-backtest-verification.md` Stage 1 Group B tasks 6-7：
 *   1. 所有池子 × 所有小時 → 每根 candle 一筆 ReplayFeature
 *   2. 固定 seed = cycleIdx → 兩次執行結果 deep-equal
 *   3. MC 歷史不足時 null 化 mc 欄位、不拋錯
 *   4. Regime engine 失敗時 null 化 regime 欄位、不拋錯
 *   5. (poolId, ts) 組合唯一
 *
 * featureExtractor 採 pure sync signature：輸入 OhlcvStore[] 直接輸出 ReplayFeature[]，
 * 檔案 I/O 由 Batch 6 entry script 負責。Plan deviation 已於 source JSDoc 註記。
 */

import { extractFeatures } from '../../../src/backtest/v3lp/featureExtractor';
import { MC_WINDOW_HOURS } from '../../../src/backtest/config';
import type { OhlcvStore, RawCandle } from '../../../src/market/HistoricalDataService';
import type { Dex } from '../../../src/types';

// 測試 fixture 故意只比 MC_WINDOW_HOURS (720) 多 3 根，讓跑 MC 引擎的 late cycle
// 只有 3 個 — 跑 10k paths × 336 hours × 3 cycles 約 10 秒內可接受；
// 再大就會讓整個 suite 變得難以忍受。
const FIXTURE_CANDLES = MC_WINDOW_HOURS + 3;

// ─── fixture helpers ─────────────────────────────────────────────────────────

/** 建立一個具備等距 timestamp 與可控價格序列的 OhlcvStore fixture。 */
function makeOhlcvStore(
    poolAddress: string,
    candleCount: number,
    priceFn: (i: number) => number,
): OhlcvStore {
    const candles: RawCandle[] = [];
    const baseTs = 1_700_000_000; // 任意錨點
    for (let i = 0; i < candleCount; i++) {
        const close = priceFn(i);
        const open = i === 0 ? close : priceFn(i - 1);
        const high = Math.max(open, close) * 1.001;
        const low = Math.min(open, close) * 0.999;
        candles.push({
            ts: baseTs + i * 3600,
            open,
            high,
            low,
            close,
            volume: 50_000 + (i % 7) * 1_000,
        });
    }
    return {
        poolAddress,
        network: 'base',
        lastFetchedTs: baseTs + (candleCount - 1) * 3600,
        candles,
    };
}

/** 溫和的 sinusoidal 價格：在 [95, 105] 區間震盪，足以讓 regime engine 跑得動。 */
function oscillatingPrice(i: number): number {
    return 100 + 5 * Math.sin(i / 30);
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('extractFeatures', () => {
    it('test_extractFeatures_allPoolsAllHours_oneFeatureEach', () => {
        const stores = [
            makeOhlcvStore('0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3', FIXTURE_CANDLES, oscillatingPrice),
            makeOhlcvStore('0xd974d59e30054cf1abeded0c9947b0d8baf90029', FIXTURE_CANDLES, oscillatingPrice),
        ];

        const features = extractFeatures(stores);

        // 每根 candle 一筆 feature（包含早期 cycle，即使其 mc/regime 為 null）
        expect(features).toHaveLength(FIXTURE_CANDLES * 2);

        // 每池應該各貢獻 FIXTURE_CANDLES 筆
        const pool1Count = features.filter(f => f.poolId === stores[0].poolAddress).length;
        const pool2Count = features.filter(f => f.poolId === stores[1].poolAddress).length;
        expect(pool1Count).toBe(FIXTURE_CANDLES);
        expect(pool2Count).toBe(FIXTURE_CANDLES);

        // 非 nullable 欄位應一律填好
        for (const f of features) {
            expect(typeof f.candleVolume).toBe('number');
            expect(typeof f.poolTvlProxy).toBe('number');
            expect(typeof f.poolFeeTier).toBe('number');
        }

        // currentPriceNorm 是 number | null：早期 cycle null，late cycle number
        const lateCycles = features.filter(f => f.cycleIdx >= MC_WINDOW_HOURS);
        const earlyCycles = features.filter(f => f.cycleIdx < MC_WINDOW_HOURS);
        expect(lateCycles.length).toBeGreaterThan(0);
        for (const f of lateCycles) {
            expect(typeof f.currentPriceNorm).toBe('number');
        }
        for (const f of earlyCycles) {
            expect(f.currentPriceNorm).toBeNull();
        }
    });

    it('test_extractFeatures_fixedSeed_reproducible', () => {
        const stores = [
            makeOhlcvStore('0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3', FIXTURE_CANDLES, oscillatingPrice),
        ];

        const first = extractFeatures(stores);
        const second = extractFeatures(stores);

        // 兩次執行結果必須完全一致（固定 seed = cycleIdx）
        expect(second).toEqual(first);

        // 且至少有一些 cycle 跑到 MC 引擎（有 non-null mc 欄位），
        // 確認重現性測試真的覆蓋了隨機路徑
        const hasMcPath = first.some(f => f.mcScore !== null);
        expect(hasMcPath).toBe(true);
    });

    it('test_extractFeatures_mcFailure_nullsNotCrash', () => {
        // candles 數量遠小於 MC_WINDOW_HOURS → 所有 cycle 都在 early-cycle 分支
        const SHORT_FIXTURE = 50;
        const stores = [
            makeOhlcvStore('0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3', SHORT_FIXTURE, oscillatingPrice),
        ];

        // 不應拋錯
        const features = extractFeatures(stores);
        expect(features).toHaveLength(SHORT_FIXTURE);

        for (const f of features) {
            expect(f.mcScore).toBeNull();
            expect(f.mcMean).toBeNull();
            expect(f.mcStd).toBeNull();
            expect(f.mcCvar95).toBeNull();
            expect(f.regime).toBeNull();
            expect(f.PaNorm).toBeNull();
            expect(f.PbNorm).toBeNull();
            expect(f.atrHalfWidth).toBeNull();
            expect(f.currentPriceNorm).toBeNull();
        }
    });

    it('test_extractFeatures_regimeFailure_nullsNotCrash', () => {
        // 真實地觸發 safeComputeRegime 的 try/catch + NaN guard 分支：
        // 使用 jest.isolateModules + jest.doMock 把 computeRegimeVector 強制 throw，
        // 同時保留其他導出函數（computeRangeGuards 等）正常運作。
        //
        // 為何不用「pathological 價格序列」：degenerate 輸入（例如全 0）會先命中
        // featureExtractor 的 `normFactor <= 0` guard 而走 null-feature 捷徑，
        // 根本觸發不到 safeComputeRegime，防禦路徑等於沒被測試到（code review I1）。
        jest.isolateModules(() => {
            jest.doMock('../../../src/engine/shared/MarketRegimeAnalyzer', () => {
                const actual = jest.requireActual(
                    '../../../src/engine/shared/MarketRegimeAnalyzer',
                );
                return {
                    ...actual,
                    computeRegimeVector: () => {
                        throw new Error('forced regime failure (test)');
                    },
                };
            });

            // 重新 require featureExtractor 以套用 mock
            const { extractFeatures: mockedExtract } = require(
                '../../../src/backtest/v3lp/featureExtractor',
            );
            const { MC_WINDOW_HOURS: W } = require('../../../src/backtest/config');

            const stores = [
                makeOhlcvStore(
                    '0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3',
                    W + 3,
                    oscillatingPrice,
                ),
            ];

            expect(() => mockedExtract(stores)).not.toThrow();
            const features = mockedExtract(stores);

            const lateCycle = features.filter(
                (f: { cycleIdx: number }) => f.cycleIdx >= W,
            );
            expect(lateCycle.length).toBeGreaterThan(0);
            // regime 必須為 null（來自 safeComputeRegime catch block）；
            // 但 mc / Pa / Pb / atrHalfWidth 不應因此也變 null（那些依賴其他邏輯）
            for (const f of lateCycle) {
                expect(f.regime).toBeNull();
            }
            // 至少驗證 mc 路徑仍照跑（證明我們只 null 化 regime，不是整筆全 null）
            const hasMcPath = lateCycle.some(
                (f: { mcScore: number | null }) => f.mcScore !== null,
            );
            expect(hasMcPath).toBe(true);
        });
    });

    it('test_extractFeatures_uniqueByPoolIdAndTs', () => {
        const stores = [
            makeOhlcvStore('0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3', FIXTURE_CANDLES, oscillatingPrice),
            makeOhlcvStore('0xd974d59e30054cf1abeded0c9947b0d8baf90029', FIXTURE_CANDLES, oscillatingPrice),
        ];

        const features = extractFeatures(stores);
        const keys = new Set<string>();
        for (const f of features) {
            const key = `${f.poolId}:${f.ts}`;
            expect(keys.has(key)).toBe(false);
            keys.add(key);
        }
        expect(keys.size).toBe(features.length);
    });
});

// 避免未用 import 警告；保留型別以便未來擴充 fixture
export type _Unused = Dex;
