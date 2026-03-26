import { config } from '../config';
import { appState, ucUpsertPosition } from '../utils/AppState';
import { PositionRecord } from '../types';
import { createServiceLogger } from '../utils/logger';
import { findMintTimestampMs } from './EventLogScanner';

const log = createServiceLogger('TimestampFiller');

export class TimestampFiller {

    /**
     * 背景補齊缺少 openTimestamp 的倉位。
     * 找到後立即更新 appState.userConfig 並呼叫 saveStateCallback 持久化。
     * 失敗次數已合併至 openTimestamp=-1（N/A 哨兵值），不再維護獨立 Map。
     * 回傳更新後的 positions 陣列。
     */
    async fill(
        positions: PositionRecord[],
        saveStateCallback?: () => Promise<void>,
    ): Promise<PositionRecord[]> {
        // openTimestamp=undefined → 待查；openTimestamp=-1 → 已放棄（N/A）
        const missing = positions.filter(p => p.openTimestampMs === undefined);
        if (missing.length === 0) return positions;

        log.info(`⏳ fillMissingTimestamps  ${missing.length} token(s) pending`);

        let updated = [...positions];
        const failures = new Map<string, number>(); // 本次執行期間的失敗計數
        let filled = 0;

        for (const pos of missing) {
            const npmAddress = config.NPM_ADDRESSES[pos.dex];
            if (!npmAddress) continue;

            const tsMs = await findMintTimestampMs(pos.tokenId, npmAddress);
            if (tsMs !== null) {
                // 更新 in-memory positions
                updated = updated.map(p =>
                    p.tokenId === pos.tokenId ? { ...p, openTimestampMs: tsMs } : p
                );
                // 更新 appState.userConfig（持久化來源）
                appState.userConfig = ucUpsertPosition(
                    appState.userConfig,
                    pos.ownerWallet,
                    pos.tokenId,
                    { openTimestamp: tsMs }
                );
                filled++;
                if (saveStateCallback) {
                    await saveStateCallback().catch(e => log.error(`Timestamp saveState failed: ${e}`));
                }
            } else {
                const cnt = (failures.get(pos.tokenId) ?? 0) + 1;
                failures.set(pos.tokenId, cnt);
                if (cnt >= config.TIMESTAMP_MAX_FAILURES) {
                    log.warn(`⏳ #${pos.tokenId} timestamp lookup failed ${cnt} times — marking N/A`);
                    updated = updated.map(p =>
                        p.tokenId === pos.tokenId ? { ...p, openTimestampMs: -1 } : p
                    );
                    appState.userConfig = ucUpsertPosition(
                        appState.userConfig, pos.ownerWallet, pos.tokenId, { openTimestamp: -1 }
                    );
                }
            }
        }

        if (filled > 0) log.info(`✅ fillMissingTimestamps  ${filled} timestamp(s) filled`);
        return updated;
    }
}
