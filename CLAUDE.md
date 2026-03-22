# CLAUDE.md — DexBot V1 多 DEX 策略（小市值版）

---

## 1. 專案核心定位

- **執行模式**：純監測 + 手動執行（Telegram Bot 推播訊號）
- **技術選型**：Node.js + TypeScript、`@uniswap/v3-sdk`、`grammyjs`（Telegram）、`ethers.js`
- **Code Review**：此專案由 **Gemini** 與 **Grok** 進行 code review，Claude 實作時應確保程式碼品質符合多模型審查標準

---

## 2. 代碼規範

### 系統韌性

**狀態持久化**
- 核心狀態（`PriceBuffer`、`volCache`）必須於重啟後保留
- 使用 `fs-extra` 將狀態儲存至 `data/state.json`，每次啟動時優先讀取

**記憶體管理**
- **禁止**使用無上限的原生 `Map` 作為快取
- 所有快取一律改用 `lru-cache`，防止記憶體無限增長

**RPC 備援與防卡死**
- 使用 `FallbackProvider`，節點順序：QuickNode → Alchemy → 公共節點
- 所有 RPC 呼叫必須設定**顯式超時**與**重試上限**
- 串行呼叫使用 `nextProvider()` 輪換節點，分散負載

**API 防封鎖**
- GeckoTerminal 免費 API 易觸發 429，必須實作 **Exponential Backoff + Jitter**
- 平行呼叫 GeckoTerminal 時限制並發數 ≤ 2
- 所有 Axios 請求應加上 `User-Agent` Header

**動態 Gas 預估**
- **禁止**硬編碼 Gas 費用（例如 `$1.5`）
- 一律透過 `fetchGasCostUSD()` 即時取得 `maxFeePerGas`

**輸入清洗**
- V3 Pool Address 必須通過 `/^0x[0-9a-fA-F]{40}$/` 校驗；V4 poolId 為 bytes32（`/^0x[0-9a-fA-F]{64}$/`）
- 不合法輸入應拒絕處理並記錄錯誤，不允許程式崩潰

### 架構規範

**配置管理（`config/`）**
```
config/
├── env.ts        # 環境變數（process.env 讀取）
├── constants.ts  # 常數（池地址、費率等）
├── abis.ts       # 合約 ABI
└── index.ts      # 統一匯出入口
```

**型別管理**
- 所有共用 `Interface` 與 `Type` 集中至 `src/types/index.ts`
- 禁止在各模組內定義跨模組使用的型別

**DRY（Don't Repeat Yourself）**
- 相同邏輯禁止在多個模組分別實作；發現重複時立刻提取成共用工具
- `tickToPrice` → `src/utils/math.ts`；token decimal / symbol 推斷 → `src/utils/tokenInfo.ts`；Wallet 正則 → `src/utils/validation.ts`
- 新增工具函式後，**所有**使用舊版 inline 實作的地方必須一併改用新版，不允許新舊並存

**文件職責分工**

| 內容類型 | 主要文件 | 另一份文件的處理方式 |
|----------|----------|----------------------|
| 環境變數完整說明 | `README.md` | CLAUDE.md 只列變數名，不重複說明 |
| 監測池清單與地址 | `README.md` | CLAUDE.md 引用 `config.POOL_SCAN_LIST` |
| Telegram 指令完整說明 | `README.md` | CLAUDE.md 只列指令名稱 |
| 狀態持久化 schema | `README.md` | CLAUDE.md 模組描述只提欄位名 |
| 部署 / Docker / Railway | `README.md` | 不在 CLAUDE.md |
| 程式架構、模組職責、資料流 | `CLAUDE.md` | README.md 保留高階一行說明 |
| Telegram 報告欄位邏輯 | `CLAUDE.md` | README.md 保留完整格式範例 |
| 未完成任務清單 | `CLAUDE.md` | 不在 README.md |
| 已完成實作歷程 | `README.md`「開發歷程」章節 | CLAUDE.md 不保留已完成項目 |

**文件同步規則**
- **每次變更程式邏輯後，必須同步更新 CLAUDE.md 與 README.md**
- CLAUDE.md：更新目錄結構、核心資料流、模組說明；任務以 P0~P4 優先級架構管理，**完成後從條目清單刪除，對應優先級區塊標注 ✅**
- README.md：更新環境變數、Telegram 指令、state.json schema、BBEngine 參數等使用者可感知的內容
- 新增功能 → 先在 CLAUDE.md `## 5. 待處理任務` 對應優先級下以 `[ ]` 記錄；**完成後刪除條目，若該優先級下已無任何待辦則標注 ✅ 已完成**
- Bug 修正 → 若有對應待處理任務，完成後依上述規則刪除；若無預先記錄，直接更新相關模組說明即可
- 若有使用者可見變化（指令、格式、env var）→ README.md 一起更新
- 禁止兩份文件出現相互矛盾的說明；主要文件先更新，另一份對應簡化

**部署文件**
- `README.md`：清楚列出所有環境變數及說明（單一來源）
- `Dockerfile`：包含 Railway 部署設定指南

---

## 3. 模組說明 & 程式碼索引

### 目錄結構

