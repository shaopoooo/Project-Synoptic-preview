/**
 * alertService — Kill Switch & 非對稱撤倉推播
 *
 * 職責：根據市場狀態判斷是否需要發出 Kill Switch 或非對稱撤倉告警。
 * 本模組不依賴 TelegramBot 實例，只接收 sendAlert callback，方便測試。
 */
import { LRUCache } from 'lru-cache';
import type { MarketSnapshot, PositionRecord, PoolStats } from '../types';
import type { MirrorResult, ArchiveResult } from '../types/backup';
import { config } from '../config';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('AlertService');

// 跨週期 cooldown（重啟後清空，保守策略：最多多推一次）
const cooldowns = new LRUCache<string, number>({ max: 100 });

/**
 * 檢查 Kill Switch（帶寬爆表）與非對稱撤倉（Buffer 穿入 80%）告警。
 *
 * @param marketSnapshots        appState.marketSnapshots
 * @param positions  appState.positions
 * @param pools      appState.pools（用來取 DEX label）
 * @param getAvg30D  bandwidthTracker.getAvg（只讀，不影響狀態）
 * @param sendAlert  botService.sendAlert callback
 */
export async function checkMarketAlerts(
    marketSnapshots: Record<string, MarketSnapshot>,
    positions: PositionRecord[],
    pools: PoolStats[],
    getAvg30D: (poolKey: string) => number | null,
    sendAlert: (msg: string) => Promise<void>,
): Promise<void> {
    // ── Kill Switch：帶寬超過 2.5× 30D 均值 ──────────────────────────────────
    for (const [poolKey, bb] of Object.entries(marketSnapshots)) {
        if (!bb.bandwidth) continue;

        const avg30D = getAvg30D(poolKey);
        if (!avg30D || avg30D <= 0) continue;

        if (bb.bandwidth > avg30D * config.KILL_SWITCH_BANDWIDTH_FACTOR) {
            const ksKey = `ks:${poolKey}`;
            const last = cooldowns.get(ksKey) ?? 0;
            if (Date.now() - last >= config.KILL_SWITCH_ALERT_COOLDOWN_MS) {
                cooldowns.set(ksKey, Date.now());
                const poolLabel = pools.find(p => p.id.toLowerCase() === poolKey)?.dex ?? poolKey.slice(0, 8);
                const ratio = (bb.bandwidth / avg30D).toFixed(1);
                await sendAlert(
                    `🚨 <b>Kill Switch A — 帶寬擴張</b>\n` +
                    `池子 <code>${poolLabel}</code> 帶寬爆表！\n` +
                    `當前帶寬 ${(bb.bandwidth * 100).toFixed(2)}%，30D 均 ${(avg30D * 100).toFixed(2)}%（×${ratio}）\n` +
                    `建議暫停開新倉，等待波動回落。（每 4h 持續提醒）`
                ).catch(() => { });
                log.warn(`🚨 Kill Switch triggered for ${poolKey} (bw ×${ratio} avg30D)`);
            }
        }
    }

    // ── 非對稱撤倉：price 穿入 buffer 80% ────────────────────────────────────
    for (const pos of positions) {
        const tranche = pos.tranchePlan;
        if (!tranche) continue;

        const buffer = tranche.buffer;
        const currentPrice = parseFloat(pos.currentPriceStr);
        if (!isFinite(currentPrice) || currentPrice <= 0) continue;

        const bufferWidth = buffer.upperPrice - buffer.lowerPrice;
        if (bufferWidth <= 0) continue;

        let penetration = 0;
        if (buffer.direction === 'down') {
            if (currentPrice < buffer.upperPrice)
                penetration = (buffer.upperPrice - currentPrice) / bufferWidth;
        } else {
            if (currentPrice > buffer.lowerPrice)
                penetration = (currentPrice - buffer.lowerPrice) / bufferWidth;
        }

        if (penetration >= config.ASYMMETRIC_UNWIND_PENETRATION) {
            const unwindKey = `unwind:${pos.tokenId}`;
            const last = cooldowns.get(unwindKey) ?? 0;
            if (Date.now() - last >= config.KILL_SWITCH_ALERT_COOLDOWN_MS) {
                cooldowns.set(unwindKey, Date.now());
                await sendAlert(
                    `⚠️ <b>非對稱撤倉告警</b> #${pos.tokenId}\n` +
                    `當前價格已穿入 Buffer 區間 ${(penetration * 100).toFixed(0)}%\n` +
                    `Buffer: [${buffer.lowerPrice.toFixed(6)}, ${buffer.upperPrice.toFixed(6)}]\n` +
                    `現價: ${currentPrice.toFixed(6)}\n` +
                    `建議評估是否提前撤回流動性。`
                ).catch(() => { });
                log.warn(`⚠️ Asymmetric unwind alert #${pos.tokenId} (penetration ${(penetration * 100).toFixed(0)}%)`);
            }
        }
    }
}

