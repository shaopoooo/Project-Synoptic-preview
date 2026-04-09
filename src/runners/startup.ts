/**
 * startup.ts — 啟動流程：Bot → State → Position → 初始掃描
 */

import { TelegramBotService, VALID_INTERVALS, IntervalMinutes } from '../bot/TelegramBot';
import { positionScanner } from '../services/position/PositionScanner';
import { getPriceBufferSnapshot, restorePriceBuffer, refreshPriceBuffer } from '../services/market/PoolMarketService';
import { createServiceLogger } from '../utils/logger';
import { loadState, saveState, restoreState } from '../utils/stateManager';
import { bandwidthTracker } from '../utils/BandwidthTracker';
import { appState, ucWalletAddresses, ucTrackedPositions } from '../utils/AppState';
import { config } from '../config';
import { prefetchAll } from './prefetch';
import { computeAll } from './compute';
import type { DiagnosticStore } from '../utils/diagnosticStore';

const log = createServiceLogger('Startup');

function triggerStateSave() {
    return saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), appState.userConfig, appState.stakeDiscoveryLastBlock);
}

export async function runStartup(
    botService: TelegramBotService,
    diagnosticStore: DiagnosticStore,
    sendCriticalAlert: (key: string, msg: string) => Promise<void>,
): Promise<{ currentIntervalMinutes: number; triggerStateSave: () => Promise<void> }> {
    let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;

    // ── Bot ──────────────────────────────────────────────────────────────────
    botService.setPositionScanner(positionScanner);
    botService.setUserConfigChangeCallback(async (cfg) => {
        appState.userConfig = cfg;
        if (cfg.marketKLowVol  !== undefined) appState.marketKLowVol  = cfg.marketKLowVol;
        if (cfg.marketKHighVol !== undefined) appState.marketKHighVol = cfg.marketKHighVol;
        await triggerStateSave();
    });
    botService.registerDiagnostics(diagnosticStore);
    botService.startBot().catch(e => log.fatal('Bot start error', e));

    // ── State restore ────────────────────────────────────────────────────────
    const saved = await loadState();
    if (saved) {
        restoreState(saved);
        restorePriceBuffer(saved.priceHistory ?? {});
        bandwidthTracker.restore(saved.rpcBandwidthWindows ?? {});
        appState.stakeDiscoveryLastBlock = saved.stakeDiscoveryLastBlock ?? {};
        if (saved.userConfig) {
            appState.userConfig = saved.userConfig;
            const uc = saved.userConfig;
            if (uc.intervalMinutes && VALID_INTERVALS.includes(uc.intervalMinutes as IntervalMinutes))
                currentIntervalMinutes = uc.intervalMinutes;
            if (uc.marketKLowVol  !== undefined) appState.marketKLowVol  = uc.marketKLowVol;
            if (uc.marketKHighVol !== undefined) appState.marketKHighVol = uc.marketKHighVol;
        }
        log.info('✅ state restored');
    }

    // ── Position restore ─────────────────────────────────────────────────────
    if (ucWalletAddresses(appState.userConfig).length > 0) {
        positionScanner.restoreFromUserConfig();
        positionScanner.restoreDiscoveredPositions();
    }

    // ── 初始掃描（非 FAST_STARTUP）──────────────────────────────────────────
    if (!config.FAST_STARTUP) {
        const data = await prefetchAll(sendCriticalAlert);
        if (data) {
            if (saved) for (const pool of data.pools) refreshPriceBuffer(pool.id, pool.tick);
            const result = computeAll(data);
            positionScanner.updatePositions(result.positions);
            appState.commit(data, { positions: positionScanner.getTrackedPositions() });
        }
    }

    await triggerStateSave();
    return { currentIntervalMinutes, triggerStateSave };
}
