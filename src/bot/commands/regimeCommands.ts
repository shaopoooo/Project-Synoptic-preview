import type { Bot } from 'grammy';
import { appState } from '../../infra/AppState';
import { currentConstantsToGenome, randomGenome } from '../../engine/shared/ParameterGenome';
import { runOneGeneration, type EvaluatedGenome } from '../../engine/shared/EvolutionEngine';
import { walkForwardValidate } from '../../engine/shared/WalkForwardValidator';
import { loadOhlcvStore } from '../../market/HistoricalDataService';
import * as fs from 'fs-extra';
import * as path from 'path';
import { rename } from 'fs/promises';
import { config } from '../../config';
import type { RegimeGenome } from '../../types';

const GENOMES_DIR = path.join(process.cwd(), 'data', 'genomes');
const MAX_GENERATIONS = 10;
const POPULATION_SIZE = 20;
const EVOLUTION_TIMEOUT_MS = 30 * 60 * 1000;

let isEvolutionRunning = false;
let evolutionStartedAt = 0;

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
            // 超時自動釋放
            if (isEvolutionRunning && Date.now() - evolutionStartedAt > EVOLUTION_TIMEOUT_MS) {
                isEvolutionRunning = false;
            }
            if (isEvolutionRunning) {
                await ctx.reply('🧬 演化搜索已在執行中，請等待完成。');
                return;
            }

            const pools = appState.pools;
            if (pools.length === 0) {
                await ctx.reply('⚠️ 無池子資料。');
                return;
            }
            const store = await loadOhlcvStore(pools[0].id);
            if (!store || store.candles.length < 3600) {
                await ctx.reply(`⚠️ 歷史數據不足：${store?.candles.length ?? 0} 根（需要 3600+）`);
                return;
            }

            await ctx.reply('🧬 開始演化搜索... (最多 30 分鐘)');

            isEvolutionRunning = true;
            evolutionStartedAt = Date.now();

            // 非同步執行（不阻塞 Telegram 回應）
            (async () => {
                try {
                    // 轉換為 HourlyReturn（需要 r 欄位）
                    const rawCandles = store.candles;
                    const candles = rawCandles.slice(1).map((c, i) => ({
                        ts: c.ts,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                        volume: c.volume,
                        r: Math.log(c.close / rawCandles[i].close),
                    }));

                    // 初始 population
                    let population: RegimeGenome[] = [
                        currentConstantsToGenome(),
                        ...Array.from({ length: POPULATION_SIZE - 1 }, () => randomGenome()),
                    ];

                    let immortal: EvaluatedGenome = {
                        genome: currentConstantsToGenome(),
                        fitness: 0,
                    };

                    for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
                        // Evaluate fitness
                        const evaluated: EvaluatedGenome[] = [];
                        for (let i = 0; i < population.length; i++) {
                            const result = walkForwardValidate(population[i], candles);
                            evaluated.push({ genome: population[i], fitness: result.fitness });

                            // Yield to event loop every 5 genomes
                            if (i % 5 === 4) {
                                await new Promise(r => setTimeout(r, 100));
                            }
                        }

                        // Update immortal
                        const best = evaluated.reduce((a, b) => a.fitness > b.fitness ? a : b);
                        if (best.fitness > immortal.fitness) {
                            immortal = best;
                        }

                        // Checkpoint
                        await fs.ensureDir(GENOMES_DIR);
                        const checkpoint = { generation: gen, population: evaluated, immortal };
                        const tmpPath = path.join(GENOMES_DIR, 'evolution-checkpoint.json.tmp');
                        const finalPath = path.join(GENOMES_DIR, 'evolution-checkpoint.json');
                        await fs.writeJson(tmpPath, checkpoint);
                        await rename(tmpPath, finalPath);

                        // Next generation
                        population = runOneGeneration(evaluated, immortal);
                    }

                    // Save final population
                    const finalEval: EvaluatedGenome[] = population.map(g => ({
                        genome: g,
                        fitness: walkForwardValidate(g, candles).fitness,
                    }));
                    setPopulationCache(finalEval);

                    const tmpPop = path.join(GENOMES_DIR, 'population.json.tmp');
                    const finalPop = path.join(GENOMES_DIR, 'population.json');
                    await fs.writeJson(tmpPop, finalEval);
                    await rename(tmpPop, finalPop);

                    // Save active genome
                    const tmpActive = path.join(GENOMES_DIR, 'active-genome.json.tmp');
                    const finalActive = path.join(GENOMES_DIR, 'active-genome.json');
                    await fs.writeJson(tmpActive, immortal.genome);
                    await rename(tmpActive, finalActive);

                    const elapsed = ((Date.now() - evolutionStartedAt) / 60000).toFixed(1);
                    const viable = finalEval.filter(e => e.fitness > 0).length;

                    await ctx.api.sendMessage(config.CHAT_ID,
                        `🧬 <b>演化完成</b> — ${MAX_GENERATIONS} 代\n\n` +
                        `最佳 fitness: ${immortal.fitness.toFixed(3)}\n` +
                        `Genome: <code>${immortal.genome.id}</code>\n` +
                        `Viable: ${viable}/${POPULATION_SIZE}\n` +
                        `耗時: ${elapsed} 分鐘\n\n` +
                        `使用 /regime apply 0 啟用最佳 genome。`,
                        { parse_mode: 'HTML' },
                    );
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    await ctx.api.sendMessage(config.CHAT_ID,
                        `🚨 演化搜索失敗: ${msg}`,
                    ).catch(() => {});
                } finally {
                    isEvolutionRunning = false;
                }
            })();

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
