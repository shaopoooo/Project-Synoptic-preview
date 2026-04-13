# Feature: P0 開倉建議系統 (Position Advice System)

> 本檔案由 gstack 在 Phase 1 結尾產出，作為交接給 superpowers (Phase 2) 的正式契約。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由 gstack 更新。

## Context（為何要做）

- **來源：**
  - `/office-hours` 2026-04-09：產出 Universal Crypto Strategy Engine design doc（APPROVED）
  - `/plan-eng-review` 2026-04-09：通用框架的 eng review，產出混合架構決定
  - `/plan-ceo-review` 2026-04-10：使用者在 24h live test 中發現真實痛點，**重排優先級** → P0 = 開倉建議系統，P1 = 通用框架
  - `/plan-eng-review` 2026-04-10：本 plan 的 eng review，outside voice 找出 18 個問題，5 個 critical 已解決

- **動機與商業價值：**
  - 24h live test 發現：mcEngine 計算完只輸出原始數字（score, CVaR, range），使用者不知道何時開倉、是否該 hold、何時該關倉
  - score > 0.5 的池子代表賺錢機會，但系統沒有可操作信號
  - 趨勢市時 bot 正確 no-go 不開倉，但使用者沒有「該等多久 / 該不該關倉」的依據
  - **核心目標：** mcEngine 計算後產生具體的「開倉 / hold / rebalance / 關倉」建議，透過 Telegram 推送

## Decisions（已定案，執行階段不得動搖）

### 架構

1. **三個獨立 cron 排程**（不阻擋主邏輯）
   - 主 cycle (10min)：`prefetch + runMCEngine + recommendOpen` (Scenario A)
   - 倉位狀態監控 (10min, 與主 cycle 錯開 5min)：`PositionScanner.fetchAll() + classifyExit + shouldClose` (Scenario B/C)
   - 新倉位探索 (1h)：`PositionScanner.syncFromChain()` (incremental)
   - 各排程獨立 `isRunning` guard 防止並發

2. **PositionAdvisor = pure functions in module**（不是 service class）
   - 符合 `.claude/rules/math.md` 的 pure function 規範
   - 模組路徑：`src/services/strategy/positionAdvisor.ts`
   - 三個函數：`recommendOpen` / `classifyExit` / `shouldClose`

3. **全部正規化空間計算**
   - currentTick → 正規化 price（除以 normFactor）
   - ATR 一律用 `guards.atrHalfWidth`（已正規化），**不用** `MarketRegime.atr`（raw）
   - Range 邊界 (Pa/Pb) 用正規化空間
   - 避免 ATR 單位混淆導致穿出深度差一個數量級

4. **Score 公式改為 Sharpe-like (`mean / std`)**
   - 取代現有的 `mc.mean / Math.abs(mc.cvar95)`
   - 原公式在 cvar95 → 0 時爆炸至無限大，門檻判斷失效
   - Breaking change：影響 `MonteCarloEngine.ts` 內 score 計算 + 所有 OpeningStrategy.score 的 callers

5. **3-gate hysteresis（全部持久化）**
   - Gate 1: 連續 2 個 cycle 超過門檻才觸發（open AND close 雙向）
   - Gate 2: LRU cooldown 1 小時，**key = positionId**（不是 pool address）
   - Gate 3: 灰色帶 0.3-0.5 不觸發任何動作
   - **必須持久化：** hysteresis counter + cooldown timestamps + outOfRangeSince map
   - 重啟後門檻不失效

6. **Snapshot consistency**
   - Position monitor 讀取 `appState.strategies[poolId].computedAt`
   - 若 > 15min ago → 視為 stale，跳過該池子的 close 判斷
   - 防止跨排程 race condition 導致同一倉位同時被 open + close

7. **State persistence 整合 stateManager**
   - 不新建獨立檔案，納入現有 `src/utils/stateManager.ts`
   - 持久化欄位：outOfRangeSince、scoreHistory（hysteresis）、alertCooldowns

### 場景決策邏輯

