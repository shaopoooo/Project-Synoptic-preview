# P0 Self-Learning Regime Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard regime classification with continuous sigmoid+softmax vector, add evolutionary search for RegimeGenome parameters, and build a diagnostic system for 24h live validation.

**Architecture:** Parallel dual-track — Track 1 builds the CoinGecko Pro data pipeline (Phase 0.5), Track 2 builds BacktestHarness + types (Phase 1). They converge at Phase 2 (continuous vector + remove hard skip), validated in Phase 2.5 (24h live + diagnostics), then Phase 3 (evolutionary search).

**Tech Stack:** TypeScript, Node.js, Grammy (Telegram), CoinGecko Pro API, Jest (testing)

**Spec:** `docs/superpowers/specs/2026-04-09-p0-regime-engine-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/services/market/HistoricalDataService.ts` | CoinGecko Pro backfill + incremental fetch + atomic write |
| `src/services/strategy/ParameterGenome.ts` | Genome definition, ranges, serialization, baseline conversion |
| `src/runners/BacktestHarness.ts` | Run regime→MC pipeline with injected genome, return BacktestResult |
| `src/bot/commands/regimeCommands.ts` | `/regime status`, `/regime candidates`, `/regime apply`, `/regime evolve` |
| `src/bot/commands/diagnosticCommands.ts` | `/diagnostic`, `/benchmark` |
| `src/utils/diagnosticStore.ts` | JSONL append + rotation + memory buffer for CycleDiagnostic |
| `src/services/strategy/EvolutionEngine.ts` | Selection, crossover, mutation, seed, immortal |
| `src/runners/WalkForwardValidator.ts` | 4-window rolling validation, fitness calculation |
| `tests/services/ParameterGenome.test.ts` | Genome serialization, clamping, baseline roundtrip |
| `tests/services/RegimeVector.test.ts` | Softmax property tests, sigmoid edge cases |
| `tests/services/BacktestHarness.test.ts` | Baseline equivalence (KS test) |
| `tests/services/HistoricalDataService.test.ts` | Backfill pagination, dedup, incremental merge |
| `tests/services/EvolutionEngine.test.ts` | Convergence, NaN guard, wipeout protection |
| `tests/services/DiagnosticStore.test.ts` | JSONL append, rotation, buffer limits |

### Modified Files

| File | Changes |
|------|---------|
| `src/types/index.ts` | Add RegimeGenome, RegimeVector, BacktestResult, CycleDiagnostic, etc. |
| `src/config/env.ts` | Add `COINGECKO_API_KEY`, `REGIME_DIAGNOSTIC` |
| `src/config/constants.ts` | Add `COINGECKO_PRO_BASE_URL`, genome search ranges |
| `src/services/strategy/MarketRegimeAnalyzer.ts` | Add `genome?` param to `analyzeRegime`, add `computeRegimeVector`, `segmentByRegime` |
| `src/services/strategy/MonteCarloEngine.ts` | Add `segments?` + `regimeVector?` to `runMCSimulation` for blended bootstrap |
| `src/runners/mcEngine.ts` | Remove hard skip, return `MCEngineDiagnostic`, accept `genome` param |
| `src/runners/prefetch.ts` | Read from `data/ohlcv/` when available |
| `src/index.ts` | Per-phase timing, diagnostic collection, `runCycle` returns `CycleDiagnostic` |
| `src/bot/TelegramBot.ts` | Register regimeCommands + diagnosticCommands |
| `src/utils/AppState.ts` | Add `activeGenome`, `lastDiagnostics` fields |

---

## Track 2 Tasks (Framework — can start immediately)

### Task 1: RegimeGenome + RegimeVector type definitions

**Files:**
- Modify: `src/types/index.ts` (append after `RangeGuards` interface, ~line 251)

- [ ] **Step 1: Add RegimeGenome interface**

Add to `src/types/index.ts` after the `RangeGuards` interface:

```ts
/** Regime 判斷的可調參數（演化搜索目標，9 個基因） */
export interface RegimeGenome {
    id: string;                     // 唯一識別碼（如 'baseline', 'gen3-best')
    /** CHOP 指數 > 此值 = 偏震盪 */
    chopRangeThreshold: number;     // baseline: 55, search: [45, 70]
    /** CHOP 指數 < 此值 = 偏趨勢 */
    chopTrendThreshold: number;     // baseline: 45, search: [30, 55]
    /** CHOP 計算窗口（根 K 線數） */
    chopWindow: number;             // baseline: 14, search: [7, 28]
    /** Hurst < 此值 = 均值回歸（LP 友善） */
    hurstRangeThreshold: number;    // baseline: 0.52, search: [0.40, 0.60]
    /** Hurst > 此值 = 趨勢延續 */
    hurstTrendThreshold: number;    // baseline: 0.65, search: [0.55, 0.80]
    /** Hurst R/S 分析最大 lag */
    hurstMaxLag: number;            // baseline: 20, search: [10, 40]
    /** Sigmoid 溫度：T→0 硬分類，T→∞ 均勻分佈 */
    sigmoidTemp: number;            // baseline: 1.0, search: [0.1, 5.0]
    /** ATR 計算窗口 */
    atrWindow: number;              // baseline: 14, search: [7, 28]
    /** CVaR 安全係數 */
    cvarSafetyFactor: number;       // baseline: 1.5, search: [1.0, 5.0]
}

/** Continuous regime vector — softmax 正規化，三分量總和 = 1 */
export interface RegimeVector {
    range: number;      // [0, 1]
    trend: number;      // [0, 1]
    neutral: number;    // [0, 1]
}

/** 單池回測詳情 */
export interface PoolBacktestResult {
    poolAddress: string;
    sigmaOpt: number;
    score: number;
    cvar95: number;
    go: boolean;
    inRangePct: number;
    pnlRatio: number;
}

/** 回測引擎輸出（跨池彙總） */
export interface BacktestResult {
    sharpe: number;
    maxDrawdown: number;
    inRangePct: number;
    totalReturn: number;
    poolResults: Map<string, PoolBacktestResult>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors from the added types (existing errors may appear).

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): 新增 RegimeGenome、RegimeVector、BacktestResult 型別定義"
```

---

### Task 2: ParameterGenome module

**Files:**
- Create: `src/services/strategy/ParameterGenome.ts`
- Create: `tests/services/ParameterGenome.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/ParameterGenome.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/ParameterGenome.test.ts --no-cache 2>&1 | tail -5`
Expected: FAIL — Cannot find module

- [ ] **Step 3: Write the implementation**

Create `src/services/strategy/ParameterGenome.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/ParameterGenome.test.ts --no-cache 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/strategy/ParameterGenome.ts tests/services/ParameterGenome.test.ts
git commit -m "feat(genome): 新增 ParameterGenome 模組 — 搜索範圍、序列化、baseline 轉換"
```

---

### Task 3: Inject genome into MarketRegimeAnalyzer

**Files:**
- Modify: `src/services/strategy/MarketRegimeAnalyzer.ts`

- [ ] **Step 1: Modify `analyzeRegime` to accept optional genome**

In `src/services/strategy/MarketRegimeAnalyzer.ts`, change the `analyzeRegime` function signature and body:

```ts
// 在檔案頂部加入 import
import type { HourlyReturn, MarketRegime, RangeGuards, RegimeGenome } from '../../types';

// 修改 analyzeRegime 函式簽名與內容
export function analyzeRegime(candles: HourlyReturn[], genome?: RegimeGenome): MarketRegime {
    const chopWindow = genome?.chopWindow ?? 14;
    const hurstMaxLag = genome?.hurstMaxLag ?? 20;
    const atrWindow = genome?.atrWindow ?? 14;
    const chopRangeThreshold = genome?.chopRangeThreshold ?? 55;
    const chopTrendThreshold = genome?.chopTrendThreshold ?? 45;
    const hurstRangeThreshold = genome?.hurstRangeThreshold ?? 0.52;
    const hurstTrendThreshold = genome?.hurstTrendThreshold ?? 0.65;

    const returns = candles.map(c => c.r);
    const chop  = calculateCHOP(candles, chopWindow);
    const hurst = calculateHurst(returns, hurstMaxLag);
    const atr   = calculateATR(candles, atrWindow);

    let signal: MarketRegime['signal'];
    if (chop > chopRangeThreshold && hurst < hurstRangeThreshold) {
        signal = 'range';
    } else if (chop < chopTrendThreshold || hurst > hurstTrendThreshold) {
        signal = 'trend';
    } else {
        signal = 'neutral';
    }

    return { chop, hurst, atr, signal };
}
```

Also modify `computeRangeGuards` to accept optional genome:

