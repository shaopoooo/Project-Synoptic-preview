import { appState } from '../utils/AppState';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { checkMarketAlerts } from '../bot/alertService';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import type { TelegramBotService } from '../bot/TelegramBot';
import type { PositionRecord, PoolStats, MarketSnapshot, RiskAnalysis } from '../types';

const log = createServiceLogger('Reporting');

// Window-based timers — not persisted, first cycle after restart always sends full report
let lastFlashAt = 0;
let lastFullReportAt = 0;

export async function runBotService(
    bot: TelegramBotService,
    isStartupComplete: boolean,
): Promise<void> {
    if (!isStartupComplete) {
        log.info('[BotService] Skipped: Initial data sync not complete yet.');
        return;
    }

    try {
        if (appState.positions.length === 0) {
            log.info('BotService skipped: no active positions');
            return;
        }

        const now = Date.now();
        const flashIntervalMs = (appState.userConfig.flashIntervalMinutes ?? config.DEFAULT_FLASH_INTERVAL_MINUTES) * 60 * 1000;
        const fullReportIntervalMs = (appState.userConfig.fullReportIntervalMinutes ?? config.DEFAULT_FULL_REPORT_INTERVAL_MINUTES) * 60 * 1000;

        let reportSent = false;
        let flashSent = false;

        // 快訊（獨立計時器，優先送出）
        if (Math.floor(now / flashIntervalMs) > Math.floor(lastFlashAt / flashIntervalMs)) {
            await bot.sendFlashReport(appState.positions);
            lastFlashAt = now;
            flashSent = true;
            log.info(`✅ Telegram flash report sent  ${appState.positions.length} position(s)`);
        }

        // 完整報告（獨立計時器，快訊之後送出）
        if (Math.floor(now / fullReportIntervalMs) > Math.floor(lastFullReportAt / fullReportIntervalMs)) {
            const entries: Array<{ position: PositionRecord; pool: PoolStats; bb: MarketSnapshot | null; risk: RiskAnalysis }> = [];
            for (const pos of appState.positions) {
                const poolData = appState.findPool(pos.poolAddress, pos.dex);
                const bb = poolData ? (appState.marketSnapshots[poolData.id.toLowerCase()] ?? null) : null;
                const risk = pos.riskAnalysis;
                if (!poolData || !risk) {
                    log.warn(`Missing data for position ${pos.tokenId}, skipping.`);
                    continue;
                }
                entries.push({ position: pos, pool: poolData, bb, risk });
            }
            if (entries.length > 0) {
                await bot.sendConsolidatedReport(entries, appState.pools, appState.lastUpdated);
                lastFullReportAt = now;
                reportSent = true;
                log.info(`✅ Telegram full report sent  ${entries.length} position(s)`);

                // ── 本週期警告附加於完整報告之後 ─────────────────────────────
                if (appState.cycleWarnings.length > 0) {
                    const warnMsg = `⚠️ <b>本週期警告（${appState.cycleWarnings.length} 項）</b>\n`
                        + appState.cycleWarnings.map(w => `  • ${w}`).join('\n');
                    await bot.sendAlert(warnMsg).catch(() => { });
                    log.warn(`CycleWarnings sent: ${appState.cycleWarnings.length} item(s)`);
                }
            }
        }

        if (!reportSent && !flashSent) {
            log.info('BotService: no report due this cycle');
        }

        await checkMarketAlerts(
            appState.marketSnapshots,
            appState.positions,
            appState.pools,
            (key) => bandwidthTracker.getAvg(key),
            (msg) => bot.sendAlert(msg),
        );
    } catch (error) {
        log.error(`BotService: ${error}`);
    }
}