**Scenario A（無倉位 → 開倉建議）**
- 觸發：mcEngine 計算完，score > 0.5 連續 2 cycle
- 灰色帶：score 在 [0.3, 0.5] 不觸發
- 期望值 = `MCSimResult.mean × 100`（14 天模擬，相對 HODL 基準，Telegram 需註記）
- 錯誤處理：mcEngine 資料不足或 regime 計算失敗 → log warning + 跳過

**Scenario B（穿出 → Hold vs Rebalance）**
- 觸發：`currentPriceNorm < Pa` OR `currentPriceNorm > Pb`
- 穿出深度 = `|currentPriceNorm - nearestBound| / atrHalfWidth`
- 決策：
  - depth < 2×ATR AND `regime.range > 0.5` → **HOLD**
  - 否則 → **REBALANCE**
- 2×ATR 閾值標記為「經驗值，待 backtest 驗證」

**Scenario C（關倉建議，雙向 hysteresis）**
- 觸發任一條件連續 2 cycle：
  1. `regime.trend > 0.6`（市場轉趨勢）
  2. `mc.score < 0.3`（機會消失）
  3. `outOfRangeSinceMs > 4 * 60 * 60 * 1000`（穿出 4h 未回歸）
  4. `cumulativeIL > 0.05 * initialCapital`（IL 5%）
- 優先序：`trend_shift > il_threshold > opportunity_lost > timeout`
- IL = null 時不觸發 IL 條件

### Cleanup

8. **刪除 `RebalanceService` class**
   - 舊的 BB drift 三級策略（wait/DCA/withdrawSingleSide）邏輯刪除
   - `calculateV3TokenValueRatio` 抽出為純函數，移到 `src/utils/math.ts`
   - 確認所有 callers 已更新

## Rejected（已否決，subagent 不得再提）

- ❌ **使用 `mean / |cvar95|` 作為 score**：cvar→0 時爆炸，門檻無意義
- ❌ **Cooldown key 使用 pool address**：multi-position per pool 時會互相壓制，看不到其中一個建議
- ❌ **將位置監控塞進主 cycle**：阻擋主 mcEngine 邏輯，違反「不阻擋主邏輯」原則
- ❌ **只持久化 outOfRangeSince，hysteresis counter 留記憶體**：重啟後門檻失效，使用者重啟一次被轟炸一次
- ❌ **Close 側不需要 hysteresis（單次觸發即可）**：score 在 0.49 抖動會「open → close → open → close」反覆轟炸
- ❌ **使用 raw `MarketRegime.atr` 做穿出深度計算**：與正規化空間的 currentPrice 單位不同，差一個數量級
- ❌ **Service class 模式**：違反 `.claude/rules/math.md` pure function 規範
- ❌ **在重構同時改邏輯**（structural + behavioral 一起改）：違反 Beck 的「先 refactor 再 implement」原則。Phase 1 先做 Sharpe scoring 重構並用 canary test 驗證，再進 Phase 2 加新邏輯
- ❌ **跳過 backtest 驗證直接 ship**：2×ATR 與 Sharpe 0.5 是經驗值，必須在 ship 前用 24h+ live data 驗證
- ❌ **新增 `data/position-state.json` 獨立檔案**：應整合進現有 stateManager
- ❌ **延後 Scenario B/C 到第二波**（outside voice 建議）：使用者明確要求三個場景一起做
- ❌ **保留 RebalanceService 與新邏輯並存**：兩套邏輯會給出矛盾建議，必須完整取代

## Constraints（必須遵守的專案規則）

- **`.claude/rules/architecture.md`：**
  - Service 必須透過參數注入依賴，避免直接修改 AppState
  - 新功能必須先更新 `.claude/tasks.md` ✅（已更新）

- **`.claude/rules/pipeline.md` (Phase 0 / Phase 1 分離)：**
  - Phase 0 (Prefetch)：所有 RPC / API 集中（`PositionScanner.fetchAll()` + `prefetchAll()`）
  - Phase 1 (Compute)：純函式，禁止 `await` / RPC / API
  - PositionAdvisor 三個函數**必須是 pure function**（屬於 Phase 1）
  - 違反此原則會導致回測不穩定

