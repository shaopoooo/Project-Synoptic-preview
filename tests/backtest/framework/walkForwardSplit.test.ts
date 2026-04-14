import { temporalSplit } from '../../../src/backtest/framework/walkForwardSplit';

const DAY = 86400;

describe('temporalSplit', () => {
    it('153 天資料依 60/20/20 切分，各段長度約等於比例', () => {
        const startTs = 0;
        const endTs = 153 * DAY;
        const split = temporalSplit(startTs, endTs, { train: 0.6, val: 0.2, test: 0.2 });

        const trainLen = split.trainEnd - split.trainStart;
        const valLen = split.valEnd - split.valStart;
        const testLen = split.testEnd - split.testStart;

        // 允許 ±1 天（integer rounding）
        expect(Math.abs(trainLen - 92 * DAY)).toBeLessThanOrEqual(DAY);
        expect(Math.abs(valLen - 31 * DAY)).toBeLessThanOrEqual(DAY);
        expect(Math.abs(testLen - 30 * DAY)).toBeLessThanOrEqual(DAY);
    });

    it('切分邊界採 half-open interval，trainEnd === valStart、valEnd === testStart', () => {
        const split = temporalSplit(0, 153 * DAY, { train: 0.6, val: 0.2, test: 0.2 });

        expect(split.trainEnd).toBe(split.valStart);
        expect(split.valEnd).toBe(split.testStart);
    });

    it('連續時序切分（非隨機抽樣），嚴格保持時間順序且涵蓋整段資料', () => {
        const startTs = 100;
        const endTs = 100 + 153 * DAY;
        const split = temporalSplit(startTs, endTs, { train: 0.6, val: 0.2, test: 0.2 });

        expect(split.trainStart).toBe(startTs);
        expect(split.testEnd).toBe(endTs);
        expect(split.trainStart).toBeLessThan(split.trainEnd);
        // half-open 邊界為嚴格相等（非 ≤），用 toBe 防未來 off-by-one 迴歸
        expect(split.trainEnd).toBe(split.valStart);
        expect(split.valStart).toBeLessThan(split.valEnd);
        expect(split.valEnd).toBe(split.testStart);
        expect(split.testStart).toBeLessThan(split.testEnd);
    });

    it('資料短於 30 天應拋出錯誤', () => {
        expect(() =>
            temporalSplit(0, 20 * DAY, { train: 0.6, val: 0.2, test: 0.2 }),
        ).toThrow(/至少|minimum|too short/i);
    });

    it('ratios 總和 ≠ 1 （超出 ±0.001 容忍）應拋出錯誤', () => {
        expect(() =>
            temporalSplit(0, 153 * DAY, { train: 0.6, val: 0.2, test: 0.3 }),
        ).toThrow(/ratios|sum|1/i);
    });

    it('任一 ratio ≤ 0 應拋出錯誤（契約：所有段必須 > 0，不允許 train-only / train-test-only）', () => {
        expect(() =>
            temporalSplit(0, 153 * DAY, { train: 0.8, val: 0, test: 0.2 }),
        ).toThrow(/> 0|大於 0|positive|必須/i);
    });
});
