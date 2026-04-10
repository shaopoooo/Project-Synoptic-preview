# Feature: P0 Phase 1 — Sharpe Scoring 重構

> 本檔案是 `.claude/plans/p0-position-advice-system.md` 的 **Phase 1 子契約**，由 superpowers brainstorming 在 2026-04-10 拆解產出。
> 子契約僅針對 Phase 1（半天工作量、breaking change refactor），完成後獨立 PR、sit 24h 觀察，再進 Phase 2。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 brainstorming 更新。

## Context（為何要做）

- **來源：**
  - 父 plan：`.claude/plans/p0-position-advice-system.md`（Decisions #4：score 公式改 Sharpe-like）
  - brainstorming 2026-04-10：將父 plan 的 Phase 1 拆成 7 個 subagent-sized micro-tasks

- **動機：**
  - 現行 score 公式 `mean / |cvar95|` 在 cvar95 → 0 時爆炸至 ∞，使 Phase 2 的 `score > 0.5` 門檻判斷失效
  - 必須在 Phase 2 加入新邏輯**之前**先完成這個 refactor，遵守 Beck「先 refactor 再 implement，不在同一個 PR 混 structural + behavioral 改動」紀律
  - Phase 1 完成後，score 變成穩定可比較的數字，Phase 2 的 hysteresis + 灰色帶才有意義

- **重要校正（探索階段發現，已修正父 plan 的錯誤）：**
  - 父 plan 寫「公式在 `MonteCarloEngine.ts:135`」**錯誤**，實際在 `src/runners/mcEngine.ts:165`
  - 父 plan 列 `calcCommands.ts` 為 caller**錯誤**，該檔案沒有任何 score 引用
  - **score 不參與任何邏輯閘門**：`go` 只看 cvar95，score 目前純粹用於 ranking + Telegram 顯示。本次 refactor 不會改變既有開倉行為

## Decisions（已定案，執行階段不得動搖）

1. **Score 公式**：`score = mean / std`，std 由 runMCSimulation 從 pnlRatios 計算
2. **退化處理**：`std < 1e-6 → score = 0`（不用 EPS hack 把 score 撐住，退化分佈視為無資訊）
3. **Score 欄位上提到 MCSimResult**：score 是 MC 的內在屬性，不該在 runner 算。`MCSimResult` 新增 `std` + `score` 兩個欄位，runner 改讀 `c.mc.score`
4. **不保留舊 score 為 backup 欄位**：Beck 紀律——refactor 完用 canary 驗證 mean/cvar95/percentiles 沒動，再切 caller。中間不存在「兩種 score 並存」的中間狀態，避免 dead code
5. **種子注入**：`runMCSimulation` 新增 optional `rng?: () => number` 參數，預設 `Math.random`，測試時注入 `seedrandom`。`runOnePath` 必須一併接受 `rng` 並用之取代所有 `Math.random()` 呼叫
6. **Canary 形式**：固定 seed 跑 runMCSimulation → snapshot 11 個欄位（mean/median/cvar95/var95/p5/p25/p50/p75/p95/inRangeDays/numPaths）。score 與 std 是新欄位，不在 snapshot 範圍，獨立 assert
7. **Phase 1 獨立 PR**：完成後 ship、sit 24h 確認沒有 regression，再開新 PR 進 Phase 2

## Rejected（已否決，subagent 不得再提）

- ❌ **`score = mean / max(std, EPS)` 用 EPS 撐住**：仍會在邊界產生大數字，與舊公式同病
- ❌ **`score = mean / (std + EPS)` 軟性 floor**：EPS 數字怎麼選都是 magic number，不如直接 0
- ❌ **保留舊 `score` 欄位 + 新增 `sharpeScore` 欄位並存**：dead code，違反 refactor 完整性
- ❌ **score 留在 mcEngine.ts 算**：score 是 MC 的內在屬性，runner 不該定義「什麼叫好」，runner 只該排序
- ❌ **Snapshot 整段 pnlRatios array**：random sampling 順序敏感，誤報率高
- ❌ **只 snapshot mean + cvar95**：太鬆，refactor 引入的 path generator bug 抓不到
- ❌ **跳過 canary，靠 manual dryrun 比對**：人眼看不出 0.001 等級的數字漂移
- ❌ **跟 Phase 2 合併成一個 PR**：違反 Beck「不混 structural + behavioral」紀律

