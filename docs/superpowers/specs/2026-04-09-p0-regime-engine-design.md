# P0 Self-Learning Regime Engine — Design Spec

> Status: Approved
> Date: 2026-04-09
> Approach: Parallel dual-track (Phase 0.5 data + Phase 1 framework in parallel)

---

## Problem Statement

DexBot's current regime classification uses hard thresholds (CHOP > 55 && Hurst < 0.52 = range, CHOP < 45 || Hurst > 0.65 = trend). This causes:

1. **Excessive pool skipping** — `mcEngine.ts:109-114` hard-skips all trend-signal pools, so the MC engine frequently produces no strategies.
2. **Binary gate fragility** — A pool at CHOP=54.9 gets no strategy while CHOP=55.1 gets one.
3. **Static parameters** — Thresholds are hand-tuned constants that never adapt to changing market conditions.
4. **Insufficient data** — Only 720 hours (30 days) of historical data, not enough for meaningful walk-forward validation.

## Architecture Decisions (Locked)

These decisions come from prior CEO + Eng review and are NOT open for revision:

- Fully soft CVaR gate — remove hard trend skip, let blended bootstrap naturally reflect regime risk
- Continuous Regime Vector (sigmoid + softmax) replaces hard `'range' | 'trend' | 'neutral'`
- MVP scope: only evolve RegimeGenome (9 params), LPStrategyGenome stays manual
- Fitness: backtest Sharpe + maxDD gate, switch to real P&L after mirror data accumulates
- Paid API (CoinGecko Pro) for 150+ day historical data
- Files integrate into existing `runners/` and `services/`, no new `evolution/` directory

## Execution Strategy

**Parallel Dual-Track:**

- **Track 1 (Data):** Phase 0.5 — CoinGecko Pro integration, backfill 150 days
- **Track 2 (Framework):** Phase 1 — BacktestHarness + RegimeGenome types + Telegram commands, validated with existing 30-day data

Tracks converge at Phase 2 when both data and framework are ready.

```
Track 1: [Phase 0.5 — Data Pipeline]─────────────────┐
                                                       ├→ Phase 2 → Phase 2.5 → Phase 3
Track 2: [Phase 1 — Harness + Genome + Commands]──────┘
```

---

## Phase 0.5 — CoinGecko Pro Data Pipeline

### Data Flow

```
CoinGecko Pro API (1H OHLCV, 365 days)
    |
fetchHistoricalBackfill()         <- one-time backfill
    |
data/ohlcv/{poolAddress}.json    <- incremental accumulation, atomic write
    |
dailyIncrementalFetch()          <- daily cron appends latest 24 candles
    |
prefetch.ts reads -> historicalReturns Map
```

### Design Decisions

1. **Storage format:** Single JSON per pool (`data/ohlcv/{poolAddress}.json`), using stateManager's atomic write pattern (write `.tmp` -> rename).

   ```ts
   interface OhlcvStore {
     poolAddress: string;
     network: 'base';
     lastFetchedTs: number;
     candles: RawCandle[];  // oldest-first
   }
   ```

2. **Backfill strategy:** CoinGecko Pro `/ohlcv/hour` endpoint returns max 1000 candles per request. 150 days = 3600 candles requires 4 paginated requests using `before` parameter.

3. **Incremental update:** On startup, compare `lastFetchedTs` with current time, fetch only the gap. Dedup using existing logic (same ts -> keep highest |r|).

4. **Dynamic `HISTORICAL_RETURNS_HOURS`:** Change from fixed 720 in config to dynamic based on `OhlcvStore.candles.length`. BacktestHarness and live pipeline each specify their own window size.

5. **Fallback:** CoinGecko Pro failure -> degrade to GeckoTerminal free tier (existing logic) + Telegram warning.

### Files

| Action | File | Description |
|--------|------|-------------|
| New    | `src/services/market/HistoricalDataService.ts` | Backfill + incremental fetch + atomic write |
| Modify | `src/runners/prefetch.ts` | Read from `data/ohlcv/` instead of direct GeckoTerminal call |
| Modify | `src/config/constants.ts` | Add `COINGECKO_PRO_BASE_URL`, make `HISTORICAL_RETURNS_HOURS` dynamic |
| Modify | `.env` | Add `COINGECKO_API_KEY` |
| New    | `data/ohlcv/` | gitignore, actual data not in repo |

### Gate Test

