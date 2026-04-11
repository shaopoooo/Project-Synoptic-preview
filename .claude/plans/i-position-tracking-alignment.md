# Feature: Position Tracking Model 對齊 (Infrastructure)

> Path B brainstorming 產出，日期 2026-04-11。交接給 `/plan-eng-review` 做對抗式 review，再進 Phase 2 執行。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由本檔更新。
>
> **本 plan 命名為 alignment 而非 model**：model 本身的定義住在 `.claude/rules/position-tracking.md`（永久 artifact）。本 plan 的 scope 是「讓既有 code / plan / tasks.md 對齊 model」的一次性對齊工作，ship 後刪除（依 Phase 2 α 規則）。

## Context（為何要做）

- **觸發**：使用者詢問「P0 Stage 3 要新建 `positionStateTracker` — 現在 `appState.positions` 是什麼狀況？未來新策略也能套同樣 tracking model 嗎？」
- **探索階段 surface 的事實**：
  1. **`appState.positions` 是 dead field**：宣告但從未寫入（`commit(CycleData)` 只更新 pools + warnings）。真實 LP position state 住在 `PositionScanner.positions` 私有欄位，不經 AppState
  2. **Position tracking 概念散落 7 處**：on-chain LP state、PositionStateTracker (P0 Stage 3)、shadow positions (backtest Stage 2)、advice tracking feedback loop (P2)、close reason counter (P2)、paper trading (P1 Phase 2d)、historical archive（不存在）
  3. **LP-centric 假設滲透**：P0 Stage 3 的 `positionStateTracker` 命名暗示「generic」但實際只處理 LP；p0-backtest 的 `v3lpShadowDriver` 命名誤導（實際處理所有 LP venues）；既有 brainstorm 的路徑命名沒有策略維度
- **動機**：若不先定義 mental model，**未來 P1 FundingRate strategy 進來時會發生三件事**：
  1. 新策略檔案命名沒有對稱規則（`positionAdvisor.ts` 是 LP 默認 vs `fundingRatePositionAdvisor.ts` 顯式）
  2. 新策略的 tracking 狀態會各自決定儲存路徑、重複實作 state machine
  3. P2 的 advice tracking / close reason counter 屆時才開始設計會太晚，資料流已經定型

## Goal（改完了的定義）

1. `.claude/rules/position-tracking.md` **已存在**並被 CLAUDE.md 的自動載入 rule 表格引用（屬於 `src/services/strategy/**` 等 path 的自動套用規則）
2. **PR 3 (`feature/position-advisor`) 已 rebase**，檔案位置對齊 matrix model (`src/services/strategy/lp/positionAdvisor.ts`)。**此項已於 2026-04-11 brainstorm 階段完成**（commit `ade8f44`），plan 只記錄而不執行
3. **`src/config/storage.ts`** 新增 `history` / `shadowLp` / `shadowLpAnalysis` / `historyLp` 四個 entries，對應 L2/L3 策略子路徑
4. **P0 Stage 3 plan** 對齊 matrix：`positionStateTracker.ts` → `src/services/strategy/lp/positionStateTracker.ts`（改 plan 文字 + 相關 test path）
5. **p0-backtest-verification plan** 對齊：`v3lpShadowDriver` → `lpShadowDriver`，路徑 `src/services/strategy/lp/lpShadowDriver.ts`
6. **CLAUDE.md** 的 `.claude/rules/*.md` 自動載入表格新增一行 `position-tracking.md`
7. **tasks.md** 新增 4 個 P3 follow-up：L3 archive 實作、`appState.positions` dead field 處理、advice tracking 路徑、close reason counter 路徑
8. **`npm test` 全綠**（153 tests 不回歸）

## Non-goal（明確不做）

