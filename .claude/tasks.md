# DexBot 任務清單與路線圖 (Tasks & Roadmap)

> P0 最緊急 → P4 待討論；完成後刪除條目，該優先級全空則標注 ✅

## 🔴 P0 開倉策略引擎（Phase 1）

**目標**：透過 BBEngine + Bootstrap Monte Carlo 計算 CVaR-adjusted 最優開倉策略，cron 週期自動計算並存入 `appState.strategies`，`/calc` 讀取後輸出。

> Step 1（runners/ 初步抽出）與 Step 2（MC 數學升級）已完成。

---

### Wave 1 — 架構重構（Stage 1~3 合併執行）

**Stage 1 — AppState Pool Lookup（✅已完成）**
- [x] `AppState.ts`：新增 `findPool(addr: string, dex?: Dex): PoolStats | undefined` 與 `findPoolsForPositions(): Map<string, PoolStats>` 方法
- [x] 替換以下 6 處重複的 `appState.pools.find(...)`：`runners/positions.ts` L53, L101；`runners/marketData.ts` L87, L116；`runners/reporting.ts` L49；`PositionAggregator.ts` L148

**Stage 2 — PositionScanner 拆分（✅已完成）**
- [x] 新建 `services/ChainPositionFetcher.ts`：搬出 `syncFromChain`、`_fetchNpmData`、`_fetchV4NpmData`、`getPoolFromTokens`（~250 行）
- [x] 新建 `services/StakeDiscovery.ts`：搬出 `scanStakedPositions`、`_scanAllWalletsForStakes`、`_getLogsChunked`（~180 行）
- [x] 新建 `services/TimestampFiller.ts`：搬出 `fillMissingTimestamps`（~60 行）
- [x] `PositionScanner.ts` 瘦身至 ~150 行：僅保留狀態管理（`positions[]`、`closedTokenIds`、`syncedWallets`），改用委派呼叫上述新模組；對外 API 不變，`runners/` import 路徑無需修改

**Stage 3 — Prefetch + Compute 管線（✅已完成）**
- [x] 新型別（`types/index.ts`）：新增 `FetchedFees`、`CycleData`、`CycleResult`、`OpeningStrategy` interface。
- [x] `services/FeeFetcher.ts`：`fetchAll(rawPositions, pools, bbs)` 將 `PositionAggregator` 內的 FeeCalculator 批次呼叫移至此處。
- [x] `runners/prefetch.ts`：`prefetchAll(alert): Promise<CycleData | null>` 統整 Phase 0a / Phase 0b 的非同步呼叫。
- [x] `runners/compute.ts`：`computeAll(data): CycleResult` Phase 1 純計算（aggregate → PnL → Risk → Rebalance）。
- [x] `AppState.ts`：新增 `commit(data: CycleData, result: CycleResult): void` 唯一寫入點，及 `strategies` 狀態。
- [x] `PositionAggregator.ts`：改為純計算，接收 feeMaps，移除 async / FeeCalculator 呼叫。
- [x] `index.ts runCycle()`：更新為 `prefetchAll → computeAll → appState.commit → runBotService → save`。
- [x] 刪除原有的 `marketData.ts`、`positions.ts`。

---

### Wave 2 — MC 引擎功能實作

- [ ] `runners/mcEngine.ts`：`runMCEngine()` 實作 — sigma candidates `[0.5, 1.0, 1.5, 2.0, 2.5, 3.0]`；Score = mean / |CVaR₉₅|；選最優 sigma；建 70/30 分倉計畫；寫入 `appState.strategies[poolAddress]`
- [ ] `bot/alertService.ts`：Kill Switch A（帶寬擴張，轉換推播 + 4h 持續提醒）；Kill Switch B（MC All No-Go，純轉換推播）
- [ ] `bot/commands/calcCommands.ts`：讀 `appState.strategies[pool]`；按使用者 capital 縮放比率結果；無策略時提示等待下一輪 cron
- [ ] `bot/formatter.ts`：`buildStrategyReport()` 輸出最優區間 + CVaR% + 分倉計畫
- [ ] `/tranche [core% buffer%]` 指令：調整分倉比例，持久化至 `userConfig`

