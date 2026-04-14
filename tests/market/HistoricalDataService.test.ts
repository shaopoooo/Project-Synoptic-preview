import {
    mergeCandles,
    paginateBackfillRequests,
} from '../../src/market/HistoricalDataService';

describe('HistoricalDataService', () => {
    describe('mergeCandles', () => {
        it('should merge two sorted arrays without duplicates', () => {
            const existing = [
                { ts: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
                { ts: 200, open: 2, high: 2, low: 2, close: 2, volume: 2 },
            ];
            const incoming = [
                { ts: 200, open: 2.1, high: 2.1, low: 2.1, close: 2.1, volume: 2.1 },
                { ts: 300, open: 3, high: 3, low: 3, close: 3, volume: 3 },
            ];
            const merged = mergeCandles(existing, incoming);
            expect(merged).toHaveLength(3);
            expect(merged.map(c => c.ts)).toEqual([100, 200, 300]);
        });

        it('should keep the candle with higher volume on ts conflict', () => {
            const existing = [{ ts: 100, open: 1, high: 1, low: 1, close: 1, volume: 10 }];
            const incoming = [{ ts: 100, open: 2, high: 2, low: 2, close: 2, volume: 5 }];
            const merged = mergeCandles(existing, incoming);
            expect(merged).toHaveLength(1);
            expect(merged[0].volume).toBe(10);
        });
    });

    describe('paginateBackfillRequests', () => {
        it('should split 150 days into 4 pages of 1000 candles', () => {
            const now = Math.floor(Date.now() / 1000);
            const pages = paginateBackfillRequests(150, now);
            expect(pages.length).toBe(4);
            for (let i = 1; i < pages.length; i++) {
                expect(pages[i].before).toBeLessThan(pages[i - 1].before);
            }
        });

        it('should return 1 page for 30 days', () => {
            const now = Math.floor(Date.now() / 1000);
            const pages = paginateBackfillRequests(30, now);
            expect(pages.length).toBe(1);
        });
    });
});
