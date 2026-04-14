/**
 * EvolutionEngine — 演化搜索引擎
 *
 * Population size: 20
 *   Selection (top 50%): 10
 *   Crossover:            5
 *   Mutation:              3
 *   Seed (random):         2
 *   Immortal:              1 (上一代最佳，wipeout protection)
 */

import type { RegimeGenome } from '../../types';
import { GENOME_RANGES, clampGenome, randomGenome } from './ParameterGenome';
import { createServiceLogger } from '../../infra/logger';

const log = createServiceLogger('Evolution');

export interface EvaluatedGenome {
    genome: RegimeGenome;
    fitness: number;
}

/** 從 population 中選出 fitness > 0 的 top 50% */
export function selectTopHalf(
    population: EvaluatedGenome[],
    immortal?: EvaluatedGenome,
): EvaluatedGenome[] {
    const viable = population.filter(g => g.fitness > 0);
    if (viable.length === 0) {
        return immortal ? [immortal] : [];
    }
    viable.sort((a, b) => b.fitness - a.fitness);
    return viable.slice(0, Math.max(1, Math.ceil(viable.length / 2)));
}

/** Uniform crossover：每個基因 50% 機率來自任一 parent */
export function crossover(parents: RegimeGenome[], count: number): RegimeGenome[] {
    const children: RegimeGenome[] = [];
    const keys = Object.keys(GENOME_RANGES) as Array<keyof typeof GENOME_RANGES>;

    for (let i = 0; i < count; i++) {
        const p1 = parents[Math.floor(Math.random() * parents.length)];
        const p2 = parents[Math.floor(Math.random() * parents.length)];
        const child: Partial<RegimeGenome> = {
            id: `cross-${Date.now().toString(36)}-${i}`,
        };
        for (const key of keys) {
            (child as Record<string, number>)[key] = Math.random() < 0.5 ? p1[key] : p2[key];
        }
        children.push(child as RegimeGenome);
    }
    return children;
}

/** Gaussian mutation：clone + 高斯噪音，sigma = 10% of range width */
export function mutate(parent: RegimeGenome, count: number): RegimeGenome[] {
    const mutants: RegimeGenome[] = [];
    const keys = Object.keys(GENOME_RANGES) as Array<keyof typeof GENOME_RANGES>;

    for (let i = 0; i < count; i++) {
        const clone: Partial<RegimeGenome> = {
            ...parent,
            id: `mut-${Date.now().toString(36)}-${i}`,
        };
        for (const key of keys) {
            const [min, max] = GENOME_RANGES[key];
            const range = max - min;
            const noise = gaussianRandom() * range * 0.1;
            (clone as Record<string, number>)[key] = parent[key] + noise;
        }
        mutants.push(clampGenome(clone as RegimeGenome));
    }
    return mutants;
}

/** 執行一代演化 */
export function runOneGeneration(
    population: EvaluatedGenome[],
    immortal: EvaluatedGenome,
): RegimeGenome[] {
    const selected = selectTopHalf(population, immortal);
    const parents = selected.map(e => e.genome);

    const crossed = crossover(parents, 5);
    const best = selected[0]?.genome ?? immortal.genome;
    const mutated = mutate(best, 3);
    const seeds = [randomGenome(), randomGenome()];

    const nextGen = [
        ...selected.map(e => e.genome),
        ...crossed,
        ...mutated,
        ...seeds,
    ];

    // 確保 immortal 在裡面
    if (!nextGen.find(g => g.id === immortal.genome.id)) {
        nextGen[nextGen.length - 1] = immortal.genome;
    }

    return nextGen.slice(0, 20);
}

/** Box-Muller 正態分佈隨機數 */
function gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
