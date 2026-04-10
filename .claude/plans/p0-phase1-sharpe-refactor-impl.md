# P0 Phase 1 — Sharpe Scoring 重構 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Spec contract:** `.claude/plans/p0-phase1-sharpe-refactor.md`（不得偏離 Decisions / Rejected 段落；如需調整必須回到 brainstorming 階段）

**Goal:** 把 score 公式從 `mean / |cvar95|` 改為 Sharpe-like `mean / std`，並用 canary snapshot 鎖死 MCSimResult 其他欄位 0 regression。

**Architecture:** 在 `MonteCarloEngine.ts` 內計算 std 與 score，把 score 上提到 `MCSimResult` 變成內在屬性；新增 optional `rng` 參數讓測試可注入固定 seed。`mcEngine.ts:165` 從自己算 score 改成讀 `c.mc.score`。退化分佈（`std < 1e-6`）→ `score = 0`。所有改動 4 個檔案，獨立 PR。

**Tech Stack:** TypeScript strict / Jest 30 / seedrandom 3.0.5

---

## File Structure

| 動作 | 檔案 | 責任 |
|------|------|------|
| Modify | `src/types/index.ts` | `MCSimResult` 新增 `std` + `score` 欄位 |
| Modify | `src/services/strategy/MonteCarloEngine.ts` | `MCSimParams` 新增 `rng?`；計算 std + score；`runOnePath` + `sampleBlended` 接受 rng 取代 `Math.random()` |
| Modify | `src/runners/mcEngine.ts:165` | 從 `c.mc.mean / Math.abs(c.mc.cvar95)` 改為 `c.mc.score` |
| Modify | `tests/services/MonteCarloEngine.test.ts`（新檔案，目前不存在）| 5 個新測試（4 Sharpe/std/rng + 1 canary snapshot） |
| Modify | `package.json` / `package-lock.json` | 加入 `seedrandom` 與 `@types/seedrandom` |

---

## Task 1: 安裝 seedrandom 並建立空測試檔

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/services/MonteCarloEngine.test.ts`

- [ ] **Step 1.1: 確認 seedrandom 版本年齡 ≥ 7 天**

Run:
```bash
npm view seedrandom time --json | tail -5
```
Expected: 看到 `3.0.5` 的 timestamp 是 2019 年（遠超過 7 天）

- [ ] **Step 1.2: 安裝 seedrandom 與型別**

Run:
```bash
npm install --save-exact seedrandom@3.0.5
npm install --save-exact --save-dev @types/seedrandom@3.0.8
```
Expected: `package.json` 中出現 `"seedrandom": "3.0.5"`（**不可有 ^ 或 ~**）與 `"@types/seedrandom": "3.0.8"`

- [ ] **Step 1.3: 確認 package.json 版本格式正確**

Run:
```bash
grep -E '"(seedrandom|@types/seedrandom)"' package.json
```
Expected:
```
"seedrandom": "3.0.5"
"@types/seedrandom": "3.0.8"
```
（沒有 `^` 或 `~`）

- [ ] **Step 1.4: 建立測試檔骨架**

Create `tests/services/MonteCarloEngine.test.ts`:
```ts
import { runMCSimulation } from '../../src/services/strategy/MonteCarloEngine';
import seedrandom from 'seedrandom';

