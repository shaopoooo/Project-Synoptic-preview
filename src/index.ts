/**
 * index.ts — DexBot 主入口
 *
 * 啟動 → 排程 cycle（prefetch → MC engine）→ 收集診斷
 */

import cron from 'node-cron';
import * as path from 'path';
import { TelegramBotService, minutesToCron, VALID_INTERVALS } from './bot/TelegramBot';
import { createServiceLogger } from './utils/logger';
import { appState } from './utils/AppState';
import { config, validateEnv } from './config';
import { prefetchAll } from './runners/prefetch';
import { runMCEngine } from './runners/mcEngine';
import { DiagnosticStore } from './utils/diagnosticStore';
import { runStartup } from './runners/startup';
import type { CycleDiagnostic, MCEngineDiagnostic } from './types';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();
const diagnosticStore = new DiagnosticStore(path.join(process.cwd(), 'data', 'diagnostics.jsonl'), 48);

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;
let isCycleRunning = false;
let cycleCount = 0;

// ── Cycle ────────────────────────────────────────────────────────────────────

async function runCycle(): Promise<CycleDiagnostic | null> {
    const t0 = Date.now();

    const tP = Date.now();
    const data = await prefetchAll();
    const prefetchMs = Date.now() - tP;
    if (!data) return null;

    appState.commit(data);

    const tMC = Date.now();
    let mc: MCEngineDiagnostic | null = null;
    try {
        mc = await runMCEngine(
            data.historicalReturns,
            botService.sendAlert.bind(botService),
            appState.activeGenome ?? undefined,
        );
    } catch (e) { log.error('MCEngine', e); }
    const mcEngineMs = Date.now() - tMC;

    return {
        cycleNumber: ++cycleCount,
        timestamp: t0,
        durationMs: Date.now() - t0,
        phase: { prefetchMs, computeMs: 0, mcEngineMs },
        pools: mc?.poolResults ?? [],
        activeGenomeId: appState.activeGenome?.id ?? null,
        summary: mc?.summary ?? { totalPools: 0, goPools: 0, oldVersionSkipCount: 0, newVersionRecoveredCount: 0 },
    };
}

// ── 排程 ─────────────────────────────────────────────────────────────────────

function buildCronJob() {
    return cron.schedule(minutesToCron(currentIntervalMinutes), async () => {
        if (isCycleRunning) return;
        isCycleRunning = true;
        try {
            const diag = await runCycle();
            if (diag) {
                await diagnosticStore.append(diag);
                log.info(`Cycle #${diag.cycleNumber} — ${diag.durationMs}ms (P0:${diag.phase.prefetchMs} MC:${diag.phase.mcEngineMs})`);
            }
        } finally { isCycleRunning = false; }
    });
}

function reschedule(minutes: number) {
    if (!VALID_INTERVALS.includes(minutes as typeof VALID_INTERVALS[number])) return;
    scheduledTask?.stop();
    currentIntervalMinutes = minutes;
    scheduledTask = buildCronJob();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    validateEnv();
    log.section('Bot startup');

    const startup = await runStartup(botService, diagnosticStore);
    currentIntervalMinutes = startup.currentIntervalMinutes;
    botService.setRescheduleCallback(reschedule);

    log.section('ready');
    scheduledTask = buildCronJob();

    if (config.FAST_STARTUP) {
        setTimeout(() => {
            if (isCycleRunning) return;
            isCycleRunning = true;
            runCycle()
                .then(async d => { if (d) await diagnosticStore.append(d); })
                .catch(e => log.error('FastStartup', e))
                .finally(() => { isCycleRunning = false; });
        }, 5000);
    }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

let stopping = false;
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
async function shutdown(sig: string) {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} — exit`);
    process.exit(0);
}

export { diagnosticStore };
main().catch(e => log.fatal('Main', e));