- **`.claude/rules/math.md`：**
  - 所有數學函式必須是 Pure Function（無副作用）
  - 關鍵計算邏輯集中在 `utils/math.ts`
  - 禁止 decimal.js，使用原生 BigInt 或 V3 SDK Math
  - `calculateV3TokenValueRatio` 移到 `utils/math.ts`

- **`.claude/rules/naming.md`：**
  - 純函式模組：`camelCase.ts`（→ `positionAdvisor.ts`）
  - Class / Service：`PascalCase.ts`（不適用，本 plan 不建 class）
  - TypeScript strict，**禁止 `any`**
  - 常數：`UPPER_SNAKE_CASE`

- **`.claude/rules/services.md`：**
  - 複雜金融邏輯（hold/rebalance/close 決策）必須有清楚的中文註解 + 公式推導
  - DEX 差異封裝在 Adapter 層（本 plan 不涉及新 DEX）

- **`.claude/rules/logging-errors.md`：**
  - 禁用 `console.log`，統一 `createServiceLogger('PositionAdvisor')`
  - RPC 呼叫包 `rpcRetry`（cron job 內 fetchAll 已是）
  - API 失敗 → fallback + log 到 `appState.cycleWarnings`

- **`.claude/rules/security.md`：**
  - 私鑰只在 .env，不 commit
  - Dry Run 模式不執行真實交易（本 plan 只做 advice，不執行）

- **`.claude/rules/telegram.md`：**
  - `src/bot/` 只能格式化文字 + 發送訊息
  - 業務邏輯必須在 `src/services/`（PositionAdvisor）或 `src/runners/`
  - alertService 只能呼叫 PositionAdvisor 並格式化結果

## Interfaces（API 契約）

```ts
// src/types/positionAdvice.ts (NEW)

import type { RegimeVector, OpeningStrategy, PositionRecord, MCSimResult } from './index';

/** 開倉建議 */
export interface OpenAdvice {
  poolId: string;
  poolLabel: string;          // dex 名稱 + 縮寫地址
  ratio: string;              // ETH/BTC ratio 描述（"目前 0.0307"）
  rangeWidthPct: number;      // ±X%（例如 4.2）
  score: number;              // Sharpe-like, mean/std
  expectedReturnPct: number;  // MC mean × 100，14 天，相對 HODL
  cvar95Pct: number;          // 風險指標
  regimeVector: RegimeVector;
}

/** 穿出後的決策 */
export type ExitDecision = 'hold' | 'rebalance';

export interface ExitAdvice {
  positionId: string;
  poolLabel: string;
  decision: ExitDecision;
  penetrationDepthAtr: number;  // 穿出幾個 ATR
  ilEstimatePct: number;        // 重開倉的 IL 估算（%）
  gasCostUsd: number;           // ~$0.5 on Base
}

/** 關倉原因（優先序：trend > il > score > timeout） */
export type CloseReason =
  | 'trend_shift'        // regime.trend > 0.6
  | 'il_threshold'       // cumulativeIL > 5%
  | 'opportunity_lost'   // mc.score < 0.3
  | 'timeout';           // outOfRange > 4h

export interface CloseAdvice {
  positionId: string;
  poolLabel: string;
  reason: CloseReason;
  cumulativePnlPct: number;
}

// ─────────────────────────────────────────────────────
// src/services/strategy/positionAdvisor.ts (NEW)

/** 開倉建議候選 — 不含 hysteresis 狀態判定 */
export function recommendOpen(
  strategy: OpeningStrategy | null,
  regimeVector: RegimeVector,
  poolLabel: string,
): OpenAdvice | null;

/** 穿出後的 Hold vs Rebalance 決策 */
export function classifyExit(
  position: PositionRecord,
  currentPriceNorm: number,
  PaNorm: number,
  PbNorm: number,
  atrHalfWidth: number,
  regimeVector: RegimeVector,
): ExitAdvice | null;

/** 關倉觸發判定 */
export function shouldClose(
  position: PositionRecord,
  mc: MCSimResult,
  regimeVector: RegimeVector,
  outOfRangeSinceMs: number | null,
  cumulativeIlPct: number | null,
): CloseAdvice | null;

// ─────────────────────────────────────────────────────
// src/utils/positionStateTracker.ts (NEW, 屬於 stateManager 一部分)

export interface PositionAdvisorState {
  /** key = poolId, value = score history (最近 N cycle) */
  scoreHistory: Record<string, number[]>;
  /** key = positionId, value = first detected out-of-range timestamp */
  outOfRangeSince: Record<string, number>;
  /** key = `${type}:${positionId}`, value = last alert timestamp */
  alertCooldowns: Record<string, number>;
}

export function loadAdvisorState(): PositionAdvisorState;
export function saveAdvisorState(state: PositionAdvisorState): Promise<void>;

/** Hysteresis: 是否該觸發 open advice？需連續 2 cycle 超過 0.5 */
export function passesOpenHysteresis(
  state: PositionAdvisorState,
  poolId: string,
  currentScore: number,
): boolean;

/** Hysteresis: 是否該觸發 close advice？需連續 2 cycle 達成 close 條件 */
export function passesCloseHysteresis(
  state: PositionAdvisorState,
  positionId: string,
  conditionMet: boolean,
): boolean;

/** Cooldown 檢查：1h 內同一 positionId 不重複 */
export function checkCooldown(
  state: PositionAdvisorState,
  type: 'open' | 'close' | 'rebalance',
  positionId: string,
): boolean;
```