```
src/
├── index.ts                    # 主進入點：cron 排程、服務協調、狀態存取
├── types/
│   └── index.ts                # 共用型別定義（PositionRecord、BBResult、RiskAnalysis、RawPosition 等）
├── config/
│   ├── env.ts                  # 環境變數讀取（process.env）
│   ├── constants.ts            # 常數（池地址、快取 TTL、BB 參數、EWMA、區塊掃描、Gas、TOKEN_DECIMALS、FMT 顯示精度、FEE_TIER_TICK_SPACING、MAX_UINT128/Q128/U256、Rebalance 係數）
│   ├── abis.ts                 # 合約 ABI（NPM、Pool、Aero Voter/Gauge）
│   └── index.ts                # 統一匯出入口
├── services/
│   ├── PoolScanner.ts          # APR 掃描（DexScreener + GeckoTerminal；池清單由 config.POOL_SCAN_LIST 驅動）
│   ├── BBEngine.ts             # 動態布林通道（20 SMA + EWMA stdDev + 30D 波動率）
│   ├── ChainEventScanner.ts    # 通用鏈上事件掃描器（ScanHandler 介面 + OpenTimestampHandler）
│   ├── PositionScanner.ts      # LP NFT 倉位監測（狀態管理、倉位發現、鏈上讀取、timestamp 補齊）
│   ├── FeeCalculator.ts        # 手續費計算（Uniswap / PancakeSwap / Aerodrome 三路 + 第三幣獎勵）
│   ├── PositionAggregator.ts   # 倉位組裝 Pipeline（RawChainPosition → PositionRecord）
│   ├── RiskManager.ts          # 風險評估（Health Score、IL Breakeven、EOQ 複利訊號）
│   ├── PnlCalculator.ts        # 絕對 PNL、開倉資訊、組合總覽計算
│   └── rebalance.ts            # 再平衡建議（純計算，不執行交易）
├── bot/
│   ├── TelegramBot.ts          # Telegram 指令處理與推播觸發
│   ├── reportService.ts        # 報告資料協調層（計算總覽/delta/holdings/alerts，呼叫 formatter 輸出字串）
│   └── commands/               # 各類 Telegram 指令模組
├── backtest/
│   └── BacktestEngine.ts       # 歷史回測引擎
└── utils/
    ├── logger.ts               # Winston 彩色 logger（console + 檔案輪轉）
    ├── math.ts                 # BigInt 固定精度數學工具（normalizeAmount / normalizeRawAmount / tickToPrice / calculateCapitalEfficiency / feeTierToTickSpacing / sub256 / MAX_UINT128 / Q128 / U256）
    ├── rpcProvider.ts          # FallbackProvider + rpcRetry + nextProvider() + fetchGasCostUSD()
    ├── cache.ts                # LRU 快取實例（bbVolCache、poolVolCache）+ snapshot/restore
    ├── stateManager.ts         # 跨重啟狀態持久化（讀寫 data/state.json）+ dex 命名自動遷移
    ├── BandwidthTracker.ts     # 30D 帶寬滾動窗口（update / snapshot / restore）
    ├── tokenPrices.ts          # 幣價快取（WETH / cbBTC / CAKE / AERO，2 分鐘 TTL）
    ├── AppState.ts             # 全域共享狀態單例（pools / positions / bbs / lastUpdated / bbKLowVol / bbKHighVol / userConfig）；re-exports WalletPosition / WalletEntry / UserConfig from types/
    ├── tokenInfo.ts            # Token 元資料（getTokenDecimals / getTokenSymbol / TOKEN_DECIMALS）
    └── formatter.ts            # 文字格式化工具；所有 toFixed 統一讀 `config.FMT.*`；只接收 raw 數值，不含運算邏輯。主要 exports：`compactAmount` / `buildTelegramPositionBlock` / `buildPositionDiffLine` / `buildSummaryBlock` / `buildPoolRankingBlock` / `buildTimestampBlock` / `buildFlashReport`（含 `FlashHolding` / `FlashAlert` / `PoolRankingRow` / `SummaryBlockData` 介面）
```

### 核心資料流

```
# 啟動順序（一次性）
TokenPriceFetcher → PoolScanner → PositionScanner → BBEngine → RiskManager
                                  ↑ 先填充 positions  ↑ 才有池子可算 BB

# PositionScanner 內部 Pipeline（5 段）：
PositionScanner.fetchAll()
  → PositionAggregator.aggregateAll(rawPositions, appState.bbs, appState.pools)
      └── FeeCalculator（fee + 第三幣）→ 基礎 PositionRecord（USD 值 + fee 正規化）
  → PnL enrichment loop（index.ts）
      └── PnlCalculator（initialCapital / ilUSD / openedDays / profitRate）
  → PositionScanner.updatePositions(assembled)  ← 寫回 appState.positions
  → runRiskManager()
      ├── RiskManager.analyzePosition（overlapPercent / healthScore / breakevenDays）
      └── RebalanceService.getRebalanceSuggestion（使用已計算的 breakevenDays）

# cron（BBEngine 必須在 PositionScanner 之前）
TokenPriceFetcher → PoolScanner → BBEngine → PositionScanner → RiskManager → BotService
                                  ↑ 預計算 BB  ↑ 直接使用 appState.bbs，不重複呼叫 GeckoTerminal

# 共享狀態（AppState singleton）
appState.pools      ← runPoolScanner 寫入
appState.positions  ← PositionScanner.updatePositions 寫入，runRiskManager 就地更新欄位
appState.bbs        ← runBBEngine 寫入，runPositionScanner 後 pruneStaleBBs()
appState.lastUpdated.* ← 各 runner 寫入時間戳
```

### PoolScanner（`src/services/PoolScanner.ts`）

- **資料來源**：DexScreener（TVL）→ GeckoTerminal OHLCV（成交量主要來源；DexScreener h24 常漏算 CL pool 成交量，僅作最終備援）；The Graph subgraph 可選啟用（設 `SUBGRAPH_API_KEY` 環境變數後自動啟用，優先級高於 GeckoTerminal）
- **APR 公式**：`APR = (avgDailyVol × feeTier / TVL) × 365`；`avgDailyVol = (gecko24h + gecko7dAvg) / 2`（兩者都有時）
- **Farm APR**：`_fetchPancakeFarmApr()` 對 PancakeSwapV3 額外呼叫 MasterChef V3 `getLatestPeriodInfo(poolAddress)`；`farmApr = (cakePerSec × 86400 × 365 × cakePrice) / tvlUSD`；`cakePerSec = raw / 1e30`；period 過期時回傳 0；`PoolStats.farmApr` 為 optional
- **池清單**：由 `config.POOL_SCAN_LIST`（`constants.ts`）統一定義，新增池子只需改此處；完整地址見 README.md
- **UniswapV4 支援**：`_fetchV4PoolStats()` 透過 `StateView.getSlot0(poolId)` 取得當前 tick / sqrtPriceX96；poolId 為 bytes32，驗證改用 `/^0x[0-9a-fA-F]{64}$/`
- **Aerodrome TVL 修正**：`_fetchAerodromeTVL()` 直接讀 token balance（`IERC20(token).balanceOf(poolAddress)`）計算真實 TVL，取代 DexScreener 只計算 gauge 質押量的低估值（約 5x 誤差）；token 幣價使用 `getTokenPrices()` 提供的 WETH / cbBTC
- **關鍵函式**：`scanAllCorePools()` → `fetchPoolStats()` → `fetchPoolVolume()` → `_fetchPancakeFarmApr()` → `_fetchAerodromeTVL()`

