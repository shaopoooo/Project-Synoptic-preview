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

**Stage 4 — DEX Adapter 模式（依賴 Stage 1~3 完成後動工）**

> **痛點**：目前 `FeeFetcher`、`NpmContractReader`、`PoolScanner` 裡充滿了 `if (dex === 'UniswapV4') ... else if (dex === 'Aerodrome')` 的硬編碼分支，違反開閉原則 (OCP)。新增任何 DEX 都必須改動 5~6 個核心檔案，遺漏任一處就會導致計算崩潰。

- [ ] **定義統一介面** `services/dex/IDexAdapter.ts`：`fetchPositionMeta`, `fetchPendingFees`, `fetchStakingRewards`, `fetchPoolStats`
- [ ] **實作 Adapter 類別**：
  - [ ] `services/dex/adapters/UniswapV3Adapter.ts`（預設）
  - [ ] `services/dex/adapters/UniswapV4Adapter.ts`（StateView + Packed PositionInfo）
  - [ ] `services/dex/adapters/AerodromeAdapter.ts`（Voter + Gauge）
  - [ ] `services/dex/adapters/PancakeSwapAdapter.ts`（MasterChef V3）
- [ ] **建立工廠** `services/dex/DexFactory.ts`：`getAdapter(dex: Dex): IDexAdapter`
- [ ] **簡化核心邏輯**：`FeeFetcher` / `NpmContractReader` 改為透過 `DexFactory.getAdapter()` 委派，消除所有 `if-else` 分支
- [ ] **刪除舊 FeeCalculator**：確認所有邏輯已遷入各 Adapter 後移除

**Wave 3 — Strategy 模組重新評估**
- [ ] `PnlCalculator`、`RiskManager`、`rebalance` 在引入 Monte Carlo 引擎後，部分邏輯可能與 MC 結果重疊或衝突（例如 Risk 的 `highVolatilityAvoid` vs MC 的 Kill Switch）。需審視三者是否需要重新分割職責、移除冗餘判斷，或將 MC 策略結果納入 Rebalance 決策流程。

---

### Wave 2 — MC 引擎功能實作（✅已完成）

- [x] `runners/mcEngine.ts`：`runMCEngine()` 實作 — sigma candidates `[0.5, 1.0, 1.5, 2.0, 2.5, 3.0]`；Score = mean / |CVaR₉₅|；選最優 sigma；建分倉計畫；寫入 `appState.strategies[poolAddress]`
- [x] `bot/alertService.ts`：Kill Switch A（帶寬擴張，標籤更新 + 4h 持續提醒說明）；Kill Switch B（MC All No-Go，在 mcEngine 推播）
- [x] `bot/commands/calcCommands.ts`：讀 `appState.strategies[pool]`；按使用者 capital 縮放分倉金額；無策略時提示等待下一輪 cron
- [x] `utils/formatter.ts`：`buildStrategyReport()` 輸出最優 σ + CVaR% + 主倉/緩衝倉區間與金額
- [x] `/tranche [core% buffer%]` 指令：調整分倉比例，持久化至 `userConfig`
- [x] `calcTranchePlan70_30` → `calcTranchePlan` 重新命名；兩函式改為同步（注入 `historicalReturns`）
- [x] `fetchHistoricalReturns` 增量快取（三段式：<1H 直接回傳 / 1-24H 增量補充 / >24H 全量重取）
- [x] `prefetch.ts` 新增 Phase 0b 歷史報酬率預取，透過 `CycleData.historicalReturns` 傳遞至 MC 引擎

---

## 🟠 P1 高優先（近期動工）

