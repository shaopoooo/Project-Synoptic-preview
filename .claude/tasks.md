# DexBot 任務清單與路線圖 (Tasks & Roadmap)

> P0 最緊急 → P4 待討論；完成後刪除條目，該優先級全空則標注 ✅
>
> 設計文件：`~/.gstack/projects/shaopoooo-dexbot/shao-dev-design-20260409-unified.md`
> CEO plans：`~/.gstack/projects/shaopoooo-dexbot/ceo-plans/2026-04-09-regime-evolution.md`

---

## 🔴 P0 Self-Learning Regime Engine（優先級最高）

**核心痛點**：regime 門檻太嚴格，Bot 頻繁 skip 池子，MC 引擎跑不到，策略建議無法產出。

**架構決定（from CEO + Eng review）：**
- Fully soft CVaR gate — 移除 `mcEngine.ts:109-114` 硬 skip，不再有 trend-based pool skipping
- Continuous Regime Vector (sigmoid + softmax) 取代硬分類 `'range' | 'trend' | 'neutral'`
- 降維：MVP 只演化 RegimeGenome (9 params)，LPStrategyGenome 暫時手動
- Fitness: MVP 用 backtest Sharpe + maxDD gate，累積 mirror 數據後切換真實 P&L
- 付費 API (CoinGecko Pro / Kaiko) 取得 150+ 天歷史數據
- 檔案結構融入現有 runners/services，不建 `evolution/` 目錄

### Phase 0.5 — 歷史數據擴展（前置條件）

- [ ] 選定並接入付費 API，驗證 150+ 天 1H OHLCV 可用性
- [ ] 建立漸進式累積機制（每次 fetch 追加到本地 JSON，不覆蓋）
- [ ] 將 `HISTORICAL_RETURNS_HOURS` 從 720 擴展為動態值
- [ ] Compute benchmark：在 Railway 跑一次 20-genome × 4-window 的 mock evolution，記錄實際耗時

### Phase 1 — Backtest Harness + Regime Commands (1-2 週)

- [ ] 從 `MarketRegimeAnalyzer` 抽出共用 `extractFeatures(candles): { chop, hurst, atr }` 純函數（DRY）
- [ ] `src/types/index.ts`：新增 `RegimeGenome`、`RegimeVector`、`LPStrategyGenome`、`CombinedGenome` 型別
- [ ] `src/services/strategy/ParameterGenome.ts`：Genome 定義、序列化、搜索範圍 `[min, max]`
- [ ] `src/runners/BacktestHarness.ts`：接受 RegimeGenome，跑 regime → MC pipeline，輸出 `{ sharpe, maxDrawdown, inRangePct, totalReturn }`
- [ ] **Baseline equivalence test**（Phase 1 gate）：現有常數轉 genome → harness 結果 = live pipeline
- [ ] Grid search 驗證 harness 正確性
- [ ] `src/bot/commands/regimeCommands.ts`：`/regime status` | `/regime candidates` | `/regime apply <id>` hot-swap
- [ ] Hot-swap 語義：僅影響下一次 `runMCEngine` cycle，不觸發鏈上操作

### Phase 2 — Continuous Regime Vector (1 週)

- [ ] `src/services/strategy/RegimeEngine.ts`：sigmoid + softmax continuous vector (`computeRegimeVector`)
- [ ] **Softmax property test**（Phase 2 gate）：100 random combos → all valid probability, no NaN
- [ ] `segmentByRegime()`：用現有硬分類器打標歷史數據，fallback < 50 samples 合併 neutral
- [ ] 修改 `MonteCarloEngine.ts`：`runMCSimulation` 新增 optional `segments` + `RegimeVector` 參數（向後相容）
- [ ] 同時修改 `calcCandidateRanges` + `calcTranchePlan` call chain（blendedBootstrap 波及 4 個檔案）
- [ ] 移除 `mcEngine.ts:109-114` 硬 skip（`if (regime.signal === 'trend') continue`）
- [ ] 驗證：continuous vector backtest Sharpe ≥ 硬分類

