/**
 * ParameterGenome — RegimeGenome 定義、序列化、搜索範圍
 *
 * 職責：
 *   - 定義每個基因的合法搜索範圍 [min, max]
 *   - 將現有硬編碼常數轉換為 baseline genome
 *   - 序列化 / 反序列化（JSON 持久化用）
 *   - clamp（確保所有參數在合法範圍內）
 */

import type { RegimeGenome } from '../../types';
import { config } from '../../config';

/** 每個基因的搜索範圍 [min, max] */
export const GENOME_RANGES: Record<keyof Omit<RegimeGenome, 'id'>, [number, number]> = {
    chopRangeThreshold:  [45, 70],
    chopTrendThreshold:  [30, 55],
    chopWindow:          [7, 28],
    hurstRangeThreshold: [0.40, 0.60],
    hurstTrendThreshold: [0.55, 0.80],
    hurstMaxLag:         [10, 40],
    sigmoidTemp:         [0.1, 5.0],
    atrWindow:           [7, 28],
    cvarSafetyFactor:    [1.0, 5.0],
};

/** 將現有硬編碼常數轉換為 baseline genome */
export function currentConstantsToGenome(): RegimeGenome {
    return {
        id: 'baseline',
        chopRangeThreshold:  55,
        chopTrendThreshold:  45,
        chopWindow:          14,
        hurstRangeThreshold: 0.52,
        hurstTrendThreshold: 0.65,
        hurstMaxLag:         20,
        sigmoidTemp:         1.0,
        atrWindow:           14,
        cvarSafetyFactor:    config.CVAR_SAFETY_FACTOR,
    };
}

/** 將 genome 的每個參數限制在合法範圍內 */
export function clampGenome(genome: RegimeGenome): RegimeGenome {
    const clamped = { ...genome };
    for (const [key, [min, max]] of Object.entries(GENOME_RANGES)) {
        const k = key as keyof typeof GENOME_RANGES;
        clamped[k] = Math.max(min, Math.min(max, clamped[k]));
    }
    return clamped;
}

/** 序列化為 JSON 字串 */
export function serializeGenome(genome: RegimeGenome): string {
    return JSON.stringify(genome);
}

/** 從 JSON 字串反序列化 */
export function deserializeGenome(json: string): RegimeGenome {
    return JSON.parse(json) as RegimeGenome;
}

/** 產生隨機 genome（所有參數在搜索範圍內均勻分佈） */
export function randomGenome(id?: string): RegimeGenome {
    const genome: Partial<RegimeGenome> = {
        id: id ?? `rand-${Date.now().toString(36)}`,
    };
    for (const [key, [min, max]] of Object.entries(GENOME_RANGES)) {
        (genome as Record<string, number>)[key] = min + Math.random() * (max - min);
    }
    return genome as RegimeGenome;
}