- ❌ **實作 L3 archive writer**：只定義路徑跟 minimum schema，不寫 code。歸為 P3 follow-up
- ❌ **處理 `appState.positions` dead field**：只 flag 為 open question。處理方式（刪除 vs 補活）延後決定
- ❌ **重構既有 `src/services/strategy/` root 檔案**（MonteCarloEngine、BollingerBands 等）：grandfathered
- ❌ **實作 `IStrategyTrackingPlugin` adapter**：interface 只在 doc/rule 裡，PositionScanner 不改造。留給 P1
- ❌ **main cycle 遍歷 plugin registry**：不碰 `src/index.ts` 的 cycle 結構
- ❌ **定義 paper trading (L2.5)**：留給 P1 Phase 2d brainstorm
- ❌ **aggregate stats 儲存路徑**（close reason counter / advice tracking）：留給各自的 P2 brainstorm
- ❌ **RebalanceService 刪除**：屬於 P0 Stage 5，不在本 plan scope

## Decisions（已定案，執行階段不得動搖）

### D1 — Framing = Proactive + 釐清 `appState.positions`
- (ii) Proactive：定 mental model 讓未來 P1/P2/P3 的 tracking 需求有對號入座規則
- (d) 綜合：解 P0 Stage 3 邊界 + 未來 add-on 對號入座
- 釐清 `appState.positions` = (ii) Map + diff，**不**重構既有程式

### D2 — Dead field 處理 = A+D
- (A) mental model 明確承認 `PositionScanner.positions` 是 L0 truth owner，不經 AppState
- (D) `appState.positions` dead field 延後決定（刪除 vs 補活），寫進 tasks.md P3 follow-up
- 本 plan **不動** `appState.positions` 欄位

### D3 — 層級設計 = 4 層 × N 策略矩陣（(ii-matrix)）
- Layer roles: L0 Reality / L1 Advice / L2 Counterfactual / L3 History — strategy-agnostic
- Strategy 軸: 目前 1 列（LP 共用 v3/v4/aerodrome/pancake），未來 P1 加 FundingRate
- Aggregate stats = derived views，**不是**層，單獨段落說明
- Paper trading = 留給 P1 brainstorm 決定屬於 L2 擴充還是 L0'（平行 L0）

### D4 — 目錄結構 = 半巢狀（Option X）
- 新 LP 檔案住 `src/services/strategy/lp/<file>.ts`
- 既有 `src/services/strategy/` root 檔案 grandfathered（`MonteCarloEngine.ts` 等不搬）
- 未來策略：`src/services/strategy/<strategy>/<file>.ts`
- Tests 維持 `tests/services/` flat（**不**鏡射 `lp/` 巢狀）

### D5 — Ownership matrix
- Q6a: **LP 共用單一 plugin**（不拆 4 個 venues，靠 `dex: Dex` discriminator）
- Q6b: **Interface 先定義、adapter 延後**（PositionScanner 暫不改造成 `IStrategyTrackingPlugin`，留給 P1）
- Q6c: P0 Stage 3 新檔名 = `src/services/strategy/lp/positionStateTracker.ts`（保留 `position` 前綴、維持 `State` 後綴與 P0 plan 一致，但位置改到 `lp/`）
- Q6d: p0-backtest Stage 2 的 `v3lpShadowDriver` → `lpShadowDriver`（因為其實處理所有 LP venues）
- Q6e: L3 `lpClosedPositionArchive` 只定義 minimum schema + 路徑，**不實作**（delta = β）

### D6 — Storage 路徑 (Q7)
- Q7a: L2 加策略子目錄 `storage/shadow/lp/`（**不**用扁平 `storage/shadow/<YYYY-MM>.jsonl`）
- Q7b: `storage/history/` 新 top-level，由本 plan 的 Stage 3 加進 `STORAGE_PATHS`（**不**追溯修改 i-unify-storage Stage 2，因為已 ship）
- Q7c: Derived views 路徑（close reason counter、advice tracking）**延後決定**

### D7 — Artifact type = C 混合
- Rule doc: `.claude/rules/position-tracking.md` — 永久 artifact，定義 mental model
- Plan: `.claude/plans/i-position-tracking-alignment.md` — 一次性對齊 plan，ship 後刪除
- Plan 檔名 = `i-position-tracking-alignment`（強調「對齊」而非「model」，避免跟 rule doc 語意重複）