### Phase 3 — Evolutionary Search (1-2 週)

- [x] `src/services/strategy/EvolutionEngine.ts`：selection (top 50%) → crossover (5) → mutation (3 clones with gaussian noise) → seed (2 random) → immortal (上一代最佳)
- [ ] Population size: 20 genomes, 10 + 5 + 3 + 2 = 20
- [ ] `src/runners/WalkForwardValidator.ts`：4 窗口滾動驗證，時序單調，訓練/驗證不重疊（需 150 天數據）
- [ ] Fitness = mean(4 windows Sharpe)，hard gate: maxDD > 30% → fitness = 0
- [ ] `isEvolutionRunning` guard（同 `isMCEngineRunning` pattern）+ 30 分鐘超時自動釋放
- [ ] Population wipeout protection：immortal genome 永遠存活
- [ ] NaN guard：post-fitness NaN check → fitness = 0，selection 只從 fitness > 0 的 genomes 取 top 50%
- [ ] **Evolution convergence test**（Phase 3 gate）：已知最佳簡化問題 → 10 代內收斂
- [ ] `/regime evolve` 手動觸發 + Telegram 通知結果
- [ ] Genome Explainability Report（`/regime candidates` 顯示參數差異與影響解釋）
- [ ] Genome 持久化：`data/genomes/` 單一 JSON + atomic write（stateManager pattern）

---

## 🟠 P1 Token-Denominated Mirror（幣本位鏡子）

**核心痛點**：LP 玩家看不到 rebalance 的真實幣本位成本。

**架構決定（from CEO review）：**
- 數據來源：RPC Event Logs（EventLogScanner chunked pattern），NOT Basescan tx API
- 儲存：JSON atomic write（stateManager pattern），NOT SQLite
- 單用戶架構，多用戶留到需求驗證後
- 可與 Phase 0.5-3 並行開發（Lane B）

### Phase 4 — Mirror P0 (1-2 週)

- [ ] `src/mirror/MirrorService.ts`：RPC getLogs 索引 90 天歷史 V3/V4 倉位交易（IncreaseLiquidity, DecreaseLiquidity, Collect, Transfer）
- [ ] `src/mirror/TokenAccountant.ts`：幣本位 P&L 計算 + triple comparison（LP vs HODL vs ETH staking）
- [ ] `src/mirror/RegimeDecisionLog.ts`：每次 regime 判斷記錄 `{ poolId, regimeVector, genomeId, timestamp }`
- [ ] `/track <wallet>` 觸發 90 天 backfill + 24h cron incremental
- [ ] `/summary` 跨倉位匯總 + ASCII 損耗圖表
- [ ] Triple comparison：需要 TokenPriceService（非穩定幣對的價格轉換）
- [ ] Out-of-range 警報（可設間隔，預設 30 分鐘）
- [ ] Error handling：AuthError → Telegram admin alert、ParseError → log + skip、MissingDecimalError → on-chain decimals() fallback
- [ ] TDD：用真實鏈上交易數據作為 test fixtures，先寫 test oracles

---

## 🟡 P2 整合 + 監控

### Phase 5 — Regime-Mirror Integration + 自動化 (1 週)

- [ ] Regime-Mirror integration：mirror P&L → evolution fitness pipeline（cherry-pick #1）
- [ ] A/B Genome Dashboard：per-pool genome 分配 + `/regime ab <pool> <id>`（cherry-pick #2）
- [ ] Regime Drift Alert：regime vector 週變化 > 0.3 → Telegram 推送（cherry-pick #3）
- [ ] 自動 evolution cycle（weekly cron on Railway）
- [ ] Safety guardrails：fitness 下降 > 20% → 自動回退到上一代最佳 genome
- [ ] `data/evolution-log.jsonl` structured log（fitness 趨勢分析用）

