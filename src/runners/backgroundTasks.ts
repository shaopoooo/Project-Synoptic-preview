import { positionScanner } from '../services/PositionScanner';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('BackgroundTasks');

type SaveFn = () => Promise<void>;

/**
 * 低優先級背景鏈上查詢，主週期完成後依序執行：
 * 1. 質押倉位掃描
 * 2. 存檔
 * 3. 補齊缺少 openTimestamp 的倉位
 */
export async function runBackgroundTasks(save: SaveFn): Promise<void> {
    log.info('▶ BackgroundTasks start');
    await positionScanner.scanStakedPositions();
    await save();
    await positionScanner.fillMissingTimestamps(save);
    log.info('✅ BackgroundTasks done');
}