describe('MonteCarloEngine — Sharpe scoring', () => {
    // Tests will be added in Task 2-6
});
```

- [ ] **Step 1.5: 確認測試檔可被 jest 載入（空 describe 應 pass）**

Run:
```bash
npm test -- MonteCarloEngine
```
Expected: PASS（0 tests, 0 failures，jest 不抱怨 import）

- [ ] **Step 1.6: Commit**

```bash
git add package.json package-lock.json tests/services/MonteCarloEngine.test.ts
git commit -m "chore(deps): 加入 seedrandom 並建立 MonteCarloEngine 測試骨架"
```

---

## Task 2: RED — Sharpe normal case 測試

**Files:**
- Modify: `tests/services/MonteCarloEngine.test.ts`

- [ ] **Step 2.1: 寫 M1.1 — Sharpe 正常 case 測試**

在 `describe` block 內加入：
```ts
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
```

- [ ] **Step 2.2: 跑測試確認 RED**

Run:
```bash
npm test -- MonteCarloEngine -t "M1.1"
```
Expected: FAIL — TypeScript 編譯錯（`rng` 不是 MCSimParams 的欄位 / `result.std` 不存在 / `result.score` 不存在）

- [ ] **Step 2.3: Commit RED**

```bash
git add tests/services/MonteCarloEngine.test.ts
git commit -m "test(mc): RED M1.1 — Sharpe 正常 case 測試"
```

---

## Task 3: RED — 退化分佈與負 mean 測試

**Files:**
- Modify: `tests/services/MonteCarloEngine.test.ts`

- [ ] **Step 3.1: 寫 M1.2 — 退化分佈測試**

在同一個 `describe` 內加入：
```ts
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
```

- [ ] **Step 3.2: 寫 M1.3 — 負 mean 測試**

繼續加入：
```ts
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
```

- [ ] **Step 3.3: 跑測試確認 RED**

Run:
```bash
npm test -- MonteCarloEngine -t "M1.2|M1.3"
```
Expected: FAIL — 同樣的編譯錯（`std` / `score` / `rng` 不存在）

- [ ] **Step 3.4: Commit RED**

```bash
git add tests/services/MonteCarloEngine.test.ts
git commit -m "test(mc): RED M1.2/M1.3 — 退化分佈 + 負 mean 測試"
```

---

## Task 4: RED — rng 決定論測試

**Files:**
- Modify: `tests/services/MonteCarloEngine.test.ts`

- [ ] **Step 4.1: 寫 M1.4 — rng 決定論測試**

```ts
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
```

- [ ] **Step 4.2: 跑測試確認 RED**

Run:
```bash
npm test -- MonteCarloEngine -t "M1.4"
```
Expected: FAIL — 編譯錯或執行時兩次結果不相等（因為 rng 沒注入，仍走 Math.random）

- [ ] **Step 4.3: Commit RED**

```bash
git add tests/services/MonteCarloEngine.test.ts
git commit -m "test(mc): RED M1.4 — rng 決定論測試"
```

---

## Task 5: RED — Canary snapshot 測試

**Files:**
- Modify: `tests/services/MonteCarloEngine.test.ts`

- [ ] **Step 5.1: 寫 M2.1 — canary snapshot 測試**

```ts
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
```

- [ ] **Step 5.2: 跑測試確認 RED**

Run:
```bash
npm test -- MonteCarloEngine -t "M2.1"
```
Expected: FAIL — 編譯錯（`rng` 不存在）

- [ ] **Step 5.3: Commit RED**

```bash
git add tests/services/MonteCarloEngine.test.ts
git commit -m "test(mc): RED M2.1 — canary snapshot 測試"
```

---

## Task 6: GREEN — MCSimResult 型別新增 std + score 欄位

**Files:**
- Modify: `src/types/index.ts`（找到 `MCSimResult` 定義，約在 line 280-300 區段，搜尋字串 `cvar95: number;` 在 interface MCSimResult 內）

- [ ] **Step 6.1: 找到 MCSimResult 定義**

Run:
```bash
grep -n "interface MCSimResult" src/types/index.ts
```
Expected: 看到 `MCSimResult` interface 的起始行號

- [ ] **Step 6.2: 新增 std + score 欄位**

在 `MCSimResult` 內，把：
```ts
export interface MCSimResult {
    numPaths: number;
    horizon: number;
    mean: number;
    median: number;
    inRangeDays: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    cvar95: number;
    var95: number;
    go: boolean;
    noGoReason?: string;
}
```
改成：
```ts
export interface MCSimResult {
    numPaths: number;
    horizon: number;
    mean: number;
    median: number;
    /** pnlRatios 的標準差，用於 Sharpe-like score 計算 */
    std: number;
    /** Sharpe-like score = mean / std；退化分佈 (std < 1e-6) 時為 0 */
    score: number;
    inRangeDays: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    cvar95: number;
    var95: number;
    go: boolean;
    noGoReason?: string;
}
```

- [ ] **Step 6.3: 確認 TypeScript 還沒崩**

Run:
```bash
npx tsc --noEmit
```
Expected: 看到 `MonteCarloEngine.ts` 內 return object 缺少 `std` / `score` 的編譯錯（這是預期的，下一個 task 會補）

- [ ] **Step 6.4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): MCSimResult 新增 std + score 欄位"
```

