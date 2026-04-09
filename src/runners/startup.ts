/**
 * startup.ts — Bot 啟動 + State 恢復（快取 / priceBuffer）
 */

import { TelegramBotService, VALID_INTERVALS, IntervalMinutes } from '../bot/TelegramBot';
import { restorePriceBuffer } from '../services/market/PoolMarketService';
import { createServiceLogger } from '../utils/logger';
import { loadState, restoreState } from '../utils/stateManager';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { appState } from '../utils/AppState';
import { config } from '../config';
import type { DiagnosticStore } from '../utils/diagnosticStore';

const log = createServiceLogger('Startup');

export async function runStartup(
    botService: TelegramBotService,
    diagnosticStore: DiagnosticStore,
): Promise<{ currentIntervalMinutes: number }> {
    let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;

    // ── Bot ──────────────────────────────────────────────────────────────────
    botService.registerDiagnostics(diagnosticStore);
    botService.startBot().catch(e => log.fatal('Bot start error', e));

    // ── State restore ────────────────────────────────────────────────────────
    const saved = await loadState();
    if (saved) {
        restoreState(saved);
        restorePriceBuffer(saved.priceHistory ?? {});
        bandwidthTracker.restore(saved.rpcBandwidthWindows ?? {});
        if (saved.userConfig) {
            appState.userConfig = saved.userConfig;
            const uc = saved.userConfig;
            if (uc.intervalMinutes && VALID_INTERVALS.includes(uc.intervalMinutes as IntervalMinutes))
                currentIntervalMinutes = uc.intervalMinutes;
        }
        log.info('✅ state restored');
    }

    return { currentIntervalMinutes };
}
