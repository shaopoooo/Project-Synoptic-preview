import { deriveMarketStats } from '../../src/runners/mcEngine';
import type { HourlyReturn } from '../../src/types';

/** Generate synthetic candles with controlled properties */
function makeCandles(n: number, basePrice: number, volatility: number): HourlyReturn[] {
    const candles: HourlyReturn[] = [];
    let price = basePrice;
    for (let i = 0; i < n; i++) {
        const prevPrice = price;
        const change = (Math.random() - 0.5) * volatility * price;
        price = Math.max(price + change, 1);
        candles.push({
            ts: 1000000 + i * 3600,
            open: prevPrice,
            high: Math.max(prevPrice, price) * 1.001,
            low: Math.min(prevPrice, price) * 0.999,
            close: price,
            volume: 1000,
            r: i === 0 ? 0 : Math.log(price / prevPrice),
        });
    }
    return candles;
}

describe('deriveMarketStats', () => {
    it('should return null for < 20 candles', () => {
        const candles = makeCandles(10, 72000, 0.01);
        expect(deriveMarketStats(candles)).toBeNull();
    });

    it('should normalize sma close to 1.0', () => {
        // ETH-priced pool (~$2200)
        const ethCandles = makeCandles(200, 2200, 0.01);
        const ethStats = deriveMarketStats(ethCandles)!;
        expect(ethStats.sma).toBeGreaterThan(0.9);
        expect(ethStats.sma).toBeLessThan(1.1);

        // BTC-priced pool (~$72000)
        const btcCandles = makeCandles(200, 72000, 0.01);
        const btcStats = deriveMarketStats(btcCandles)!;
        expect(btcStats.sma).toBeGreaterThan(0.9);
        expect(btcStats.sma).toBeLessThan(1.1);
    });

    it('should produce similar stdDev1H regardless of price level', () => {
        // Same volatility (1%), different price levels
        const ethCandles = makeCandles(500, 2200, 0.01);
        const btcCandles = makeCandles(500, 72000, 0.01);
        const ethStats = deriveMarketStats(ethCandles)!;
        const btcStats = deriveMarketStats(btcCandles)!;

        // stdDev1H should be similar (both ~0.5% hourly)
        // Allow 2x tolerance due to randomness
        const ratio = ethStats.stdDev1H / btcStats.stdDev1H;
        expect(ratio).toBeGreaterThan(0.3);
        expect(ratio).toBeLessThan(3.0);
    });

    it('should set normFactor to mean of all closes', () => {
        const candles = makeCandles(100, 50000, 0.001);
        const stats = deriveMarketStats(candles)!;
        const meanClose = candles.reduce((s, c) => s + c.close, 0) / candles.length;
        expect(stats.normFactor).toBeCloseTo(meanClose, 0);
    });

    it('should compute volatility30D as annualized stdDev1H', () => {
        const candles = makeCandles(200, 2200, 0.01);
        const stats = deriveMarketStats(candles)!;
        expect(stats.volatility30D).toBeCloseTo(stats.stdDev1H * Math.sqrt(8760), 10);
    });

    it('should return null for all-zero closes', () => {
        const candles: HourlyReturn[] = Array.from({ length: 30 }, (_, i) => ({
            ts: i * 3600, open: 0, high: 0, low: 0, close: 0, volume: 0, r: 0,
        }));
        expect(deriveMarketStats(candles)).toBeNull();
    });
});