---

## Task 7: GREEN — runMCSimulation 計算 std + score + rng 注入

**Files:**
- Modify: `src/services/strategy/MonteCarloEngine.ts`

- [ ] **Step 7.1: MCSimParams 新增 rng 欄位**

找到 `interface MCSimParams`（約 line 32），在最後加入：
```ts
interface MCSimParams {
    historicalReturns: number[];
    P0: number;
    Pa: number;
    Pb: number;
    capital: number;
    dailyFeesToken0: number;
    horizon: number;
    numPaths: number;
    segments?: RegimeSegment[];
    regimeVector?: RegimeVector;
    /** Optional RNG for deterministic testing; defaults to Math.random */
    rng?: () => number;
}
```

- [ ] **Step 7.2: sampleBlended 接受 rng**

把現有的 `sampleBlended` 函式（line 53）：
```ts
function sampleBlended(segments: RegimeSegment[], regimeVector: RegimeVector): number {
    const r = Math.random();
    let cumulative = 0;
    for (const seg of segments) {
        cumulative += regimeVector[seg.regime];
        if (r <= cumulative) {
            return seg.returns[Math.floor(Math.random() * seg.returns.length)];
        }
    }
    const last = segments[segments.length - 1];
    return last.returns[Math.floor(Math.random() * last.returns.length)];
}
```
改成：
```ts
function sampleBlended(
    segments: RegimeSegment[],
    regimeVector: RegimeVector,
    rng: () => number,
): number {
    const r = rng();
    let cumulative = 0;
    for (const seg of segments) {
        cumulative += regimeVector[seg.regime];
        if (r <= cumulative) {
            return seg.returns[Math.floor(rng() * seg.returns.length)];
        }
    }
    const last = segments[segments.length - 1];
    return last.returns[Math.floor(rng() * last.returns.length)];
}
```

- [ ] **Step 7.3: runOnePath 接受 rng**

把現有的 `runOnePath` 簽名與內部的 `Math.random()` 都改成 `rng`：
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
    rng: () => number,
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
            ? sampleBlended(segments!, regimeVector!, rng)
            : returns[Math.floor(rng() * n)];
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

- [ ] **Step 7.4: runMCSimulation 解開 rng + 計算 std + score + 加進 return object**

在 `runMCSimulation` 內部，destructure 後馬上加上：
```ts
const rng = params.rng ?? Math.random;
```

把對 `runOnePath` 的呼叫從：
```ts
const { pnlRatio, hoursInRange } = runOnePath(
    historicalReturns, P0, Pa, Pb, L, capital, hourlyFees, horizonHours,
    params.segments, params.regimeVector,
);
```
改成：
```ts
const { pnlRatio, hoursInRange } = runOnePath(
    historicalReturns, P0, Pa, Pb, L, capital, hourlyFees, horizonHours,
    rng, params.segments, params.regimeVector,
);
```

在 `mean` 計算之後、return object 之前，新增 std + score 計算：
```ts
const mean = pnlRatios.reduce((s, v) => s + v, 0) / n;
// std + Sharpe-like score
const variance = pnlRatios.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
const std = Math.sqrt(variance);
const score = std < 1e-6 ? 0 : mean / std;
```

