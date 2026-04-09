import type { Bot } from 'grammy';
import { appState } from '../../utils/AppState';
import { currentConstantsToGenome } from '../../services/strategy/ParameterGenome';
import type { RegimeGenome } from '../../types';

/** Population cache — set by evolution engine, read by commands */
let populationCache: Array<{ genome: RegimeGenome; fitness: number }> = [];

export function setPopulationCache(pop: Array<{ genome: RegimeGenome; fitness: number }>) {
    populationCache = pop;
}

export function getPopulationCache(): Array<{ genome: RegimeGenome; fitness: number }> {
    return populationCache;
}

function formatGenomeParams(g: RegimeGenome, baseline?: RegimeGenome): string {
    const keys: Array<keyof Omit<RegimeGenome, 'id'>> = [
        'chopRangeThreshold', 'chopTrendThreshold', 'chopWindow',
        'hurstRangeThreshold', 'hurstTrendThreshold', 'hurstMaxLag',
        'sigmoidTemp', 'atrWindow', 'cvarSafetyFactor',
    ];
    const lines: string[] = [];
    for (const k of keys) {
        const val = g[k] as number;
        const base = baseline ? baseline[k] as number : null;
        let arrow = '';
        if (base != null) {
            arrow = val > base + 0.001 ? '▲' : val < base - 0.001 ? '▼' : '=';
        }
        const valStr = val < 1 ? val.toFixed(2) : val.toFixed(1);
        const baseStr = base != null ? ` (base ${base < 1 ? base.toFixed(2) : base.toFixed(1)})` : '';
        lines.push(`  ${k}=${valStr} ${arrow}${baseStr}`);
    }
    return lines.join('\n');
}

export function registerRegimeCommands(bot: Bot): void {
    bot.command('regime', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/);
        const sub = parts[0]?.toLowerCase() ?? '';

        if (sub === 'status') {
            const genome = appState.activeGenome ?? currentConstantsToGenome();
            const poolCount = Object.keys(appState.strategies).length;

            let msg = `🧬 <b>Regime Status</b>\n\nActive genome: <code>${genome.id}</code>\n`;
            msg += `<pre>${formatGenomeParams(genome)}</pre>\n\n`;
            msg += `策略池數: ${poolCount}`;

            await ctx.reply(msg, { parse_mode: 'HTML' });
            return;
        }

        if (sub === 'candidates') {
            if (populationCache.length === 0) {
                await ctx.reply('尚無演化結果。使用 /regime evolve 觸發演化搜索。');
                return;
            }

            const baseline = currentConstantsToGenome();
            const top5 = [...populationCache]
                .sort((a, b) => b.fitness - a.fitness)
                .slice(0, 5);

            const lines = top5.map((entry, i) => {
                const tag = i === 0 ? ' ← BEST' : '';
                return [
                    `<b>#${i}</b> fitness=${entry.fitness.toFixed(3)}${tag}`,
                    `<pre>${formatGenomeParams(entry.genome, baseline)}</pre>`,
                ].join('\n');
            });

            await ctx.reply(`🧬 <b>Top 5 Genome Candidates</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
            return;
        }

        if (sub === 'apply') {
            const idxStr = parts[1];
            const idx = parseInt(idxStr ?? '', 10);
            if (isNaN(idx) || idx < 0 || populationCache.length === 0 || idx >= populationCache.length) {
                await ctx.reply(`用法: /regime apply <index>\n可用範圍: 0-${Math.max(0, populationCache.length - 1)}`);
                return;
            }
            const sorted = [...populationCache].sort((a, b) => b.fitness - a.fitness);
            const selected = sorted[idx];
            appState.activeGenome = selected.genome;
            await ctx.reply(
                `✅ Genome <code>${selected.genome.id}</code> 已啟用 (fitness=${selected.fitness.toFixed(3)})\n` +
                `將在下一次 MC cycle 生效。`,
                { parse_mode: 'HTML' },
            );
            return;
        }

        if (sub === 'evolve') {
            await ctx.reply('🧬 Evolution 功能將在完成接入後啟用。');
            return;
        }

        await ctx.reply(
            '🧬 <b>Regime Engine</b>\n\n' +
            '<code>/regime status</code>     — 當前 genome 參數\n' +
            '<code>/regime candidates</code> — 演化結果 top 5\n' +
            '<code>/regime apply &lt;id&gt;</code> — 切換 genome\n' +
            '<code>/regime evolve</code>     — 觸發演化搜索',
            { parse_mode: 'HTML' },
        );
    });
}
