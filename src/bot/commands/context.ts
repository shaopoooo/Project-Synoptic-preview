import type { UserConfig } from '../../types';
import type { PositionScanner } from '../../market/position/PositionScanner';

/** 允許的排程間隔（分鐘）：10 的倍數且能整除 1440，起始對齊每日 00:00 */
export const VALID_INTERVALS = [10, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;
export type IntervalMinutes = typeof VALID_INTERVALS[number];

export function minutesToCron(min: number): string {
    if (min < 60) return `*/${min} * * * *`;
    if (min === 1440) return `0 0 * * *`;
    return `0 */${min / 60} * * *`;
}

export interface BotDeps {
    onReschedule: ((minutes: number) => void) | null;
    onUserConfigChange: ((cfg: UserConfig) => Promise<void>) | null;
    positionScanner: PositionScanner | null;
}
