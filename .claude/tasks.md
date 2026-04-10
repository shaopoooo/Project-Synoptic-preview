# DexBot 任務清單與路線圖 (Tasks & Roadmap)

> **本檔案定位：索引 + 輕量待辦**
> - 正式 feature（需決策、架構、TDD）→ 開 `.claude/plans/<name>.md`，此處只留一行索引指向 plan
> - 雜項修繕（typo、log level、bump 版本）→ 直接寫在 `## 🧹 雜項` 區塊，無需 plan
> - 完成後條目可保留打勾或刪除；該優先級全空則標注 ✅
>
> P0 最緊急 → P4 待討論
>
> **設計文件：**
> - 開倉建議系統：`~/.gstack/projects/shaopoooo-dexbot/shao-feature/p0-regime-engine-design-20260409-201538.md`
> - CEO Plan：`~/.gstack/projects/shaopoooo-dexbot/ceo-plans/2026-04-10-universal-strategy-engine.md`
> - Test Plan：`~/.gstack/projects/shaopoooo-dexbot/shao-dev-eng-review-test-plan-20260410-151815.md`

---

## ✅ 已完成

- **Self-Learning Regime Engine** (PR #19, 2026-04-10): Continuous regime vector + evolutionary search + walk-forward validation + blended bootstrap + Telegram `/regime` 指令

---

## 🧹 雜項（無需開 plan 檔案）

- [ ] `runOnePath` 11 個 positional args 改成單一 `RunOnePathParams` object（code review S1, P0 Phase 1 follow-up）

---

## 🔴 P0 開倉建議系統 (Position Advice System)

> **Plan 檔案：** `.claude/plans/p0-position-advice-system.md`（決策脈絡 + Decisions + Rejected + Test Plan + Tasks 完整契約）

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

### Phase 1 — Pre-refactor: Sharpe scoring (前置, 半天) ✅

- [x] `MonteCarloEngine.ts`：score 公式從 `mean/|cvar95|` 改為 Sharpe-like `mean/std`
- [x] 更新影響 callers（`mcEngine.ts:165` 改讀 `c.mc.score`；`calcCommands.ts` 經 grep 確認無 caller）
- [x] Canary regression test：seedrandom 注入固定 seed → snapshot 鎖住 11 個 MCSimResult 欄位

### Phase 2 — PositionAdvisor pure functions (2 天, TDD)

- [ ] `tests/services/PositionAdvisor.test.ts`：先寫 19 個測試（spec）
  - recommendOpen: 6 cases (hysteresis、灰色帶、null guard)
  - classifyExit: 6 cases (in-range、hold/rebalance branches、ATR=0)
  - shouldClose: 7 cases (4 個觸發、優先序、null IL)
- [ ] `src/types/positionAdvice.ts`：`OpenAdvice`、`ExitAdvice`、`CloseAdvice`、`CloseReason` 型別
- [ ] `src/services/strategy/positionAdvisor.ts`：3 個 pure functions
- [ ] 確認所有測試 GREEN

### Phase 3 — State persistence (1 天, TDD)

- [ ] `tests/utils/positionStateTracker.test.ts`：3 個測試（save/load round-trip、清理、null）
- [ ] `src/utils/positionStateTracker.ts`：管理 outOfRangeSince map + hysteresis counter + cooldown timestamps
- [ ] 整合到現有 `stateManager`（不新建獨立檔案）
- [ ] Restart 測試：寫狀態 → kill process → restart → 狀態還在

### Phase 4 — Cycle integration (2 天)

- [ ] `src/index.ts`：新增獨立 cron jobs
  - Position state monitor (10min, 與主 cycle 錯開 5min)
  - New position discovery (1h)
  - 並發 guard（個別 isRunning flag）
- [ ] `src/runners/mcEngine.ts`：計算後呼叫 `recommendOpen`，hysteresis 過後推送通知
- [ ] Snapshot staleness guard：position monitor 讀取 `strategies.computedAt`，> 15min 跳過判斷
- [ ] `tests/integration/positionMonitorCycle.test.ts`：3 個整合測試

### Phase 5 — Telegram + cleanup (1 天)

- [ ] `src/bot/alertService.ts`：新增 advice alert types + per-positionId LRU cooldown
- [ ] Telegram 訊息格式：含 ratio 含義解釋、區間 ±X%、期望值（標註相對 HODL）
- [ ] 刪除 `RebalanceService` class（保留 `calculateV3TokenValueRatio` 純函數）
- [ ] 移動 `calculateV3TokenValueRatio` → `src/utils/math.ts`
- [ ] 確認所有 RebalanceService callers 已更新

### Backtest 驗證（P0 ship 前最後門檻）

- [ ] 用 24h+ live data 驗證 2×ATR 穿出深度閾值
- [ ] 用 24h+ live data 驗證 Sharpe 0.5 訊號門檻
- [ ] 兩個閾值若需調整，更新 config + 重跑 regression

---

## 🟠 P1 通用策略框架 (Universal Strategy Engine)

**架構決定（from prior eng review）：** 混合架構 — 共享 PricePathGenerator + RiskMetrics 工具，但每個策略擁有自己的 pipeline（編排 + payoff + go/noGo），輸出標準化 StrategyResult 給 StrategyAllocator。

開倉建議系統穩定後再啟動。

### Phase 1 — MC 三層拆分 (5 天, TDD)

- [ ] 前置測試：14 個 MonteCarloEngine 測試 + canary regression（固定 seed）
- [ ] `src/services/strategy/PricePathGenerator.ts`：抽出價格路徑生成 + blended bootstrap
- [ ] `src/services/strategy/RiskMetrics.ts`：抽出 CVaR / VaR / percentiles 計算
- [ ] `src/types/strategy.ts`：`MarketDataSeries`、`PayoffResult`、`SimulationContext`、`StrategyResult`、`IStrategy` interface（無 index signature）
- [ ] `src/services/strategy/V3LPStrategy.ts`：包現有 V3 LP 邏輯為第一個 plugin
- [ ] `MonteCarloEngine.ts` 重構：runMCSimulation 接收 IStrategy
- [ ] `appState.strategies` 型別遷移到 `StrategyResult`
- [ ] Canary 驗證：重構前後 MC 輸出位元相等

### Phase 2a — FundingRateStrategy (2 天)

- [ ] FundingRate 數據源（preferred: 真實 perp DEX API；fallback: synthetic 基於歷史 vol）
- [ ] `src/services/strategy/FundingRateStrategy.ts`：實作 IStrategy
- [ ] 跑演化驗證：trend regime 是否自動偏好 perp 策略

### Phase 2b — StrategyAllocator + 視覺化 (2 天)

- [ ] `src/services/strategy/StrategyAllocator.ts`：regime vector → 策略權重向量（softmax）
- [ ] Regime Transition Alert：regime vector 24h 變化 > 20% → Telegram 通知 + 策略切換建議
- [ ] Historical regime-strategy backtest 視覺化：Telegram 文字圖表（非 Web）

### Phase 2c — LLM Strategy Advisor (2 天)

- [ ] `src/services/strategy/LLMStrategyAdvisor.ts`：Phase 0 模組
- [ ] 輸入：regime vector + 市場數據摘要（限 ~500 tokens）+ 現有策略 score
- [ ] 輸出：自然語言策略建議 + pseudocode
- [ ] LLM 選擇：Claude API（claude-api skill），成本 ~$0.01/次
- [ ] Fallback：API 失敗 → log + Telegram 錯誤訊息（不重試）
- [ ] `/strategy suggest` Telegram 指令觸發
- [ ] One-click Paper Trading 按鈕（inline keyboard）

### Phase 2d — Paper Trading + 績效歸因 (3 天)

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

---

## 🔵 P3 延伸功能

### Phase 6 — 開倉建議強化

- [ ] `/calc` 強化版：regime-aware EV 估算
- [ ] 每日/每週幣本位 PnL 報告
- [ ] Unsupervised regime labeling：HMM/clustering 替代硬分類器打標
- [ ] Per-step regime blending：每個時間步切換 regime bucket

### 其他 P3

- [ ] `position: any` 型別修復：定義 V3 / V4 union type
- [ ] 擴充單元測試：覆蓋 utils (`stateManager`, `formatter`, `math`, `validation`) 及 AppState
- [ ] `index.ts` 測試覆蓋：dependency injection + Mock 邊界

---

## ⚪ P4 待討論後動工

### 架構債

- [ ] **DEX Adapter 模式**：統一介面 `IDexAdapter`，消除 if-else 分支
- [ ] **Strategy 模組重新評估**：`PnlCalculator`、`RiskManager`、`rebalance` 與 MC 引擎職責重疊

### 原 P1 遺留

- [ ] 質押倉位自動偵測：掃描 ERC-721 Transfer 事件
- [ ] 穿倉即時告警 (Out-of-Range Alert)：`ChainEventScanner` 監聽 Swap event（注意：與 P0 Position Advice 場景 B 重疊，需評估）
- [ ] Aerodrome Gauge Emissions APR
- [ ] Aerodrome 質押 unclaimed fees 顯示修正
- [ ] PnlCalculator 參數注入（消除對 `appState.userConfig` 的直接依賴）
- [ ] GeckoTerminal 請求節流
- [ ] `_fetchAerodromeTVL` RPC 失敗降級

### 原 P2 遺留

- [ ] BBEngine 帶寬優化
- [ ] rebalance.ts 帶寬防護
- [ ] 毒性交易流偵測 (Toxic Order Flow)
- [ ] EOQ gas 成本乘數
- [ ] APR 邏輯重構
- [ ] 池子檢查嚴謹化

### 原 P4

- rebalance.ts 數學升級
- IL 精算與財務模型重構
- 回測策略模擬 (BacktestEngine)
- 拆分 `PositionRecord`、統一 RPC Provider、強化枚舉型別

---

## 🟢 Mirror / Token-Denominated 功能（已併入 P1 Phase 2d）

> Paper Trading (Phase 2d) 取代了原本的 Mirror 概念。下列項目延續 mirror 願景，依賴 Phase 2d 完成。

- [ ] `/share` 分享卡片（獲客工具）
- [ ] Gas 成本追蹤（gas 費納入幣本位成本）
- [ ] 歷史決策回測（「如果你上次聽了建議不動，你會多 X ETH」）
- [ ] 開倉建議歷史準確度追蹤
- [ ] 多鏈支持（Base → Arbitrum → Ethereum）
- [ ] 多用戶 + 付費訂閱

---

## 未來展望 (Ideas & Roadmap)

1. **透明 Vault + Telegram 控制台**：智能合約 vault，MC 引擎驅動自動 rebalance
2. **委託執行 Bot**：用戶授權錢包，一鍵確認執行
3. **Auto Feature Discovery**：在 Genome 中加入 feature weights
4. **Online Learning**：從離線回測遷移到 production 中持續學習
5. **多策略消費者**：regime engine 餵養套利、對沖、定向交易策略（→ 已在 P1 路線上）
6. **Delta-Neutral 整合對沖**：接入永續 DEX (GMX/Hyperliquid)
7. **跨池流動性遷移**：不同 DEX 費率層搬磚機會
8. **Smart Money 追蹤**：鏈上頂級 LP 地址分析
9. **LVR 監控防禦**：基於 Order Flow 避免套利者吸血
10. **期權對沖 IL**：LP + Put Option 套期保值