- [ ] After backfill: `candles.length >= 3600` (150 days)
- [ ] After incremental fetch: no duplicate timestamps
- [ ] On network failure: falls back to GeckoTerminal + Telegram receives warning

---

## Phase 1 — BacktestHarness + RegimeGenome Type System

### Type Definitions (`src/types/index.ts`)

```ts
/** Tunable parameters for regime classification (evolution target) */
interface RegimeGenome {
  // CHOP thresholds
  chopRangeThreshold: number;    // current: 55, search range [45, 70]
  chopTrendThreshold: number;    // current: 45, search range [30, 55]
  chopWindow: number;            // current: 14, search range [7, 28]
  // Hurst thresholds
  hurstRangeThreshold: number;   // current: 0.52, search range [0.40, 0.60]
  hurstTrendThreshold: number;   // current: 0.65, search range [0.55, 0.80]
  hurstMaxLag: number;           // current: 20, search range [10, 40]
  // Sigmoid temperature (Phase 2, fixed in Phase 1)
  sigmoidTemp: number;           // default: 1.0, search range [0.1, 5.0]
  // ATR
  atrWindow: number;             // current: 14, search range [7, 28]
  // CVaR safety factor
  cvarSafetyFactor: number;      // current: config value, search range [1.0, 5.0]
}

/** Continuous regime vector (Phase 2 enables, Phase 1 uses one-hot from hard classification) */
interface RegimeVector {
  range: number;    // [0, 1], softmax sum = 1
  trend: number;
  neutral: number;
}

/** Per-pool backtest detail */
interface PoolBacktestResult {
  poolAddress: string;
  sigmaOpt: number;
  score: number;
  cvar95: number;
  go: boolean;
  inRangePct: number;
  pnlRatio: number;
}

/** Single backtest result (aggregated across all pools) */
interface BacktestResult {
  sharpe: number;
  maxDrawdown: number;
  inRangePct: number;
  totalReturn: number;
  poolResults: Map<string, PoolBacktestResult>;
}
```

### ParameterGenome Module (`src/services/strategy/ParameterGenome.ts`)

Responsibilities:
- `GENOME_RANGES`: `[min, max]` definition per parameter
- `currentConstantsToGenome()`: convert existing hard-coded constants to genome (baseline)
- `serializeGenome()` / `deserializeGenome()`: JSON serialization
- `clampGenome()`: ensure all parameters within legal range

### BacktestHarness (`src/runners/BacktestHarness.ts`)

```
Input: RegimeGenome + HourlyReturn[] + PoolStats[]
  |
1. Override analyzeRegime thresholds with genome params
  |
2. Run regime -> MC pipeline (same logic as live)
  |
3. Simulate PnL accumulation over horizon
  |
Output: BacktestResult { sharpe, maxDrawdown, inRangePct, totalReturn }
```

**Key design:** BacktestHarness is NOT a rewrite of the MC pipeline. It CALLS existing `calcCandidateRanges` + `runMCSimulation` with injected genome parameters. This ensures harness and live pipeline logic are always identical.

Implementation: `analyzeRegime` and `computeRangeGuards` gain an optional `genome` parameter:

```ts
// MarketRegimeAnalyzer.ts — backward-compatible modification
export function analyzeRegime(
  candles: HourlyReturn[],
  genome?: RegimeGenome    // new, omit = use existing constants
): MarketRegime { ... }
```

### Telegram Commands (`src/bot/commands/regimeCommands.ts`)

| Command | Description |
|---------|-------------|
| `/regime status` | Show current active genome params + per-pool regime vector |
| `/regime candidates` | List top 5 genomes from latest evolution + fitness |
| `/regime apply <id>` | Hot-swap genome, affects next `runMCEngine` cycle only |

Hot-swap semantics: write to `appState.activeGenome`, `mcEngine.ts` reads it on next cycle.

### Baseline Equivalence Test (Phase 1 Gate)

Statistical equivalence via KS two-sample test (p > 0.05), run 50 iterations each for harness and live pipeline with identical input data.

### Files

| Action | File |
|--------|------|
| Modify | `src/types/index.ts` — add RegimeGenome, RegimeVector, BacktestResult |
| New    | `src/services/strategy/ParameterGenome.ts` |
| New    | `src/runners/BacktestHarness.ts` |
| Modify | `src/services/strategy/MarketRegimeAnalyzer.ts` — genome parameter injection |
| New    | `src/bot/commands/regimeCommands.ts` |
| New    | `__tests__/BacktestHarness.baseline.test.ts` |