- [x] **市場狀態指標：CHOP 指數 + Hurst 指數（Strategy 前置過濾器）**

  **目標**：在 MC 引擎計算前判斷市場是「震盪適合 LP」還是「趨勢需迴避」，降低開倉至趨勢行情的損失。

  **Step 1 — Pure Functions（`utils/math.ts`）**
  - `calculateCHOP(candles: HourlyReturn[], n = 14): number`
    - 公式：`100 × log10(Σ ATR(1,i) / (max_high - min_low)) / log10(n)`，i = 最近 n 根
    - `ATR(1,i) = high_i - low_i`（1H K 線直接使用 HL range）
    - 結果區間：`[0, 100]`；>61.8 = 震盪（LP 友善）；<38.2 = 強趨勢（危險）
    - 輸入：`HourlyReturn[]`（已有 `high`/`low`/`close` 欄位，無需新 API）
  - `calculateHurst(returns: number[], maxLag = 20): number`
    - 使用 R/S 分析（Rescaled Range），對多個 lag 計算 `log(R/S) / log(lag)` 斜率
    - 結果：H > 0.5 = 趨勢延續；H < 0.5 = 均值回歸（LP 友善）；≈ 0.5 = 隨機遊走
    - 輸入：`number[]`（直接使用 `HourlyReturn[].map(h => h.r)`）

  **Step 2 — 型別（`types/index.ts`）**
  - 新增 `MarketRegime` interface：`{ chop: number; hurst: number; signal: 'range' | 'trend' | 'neutral' }`
    - `signal = 'range'`：CHOP > 55 **且** Hurst < 0.52 → 雙重確認震盪
    - `signal = 'trend'`：CHOP < 45 **或** Hurst > 0.58 → 任一觸發趨勢警告
    - 其餘：`'neutral'`
  - `OpeningStrategy` 新增 `marketRegime?: MarketRegime`

  **Step 3 — 計算層（`services/strategy/MarketRegimeAnalyzer.ts`，純函式模組）**
  - `analyzeRegime(returns: HourlyReturn[]): MarketRegime`
    - 呼叫 `calculateCHOP` + `calculateHurst`，組裝 `signal` 判斷後回傳
    - 無副作用，方便單元測試

  **Step 4 — MCEngine 整合（`runners/mcEngine.ts`）**
  - 在 Step 1 `calcCandidateRanges` 之前插入：
    ```typescript
    const regime = analyzeRegime(rawReturns); // rawReturns = HourlyReturn[]（含 high/low）
    if (regime.signal === 'trend') {
        log.warn(`MCEngine: pool ${pool.dex} 趨勢市場 CHOP=${regime.chop.toFixed(1)} H=${regime.hurst.toFixed(2)}，跳過`);
        delete appState.strategies[pool.id.toLowerCase()];
        continue;
    }
    ```
  - 計算成功後，將 `marketRegime` 存入 `OpeningStrategy`

  **Step 5 — 告警（`bot/alertService.ts`）**
  - 持倉池若 `regime.signal === 'trend'`，推播：「⚠️ 趨勢警告：{pool} CHOP={X} Hurst={Y}，LP 有偏移風險」
  - 使用現有 `sendAlert` 機制，加 cooldown（與 Kill Switch 共用同一防重複機制）

  **Step 6 — `/calc` 報告（`utils/formatter.ts`）**
  - `buildStrategyReport()` 新增一行：`市場狀態：震盪/中性/趨勢 (CHOP=X H=Y)`

- [ ] **質押倉位自動偵測**：掃描 ERC-721 Transfer 事件（`from=wallet, to=已知質押合約`），自動 Upsert `externalStake: true`（PancakeSwap V3 MasterChef / Aerodrome Gauge）。
- [ ] **穿倉即時告警 (Out-of-Range Alert)**：在 `ChainEventScanner` 監聽 Swap event，更新 `currentTick` 並推播穿倉警報（設有 cooldown 避免重複干擾）。
- [ ] **Aerodrome Gauge Emissions APR**：`emissionApr = (rewardRate * 86400 * 365 * aeroPrice) / (totalSupply * lpPriceUSD)`。
- [ ] **Aerodrome 質押 unclaimed fees 顯示修正**：質押中的 Gauge 手續費不可直接領取，應強制將 `unclaimedFees0 / 1` 設為 0，僅計算 AERO 獎勵 USD。
- [ ] **PnlCalculator 參數注入**：`calculateAbsolutePNL` / `calculateOpenInfo` 目前在 Phase 1 內部直接讀取 `appState.userConfig`（違反純函式原則）。改為由 `computeAll` 在進入計算前取出 `initialCapital` 並以參數傳入，消除 service 層對全域狀態的直接依賴。
- [ ] **GeckoTerminal 請求節流**：`prefetch.ts` Phase 0b OHLCV 批次抓取從 `Promise.all` 改為序列＋隨機 Jitter（200–600ms），避免 cold start 同時打多個請求觸發 429。
- [ ] **`_fetchAerodromeTVL` RPC 失敗降級**：目前 `aero.token1` 失敗會 retry 3 次後靜默，最終 TVL 可能為 0 或舊快取但未標記。改為首次失敗直接 fallback 到 DexScreener TVL（不重試），並寫入 `cycleWarnings`。

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
