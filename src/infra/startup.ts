/**
 * startup.ts — Bot 啟動 + State 恢復
 */

import { TelegramBotService, VALID_INTERVALS, IntervalMinutes } from '../bot/TelegramBot';
import { createServiceLogger } from './logger';
import { loadState, restoreState } from './stateManager';
import { appState } from './AppState';
import { config } from '../config';
import type { DiagnosticStore } from './diagnosticStore';

const log = createServiceLogger('Startup');

export async function runStartup(
    botService: TelegramBotService,
    diagnosticStore: DiagnosticStore,
): Promise<{ currentIntervalMinutes: number }> {
    let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;

    botService.registerDiagnostics(diagnosticStore);
    botService.startBot().catch(e => log.fatal('Bot start error', e));

    const saved = await loadState();
    if (saved) {
        restoreState(saved);
        if (saved.userConfig) {
            appState.userConfig = saved.userConfig;
            if (saved.userConfig.intervalMinutes && VALID_INTERVALS.includes(saved.userConfig.intervalMinutes as IntervalMinutes))
                currentIntervalMinutes = saved.userConfig.intervalMinutes;
        }
        log.info('✅ state restored');
    }

    return { currentIntervalMinutes };
}