### D8 — Rule doc 位置 = `.claude/rules/`（γ）
- 放 `.claude/rules/` 而非 `.claude/docs/` 或 `docs/architecture/`
- 理由：自動載入到未來所有相關對話 context（`src/services/strategy/**` path matcher），無需手動 import
- 跟 `.claude/rules/architecture.md` 對稱（一講目錄結構、一講 position tracking model）

## Rejected（已否決，subagent 不得再提）

### 方向選擇
- ❌ **(a) 單獨解 P0 Stage 3 邊界**：產出物只能塞給 P0 Stage 3 plan 當補丁，不產生獨立 doc；未來 P2/P1 的 tracking 需求又會再問一次同樣的問題
- ❌ **(c) 完整挖既有 `appState.positions` 技術債**：會讓 brainstorm 膨脹成「半個 position 子系統重構」，違反 plan 獨立性
- ❌ **(B) 補活 `appState.positions`**：main cycle 加倉位掃描、所有讀倉位的地方改讀 AppState — 觸碰很多既有 service，違反 plan 獨立性
- ❌ **(C) 純刪 dead field**：沒回答「scanner truth 要不要納入 AppState」的大問題

### 層級數量
- ❌ **3 層極簡（Reality / Advice / History）**：shadow 塞進 L1，但 hysteresis (L1 有狀態機) 跟 shadow (無狀態 per-cycle simulation) lifecycle / 持久化完全不同，混一層導致誤解
- ❌ **5 層（+ L2.5 paper trading）**：P1 還沒 brainstorm，現在定 paper trading 層級是偷跑決策；paper trading 本質可能只是另一個 L0'（平行真實）而非 L2 擴充

### 目錄結構
- ❌ **完全 flat（Option Y，LP = implicit default）**：未來 FundingRate 會造成不對稱 — `positionAdvisor.ts` (LP implicit) vs `fundingRatePositionAdvisor.ts` (explicit)，讀者需要翻 doc 才知道 `positionAdvisor.ts` 只適用 LP
- ❌ **寬鬆 flat（Option Z，無對稱規則）**：太模糊，matrix model 變口頭約定
- ❌ **全部巢狀（連既有 `MonteCarloEngine.ts` 也搬進 `lp/`）**：觸碰大量 imports，違反 plan 獨立性且無實際 value

### Dead field 處理
- ❌ **Full refactor `appState.positions`**：等於原方向 (c)，已排除
- ❌ **立即刪除 dead field**：沒回答 scanner truth 歸屬問題

### Counterfactual vs Advice 關係
- ❌ **將 shadow driver 塞進 L1**：shadow 跟 hysteresis 的 lifecycle 完全不同，混一層會讓讀者誤以為兩者是同一機制
- ❌ **將 shadow 當成 L0 的平行真實（「虛擬鏈」）**：shadow 是 per-cycle 獨立 simulation，不跨 cycle 累積，跟 paper trading 的「有生命週期虛擬倉位」不同，不該當平行 L0

### Artifact
- ❌ **A 純 plan**：mental model 內容跟 execution task 混在 plan 檔案，plan ship 後被刪，model 也沒了
- ❌ **B 純 doc**：沒有執行保證，rename / STORAGE_PATHS 更新等工作容易累積 debt
- ❌ **`.claude/docs/position-tracking.md`**（β 位置）：不會自動載入，未來策略 brainstorm 時要手動 import
- ❌ **`docs/architecture/position-tracking.md`**（α 位置）：傳統架構 doc 位置，但 DexBot 目前 `docs/` 下主要放 ops runbook（`docs/ops/dr-runbook.md`），架構 doc 放這裡語意不通

### 一般原則
- ❌ **Plan 標註時間預估**：違反 CLAUDE.md「Avoid giving time estimates」原則

## Constraints（必須遵守的專案規則）