---

## 🟠 P1 高優先（近期動工）

- [ ] **質押倉位自動偵測**：掃描 ERC-721 Transfer 事件（`from=wallet, to=已知質押合約`），自動 Upsert `externalStake: true`（PancakeSwap V3 MasterChef / Aerodrome Gauge）。
- [ ] **穿倉即時告警 (Out-of-Range Alert)**：在 `ChainEventScanner` 監聽 Swap event，更新 `currentTick` 並推播穿倉警報（設有 cooldown 避免重複干擾）。
- [ ] **Aerodrome Gauge Emissions APR**：`emissionApr = (rewardRate * 86400 * 365 * aeroPrice) / (totalSupply * lpPriceUSD)`。
- [ ] **Aerodrome 質押 unclaimed fees 顯示修正**：質押中的 Gauge 手續費不可直接領取，應強制將 `unclaimedFees0 / 1` 設為 0，僅計算 AERO 獎勵 USD。

---

## 🟡 P2 中優先（排程中）

- [ ] **BBEngine 帶寬優化**：加 stdDev 下限，避免過度平滑導致帶寬低於 30D 歷史波動率極限。
- [ ] **rebalance.ts 帶寬防護**：若 `currentBandwidth > avg30D × HIGH_VOLATILITY_FACTOR`，強制覆寫為 `wait` 策略。
- [ ] **毒性交易流偵測 (Toxic Order Flow)**：5 分鐘視窗內同向 Swap >= 80% 且流量大於 TVL X% 觸發警告。
- [ ] **EOQ gas 成本乘數 (`/gas` 指令)**：Base 實際 gas < $0.05，需套用乘數調整 compound threshold。
- [ ] **APR 邏輯重構**：提取 V3/V4 volume blending + APR 計算共用函式。
- [ ] **池子檢查嚴謹化**：`PositionScanner.getPoolFromTokens` 同時驗證 token0/token1 地址。

---

## 🔵 P3 有依賴鏈（需按序執行）

- [ ] **`position: any` 型別修復**：定義 V3 / V4 union type 置換 `any`。
- [ ] **擴充單元測試**：覆蓋 utils ( `stateManager`, `formatter`, `math`, `validation` 等 ) 及 AppState 的方法。
- [ ] **`index.ts` 測試覆蓋**：改用 dependency injection 傳入 runner 陣列，Mock 其餘邊界，增加核心 main & 排程的測試。

---

## ⚪ P4 待討論後動工

- **rebalance.ts 數學升級**：替換 Math.sqrt 為 V3 SDK，計算 `suggestedHedgeDelta`。
- **IL 精算與財務模型重構**：精準計算 IL 與手續費收益（collected），替換 `positionValueUSD` 為精算邏輯。
- **回測策略模擬 (BacktestEngine)**：新增 `runSimulation`，處理滑價/Gas、日線 vs 時線差異。
- 其他優化：拆分 `PositionRecord`、統一 RPC Provider、強化各處枚舉字串型別。

---

## 未來展望 (Ideas & Roadmap)

1. **Delta-Neutral 整合對沖策略**：接入永續 DEX (GMX/Hyperliquid)，建議多空對沖。
2. **跨池流動性遷移 (Cross-Pool Migration)**：發掘不同 DEX 費率層更優 APR 的搬磚機會。
3. **Smart Money 追蹤**：分析鏈上歷史前 5% 頂級 LP 地址，推播聰明錢警報。
4. **LVR 監控防禦**：基於鏈上原生訂單流 (Order Flow) 避免套利者吸血。
5. **期權對沖 IL (Panoptic/Smilee)**：引導開 LP 同時購入同區間 Put Option 套期保值。
