# DexBot 任務清單與路線圖 (Tasks & Roadmap)

> **本檔案定位：索引 + 輕量待辦**
> - 正式 feature（需決策、架構、TDD）→ 開 `.claude/plans/<name>.md`，此處只留一行索引指向 plan
> - 雜項修繕（typo、log level、bump 版本）→ 直接寫在 `## 🧹 雜項` 區塊，無需 plan
> - 完成後條目可保留打勾或刪除；該優先級全空則標注 ✅
>
> P0 最緊急 → P4 待討論

---

## ✅ 已完成

- **Self-Learning Regime Engine** (PR #19, 2026-04-10): Continuous regime vector + evolutionary search + walk-forward validation + blended bootstrap + Telegram `/regime` 指令
- **P0 Stage 1 — Sharpe scoring 重構** (PR #20, 2026-04-11): MC score 從 `mean/|cvar95|` 改為 `mean/std`（Sharpe-like），含 seedrandom 固定 seed canary regression test
- **Phase 1 Planning Brainstorm（本對話 2026-04-10/11）**: 三份 plan 完整就緒
  - `.claude/plans/p0-position-advice-system.md`（修改 5 處）
  - `.claude/plans/i-r2-backup.md`（新建）
  - `.claude/plans/p0-backtest-verification.md`（新建，B2 brainstorm 產出）

---

## 🧹 雜項（無需開 plan 檔案）

- [ ] `runOnePath` 11 個 positional args 改成單一 `RunOnePathParams` object（code review S1, P0 Stage 1 follow-up）

---

## 🛠️ Infrastructure

- [ ] **Cloudflare R2 Backup** → `.claude/plans/i-r2-backup.md`（DR + Dev Access；mirror 每日 + weekly archive + 手動 CLI restore；與 P0 Stage 2 並行）

---

## 🔴 P0 開倉建議系統 (Position Advice System)

> **Plan（主）：** `.claude/plans/p0-position-advice-system.md`
> **Plan（獨立 feature，依寬鬆隔離原則並存）：** `.claude/plans/p0-backtest-verification.md`

### 📦 PR 切分對照表（執行時查閱）

| 邏輯 PR | 內容 | 對應 Plan / Stage | 狀態 |
|---------|------|------------------|------|
| PR 1 | Cloudflare R2 Backup | `i-r2-backup.md`（Stage 1-5） | 📋 待啟動（可與 PR 3 並行） |
| PR 2 | Sharpe scoring 重構 | P0 Stage 1 | ✅ GitHub PR #20 已合併 |
| PR 3 | PositionAdvisor 純函數 | P0 Stage 2 | 📋 待啟動 |
| PR 4 | Offline backtest harness | `p0-backtest-verification.md` Stage 1 | 📋 依賴 PR 3 |
| PR 5 | Cycle integration + Telegram + Shadow | P0 Stage 3-5 + backtest Stage 2 | 📋 依賴 PR 3、PR 4 |

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
> Stage 1 (offline replay) + Stage 2 (shadow mode) + Stage 3 (manual tune trigger)
> 60 個 RED 測試、framework/v3lp 兩層架構、連續 2 週同方向紅標 trigger
> 通過絕對底線（A>0, D>0, C≥50%）才允許 P0 ship

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