### Gate Test

- [ ] Baseline genome (from current constants) produces statistically equivalent results to live pipeline (KS test p > 0.05)
- [ ] Grid search over 3x3 genome variations produces different but valid BacktestResults

---

## Phase 2 — Continuous Regime Vector + Remove Hard Skip

### Sigmoid + Softmax Transform

```ts
export function computeRegimeVector(
  candles: HourlyReturn[],
  genome: RegimeGenome
): RegimeVector {
  const chop = calculateCHOP(candles, genome.chopWindow);
  const hurst = calculateHurst(candles.map(c => c.r), genome.hurstMaxLag);
  const T = genome.sigmoidTemp;

  // Per-regime logit (further from threshold = stronger signal)
  const rangeLogit = sigmoid((chop - genome.chopRangeThreshold) / T)
                   + sigmoid((genome.hurstRangeThreshold - hurst) / T);
  const trendLogit = sigmoid((genome.chopTrendThreshold - chop) / T)
                   + sigmoid((hurst - genome.hurstTrendThreshold) / T);
  const neutralLogit = 1.0;  // baseline anchor

  return softmax(rangeLogit, trendLogit, neutralLogit);
}
```

Design notes:
- `sigmoidTemp` controls soft/hard: T -> 0 degrades to hard classification (current behavior), T -> inf = uniform
- `neutralLogit = 1.0` as anchor prevents all three logits from drifting
- `exp(x - max)` overflow protection in softmax

### History Segmentation (`segmentByRegime`)

Uses existing hard classifier to label 150-day history, providing regime-segmented sampling pools for blended bootstrap. Segments with < 50 samples merge into neutral.

### Blended Bootstrap (`MonteCarloEngine.ts`)

`runMCSimulation` gains optional `segments` + `regimeVector` parameters:
- With segments + regimeVector: each bootstrap step first picks a regime bucket by vector weights, then samples from that bucket's returns
- Without: falls back to original behavior (uniform sampling from all returns)

**Backward compatible:** omitting segments/regimeVector = existing behavior unchanged.

### Call Chain Impact (4 files)

```
mcEngine.ts
  -> calcCandidateRanges()   <- pass segments + regimeVector
       -> runMCSimulation()  <- uses blended bootstrap
  -> calcTranchePlan()       <- same
BacktestHarness.ts            <- same
```

### Remove Hard Skip (`mcEngine.ts:109-114`)

```diff
- if (regime.signal === 'trend') {
-     log.warn(`MCEngine: pool ${pool.dex} ...`);
-     delete appState.strategies[pool.id.toLowerCase()];
-     trendSkippedPools.push(...);
-     continue;
- }
+ // Continuous regime vector — no more pool skipping
+ // High trend weight -> blended bootstrap samples more trend returns
+ // -> wilder price paths -> worse CVaR -> naturally wider ranges or no-go
+ const regimeVector = computeRegimeVector(rawReturns, activeGenome);
+ const segments = segmentByRegime(rawReturns);
```

This IS the "fully soft CVaR gate" — trend markets are not skipped but naturally reflected via CVaR.

### Files

| Action | File |
|--------|------|
| Modify | `src/services/strategy/MarketRegimeAnalyzer.ts` — add `computeRegimeVector`, `segmentByRegime` |
| Modify | `src/services/strategy/MonteCarloEngine.ts` — blended bootstrap |
| Modify | `src/runners/mcEngine.ts` — remove hard skip, inject regimeVector + segments |
| Modify | `src/runners/BacktestHarness.ts` — support continuous vector mode |
| New    | `__tests__/RegimeVector.property.test.ts` |

### Gate Test

- [ ] Softmax property test: 100 random genome combos -> all valid probability distributions, no NaN
- [ ] Continuous vector backtest Sharpe >= hard classification Sharpe (within 5% tolerance)

---

## Phase 2.5 — 24h Live Validation + Diagnostic System

### Purpose

Validate continuous regime vector + blended bootstrap in production for 24 hours before entering evolutionary search (Phase 3).

### Architecture

```
runCycle()
  | returns CycleDiagnostic
  |
  +-> data/diagnostics.jsonl        <- full history (append-only)
  +-> appState.lastDiagnostics[]    <- last 48 entries, for Telegram cmd
  +-> Telegram push (toggleable)
```

### CycleDiagnostic Structure