把早期 return（line 126，歷史資料不足的 fallback）也補上 `std` + `score`：
```ts
return {
    numPaths: 0, horizon,
    mean: 0, median: 0,
    std: 0, score: 0,
    inRangeDays: 0,
    p5: 0, p25: 0, p50: 0, p75: 0, p95: 0,
    cvar95: 0, var95: 0,
    go: false,
    noGoReason: historicalReturns.length < 2
        ? '歷史報酬率資料不足，無法執行 Bootstrap 模擬'
        : '區間或資金參數無效',
};
```

把正常 return（line 185）也補上：
```ts
return {
    numPaths: n,
    horizon,
    mean,
    median,
    std,
    score,
    inRangeDays,
    p5: pnlRatios[Math.floor(n * 0.05)],
    p25: pnlRatios[Math.floor(n * 0.25)],
    p50: pnlRatios[Math.floor(n * 0.50)],
    p75: pnlRatios[Math.floor(n * 0.75)],
    p95: pnlRatios[Math.floor(n * 0.95)],
    cvar95,
    var95,
    go,
    noGoReason,
};
```

- [ ] **Step 7.5: grep 確認沒有遺漏的 Math.random**

Run:
```bash
grep -n "Math.random" src/services/strategy/MonteCarloEngine.ts
```
Expected: **沒有任何匹配**（所有 `Math.random()` 都已替換成 `rng()`）

- [ ] **Step 7.6: TypeScript 檢查通過**

Run:
```bash
npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 7.7: 跑新測試確認 GREEN**

Run:
```bash
npm test -- MonteCarloEngine
```
Expected: M1.1, M1.2, M1.3, M1.4, M2.1 全部 PASS（M2.1 會自動建立 snapshot 檔）

- [ ] **Step 7.8: Commit GREEN**

```bash
git add src/services/strategy/MonteCarloEngine.ts tests/services/MonteCarloEngine.test.ts/__snapshots__
git commit -m "feat(mc): runMCSimulation 計算 std + Sharpe score 並支援 rng 注入"
```

---

## Task 8: VERIFY — 全測試 + 既有 BlendedBootstrap 0 regression

**Files:** （無修改，只跑測試）

- [ ] **Step 8.1: 跑全測試**

Run:
```bash
npm test
```
Expected: 所有測試 PASS。重點觀察 `BlendedBootstrap.test.ts`、`RiskManager.test.ts` 等既有 MC 相關測試 0 regression

- [ ] **Step 8.2: 若有 regression → 回 Task 7 修實作（不得改測試）**

如果有任何測試失敗：
1. 讀錯誤訊息確認原因
2. 回 Task 7 對應 step 修正
3. **嚴禁修測試遷就實作**
4. 跑 `npm test` 直到全綠

- [ ] **Step 8.3: （無 commit，純驗證 step）**

---

## Task 9: GREEN — 切換 mcEngine.ts caller

**Files:**
- Modify: `src/runners/mcEngine.ts:165`

- [ ] **Step 9.1: 確認舊公式位置**

Run:
```bash
grep -n "Math.abs(c.mc.cvar95)" src/runners/mcEngine.ts
```
Expected: 看到 line 165 的匹配

- [ ] **Step 9.2: 替換舊公式為讀取 c.mc.score**

把 line 165：
```ts
const scored = goCandidates.map(c => ({ c, score: c.mc.mean / Math.abs(c.mc.cvar95) }));
```
改成：
```ts
const scored = goCandidates.map(c => ({ c, score: c.mc.score }));
```

- [ ] **Step 9.3: grep 確認沒有殘留**

Run:
```bash
grep -rn "mean / Math.abs.*cvar95" src/
```
Expected: **沒有任何匹配**

- [ ] **Step 9.4: 跑全測試**

Run:
```bash
npm test
```
Expected: 全綠

- [ ] **Step 9.5: TypeScript 檢查**

Run:
```bash
npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 9.6: Commit**