### BBEngine（`src/services/BBEngine.ts`）

- **均線週期**：20 SMA（`BB_HOURLY_WINDOW=20`），時間框架：1 小時；Tick 轉換使用 `nearestUsableTick`
- **stdDev 計算**：資料 ≥ 5 筆（`MIN_CANDLES_FOR_EWMA`）時用 EWMA（`α=0.3, β=0.7`）平滑後計算；不足時從 30D 年化波動率換算 1H stdDev（`sma × vol / √8760`）
- **Tick 計算方式**：直接由 SMA price 換算 tick（`tick = log(price) / log(1.0001)`），不再以 currentTick ± offset 計算；同一池子所有倉位週期內看到相同 BB，不受市價微動影響
- **下界保護**：`lowerPrice = max(sma - maxOffset, sma - k × stdDev)`，`maxOffset = sma × 10%`，禁止使用絕對數值夾值
- **幣價快取**：同時取得 WETH / cbBTC / CAKE / AERO 四個價格（DexScreener，2 分鐘 TTL），存入 `BBResult`
- **k 值**：`appState.bbKLowVol`（震盪市）/ `appState.bbKHighVol`（趨勢市），預設讀 `config.BB_K_LOW_VOL / BB_K_HIGH_VOL`，可透過 `/bbk` 即時調整；完整說明見 README.md
- **關鍵函式**：`computeDynamicBB()` — 計算上下界 Tick 與價格

### ChainEventScanner（`src/services/ChainEventScanner.ts`）

- **架構**：通用 `getLogs` 掃描器，取代 `OpenTimestampService.ts`；新增事件類型只需實作 `ScanHandler` 介面並呼叫 `chainEventScanner.registerHandler()`
- **ScanHandler 介面**：`getFromBlock()` / `processLog()` / `onBatchComplete()`；支援 `stopOnFirstMatch`、`needsBlockTimestamp`、OR-filter tokenId 批次查詢
- **分組策略**：同 NPM 合約的所有 tokenId 合併一次 `getLogs`（OR filter），分塊掃描（`BLOCK_SCAN_CHUNK=2000`），連續失敗超過 `MAX_CONSECUTIVE_FAILURES=3` 即中止
- **內建 Handler**：`OpenTimestampHandler`（原 `OpenTimestampService.ts` 邏輯移入此處）
- **Singleton 匯出**：`chainEventScanner`、`openTimestampHandler`、`getOpenTimestampSnapshot()`、`restoreOpenTimestamps()`

### PositionScanner（`src/services/PositionScanner.ts`）