## Constraints（必須遵守的專案規則）

- **`.claude/rules/pipeline.md`**：runMCSimulation 必須維持 pure function（無 await / RPC），rng 注入不能引入副作用
- **`.claude/rules/math.md`**：std 計算 pure function，避免引用全域狀態
- **`.claude/rules/naming.md`**：TypeScript strict，**禁止 `any`**；新增欄位用 camelCase
- **`.claude/rules/logging-errors.md`**：不新增 console.log，沿用 `createServiceLogger('MCEngine')`
- **TDD 紀律**（superpowers `test-driven-development`）：每個 micro-task 嚴守 RED → GREEN → REFACTOR
- **不偏離父 plan**：本子契約只動 score 公式相關欄位，不得擴張到 PositionAdvisor、stateManager、telegram 等 Phase 2-5 範圍

## Interfaces（API 契約）

### Modify

```ts
// src/types/index.ts — MCSimResult 新增兩欄
export interface MCSimResult {
  numPaths: number;
  horizon: number;
  mean: number;
  median: number;
  std: number;          // ← NEW: pnlRatios 的標準差
  score: number;        // ← NEW: Sharpe-like, mean / std (degenerate → 0)
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

```ts
// src/services/strategy/MonteCarloEngine.ts
export interface MCSimParams {
  // ...既有欄位不變
  rng?: () => number;   // ← NEW: optional, 預設 Math.random
}

