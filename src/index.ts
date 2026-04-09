/**
 * index.ts — DexBot 主入口
 *
 * 職責：排程管理、cycle 執行 + 診斷收集、graceful shutdown。
 * 啟動流程（Bot / State / Position）委託給 runners/startup.ts。
 */

import cron from 'node-cron';
import * as path from 'path';
import { TelegramBotService, minutesToCron, VALID_INTERVALS } from './bot/TelegramBot';
import { positionScanner } from './services/position/PositionScanner';
import { createServiceLogger } from './utils/logger';
import { appState } from './utils/AppState';
import { config, validateEnv } from './config';
import { LRUCache } from 'lru-cache';
import { prefetchAll } from './runners/prefetch';
import { computeAll } from './runners/compute';
import { runBotService } from './runners/reporting';
import { runBackgroundTasks } from './runners/backgroundTasks';
import { runMCEngine } from './runners/mcEngine';
import { DiagnosticStore } from './utils/diagnosticStore';
import { runStartup } from './runners/startup';
import type { CycleDiagnostic } from './types';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();

// ── 全域狀態 ──────────────────────────────────────────────────────────────────

let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let isCycleRunning = false;
let isBackgroundTaskRunning = false;
let isMCEngineRunning = false;
let isStartupComplete = false;
let cycleCount = 0;
let triggerStateSave: () => Promise<void>;

const diagnosticStore = new DiagnosticStore(
    path.join(process.cwd(), 'data', 'diagnostics.jsonl'),
    48,
);

const alertCooldowns = new LRUCache<string, number>({ max: 50 });
async function sendCriticalAlert(key: string, message: string) {
    const last = alertCooldowns.get(key) ?? 0;
    if (Date.now() - last < config.CRITICAL_ALERT_COOLDOWN_MS) return;
    alertCooldowns.set(key, Date.now());
    await botService.sendAlert(`🚨 <b>DexBot 告警</b>\n${message}`).catch(() => { });
}

// ── 主週期 ───────────────────────────────────────────────────────────────────

async function runCycle(): Promise<CycleDiagnostic | null> {
    const t0 = Date.now();

    const tPrefetch = Date.now();
    const data = await prefetchAll(sendCriticalAlert);
    const prefetchMs = Date.now() - tPrefetch;
    if (!data) return null;

    const tCompute = Date.now();
    const result = computeAll(data);
    positionScanner.updatePositions(result.positions);
    appState.commit(data, { positions: positionScanner.getTrackedPositions() });
    const computeMs = Date.now() - tCompute;

    const tMC = Date.now();
    let mcDiagnostic: import('./types').MCEngineDiagnostic | null = null;
    if (!isMCEngineRunning) {
        isMCEngineRunning = true;
        try {
            mcDiagnostic = await runMCEngine(
                data.historicalReturns,
                botService.sendAlert.bind(botService),
                appState.activeGenome ?? undefined,
            );
        } catch (e) {
            log.error('MCEngine', e);
        } finally {
            isMCEngineRunning = false;
        }
    }
    const mcEngineMs = Date.now() - tMC;

    await runBotService(botService, isStartupComplete).catch((e) => log.error('BotService', e));
    await triggerStateSave().catch((e) => log.error('State save', e));

    const bbForLog = appState.positions[0]
        ? (appState.marketSnapshots[appState.positions[0].poolAddress.toLowerCase()] ?? null)
        : null;
    await positionScanner.logSnapshots(appState.positions, bbForLog, appState.marketKLowVol, appState.marketKHighVol)
        .catch((e) => log.error('LogSnapshots', e));

    return {
        cycleNumber: ++cycleCount,
        timestamp: t0,
        durationMs: Date.now() - t0,
        phase: { prefetchMs, computeMs, mcEngineMs },
        pools: mcDiagnostic?.poolResults ?? [],
        activeGenomeId: appState.activeGenome?.id ?? null,
        summary: mcDiagnostic?.summary ?? {
            totalPools: 0, goPools: 0, oldVersionSkipCount: 0, newVersionRecoveredCount: 0,
        },
    };
}

// ── 排程 ─────────────────────────────────────────────────────────────────────

function scheduleBackgroundTasks(label: string) {
    if (isBackgroundTaskRunning || isCycleRunning) return;
    isBackgroundTaskRunning = true;
    runBackgroundTasks(triggerStateSave)
        .catch((e) => log.error(`BackgroundTasks (${label})`, e))
        .finally(() => { isBackgroundTaskRunning = false; });
}

function buildCronJob() {
    return cron.schedule(minutesToCron(currentIntervalMinutes), async () => {
        if (isCycleRunning) return;
        isCycleRunning = true;
        try {
            log.section(`${currentIntervalMinutes}m cycle`);
            const diag = await runCycle();
            if (diag) {
                await diagnosticStore.append(diag);
                log.info(`Cycle #${diag.cycleNumber} — ${diag.durationMs}ms (P0:${diag.phase.prefetchMs} C:${diag.phase.computeMs} MC:${diag.phase.mcEngineMs})`);
            }
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
    log.info(`🔄 排程已更新為每 ${minutes} 分鐘`);
}

// ── 啟動 ──────────────────────────────────────────────────────────────────────

async function main() {
    validateEnv();
    log.section('DexInfoBot startup');

    const startup = await runStartup(botService, diagnosticStore, sendCriticalAlert);
    currentIntervalMinutes = startup.currentIntervalMinutes;
    triggerStateSave = startup.triggerStateSave;
    botService.setRescheduleCallback(reschedule);

    isStartupComplete = true;
    log.info(`startup complete — interval: ${currentIntervalMinutes}m`);
    log.section('ready');

    scheduledTask = buildCronJob();

    if (config.FAST_STARTUP) {
        log.info('⚡ FAST_STARTUP — first cycle in 5s');
        setTimeout(() => {
            if (isCycleRunning) return;
            isCycleRunning = true;
            runCycle()
                .then(async (diag) => { if (diag) await diagnosticStore.append(diag); })
                .catch((e) => log.error('FastStartup', e))
                .finally(() => { isCycleRunning = false; scheduleBackgroundTasks('fast'); });
        }, 5000);
    }

    scheduleBackgroundTasks('startup');
}

// ── 關閉 ──────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info(`${signal} — saving state`);
    try { await triggerStateSave(); } catch (e) { log.fatal('shutdown save failed', e); }
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { diagnosticStore };

main().catch((e) => log.fatal('Main error', e));
