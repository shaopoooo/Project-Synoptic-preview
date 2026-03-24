/**
 * alertService — Kill Switch & 非對稱撤倉推播
 *
 * 職責：根據市場狀態判斷是否需要發出 Kill Switch 或非對稱撤倉告警。
 * 本模組不依賴 TelegramBot 實例，只接收 sendAlert callback，方便測試。
 */
import { LRUCache } from 'lru-cache';
import type { BBResult, PositionRecord, PoolStats } from '../types';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('AlertService');

// 跨週期 cooldown（重啟後清空，保守策略：最多多推一次）
const cooldowns = new LRUCache<string, number>({ max: 100 });

/**
 * 檢查 Kill Switch（帶寬爆表）與非對稱撤倉（Buffer 穿入 80%）告警。
 *
 * @param bbs        appState.bbs
 * @param positions  appState.positions
 * @param pools      appState.pools（用來取 DEX label）
 * @param getAvg30D  bandwidthTracker.getAvg（只讀，不影響狀態）
 * @param sendAlert  botService.sendAlert callback
 */
export async function checkMarketAlerts(
    bbs: Record<string, BBResult>,
    positions: PositionRecord[],
    pools: PoolStats[],
    getAvg30D: (poolKey: string) => number | null,
    sendAlert: (msg: string) => Promise<void>,
): Promise<void> {
    // ── Kill Switch：帶寬超過 2.5× 30D 均值 ──────────────────────────────────
    for (const [poolKey, bb] of Object.entries(bbs)) {
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
                    `🚨 <b>Kill Switch 告警</b>\n` +
                    `池子 <code>${poolLabel}</code> 帶寬爆表！\n` +
                    `當前帶寬 ${(bb.bandwidth * 100).toFixed(2)}%，30D 均 ${(avg30D * 100).toFixed(2)}%（×${ratio}）\n` +
                    `建議暫停開新倉，等待波動回落。`
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