- **職責**：狀態管理、倉位發現、鏈上原始資料讀取（→ `RawChainPosition[]`）、timestamp 補齊；不直接計算 IL / PNL / Risk
- **多錢包支援**：`WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 環境變數，支援動態新增
- **UniswapV4 支援**：`_fetchV4NpmData()` 透過 V4 PositionManager 的 `getPoolAndPositionInfo(tokenId)` 取得 PoolKey + packed PositionInfo；PositionInfo packed uint256 解碼：bits 0-23 = tickLower（int24），bits 24-47 = tickUpper（int24）；poolId 由 `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))` 動態計算
- **Gauge / MasterChef 鎖倉**：`TRACKED_TOKEN_<tokenId>=<DEX>` 手動追蹤質押倉位（DEX 值：`UniswapV3` / `UniswapV4` / `PancakeSwapV3` / `Aerodrome`）；`isStaked` 欄位自動偵測（ownerOf 回傳非已知錢包 → staked）；`depositorWallet` 追蹤實際持有者
- **關閉倉位自動剔除**：`updatePositions()` 確認 `liquidity=0` 時，將 tokenId 加入 `closedTokenIds` Set 並設 `WalletPosition.closed = true`（透過 `ucUpsertPosition`）；`syncFromChain` 和 `restoreDiscoveredPositions` 均跳過 closed 倉位；重啟後由 `restoreFromUserConfig()` 從 `userConfig.wallets[].positions[].closed` 重建 Set，不重新掃描已關倉 NFT
- **Burned NFT 自動偵測**：`_fetchNpmData()` 捕捉 `positions()` 或 `ownerOf()` 拋出含 `"ID"` 或 `"nonexistent token"` 的錯誤時，自動將 tokenId 加入 `closedTokenIds`、設 `closed=true`、從 `positions` 陣列移除，停止後續重試；不需等待使用者手動呼叫 `/unstake`
- **`unstake()` 方法**：供 TelegramBot `/unstake` 指令呼叫，負責鏈上驗證後清除 `externalStake`；回傳 discriminated union：`{ status: 'closed' }` / `{ status: 'still_staked'; owner }` / `{ status: 'ok' }` / `{ status: 'not_found' }` / `{ status: 'chain_error'; error }`；若鏈上 `liquidity=0` 或 NFT 已 burned 則自動關倉；若 `ownerOf` 仍是合約（NFT 還在 Gauge）則回傳 `still_staked` 阻止操作；**TelegramBot 只格式化結果，不包含任何鏈上查詢邏輯**
- **Drift 門檻**：實際區間與 BB 區間重合度 < 80% 時推播 `STRATEGY_DRIFT_WARNING`
- **手續費計算**：委託 `FeeCalculator`（見下方），PositionScanner 不直接呼叫合約計算費用
- **timestamp 失敗保護**：`timestampFailures` Map 記錄各 tokenId 失敗次數；超過 `config.TIMESTAMP_MAX_FAILURES`（= 3）後寫入 `openTimestampMs = -1`（顯示 N/A），停止重試
- **注意**：Aerodrome `positions()` 第 5 欄回傳 `tickSpacing`（非 fee pips）
- **關鍵函式**：`fetchAll()` / `updatePositions()` / `syncFromChain(skipTimestampScan?)` / `fillMissingTimestamps()` / `restoreDiscoveredPositions()` / `restoreFromUserConfig()` / `unstake(tokenId)`

### FeeCalculator（`src/services/FeeCalculator.ts`）

- **職責**：純 RPC 手續費計算，與 PositionScanner 解耦
- **共用常數**：`MAX_UINT128`、`Q128`、`U256` 定義於 `config/constants.ts`，透過 `utils/math.ts` re-export；`sub256()` 定義於 `utils/math.ts`；FeeCalculator 直接從 `utils/math.ts` import
- **UniswapV4**：`StateView.getPositionInfo(poolId, positionManager, tickLower, tickUpper, salt)` 取得 `lastFgX128`；`StateView.getFeeGrowthInside(poolId, tickLower, tickUpper)` 取得當前 `fgX128`；`fees = liquidity × sub256(current, last) / 2^128`；`salt = bytes32(tokenId)`
- **Aerodrome staked fallback 鏈**：`voter.gauges()` → `gauge.pendingFees(tokenId)` → `collect.staticCall({from: gauge})` → `tokensOwed`（`computePendingFees()` 已永久移除：Aerodrome pool 在公共節點不支援 `feeGrowthGlobal` / `ticks()`，每次掃描浪費 6+ 次 RPC retry）
- **Aerodrome unstaked**：`computePendingFees()`（pool feeGrowth 數學計算）
- **UniswapV3 / PancakeSwapV3**：`collect.staticCall({ from: owner })`，最終 fallback `tokensOwed0/1`
- **第三幣獎勵**：PancakeSwapV3 staked → `masterchef.pendingCake(tokenId)`；Aerodrome staked → `gauge.earned(depositorWallet, tokenId)`
- **幣價**：直接使用傳入的 `cakePrice / aeroPrice` 參數（由 `tokenPrices.ts` 提供），不自行維護快取

### PositionAggregator（`src/services/PositionAggregator.ts`）

- **職責**：Pipeline 組裝，將 `RawChainPosition[]` 轉為完整 `PositionRecord[]`
- **輸入**：`rawPositions, latestBBs, latestPools, gasCostUSD`
- **內部呼叫**：`FeeCalculator`、`RiskManager`、`PnlCalculator`、`rebalance`
- **幣價 fallback**：`bb` 為 null 時（啟動首次掃描），fallback 到 `getTokenPrices()` 取得 WETH / cbBTC / CAKE / AERO 價格，避免啟動時幣價全為 $0
- **token 數量**：`assemble()` 計算並儲存正規化持倉數量 `amount0 = normalizeAmount(posAmount0Raw, dec0)`、`amount1 = normalizeAmount(posAmount1Raw, dec1)`，供 Telegram 🪙 行與 position.log Holdings 行顯示
- **關鍵函式**：`aggregateAll(rawPositions, latestBBs, latestPools, gasCostUSD)` / `assemble(input)`

### BandwidthTracker（`src/utils/BandwidthTracker.ts`）

- **職責**：各池 30D bandwidth 滾動窗口管理，與 `index.ts` 及 `RiskManager` 解耦
- **窗口大小**：`config.BANDWIDTH_WINDOW_MAX`（= 8640 筆 = 30D × 288 cycles/day）
- **持久化**：`snapshot() / restore()` 接入 `state.json`，重啟後自動恢復
- **Singleton**：`export const bandwidthTracker = new BandwidthTracker()`

### RiskManager & EOQ（`src/services/RiskManager.ts`）

```
Health Score      = 50 + (unclaimedFees + cumulativeIL) / capital × 1000（上限 100 分）
IL Breakeven Days = |cumulativeIL| / dailyFeesUSD（cumulativeIL < 0 才計算，否則 0）
EOQ Threshold     = sqrt(2 × P × G)   ← P = positionValueUSD, G = gasCostUSD（與日費率無關）
compoundIntervalDays = Threshold / dailyFeesUSD
```

- `G`（Gas）必須由 `fetchGasCostUSD()` 即時取得，**禁止硬編碼**
- `dailyFeesUSD` 內部按倉位佔池 TVL 比例縮放：`poolDailyFeesUSD × (capital / tvlUSD)`
- `redAlert`：`cumulativeIL < 0 && ilBreakevenDays > RED_ALERT_BREAKEVEN_DAYS`（盈利中不觸發）
- 當 `Unclaimed Fees > Threshold` 時發送 `COMPOUND_SIGNAL`
- **關鍵函式**：`analyzePosition(positionState, bb, poolDailyFeesUSD, avg30DBandwidth, currentBandwidth, gasCostUSD?, tvlUSD?)`

| 條件 | 標記 | 建議行動 |
|------|------|----------|
| cumulativeIL < 0 且 Breakeven Days > 30 天 | `RED_ALERT` | 建議減倉 |
| Bandwidth > 2× 30D 平均 | `HIGH_VOLATILITY_AVOID` | 建議觀望 |

### PnlCalculator（`src/services/PnlCalculator.ts`）

- **關鍵函式**：`getInitialCapital(tokenId)` / `calculateOpenInfo()` / `calculatePortfolioSummary()`
- 運算必須與 `@uniswap/v3-sdk` 保持一致

### Telegram Bot（`src/bot/TelegramBot.ts` + `reportService.ts`）

**架構分層：**
- `TelegramBot.ts`：指令路由、`sendAlert()` 推播觸發；呼叫 `reportService` 的兩個 async 函式
- `reportService.ts`：資料協調層，計算總覽/delta/holdings/alerts 等 raw 數值，呼叫 `formatter` 輸出字串；維護快訊 snapshot 與完整報告 snapshot（記憶體，不持久化）
- `formatter.ts`：純字串格式化，接收 raw 數值，**不含任何運算邏輯**
- `reportService` 排程：快訊與完整報告均使用 window-based 對齊（`Math.floor(now/intervalMs) > Math.floor(lastAt/intervalMs)`），避免累積漂移

- **`compactAmount(n)`**：將極小數字轉為下標零表示法（如 `0.0002719` → `0.0₃2719`），Telegram 與 positions.log 共用同一邏輯（`formatter.ts`）
- **淨損益 vs 無常損失**：`💸 淨損益` = LP現值 + Unclaimed - 本金（含手續費）；`無常損失` = LP現值 - 本金（純市價波動）
- **鎖倉 icon**：`isStaked = true` 的倉位在 tokenId 後顯示 `🔒`
- **BB k 值顯示**：報告底部顯示目前 `k_low / k_high`（`appState.bbKLowVol / bbKHighVol`）
- **`sendAlert(message)`**：直接呼叫 `bot.api.sendMessage`，不 try/catch（錯誤向上拋出，不靜默吞掉）；訊息超過 4096 字元時自動按換行拆分成多段發送
- **池排行 APR 格式**：有 `farmApr` 時顯示 `APR Z.XX%(手續費X.XX%+農場Y.XX%)`；In-Range APR 以 `totalApr` × 資金效率計算
- **`/unstake` 架構原則**：TelegramBot 只格式化 `positionScanner.unstake(tokenId)` 的回傳結果，不包含任何鏈上查詢或狀態變更邏輯；`setPositionScanner(scanner)` 方法於 `index.ts` 啟動時注入

**指令**：`/help` / `/sort <key>` / `/interval <分鐘>` / `/report [flash|full <分鐘>]` / `/bbk [low high]` / `/compact` / `/config` / `/wallet` / `/dex` / `/invest` / `/capital` / `/stake` / `/unstake`；完整說明見 README.md

**所有 Telegram 可修改的變數均存於 `appState.userConfig`**，透過 `onUserConfigChange` 回呼立即持久化：
- `sortBy` — `/sort`；`intervalMinutes` — `/interval`（同時觸發 `onReschedule` 更新 cron）
- `flashIntervalMinutes` — `/report flash`；`fullReportIntervalMinutes` — `/report full`
- `bbKLowVol / bbKHighVol` — `/bbk`（同時直接更新 `appState.bbKLowVol/bbKHighVol` 供 BBEngine runtime 使用）
- `compactMode` — `/compact`（toggle，完整報告每倉位顯示 2 行核心數據）
- `wallets[].positions[]` — `/wallet` / `/invest` / `/capital` / `/stake` / `/unstake`

**報告欄位邏輯（實作參考）：**

- `💱` 幣價行：`getTokenPrices()` 提供，不依賴 BBResult
- `⏳ 開倉`：需 `openTimestampMs > 0`；`· 獲利 +X%` 需 `initialCapital != null`
- `💼 倉位`：`positionValueUSD`；`本金`：`initialCapital ?? N/A`；`健康`：`healthScore/100`
- `⌛ Breakeven`：`ilUSD >= 0` → 顯示「盈利中」；否則顯示 `breakevenDays` 天數
- `💸 淨損益`：`ilUSD`（LP現值 + Unclaimed - 本金）；`無常損失`：`positionValueUSD - initialCapital`
- `🪙 持倉數量`：`amount0` / `amount1`（PositionAggregator 組裝時計算並儲存的正規化 token 數量）
- `🔄 未領取`：`unclaimedFeesUSD`；`✅/❌` 比較 `compoundThreshold`；逐幣明細各幣 > 0 才顯示
- `🔒`：`isStaked = true`
- `⚠️ RED_ALERT`：`cumulativeIL < 0 && breakevenDays > config.RED_ALERT_BREAKEVEN_DAYS`（盈利中不觸發）
- `⚠️ HIGH_VOLATILITY_AVOID`：`currentBandwidth > avg30D × config.HIGH_VOLATILITY_FACTOR`
- `⚠️ DRIFT`：`overlapPercent < config.DRIFT_WARNING_PCT`；附 `rebalance.strategyName`
- 底部：`📐 BB k: low=X  high=X`（`appState.bbKLowVol / bbKHighVol`）

完整格式範例見 README.md。

### 環境變數

完整說明與 `.env` 範例見 **README.md**。Claude 在讀寫環境變數時需注意的關鍵命名：
- `WALLET_ADDRESS_N`：多錢包種子（啟動後透過 `/wallet add` 動態管理，持久化於 `state.json`）
- 本金設定、外部質押追蹤：已移至 `state.json` 的 `userConfig` 欄位，透過 Telegram 指令管理（`/invest`、`/capital`、`/stake`、`/unstake`）；**不再使用 `.env` 變數**

---

## 4. 安全性備註

本 Bot 為**純背景監測腳本**，`npm audit` 回報的相依套件漏洞在當前架構下風險為零：

- **無 Web Server**：無外部接收 payload 或 cookie 的介面
- **無動態合約編譯**：不使用 `solc` 或 `mocha`，無 RCE 風險
- **無私鑰簽發**：純監測模式，未引入錢包私鑰進行鏈上寫入

> 可安全忽略 `cookie`、`serialize-javascript`、`elliptic` 等套件的升級警告。

---

## 5. 待處理任務

> P0 最緊急 → P4 待討論；完成後刪除條目，該優先級全空則標注 ✅

### P0 🔴 ✅ 已完成

### P1 🟠 高優先（近期動工）

- [ ] **質押倉位自動偵測**：`syncFromChain()` 掃完錢包 balance 後，額外掃各 NPM 合約的 ERC-721 Transfer 事件（`from=wallet, to=已知質押合約`），自動發現未登記的質押倉位。實作重點：
  - PancakeSwap：`Transfer(from=wallet, to=PANCAKE_MASTERCHEF_V3)` on PancakeSwap V3 NPM，發現後呼叫 `masterchef.userPositionInfos(tokenId)` 確認 `user==wallet`（排除已領回）
  - Aerodrome：先對已知池子呼叫 `voter.gauges(poolAddress)` 取 gauge 地址，再掃 `Transfer(from=wallet, to=gauge)` on Aerodrome NPM
  - 確認仍在質押後自動 upsert `externalStake: true`（不覆蓋已手動設定的 `initial`）
  - 限制：block lookback 3M blocks ≈ 70 天，更早質押的需手動 `/stake`

- [ ] **穿倉即時告警 (Out-of-Range Alert)**：目前穿倉只能在每輪 cron 掃描時被動發現（延遲 5~30 分鐘）。應在 `ChainEventScanner` 中為重點池新增 Swap event 監聽，在記憶體內維護最新 `currentTick`，一旦偵測到 `currentTick < tickLower` 或 `currentTick > tickUpper` 立即推播 Telegram 告警。實作重點：
  - 新增 `SwapTickHandler`（實作 `ScanHandler` 介面），訂閱目標池的 `Swap(address,address,int256,int256,uint160,uint128,int24)` event，從最後一個參數取 `tick`
  - 僅需更新 `appState.positions` 對應倉位的 `currentTick`，不觸發完整 `runPositionScanner()`
  - 告警訊息格式：`⚠️ #tokenId 穿倉！當前 tick=X 已超出 [tickLower, tickUpper]`
  - 告警後設 cooldown（如 30 分鐘），避免在邊界反覆推播

