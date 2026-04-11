# DexBot 任務清單與路線圖 (Tasks & Roadmap)

> **本檔案定位：索引 + 輕量待辦**
> - 正式 feature（需決策、架構、TDD）→ 開 `.claude/plans/<name>.md`，此處只留一行索引指向 plan
> - 雜項修繕（typo、log level、bump 版本）→ 直接寫在 `## 🧹 雜項` 區塊，無需 plan
> - 完成後條目可保留打勾或刪除；該優先級全空則標注 ✅
>
> P0 最緊急 → P4 待討論

---

## 🎯 當前執行路線圖 (Current Execution Roadmap)

> 本段**跨 priority**統合所有**進行中 / 待啟動**的 plan 的 stage 執行順序。新 plan 啟動 / 既有 plan 完成時必須同步更新本段。細節決策請查對應 plan 檔案。
>
> **涉及的 plans：**
> - `.claude/plans/p0-position-advice-system.md`（主，PR 3 + PR 5a）
> - `.claude/plans/p0-backtest-verification.md`（副，PR 4 + PR 5b）
> - `.claude/plans/i-unify-storage.md`（infra，跨越 S0 / S0.5 / PR 6 / S7）

### 📦 PR / Stage 切分對照表

| 節點 | 內容 | 對應 Plan / Stage | 狀態 | 依賴 |
|---|---|---|---|---|
| PR 1 | Cloudflare R2 Backup | ~~`i-r2-backup.md`~~（已刪） | ✅ v0.2.0 已 ship | — |
| PR 2 | Sharpe scoring 重構 | `p0-position-advice-system.md` Stage 1 | ✅ GitHub PR #20 已合併 | — |
| S0 | Paper reservation（純 markdown commit + Railway PRE-FLIGHT 實測，不開 branch） | `i-unify-storage.md` Stage 1 | ✅ 2026-04-11（`6252c17` + `3e1275a`） | 無 |
| S0.5 | Config module foundation（`src/config/storage.ts` + `ensureStorageDir()` + test，獨立 merge 到 dev） | `i-unify-storage.md` Stage 2 | ✅ 2026-04-11（`d1d6fee`） | S0 |
| **PR 3** | **PositionAdvisor 純函數（第一行就 import `STORAGE_PATHS`）** | **`p0-position-advice-system.md` Stage 2** | **📋 下一步** | **S0.5 ✅** |
| PR 4 | Offline backtest harness（直接用 `STORAGE_PATHS.backtestResults`） | `p0-backtest-verification.md` Stage 1 | 📋 待啟動 | PR 3 |
| **PR 5a** | **P0 核心：state persistence + cycle integration + telegram + RebalanceService 清理 + ShadowSnapshot 寫入（fire-and-forget，無 analyzer）**。shadow observer 直接用 `STORAGE_PATHS.shadow` | `p0-position-advice-system.md` Stage 3-5 | 📋 待啟動 | PR 3、PR 4 |
| **PR 5b** | **Shadow 觀察層：weeklyAnalyzer + counterfactual 計算 + Telegram 週報 + `checkManualTuneTrigger()`**（讀 PR 5a 寫出的 shadow log） | `p0-backtest-verification.md` Stage 2-3 | 📋 待啟動 | PR 5a（或 PR 5a code 已穩定足以寫 PR 5b） |
| **PR 6** | **Storage refactor 剩餘部分：既有服務 path 替換 + Dockerfile/entrypoint + R2 收斂 + 測試重寫 + docs**（原 config module group 已併入 S0.5） | **`i-unify-storage.md` Stage 3** | **📋 待啟動** | **PR 5a + PR 5b 的較晚者（D2 硬約束：同 release window）** |
| **S7** | **Migration day + 48h 觀察（non-code）** | **`i-unify-storage.md` Stage 4** | **📋 待啟動** | **PR 6 merged + deployed** |

### 🎯 路線圖（PR 為單位）

**已完成**

