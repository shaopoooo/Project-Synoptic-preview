import { PriceBuffer } from '../../src/services/market/PoolMarketService';

describe('PriceBuffer', () => {
    let buffer: PriceBuffer;

    beforeEach(() => {
        buffer = new PriceBuffer();
    });

    it('returns empty array for unknown pool', () => {
        expect(buffer.getPrices('0xunknown')).toEqual([]);
    });

    it('stores and retrieves a price', () => {
        buffer.addPrice('0xpool', 0.03);
        expect(buffer.getPrices('0xpool')).toEqual([0.03]);
    });

    it('rejects non-finite and non-positive prices', () => {
        buffer.addPrice('0xpool', NaN);
        buffer.addPrice('0xpool', Infinity);
        buffer.addPrice('0xpool', -1);
        expect(buffer.getPrices('0xpool')).toEqual([]);
    });

    it('overwrites price within the same hour', () => {
        buffer.addPrice('0xpool', 0.03);
        buffer.addPrice('0xpool', 0.04);
        // Same hour → only one entry, latest wins
        expect(buffer.getPrices('0xpool')).toHaveLength(1);
        expect(buffer.getPrices('0xpool')[0]).toBe(0.04);
    });

    it('is case-insensitive for pool address', () => {
        buffer.addPrice('0xABCD', 0.03);
        expect(buffer.getPrices('0xabcd')).toEqual([0.03]);
    });

    it('serializes and restores round-trip correctly', () => {
        buffer.addPrice('0xpool', 0.03);
        const snap = buffer.serialize();
        const restored = new PriceBuffer();
        restored.restore(snap);
        expect(restored.getPrices('0xpool')).toEqual([0.03]);
    });

    it('restore skips invalid prices', () => {
        const badData = { '0xpool': { '1234567890000': -1, '1234567891000': 0.03 } };
        const restored = new PriceBuffer();
        restored.restore(badData);
        const prices = restored.getPrices('0xpool');
        expect(prices).toHaveLength(1);
        expect(prices[0]).toBe(0.03);
    });

    it('restore clears existing data', () => {
        buffer.addPrice('0xold', 0.05);
        buffer.restore({});
        expect(buffer.getPrices('0xold')).toEqual([]);
    });
});
