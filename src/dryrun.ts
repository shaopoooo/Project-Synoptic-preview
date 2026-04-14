/**
 * dryrun.ts — 單次 prefetch + MC engine 執行（無 Telegram、無 cron）
 *
 * Usage: npm run dryrun
 */
import { prefetchAll } from './market/prefetch';
import { runMCEngine } from './engine/lp/mcEngine';
import { appState } from './infra/AppState';
import { createServiceLogger } from './infra/logger';

const log = createServiceLogger('Dryrun');

async function main() {
    log.section('DexBot dryrun — single-pass (no Telegram, no cron)');

    const data = await prefetchAll();
    if (!data) {
        log.error('prefetchAll failed — aborting');
        process.exit(1);
    }

    appState.commit(data);

    const diag = await runMCEngine(data.historicalReturns);
    log.info(`MC Engine: ${diag.summary.goPools}/${diag.summary.totalPools} pools go`);

    for (const p of diag.poolResults) {
        const vec = p.regimeVector
            ? `R=${p.regimeVector.range.toFixed(2)} T=${p.regimeVector.trend.toFixed(2)} N=${p.regimeVector.neutral.toFixed(2)}`
            : `signal=${p.hardSignal}`;
        log.info(
            `[${p.dex}] ${p.pool} | ${vec}\n` +
            `  σ=${p.sigmaOpt?.toFixed(2) ?? '-'} score=${p.score?.toFixed(3) ?? '-'} CVaR=${p.cvar95 != null ? (p.cvar95 * 100).toFixed(2) + '%' : '-'} ${p.go ? '✅' : '🚫'}`
        );
    }

    log.section('dryrun complete');
}

main().catch(e => { console.error('Dryrun failed:', e); process.exit(1); });
