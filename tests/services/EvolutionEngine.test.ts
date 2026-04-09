import {
    selectTopHalf,
    crossover,
    mutate,
    runOneGeneration,
} from '../../src/services/strategy/EvolutionEngine';
import { currentConstantsToGenome, randomGenome, GENOME_RANGES } from '../../src/services/strategy/ParameterGenome';
import type { RegimeGenome } from '../../src/types';

describe('EvolutionEngine', () => {
    describe('selectTopHalf', () => {
        it('should select top 50% by fitness', () => {
            const pop = Array.from({ length: 10 }, (_, i) => ({
                genome: randomGenome(`g${i}`),
                fitness: i * 0.1,
            }));
            const selected = selectTopHalf(pop);
            expect(selected).toHaveLength(5);
            expect(selected[0].fitness).toBeGreaterThanOrEqual(selected[1].fitness);
        });

        it('should only select from fitness > 0', () => {
            const pop = [
                { genome: randomGenome('a'), fitness: 0 },
                { genome: randomGenome('b'), fitness: 0 },
                { genome: randomGenome('c'), fitness: 0.5 },
            ];
            const selected = selectTopHalf(pop);
            expect(selected).toHaveLength(1);
            expect(selected[0].fitness).toBe(0.5);
        });

        it('should return immortal when all fitness = 0 (wipeout protection)', () => {
            const immortal = { genome: currentConstantsToGenome(), fitness: 0 };
            const pop = [
                { genome: randomGenome('a'), fitness: 0 },
                { genome: randomGenome('b'), fitness: 0 },
            ];
            const selected = selectTopHalf(pop, immortal);
            expect(selected).toHaveLength(1);
            expect(selected[0].genome.id).toBe('baseline');
        });
    });

    describe('crossover', () => {
        it('should produce N children', () => {
            const parents = [randomGenome('p1'), randomGenome('p2'), randomGenome('p3')];
            const children = crossover(parents, 5);
            expect(children).toHaveLength(5);
        });

        it('should produce children with values within parent ranges', () => {
            const p1 = currentConstantsToGenome();
            const p2 = randomGenome('p2');
            const children = crossover([p1, p2], 10);
            for (const child of children) {
                for (const [key] of Object.entries(GENOME_RANGES)) {
                    const k = key as keyof typeof GENOME_RANGES;
                    const val = child[k];
                    const v1 = p1[k];
                    const v2 = p2[k];
                    // Value should be from one of the parents
                    expect(val === v1 || val === v2).toBe(true);
                }
            }
        });
    });

    describe('mutate', () => {
        it('should produce N mutants within genome ranges', () => {
            const parent = currentConstantsToGenome();
            const mutants = mutate(parent, 3);
            expect(mutants).toHaveLength(3);
            for (const m of mutants) {
                for (const [key, [min, max]] of Object.entries(GENOME_RANGES)) {
                    const val = m[key as keyof typeof GENOME_RANGES];
                    expect(val).toBeGreaterThanOrEqual(min);
                    expect(val).toBeLessThanOrEqual(max);
                }
            }
        });
    });

    describe('runOneGeneration', () => {
        it('should produce exactly 20 genomes', () => {
            const pop = Array.from({ length: 20 }, (_, i) => ({
                genome: randomGenome(`g${i}`),
                fitness: Math.random(),
            }));
            const immortal = pop.reduce((a, b) => a.fitness > b.fitness ? a : b);
            const nextGen = runOneGeneration(pop, immortal);
            expect(nextGen).toHaveLength(20);
        });
    });
});