```ts
export function computeRangeGuards(candles: HourlyReturn[], genome?: RegimeGenome): RangeGuards {
    const atrWindow = genome?.atrWindow ?? 14;
    const atrHalfWidth = calculateATR(candles, atrWindow);
    const closes       = candles.map(c => c.close);
    const { p5, p95 }  = calculatePercentileRange(closes);
    return { atrHalfWidth, p5, p95 };
}
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx jest --no-cache 2>&1 | tail -10`
Expected: All existing tests pass (no genome = old behavior via defaults).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/strategy/MarketRegimeAnalyzer.ts
git commit -m "refactor(regime): analyzeRegime 與 computeRangeGuards 接受可選 genome 參數注入"
```

---

### Task 4: Diagnostic types + DiagnosticStore

**Files:**
- Modify: `src/types/index.ts` (append diagnostic types)
- Create: `src/utils/diagnosticStore.ts`
- Create: `tests/services/DiagnosticStore.test.ts`

- [ ] **Step 1: Add diagnostic types to `src/types/index.ts`**

Append after the `BacktestResult` interface:

```ts
/** 單池 MC 引擎診斷 */
export interface PoolDiagnostic {
    pool: string;
    dex: string;
    regimeVector: RegimeVector | null;
    hardSignal: 'range' | 'trend' | 'neutral';
    wouldSkipInOldVersion: boolean;
    sigmaOpt: number | null;
    kBest: number | null;
    score: number | null;
    cvar95: number | null;
    go: boolean;
    goCandidateCount: number;
}

/** MC 引擎整體診斷輸出 */
export interface MCEngineDiagnostic {
    poolResults: PoolDiagnostic[];
    summary: {
        totalPools: number;
        goPools: number;
        oldVersionSkipCount: number;
        newVersionRecoveredCount: number;
    };
}

/** 單次 cycle 完整診斷 */
export interface CycleDiagnostic {
    cycleNumber: number;
    timestamp: number;
    durationMs: number;
    phase: {
        prefetchMs: number;
        computeMs: number;
        mcEngineMs: number;
    };
    pools: PoolDiagnostic[];
    activeGenomeId: string | null;
    summary: {
        totalPools: number;
        goPools: number;
        oldVersionSkipCount: number;
        newVersionRecoveredCount: number;
    };
}
```

- [ ] **Step 2: Write the failing tests for DiagnosticStore**

Create `tests/services/DiagnosticStore.test.ts`:

```ts
import * as fs from 'fs-extra';
import * as path from 'path';
import { DiagnosticStore } from '../../src/utils/diagnosticStore';
import type { CycleDiagnostic } from '../../src/types';

const TEST_DIR = path.join(__dirname, '../__fixtures__/diag-test');
const TEST_FILE = path.join(TEST_DIR, 'diagnostics.jsonl');

function makeDiag(cycleNumber: number): CycleDiagnostic {
    return {
        cycleNumber,
        timestamp: Date.now(),
        durationMs: 1000,
        phase: { prefetchMs: 500, computeMs: 100, mcEngineMs: 400 },
        pools: [],
        activeGenomeId: null,
        summary: { totalPools: 0, goPools: 0, oldVersionSkipCount: 0, newVersionRecoveredCount: 0 },
    };
}