- **CLAUDE.md Plan 獨立性原則**（2026-04-11 生效）：本 plan 只能 read-only reference 其他 plan 的 Interfaces / Decisions，不得修改他 plan 的內容。**例外**：
  - Stage 4 對 P0 Stage 3 plan 的 `positionStateTracker` 路徑字串更新，屬於本 plan scope 內的直接操作（Decision D5 授權）
  - Stage 4 對 p0-backtest plan 的 `v3lpShadowDriver` → `lpShadowDriver` rename，同上
- **`.claude/rules/architecture.md`**：新 rule 檔案不改變整體目錄結構；`src/services/strategy/lp/` 子目錄屬於「新 LP plugin」而非新層級，不違反原則
- **`.claude/rules/naming.md`**：新 rule doc 本身是 markdown，不適用 camelCase/PascalCase 規則
- **`.claude/rules/testing.md`**：tests 維持 flat（`tests/services/` 不鏡射 source 的 `lp/` 巢狀）
- **CLAUDE.md line 101 命名規則**：Stage 1-4、Group 1.A-4.A 強制使用，本 plan 已遵守

## Interfaces（API 契約）

### `src/config/storage.ts` — MODIFY（Stage 3）

```ts
// DELETE 原 shadow / shadowAnalysis（零消費者，由 Eng review A1 1A 決策確認）
// ADD 4 個新 entries：
export const STORAGE_PATHS = {
    // ...既有不動 (backtestResults / ohlcv / diagnostics / debug / positions / bot)
    // shadow: DELETED
    // shadowAnalysis: DELETED
    shadowLp: `${STORAGE_ROOT}/shadow/lp`,
    shadowLpAnalysis: `${STORAGE_ROOT}/shadow/lp/analysis`,
    history: `${STORAGE_ROOT}/history`,              // base path for L3
    historyLp: `${STORAGE_ROOT}/history/lp`,
} as const;
```

**刪除 `shadow` / `shadowAnalysis` 的授權**：Eng review 階段 `grep -rn "STORAGE_PATHS.shadow" src/ tests/` 確認**零**個消費者（唯一引用在 `tests/config/storage.test.ts` 的測試斷言自己）。刪除無 breaking risk，符合 DRY + minimal diff 原則。

**連帶動作**：
- `tests/config/storage.test.ts` 現有對 `STORAGE_PATHS.shadow` / `shadowAnalysis` 的 2 個斷言**必須刪除**（否則 test 會 fail）
- 若 Stage 2 後有其他 plan 假設 `STORAGE_PATHS.shadow` 存在（例如 p0-backtest-verification），Stage 4 的 rename 會改成 `shadowLp`

### `.claude/rules/position-tracking.md` — NEW（Stage 2）

完整內容見 `i-position-tracking-alignment` Stage 2 產出。frontmatter 指定：
```yaml
---
paths: ["src/services/strategy/**", "src/services/position/**", "src/services/shadow/**", "src/bot/**"]
alwaysApply: false
description: "Position tracking mental model — 4 layer × N strategy 矩陣"
---
```

### `CLAUDE.md` 自動載入 rule 表格 — MODIFY（Stage 2）

**插入位置**（Eng review 4B 決策）：**緊接 `services.md` 之後**，理由是兩者主題相鄰（services 規範 service 層一般約束、position-tracking 是 service 層的具體 model）。