- [ ] **Aerodrome Gauge Emissions APR**：TVL 修正已完成（`_fetchAerodromeTVL` 鏈上讀 token balance）。仍需補充 AERO Token 排放部分：
  - `gauge.rewardRate()` → 每秒 AERO 排放量
  - `gauge.totalSupply()` → 已質押 LP 總量
  - 公式：`emissionApr = (rewardRate × 86400 × 365 × aeroPrice) / (totalSupply × lpPriceUSD)`
  - `PoolStats` 新增 `emissionApr?: number`；Telegram 池排行格式改為 `手續費 X% + 排放 Y%`


### P2 🟡 中優先（排程中）

- [ ] **BBEngine 帶寬優化（區間太窄）**：目前 EWMA 過度平滑（β=0.7）導致方差嚴重低估，加上缺乏 stdDev 下限，低波動期帶寬可能崩塌至 ±0.5%，遠小於實際日內波動。分兩步實作：
  - **步驟一（改動小）**：加 stdDev 下限 — `stdDev1H = Math.max(ewmaStdDev, volDerivedStdDev)`，確保帶寬不低於 30D 歷史波動率暗示的最小值；新增常數 `BB_MIN_BAND_PCT`（建議 0.03），`halfBand = Math.max(k × stdDev1H, sma × BB_MIN_BAND_PCT)`
  - **步驟二（改動中）**：對原始價格計算方差（不對 EWMA 平滑後的序列算），EWMA 只用來平滑 SMA 趨勢，不影響方差估計
  - 調整後觀察 1~2 天，若仍太窄再加步驟二；同時補充對應單元測試驗證帶寬下限