**Modify (不新增介面，但更動既有型別):**

```ts
// src/services/strategy/MonteCarloEngine.ts
// Score 公式從 mean/|cvar95| → mean/std
// 影響欄位：MCSimResult 內的 score 計算
// 影響 callers：mcEngine.ts:135, calcCommands.ts (任何讀 OpeningStrategy.score 的地方)
```

**Delete:**

```ts
// src/services/strategy/rebalance.ts
// - 刪除 RebalanceService class
// - calculateV3TokenValueRatio 移到 src/utils/math.ts (保留為純函數)
```

## Test Plan（TDD 起點，RED 階段的測試清單）

**測試先行原則：** Phase 2 / 3 / 4 必須先寫 RED 測試再寫實作。25 個測試在實作前完成。

### tests/services/PositionAdvisor.test.ts (NEW)

#### `recommendOpen()` — 6 cases

- [ ] RED: strategy.score = 0.6, regime 正常 → 回傳 OpenAdvice，含 Sharpe score、expectedReturnPct、cvar95Pct
- [ ] RED: strategy.score = 0.4（灰色帶） → 回傳 null
- [ ] RED: strategy.score = 0.2（< 0.3） → 回傳 null
- [ ] RED: strategy = null → 回傳 null（無 mcEngine 結果）
- [ ] RED: strategy.score = 0.55, regime.trend > 0.6 → 仍回傳 OpenAdvice（hysteresis 是上層責任，advisor 只判斷數字）
- [ ] RED: strategy.computedAt 為 0 → 回傳 null（無有效計算）

#### `classifyExit()` — 6 cases

- [ ] RED: currentPriceNorm 在 [Pa, Pb] 內 → 回傳 null（沒穿出）
- [ ] RED: 穿下界深度 1.5×ATR, regime.range = 0.7 → decision='hold'
- [ ] RED: 穿下界深度 1.5×ATR, regime.range = 0.4 → decision='rebalance'（regime 不夠 range）
- [ ] RED: 穿下界深度 3×ATR, regime.range = 0.7 → decision='rebalance'（太深）
- [ ] RED: 穿上界深度 1.5×ATR, regime.range = 0.7 → decision='hold'（對稱性）
- [ ] RED: atrHalfWidth = 0 → decision='rebalance'（避免除零）

#### `shouldClose()` — 7 cases

- [ ] RED: regime.trend = 0.7 → CloseAdvice with reason='trend_shift'
- [ ] RED: mc.score = 0.2 → reason='opportunity_lost'
- [ ] RED: outOfRangeSinceMs = (Date.now() - 5h) → reason='timeout'
- [ ] RED: cumulativeIlPct = 0.06 → reason='il_threshold'
- [ ] RED: trend > 0.6 AND il > 5% → 回傳 trend_shift（優先序最高）
- [ ] RED: outOfRangeSinceMs = null → 不觸發 timeout（即使其他條件）
- [ ] RED: cumulativeIlPct = null → 不觸發 IL，但其他條件仍可觸發