新增一行：
```md
| `position-tracking.md` | `src/services/strategy/**` 等 — 4 層 × N 策略矩陣 |
```

插入後的表格片段：
```md
| `architecture.md` | 整體目錄結構、AppState 注入原則 |
| `pipeline.md` | `src/runners/`、`src/services/` — Phase 0/1 分離 |
| `services.md` | `src/services/` — Service 層約束 |
| `position-tracking.md` | `src/services/strategy/**` 等 — 4 層 × N 策略矩陣 |  ← NEW
| `math.md` | `src/utils/math.ts` — Pure Function + BigInt |
| ... (其餘不動)
```

## Test Plan（TDD 起點，RED 階段測試清單）

本 plan 主要是 doc / plan 文字變更 + 1 個 `src/config/storage.ts` modification，需要測試的只有最後一項。

### `tests/config/storage.test.ts` — MODIFY（Stage 3）

既有測試涵蓋 8 個 entries。**Stage 3 刪除 2 個舊斷言 + 新增 8 個 case**，最終涵蓋 10 個 entries（`shadow` / `shadowAnalysis` 刪除、新增 4 個）：

**DELETE 的既有斷言**：
- ❌ `expect(mod.STORAGE_PATHS.shadow).toBe('./storage/shadow')`（測試檔 ~line 29）
- ❌ `expect(mod.STORAGE_PATHS.shadow).toBe('/custom/path/shadow')`（測試檔 ~line 38）
- ❌ `expect(mod.STORAGE_PATHS.shadowAnalysis).toBe('/custom/path/shadow/analysis')`（測試檔 ~line 39）

**ADD 的新 RED case**：
- [ ] RED: `STORAGE_PATHS.shadowLp === STORAGE_ROOT + '/shadow/lp'`
- [ ] RED: `STORAGE_PATHS.shadowLpAnalysis === STORAGE_ROOT + '/shadow/lp/analysis'`
- [ ] RED: `STORAGE_PATHS.history === STORAGE_ROOT + '/history'`
- [ ] RED: `STORAGE_PATHS.historyLp === STORAGE_ROOT + '/history/lp'`
- [ ] RED: `ensureStorageDir('shadowLp')` 冪等建立 `storage/shadow/lp/`（連同 `storage/shadow/` 父目錄）
- [ ] RED: `ensureStorageDir('historyLp')` 冪等建立 `storage/history/lp/`
- [ ] RED: `storageSubpath('shadowLp', '2026-04.jsonl')` → `./storage/shadow/lp/2026-04.jsonl`
- [ ] RED: TypeScript strict — `STORAGE_PATHS.shadow` 應 compile error（型別已不存在）

**無新增 src code 測試**，因為：
- Rule doc 不需要測試（markdown 文件）
- Plan 修改不需要測試（plan 文字）
- `CLAUDE.md` 修改不需要測試
- `tasks.md` 修改不需要測試
- P0 Stage 3 / p0-backtest plan 的文字修改不需要測試

## Tasks（subagent 執行順序）

### Stage 1 — Brainstorm artifact（本 plan 自己 + rule doc）

**Group 1.A / Write artifacts（sequential）**

1. **NEW** `.claude/rules/position-tracking.md`（見 Interfaces 段落）— **已於 brainstorm 階段完成**
2. **NEW** `.claude/plans/i-position-tracking-alignment.md`（本檔）— **已於 brainstorm 階段完成**
3. **PRIOR WORK**：`feature/position-advisor` 分支 rebase，`src/services/strategy/positionAdvisor.ts` → `src/services/strategy/lp/positionAdvisor.ts`，commit `ade8f44` — **已於 brainstorm 階段完成**

### Stage 2 — Rule 啟用 + CLAUDE.md 索引更新

**Group 2.A / Rule activation（sequential）**

4. **MODIFY** `CLAUDE.md`：自動載入 rule 表格新增一行 `position-tracking.md`（見 Interfaces 段落）
5. **VERIFY**：`rg "position-tracking" CLAUDE.md` 應有 1 個 hit

### Stage 3 — `src/config/storage.ts` 擴充 + tests

**Group 3.A / Storage paths extension（TDD，sequential）**

6. **RED**：修改 `tests/config/storage.test.ts`，加入 8 個新 case（見 Test Plan 段落）
7. **GREEN**：修改 `src/config/storage.ts`，加入 4 個新 entries（`shadowLp` / `shadowLpAnalysis` / `history` / `historyLp`）
8. **REFACTOR**：確認 TypeScript strict 通過、`STORAGE_PATHS` 所有 entries 仍為目錄（非檔案）
9. **VERIFY**：`npm test -- --testPathPatterns="storage"` 全綠

### Stage 4 — Rule override pointer 加到既有 plans（非侵入式，由 Eng review 2C 授權）

**策略說明**：由 Eng review A2 decision 2C，Stage 4 **不**直接修改 P0 / p0-backtest plan 的路徑字串與命名內容。改為在兩個 plan 的頂部加一個 **rule override pointer**，告訴執行階段 subagent「路徑字串 / 命名以 `.claude/rules/position-tracking.md` 為準，本 plan 內文保留為歷史 snapshot」。

這個設計的理由：
- 嚴守 CLAUDE.md Plan 獨立性原則 — 不修改他 plan 的實質內容
- `.claude/rules/position-tracking.md` 會自動載入到執行階段 subagent 的 context，讀到 P0 plan 內容時 rule 會覆蓋 plan 字串
- P0 / p0-backtest plan 內部提到的 `positionStateTracker` / `v3lpShadowDriver` / `storage/shadow/<YYYY-MM>.jsonl` 都保留為歷史紀錄，不改

**Group 4.A / P0 plan pointer（sequential）**

10. **MODIFY** `.claude/plans/p0-position-advice-system.md`：在 plan 最頂部（緊接 paper reservation note 後）新增一段 `📐 Rule override notice`：
    ```md
    > **📐 Rule override notice (2026-04-12)**：本 plan 內文的路徑字串與命名以 `.claude/rules/position-tracking.md` 為**實際執行依據**，本 plan 文字保留為歷史 snapshot：
    > - `src/utils/positionStateTracker.ts` → 實際位置 `src/services/strategy/lp/positionStateTracker.ts`（LP column L1）
    > - `tests/utils/positionStateTracker.test.ts` → 實際 `tests/services/positionStateTracker.test.ts`（tests flat）
    > - 其餘 LP-related 檔案以 rule doc 的「目錄 & 命名 convention」段落為準
    > 執行階段 subagent 遇到衝突一律以 rule 為準。若 rule 與本 plan 對同一語意有衝突以 rule 優先。
    ```
11. **VERIFY**：
    - `rg "Rule override notice" .claude/plans/p0-position-advice-system.md` 有 1 hit
    - `rg "src/utils/positionStateTracker" .claude/plans/p0-position-advice-system.md` 仍有若干 hits（歷史保留，不刪）

**Group 4.B / p0-backtest plan pointer（sequential）**

12. **MODIFY** `.claude/plans/p0-backtest-verification.md`：在 plan 最頂部（緊接既有 paper reservation note 後）新增一段：
    ```md
    > **📐 Rule override notice (2026-04-12)**：本 plan 內文的 shadow 路徑與命名以 `.claude/rules/position-tracking.md` 為**實際執行依據**：
    > - `v3lpShadowDriver` → 實際 `lpShadowDriver`（rule doc D5 Q6d）
    > - `storage/shadow/<YYYY-MM>.jsonl` → 實際 `storage/shadow/lp/<YYYY-MM>.jsonl`
    > - `storage/shadow/analysis/<weekIso>.md` → 實際 `storage/shadow/lp/analysis/<weekIso>.md`
    > - shadow log 的 STORAGE_PATHS entry 名稱 = `shadowLp` / `shadowLpAnalysis`（不是 `shadow` / `shadowAnalysis`，後者已在 i-position-tracking-alignment Stage 3 刪除）
    > 執行階段 subagent 遇到衝突一律以 rule 為準。
    ```
13. **VERIFY**：
    - `rg "Rule override notice" .claude/plans/p0-backtest-verification.md` 有 1 hit
    - `rg "v3lpShadowDriver" .claude/plans/p0-backtest-verification.md` 仍有若干 hits（歷史保留）

### Stage 5 — tasks.md follow-ups

**Group 5.A / P3 follow-ups（sequential）**

14. **MODIFY** `.claude/tasks.md`：在「雜項（無需開 plan 檔案）」或 P3 區塊新增 4 個條目：
    - `[ ] P3: 決定 appState.positions dead field 處理（刪除 vs 補活 vs 純 document）— 來源 i-position-tracking-alignment D2`
    - `[ ] P3: L3 archive writer 實作（lpClosedPositionArchive → storage/history/lp/<YYYY>.jsonl）+ minimum schema 定義 — 來源 i-position-tracking-alignment D5 Q6e`
    - `[ ] P3: Advice tracking feedback loop 儲存路徑決定（P2 雜項已登記，此處補指標） — 來源 i-position-tracking-alignment D6 Q7c`
    - `[ ] P3: Close reason counter 儲存路徑決定（P2 雜項已登記，此處補指標）— 來源 i-position-tracking-alignment D6 Q7c`
15. **VERIFY**：`rg "i-position-tracking-alignment" .claude/tasks.md` 應有 4 個 hits

### Stage 6 — Final smoke test

16. **VERIFY**：`npx tsc --noEmit` 零 error
17. **VERIFY**：`npm test` 全綠。測試數變化：
    - 既有 153 tests
    - Stage 3 storage.test.ts：**刪除 3 個舊斷言**（`STORAGE_PATHS.shadow` 相關），**新增 8 個新 case**
    - 預期最終 = 153 − 3 + 8 = **158 tests**
18. **VERIFY**：整份 plan 的 grep sanity check —
    - `rg "Stage [A-Z]\b" .claude/plans/i-position-tracking-alignment.md` 結果為空（確認無舊命名殘留）
    - `rg "STORAGE_PATHS\.shadow[^L]" src/ tests/` 結果為空（`shadow` / `shadowAnalysis` 已完全刪除，不匹配 `shadowLp` / `shadowLpAnalysis`）
    - `rg "positionStateTracker" src/` 結果為空（還沒實作，PR 5a 才會建）
    - `rg "lpShadowDriver" src/` 結果為空（同上，backtest Stage 2 才會建）
    - `rg "Rule override notice" .claude/plans/p0-*.md` 有 2 hits（Group 4.A + 4.B 各一）

## Smoke Test Checklist（Stage 6 驗證）

- [ ] `npx tsc --noEmit` 零 error
- [ ] `npm test` 全綠，測試數 153 → 158（刪 3 舊斷言 + 新增 8 個 storage test）
- [ ] `rg "position-tracking" CLAUDE.md` 有 1 hit（rule 表格引用），位置在 `services.md` 之後
- [ ] `rg "STORAGE_PATHS\.shadow[^L]" src/ tests/` 結果為空（舊 `shadow` / `shadowAnalysis` 已徹底刪除）
- [ ] `rg "STORAGE_PATHS.historyLp" src/` 應為空（Stage 3 只 add 常數，還沒有 src 消費者）
- [ ] `rg "Rule override notice" .claude/plans/p0-position-advice-system.md .claude/plans/p0-backtest-verification.md` 共 2 hits
- [ ] `rg "i-position-tracking-alignment" .claude/tasks.md` 有 4 hits（follow-up 條目）
- [ ] `rg "v3lpShadowDriver" .claude/plans/p0-backtest-verification.md` 仍有若干 hits（**刻意保留為歷史 snapshot**，rule override pointer 指引執行者以 rule 為準）
- [ ] `rg "src/utils/positionStateTracker" .claude/plans/p0-position-advice-system.md` 仍有若干 hits（同上，歷史保留）

## Risks

- **R1**：Stage 4 對 P0 Stage 3 plan 的 `positionStateTracker` 路徑字串更新可能漏掉某些引用點 — Mitigation：Task 11 的 `rg` VERIFY 會 catch
- **R2**：保留舊 `shadow` / `shadowAnalysis` entries 作為「base path」語意模糊，未來讀者可能誤用（例如把 LP shadow log 寫到扁平 `storage/shadow/` 而非 `storage/shadow/lp/`） — Mitigation：`position-tracking.md` rule 明確寫「L2 LP 路徑為 `storage/shadow/lp/`」；`src/config/storage.ts` 的 `shadow` entry 加 JSDoc 註記「base path，消費者應用 `shadowLp` 等具體策略路徑」
- **R3**：本 plan 執行時 PR 3 (`feature/position-advisor`) 尚未 merge 到 dev — Stage 4 修改 P0 plan 的路徑字串跟 PR 3 的 code 並行存在，若 PR 3 merge 後再跑本 plan 可能有衝突 — Mitigation：本 plan 只動 `.claude/plans/p0-position-advice-system.md` 跟 `.claude/plans/p0-backtest-verification.md` 的文字，**不**動 `src/services/strategy/lp/positionAdvisor.ts`（PR 3 的 code），所以不會有 conflict
- **R4**：`CLAUDE.md` 修改（Task 4）可能跟其他 concurrent 修改衝突 — Mitigation：本 plan 執行時先 `git pull`
- **R5**：`tests/config/storage.test.ts` 已由 i-unify-storage Stage 2 commit `4668445` 建立，Task 6 的 `MODIFY` 需要先確認既有測試結構，避免破壞 — Mitigation：Task 6 subagent 必須先 `Read` 既有 test 檔案再編輯
- **R6**：新 rule `position-tracking.md` 的 `paths` matcher 若過寬，可能不必要地載入進跟 position 無關的對話（例如只改 `src/config/` 的對話）— Mitigation：`paths` 精確設為 `src/services/strategy/**` / `src/services/position/**` / `src/services/shadow/**` / `src/bot/**`，不包含 `src/runners/` 或 `src/utils/`

## 與其他 plan 的依賴

| Plan | 依賴點 | 處理 |
|---|---|---|
| `p0-position-advice-system.md` | Stage 3 `positionStateTracker` 檔案位置 | Stage 4 task 10 修改路徑字串 |
| `p0-backtest-verification.md` | Stage 2 `v3lpShadowDriver` 命名與路徑 | Stage 4 task 12 修改路徑字串 + rename |
| `i-unify-storage.md` | Stage 2 已 ship 的 `STORAGE_PATHS` | Stage 3 task 7 擴充（新增 entries，不追溯修改既有） |
| Future P1 plan（Universal Strategy Engine）| 整份 matrix model + plugin contract | 本 rule doc 自動載入；P1 brainstorm 時繼承 |

## 與 PR 3 (`feature/position-advisor`) 的關係

- PR 3 rebase（commit `ade8f44`）是本 brainstorm 階段的 **prior work**，已完成
- PR 3 branch 上的檔案位置 (`src/services/strategy/lp/positionAdvisor.ts`) 對齊 matrix model
- **PR 3 merge 到 dev 的時機**：本 plan 執行完成後，或**先 merge PR 3 再跑本 plan 也可以**（兩者 touch 不同檔案）
- 推薦順序：**本 plan 先執行（Stage 2-5，純 doc/plan 變更）→ PR 3 merge → 後續 P0/backtest 啟動**

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 issues found, 0 critical gaps — all resolved inline (1A / 2C / 4B) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | N/A (非 UI plan) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Eng review 修改摘要**（已全部套用至本 plan）：
- **A1 → 1A**：`STORAGE_PATHS.shadow` / `shadowAnalysis` 兩個 dead entries 完全刪除（zero consumer 確認）。Stage 3 task 需連帶刪除 test 既有 3 個舊斷言，新增 8 個 RED case。Stage 6 smoke test 調整測試數從 161 → 158
- **A2 → 2C**：Stage 4 從「直接修改 P0 / p0-backtest plan 路徑字串」改為「加 rule override pointer 到兩個 plan 頂部」。嚴守 Plan 獨立性原則，rule doc 覆蓋 plan 字串作為執行依據
- **A3 → 4B**：CLAUDE.md 索引表格插入位置指定為 `services.md` 之後，理由是主題相鄰
- **A4 (paths matcher 範圍)**：低信心 finding，未納入決策，維持 plan 原設定 `src/bot/**`

**UNRESOLVED:** 0

**VERDICT:** ENG CLEARED — ready for Phase 2 execution.