- [ ] **rebalance.ts 帶寬輔助決策（階段二）**：依賴 P1 穿倉告警的 `SwapTickHandler` 基礎設施。在決策樹入口加帶寬防護層：若當前 `currentBandwidth > avg30D × HIGH_VOLATILITY_FACTOR`（毒性交易流 / 異常單邊行情），強制覆寫為 `wait` 策略，避免在飛刀行情下掛單接盤。實作重點：
  - `getRebalanceSuggestion()` 新增 `currentBandwidth` 與 `avg30DBandwidth` 參數（由 `bandwidthTracker` 提供）
  - 帶寬過高時提前回傳 `{ recommendedStrategy: 'wait', strategyName: '高波動觀望' }`
  - 依賴 P2 毒性交易流偵測完成後可共用同一帶寬數據

- [ ] **毒性交易流偵測 (Toxic Order Flow)**：依賴 P1 `SwapTickHandler` 基礎設施，在同一 Swap event 監聯上加統計邏輯。在 5 分鐘滾動窗口內若同向 Swap 比率 > 80%（token0→token1 或反向）且淨流量 > 池 TVL 的 X%，觸發 `🚨 毒性交易流警報` 建議短期撤回流動性。需先確認：
  - **「大額」門檻**：相對 TVL 百分比（建議 0.5%）或固定 USD 金額？
  - **時間窗口**：5 分鐘 vs 15 分鐘，影響誤報率
  - 實作時新增 `ToxicFlowDetector`，`RiskAnalysis` 新增 `toxicFlowWarning` 欄位

- [ ] **PoolScanner DexScreener URL 統一使用 `config.API_URLS`**：`fetchPoolStats` L154 與 `_fetchV4PoolStats` L276 的 DexScreener URL 直接硬編碼，應改用 `config.API_URLS.DEXSCREENER_PAIRS`

- [ ] **PoolScanner V3/V4 APR 計算邏輯提取共用函式**：`fetchPoolStats` 與 `_fetchV4PoolStats` 有 ~30 行重複的 volume blending + APR 計算邏輯，應提取為 `_computeAprFromVolume(tvlUSD, volData, feeTier)` 共用函式

- [ ] **FeeCalculator `voter.gauges()` 同 cycle 重複呼叫**：`fetchUnclaimedFees` 和 `fetchThirdPartyRewards` 各自呼叫 `voter.gauges(poolAddress)`，同一個 tokenId 在同一個 cycle 內重複 RPC 2 次。應在 caller 層快取結果或將 gauge address 傳入參數