---

## 🔵 P3 延伸功能

### Phase 6 — 開倉建議 + Rebalance 智能

- [ ] `/calc` 強化版：regime-aware EV 估算，3 個範圍 × regime vector 影響
- [ ] Rebalance EV 警報：out-of-range 觸發 MC 計算 rebalance EV，推送結果
- [ ] 每日/每週幣本位 PnL 報告
- [ ] 切換到真實 P&L fitness（替代 backtest Sharpe）
- [ ] LPStrategyGenome 加入演化搜索（降維決定後的下一步）
- [ ] Unsupervised regime labeling：HMM/clustering 替代硬分類器打標
- [ ] Per-step regime blending：每個時間步根據 transition probability 切換 regime bucket

### 其他 P3

- [ ] `position: any` 型別修復：定義 V3 / V4 union type
- [ ] 擴充單元測試：覆蓋 utils (`stateManager`, `formatter`, `math`, `validation`) 及 AppState
- [ ] `index.ts` 測試覆蓋：dependency injection + Mock 邊界

---

## ⚪ P4 待討論後動工

### 原 P0 遺留（Stage 4 + Wave 3）

- [ ] **DEX Adapter 模式**：統一介面 `IDexAdapter`，Adapter 類別（V3/V4/Aerodrome/PancakeSwap），工廠 `DexFactory`，消除 if-else 分支。痛點仍在但不阻塞 regime engine。
- [ ] **Strategy 模組重新評估**：`PnlCalculator`、`RiskManager`、`rebalance` 與 MC 引擎的職責重疊（`highVolatilityAvoid` vs Kill Switch vs fully soft CVaR gate）。需在 regime engine 穩定後重新審視。

### 原 P1 遺留

- [ ] 質押倉位自動偵測：掃描 ERC-721 Transfer 事件
- [ ] 穿倉即時告警 (Out-of-Range Alert)：`ChainEventScanner` 監聽 Swap event
- [ ] Aerodrome Gauge Emissions APR
- [ ] Aerodrome 質押 unclaimed fees 顯示修正
- [ ] PnlCalculator 參數注入（消除對 `appState.userConfig` 的直接依賴）
- [ ] GeckoTerminal 請求節流（`Promise.all` → 序列 + Jitter）
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
- 其他優化：拆分 `PositionRecord`、統一 RPC Provider、強化枚舉型別

---

## 🟢 Mirror 功能延伸（依賴 Phase 4 完成）

- [ ] `/share` 分享卡片（獲客工具）
- [ ] Gas 成本追蹤（gas 費納入幣本位成本）
- [ ] MC 引擎回測校準（用 mirror 歷史 rebalance 數據）
- [ ] 歷史決策回測（「如果你上次聽了建議不動，你會多 X ETH」）
- [ ] 開倉建議歷史準確度追蹤
- [ ] 多鏈支持（Base → Arbitrum → Ethereum）
- [ ] 多用戶 + 付費訂閱

---

## 未來展望 (Ideas & Roadmap)

1. **透明 Vault + Telegram 控制台**：智能合約 vault，MC 引擎驅動自動 rebalance（路徑 B → C → A）
2. **委託執行 Bot**：用戶授權錢包，一鍵確認執行
3. **Auto Feature Discovery**：在 Genome 中加入 feature weights，weight=0 等同不用該特徵
4. **Online Learning**：從離線回測遷移到 production 中持續學習
5. **多策略消費者**：regime engine 餵養套利、對沖、定向交易策略
6. **Delta-Neutral 整合對沖**：接入永續 DEX (GMX/Hyperliquid)
7. **跨池流動性遷移**：不同 DEX 費率層搬磚機會
8. **Smart Money 追蹤**：鏈上頂級 LP 地址分析
9. **LVR 監控防禦**：基於 Order Flow 避免套利者吸血
10. **期權對沖 IL**：LP + Put Option 套期保值
