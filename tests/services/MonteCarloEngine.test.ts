import { runMCSimulation } from '../../src/services/strategy/MonteCarloEngine';
import seedrandom from 'seedrandom';

describe('MonteCarloEngine — Sharpe scoring', () => {
    it('M1.1: 正常分佈時 score 應為 mean / std', () => {
        // 構造可預期的歷史序列：mean ≈ 0, std ≈ 0.01
        // 用固定 seed 注入，讓結果可重現
        const rng = seedrandom('m1.1-test');
        const result = runMCSimulation({
            historicalReturns: Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.01),
            P0: 1.0,
            Pa: 0.95,
            Pb: 1.05,
            capital: 1.0,
            dailyFeesToken0: 0.001,
            horizon: 7,
            numPaths: 1000,
            rng,
        });

        // std 必須是有限正數
        expect(Number.isFinite(result.std)).toBe(true);
        expect(result.std).toBeGreaterThan(0);

        // score = mean / std（容許 1e-9 浮點誤差）
        expect(result.score).toBeCloseTo(result.mean / result.std, 9);
    });

    it('M1.2: 退化分佈 (std < 1e-6) 時 score 應為 0，不爆炸', () => {
        // 所有 returns 都是 0 → std ≈ 0
        const rng = seedrandom('m1.2-test');
        const result = runMCSimulation({
            historicalReturns: new Array(200).fill(0),
            P0: 1.0,
            Pa: 0.95,
            Pb: 1.05,
            capital: 1.0,
            dailyFeesToken0: 0.001,
            horizon: 7,
            numPaths: 1000,
            rng,
        });

        expect(result.std).toBeLessThan(1e-6);
        expect(result.score).toBe(0);
        expect(Number.isFinite(result.score)).toBe(true);
        expect(Number.isNaN(result.score)).toBe(false);
    });

    it('M1.3: 負 mean 應產生負 score（合法）', () => {
        // 構造下跌偏向的 returns：mean < 0
        const rng = seedrandom('m1.3-test');
        const negDriftReturns = Array.from({ length: 200 }, (_, i) => -0.005 + Math.cos(i) * 0.005);
        const result = runMCSimulation({
            historicalReturns: negDriftReturns,
            P0: 1.0,
            Pa: 0.95,
            Pb: 1.05,
            capital: 1.0,
            dailyFeesToken0: 0.001,
            horizon: 7,
            numPaths: 1000,
            rng,
        });

        // 負 score 是合法的：表示期望虧損
        expect(result.score).toBeLessThan(0);
        expect(Number.isFinite(result.score)).toBe(true);
    });

    it('M1.4: 注入相同 seed 應產生位元相等的結果', () => {
        const params = {
            historicalReturns: Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.01),
            P0: 1.0,
            Pa: 0.95,
            Pb: 1.05,
            capital: 1.0,
            dailyFeesToken0: 0.001,
            horizon: 7,
            numPaths: 500,
        };

        const r1 = runMCSimulation({ ...params, rng: seedrandom('determinism') });
        const r2 = runMCSimulation({ ...params, rng: seedrandom('determinism') });

        expect(r1.mean).toBe(r2.mean);
        expect(r1.std).toBe(r2.std);
        expect(r1.score).toBe(r2.score);
        expect(r1.cvar95).toBe(r2.cvar95);
        expect(r1.var95).toBe(r2.var95);
        expect(r1.median).toBe(r2.median);
        expect(r1.p5).toBe(r2.p5);
        expect(r1.p25).toBe(r2.p25);
        expect(r1.p50).toBe(r2.p50);
        expect(r1.p75).toBe(r2.p75);
        expect(r1.p95).toBe(r2.p95);
        expect(r1.inRangeDays).toBe(r2.inRangeDays);
    });

    it('M2.1: canary snapshot — 鎖住 11 個 MCSimResult 欄位', () => {
        // 固定 seed + 固定參數 → 鎖住 path generator 行為
        // 任何動到 path generator 的 PR 都會被擋下
        const rng = seedrandom('phase1-canary');
        const result = runMCSimulation({
            historicalReturns: Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.3) * 0.015),
            P0: 1.0,
            Pa: 0.95,
            Pb: 1.05,
            capital: 1.0,
            dailyFeesToken0: 0.001,
            horizon: 7,
            numPaths: 1000,
            rng,
        });

        // Snapshot 鎖住 11 個既有欄位（不包含新增的 std / score）
        const canaryFields = {
            numPaths: result.numPaths,
            mean: result.mean,
            median: result.median,
            cvar95: result.cvar95,
            var95: result.var95,
            p5: result.p5,
            p25: result.p25,
            p50: result.p50,
            p75: result.p75,
            p95: result.p95,
            inRangeDays: result.inRangeDays,
        };
        expect(canaryFields).toMatchSnapshot();
    });
});