- [ ] **PositionScanner.logSnapshots 同步 I/O**：L318 `fs.appendFileSync`（同步 I/O），多倉位下可能短暫阻塞事件循環。建議改為 `await fs.appendFile`

- [ ] **PositionScanner.getPoolFromTokens 不驗證 token pair**：L476 只比對 fee + dex，不驗證 token0/token1 地址。若未來出現同 DEX 同 fee 但不同 token pair 的池子會誤配。應同時比對 token 地址


- [ ] **stateManager `readJson` 無 schema 驗證**：L97 直接 `as PersistedState`，若 JSON 格式損毀會在後續程式碼拋出難以追蹤的錯誤。建議加 try-catch 包裝或 schema 驗證

- [ ] **TelegramBot `/pool add` fee 輸入格式不一致**：使用者輸入百分比（如 `0.05`），但 `constants.ts POOLS` 的 fee 格式為小數（如 `0.0005`），容易混淆。應在指令說明中明確標注，或自動偵測並轉換

### P3 🔵 有依賴鏈（需按序執行）

✅ 已完成

### P3 🔵 有依賴鏈（需按序執行）

- [ ] **為 `position: any` 定義型別**：`AggregateInput.position` 與 `RawChainPosition.position` 使用 `any`，應定義 `V3PositionData` / `V4PositionData` union type，消除跨模組型別盲區

- [ ] **補充 utils 層單元測試**：目前僅 `BBEngine`、`RiskManager`、`PnlCalculator`、`rebalance` 有測試。需補充 `stateManager`（遷移邏輯）、`AppState`（ucUpsertPosition / ucRemovePosition）、`formatter`（compactAmount / buildPositionBlock）、`validation`、`math` 的單元測試

- [ ] **`index.ts` 排程協調邏輯整合測試**：`src/index.ts` 目前覆蓋率 0%（未被任何 test import，因副作用太重）。`fastStartup.test.ts` 只測抽象狀態機，未覆蓋實際的 `runCycle()`、`buildCronJob()`、`main()` 流程。改法：將 `runCycle()` 的 runner 序列改為可注入設計（接收 runner 函式陣列參數，預設為實際 runners），測試時傳入 mock runners，即可真正驗證 `buildCronJob` 的 isCycleRunning 保護、`FAST_STARTUP` 5 秒觸發、`gracefulShutdown` 的 save 行為，不需啟動任何外部服務

### P4 ⚪ 待討論後動工

#### rebalance.ts 數學引擎升級（階段三）

需先確認以下問題：

1. **SDK 替換必要性**：`Math.sqrt` 在極窄區間（18 dec vs 8 dec 混搭池）是否有實際精度問題？需要實測確認誤差量級
2. **Delta 輸出格式**：`suggestedHedgeDelta` 應輸出 token 數量還是 USD 名目值？需對接永續合約 API

確認後執行步驟：

- [ ] 以 `@uniswap/v3-sdk` `TickMath` 替換 `Math.sqrt` sqrtPrice 推算，確保極端匯率精度
- [ ] `RebalanceSuggestion` 新增 `suggestedHedgeDelta`（多/空頭暴露量），供未來 Delta-Neutral 整合（對應方向一）
- [ ] 將 `calculateV3TokenValueRatio` 的浮點平方根改為 SDK `Position` 精算，消除 `deficitRatio` 誤差

#### IL 精算與財務模型重構

需先確認以下問題：

1. **本金定義**：`initial` 指「首次入金」還是「累計加減倉後的淨投入」？是否需支援動態加減倉紀錄？
2. **已領取手續費**：是否需要追蹤 `collectedFeesUSD`？若需要，要掃描 `Collect` event 累加。
3. **SDK 精算必要性**：現行誤差預計 < 1%，在沒有測試保護前是否值得優先投入？
4. **Health Score 公式**：`50 + roi × 1000` 線性映射在極端值的表現是否符合預期？

確認後執行步驟：

- [ ] 以 `@uniswap/v3-sdk` `Position` 替換 `positionValueUSD` 計算
- [ ] `PositionRecord` 新增 `collectedFeesUSD` 欄位
- [ ] `ilUSD` 改為 `LP現值 + unclaimed + collected - 本金`
- [ ] `RiskManager.analyzePosition` 傳入精算後 `ilUSD`
- [ ] 補充邊界條件單元測試（依賴 P3 Jest 基礎設施）

#### 回測策略模擬

需先確認以下問題：

1. **再平衡成本模型**：slippage 使用固定比例（0.1%）還是依池子深度動態計算？
2. **複利假設**：收取的手續費是否自動再投入 LP？
3. **資料粒度**：GeckoTerminal 只提供 1D OHLCV，1H BB 計算是否可接受用日線代替？（日線替代會產生系統性偏差）
4. **回測範圍**：只支援現有池子，還是允許自訂池地址？
5. **輸出格式**：console log、JSON export，還是 Telegram 指令觸發？
6. **IL 計算**：逐日需模擬每個時間點的 sqrtPrice 數學計算 LP 現值，複雜度高
7. **Gas 成本**：歷史 Gas 費用難取得，是否接受固定值（如 $2/次）作為估計？

確認後執行步驟：

- [ ] `BacktestEngine.ts` 新增 `runSimulation(poolAddress, days)`
- [ ] 實作 `HoldStrategy`（持倉不動的 IL + 手續費收益）
- [ ] 實作 `RebalanceStrategy`（每日收盤觸發 BB 判斷，扣除 Gas + slippage）
- [ ] 輸出比較表：`[日期 | Hold PnL | Rebalance PnL | 再平衡次數 | 累計 Gas]`
- [ ] Telegram `/backtest <days>` 指令

#### 其他待討論項目

