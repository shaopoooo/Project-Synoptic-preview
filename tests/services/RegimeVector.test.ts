import seedrandom from 'seedrandom';
// 鎖死 Math.random，讓 syntheticCandles + randomGenome 完全決定論
// （在 import 其他模組「之前」seed，避免模組層 random 還是用真實 Math.random）
seedrandom('regime-vector-test', { global: true });

import { computeRegimeVector, segmentByRegime } from '../../src/services/strategy/MarketRegimeAnalyzer';
import { randomGenome } from '../../src/services/strategy/ParameterGenome';
import type { HourlyReturn } from '../../src/types';

/** 產生合成蠟燭數據 */
function syntheticCandles(n: number, center = 1000, spread = 50): HourlyReturn[] {
    const candles: HourlyReturn[] = [];
    let price = center;
    // Need n+1 raw candles to get n candles with valid r
    const raw: Array<{ price: number; high: number; low: number }> = [];
    for (let i = 0; i <= n; i++) {
        const change = (Math.random() - 0.5) * spread;
        price = Math.max(price + change, 1);
        raw.push({ price, high: price + Math.abs(change), low: price - Math.abs(change) });
    }
    for (let i = 1; i <= n; i++) {
        candles.push({
            ts: 1000000 + i * 3600,
            open: raw[i].price - (Math.random() - 0.5) * 10,
            high: raw[i].high,
            low: raw[i].low,
            close: raw[i].price,
            volume: 1000 + Math.random() * 5000,
            r: Math.log(raw[i].price / raw[i - 1].price),
        });
    }
    return candles;
}

describe('computeRegimeVector', () => {
    const candles = syntheticCandles(200);

    it('should produce valid probability distribution for 100 random genomes', () => {
        for (let i = 0; i < 100; i++) {
            const genome = randomGenome();
            const vec = computeRegimeVector(candles, genome);

            expect(vec.range + vec.trend + vec.neutral).toBeCloseTo(1.0, 10);
            expect(vec.range).toBeGreaterThanOrEqual(0);
            expect(vec.trend).toBeGreaterThanOrEqual(0);
            expect(vec.neutral).toBeGreaterThanOrEqual(0);
            expect(vec.range).toBeLessThanOrEqual(1);
            expect(vec.trend).toBeLessThanOrEqual(1);
            expect(vec.neutral).toBeLessThanOrEqual(1);
            expect(Number.isNaN(vec.range)).toBe(false);
            expect(Number.isNaN(vec.trend)).toBe(false);
            expect(Number.isNaN(vec.neutral)).toBe(false);
        }
    });

    it('should approach one-hot when sigmoidTemp is very small', () => {
        const genome = randomGenome();
        genome.sigmoidTemp = 0.01;
        const vec = computeRegimeVector(candles, genome);
        const max = Math.max(vec.range, vec.trend, vec.neutral);
        expect(max).toBeGreaterThan(0.9);
    });

    it('should approach uniform when sigmoidTemp is very large', () => {
        const genome = randomGenome();
        genome.sigmoidTemp = 100;
        const vec = computeRegimeVector(candles, genome);
        expect(vec.range).toBeGreaterThan(0.15);
        expect(vec.trend).toBeGreaterThan(0.15);
        expect(vec.neutral).toBeGreaterThan(0.15);
    });
});

describe('segmentByRegime', () => {
    it('should return segments with non-empty returns', () => {
        const candles = syntheticCandles(500);
        const segments = segmentByRegime(candles);
        expect(segments.length).toBeGreaterThan(0);
        for (const seg of segments) {
            expect(seg.returns.length).toBeGreaterThan(0);
            expect(['range', 'trend', 'neutral']).toContain(seg.regime);
        }
    });

    it('should handle short candle arrays', () => {
        const candles = syntheticCandles(20);
        const segments = segmentByRegime(candles);
        expect(segments.length).toBeGreaterThan(0);
        // All returns should be accounted for
        const totalReturns = segments.reduce((s, seg) => s + seg.returns.length, 0);
        expect(totalReturns).toBe(candles.length);
    });
});