export function runMCSimulation(params: MCSimParams): MCSimResult;
// 內部：const rng = params.rng ?? Math.random;
// 內部：runOnePath(...) 必須改成接受 rng 並 propagate
// 內部：std = sqrt(sum((x - mean)^2) / n)
// 內部：score = std < 1e-6 ? 0 : mean / std
```

### Modify (caller)

```ts
// src/runners/mcEngine.ts:165
// BEFORE: const scored = goCandidates.map(c => ({ c, score: c.mc.mean / Math.abs(c.mc.cvar95) }));
// AFTER:  const scored = goCandidates.map(c => ({ c, score: c.mc.score }));
```

### Unchanged（顯示層不需動）

- `formatter.ts:594` `strategy.score.toFixed(3)` — 仍有效（OpeningStrategy.score 來自 MCSimResult.score，型別不變）
- `dryrun.ts:21`、`diagnosticCommands.ts:33` 同上
- `OpeningStrategy.score` 欄位定義不變，只是 producer 換來源

## Test Plan（TDD 起點，RED 階段的測試清單）

### tests/services/MonteCarloEngine.test.ts (MODIFY)

#### Sharpe / std 計算（4 個新測試）

- [ ] **RED M1.1**：注入固定 pnlRatios 分佈（mean=0.05, std=0.02）→ `result.std` ≈ 0.02、`result.score` ≈ 2.5
- [ ] **RED M1.2**：注入退化分佈（所有 pnl 相同 → std = 0）→ `result.std` = 0、`result.score` = 0（不爆炸、不 NaN、不 Infinity）
- [ ] **RED M1.3**：注入負 mean（mean=-0.03, std=0.02）→ `result.score` ≈ -1.5（負 score 是合法的，代表期望虧損）
- [ ] **RED M1.4**：`runMCSimulation` 接受 `rng` 參數，注入相同 seed 兩次 → 兩次回傳 MCSimResult 完全相等

#### Canary regression（1 個新測試）

- [ ] **RED M2.1**：固定 seed + 固定 historicalReturns + 固定 P0/Pa/Pb/capital → snapshot 11 個欄位（mean/median/cvar95/var95/p5/p25/p50/p75/p95/inRangeDays/numPaths）。**這個 snapshot 在 Phase 1 完成後鎖死**，未來任何動到 path generator 的 PR 都會被擋下

### tests/runners/mcEngine.test.ts (若已存在則 MODIFY，無則跳過)

- 不需要新測試。caller 改一行讀取來源，行為不變

### TDD 守則

- 每個測試先 **RED**（執行 → 失敗）
- 寫最少程式碼讓測試 **GREEN**
- **REFACTOR** 階段不改測試行為
- 嚴禁先寫實作再補測試

## Tasks（subagent 執行順序，每個 micro-task 一個 subagent）

### M1 — RED：寫 4 個 Sharpe / std / rng 測試
- 在 `tests/services/MonteCarloEngine.test.ts` 新增 4 個測試（M1.1-M1.4）
- 測試應全部失敗（型別錯誤 / 欄位不存在）
- 安裝 `seedrandom` 套件（version pin、age ≥ 7d、commit lock）
- **完成標準**：`npm test -- MonteCarloEngine` 出現 4 個 RED

### M2 — RED：寫 canary snapshot test
- 在同檔案新增 M2.1 canary test
- 用 `seedrandom('phase1-canary')` 產生固定 rng
- 第一次跑會自動建立 snapshot（之後變更會擋）
- **完成標準**：`npm test -- MonteCarloEngine` 出現第 5 個 RED

### M3 — GREEN：實作 Sharpe + std + rng injection
- `src/types/index.ts`：MCSimResult 新增 `std`、`score` 欄位
- `src/services/strategy/MonteCarloEngine.ts`：
  - `MCSimParams` 新增 `rng?: () => number`
  - `runMCSimulation` 內 `const rng = params.rng ?? Math.random`
  - `runOnePath` 改成接受 `rng` 並 propagate（grep 確認沒漏 `Math.random()`）
  - 計算 std：`Math.sqrt(pnlRatios.reduce((s, v) => s + (v - mean) ** 2, 0) / n)`
  - 計算 score：`std < 1e-6 ? 0 : mean / std`
  - 在 return object 加入兩個新欄位
- **完成標準**：M1.1-M1.4 + M2.1 全部 GREEN

### M4 — VERIFY：跑全測試 + 既有 MC 測試 0 regression
- `npm test`
- 任何 regression 必須回去 M3 修，**不得修測試遷就實作**
- **完成標準**：所有測試 GREEN，包括既有的 MC 與 mcEngine 測試

### M5 — GREEN：切換 caller
- `src/runners/mcEngine.ts:165`：改為 `score: c.mc.score`
- grep 確認沒有其他 `c.mc.mean / Math.abs(c.mc.cvar95)` 殘留
- **完成標準**：`npm test` 全綠

### M6 — VERIFY：手動 dryrun 確認 Telegram 顯示
- `npm run dryrun`
- 確認 Telegram 訊息中的 `Score: X.XXX` 顯示為合理的 Sharpe 數字（通常 -3 ~ 5 之間），不是爆炸的數字
- 確認沒有 NaN / Infinity
- **完成標準**：dryrun 輸出正常

### M7 — REFACTOR：clean up
- review diff，確認：
  - 沒有 dead code
  - import 沒有未使用項
  - type 一致（沒有 `any`）
  - log 訊息與 score 數值範圍合理
- **完成標準**：diff clean，無 lint warning

## 完成標準（Phase 1 ship gate）

- ✅ 5 個新測試 GREEN（M1.1-M1.4、M2.1）
- ✅ 所有既有測試 0 regression
- ✅ Canary snapshot 鎖住 11 個 MCSimResult 欄位
- ✅ `npm run dryrun` Telegram 訊息正常顯示新 score
- ✅ `git diff` 範圍只在 4 個檔案：`types/index.ts`、`services/strategy/MonteCarloEngine.ts`、`runners/mcEngine.ts`、`tests/services/MonteCarloEngine.test.ts`
- ✅ PR ship 後 sit 24h 觀察無異常，再進 Phase 2

## Phase 1 完成後的下一步

- 退出本子契約，回到父 plan `.claude/plans/p0-position-advice-system.md`
- 新一輪 brainstorming → 拆解 Phase 2（PositionAdvisor pure functions）