```bash
git add src/runners/mcEngine.ts
git commit -m "refactor(mcEngine): 改用 MCSimResult.score 取代 inline cvar95 公式"
```

---

## Task 10: VERIFY — 手動 dryrun 確認 Telegram 顯示

**Files:** （無修改）

- [ ] **Step 10.1: 跑 dryrun**

Run:
```bash
npm run dryrun
```
Expected: 看到輸出中包含 `score=X.XXX` 的池子摘要，**X.XXX 應該在 -3 ~ 5 之間**（Sharpe 範圍），不再是過去常見的爆炸大數字

- [ ] **Step 10.2: 確認沒有 NaN / Infinity**

從 dryrun 輸出中目視確認：
- 沒有 `score=NaN`
- 沒有 `score=Infinity`
- 沒有 `score=undefined`
- Telegram 訊息能正常組裝（不 throw）

- [ ] **Step 10.3: （無 commit，純驗證 step）**

---

## Task 11: REFACTOR + Final clean-up

**Files:** （視情況修整）

- [ ] **Step 11.1: 檢查 git diff 範圍**

Run:
```bash
git diff main...HEAD --stat
```
Expected: 只動到 5 個檔案：
- `package.json`
- `package-lock.json`
- `src/types/index.ts`
- `src/services/strategy/MonteCarloEngine.ts`
- `src/runners/mcEngine.ts`
- `tests/services/MonteCarloEngine.test.ts` (+ snapshot 檔)

如果有其他檔案被動到 → review 是否必要，若無必要 revert

- [ ] **Step 11.2: review unused imports**

Run:
```bash
npx tsc --noEmit
```
Expected: 0 errors / 0 warnings

- [ ] **Step 11.3: 確認沒有 dead code（舊 score 公式相關的 helper / comment）**

Run:
```bash
grep -rn "cvar.*score\|score.*cvar" src/ --include="*.ts"
```
Expected: 只看到型別定義 / 註解中合理的提及，沒有「舊公式 helper」殘留

- [ ] **Step 11.4: 跑最後一次全測試**

Run:
```bash
npm test
```
Expected: 全綠

- [ ] **Step 11.5: 更新 .claude/tasks.md 標記 Phase 1 完成**

把 `.claude/tasks.md` 中 P0 Phase 1 相關的兩條 checkbox 打勾：
```markdown
- [x] `MonteCarloEngine.ts`：score 公式從 `mean/|cvar95|` 改為 Sharpe-like `mean/std`
- [x] 更新 `OpeningStrategy.score` 文件說明 + 影響 callers (mcEngine.ts, calcCommands.ts)
- [x] Canary regression test：固定 seed → 確認新舊公式輸出可預測
```

- [ ] **Step 11.6: Final commit**

```bash
git add .claude/tasks.md
git commit -m "docs(tasks): 標記 P0 Phase 1 Sharpe scoring 重構完成"
```

---

## Ship Gate（全部完成才能進 Phase 2）

- ✅ Task 1-11 全部完成
- ✅ 5 個新測試 GREEN（M1.1-M1.4、M2.1）
- ✅ 既有 `npm test` 0 regression
- ✅ Canary snapshot 鎖住 11 個欄位
- ✅ `npm run dryrun` Telegram 訊息正常顯示新 score
- ✅ `git diff` 範圍只在 6 個檔案內
- ✅ 無 TypeScript / lint warning
- ✅ PR ship 後 sit 24h，確認 production 無異常後再開啟 Phase 2 brainstorming

## 下一步

Phase 1 sit 24h 觀察通過後，回到父 plan `.claude/plans/p0-position-advice-system.md`，啟動 Phase 2 brainstorming 拆解 PositionAdvisor pure functions。