```ts
interface PoolDiagnostic {
  pool: string;
  dex: string;
  regimeVector: RegimeVector;
  hardSignal: 'range' | 'trend' | 'neutral';  // shadow comparison
  wouldSkipInOldVersion: boolean;
  sigmaOpt: number | null;
  kBest: number | null;
  score: number | null;
  cvar95: number | null;
  go: boolean;
  goCandidateCount: number;
}

interface CycleDiagnostic {
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

### index.ts Rewrite

Key changes to `src/index.ts`:
1. `runCycle()` returns `CycleDiagnostic` instead of void
2. Per-phase timing (prefetch, compute, mcEngine)
3. `runMCEngine` returns `MCEngineDiagnostic` instead of void
4. Cron caller handles diagnostic storage + push

```ts
async function runCycle(): Promise<CycleDiagnostic> {
  const t0 = Date.now();

  const tPrefetch = Date.now();
  const data = await prefetchAll(sendCriticalAlert);
  const prefetchMs = Date.now() - tPrefetch;
  if (!data) throw new Error('prefetch failed');

  const tCompute = Date.now();
  const result = computeAll(data);
  positionScanner.updatePositions(result.positions);
  appState.commit(data, { positions: positionScanner.getTrackedPositions() });
  const computeMs = Date.now() - tCompute;

  const tMC = Date.now();
  const mcDiagnostics = await runMCEngine(
    data.historicalReturns,
    botService.sendAlert.bind(botService),
    appState.activeGenome ?? undefined,
  );
  const mcEngineMs = Date.now() - tMC;

  return {
    cycleNumber: ++cycleCount,
    timestamp: t0,
    durationMs: Date.now() - t0,
    phase: { prefetchMs, computeMs, mcEngineMs },
    pools: mcDiagnostics.poolResults,
    activeGenomeId: appState.activeGenome?.id ?? null,
    summary: mcDiagnostics.summary,
  };
}
```

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/diagnostic` | Latest cycle full diagnostic (regime vector, score, CVaR, old vs new comparison) |
| `/diagnostic <N>` | Last N cycles summary (timing trends, go/no-go changes) |
| `/benchmark` | Last 48 cycles performance stats: avg/p95/max per phase |
| `/diagnostic on/off` | Toggle per-cycle Telegram auto-push |

### Persistence (`data/diagnostics.jsonl`)

- Append-only JSONL, one `CycleDiagnostic` per line
- Auto-rotation: rename to `diagnostics.{date}.jsonl` when exceeding 10MB
- gitignore

### Files

| Action | File |
|--------|------|
| Rewrite | `src/index.ts` — timing + diagnostic collection + new cycle structure |
| Modify  | `src/runners/mcEngine.ts` — return `MCEngineDiagnostic` instead of void |
| New     | `src/utils/diagnosticStore.ts` — JSONL append + rotation + memory buffer |
| New     | `src/bot/commands/diagnosticCommands.ts` — `/diagnostic` + `/benchmark` |
| Modify  | `src/bot/TelegramBot.ts` — register new commands |

### Validation Criteria

- [ ] 24h all cycles complete without crash
- [ ] `/diagnostic` shows correct regime vectors (components in [0,1], sum = 1, no NaN)
- [ ] `/benchmark` shows reasonable per-phase timing (MCEngine < Railway timeout)
- [ ] At least 1 pool "old version would skip -> new version produces strategy" with reasonable CVaR (< -2%)
- [ ] `diagnostics.jsonl` accumulates correctly, no corrupt lines
- [ ] Manual human confirmation that push content is reasonable

---

## Phase 3 — Evolutionary Search

### EvolutionEngine (`src/services/strategy/EvolutionEngine.ts`)

```
Population (20 genomes)
  +-- Selection:  top 50% by fitness (10)
  +-- Crossover:  uniform crossover -> 5 children
  +-- Mutation:   3 clones + gaussian noise (sigma = 10% of range)
  +-- Seed:       2 random genomes (diversity injection)
  +-- Immortal:   previous generation's best (wipeout protection)
      = 10 + 5 + 3 + 2 = 20
```

### Walk-Forward Validator (`src/runners/WalkForwardValidator.ts`)

```
150 days historical data
  +-- Window 1: [Day 0-75] train  -> [Day 75-95] validate
  +-- Window 2: [Day 20-95] train -> [Day 95-115] validate
  +-- Window 3: [Day 40-115] train -> [Day 115-135] validate
  +-- Window 4: [Day 60-135] train -> [Day 135-150] validate

Fitness = mean(4 windows Sharpe)
Hard gate: any window maxDD > 30% -> fitness = 0
```

