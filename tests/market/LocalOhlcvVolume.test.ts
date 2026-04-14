/**
 * Test the volume calculation logic that PoolScanner uses from local OHLCV data.
 * Since fetchPoolVolume is private, we test the calculation pattern directly.
 */
import type { RawCandle } from '../../src/market/HistoricalDataService';

/** Replicate PoolScanner's volume calculation from local OHLCV */
function calculateVolumeFromCandles(candles: RawCandle[]): { daily: number; avg7d: number } | null {
    if (candles.length < 24) return null;
    const last24 = candles.slice(-24);
    const last168 = candles.slice(-168);
    const daily = last24.reduce((s, c) => s + c.volume, 0);
    const daysAvailable = last168.length / 24;
    const avg7d = last168.reduce((s, c) => s + c.volume, 0) / Math.max(daysAvailable, 1);
    return { daily, avg7d };
}

function makeCandles(n: number, volumePerCandle: number): RawCandle[] {
    return Array.from({ length: n }, (_, i) => ({
        ts: 1000000 + i * 3600,
        open: 100, high: 101, low: 99, close: 100,
        volume: volumePerCandle,
    }));
}

describe('Local OHLCV Volume Calculation', () => {
    it('should return null for < 24 candles', () => {
        expect(calculateVolumeFromCandles(makeCandles(10, 1000))).toBeNull();
    });

    it('should sum last 24 candles for daily volume', () => {
        const candles = makeCandles(100, 5000);
        const result = calculateVolumeFromCandles(candles)!;
        expect(result.daily).toBe(24 * 5000); // 120,000
    });

    it('should average 7 days for avg7d volume', () => {
        const candles = makeCandles(200, 5000);
        const result = calculateVolumeFromCandles(candles)!;
        // last168 = 168 candles, daysAvailable = 7
        expect(result.avg7d).toBe(168 * 5000 / 7); // 120,000 per day
    });

    it('should handle exactly 24 candles', () => {
        const candles = makeCandles(24, 1000);
        const result = calculateVolumeFromCandles(candles)!;
        expect(result.daily).toBe(24000);
        expect(result.avg7d).toBe(24000); // only 1 day available
    });

    it('should handle varying volumes', () => {
        const candles: RawCandle[] = Array.from({ length: 48 }, (_, i) => ({
            ts: 1000000 + i * 3600,
            open: 100, high: 101, low: 99, close: 100,
            volume: i < 24 ? 1000 : 2000, // first day 1000, second day 2000
        }));
        const result = calculateVolumeFromCandles(candles)!;
        expect(result.daily).toBe(24 * 2000); // last 24 = second day
        expect(result.avg7d).toBe((24 * 1000 + 24 * 2000) / 2); // 2 days average
    });
});