- [ ] **PositionRecord 型別拆分**：目前 27 個欄位超大，可考慮拆成 `PositionCore` + `PositionRisk` + `PositionMetadata` 子型別，降低認知負擔
- [ ] **統一 RPC provider 機制**：`rpcProvider`（FallbackProvider）僅在 `fetchGasCostUSD` 使用，其他地方用 `nextProvider()`（round-robin），兩套機制共存不一致
- [ ] **`tokenPrices.ts` 個別錯誤處理**：四個平行 DexScreener API 呼叫使用 `Promise.all`，一個失敗全部失敗；應改 `Promise.allSettled` 讓部分失敗時其餘幣價仍可更新
- [ ] **`index.ts bbForLog` 只取第一個 BB**：L226 `Object.values(appState.bbs)[0]` 在多池情境下 log 顯示的 BB 可能是錯誤的池。應改為按 position 關聯的 pool 取對應 BB
- [ ] **stateManager 建立空 WalletEntry 的 hack**：L64-72 使用 `ucUpsertPosition` + 清空 `positions` 的方式不直觀，建議新增 `ucAddWallet(cfg, address)` 專用函式
- [ ] **型別強化**：`BBResult.regime` 改為 string literal union；`ScanRequest.dex` 改為 `Dex` 型別；`PositionRecord.currentPriceStr` 考慮改為 `number`

---

## 6. 未來展望

以下為 V1 穩定後可探索的策略方向，不在當前實作範圍內，僅作為架構演進參考。

### 方向一：Delta-Neutral 整合對沖策略

**痛點**：V3 LP 最大問題是「賺了手續費，賠了幣價跌幅」。

**方向**：整合永續合約 DEX（Hyperliquid、GMX 或 Base 上的 Perp 協議）。

**實作場景**：DexBot 偵測到 WETH/USDC LP 倉位後，自動計算對 WETH 的多頭曝險（Delta），並建議在永續合約市場開出等值空單對沖。LP 倉位因此轉變為純手續費收益機，完全免疫幣價波動。

**技術前置條件**：
- 接入 Hyperliquid 或 GMX API，取得即時資金費率與開倉成本
- `PositionRecord` 新增 `deltaExposure` 欄位（由 `PositionAggregator` 根據 V3 流動性數學計算）
- 對沖建議納入 `RebalanceSuggestion`，並在 Telegram 報告中呈現

---

### 方向二：跨池跨協議資金遷移套利（Cross-Pool Migration）

**痛點**：現有 Bot 只針對「已持有倉位」做再平衡，忽略「別的池子更香」的機會。

**方向**：建立多維度資本效率掃描器，主動比較同交易對在不同 DEX / 費率層的 APR 差異。

**實作場景**：WETH/cbBTC 在 Uniswap 0.05% APR 掉到 20%，同期 Aerodrome 同交易對 APR 飆至 80%；扣除 Gas 與滑價後，遷移回本週期僅 2 天，Bot 推播遷移建議。

**技術前置條件**：
- `PoolScanner` 擴展為掃描更多候選池（超出現有 POOL_SCAN_LIST）
- 新增 `MigrationAnalyzer`：計算遷移成本（Gas × 2 + 滑價估計）與 APR 差異回本期
- Telegram 新指令 `/migrate` 觸發即時遷移機會掃描

---

### 方向三：Smart Money 追蹤與逆向工程

**痛點**：`PositionAggregator`、`ChainEventScanner` 的基礎設施目前只服務自己的錢包。

**方向**：將監控目標擴展至「歷史績效前 5% 的頂級 LP 地址」，建立聰明錢追蹤清單。

**實作場景**：分析歷史 NFT Mint/Burn/Collect 事件找出長期獲利巨鯨；當這些地址突然撤走流動性或對新池開出極窄區間，Bot 推播「🐋 聰明錢動作警報」供跟單或離場參考。長期可包裝為 SaaS 付費訂閱服務。

**技術前置條件**：
- `ChainEventScanner` 新增 `SmartMoneyHandler`（ScanHandler 介面），掃描指定地址的 LP 行為
- 新增外部錢包監控清單（`SMART_MONEY_ADDRESSES` env 變數）
- Telegram 新增聰明錢動作推播頻道分組

---

### 方向四：LVR 監控與毒性交易流防禦

**痛點**：Bollinger Bands 是統計學指標，LP 的真實虧損主要來自套利者（Arbitrageurs），學術上稱為 LVR（Loss Versus Rebalancing）。

**方向**：超越技術分析，改用鏈上原生的 Order Flow 特徵評估風險。

**實作場景**：監控池子 Swap 方向與頻率；若偵測到明顯單向毒性交易流（CEX 砸盤 → 鏈上套利機器人倒貨），不等價格碰到布林下軌就提早觸發「☠️ 毒性交易流警告」，建議暫時抽離流動性，等 CEX/DEX 價格回歸平衡後再放回。

**技術前置條件**：
- `ChainEventScanner` 新增 `SwapFlowHandler`：統計近 N 個 block 內 Swap 的 token0→token1 vs token1→token0 比率
- 新增 `ToxicFlowDetector`：計算單向流比率門檻（如 > 80% 同向視為毒性）
- 整合至 `RiskManager.analyzePosition()`，新增 `toxicFlowWarning` 欄位

---

### 方向五：期權對沖 IL（Panoptic / Smilee）

**原理**：在 Uniswap V3 提供流動性，數學上等同於「賣出賣權（Short Put）」。

**方向**：對接 DeFi 期權協議（Panoptic、Smilee），在開 LP 時同步計算期權保費，達到最大虧損鎖死、手續費收益無限的完美部位。

**實作場景**：Bot 建議開出偏窄 LP 區間時，同步計算在 Panoptic 買入對應深度價外（OTM）選擇權的成本；若期權保費遠低於預期手續費收入，推播「💡 建議買入 IL 保險」。

**技術前置條件**：
- 接入 Panoptic 或 Smilee API，取得指定 Strike / Expiry 的期權報價
- 新增 `OptionsHedgeCalculator`：輸入 LP 區間與預期持倉天數，輸出保費 vs 預期費收的損益平衡點
- 整合至 `RebalanceSuggestion`，作為可選對沖建議欄位

---