- ✅ **PR 1 · Cloudflare R2 Backup** (v0.2.0, 2026-04-11)
- ✅ **PR 2 · Sharpe scoring 重構** (GitHub PR #20, 2026-04-11) — P0 Stage 1
- ✅ **S0 · i-unify-storage Stage 1 (Paper reservation)** (2026-04-11, `6252c17` + `3e1275a`)
  - P0 plan 路徑字串對齊 `storage/...`
  - P0 plan gap 補 `OpeningStrategy.mean/std`
  - R1 Railway volume rename PRE-FLIGHT 結果回填（可 rename 不需 delete+recreate）
- ✅ **S0.5 · i-unify-storage Stage 2 (Config module foundation)** (2026-04-11, `d1d6fee`)
  - 新建 `src/config/storage.ts`（`STORAGE_ROOT` + `STORAGE_PATHS` 8 領域 + `storageSubpath()` + `ensureStorageDir()`）
  - 8 個 TDD 測試全綠
- ✅ **PR 3 · P0 Stage 2 PositionAdvisor 純函數** (PR #28, 2026-04-12)
  - `recommendOpen` / `classifyExit` / `shouldClose` 三個純函數 + 21 個 tests
  - Rebase commit `ade8f44` 把檔案搬到 `src/services/strategy/lp/` 對齊 matrix model
- ✅ **i-position-tracking-alignment brainstorm + rule + plan** (2026-04-12, `37ebadf`)
  - `.claude/rules/position-tracking.md` 永久 matrix model rule（4 層 × N 策略）
  - `.claude/plans/i-position-tracking-alignment.md` 對齊 plan（plan-eng-review 已通過）

**待啟動**

- 📋 **i-position-tracking-alignment Phase 2 (Stage 2-6)**
  - Plan: `.claude/plans/i-position-tracking-alignment.md`
  - Stage 2: CLAUDE.md 索引表格新增 `position-tracking.md`（位置 = `services.md` 後）
  - Stage 3: `src/config/storage.ts` 擴充 — 刪除 `shadow` / `shadowAnalysis`、新增 `shadowLp` / `shadowLpAnalysis` / `history` / `historyLp`
  - Stage 4: P0 plan + p0-backtest plan 各加一段 Rule override notice pointer
  - Stage 5: tasks.md 新增 4 個 P3 follow-up
  - Stage 6: Final smoke test（153 → 158 tests）
  - **依賴**：無（純 doc / const 擴充，不阻擋其他 PR）
  - **建議時機**：下次 session 起手做，落實 matrix model 讓後續 PR 4/5a 對齊

- 📋 **PR 4 · backtest Stage 1 (Offline replay harness)**
  - Plan: `.claude/plans/p0-backtest-verification.md` Stage 1
  - 跑 5 個月歷史 × grid search，直接使用 `STORAGE_PATHS.backtestResults`
  - 產出 chosen thresholds 供 PR 5a 使用
  - 通過 A>0 / D>0 / C≥50% 絕對底線才允許進 PR 5a
  - **依賴**：PR 3 (advisor 純函數) ✅ + i-position-tracking-alignment Phase 2（建議先做完）

- 📋 **PR 5a · P0 Stage 3-5 核心 product value**
  - Plan: `.claude/plans/p0-position-advice-system.md` Stage 3-5
  - Stage 3: State persistence（`positionStateTracker` 整合進 `stateManager`）
  - Stage 4: Cycle integration（2 個新 cron jobs + mcEngine 寫 ShadowSnapshot 到 `STORAGE_PATHS.shadowLp`，fire-and-forget）
  - Stage 5: Telegram advice alerts + 刪 `RebalanceService`
  - **不含** `weeklyAnalyzer` / `manualTuneTrigger`（留 PR 5b）
  - ship 後使用者直接看到新功能
  - **依賴**：PR 4 (chosen thresholds)

- 📋 **PR 5b · backtest Stage 2-3 shadow 觀察層**
  - Plan: `.claude/plans/p0-backtest-verification.md` Stage 2-3
  - Stage 2: `weeklyAnalyzer` 週日 23:00 cron + counterfactual + `lpShadowDriver` + `shadowReportFormatter` + `alertService.sendShadowWeeklyReport`
  - Stage 3: `checkManualTuneTrigger()` 連續 2 週紅標邏輯 + `alertService.sendManualTuneAlert`
  - 讀 PR 5a 寫出的 shadow log，**單向依賴**
  - 無 user-visible UI 變化，純 observability
  - `manualTuneTrigger` 需 ≥ 2 週 shadow log 才可能 fire，不急
  - **依賴**：PR 5a (shadow log 已在寫入)

- 📋 **PR 6 · i-unify-storage Stage 3 storage refactor**
  - Plan: `.claude/plans/i-unify-storage.md` Stage 3
  - Group 3.A: 既有服務 path refactor（只改 `logger` / `diagnosticStore` / OHLCV；shadow observer + backtest writer 已在 PR 4/5 階段直接用新常數）
  - Group 3.B: Dockerfile app user UID 1001 + `bin/docker-entrypoint.sh` (chown only)
  - Group 3.C: 刪光 27 個 backup 測試 + 新測試 suite + `dr-dryrun.test.ts`
  - Group 3.D: R2 結構收斂（`MIRROR_PATHS=['storage/']` + tar root=`storage/` + `r2Restore` clean break）
  - Group 3.E: `docs/ops/dr-runbook.md` + README / CHANGELOG / `.env.sample`
  - **依賴**：PR 5a + PR 5b 較晚者
  - **D2 硬約束**：必須與較晚者在同 release window（同天或緊鄰 1-2 天）

- 📋 **Phase 3 release flow**（PR 5a / 5b / 6 合併前後）
  - `/cso` 資安掃描 → `/ship` 自動化 → 手動 `gh pr create` × 3 → self-review → merge 順序 PR 5a → PR 5b → PR 6 →（想部署時）手動 merge dev → main

- 📋 **S7 · i-unify-storage Stage 4 migration day**（non-code）
  - `railway service pause`
  - SSH: `tar czf /tmp/pre-migration.tgz /app/data /app/logs`
  - `railway volume download` insurance tarball 到本地
  - Railway dashboard 切 volume mount（按 S0 PRE-FLIGHT 結果選 rename 路徑）
  - Deploy Stage 3 merge commit
  - Entrypoint 自動 chown（不 mkdir）
  - Consumer services `ensureStorageDir` on init
  - Smoke test 13 項
  - `railway service resume`
  - 48h 觀察 daily mirror + weekly archive
  - T+7d 刪 insurance tarball
  - T+30d 清 R2 legacy `data/` + `logs/` prefix
  - **依賴**：PR 6 merged + deployed

**P1 平行軌道（非阻擋 P0，可在 P0 穩定後啟動）**

- 📋 **P1 Phase 1 · Trend follow strategy (BTC/ETH instance, research wedge)**
  - Plan: `.claude/plans/p1-trend-follow-strategy.md`（Path A office-hours 產出，2026-04-12）
  - Strategy class = trend follow via perp，driven by regime transitions
  - BTC/ETH instance = 用 pair trade (BTC-USD + ETH-USD on Hyperliquid) 補 LP short-vol 漏洞
  - Wedge = Approach A: subscribe 既有 regime engine 的 trend signal + 加 signed direction scalar（regime engine 唯一修改）
  - 5 Stages: types → direction scalar + pairTradeAdapter → backtest runner → pass criteria + 6-month run → pass/fail 分支（開新 plan or retrospective）
  - Pass criteria shape 已定（Sharpe / vs LP baseline / max DD / trade count / win rate），具體數字 Stage 4 mini-brainstorm 決定
  - **依賴**：`i-position-tracking-alignment` Phase 2 已完成（matrix rule active + storage.ts 擴充）
  - **下一步**：review 本 plan → `/plan-eng-review`（Path A 第 3 步必要）→ `superpowers:brainstorming` 定稿 → Phase 2 執行

### 關鍵依賴規則

- **S0 必須先於 S0.5**（S0.5 的 config module 要 import 正確的領域名稱，而領域名稱在 S0 的 paper reservation 就已敲定）
- **S0.5 必須先於 PR 3**（否則 P0 code 會 hardcode 舊路徑字串，Stage 3 Group 3.A 就無法縮小 scope）
- **PR 3 必須先於 PR 4**（backtest 依賴 advisor 純函數）
- **PR 4 必須先於 PR 5a**（PR 5a 需要 PR 4 產出的 chosen thresholds 寫入 config）
- **PR 5a 必須先於 PR 5b**（PR 5b 的 weeklyAnalyzer 讀 PR 5a 寫出的 shadow log；code 層面可提前寫 PR 5b，但 merge 順序需要 PR 5a 先）
- **PR 6 與 PR 5a/5b 較晚者同 release window**（D2 硬約束；若 PR 5b 與 PR 6 相隔 > 1 週，γ 假設失效，需回頭改寫 migration script）
- **S7 在 PR 6 merge + deploy 後**才執行（純 ops，非 code）

**跨 plan 並行策略 = P2（sequential plans）**：同一 plan 內 Group 可並行；不跨 plan 並行。實際順序 = S0 ✅ → S0.5 ✅ → PR 3 ✅ → **i-position-tracking-alignment Phase 2** → PR 4 → PR 5a → PR 5b → PR 6 → S7。

### 下次回來最自然的起點 = i-position-tracking-alignment Phase 2 (Stage 2-6)

S0 / S0.5 / PR 3 / i-position-tracking-alignment brainstorm 均已於 2026-04-11/12 完成。`src/config/storage.ts` 已在 dev，`.claude/rules/position-tracking.md` matrix model rule 已 commit，`.claude/plans/i-position-tracking-alignment.md` plan-eng-review 已通過。

Phase 2 第一步：在 dev 切 `feature/position-tracking-alignment` 分支，按 plan 的 Stage 2-6 順序執行：

1. **Stage 2**：CLAUDE.md 索引表格新增 `position-tracking.md`（插入位置 = `services.md` 後）
2. **Stage 3**：`src/config/storage.ts` 擴充 — 刪除 `shadow` / `shadowAnalysis`，新增 `shadowLp` / `shadowLpAnalysis` / `history` / `historyLp`（+ 更新 `tests/config/storage.test.ts` 刪 3 舊斷言、新增 8 個 RED case）
3. **Stage 4**：`p0-position-advice-system.md` + `p0-backtest-verification.md` 各加一段 Rule override notice pointer（不修改 plan 內文路徑字串，只加 pointer）
4. **Stage 5**：`tasks.md` 新增 4 個 P3 follow-up（appState.positions / L3 archive / advice tracking 路徑 / close reason counter 路徑）
5. **Stage 6**：Final smoke test（`npx tsc --noEmit` + `npm test` 153 → 158 + grep sanity check）

執行後 merge 到 dev，刪 plan（依 Phase 2 α 規則），才能進 PR 4。

---

## ✅ 已完成

### Shipped features（已進 production 或 merged dev）

- **Cloudflare R2 Backup** (v0.2.0, 2026-04-11): Daily mirror + weekly archive + analysis flatten + 手動 CLI restore + Telegram failure alert；prod/dev 雙 bucket + 兩組 token；CSO audit 修復 path traversal + tar.x hardening
- **Self-Learning Regime Engine** (PR #19, 2026-04-10): Continuous regime vector + evolutionary search + walk-forward validation + blended bootstrap + Telegram `/regime` 指令
- **P0 Stage 1 — Sharpe scoring 重構** (PR #20, 2026-04-11): MC score 從 `mean/|cvar95|` 改為 `mean/std`（Sharpe-like），含 seedrandom 固定 seed canary regression test
- **PR 3 — P0 Stage 2 PositionAdvisor 純函數** (PR #28, 2026-04-12, merge commit `34acf68`): `recommendOpen` / `classifyExit` / `shouldClose` 三個純函數 + 21 個 TDD tests，含 rebase commit `ade8f44` 把檔案搬到 `src/services/strategy/lp/positionAdvisor.ts` 對齊 matrix model

### Planning artifacts（plans 已寫 / brainstorm 已完成）

- **S0 — i-unify-storage Stage 1 (Paper reservation)** (2026-04-11, commit `6252c17` + `3e1275a`): P0 plan 路徑字串對齊 `storage/...`、P0 plan gap 補 `OpeningStrategy.mean/std`、R1 Railway volume rename PRE-FLIGHT 實測結果回填（可 rename 不需 delete+recreate → 採 migration state machine 4a 分支）
- **S0.5 — i-unify-storage Stage 2 (Config module foundation)** (2026-04-11, commit `d1d6fee`): 新建 `src/config/storage.ts`（`STORAGE_ROOT` / `STORAGE_PATHS` 8 個領域 / `storageSubpath()` / `ensureStorageDir()`），8 個 TDD 測試全綠、tsc strict 零 error、整體 18 suites / 132 tests 全綠；純 additive util module 解除 PR 3 / 4 / 5 所有新 code hardcode 舊路徑的風險
- **i-position-tracking-alignment brainstorm + rule + plan** (2026-04-12, commit `37ebadf`): `.claude/rules/position-tracking.md`（永久 4 層 × N 策略 matrix model rule，自動載入）+ `.claude/plans/i-position-tracking-alignment.md`（對齊 plan，plan-eng-review 已通過 3 個 issues inline resolved）
- **p1-trend-follow-strategy office-hours brainstorm** (2026-04-12): `.claude/plans/p1-trend-follow-strategy.md`（Path A 第 1 步產出，取代 tasks.md P1 舊版 Phase 1 framework-first task list）。核心決策：trend follow = strategy class，BTC/ETH pair trade 是 instance #1，wedge 用 Approach A（subscribe regime signal + signed direction scalar）。551 行，9 個 Decisions，5 個 Stages。待 `/plan-eng-review`（Path A 第 3 步必要）
- **Phase 1 Planning Brainstorm（2026-04-10/11/12）**: 五份 plan 完整就緒
  - `.claude/plans/p0-position-advice-system.md`
  - `.claude/plans/p0-backtest-verification.md`
  - `.claude/plans/i-unify-storage.md`
  - `.claude/plans/i-position-tracking-alignment.md`
  - `.claude/plans/p1-trend-follow-strategy.md` ← NEW 2026-04-12
  - ~~`.claude/plans/i-r2-backup.md`~~（已隨 v0.2.0 ship，依 Phase 2 規則 α 刪除）

---

## 🧹 雜項（無需開 plan 檔案）

- [ ] `runOnePath` 11 個 positional args 改成單一 `RunOnePathParams` object（code review S1, P0 Stage 1 follow-up）
- [ ] **PositionAdvisor follow-ups（PR 3 code review minor）** — 皆為 non-blocking，適當時機順手處理：
  - `formatPoolLabel` 改為 `0xabcd...ef12` 雙側縮寫（避免前綴碰撞，如 Base 上多個 `0x4200...` 池）
  - `recommendOpen` 的 `center === 0` guard 加 JSDoc 說明「理論上不發生的保險護欄」
  - `ATR_DEPTH_HOLD_MAX` 改名 `MAX_PENETRATION_ATR_MULTIPLE`（常數名更精確表達單位）
  - 若未來新增第二個 timeout-like 決策函數，統一注入 `nowMs: number` 參數取代 `Date.now()` 蔓延
  - `shouldClose` priority matrix 補齊剩餘 3 對：`trend↔opportunity_lost` / `trend↔timeout` / `il↔timeout`（目前靠鏈式傳遞性覆蓋，defensive testing 可補齊）
- [ ] **PositionAdvisor NaN hardening（PR 3 /cso informational）** — `recommendOpen` / `shouldClose` 對 `strategy.score` / `mc.score` / `strategy.mean` / `strategy.cvar95` 加 `Number.isFinite()` guard，避免 NaN 透過 `NaN < 0.5 === false` 繞過門檻後產生 NaN 欄位的 OpenAdvice。非安全議題，屬資料完整性。
- [ ] **P3: `appState.positions` dead field 處理**（刪除 vs 補活 vs 純 document）— 來源：`i-position-tracking-alignment` Decision D2。`PositionScanner.positions` 是 L0 truth owner、不經 AppState，此欄位目前宣告但從未寫入
- [ ] **P3: L3 archive writer 實作**（`lpClosedPositionArchive` → `storage/history/lp/<YYYY>.jsonl`）+ minimum schema 定義 — 來源：`i-position-tracking-alignment` Decision D5 Q6e。`STORAGE_PATHS.historyLp` 已於 Stage 3 建立，但無 writer
- [ ] **P3: Advice tracking feedback loop 儲存路徑決定**（P2 雜項已登記，此處補 matrix 指標）— 來源：`i-position-tracking-alignment` Decision D6 Q7c。aggregate stats 是 derived view，路徑延後決定
- [ ] **P3: Close reason counter 儲存路徑決定**（P2 雜項已登記，此處補 matrix 指標）— 來源：`i-position-tracking-alignment` Decision D6 Q7c。同上

---

## 🛠️ Infrastructure

> **Plan：** `.claude/plans/i-unify-storage.md`（Path B brainstorming + plan-eng-review 已通過，status: CLEAR）

### 📦 i-unify-storage Stage 總覽

| Stage | 內容 | 時機 | 依賴 |
|---|---|---|---|
| **Stage 1** | Paper reservation：更新 p0 plan 路徑字串 + Railway staging PRE-FLIGHT 實測 | **立即**（純 markdown/ops commit 到 dev，不開 branch） | 無 |
| **Stage 2** | Config module foundation：新建 `src/config/storage.ts` + `ensureStorageDir()` + test | **Stage 1 之後立即**（獨立 merge 到 dev，**不受** D2 硬約束） | Stage 1 |
| **Stage 3** | 既有服務路徑 refactor + Dockerfile/entrypoint + R2 結構收斂 + 測試重寫（**原 Config group 已併入 Stage 2**） | **與 P0 final PR 同 release window**（D2 硬約束） | P0 Stages 2-5 + backtest Stages 1-3 已全部 ship |
| **Stage 4** | Migration day：停機 → insurance tarball → volume 切換 → deploy → smoke test → 48h 觀察 → T+7d 刪 insurance → T+30d 清 R2 legacy prefix | Stage 3 merge 後 | Stage 3 |

**核心決策：** P2 flat 結構、`/app/storage/{shadow,backtest-results,ohlcv,diagnostics,debug,positions,bot}`、單 R2 prefix、γ 凍結 migration、roll-forward rollback、Stage 2 post-review 排序優化（避免 write-then-rewrite 浪費）

### 待啟動 infra feature

- [ ] **TG ops 指令取代 SSH 操作**（backup / restore / backfill）— 需獨立 Path B brainstorm，需先設計 ops service layer（`.claude/rules/telegram.md`：bot 只能 format/send，不含業務邏輯）。來源：i-unify-storage brainstorm Decision D13

---

## 🔴 P0 開倉建議系統 (Position Advice System)

> **Plan（主）：** `.claude/plans/p0-position-advice-system.md`
> **Plan（獨立 feature，依寬鬆隔離原則並存）：** `.claude/plans/p0-backtest-verification.md`
>
> 本 section 只保留 P0 專屬設計決策與 Stage 清單。**跨 plan 的 PR 切分、執行順序、依賴規則請見本檔案最上方的 🎯 當前執行路線圖**，不在此重複。


**核心痛點**：mcEngine 計算完只輸出原始數字，使用者不知道何時開倉、是否該 hold、何時該關倉。24h live test 發現 score > 0.5 有賺錢機會但缺乏可操作信號。

**架構決定（from CEO + Eng review，2026-04-10）：**
- **三個獨立排程**（不阻擋主邏輯）：
  - 主 cycle (10min)：prefetch + mcEngine + recommendOpen
  - 倉位狀態監控 (10min, 錯開)：fetchAll + classifyExit + shouldClose
  - 新倉位探索 (1h)：syncFromChain
- **全部正規化空間計算**（避免 ATR 單位混淆）
- **PositionAdvisor = pure functions in module**（不是 service class）
- **Score 公式改用 Sharpe-like** (`mean / std`)，取代 `mean / |cvar95|`（後者在 cvar→0 時爆炸）
- **3-gate hysteresis**（持久化）：連續 2 cycle + 1h LRU cooldown + 灰色帶 0.3-0.5
- **Cooldown key = positionId**（不是 pool，避免 multi-position 互相壓制）
- **Snapshot consistency**：position monitor 讀 `strategies.computedAt`，> 15min 視為 stale
- **Open + Close 雙向 hysteresis**（避免 score 邊界抖動）
- **TDD 先行**：25 個測試在實作前完成

### Stage 1 — Sharpe scoring 重構 ✅ PR #20 (2026-04-11)

- [x] MC score 從 `mean/|cvar95|` 改為 Sharpe-like `mean/std`
- [x] 含 seedrandom 固定 seed canary regression test

### Stage 2 — PositionAdvisor pure functions (TDD)

- [ ] 19 個 RED 測試 → 純函數實作 → REFACTOR
- 詳見 plan 檔案

### Stage 3 — State persistence (TDD)

- [ ] 整合 `positionStateTracker` 到現有 `stateManager`
- 詳見 plan 檔案

### Stage 4 — Cycle integration

- [ ] 新增 2 個獨立 cron jobs（位置監控、新倉位探索）
- [ ] mcEngine cycle 結尾整合 advisor + ShadowSnapshot 寫入
- 詳見 plan 檔案

### Stage 5 — Telegram + cleanup

- [ ] alertService 新增 advice alert types
- [ ] 刪除 RebalanceService class
- 詳見 plan 檔案

### Stage 6 — Backtest Verification（獨立 plan）

> **完整設計：** `.claude/plans/p0-backtest-verification.md`
>
> - **Stage 1** (offline replay) → PR 4
>   - 跑 5 個月歷史 × grid search、產出 chosen thresholds
>   - 寫到 `./storage/backtest-results/<date>/`（paper-reserved 新路徑，來自 S0）
>   - 通過絕對底線（A>0, D>0, C≥50%）才允許進 PR 5a
> - **Stage 2** (shadow mode) → PR 5b
>   - weekly analyzer + counterfactual 計算 + Telegram 週報
> - **Stage 3** (manual tune trigger) → PR 5b
>   - 連續 2 週同方向紅標觸發 `checkManualTuneTrigger()`，**不**自動改 config
>
> 60 個 RED 測試、framework/v3lp 兩層架構

---

## 🟠 P1 通用策略框架 (Universal Strategy Engine)

> ⚠️ **P1 舊版 brainstorm（tasks.md-embedded）已被 Phase 1 部分取代。** Phase 1 現在有正式 plan: `.claude/plans/p1-trend-follow-strategy.md`（2026-04-12 office-hours 產出）。
>
> 剩餘的 Phase 2a-2d + Phase 3 仍是 2026-04 前的舊流程遺產，**不具執行合約效力**，啟動時必須走 Path A 或 Path B brainstorm 產出正式 plan 後才可執行。
>
> **為什麼 Phase 2-3 還沒被取代**：Phase 1 trend follow 是當前最有價值的 research wedge，其他 Phase 需要等 Phase 1 backtest 結果出來後才有資訊決定要不要做、怎麼做。

### Phase 1 — Trend follow strategy（✅ 已有正式 plan）

> **Plan: `.claude/plans/p1-trend-follow-strategy.md`**
>
> - Strategy class = trend follow via perp，regime-driven
> - BTC/ETH instance 是第一個 instance（補 LP short-vol 漏洞）
> - Wedge = Approach A（subscribe 既有 regime signal + signed direction scalar）
> - Execution = pair trade BTC-USD + ETH-USD on Hyperliquid
> - Backtest-first，pass criteria gated production
> - 5 Stages（Stage 1 純邏輯 → 2 adapter + regime mod → 3 backtest runner → 4 pass criteria + 6-month run → 5.A/5.B pass/fail 分支）
> - Path A 進度：`/office-hours` ✅，下一步 `/plan-eng-review`（必要）
>
> ~~**舊版 Phase 1 task list**（MC 三層拆分 / PricePathGenerator / IStrategy interface / V3LPStrategy plugin / MC engine refactor）**已被拒絕**~~ — 理由：當前只有 1 個 strategy class，framework-first 抽象沒有 data 支撐（違反 strangler fig / rule of three）。正確做法是先 ship trend follow module（`src/services/strategy/trendFollow/`），等未來有 2-3 個 strategies 才 brainstorm framework 抽象。詳見 `p1-trend-follow-strategy.md` 的 Rejected 段落。

### Phase 2a — FundingRateStrategy

- [ ] FundingRate 數據源（preferred: 真實 perp DEX API；fallback: synthetic 基於歷史 vol）
- [ ] `src/services/strategy/FundingRateStrategy.ts`：實作 IStrategy
- [ ] 跑演化驗證：trend regime 是否自動偏好 perp 策略

### Phase 2b — StrategyAllocator + 視覺化

- [ ] `src/services/strategy/StrategyAllocator.ts`：regime vector → 策略權重向量（softmax）
- [ ] Regime Transition Alert：regime vector 24h 變化 > 20% → Telegram 通知 + 策略切換建議
- [ ] Historical regime-strategy backtest 視覺化：Telegram 文字圖表（非 Web）

### Phase 2c — LLM Strategy Advisor

- [ ] `src/services/strategy/LLMStrategyAdvisor.ts`：Phase 0 模組
- [ ] 輸入：regime vector + 市場數據摘要（限 ~500 tokens）+ 現有策略 score
- [ ] 輸出：自然語言策略建議 + pseudocode
- [ ] LLM 選擇：Claude API（claude-api skill），成本 ~$0.01/次
- [ ] Fallback：API 失敗 → log + Telegram 錯誤訊息（不重試）
- [ ] `/strategy suggest` Telegram 指令觸發
- [ ] One-click Paper Trading 按鈕（inline keyboard）

### Phase 2d — Paper Trading + 績效歸因

- [ ] `src/services/paper/PaperTradingService.ts`：用真實市場數據追蹤模擬倉位 PnL（取代舊的 Mirror 概念）
- [ ] Strategy Performance Attribution：每個策略對總 PnL 的貢獻
- [ ] Telegram 報告：「這週 V3 LP +X%，FundingRate +Y%，總計 +Z%」
- [ ] One-click adoption：LLM 建議 → 按鈕 → 自動啟動 paper trading

### Phase 3 — GP 表達式樹 ⚠️ 探索性研究（暫不交付）

- [ ] **前置 TODO**：先做 GP 計算量 benchmark（200 pop × 50 gen × 10k MC paths ≈ 100M simulations）
- [ ] Phase 3a：表達式樹節點系統 + GP crossover/mutation/hoist
- [ ] Phase 3b：Fitness 整合 walk-forward + LLM 解讀器

---

## 🟡 P2 進階策略 + 監控

- [ ] A/B Genome Dashboard：per-pool genome 分配 + `/regime ab <pool> <id>`
- [ ] 自動 evolution cycle（weekly cron on Railway）
- [ ] Safety guardrails：fitness 下降 > 20% → 自動回退上一代
- [ ] LPStrategyGenome 加入演化搜索（regime 穩定後）
- [ ] **Advice tracking + feedback loop**：發出 advice 後 log advice_id + 後續 N cycle 的 score 軌跡 → `data/advice-tracking.jsonl`
- [ ] **Close reason counter**：trend_shift / opportunity_lost / timeout / il_threshold 各自的觸發 counter，整合 diagnosticStore
- [ ] **Donchian breakout 對照實驗**（source: `p1-trend-follow-strategy.md` Approach B，降級至 P2 follow-up）— 用 Donchian channel 獨立指標跑 BTC/ETH 同期 backtest，跟 P1 Phase 1 trend follow（Approach A = regime subscribe）的 P&L / Sharpe / 勝率做對照。目的：驗證「regime engine signal 比業界標準 Donchian 更好 / 更差」。僅在 P1 Phase 1 pass 後執行才有意義

---

## 🔵 P3 延伸功能

### P3a · 產品強化

- [ ] `/calc` 強化版：regime-aware EV 估算
- [ ] 每日/每週幣本位 PnL 報告
- [ ] Unsupervised regime labeling：HMM/clustering 替代硬分類器打標
- [ ] Per-step regime blending：每個時間步切換 regime bucket

### P3b · 技術債 / 測試覆蓋

- [ ] `position: any` 型別修復：定義 V3 / V4 union type
- [ ] 擴充單元測試：覆蓋 utils (`stateManager`, `formatter`, `math`, `validation`) 及 AppState
- [ ] `index.ts` 測試覆蓋：dependency injection + Mock 邊界

### P3c · Paper Trading 衍生功能（依賴 P1 Phase 2d）

> Paper Trading (P1 Phase 2d) 取代了原本的 Mirror 概念。下列項目延續 mirror 願景，依賴 Phase 2d 完成。

- [ ] `/share` 分享卡片（獲客工具）
- [ ] Gas 成本追蹤（gas 費納入幣本位成本）
- [ ] 歷史決策回測（「如果你上次聽了建議不動，你會多 X ETH」）
- [ ] 開倉建議歷史準確度追蹤
- [ ] 多鏈支持（Base → Arbitrum → Ethereum）
- [ ] 多用戶 + 付費訂閱

---

## ⚪ P4 待討論後動工

### 架構債

- [ ] **DEX Adapter 模式**：統一介面 `IDexAdapter`，消除 if-else 分支
- [ ] **Strategy 模組重新評估**：`PnlCalculator`、`RiskManager`、`rebalance` 與 MC 引擎職責重疊

---

## 未來展望 (Ideas & Roadmap)

> 純 idea backlog，**未排期、未 brainstorm**。啟動任一項都要走 Path A `/office-hours` 或 Path B `brainstorming` 產出正式 plan 檔案。

### A · 產品形態轉型（做完 P0 + P1 後才有資格討論）

- **透明 Vault + Telegram 控制台**：智能合約 vault，MC 引擎驅動自動 rebalance
- **委託執行 Bot**：用戶授權錢包，一鍵確認執行
- **期權對沖 IL**：LP + Put Option 套期保值

### B · 策略擴張（DeFi-native 獨立產品方向）

- **Delta-Neutral 整合對沖**：接入永續 DEX (GMX / Hyperliquid)
- **跨池流動性遷移**：不同 DEX 費率層搬磚機會
- **Smart Money 追蹤**：鏈上頂級 LP 地址分析
- **LVR 監控防禦**：基於 Order Flow 避免套利者吸血

### C · ML / Research（跟 P1 Phase 3 GP 表達式樹相鄰）

- **Auto Feature Discovery**：在 Genome 中加入 feature weights
- **Online Learning**：從離線回測遷移到 production 中持續學習
