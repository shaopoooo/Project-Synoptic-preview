/**
 * startup.ts — 啟動流程（Bot 初始化、State 恢復、Position 同步）
 *
 * 從 index.ts 抽出，僅含啟動階段的一次性邏輯。
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

type AlertFn = (key: string, msg: string) => Promise<void>;

function triggerStateSave() {
    return saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), appState.userConfig, appState.stakeDiscoveryLastBlock);
}

/** 初始化 Bot 回呼、State 恢復、Position 同步、初始掃描。回傳 { reschedule, triggerStateSave }。 */
export async function runStartup(
    botService: TelegramBotService,
    diagnosticStore: DiagnosticStore,
    sendCriticalAlert: AlertFn,
): Promise<{ currentIntervalMinutes: number; triggerStateSave: () => Promise<void> }> {
    let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;

    // ── 1. Bot 初始化 ────────────────────────────────────────────────────────
    botService.setPositionScanner(positionScanner);
    botService.setRescheduleCallback((minutes: number) => {
        // reschedule 由 index.ts 覆寫
    });
    botService.setUserConfigChangeCallback(async (cfg) => {
        const prevWalletSet = new Set(ucWalletAddresses(appState.userConfig).map(w => w.toLowerCase()));
        const prevTrackedIds = new Set(ucTrackedPositions(appState.userConfig).map(t => t.tokenId));
        const addedWallets = ucWalletAddresses(cfg).filter(w => !prevWalletSet.has(w.toLowerCase()));
        const addedTracked = ucTrackedPositions(cfg).filter(t => !prevTrackedIds.has(t.tokenId));

        appState.userConfig = cfg;
        if (cfg.marketKLowVol  !== undefined) appState.marketKLowVol  = cfg.marketKLowVol;
        if (cfg.marketKHighVol !== undefined) appState.marketKHighVol = cfg.marketKHighVol;
        await saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), cfg, appState.stakeDiscoveryLastBlock);
        const wallets = ucWalletAddresses(cfg);
        const tracked = ucTrackedPositions(cfg);
        const investments = cfg.wallets.reduce((s, w) => s + w.positions.filter(p => p.initial > 0).length, 0);
        log.info(`💾 userConfig updated & saved — wallets: ${wallets.length}, investments: ${investments}, tracked: ${tracked.length}`);

        if (addedWallets.length > 0 || addedTracked.length > 0) {
            const reason = addedWallets.length > 0
                ? `新錢包: ${addedWallets.join(', ')}`
                : `新追蹤倉位: ${addedTracked.map(t => `#${t.tokenId}`).join(', ')}`;
            log.info(`🔍 ${reason}，背景觸發 chain scan`);
            positionScanner.syncFromChain(true)
                .then(() => saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), appState.userConfig))
                .catch(e => log.error(`Auto sync (new tracked)`, e));
        }
    });
    botService.registerDiagnostics(diagnosticStore);
    botService.startBot().catch((e) => log.fatal(`Bot start error`, e));

    // ── 2. State restore ─────────────────────────────────────────────────────
    const savedState = await loadState();
    if (savedState) {
        restoreState(savedState);
        restorePriceBuffer(savedState.priceHistory ?? {});
        bandwidthTracker.restore(savedState.rpcBandwidthWindows ?? {});
        appState.stakeDiscoveryLastBlock = savedState.stakeDiscoveryLastBlock ?? {};
        log.info('✅ state restored from previous session');
    }

    if (savedState?.userConfig) {
        appState.userConfig = savedState.userConfig;
        const uc = appState.userConfig;
        if (uc.intervalMinutes && VALID_INTERVALS.includes(uc.intervalMinutes as IntervalMinutes))
            currentIntervalMinutes = uc.intervalMinutes;
        if (uc.marketKLowVol  !== undefined) appState.marketKLowVol  = uc.marketKLowVol;
        if (uc.marketKHighVol !== undefined) appState.marketKHighVol = uc.marketKHighVol;
        const wallets = ucWalletAddresses(uc);
        const totalPositions = uc.wallets.reduce((s, w) => s + w.positions.length, 0);
        log.info(`✅ userConfig restored — wallets: ${wallets.length}, positions: ${totalPositions}`);
    } else if (savedState) {
        log.info(`userConfig not in state — using .env seed (wallets: ${ucWalletAddresses(appState.userConfig).length})`);
    }

    appState.userConfig = {
        sortBy: 'size',
        intervalMinutes: currentIntervalMinutes,
        flashIntervalMinutes: config.DEFAULT_FLASH_INTERVAL_MINUTES,
        fullReportIntervalMinutes: config.DEFAULT_FULL_REPORT_INTERVAL_MINUTES,
        marketKLowVol: appState.marketKLowVol,
        marketKHighVol: appState.marketKHighVol,
        ...appState.userConfig,
    };

    // ── 3. Position restore / chain sync ────────────────────────────────────
    const hasWallets = ucWalletAddresses(appState.userConfig).length > 0;

    if (!hasWallets) {
        log.warn('No wallet addresses configured — skipping position restore.');
    } else {
        positionScanner.restoreFromUserConfig();
        const allKnownIds = new Set(
            appState.userConfig.wallets.flatMap(w => w.positions.map(p => p.tokenId))
        );
        const savedWalletAddresses = savedState?.userConfig
            ? ucWalletAddresses(savedState.userConfig)
            : (savedState?.syncedWallets ?? []);
        const currentWallets = ucWalletAddresses(appState.userConfig);
        const walletsUnchanged = savedWalletAddresses.length === currentWallets.length &&
            savedWalletAddresses.every(w => currentWallets.includes(w));
        const hasNewTracked = ucTrackedPositions(appState.userConfig).some(
            tp => !allKnownIds.has(tp.tokenId)
        );

        if (walletsUnchanged && allKnownIds.size > 0 && !hasNewTracked) {
            positionScanner.restoreDiscoveredPositions();
        } else {
            if (hasNewTracked) log.info('New tracked positions detected — forcing chain sync');
            await positionScanner.syncFromChain(true);
        }
    }

    // ── 4. 初始掃描（非 FAST_STARTUP 才執行）────────────────────────────────
    if (!config.FAST_STARTUP) {
        const data = await prefetchAll(sendCriticalAlert);
        if (data) {
            if (savedState) {
                for (const pool of data.pools) refreshPriceBuffer(pool.id, pool.tick);
                log.info(`✅ PriceBuffer refreshed for ${data.pools.length} pool(s) after restore`);
            }
            const result = computeAll(data);
            positionScanner.updatePositions(result.positions);
            appState.commit(data, { positions: positionScanner.getTrackedPositions() });
        }
    }

    await triggerStateSave();
    return { currentIntervalMinutes, triggerStateSave };
}
