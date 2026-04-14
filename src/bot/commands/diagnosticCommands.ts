import type { Bot } from 'grammy';
import type { DiagnosticStore } from '../../infra/diagnosticStore';
import type { CycleDiagnostic } from '../../types';

function formatDiagnostic(diag: CycleDiagnostic): string {
    const lines = [
        `📊 <b>Cycle #${diag.cycleNumber}</b> — ${new Date(diag.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
        `⏱ ${diag.durationMs}ms (P0:${diag.phase.prefetchMs} C:${diag.phase.computeMs} MC:${diag.phase.mcEngineMs})`,
        ``,
    ];

    for (const p of diag.pools) {
        const vec = p.regimeVector
            ? `R=${p.regimeVector.range.toFixed(2)} T=${p.regimeVector.trend.toFixed(2)} N=${p.regimeVector.neutral.toFixed(2)}`
            : `signal=${p.hardSignal}`;
        const skipTag = p.wouldSkipInOldVersion ? (p.go ? ' 🔄rescued' : ' ❌skip') : '';
        const goTag = p.go ? '✅' : '🚫';
        lines.push(
            `<b>${p.dex}</b> ${p.pool}`,
            `  ${vec}${skipTag}`,
            `  σ=${p.sigmaOpt?.toFixed(2) ?? '-'} score=${p.score?.toFixed(3) ?? '-'} CVaR=${p.cvar95 != null ? (p.cvar95 * 100).toFixed(2) + '%' : '-'} ${goTag}`,
        );
    }

    lines.push('');
    const s = diag.summary;
    lines.push(`📈 Go: ${s.goPools}/${s.totalPools} | 舊版 skip: ${s.oldVersionSkipCount} | 新版救回: ${s.newVersionRecoveredCount}`);

    return lines.join('\n');
}

function formatBenchmark(stats: ReturnType<DiagnosticStore['getBenchmarkStats']>): string {
    const fmt = (ms: number) => (ms / 1000).toFixed(1) + 's';
    return [
        `⏱ <b>Benchmark</b> — 最近 ${stats.count} 個 cycles`,
        ``,
        `<pre>`,
        `           avg    p95    max`,
        `Prefetch   ${fmt(stats.prefetch.avg).padStart(5)}  ${fmt(stats.prefetch.p95).padStart(5)}  ${fmt(stats.prefetch.max).padStart(5)}`,
        `Compute    ${fmt(stats.compute.avg).padStart(5)}  ${fmt(stats.compute.p95).padStart(5)}  ${fmt(stats.compute.max).padStart(5)}`,
        `MCEngine   ${fmt(stats.mcEngine.avg).padStart(5)}  ${fmt(stats.mcEngine.p95).padStart(5)}  ${fmt(stats.mcEngine.max).padStart(5)}`,
        `Total      ${fmt(stats.total.avg).padStart(5)}  ${fmt(stats.total.p95).padStart(5)}  ${fmt(stats.total.max).padStart(5)}`,
        `</pre>`,
        ``,
        `Go rate: ${(stats.goRate * 100).toFixed(0)}% | Recovered: ${stats.avgRecovered.toFixed(1)}/cycle`,
    ].join('\n');
}

export function registerDiagnosticCommands(bot: Bot, diagnosticStore: DiagnosticStore): void {
    bot.command('diagnostic', async (ctx) => {
        const arg = ctx.match?.trim() ?? '';

        if (arg === 'on' || arg === 'off') {
            await ctx.reply(`✅ Diagnostic 自動推播已${arg === 'on' ? '開啟' : '關閉'}`);
            return;
        }

        const n = parseInt(arg, 10);
        if (!isNaN(n) && n > 0) {
            const recent = diagnosticStore.getRecent(n);
            if (recent.length === 0) {
                await ctx.reply('尚無診斷數據。');
                return;
            }
            const summaries = recent.map(d =>
                `#${d.cycleNumber} ${(d.durationMs / 1000).toFixed(1)}s Go:${d.summary.goPools}/${d.summary.totalPools}`
            );
            await ctx.reply(`📊 最近 ${recent.length} 個 cycles:\n` + summaries.join('\n'), { parse_mode: 'HTML' });
            return;
        }

        const latest = diagnosticStore.getRecent(1);
        if (latest.length === 0) {
            await ctx.reply('尚無診斷數據，等待第一個 cycle 完成。');
            return;
        }
        await ctx.reply(formatDiagnostic(latest[0]), { parse_mode: 'HTML' });
    });

    bot.command('benchmark', async (ctx) => {
        const stats = diagnosticStore.getBenchmarkStats();
        if (stats.count === 0) {
            await ctx.reply('尚無 benchmark 數據。');
            return;
        }
        await ctx.reply(formatBenchmark(stats), { parse_mode: 'HTML' });
    });
}
