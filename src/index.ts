import cron from 'node-cron';
import { TelegramBotService, minutesToCron, VALID_INTERVALS, IntervalMinutes } from './bot/TelegramBot';
import { positionScanner } from './services/PositionScanner';
import { getPriceBufferSnapshot, restorePriceBuffer, refreshPriceBuffer } from './services/BBEngine';
import { createServiceLogger } from './utils/logger';
import { loadState, saveState, restoreState } from './utils/stateManager';
import { bandwidthTracker } from './utils/BandwidthTracker';
import { appState, ucWalletAddresses, ucTrackedPositions, ucPoolList } from './utils/AppState';
import { config, validateEnv } from './config';
import { LRUCache } from 'lru-cache';
import { prefetchAll } from './runners/prefetch';
import { computeAll } from './runners/compute';
import { runBotService } from './runners/reporting';
import { runBackgroundTasks } from './runners/backgroundTasks';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();

// ── 全域狀態 ──────────────────────────────────────────────────────────────────

let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

let isCycleRunning = false;
let isBackgroundTaskRunning = false;
let isStartupComplete = false;

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function triggerStateSave() {
    return saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), appState.userConfig, appState.stakeDiscoveryLastBlock);
}

// 嚴重錯誤告警（每類每 30 分鐘至多一次，避免洗版）
const alertCooldowns = new LRUCache<string, number>({ max: 50 });
async function sendCriticalAlert(key: string, message: string) {
    const last = alertCooldowns.get(key) ?? 0;
    if (Date.now() - last < config.CRITICAL_ALERT_COOLDOWN_MS) return;
    alertCooldowns.set(key, Date.now());
    await botService.sendAlert(`🚨 <b>DexBot 告警</b>\n${message}`).catch(() => { });
}

// ── 主週期（cron 與 FAST_STARTUP 共用）───────────────────────────────────────
// 順序：TokenPrice → Pool → BB → Position → Risk → Bot → save
// 注意：BB 在 Position 之前，因為穩態下 appState.positions 已有前一輪資料可決定要算哪些池。
// 首次啟動（無倉位）由 main() 的初始掃描路徑處理，不走此函式。

async function runCycle() {
    const data = await prefetchAll(sendCriticalAlert);
    if (!data) return;

    const result = computeAll(data);
    positionScanner.updatePositions(result.positions);
    appState.commit(data, { positions: positionScanner.getTrackedPositions() });

    await runBotService(botService, isStartupComplete).catch((e) => log.error(`BotService: ${e}`));
    await triggerStateSave().catch((e) => log.error(`State save: ${e}`));

    // 記錄 snapshot 至 positions.log
    const bbForLog = appState.positions[0]
        ? (appState.bbs[appState.positions[0].poolAddress.toLowerCase()] ?? null)
        : null;
    await positionScanner.logSnapshots(appState.positions, bbForLog, appState.bbKLowVol, appState.bbKHighVol)
        .catch((e) => log.error(`LogSnapshots: ${e}`));
}

// ── 低優先級背景任務（由呼叫方在主週期完成後觸發，runCycle 本身不觸發）──────

function scheduleBackgroundTasks(label: string) {
    if (isBackgroundTaskRunning) return;
    if (isCycleRunning) {
        log.info('BackgroundTasks: 主週期執行中，延後至下次觸發');
        return;
    }
    isBackgroundTaskRunning = true;
    runBackgroundTasks(triggerStateSave)
        .catch((e) => log.error(`BackgroundTasks (${label}): ${e}`))
        .finally(() => { isBackgroundTaskRunning = false; });
}

// ── 排程管理 ──────────────────────────────────────────────────────────────────

function buildCronJob() {
    return cron.schedule(minutesToCron(currentIntervalMinutes), async () => {
        if (isCycleRunning) {
            log.warn(`⚠️  上一個週期尚未完成，跳過本次觸發（排程重疊保護）`);
            return;
        }
        isCycleRunning = true;
        try {
            log.section(`${currentIntervalMinutes}m cycle`);
            await runCycle();
            log.section('cycle end');
        } finally {
            isCycleRunning = false;
        }
        scheduleBackgroundTasks('cycle');
    });
}

function reschedule(minutes: number) {
    if (!VALID_INTERVALS.includes(minutes as typeof VALID_INTERVALS[number])) return;
    scheduledTask?.stop();
    currentIntervalMinutes = minutes;
    scheduledTask = buildCronJob();
    log.info(`🔄 排程已更新為每 ${minutes} 分鐘 (cron: ${minutesToCron(minutes)})`);
}

// ── 啟動 ──────────────────────────────────────────────────────────────────────