Time monotonic: training always before validation, validation windows do not overlap.

### Railway Resource Protection

Three layers:

1. **Per-generation checkpoint:** After each generation, write to `data/genomes/evolution-checkpoint.json` (atomic write). Resume from checkpoint after timeout or restart.

2. **Batched computation:** 20 genomes x 4 windows = 80 backtests. Yield to event loop every 5 genomes (`await new Promise(r => setTimeout(r, 100))`).

3. **30-minute timeout + auto-release:**
   ```ts
   const EVOLUTION_TIMEOUT_MS = 30 * 60 * 1000;
   if (isEvolutionRunning && Date.now() - evolutionStartedAt > EVOLUTION_TIMEOUT_MS) {
     isEvolutionRunning = false;
   }
   ```

### NaN Guard

- Post-fitness NaN check -> fitness = 0
- Selection only picks from genomes with fitness > 0
- Population wipeout protection: immortal genome always survives

### Genome Persistence

```
data/genomes/
  +-- active-genome.json              <- currently live genome
  +-- population.json                 <- latest generation full population + fitness
  +-- evolution-checkpoint.json       <- mid-run checkpoint
  +-- evolution-log.jsonl             <- per-generation summary (Phase 5 trend analysis)
```

All use stateManager atomic write pattern. `data/genomes/` is gitignored.

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/regime evolve` | Manually trigger full evolution (10 generations), push result |
| `/regime status` | Current active genome + per-pool regime vector |
| `/regime candidates` | Top 5 genomes + fitness + parameter diff highlighting |
| `/regime apply <id>` | Hot-swap (affects next cycle) |

### Genome Explainability (`/regime candidates`)

Shows parameter differences vs baseline with directional arrows and plain-language impact descriptions.

### Files

| Action | File |
|--------|------|
| New    | `src/services/strategy/EvolutionEngine.ts` |
| New    | `src/runners/WalkForwardValidator.ts` |
| New    | `src/bot/commands/regimeCommands.ts` — `/regime *` commands |
| Modify | `src/bot/TelegramBot.ts` — register regime commands |
| Modify | `src/index.ts` — `isEvolutionRunning` guard + timeout |
| New    | `__tests__/Evolution.convergence.test.ts` |
| New    | `data/genomes/` — gitignore |

### Gate Test

- [ ] Evolution convergence test: known-optimal simplified problem converges within 10 generations
- [ ] NaN guard: genome with extreme params produces fitness = 0, not NaN
- [ ] Checkpoint resume: kill mid-evolution, restart, continues from last checkpoint
- [ ] Wipeout protection: population of all-bad genomes still produces next generation (via immortal)

---

## Complete File Inventory

### New Files (11)

| File | Phase |
|------|-------|
| `src/services/market/HistoricalDataService.ts` | 0.5 |
| `src/services/strategy/ParameterGenome.ts` | 1 |
| `src/runners/BacktestHarness.ts` | 1 |
| `src/bot/commands/regimeCommands.ts` | 1 |
| `__tests__/BacktestHarness.baseline.test.ts` | 1 |
| `__tests__/RegimeVector.property.test.ts` | 2 |
| `src/utils/diagnosticStore.ts` | 2.5 |
| `src/bot/commands/diagnosticCommands.ts` | 2.5 |
| `src/services/strategy/EvolutionEngine.ts` | 3 |
| `src/runners/WalkForwardValidator.ts` | 3 |
| `__tests__/Evolution.convergence.test.ts` | 3 |

### Modified Files (9)

| File | Phase(s) |
|------|----------|
| `src/types/index.ts` | 1 |
| `src/config/constants.ts` | 0.5 |
| `src/runners/prefetch.ts` | 0.5 |
| `src/services/strategy/MarketRegimeAnalyzer.ts` | 1, 2 |
| `src/services/strategy/MonteCarloEngine.ts` | 2 |
| `src/runners/mcEngine.ts` | 2, 2.5 |
| `src/index.ts` | 2.5, 3 |
| `src/bot/TelegramBot.ts` | 1, 2.5 |
| `.env` | 0.5 |

### Data Directories (gitignored)

- `data/ohlcv/` — historical OHLCV per pool
- `data/genomes/` — genome population + checkpoints
- `data/diagnostics.jsonl` — cycle diagnostic history