### tests/utils/positionStateTracker.test.ts (NEW)

- [ ] RED: save → load round-trip 保留 outOfRangeSince、scoreHistory、alertCooldowns
- [ ] RED: removePosition(positionId) 後 outOfRangeSince + cooldowns 不再含該 key
- [ ] RED: load 不存在的檔案 → 回傳空 state（不 throw）
- [ ] RED: passesOpenHysteresis：第一次 score=0.6 → false（只 1 次）
- [ ] RED: passesOpenHysteresis：連續第二次 score=0.6 → true
- [ ] RED: passesCloseHysteresis：跟 open 對稱
- [ ] RED: checkCooldown：剛 alerted 過 → false（在冷卻中）
- [ ] RED: checkCooldown：1h 後 → true（冷卻結束）

### tests/integration/positionMonitorCycle.test.ts (NEW)

- [ ] RED: cron 觸發 → mock fetchAll → mock advisor return advice → sendAlert 被呼叫一次
- [ ] RED: 並發觸發（第一次未完成又觸發）→ 第二次被 isRunning guard 跳過
- [ ] RED: fetchAll throws → caught, log error, no alert sent
- [ ] RED: strategies.computedAt > 15min ago → snapshot stale，跳過 close 判斷

### tests/services/MonteCarloEngine.test.ts (MODIFY)

- [ ] RED: Sharpe score 計算正確（mean=0.05, std=0.02 → score=2.5）
- [ ] RED: Sharpe score 在 std 接近 0 時不爆炸（加 epsilon）
- [ ] RED: 固定 seed canary：原 score 公式輸出 vs 新 Sharpe 公式輸出 → 兩者都符合 snapshot

### TDD 守則

- 每個測試先 **RED**（執行 → 失敗）
- 寫最少程式碼讓測試 **GREEN**
- **REFACTOR** 階段不改測試行為
- 嚴禁先寫實作再補測試（違反 `.claude/rules` test-oracle-gap 教訓）

## Tasks（subagent 執行順序）

> Stage 內若未明確分 Group，預設整個 Stage 為單一 Group（sequential）。Group 拆分可在進入 Phase 2 執行時依需要補上。

### Stage 1 — Sharpe scoring 重構 ✅ PR #20

**已完成**（2026-04-11 合併到 dev）。任務記錄保留供歷史追溯：

1. **RED**：寫 Sharpe score 計算測試 + canary regression test（固定 seed）
2. **GREEN**：在 `MonteCarloEngine.ts` 新增 Sharpe 計算，**保留**舊 score 為 backup 欄位
3. **GREEN**：所有 caller 改讀 Sharpe score（mcEngine.ts:135 + calcCommands.ts）
4. **VERIFY**：跑所有現有測試 + canary，確認沒有 regression
5. **REFACTOR**：移除舊的 cvar-based score 公式

### Stage 2 — PositionAdvisor pure functions（TDD）

6. **RED**：寫 `tests/services/PositionAdvisor.test.ts` 19 個 cases（全部失敗）
7. **GREEN**：建立 `src/types/positionAdvice.ts`（型別定義）
8. **GREEN**：實作 `src/services/strategy/positionAdvisor.ts` 的 3 個函數，逐一讓測試 GREEN
9. **REFACTOR**：抽出共用 helper（例如「穿出方向偵測」），保持純函數

### Stage 3 — State persistence（TDD）

10. **RED**：寫 `tests/utils/positionStateTracker.test.ts` 8 個 cases
11. **GREEN**：實作 `src/utils/positionStateTracker.ts`，整合到 `stateManager.ts`
12. **VERIFY**：手動 restart 測試（寫狀態 → kill process → restart → 狀態還在）
13. **REFACTOR**：確認 schema 清晰，欄位命名一致

### Stage 4 — Cycle integration

14. **RED**：寫 `tests/integration/positionMonitorCycle.test.ts` 4 個 cases
15. **GREEN**：在 `src/index.ts` 新增 2 個獨立 cron job
    - 倉位狀態監控 (10min, 與主 cycle 錯開 5min)，含 isRunning guard
    - 新倉位探索 (1h)，含 isRunning guard