// ── R2 Backup failure alert ──────────────────────────────────────────────────
// 對應 .claude/plans/i-r2-backup.md Decisions #9（任一失敗即推）+ Stage 3 Task 15
//
// 規範（rules/telegram.md）：本模組只做格式化與發送，實際業務邏輯（diff / 上傳 / tar）
// 仍在 src/services/backup/ 內。caller 傳入 sendAlert callback，保持與
// checkMarketAlerts 同樣的 testable pattern。

const BACKUP_ERROR_PREVIEW_LIMIT = 5;

function formatTs(ts: number): string {
    return new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

function formatMirrorFailure(result: MirrorResult): string {
    const lines: string[] = [];
    lines.push('🚨 <b>R2 Backup Mirror Failed</b>');
    lines.push(`時間：${formatTs(result.startedAt)}`);
    lines.push(`耗時：${result.finishedAt - result.startedAt}ms`);
    lines.push(`成功：${result.uploadedCount} 檔（${result.uploadedBytes} bytes）`);
    lines.push(`失敗：${result.failedCount} 檔`);
    if (result.errors.length > 0) {
        lines.push('');
        lines.push('失敗檔案清單：');
        const shown = result.errors.slice(0, BACKUP_ERROR_PREVIEW_LIMIT);
        for (const err of shown) {
            lines.push(`• <code>${err.path}</code> — ${err.message}`);
        }
        const remaining = result.errors.length - shown.length;
        if (remaining > 0) lines.push(`• …（尚有 ${remaining} 筆略）`);
    }
    return lines.join('\n');
}

function formatArchiveFailure(result: ArchiveResult): string {
    const lines: string[] = [];
    lines.push('🚨 <b>R2 Backup Archive Failed</b>');
    lines.push(`時間：${formatTs(result.startedAt)}`);
    lines.push(`耗時：${result.finishedAt - result.startedAt}ms`);
    lines.push(`週次：${result.weekIso}`);
    if (result.r2Key) lines.push(`目標：<code>${result.r2Key}</code>`);
    lines.push(`錯誤：${result.error ?? '(unknown)'}`);
    return lines.join('\n');
}

/**
 * 格式化 backup failure 並透過 sendAlert 推送。
 *
 * caller 只需在 result.ok === false 時呼叫本函式；本函式自己不重複判斷。
 */
export async function sendBackupFailure(
    type: 'mirror' | 'archive',
    result: MirrorResult | ArchiveResult,
    sendAlert: (msg: string) => Promise<void>,
): Promise<void> {
    const msg = type === 'mirror'
        ? formatMirrorFailure(result as MirrorResult)
        : formatArchiveFailure(result as ArchiveResult);
    log.warn(`Backup ${type} failure alert dispatched`);
    await sendAlert(msg).catch((e) => log.error(`sendBackupFailure (${type}) send failed`, e));
}
