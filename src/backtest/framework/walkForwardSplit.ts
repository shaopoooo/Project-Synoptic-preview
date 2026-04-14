/**
 * Walk-forward / temporal split（PR 4 backtest harness 框架層）。
 *
 * 為什麼一定要時序切分而不是隨機抽樣？
 * - 對應 Eng brainstorming Decision B4：隨機切分會讓 val/test 段偷看到未來
 *   資訊（temporal leakage），使 threshold grid search 結果過於樂觀。
 * - 本函式嚴格沿時間軸切三段：train（較早）→ val（中）→ test（最新）。
 *
 * 區間慣例：**half-open interval** `[start, end)`
 * - `trainEnd === valStart`：trainEnd 這一秒屬於 val，而不屬於 train。
 * - `valEnd === testStart`：同理。
 * - `testEnd === endTs`：最後一段強制對齊 endTs，避免 integer rounding 造成
 *   尾端遺漏。
 *
 * 這是純函數（pure function），無任何 I/O、async、全域狀態。
 */

/**
 * 切分後的三段時間範圍。時間單位 = 呼叫端傳入的 Unix 秒。
 * 所有邊界皆為 half-open：`[start, end)`。
 */
export interface TemporalSplit {
    trainStart: number;
    trainEnd: number;
    valStart: number;
    valEnd: number;
    testStart: number;
    testEnd: number;
}

const MIN_SPAN_SECONDS = 30 * 86400;
const RATIO_TOLERANCE = 1e-3;

/**
 * 將 `[startTs, endTs)` 依 train/val/test 比例切分。
 *
 * @throws 若 `endTs - startTs < 30 天`、或 `ratios` 總和不為 1（±1e-3 容差）、
 *   或任一 ratio ≤ 0。
 */
export function temporalSplit(
    startTs: number,
    endTs: number,
    ratios: { train: number; val: number; test: number },
): TemporalSplit {
    const span = endTs - startTs;

    if (span < MIN_SPAN_SECONDS) {
        throw new Error(
            `temporalSplit: 至少 30 天資料才能 split（minimum 30 days required），實際 span=${span}s`,
        );
    }

    const { train, val, test } = ratios;
    if (train <= 0 || val <= 0 || test <= 0) {
        throw new Error(
            `temporalSplit: ratios 必須全部 > 0，收到 train=${train} val=${val} test=${test}`,
        );
    }

    const sum = train + val + test;
    if (Math.abs(sum - 1) > RATIO_TOLERANCE) {
        throw new Error(
            `temporalSplit: ratios 總和必須為 1（±${RATIO_TOLERANCE}），收到 ${sum}`,
        );
    }

    const trainStart = startTs;
    const trainEnd = startTs + Math.floor(span * train);
    const valStart = trainEnd;
    const valEnd = startTs + Math.floor(span * (train + val));
    const testStart = valEnd;
    const testEnd = endTs; // 強制對齊避免 integer rounding 造成尾端遺漏

    return { trainStart, trainEnd, valStart, valEnd, testStart, testEnd };
}