16. **GREEN**：在 `src/runners/mcEngine.ts` 加 advisor call + hysteresis check + sendAlert
17. **GREEN**：實作 snapshot staleness guard（讀取 strategies.computedAt > 15min 跳過）
17.5 **GREEN**：cycle 結尾組裝 ShadowSnapshot 並 fire-and-forget 呼叫 shadowLogger
    - 從 advisor 內部狀態取出當下的 hysteresis counters
    - 從 config 讀取 currentThresholds
    - 組裝完整 ShadowSnapshot（含 mcEngine 輸出、regime、範圍、currentPriceNorm、triggered flags、positionState）
    - shadowLogger 介面與 ShadowSnapshot 型別由 `.claude/plans/p0-backtest-verification.md` 定義，本 task 僅呼叫（read-only reference）
18. **VERIFY**：跑整合測試 + 跨 cron 錯開模擬

### Stage 5 — Telegram + cleanup

19. **GREEN**：在 `src/bot/alertService.ts` 新增 advice alert 類型 + per-positionId LRU cooldown
    - 注意：alertService 的其他新方法（`sendShadowWeeklyReport`、`sendBackupFailure`、`sendPhase5cTrigger`）由各自的 plan 定義，本 task 不負責，但需保證 alertService 介面設計具備擴展性
20. **GREEN**：Telegram 訊息格式（中文，註記「相對 HODL 基準」）
21. **DELETE**：移除 `src/services/strategy/rebalance.ts` 的 `RebalanceService` class
22. **MOVE**：把 `calculateV3TokenValueRatio` 移到 `src/utils/math.ts`（保留為純函數）
23. **VERIFY**：grep 確認沒有 RebalanceService callers 殘留
24. **REFACTOR**：所有 advice 訊息共用同一個 Telegram formatter

### Stage 6 — Backtest Verification

> **詳細設計：** `.claude/plans/p0-backtest-verification.md`（獨立 plan）
>
> 此 Stage 不在 P0 plan 內展開，僅列出 P0 對 backtest 的依賴。

**P0 對 backtest 的核心依賴**（read-only reference）：
- 此 Stage 必須在 PR 3（PositionAdvisor 純函數）合併之後執行
- backtest grid search 的最佳 thresholds 將寫入 PR 5 的 PositionAdvisor config
- backtest 必須通過「絕對底線（A>0, D>0, C≥50%）」才允許 P0 進入生產
- 若 backtest 不通過 → P0 退回 Decisions 段落 review

**獨立執行單元**：本 Stage 由獨立 PR 4 處理，不在 P0 主線 PR（PR 5）內合併

### PR 切分

| 邏輯 PR | 內容 | 對應 Plan / Stage | 狀態 |
|---------|------|------------------|------|
| PR 1 | Cloudflare R2 Backup（完整） | `.claude/plans/i-r2-backup.md`（Stage 1-5） | 📋 待啟動 |
| PR 2 | Sharpe scoring 重構 | P0 Stage 1 | ✅ GitHub PR #20 |
| PR 3 | PositionAdvisor 純函數 | P0 Stage 2 | 📋 待啟動 |
| PR 4 | Offline backtest harness | `p0-backtest-verification.md` Stage 1 | 📋 依賴 PR 3 |
| PR 5 | Cycle integration + Telegram + Shadow | P0 Stage 3-5 + backtest Stage 2 | 📋 依賴 PR 3、PR 4 |

PR 4 的 grid search 結果（chosen thresholds）寫入 PR 5 的 PositionAdvisor config。

### 完成標準

- 所有 25 個單元測試 GREEN
- Canary regression：score 公式變更前後 MC 輸出可預測
- 手動跑 24h，確認：
  - score > 0.5 連續 2 cycle 才推送
  - 同一 positionId 1h 內不重複推送
  - 穿出後正確判斷 hold / rebalance
  - 關倉條件正確觸發
  - Process restart 後 hysteresis + cooldown 仍生效
- `RebalanceService` callers 全部移除
- 跑 `/cso` 確認無安全漏洞
- 跑 `/ship` 整理 commit 並建 PR
