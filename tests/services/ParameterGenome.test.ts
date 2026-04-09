import {
    GENOME_RANGES,
    currentConstantsToGenome,
    clampGenome,
    serializeGenome,
    deserializeGenome,
    randomGenome,
} from '../../src/services/strategy/ParameterGenome';
import type { RegimeGenome } from '../../src/types';

describe('ParameterGenome', () => {
    describe('GENOME_RANGES', () => {
        it('should define min < max for every parameter', () => {
            for (const [key, [min, max]] of Object.entries(GENOME_RANGES)) {
                expect(min).toBeLessThan(max);
            }
        });

        it('should cover all 9 genome parameters', () => {
            const expectedKeys = [
                'chopRangeThreshold', 'chopTrendThreshold', 'chopWindow',
                'hurstRangeThreshold', 'hurstTrendThreshold', 'hurstMaxLag',
                'sigmoidTemp', 'atrWindow', 'cvarSafetyFactor',
            ];
            expect(Object.keys(GENOME_RANGES).sort()).toEqual(expectedKeys.sort());
        });
    });

    describe('currentConstantsToGenome', () => {
        it('should return a genome matching current hard-coded constants', () => {
            const g = currentConstantsToGenome();
            expect(g.id).toBe('baseline');
            expect(g.chopRangeThreshold).toBe(55);
            expect(g.chopTrendThreshold).toBe(45);
            expect(g.chopWindow).toBe(14);
            expect(g.hurstRangeThreshold).toBe(0.52);
            expect(g.hurstTrendThreshold).toBe(0.65);
            expect(g.hurstMaxLag).toBe(20);
            expect(g.sigmoidTemp).toBe(1.0);
            expect(g.atrWindow).toBe(14);
            expect(g.cvarSafetyFactor).toBe(1.5);
        });
    });

    describe('clampGenome', () => {
        it('should clamp out-of-range values', () => {
            const bad: RegimeGenome = {
                id: 'test',
                chopRangeThreshold: 999,
                chopTrendThreshold: -10,
                chopWindow: 100,
                hurstRangeThreshold: 2.0,
                hurstTrendThreshold: -1.0,
                hurstMaxLag: 0,
                sigmoidTemp: 0,
                atrWindow: 1,
                cvarSafetyFactor: 100,
            };
            const clamped = clampGenome(bad);
            for (const [key, [min, max]] of Object.entries(GENOME_RANGES)) {
                const val = clamped[key as keyof typeof GENOME_RANGES];
                expect(val).toBeGreaterThanOrEqual(min);
                expect(val).toBeLessThanOrEqual(max);
            }
        });

        it('should not modify in-range values', () => {
            const baseline = currentConstantsToGenome();
            const clamped = clampGenome(baseline);
            expect(clamped).toEqual(baseline);
        });
    });

    describe('serialize / deserialize roundtrip', () => {
        it('should produce identical genome after roundtrip', () => {
            const original = currentConstantsToGenome();
            const json = serializeGenome(original);
            const restored = deserializeGenome(json);
            expect(restored).toEqual(original);
        });
    });

    describe('randomGenome', () => {
        it('should produce a genome within all ranges', () => {
            for (let i = 0; i < 20; i++) {
                const g = randomGenome();
                for (const [key, [min, max]] of Object.entries(GENOME_RANGES)) {
                    const val = g[key as keyof typeof GENOME_RANGES];
                    expect(val).toBeGreaterThanOrEqual(min);
                    expect(val).toBeLessThanOrEqual(max);
                }
            }
        });
    });
});