async function main() {
    validateEnv();
    log.section('DexInfoBot startup');

    // ── 1. Bot 初始化 ────────────────────────────────────────────────────────
    botService.setPositionScanner(positionScanner);
    botService.setRescheduleCallback(reschedule);
    botService.setUserConfigChangeCallback(async (cfg) => {
        // 在更新前記錄舊錢包清單與已追蹤的 tokenId，用來偵測新增項目
        const prevWalletSet = new Set(ucWalletAddresses(appState.userConfig).map(w => w.toLowerCase()));
        const prevTrackedIds = new Set(ucTrackedPositions(appState.userConfig).map(t => t.tokenId));
        const addedWallets = ucWalletAddresses(cfg).filter(w => !prevWalletSet.has(w.toLowerCase()));
        const addedTracked = ucTrackedPositions(cfg).filter(t => !prevTrackedIds.has(t.tokenId));

        appState.userConfig = cfg;
        // bbKLowVol / bbKHighVol 在 userConfig 更新後同步到 appState runtime 欄位（BBEngine 使用）
        if (cfg.bbKLowVol  !== undefined) appState.bbKLowVol  = cfg.bbKLowVol;
        if (cfg.bbKHighVol !== undefined) appState.bbKHighVol = cfg.bbKHighVol;
        await saveState(
            getPriceBufferSnapshot(),
            bandwidthTracker.snapshot(),
            cfg,
            appState.stakeDiscoveryLastBlock,
        );
        const wallets = ucWalletAddresses(cfg);
        const tracked = ucTrackedPositions(cfg);
        const investments = cfg.wallets.reduce((s, w) => s + w.positions.filter(p => p.initial > 0).length, 0);
        log.info(`💾 userConfig updated & saved — wallets: ${wallets.length}, investments: ${investments}, tracked: ${tracked.length}`);

        // 有新增錢包或新增 externalStake 倉位 → 背景觸發 chain scan
        if (addedWallets.length > 0 || addedTracked.length > 0) {
            const reason = addedWallets.length > 0
                ? `新錢包: ${addedWallets.join(', ')}`
                : `新追蹤倉位: ${addedTracked.map(t => `#${t.tokenId}`).join(', ')}`;
            log.info(`🔍 ${reason}，背景觸發 chain scan`);
            positionScanner.syncFromChain(true)
                .then(() => saveState(getPriceBufferSnapshot(), bandwidthTracker.snapshot(), appState.userConfig))
                .catch(e => log.error(`Auto sync (new tracked): ${e}`));
        }
    });
    botService.startBot().catch((e) => log.error(`Bot start error: ${e}`));

    // ── 2. State restore ─────────────────────────────────────────────────────
    const savedState = await loadState();
    if (savedState) {
        restoreState(savedState);
        restorePriceBuffer(savedState.priceBuffer ?? {});
        bandwidthTracker.restore(savedState.bandwidthWindows ?? {});
        appState.stakeDiscoveryLastBlock = savedState.stakeDiscoveryLastBlock ?? {};
        log.info('✅ state restored from previous session');
    }

    if (savedState?.userConfig) {
        appState.userConfig = savedState.userConfig;
        const uc = appState.userConfig;
        if (uc.intervalMinutes && VALID_INTERVALS.includes(uc.intervalMinutes as IntervalMinutes))
            currentIntervalMinutes = uc.intervalMinutes;
        if (uc.bbKLowVol  !== undefined) appState.bbKLowVol  = uc.bbKLowVol;
        if (uc.bbKHighVol !== undefined) appState.bbKHighVol = uc.bbKHighVol;
        const wallets = ucWalletAddresses(uc);
        const totalPositions = uc.wallets.reduce((s, w) => s + w.positions.length, 0);
        log.info(`✅ userConfig restored — wallets: ${wallets.length}, positions: ${totalPositions}`);
    } else if (savedState) {
        log.info(`userConfig not in state — using .env seed (wallets: ${ucWalletAddresses(appState.userConfig).length})`);
    }

    // 確保 runtime 預設值反映在 userConfig，讓下次儲存時包含完整欄位
    appState.userConfig = {
        sortBy: 'size',
        intervalMinutes: currentIntervalMinutes,
        flashIntervalMinutes: config.DEFAULT_FLASH_INTERVAL_MINUTES,
        fullReportIntervalMinutes: config.DEFAULT_FULL_REPORT_INTERVAL_MINUTES,
        bbKLowVol: appState.bbKLowVol,
        bbKHighVol: appState.bbKHighVol,
        ...appState.userConfig,
    };

    // ── 3. Position restore / chain sync ────────────────────────────────────
    const hasWallets = ucWalletAddresses(appState.userConfig).length > 0;

    if (!hasWallets) {
        log.warn('No wallet addresses configured — skipping startup scan. Use /wallet add in Telegram to add a wallet.');
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
    if (!config.FAST_STARTUP && hasWallets) {
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

    // ── 5. 啟動完成，建立排程 ────────────────────────────────────────────────
    isStartupComplete = true;
    await triggerStateSave();
    log.info(`startup complete — scheduler enabled (interval: ${currentIntervalMinutes}m)`);
    log.section('ready');

    scheduledTask = buildCronJob();

    // FAST_STARTUP: 5 秒後立即觸發第一輪完整週期，不等到下一個整點
    if (config.FAST_STARTUP) {
        log.info('⚡ FAST_STARTUP=true — skipping initial scan, first cron cycle fires in 5s');
        setTimeout(() => {
            log.info('⚡ FAST_STARTUP: triggering first cycle now');
            if (isCycleRunning) {
                log.warn('⚡ FAST_STARTUP: cycle already running, skipping');
                return;
            }
            isCycleRunning = true;
            Promise.resolve()
                .then(runCycle)
                .catch((e) => log.error(`FastStartup cycle: ${e}`))
                .finally(() => {
                    isCycleRunning = false;
                    scheduleBackgroundTasks('fast');
                });
        }, 5000);
    }

    scheduleBackgroundTasks('startup');
}

// ── 關閉處理 ──────────────────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info(`${signal} received — saving state before exit`);
    try {
        await triggerStateSave();
        log.info('✅ state saved — exiting');
    } catch (e) {
        log.error(`graceful shutdown save failed: ${e}`);
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main().catch((e) => log.error(`Main error: ${e}`));