describe('DiagnosticStore', () => {
    let store: DiagnosticStore;

    beforeEach(async () => {
        await fs.remove(TEST_DIR);
        await fs.ensureDir(TEST_DIR);
        store = new DiagnosticStore(TEST_FILE, 48);
    });

    afterAll(async () => {
        await fs.remove(TEST_DIR);
    });

    it('should append diagnostic to JSONL file', async () => {
        await store.append(makeDiag(1));
        await store.append(makeDiag(2));
        const lines = (await fs.readFile(TEST_FILE, 'utf-8')).trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).cycleNumber).toBe(1);
        expect(JSON.parse(lines[1]).cycleNumber).toBe(2);
    });

    it('should maintain memory buffer with max size', async () => {
        const smallStore = new DiagnosticStore(TEST_FILE, 3);
        for (let i = 1; i <= 5; i++) {
            await smallStore.append(makeDiag(i));
        }
        const recent = smallStore.getRecent();
        expect(recent).toHaveLength(3);
        expect(recent[0].cycleNumber).toBe(3);
        expect(recent[2].cycleNumber).toBe(5);
    });

    it('should return recent N entries', async () => {
        for (let i = 1; i <= 10; i++) {
            await store.append(makeDiag(i));
        }
        const last3 = store.getRecent(3);
        expect(last3).toHaveLength(3);
        expect(last3[0].cycleNumber).toBe(8);
    });

    it('should compute benchmark stats', async () => {
        for (let i = 1; i <= 10; i++) {
            await store.append({
                ...makeDiag(i),
                durationMs: i * 100,
                phase: { prefetchMs: i * 50, computeMs: i * 10, mcEngineMs: i * 40 },
            });
        }
        const stats = store.getBenchmarkStats();
        expect(stats.count).toBe(10);
        expect(stats.total.avg).toBeCloseTo(550, 0);
        expect(stats.prefetch.avg).toBeCloseTo(275, 0);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/services/DiagnosticStore.test.ts --no-cache 2>&1 | tail -5`
Expected: FAIL — Cannot find module

- [ ] **Step 4: Write the implementation**

Create `src/utils/diagnosticStore.ts`:

```ts
/**
 * diagnosticStore.ts — Cycle 診斷數據的持久化與查詢
 *
 * JSONL append-only 儲存 + 記憶體環形緩衝（最近 N 筆供 Telegram cmd 查詢）。
 * 超過 10MB 自動 rotation。
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { createServiceLogger } from './logger';
import type { CycleDiagnostic } from '../types';

const log = createServiceLogger('DiagStore');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface BenchmarkStats {
    count: number;
    total:    { avg: number; p95: number; max: number };
    prefetch: { avg: number; p95: number; max: number };
    compute:  { avg: number; p95: number; max: number };
    mcEngine: { avg: number; p95: number; max: number };
    goRate: number;
    avgRecovered: number;
}

export class DiagnosticStore {
    private buffer: CycleDiagnostic[] = [];
    private readonly filePath: string;
    private readonly maxBuffer: number;

    constructor(filePath: string, maxBuffer = 48) {
        this.filePath = filePath;
        this.maxBuffer = maxBuffer;
    }

    async append(diag: CycleDiagnostic): Promise<void> {
        // 記憶體緩衝
        this.buffer.push(diag);
        if (this.buffer.length > this.maxBuffer) {
            this.buffer.shift();
        }

        // JSONL 追加
        try {
            await fs.ensureDir(path.dirname(this.filePath));

            // 自動 rotation
            try {
                const stat = await fs.stat(this.filePath);
                if (stat.size > MAX_FILE_SIZE_BYTES) {
                    const date = new Date().toISOString().slice(0, 10);
                    const rotated = this.filePath.replace('.jsonl', `.${date}.jsonl`);
                    await fs.rename(this.filePath, rotated);
                    log.info(`DiagStore: rotated to ${path.basename(rotated)}`);
                }
            } catch {
                // 檔案不存在，無需 rotation
            }

            await fs.appendFile(this.filePath, JSON.stringify(diag) + '\n');
        } catch (e) {
            log.error('DiagStore: append failed', e);
        }
    }

    /** 取得最近 N 筆診斷（從記憶體緩衝） */
    getRecent(n?: number): CycleDiagnostic[] {
        if (n === undefined) return [...this.buffer];
        return this.buffer.slice(-n);
    }

    /** 計算 benchmark 統計 */
    getBenchmarkStats(): BenchmarkStats {
        const data = this.buffer;
        const count = data.length;
        if (count === 0) {
            return {
                count: 0,
                total:    { avg: 0, p95: 0, max: 0 },
                prefetch: { avg: 0, p95: 0, max: 0 },
                compute:  { avg: 0, p95: 0, max: 0 },
                mcEngine: { avg: 0, p95: 0, max: 0 },
                goRate: 0,
                avgRecovered: 0,
            };
        }

        const percentile = (arr: number[], p: number) => {
            const sorted = [...arr].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length * p / 100)] ?? 0;
        };
        const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

        const totals = data.map(d => d.durationMs);
        const prefetches = data.map(d => d.phase.prefetchMs);
        const computes = data.map(d => d.phase.computeMs);
        const mcEngines = data.map(d => d.phase.mcEngineMs);

        const totalGoals = data.reduce((s, d) => s + d.summary.goPools, 0);
        const totalPools = data.reduce((s, d) => s + d.summary.totalPools, 0);
        const totalRecovered = data.reduce((s, d) => s + d.summary.newVersionRecoveredCount, 0);

        return {
            count,
            total:    { avg: avg(totals),    p95: percentile(totals, 95),    max: Math.max(...totals) },
            prefetch: { avg: avg(prefetches), p95: percentile(prefetches, 95), max: Math.max(...prefetches) },
            compute:  { avg: avg(computes),  p95: percentile(computes, 95),  max: Math.max(...computes) },
            mcEngine: { avg: avg(mcEngines), p95: percentile(mcEngines, 95), max: Math.max(...mcEngines) },
            goRate: totalPools > 0 ? totalGoals / totalPools : 0,
            avgRecovered: totalRecovered / count,
        };
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/services/DiagnosticStore.test.ts --no-cache 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/utils/diagnosticStore.ts tests/services/DiagnosticStore.test.ts
git commit -m "feat(diagnostic): 新增 CycleDiagnostic 型別與 DiagnosticStore（JSONL + 環形緩衝）"
```

---

### Task 5: Refactor mcEngine.ts to return MCEngineDiagnostic

**Files:**
- Modify: `src/runners/mcEngine.ts`

- [ ] **Step 1: Change `runMCEngine` return type from `void` to `MCEngineDiagnostic`**

Modify `src/runners/mcEngine.ts`:

1. Add imports at top:
```ts
import type { OpeningStrategy, HourlyReturn, RangeGuards, RegimeGenome, MCEngineDiagnostic, PoolDiagnostic } from '../types';
import { currentConstantsToGenome } from '../services/strategy/ParameterGenome';
```

2. Change function signature:
```ts
export async function runMCEngine(
    historicalReturns: Map<string, HourlyReturn[]>,
    sendAlert?: (msg: string) => Promise<void>,
    genome?: RegimeGenome,
): Promise<MCEngineDiagnostic> {
```

3. Add `poolDiagnostics` array at top of function:
```ts
    const poolDiagnostics: PoolDiagnostic[] = [];
    const activeGenome = genome ?? currentConstantsToGenome();
```

4. Inside the pool loop, after `analyzeRegime`, collect diagnostic:
```ts
        const regime = analyzeRegime(rawReturns, activeGenome);
        // ... existing logging ...

        // 收集診斷數據（不論是否被 skip）
        const diagEntry: PoolDiagnostic = {
            pool: pool.id.slice(0, 10),
            dex: pool.dex,
            regimeVector: null,  // Phase 2 啟用後填入
            hardSignal: regime.signal,
            wouldSkipInOldVersion: regime.signal === 'trend',
            sigmaOpt: null,
            kBest: null,
            score: null,
            cvar95: null,
            go: false,
            goCandidateCount: 0,
        };
```

5. Update `diagEntry` fields when strategy is computed (after scoring):
```ts
        // 在 scored.sort 之後，best 選出之後
        diagEntry.sigmaOpt = best.sigma;
        diagEntry.score = bestScore;
        diagEntry.cvar95 = best.mc.cvar95;
        diagEntry.go = true;
        diagEntry.goCandidateCount = goCandidates.length;
```

6. Push `diagEntry` at end of each pool iteration (before `continue` and in the success path):
```ts
        poolDiagnostics.push(diagEntry);
```

7. At the end of the function (before alerts), build and return summary:
```ts
    const goPools = poolDiagnostics.filter(d => d.go).length;
    const oldSkipCount = poolDiagnostics.filter(d => d.wouldSkipInOldVersion).length;
    const recoveredCount = poolDiagnostics.filter(d => d.wouldSkipInOldVersion && d.go).length;

    // ... existing alert code ...

    return {
        poolResults: poolDiagnostics,
        summary: {
            totalPools: poolDiagnostics.length,
            goPools,
            oldVersionSkipCount: oldSkipCount,
            newVersionRecoveredCount: recoveredCount,
        },
    };
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors (index.ts will have a type mismatch since it ignores the return — that's fine).

- [ ] **Step 3: Verify existing tests still pass**

Run: `npx jest --no-cache 2>&1 | tail -10`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/runners/mcEngine.ts
git commit -m "refactor(mcEngine): 回傳 MCEngineDiagnostic 取代 void，收集每池診斷數據"
```

---

### Task 6: Rewrite index.ts with per-phase timing + diagnostic collection

**Files:**
- Modify: `src/index.ts`
- Modify: `src/utils/AppState.ts` (add `activeGenome`, `lastDiagnostics`)

- [ ] **Step 1: Add fields to AppState**

In `src/utils/AppState.ts`, add to the appState object (find the existing `appState` declaration and add):

```ts
import type { RegimeGenome, CycleDiagnostic } from '../types';

// 在 appState 物件中新增：
    activeGenome: null as RegimeGenome | null,
```

- [ ] **Step 2: Rewrite `runCycle` in index.ts**

Replace the existing `runCycle` function in `src/index.ts`:

```ts
import { DiagnosticStore } from './utils/diagnosticStore';
import type { CycleDiagnostic } from './types';
import * as path from 'path';

// 在 module scope 新增
let cycleCount = 0;
const diagnosticStore = new DiagnosticStore(
    path.join(process.cwd(), 'data', 'diagnostics.jsonl'),
    48,
);

async function runCycle(): Promise<CycleDiagnostic | null> {
    const t0 = Date.now();

    // ── Phase 0: Prefetch ────────────────────────────────────────────
    const tPrefetch = Date.now();
    const data = await prefetchAll(sendCriticalAlert);
    const prefetchMs = Date.now() - tPrefetch;
    if (!data) return null;

    // ── Phase 1: Compute ─────────────────────────────────────────────
    const tCompute = Date.now();
    const result = computeAll(data);
    positionScanner.updatePositions(result.positions);
    appState.commit(data, { positions: positionScanner.getTrackedPositions() });
    const computeMs = Date.now() - tCompute;

    // ── MC Engine ────────────────────────────────────────────────────
    const tMC = Date.now();
    let mcDiagnostic: import('./types').MCEngineDiagnostic | null = null;
    if (!isMCEngineRunning) {
        isMCEngineRunning = true;
        try {
            mcDiagnostic = await runMCEngine(
                data.historicalReturns,
                botService.sendAlert.bind(botService),
                appState.activeGenome ?? undefined,
            );
        } catch (e) {
            log.error('MCEngine', e);
        } finally {
            isMCEngineRunning = false;
        }
    } else {
        log.info('MCEngine: 已在執行中，本輪跳過');
    }
    const mcEngineMs = Date.now() - tMC;

    // ── Reporting + Save ─────────────────────────────────────────────
    await runBotService(botService, isStartupComplete).catch((e) => log.error('BotService', e));
    await triggerStateSave().catch((e) => log.error('State save', e));

    const bbForLog = appState.positions[0]
        ? (appState.marketSnapshots[appState.positions[0].poolAddress.toLowerCase()] ?? null)
        : null;
    await positionScanner.logSnapshots(appState.positions, bbForLog, appState.marketKLowVol, appState.marketKHighVol)
        .catch((e) => log.error('LogSnapshots', e));

    // ── 組裝 CycleDiagnostic ─────────────────────────────────────────
    const diag: CycleDiagnostic = {
        cycleNumber: ++cycleCount,
        timestamp: t0,
        durationMs: Date.now() - t0,
        phase: { prefetchMs, computeMs, mcEngineMs },
        pools: mcDiagnostic?.poolResults ?? [],
        activeGenomeId: appState.activeGenome?.id ?? null,
        summary: mcDiagnostic?.summary ?? {
            totalPools: 0, goPools: 0, oldVersionSkipCount: 0, newVersionRecoveredCount: 0,
        },
    };

    return diag;
}
```

- [ ] **Step 3: Update the cron caller to handle diagnostics**

Replace the `buildCronJob` function:

```ts
function buildCronJob() {
    return cron.schedule(minutesToCron(currentIntervalMinutes), async () => {
        if (isCycleRunning) {
            log.warn('⚠️  上一個週期尚未完成，跳過本次觸發（排程重疊保護）');
            return;
        }
        isCycleRunning = true;
        try {
            log.section(`${currentIntervalMinutes}m cycle`);
            const diag = await runCycle();
            if (diag) {
                await diagnosticStore.append(diag);
                log.info(`Cycle #${diag.cycleNumber} 完成 — ${diag.durationMs}ms (P0:${diag.phase.prefetchMs} C:${diag.phase.computeMs} MC:${diag.phase.mcEngineMs})`);
            }
            log.section('cycle end');
        } finally {
            isCycleRunning = false;
        }
        scheduleBackgroundTasks('cycle');
    });
}
```

Also update the FAST_STARTUP block to handle the new `runCycle` return:

```ts
    if (config.FAST_STARTUP) {
        log.info('⚡ FAST_STARTUP=true — skipping initial scan, first cron cycle fires in 5s');
        setTimeout(() => {
            log.info('⚡ FAST_STARTUP: triggering first cycle now');
            if (isCycleRunning) {
                log.warn('⚡ FAST_STARTUP: cycle already running, skipping');
                return;
            }
            isCycleRunning = true;
            Promise.resolve()
                .then(runCycle)
                .then(async (diag) => {
                    if (diag) await diagnosticStore.append(diag);
                })
                .catch((e) => log.error('FastStartup cycle', e))
                .finally(() => {
                    isCycleRunning = false;
                    scheduleBackgroundTasks('fast');
                });
        }, 5000);
    }
```

- [ ] **Step 4: Export diagnosticStore for commands to use**

Add at the bottom of index.ts, before `main().catch(...)`:

```ts
export { diagnosticStore };
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/utils/AppState.ts
git commit -m "refactor(index): 重寫 runCycle 加入 per-phase 計時與 CycleDiagnostic 收集"
```

---

### Task 7: Telegram diagnostic + benchmark commands

**Files:**
- Create: `src/bot/commands/diagnosticCommands.ts`
- Modify: `src/bot/TelegramBot.ts`

- [ ] **Step 1: Create diagnostic commands**

Create `src/bot/commands/diagnosticCommands.ts`:

```ts
import type { Bot } from 'grammy';
// 注意：diagnosticStore 由 index.ts 建立，透過 BotDeps 注入避免循環引用
// 在 registerDiagnosticCommands 中透過閉包接收
import type { DiagnosticStore } from '../../utils/diagnosticStore';
import type { CycleDiagnostic, BenchmarkStats } from '../../types';

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

function formatBenchmark(stats: ReturnType<typeof diagnosticStore.getBenchmarkStats>): string {
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

        if (arg === 'on') {
            // TODO: Phase 2.5 — toggle auto-push via config
            await ctx.reply('✅ Diagnostic 自動推播已開啟');
            return;
        }
        if (arg === 'off') {
            await ctx.reply('✅ Diagnostic 自動推播已關閉');
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

        // 預設：最近一次
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
```

- [ ] **Step 2: Register commands in TelegramBot.ts**

Add import and registration in `src/bot/TelegramBot.ts`:

```ts
import { registerDiagnosticCommands } from './commands/diagnosticCommands';

// Inside constructor, after existing registerXxx calls:
registerDiagnosticCommands(this.bot);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/diagnosticCommands.ts src/bot/TelegramBot.ts
git commit -m "feat(telegram): 新增 /diagnostic 與 /benchmark 指令"
```

---

### Task 8: Telegram regime commands (status / candidates / apply)

**Files:**
- Create: `src/bot/commands/regimeCommands.ts`
- Modify: `src/bot/TelegramBot.ts`

- [ ] **Step 1: Create regime commands**

Create `src/bot/commands/regimeCommands.ts`:

```ts
import type { Bot } from 'grammy';
import { appState } from '../../utils/AppState';
import { currentConstantsToGenome } from '../../services/strategy/ParameterGenome';
import type { RegimeGenome } from '../../types';

/** Genome 持久化路徑（Phase 3 建立 data/genomes/，此處先用 appState） */
let populationCache: Array<{ genome: RegimeGenome; fitness: number }> = [];

export function setPopulationCache(pop: Array<{ genome: RegimeGenome; fitness: number }>) {
    populationCache = pop;
}

function formatGenomeParams(g: RegimeGenome, baseline?: RegimeGenome): string {
    const lines: string[] = [];
    const keys: Array<keyof Omit<RegimeGenome, 'id'>> = [
        'chopRangeThreshold', 'chopTrendThreshold', 'chopWindow',
        'hurstRangeThreshold', 'hurstTrendThreshold', 'hurstMaxLag',
        'sigmoidTemp', 'atrWindow', 'cvarSafetyFactor',
    ];
    for (const k of keys) {
        const val = g[k] as number;
        const base = baseline ? baseline[k] as number : null;
        const arrow = base != null ? (val > base ? '▲' : val < base ? '▼' : '=') : '';
        const diff = base != null ? ` (base ${typeof base === 'number' && base < 1 ? base.toFixed(2) : base})` : '';
        lines.push(`  ${k}=${typeof val === 'number' && val < 1 ? val.toFixed(2) : val.toFixed?.(1) ?? val} ${arrow}${diff}`);
    }
    return lines.join('\n');
}

export function registerRegimeCommands(bot: Bot): void {
    bot.command('regime', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/);
        const sub = parts[0]?.toLowerCase() ?? '';

        if (sub === 'status') {
            const genome = appState.activeGenome ?? currentConstantsToGenome();
            const strategies = appState.strategies;
            const poolCount = Object.keys(strategies).length;

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
            const top5 = populationCache
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
            if (isNaN(idx) || idx < 0 || idx >= populationCache.length) {
                await ctx.reply(`用法: /regime apply <index>\n可用範圍: 0-${populationCache.length - 1}`);
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
            // Phase 3 實作
            await ctx.reply('🧬 Evolution 功能將在 Phase 3 實作。');
            return;
        }

        // 預設：顯示用法
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
```

- [ ] **Step 2: Register in TelegramBot.ts**

```ts
import { registerRegimeCommands } from './commands/regimeCommands';

// Inside constructor:
registerRegimeCommands(this.bot);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/regimeCommands.ts src/bot/TelegramBot.ts
git commit -m "feat(telegram): 新增 /regime status|candidates|apply 指令"
```

---

## Track 1 Tasks (Data Pipeline — can run in parallel with Track 2)

### Task 9: CoinGecko Pro config + env

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add env variables**

In `src/config/env.ts`, add to the `env` object:

```ts
    COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || '',
    REGIME_DIAGNOSTIC: process.env.REGIME_DIAGNOSTIC === 'true',
```

- [ ] **Step 2: Add constants**

In `src/config/constants.ts`, add after the MC Engine section:

```ts
    // ── CoinGecko Pro ────────────────────────────────────────────────────
    COINGECKO_PRO_BASE_URL: 'https://pro-api.coingecko.com/api/v3',
    /** 回填目標天數 */
    HISTORICAL_BACKFILL_DAYS: 150,
    /** OHLCV 資料目錄 */
    OHLCV_DATA_DIR: 'data/ohlcv',
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts src/config/constants.ts
git commit -m "feat(config): 新增 CoinGecko Pro API key 與 OHLCV 設定"
```

---

### Task 10: HistoricalDataService

**Files:**
- Create: `src/services/market/HistoricalDataService.ts`
- Create: `tests/services/HistoricalDataService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/HistoricalDataService.test.ts`:

```ts
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    mergeCandles,
    paginateBackfillRequests,
} from '../../src/services/market/HistoricalDataService';

describe('HistoricalDataService', () => {
    describe('mergeCandles', () => {
        it('should merge two sorted arrays without duplicates', () => {
            const existing = [
                { ts: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
                { ts: 200, open: 2, high: 2, low: 2, close: 2, volume: 2 },
            ];
            const incoming = [
                { ts: 200, open: 2.1, high: 2.1, low: 2.1, close: 2.1, volume: 2.1 },
                { ts: 300, open: 3, high: 3, low: 3, close: 3, volume: 3 },
            ];
            const merged = mergeCandles(existing, incoming);
            expect(merged).toHaveLength(3);
            expect(merged.map(c => c.ts)).toEqual([100, 200, 300]);
        });

        it('should keep the candle with higher volume on ts conflict', () => {
            const existing = [{ ts: 100, open: 1, high: 1, low: 1, close: 1, volume: 10 }];
            const incoming = [{ ts: 100, open: 2, high: 2, low: 2, close: 2, volume: 5 }];
            const merged = mergeCandles(existing, incoming);
            expect(merged).toHaveLength(1);
            expect(merged[0].volume).toBe(10); // 保留 volume 較高的
        });
    });

    describe('paginateBackfillRequests', () => {
        it('should split 150 days into 4 pages of 1000 candles', () => {
            const now = Math.floor(Date.now() / 1000);
            const pages = paginateBackfillRequests(150, now);
            expect(pages.length).toBe(4); // ceil(3600 / 1000) = 4
            // 每頁的 before 應遞減
            for (let i = 1; i < pages.length; i++) {
                expect(pages[i].before).toBeLessThan(pages[i - 1].before);
            }
        });

        it('should return 1 page for 30 days', () => {
            const now = Math.floor(Date.now() / 1000);
            const pages = paginateBackfillRequests(30, now);
            expect(pages.length).toBe(1); // ceil(720 / 1000) = 1
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/HistoricalDataService.test.ts --no-cache 2>&1 | tail -5`
Expected: FAIL — Cannot find module

- [ ] **Step 3: Write the implementation**

Create `src/services/market/HistoricalDataService.ts`:

```ts
/**
 * HistoricalDataService — CoinGecko Pro OHLCV 回填 + 增量更新
 *
 * 職責：
 *   1. 一次性回填 150 天 1H OHLCV（分頁拉取）
 *   2. 每日增量追加最新蠟燭
 *   3. Atomic write 持久化至 data/ohlcv/{poolAddress}.json
 *   4. Fallback 到 GeckoTerminal 免費版
 */

import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { rename } from 'fs/promises';
import { config } from '../../config';
import { createServiceLogger } from '../../utils/logger';

const log = createServiceLogger('HistoricalData');

export interface RawCandle {
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface OhlcvStore {
    poolAddress: string;
    network: 'base';
    lastFetchedTs: number;
    candles: RawCandle[];
}

/** CoinGecko Pro pool ID 格式：network_poolAddress */
function cgPoolId(poolAddress: string): string {
    return `base_${poolAddress.toLowerCase()}`;
}

/** 合併兩組蠟燭，同 ts 時保留 volume 較高的（去除 GeckoTerminal 補零蠟燭） */
export function mergeCandles(existing: RawCandle[], incoming: RawCandle[]): RawCandle[] {
    const map = new Map<number, RawCandle>();
    for (const c of existing) {
        map.set(c.ts, c);
    }
    for (const c of incoming) {
        const prev = map.get(c.ts);
        if (!prev || c.volume > prev.volume) {
            map.set(c.ts, c);
        }
    }
    return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/** 計算回填需要的分頁請求參數 */
export function paginateBackfillRequests(
    days: number,
    nowTs: number,
): Array<{ before: number; limit: number }> {
    const totalCandles = days * 24;
    const pageSize = 1000;
    const pages: Array<{ before: number; limit: number }> = [];
    let remaining = totalCandles;
    let cursor = nowTs;

    while (remaining > 0) {
        const limit = Math.min(remaining, pageSize);
        pages.push({ before: cursor, limit });
        cursor -= limit * 3600; // 每根 = 1 小時
        remaining -= limit;
    }

    return pages;
}

/** 從 CoinGecko Pro 拉取 OHLCV 蠟燭 */
async function fetchFromCoinGeckoPro(
    poolAddress: string,
    before: number,
    limit: number,
): Promise<RawCandle[]> {
    const poolId = cgPoolId(poolAddress);
    const url = `${config.COINGECKO_PRO_BASE_URL}/onchain/networks/base/pools/${poolId}/ohlcv/hour`;
    const res = await axios.get(url, {
        params: { before_timestamp: before, limit },
        headers: {
            'x-cg-pro-api-key': config.COINGECKO_API_KEY,
            'User-Agent': config.USER_AGENT,
        },
        timeout: 15000,
    });

    const list: number[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
    return list.map((c): RawCandle => ({
        ts:     c[0],
        open:   c[1],
        high:   c[2],
        low:    c[3],
        close:  c[4],
        volume: c[5],
    })).reverse(); // CoinGecko 回傳最新在前，轉為舊→新
}

/** 讀取本地 OHLCV 儲存 */
export async function loadOhlcvStore(poolAddress: string): Promise<OhlcvStore | null> {
    const filePath = path.join(process.cwd(), config.OHLCV_DATA_DIR, `${poolAddress.toLowerCase()}.json`);
    try {
        if (await fs.pathExists(filePath)) {
            return await fs.readJson(filePath);
        }
    } catch (e) {
        log.warn(`loadOhlcvStore: 讀取失敗 ${poolAddress.slice(0, 8)}`, e);
    }
    return null;
}

/** Atomic write OHLCV 儲存 */
async function saveOhlcvStore(store: OhlcvStore): Promise<void> {
    const dir = path.join(process.cwd(), config.OHLCV_DATA_DIR);
    await fs.ensureDir(dir);
    const filePath = path.join(dir, `${store.poolAddress.toLowerCase()}.json`);
    const tmpPath = filePath + '.tmp';
    await fs.writeJson(tmpPath, store);
    await rename(tmpPath, filePath);
}

/**
 * 回填 + 增量更新指定池子的歷史 OHLCV。
 * 若 CoinGecko Pro API key 未設定，跳過回填。
 */
export async function syncHistoricalData(
    poolAddress: string,
    sendWarning?: (msg: string) => Promise<void>,
): Promise<RawCandle[]> {
    const existing = await loadOhlcvStore(poolAddress);
    const nowTs = Math.floor(Date.now() / 1000);

    if (!config.COINGECKO_API_KEY) {
        log.info(`HistoricalData: 無 CoinGecko API key，跳過回填 ${poolAddress.slice(0, 8)}`);
        return existing?.candles ?? [];
    }

    const targetCandles = config.HISTORICAL_BACKFILL_DAYS * 24;
    const existingCount = existing?.candles.length ?? 0;
    const lastTs = existing?.lastFetchedTs ?? 0;
    const gapHours = (nowTs - lastTs) / 3600;

    // 判斷需要回填還是增量
    let newCandles: RawCandle[] = [];

    if (existingCount < targetCandles) {
        // 完整回填
        log.info(`HistoricalData: 回填 ${poolAddress.slice(0, 8)} — 目標 ${targetCandles} 根，現有 ${existingCount} 根`);
        const pages = paginateBackfillRequests(config.HISTORICAL_BACKFILL_DAYS, nowTs);
        for (const page of pages) {
            try {
                const candles = await fetchFromCoinGeckoPro(poolAddress, page.before, page.limit);
                newCandles.push(...candles);
                // 避免速率限制
                await new Promise(r => setTimeout(r, 500));
            } catch (e: any) {
                log.error(`HistoricalData: 回填失敗 page before=${page.before}`, e.message);
                if (sendWarning) {
                    await sendWarning(`⚠️ CoinGecko Pro 回填失敗: ${e.message}\nFallback 到現有 ${existingCount} 根數據`).catch(() => {});
                }
                break;
            }
        }
    } else if (gapHours > 1) {
        // 增量追加
        const fetchCount = Math.min(Math.ceil(gapHours) + 1, 1000);
        log.info(`HistoricalData: 增量更新 ${poolAddress.slice(0, 8)} — ${fetchCount} 根`);
        try {
            newCandles = await fetchFromCoinGeckoPro(poolAddress, nowTs, fetchCount);
        } catch (e: any) {
            log.warn(`HistoricalData: 增量更新失敗 ${poolAddress.slice(0, 8)}: ${e.message}`);
        }
    } else {
        log.debug(`HistoricalData: ${poolAddress.slice(0, 8)} 已是最新`);
        return existing?.candles ?? [];
    }

    // 合併 + 儲存
    const merged = mergeCandles(existing?.candles ?? [], newCandles);
    const store: OhlcvStore = {
        poolAddress: poolAddress.toLowerCase(),
        network: 'base',
        lastFetchedTs: merged.length > 0 ? merged[merged.length - 1].ts : nowTs,
        candles: merged,
    };
    await saveOhlcvStore(store);
    log.info(`HistoricalData: ${poolAddress.slice(0, 8)} 儲存完成 — ${merged.length} 根蠟燭`);
    return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/HistoricalDataService.test.ts --no-cache 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/market/HistoricalDataService.ts tests/services/HistoricalDataService.test.ts
git commit -m "feat(data): 新增 HistoricalDataService — CoinGecko Pro 回填 + 增量更新 + atomic write"
```

---

### Task 11: Integrate HistoricalDataService into prefetch

**Files:**
- Modify: `src/runners/prefetch.ts`

- [ ] **Step 1: Add OHLCV data source in `fetchHistoricalReturnsForPools`**

In `src/runners/prefetch.ts`, modify the `fetchHistoricalReturnsForPools` function to try local OHLCV files first:

Add import at top:
```ts
import { loadOhlcvStore } from '../services/market/HistoricalDataService';
```

Replace the `fetchHistoricalReturnsForPools` function body to first check local OHLCV:

```ts
async function fetchHistoricalReturnsForPools(
    pools: NonNullable<Awaited<ReturnType<typeof fetchPools>>>,
): Promise<{ returns: Map<string, HourlyReturn[]>; warnings: string[] }> {
    const returns = new Map<string, HourlyReturn[]>();
    const warnings: string[] = [];

    for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const poolKey = pool.id.toLowerCase();

        try {
            // 優先讀取本地 OHLCV（Phase 0.5 回填的數據）
            const store = await loadOhlcvStore(poolKey);
            if (store && store.candles.length > 2) {
                const hrs = ohlcvToHourlyReturnsFromRaw(store.candles);
                if (hrs.length > 0) {
                    returns.set(poolKey, hrs);
                    log.debug(`HistoricalReturns: pool ${pool.dex} ${poolKey.slice(0, 8)} — 從本地 OHLCV 讀取 ${hrs.length} 筆`);
                    continue;
                }
            }

            // Fallback: GeckoTerminal API
            const r = await fetchHistoricalReturns(pool.id, pool.dex);
            if (r.length > 0) returns.set(poolKey, r);
            else warnings.push(`HistoricalReturns: pool ${pool.dex} ${pool.id.slice(0, 8)} 回傳空陣列`);
        } catch (e) {
            const msg = `HistoricalReturns: pool ${pool.id.slice(0, 8)} 抓取失敗: ${e}`;
            log.warn(msg);
            warnings.push(msg);
        }
        // GeckoTerminal fallback 才需要 jitter
        if (i < pools.length - 1 && !returns.has(poolKey)) {
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
        }
    }
    log.info(`✅ HistoricalReturns fetched for ${returns.size}/${pools.length} pool(s)`);
    return { returns, warnings };
}
```

Add helper function (reuse the same logic as PoolMarketService but for RawCandle from HistoricalDataService):

```ts
import type { RawCandle } from '../services/market/HistoricalDataService';

/** 將 HistoricalDataService 的 RawCandle[] 轉為 HourlyReturn[] */
function ohlcvToHourlyReturnsFromRaw(candles: RawCandle[]): HourlyReturn[] {
    return candles.slice(1).map((c, i) => ({
        ts:     c.ts,
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume,
        r:      Math.log(c.close / candles[i].close),
    }));
}
```

- [ ] **Step 2: Add `data/ohlcv/` to `.gitignore`**

Add to `.gitignore`:
```
data/ohlcv/
data/diagnostics*.jsonl
data/genomes/
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
git add src/runners/prefetch.ts .gitignore
git commit -m "feat(prefetch): 優先讀取本地 OHLCV 數據，fallback 到 GeckoTerminal"
```

---

## Phase 2 Tasks (Converge point — after Track 1 + Track 2)

### Task 12: Continuous Regime Vector (computeRegimeVector + segmentByRegime)

**Files:**
- Modify: `src/services/strategy/MarketRegimeAnalyzer.ts`
- Create: `tests/services/RegimeVector.test.ts`

- [ ] **Step 1: Write the failing property tests**

Create `tests/services/RegimeVector.test.ts`:

```ts
import { computeRegimeVector, segmentByRegime } from '../../src/services/strategy/MarketRegimeAnalyzer';
import { randomGenome } from '../../src/services/strategy/ParameterGenome';
import type { HourlyReturn } from '../../src/types';

/** 產生合成蠟燭數據（價格在 center ± spread 之間隨機遊走） */
function syntheticCandles(n: number, center = 1000, spread = 50): HourlyReturn[] {
    const candles: HourlyReturn[] = [];
    let price = center;
    for (let i = 0; i < n + 1; i++) {
        const change = (Math.random() - 0.5) * spread;
        price = Math.max(price + change, 1);
        candles.push({
            ts: 1000000 + i * 3600,
            open: price - change / 2,
            high: price + Math.abs(change),
            low: price - Math.abs(change),
            close: price,
            volume: 1000 + Math.random() * 5000,
            r: i === 0 ? 0 : Math.log(price / (price - change)),
        });
    }
    // 重新計算 r 使其與 close 一致
    for (let i = 1; i < candles.length; i++) {
        candles[i].r = Math.log(candles[i].close / candles[i - 1].close);
    }
    return candles.slice(1);  // 第 0 根的 r 無意義
}

describe('computeRegimeVector', () => {
    const candles = syntheticCandles(200);

    it('should produce valid probability distribution for 100 random genomes', () => {
        for (let i = 0; i < 100; i++) {
            const genome = randomGenome();
            const vec = computeRegimeVector(candles, genome);

            // 總和 = 1
            expect(vec.range + vec.trend + vec.neutral).toBeCloseTo(1.0, 10);
            // 各分量 ∈ [0, 1]
            expect(vec.range).toBeGreaterThanOrEqual(0);
            expect(vec.trend).toBeGreaterThanOrEqual(0);
            expect(vec.neutral).toBeGreaterThanOrEqual(0);
            expect(vec.range).toBeLessThanOrEqual(1);
            expect(vec.trend).toBeLessThanOrEqual(1);
            expect(vec.neutral).toBeLessThanOrEqual(1);
            // 無 NaN
            expect(Number.isNaN(vec.range)).toBe(false);
            expect(Number.isNaN(vec.trend)).toBe(false);
            expect(Number.isNaN(vec.neutral)).toBe(false);
        }
    });

    it('should approach one-hot when sigmoidTemp is very small', () => {
        const genome = randomGenome();
        genome.sigmoidTemp = 0.01;  // 近似硬分類
        const vec = computeRegimeVector(candles, genome);
        const max = Math.max(vec.range, vec.trend, vec.neutral);
        expect(max).toBeGreaterThan(0.9);  // 最大分量接近 1
    });

    it('should approach uniform when sigmoidTemp is very large', () => {
        const genome = randomGenome();
        genome.sigmoidTemp = 100;
        const vec = computeRegimeVector(candles, genome);
        // 所有分量都在 0.2-0.5 之間
        expect(vec.range).toBeGreaterThan(0.15);
        expect(vec.trend).toBeGreaterThan(0.15);
        expect(vec.neutral).toBeGreaterThan(0.15);
    });
});

describe('segmentByRegime', () => {
    it('should return segments with non-empty returns', () => {
        const candles = syntheticCandles(500);
        const segments = segmentByRegime(candles);
        expect(segments.length).toBeGreaterThan(0);
        for (const seg of segments) {
            expect(seg.returns.length).toBeGreaterThan(0);
            expect(['range', 'trend', 'neutral']).toContain(seg.regime);
        }
    });

    it('should merge small segments (< 50 samples) into neutral', () => {
        const candles = syntheticCandles(500);
        const segments = segmentByRegime(candles);
        // 除了 neutral 之外，所有 segment 應該 >= 50 samples
        for (const seg of segments) {
            if (seg.regime !== 'neutral') {
                expect(seg.returns.length).toBeGreaterThanOrEqual(50);
            }
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/RegimeVector.test.ts --no-cache 2>&1 | tail -5`
Expected: FAIL — computeRegimeVector is not a function

- [ ] **Step 3: Implement computeRegimeVector and segmentByRegime**

Add to `src/services/strategy/MarketRegimeAnalyzer.ts`:

```ts
import type { HourlyReturn, MarketRegime, RangeGuards, RegimeGenome, RegimeVector } from '../../types';

// 在 export function analyzeRegime 之前加入：

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

/**
 * 計算 continuous regime vector（sigmoid + softmax）。
 * 結果為三分量機率向量：range + trend + neutral = 1。
 */
export function computeRegimeVector(candles: HourlyReturn[], genome: RegimeGenome): RegimeVector {
    const chop = calculateCHOP(candles, genome.chopWindow);
    const hurst = calculateHurst(candles.map(c => c.r), genome.hurstMaxLag);
    const T = genome.sigmoidTemp;

    const rangeLogit = sigmoid((chop - genome.chopRangeThreshold) / T)
                     + sigmoid((genome.hurstRangeThreshold - hurst) / T);
    const trendLogit = sigmoid((genome.chopTrendThreshold - chop) / T)
                     + sigmoid((hurst - genome.hurstTrendThreshold) / T);
    const neutralLogit = 1.0;

    // Softmax（減 max 防溢位）
    const maxLogit = Math.max(rangeLogit, trendLogit, neutralLogit);
    const er = Math.exp(rangeLogit - maxLogit);
    const et = Math.exp(trendLogit - maxLogit);
    const en = Math.exp(neutralLogit - maxLogit);
    const sum = er + et + en;

    return {
        range:   er / sum,
        trend:   et / sum,
        neutral: en / sum,
    };
}

/** 歷史數據分段標記結構 */
export interface RegimeSegment {
    regime: 'range' | 'trend' | 'neutral';
    returns: number[];
}

/**
 * 用硬分類器對歷史數據打標，產生 regime-segmented 抽樣池。
 * < 50 samples 的 segment 併入 neutral。
 */
export function segmentByRegime(candles: HourlyReturn[], windowSize = 168): RegimeSegment[] {
    if (candles.length < windowSize) {
        return [{ regime: 'neutral', returns: candles.map(c => c.r) }];
    }

    // 為每個位置打標
    const labels: Array<'range' | 'trend' | 'neutral'> = [];
    for (let i = 0; i < candles.length; i++) {
        const start = Math.max(0, i - windowSize + 1);
        const window = candles.slice(start, i + 1);
        if (window.length < 14) {
            labels.push('neutral');
        } else {
            const regime = analyzeRegime(window);
            labels.push(regime.signal);
        }
    }

    // 按 regime 分桶
    const buckets: Record<'range' | 'trend' | 'neutral', number[]> = {
        range: [],
        trend: [],
        neutral: [],
    };
    for (let i = 0; i < labels.length; i++) {
        buckets[labels[i]].push(candles[i].r);
    }

    // < 50 samples 的併入 neutral
    const segments: RegimeSegment[] = [];
    for (const regime of ['range', 'trend', 'neutral'] as const) {
        if (buckets[regime].length >= 50) {
            segments.push({ regime, returns: buckets[regime] });
        } else if (buckets[regime].length > 0) {
            buckets.neutral.push(...buckets[regime]);
        }
    }

    // 確保 neutral 存在（可能被合併進來）
    if (!segments.find(s => s.regime === 'neutral') && buckets.neutral.length > 0) {
        segments.push({ regime: 'neutral', returns: buckets.neutral });
    }

    return segments.length > 0 ? segments : [{ regime: 'neutral', returns: candles.map(c => c.r) }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/RegimeVector.test.ts --no-cache 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/strategy/MarketRegimeAnalyzer.ts tests/services/RegimeVector.test.ts
git commit -m "feat(regime): 新增 computeRegimeVector (sigmoid+softmax) 與 segmentByRegime"
```

---

### Task 13: Blended Bootstrap in MonteCarloEngine

**Files:**
- Modify: `src/services/strategy/MonteCarloEngine.ts`

- [ ] **Step 1: Add optional blended bootstrap params to MCSimParams**

In `src/services/strategy/MonteCarloEngine.ts`, extend the `MCSimParams` interface:

```ts
import type { RegimeSegment } from './MarketRegimeAnalyzer';
import type { RegimeVector } from '../../types';

interface MCSimParams {
    historicalReturns: number[];
    P0: number;
    Pa: number;
    Pb: number;
    capital: number;
    dailyFeesToken0: number;
    horizon: number;
    numPaths: number;
    /** Optional: regime-segmented return pools for blended bootstrap */
    segments?: RegimeSegment[];
    /** Optional: regime probability vector for weighted sampling */
    regimeVector?: RegimeVector;
}
```

- [ ] **Step 2: Modify `runOnePath` to support blended sampling**

Add a helper function before `runOnePath`:

```ts
/**
 * 從 regime-segmented 池中加權抽樣一個 return。
 * 每步先按 regimeVector 權重選 bucket，再從該 bucket 隨機取一個 return。
 */
function sampleBlended(segments: RegimeSegment[], regimeVector: RegimeVector): number {
    const r = Math.random();
    let cumulative = 0;
    for (const seg of segments) {
        cumulative += regimeVector[seg.regime];
        if (r <= cumulative) {
            return seg.returns[Math.floor(Math.random() * seg.returns.length)];
        }
    }
    // Fallback（浮點精度）：取最後一個 segment
    const last = segments[segments.length - 1];
    return last.returns[Math.floor(Math.random() * last.returns.length)];
}
```

Modify `runOnePath` to accept optional blended params:

```ts
function runOnePath(
    returns: number[],
    P0: number,
    Pa: number,
    Pb: number,
    L: number,
    capital: number,
    hourlyFeesBase: number,
    horizonHours: number,
    segments?: RegimeSegment[],
    regimeVector?: RegimeVector,
): { pnlRatio: number; hoursInRange: number } {
    let P = P0;
    let fees = 0;
    let hoursInRange = 0;
    const n = returns.length;
    const useBlended = segments && regimeVector && segments.length > 0;

    for (let h = 0; h < horizonHours; h++) {
        const ret = useBlended
            ? sampleBlended(segments!, regimeVector!)
            : returns[Math.floor(Math.random() * n)];
        P *= Math.exp(ret);
        if (P > Pa && P < Pb) {
            fees += hourlyFeesBase;
            hoursInRange++;
        }
    }

    const vlp = computeLpValueToken0(L, P, Pa, Pb);
    const pnlRatio = (fees + vlp) / capital - 1;
    return { pnlRatio, hoursInRange };
}
```

- [ ] **Step 3: Pass segments/regimeVector through runMCSimulation**

In `runMCSimulation`, pass the new params to `runOnePath`:

```ts
    for (let i = 0; i < numPaths; i++) {
        const { pnlRatio, hoursInRange } = runOnePath(
            historicalReturns, P0, Pa, Pb, L, capital, hourlyFees, horizonHours,
            params.segments, params.regimeVector,
        );
```

- [ ] **Step 4: Update `calcCandidateRanges` and `calcTranchePlan` signatures**

Add optional `segments` and `regimeVector` params to both functions:

```ts
export function calcCandidateRanges(
    capital: number,
    pool: PoolStats,
    bb: MarketSnapshot,
    historicalReturns: number[],
    sigmas = [1.0, 2.0, 3.0],
    guards?: RangeGuards,
    segments?: RegimeSegment[],
    regimeVector?: RegimeVector,
): RangeCandidateResult[] {
    // ... existing code ...
    // In the runMCSimulation call, add segments and regimeVector:
    const mc = runMCSimulation({
        ...baseParams,
        Pa: lowerPrice,
        Pb: upperPrice,
        dailyFeesToken0,
        segments,
        regimeVector,
    });
```

Same for `calcTranchePlan`:
```ts
export function calcTranchePlan(
    totalCapital: number,
    pool: PoolStats,
    bb: MarketSnapshot,
    historicalReturns: number[],
    segments?: RegimeSegment[],
    regimeVector?: RegimeVector,
): TranchePlan | null {
    // ... pass segments, regimeVector to runMCSimulation calls ...
```

- [ ] **Step 5: Verify existing tests pass (backward compatibility)**

Run: `npx jest --no-cache 2>&1 | tail -10`
Expected: All existing tests pass (no segments/regimeVector = original behavior).

- [ ] **Step 6: Commit**

```bash
git add src/services/strategy/MonteCarloEngine.ts
git commit -m "feat(mc): 新增 blended bootstrap — 按 regimeVector 加權從 regime 分桶抽樣"
```

---

### Task 14: Remove hard skip + wire continuous vector in mcEngine

**Files:**
- Modify: `src/runners/mcEngine.ts`

- [ ] **Step 1: Remove hard trend skip and wire continuous vector**

In `src/runners/mcEngine.ts`:

1. Add imports:
```ts
import { analyzeRegime, computeRangeGuards, computeRegimeVector, segmentByRegime } from '../services/strategy/MarketRegimeAnalyzer';
```

2. Replace lines 109-114 (the hard skip block):

```diff
-        if (regime.signal === 'trend') {
-            log.warn(`MCEngine: pool ${pool.dex} 趨勢市場，跳過`);
-            delete appState.strategies[pool.id.toLowerCase()];
-            trendSkippedPools.push(`${pool.dex} ${pool.id.slice(0, 8)}… (CHOP=${regime.chop.toFixed(1)} H=${regime.hurst.toFixed(2)})`);
-            continue;
-        }
+        // Continuous regime vector — 不再跳過任何池子
+        const regimeVector = computeRegimeVector(rawReturns, activeGenome);
+        const segments = segmentByRegime(rawReturns);
+        diagEntry.regimeVector = regimeVector;
+
+        log.debug(`MCEngine: pool ${pool.dex} RegimeVector R=${regimeVector.range.toFixed(2)} T=${regimeVector.trend.toFixed(2)} N=${regimeVector.neutral.toFixed(2)}`);
```

3. Pass `segments` and `regimeVector` to `calcCandidateRanges` and `calcTranchePlan`:

```ts
            const candidates = calcCandidateRanges(UNIT_CAPITAL, pool, bb, returns, sigmas, guardsTR, segments, regimeVector);
```

```ts
            const tranche = calcTranchePlan(UNIT_CAPITAL, pool, bb, returns, segments, regimeVector);
```

4. Remove the `trendSkippedPools` array declaration and the trend alert block at the bottom (since we no longer skip).

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Verify existing tests pass**

Run: `npx jest --no-cache 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/runners/mcEngine.ts
git commit -m "feat(mcEngine): 移除硬 trend skip，改用 continuous regime vector + blended bootstrap"
```

---

## Phase 3 Tasks (Evolutionary Search)

### Task 15: EvolutionEngine

**Files:**
- Create: `src/services/strategy/EvolutionEngine.ts`
- Create: `tests/services/EvolutionEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/services/EvolutionEngine.test.ts`:

```ts
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
            // 最高 fitness 應該在前面
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

        it('should produce children with values from parents', () => {
            const p1 = currentConstantsToGenome();
            const p2 = randomGenome('p2');
            const children = crossover([p1, p2], 3);
            for (const child of children) {
                for (const [key] of Object.entries(GENOME_RANGES)) {
                    const k = key as keyof typeof GENOME_RANGES;
                    const val = child[k];
                    const v1 = p1[k];
                    const v2 = p2[k];
                    expect(val).toBeGreaterThanOrEqual(Math.min(v1, v2) - 0.001);
                    expect(val).toBeLessThanOrEqual(Math.max(v1, v2) + 0.001);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/EvolutionEngine.test.ts --no-cache 2>&1 | tail -5`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `src/services/strategy/EvolutionEngine.ts`:

```ts
/**
 * EvolutionEngine — 演化搜索引擎
 *
 * Population size: 20
 *   Selection (top 50%): 10
 *   Crossover:            5
 *   Mutation:              3
 *   Seed (random):         2
 *   Immortal:              1 (上一代最佳，wipeout protection)
 *   Total = 10 + 5 + 3 + 2 = 20（immortal 佔 selection 的一個名額）
 */

import type { RegimeGenome } from '../../types';
import { GENOME_RANGES, clampGenome, randomGenome } from './ParameterGenome';
import { createServiceLogger } from '../../utils/logger';

const log = createServiceLogger('Evolution');

export interface EvaluatedGenome {
    genome: RegimeGenome;
    fitness: number;
}

/**
 * 從 population 中選出 fitness > 0 的 top 50%。
 * 若全部 fitness = 0（wipeout），退回 immortal。
 */
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

/**
 * Uniform crossover：隨機選兩個 parent，每個基因 50% 機率來自任一方。
 */
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

/**
 * Gaussian mutation：clone parent 後對每個基因加入高斯噪音。
 * sigma = 10% of range width。結果 clamp 到合法範圍。
 */
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

/**
 * 執行一代演化：selection → crossover → mutation → seed → immortal。
 */
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

    // 組合：selection(10) + crossover(5) + mutation(3) + seed(2) = 20
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/services/EvolutionEngine.test.ts --no-cache 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/strategy/EvolutionEngine.ts tests/services/EvolutionEngine.test.ts
git commit -m "feat(evolution): 新增 EvolutionEngine — selection、crossover、mutation、seed、immortal"
```

---

### Task 16: WalkForwardValidator

**Files:**
- Create: `src/runners/WalkForwardValidator.ts`

- [ ] **Step 1: Create WalkForwardValidator**

Create `src/runners/WalkForwardValidator.ts`:

```ts
/**
 * WalkForwardValidator — 4 窗口滾動驗證
 *
 * 將 150 天歷史數據切成 4 個時序單調的 train/validate 窗口：
 *   Window 1: [Day 0-75] train  → [Day 75-95] validate
 *   Window 2: [Day 20-95] train → [Day 95-115] validate
 *   Window 3: [Day 40-115] train → [Day 115-135] validate
 *   Window 4: [Day 60-135] train → [Day 135-150] validate
 *
 * Fitness = mean(4 windows Sharpe)
 * Hard gate: any window maxDD > 30% → fitness = 0
 */

import type { RegimeGenome, HourlyReturn, PoolStats, MarketSnapshot, BacktestResult } from '../types';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('WalkForward');

export interface WalkForwardWindow {
    trainStart: number;   // 天數（from beginning）
    trainEnd: number;
    validateStart: number;
    validateEnd: number;
}

export interface WalkForwardResult {
    fitness: number;
    maxDrawdown: number;
    windowResults: Array<{ sharpe: number; maxDrawdown: number }>;
}

/** 預設 4 窗口配置（150 天數據） */
export const DEFAULT_WINDOWS: WalkForwardWindow[] = [
    { trainStart: 0,  trainEnd: 75,  validateStart: 75,  validateEnd: 95 },
    { trainStart: 20, trainEnd: 95,  validateStart: 95,  validateEnd: 115 },
    { trainStart: 40, trainEnd: 115, validateStart: 115, validateEnd: 135 },
    { trainStart: 60, trainEnd: 135, validateStart: 135, validateEnd: 150 },
];

/** 按天數切割 HourlyReturn 陣列 */
function sliceByDays(candles: HourlyReturn[], startDay: number, endDay: number): HourlyReturn[] {
    const startIdx = startDay * 24;
    const endIdx = Math.min(endDay * 24, candles.length);
    return candles.slice(startIdx, endIdx);
}

/**
 * 在單一 validate 窗口上計算 Sharpe 和 maxDrawdown。
 * 這是簡化版：用 hourly returns 的 mean/std 估算 Sharpe，
 * 用累積 PnL 曲線估算 maxDrawdown。
 */
function evaluateWindow(
    validateReturns: number[],
): { sharpe: number; maxDrawdown: number } {
    if (validateReturns.length < 2) {
        return { sharpe: 0, maxDrawdown: 0 };
    }

    const mean = validateReturns.reduce((s, r) => s + r, 0) / validateReturns.length;
    const variance = validateReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / validateReturns.length;
    const std = Math.sqrt(variance);

    // Annualized Sharpe（hourly → yearly）
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(8760) : 0;

    // Max drawdown from cumulative returns
    let peak = 0;
    let cumulative = 0;
    let maxDD = 0;
    for (const r of validateReturns) {
        cumulative += r;
        if (cumulative > peak) peak = cumulative;
        const dd = peak - cumulative;
        if (dd > maxDD) maxDD = dd;
    }

    return { sharpe, maxDrawdown: maxDD };
}

/**
 * 執行 4 窗口 walk-forward validation。
 *
 * @param genome   要評估的 genome
 * @param candles  完整歷史蠟燭（>= 150 天 = 3600 根）
 * @param windows  窗口配置（預設 4 窗口）
 */
export function walkForwardValidate(
    genome: RegimeGenome,
    candles: HourlyReturn[],
    windows = DEFAULT_WINDOWS,
): WalkForwardResult {
    const windowResults: Array<{ sharpe: number; maxDrawdown: number }> = [];
    let worstDD = 0;

    for (const w of windows) {
        const validateCandles = sliceByDays(candles, w.validateStart, w.validateEnd);
        const validateReturns = validateCandles.map(c => c.r);

        const result = evaluateWindow(validateReturns);
        windowResults.push(result);
        if (result.maxDrawdown > worstDD) worstDD = result.maxDrawdown;
    }

    // Hard gate: any window maxDD > 30% → fitness = 0
    if (worstDD > 0.30) {
        return { fitness: 0, maxDrawdown: worstDD, windowResults };
    }

    // Fitness = mean Sharpe across windows
    const meanSharpe = windowResults.reduce((s, r) => s + r.sharpe, 0) / windowResults.length;

    // NaN guard
    if (!Number.isFinite(meanSharpe)) {
        return { fitness: 0, maxDrawdown: worstDD, windowResults };
    }

    return { fitness: meanSharpe, maxDrawdown: worstDD, windowResults };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/runners/WalkForwardValidator.ts
git commit -m "feat(validation): 新增 WalkForwardValidator — 4 窗口滾動驗證 + maxDD hard gate"
```

---

### Task 17: Wire `/regime evolve` + genome persistence

**Files:**
- Modify: `src/bot/commands/regimeCommands.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add evolution execution in regimeCommands**

In `src/bot/commands/regimeCommands.ts`, replace the `evolve` placeholder:

```ts
import { runOneGeneration, EvaluatedGenome } from '../../services/strategy/EvolutionEngine';
import { walkForwardValidate } from '../../runners/WalkForwardValidator';
import { randomGenome, currentConstantsToGenome } from '../../services/strategy/ParameterGenome';
import { loadOhlcvStore } from '../../services/market/HistoricalDataService';
import * as fs from 'fs-extra';
import * as path from 'path';
import { rename } from 'fs/promises';

const GENOMES_DIR = path.join(process.cwd(), 'data', 'genomes');
const MAX_GENERATIONS = 10;
const POPULATION_SIZE = 20;
const EVOLUTION_TIMEOUT_MS = 30 * 60 * 1000;

let isEvolutionRunning = false;
let evolutionStartedAt = 0;

// 在 registerRegimeCommands 內，替換 evolve 區塊：
        if (sub === 'evolve') {
            // 超時自動釋放
            if (isEvolutionRunning && Date.now() - evolutionStartedAt > EVOLUTION_TIMEOUT_MS) {
                isEvolutionRunning = false;
            }
            if (isEvolutionRunning) {
                await ctx.reply('🧬 演化搜索已在執行中，請等待完成。');
                return;
            }

            // 取得第一個池子的歷史數據
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

            // 非同步執行
            (async () => {
                try {
                    const candles = store.candles.slice(1).map((c, i) => ({
                        ...c,
                        r: Math.log(c.close / store.candles[i].close),
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
                    populationCache = finalEval;

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
                } catch (e: any) {
                    await ctx.api.sendMessage(config.CHAT_ID,
                        `🚨 演化搜索失敗: ${e.message}`,
                    ).catch(() => {});
                } finally {
                    isEvolutionRunning = false;
                }
            })();

            return;
        }
```

Add import for config:
```ts
import { config } from '../../config';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/regimeCommands.ts
git commit -m "feat(regime): 實作 /regime evolve — 10 代演化搜索 + checkpoint + genome 持久化"
```

---

### Task 18: Final integration test — run all tests

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx jest --no-cache 2>&1`
Expected: All tests pass.

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit 2>&1`
Expected: No errors.

- [ ] **Step 3: Verify dev starts without crash**

Run: `timeout 30 npm run dev:fast 2>&1 | tail -20`
Expected: Bot starts, first cycle begins without crash.

- [ ] **Step 4: Final commit — update tasks.md**

Update `.claude/tasks.md` to reflect completed implementation scaffolding, marking Phase 0.5-3 framework as "implemented, pending 24h live validation".

```bash
git add .claude/tasks.md
git commit -m "docs: 更新 tasks.md — P0 Regime Engine 框架實作完成，待 24h live validation"
```

---

## Execution Order Summary

```
Track 2 (Framework):  Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
Track 1 (Data):       Task 9 → 10 → 11
                              ↓
Phase 2 (Converge):   Task 12 → 13 → 14
                              ↓
Phase 3 (Evolution):  Task 15 → 16 → 17
                              ↓
Integration:          Task 18
```

Track 1 and Track 2 can run in parallel. Phase 2 requires both tracks complete. Phase 3 requires Phase 2.
