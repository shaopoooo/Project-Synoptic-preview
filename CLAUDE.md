# CLAUDE.md — DexBot V1 多 DEX 策略（小市值版）

---

## 1. 專案核心定位

- **執行模式**：純監測 + 手動執行（Telegram Bot 推播訊號）
- **技術選型**：Node.js + TypeScript、`@uniswap/v3-sdk`、`grammyjs`（Telegram）、`ethers.js`

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
- 所有外部傳入的 Pool Address 必須通過 `/^0x[0-9a-fA-F]{40}$/` 校驗
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

**部署文件**
- `README.md`：清楚列出所有環境變數及說明
- `Dockerfile`：包含 Railway 部署設定指南

---

## 3. 模組說明 & 程式碼索引

### 目錄結構

```
src/
├── index.ts                    # 主進入點：cron 排程、服務協調、狀態存取
├── config/
│   ├── env.ts                  # 環境變數讀取（process.env）
│   ├── constants.ts            # 常數（池地址、子圖端點、快取 TTL）
│   ├── abis.ts                 # 合約 ABI（NPM、Pool、Aero Voter/Gauge）
│   └── index.ts                # 統一匯出入口
├── services/
│   ├── PoolScanner.ts          # APR 掃描（DexScreener + The Graph + GeckoTerminal）
│   ├── BBEngine.ts             # 動態布林通道（20 SMA + 30D 波動率）
│   ├── PositionScanner.ts      # LP NFT 倉位監測（On-chain RPC）
│   ├── RiskManager.ts          # 風險評估（Health Score、IL Breakeven、EOQ 複利訊號）
│   ├── PnlCalculator.ts        # 絕對 PNL、開倉資訊、組合總覽計算
│   ├── OpenTimestampService.ts # 批次查詢 NFT 建倉時間戳（per NPM 單次 getLogs）
│   └── rebalance.ts            # 再平衡建議（純計算，不執行交易）
├── bot/
│   └── TelegramBot.ts          # Telegram 推播格式化
├── backtest/
│   └── BacktestEngine.ts       # 歷史回測引擎
└── utils/
    ├── logger.ts               # Winston 彩色 logger（console + 檔案輪轉）
    ├── math.ts                 # BigInt 固定精度數學工具
    ├── rpcProvider.ts          # FallbackProvider + rpcRetry + nextProvider() + fetchGasCostUSD()
    ├── cache.ts                # LRU 快取實例（bbVolCache、poolVolCache）+ snapshot/restore
    └── stateManager.ts         # 跨重啟狀態持久化（讀寫 data/state.json）
```

### 核心資料流

```
# 啟動順序（一次性）
runPoolScanner → runPositionScanner → runBBEngine → runRiskManager
                 ↑ 先填充 activePositions    ↑ 才有池子可算 BB

# 5 分鐘 cron（BBEngine 必須在 PositionScanner 之前）
runPoolScanner → runBBEngine → runPositionScanner → runRiskManager → runBotService
                 ↑ 預計算 BB   ↑ 直接使用 latestBBs，不重複呼叫 GeckoTerminal
```

### PoolScanner（`src/services/PoolScanner.ts`）

- **資料來源**：DexScreener（TVL）→ The Graph（Uniswap/PancakeSwap）→ GeckoTerminal（Aerodrome + fallback）
- **APR 公式**：`APR = (24h 手續費 / TVL) × 365`，24h 手續費 = 7D 加權均量 × 費率
- **關鍵函式**：`scanAllCorePools()` → `fetchPoolStats()` → `fetchPoolVolume()`

| 協議 | 費率 | 合約地址 |
|------|------|----------|
| PancakeSwap V3 | 0.01% | `0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3` |
| PancakeSwap V3 | 0.05% | `0xd974d59e30054cf1abeded0c9947b0d8baf90029` |
| Uniswap V3 | 0.05% | `0x7aea2e8a3843516afa07293a10ac8e49906dabd1` |
| Uniswap V3 | 0.30% | `0x8c7080564b5a792a33ef2fd473fba6364d5495e5` |
| Aerodrome Slipstream | 0.0085% | `0x22aee3699b6a0fed71490c103bd4e5f3309891d5` |

### BBEngine（`src/services/BBEngine.ts`）

- **均線週期**：20 SMA，時間框架：1 小時；Tick 轉換使用 `@uniswap/v3-sdk` `TickMath` + `nearestUsableTick`
- **下界保護**：`lowerPrice = max(sma - maxOffset, sma - k × stdDev)`，禁止使用絕對數值夾值
- **關鍵函式**：`computeDynamicBB()` — 計算上下界 Tick 與價格

| 市場狀態 | 條件 | k 值 |
|----------|------|------|
| 震盪市 | 30D 年化波動率 < 50% | `k = 1.2` |
| 趨勢市 | 30D 年化波動率 ≥ 50% | `k = 1.8` |

### PositionScanner（`src/services/PositionScanner.ts`）

- **多錢包支援**：`WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 環境變數，支援動態新增
- **Gauge 鎖倉**：`TRACKED_TOKEN_<tokenId>=<DEX>` 手動追蹤質押至 Aerodrome Gauge 的倉位
- **Drift 門檻**：實際區間與 BB 區間重合度 < 80% 時推播 `STRATEGY_DRIFT_WARNING`
- **手續費計算策略**：
  - Aerodrome → `fetchAerodromeGaugeFees()`（voter → gauge → `pendingFees` 或 `collect.staticCall`）
  - Uniswap / PancakeSwap → `collect.staticCall({ from: owner })`
  - 最終 fallback：NPM `positions()` 的 `tokensOwed0/1`
- **注意**：Aerodrome `positions()` 第 5 欄回傳 `tickSpacing`（非 fee pips）
- **關鍵函式**：`updateAllPositions()` / `syncFromChain()` / `restoreDiscoveredPositions()` / `getDiscoveredSnapshot()`

### RiskManager & EOQ（`src/services/RiskManager.ts`）

```
Health Score     = (Fee_Income / IL_Risk_Weight) × 100（上限 100 分）
IL Breakeven Days = 累計 IL（USD）/ (24h 手續費 / 24)
EOQ Threshold    = sqrt(2 × P × G × Fee_Rate_24h)
```

- `G`（Gas）必須由 `fetchGasCostUSD()` 即時取得，**禁止硬編碼**
- 當 `Unclaimed Fees > Threshold` 時發送 `COMPOUND_SIGNAL`
- **關鍵函式**：`analyzePosition(positionState, bb, dailyFeesUSD, avg30DBandwidth, currentBandwidth, gasCostUSD)`

| 條件 | 標記 | 建議行動 |
|------|------|----------|
| IL Breakeven Days > 30 天 | `RED_ALERT` | 建議減倉 |
| Bandwidth > 2× 30D 平均 | `HIGH_VOLATILITY_AVOID` | 建議觀望 |

### PnlCalculator（`src/services/PnlCalculator.ts`）

- **關鍵函式**：`getInitialCapital(tokenId)` / `calculateOpenInfo()` / `calculatePortfolioSummary()`
- 運算必須與 `@uniswap/v3-sdk` 保持一致

### Telegram Bot（`src/bot/TelegramBot.ts`）

- **關鍵函式**：`sendConsolidatedReport()` — 每 5 分鐘推播單一合併報告

```
[2026-03-07 10:00] 倉位監控報告 (2 個倉位 | 排序: 倉位大小 ↓)

📊 總覽  2 倉位 · 2 錢包
💼 總倉位 $2,960  |  Unclaimed $4.6
💰 總獲利 +$18.2 (+1.82%) 🟢

━━ #1 PancakeSwap 0.01% ━━
倉位 $1,987 | 本金 $2,000 | 健康 94/100
⏳ 開倉 3天2小時 · 獲利 +1.82%
👛 0xabc...1234 · #1675918
💹 當前 0.02921 | Low Vol (震盪市)
  ├ 你的 0.02803 ~ 0.03054
  └ BB   0.02628 ~ 0.03213
💸 Unclaimed $4.6 | IL +$18.2 🟢
⏱ Breakeven 盈利中
🔄 Compound ✅ $4.6 > $0.1

📊 各池收益排行:
🥇 Aerodrome 0.0085% — APR 67.2% | TVL $1,234K
🥈 PancakeSwap 0.01% — APR 29.4% | TVL $987K ◀ 你的倉位
```

排序指令：`/sort size`、`/sort apr`、`/sort unclaimed`、`/sort health`

### 環境變數（`.env`）

| 變數 | 說明 |
|------|------|
| `WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... | 監控錢包地址（逐號新增） |
| `RPC_URL` | Base 主 RPC |
| `SUBGRAPH_API_KEY` | The Graph API Key |
| `BOT_TOKEN` | Telegram Bot Token |
| `CHAT_ID` | Telegram Chat ID |
| `INITIAL_INVESTMENT_<tokenId>` | 各倉位初始本金 USD |
| `TRACKED_TOKEN_<tokenId>` | 手動追蹤鎖倉倉位，值為 DEX 名稱 |

### 待處理問題定位

| 問題 | 檔案 | 位置 |
|------|------|------|
| 缺少 User-Agent Header | `src/services/PoolScanner.ts` | `fetchPoolVolume()` |
| 缺少 User-Agent Header | `src/services/BBEngine.ts` | `fetchDailyVol()` |
| GeckoTerminal 429 rate-limit（平行化前必須處理） | `src/services/PoolScanner.ts` | `fetchPoolVolume()` — 免費 API 易觸發 429，需限制並發（≤2）+ Exponential Backoff |

---

## 4. 安全性備註

本 Bot 為**純背景監測腳本**，`npm audit` 回報的相依套件漏洞在當前架構下風險為零：

- **無 Web Server**：無外部接收 payload 或 cookie 的介面
- **無動態合約編譯**：不使用 `solc` 或 `mocha`，無 RCE 風險
- **無私鑰簽發**：純監測模式，未引入錢包私鑰進行鏈上寫入

> 可安全忽略 `cookie`、`serialize-javascript`、`elliptic` 等套件的升級警告。

---

## 5. 任務清單

### ✅ 階段一：基礎建設（已完成）

- [x] **RPC 備援**：`src/utils/rpcProvider.ts` 實作 `FallbackProvider`（QuickNode → Alchemy → 公共節點）+ `rpcRetry`
- [x] **config 拆分**：`env.ts` / `constants.ts` / `abis.ts` 分離，`index.ts` 統一匯出
- [x] **README.md**：完整記錄環境變數、架構與啟動方式

### ✅ 階段二：多池子 & 多錢包支援（已完成）

- [x] **新增 Aerodrome WETH/cbBTC 池**：fee=85 (0.0085%)，tickSpacing=1，NPM `0x827922...`
- [x] **池命名統一**：全部改為 `{DEX}_{交易對}_{費率}` 格式（如 `UNISWAP_WETH_CBBTC_0_05`）
- [x] **多錢包支援**：`env.ts` 改為 `WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 編號變數
- [x] **syncFromChain 多錢包迴圈**：外層錢包、內層 DEX，已同步錢包記錄於 `syncedWallets` Set
- [x] **getPoolFromTokens 碰撞修正**：key 改為 `${dex}_${fee}`，避免同費率不同 DEX 衝突
- [x] **dex 型別擴充**：全專案 `'Uniswap' | 'PancakeSwap'` 改為加入 `'Aerodrome'`

### ✅ 階段三：Bug 修正（已完成）

- [x] **IL 計算錯誤修正**：改用 Uniswap V3 sqrtPrice 數學計算 LP 倉位本金（`amount0 = L × (1/sqrtP_current - 1/sqrtP_upper)`）
- [x] **Health Score 歸零修正**：連鎖修正（IL 正確後 ilRiskWeight 不再為 $1801）
- [x] **ilUSD 型別修正**：改為 `number | null`，未設定初始本金時顯示「未設定歷史本金」
- [x] **previousBandwidth 污染修正**：改為 `previousBandwidths: Record<string, number>`，各池獨立追蹤
- [x] **initialized flag 改進**：改為 `syncedWallets: Set<string>`，支援熱新增錢包
- [x] **Aerodrome slot0 ABI 修正**：新增 `AERO_POOL_ABI`（6 個回傳值，無 `feeProtocol`），`PoolScanner` 依 dex 動態選擇
- [x] **BBEngine 重複查詢修正**：執行順序改為 BBEngine → PositionScanner，`updateAllPositions` 接收 `latestBBs` 避免重複呼叫 GeckoTerminal
- [x] **鎖倉倉位支援**：`TRACKED_TOKEN_IDS` 結構（`tokenId → dex`），手動補入 Gauge 鎖倉的倉位
- [x] **Aerodrome Subgraph Invalid URL 修正**：`fetchPoolVolume` 加入 `if (!config.SUBGRAPHS[dex])` guard，無 subgraph 時直接跳至 GeckoTerminal
- [x] **Aerodrome NPM fee 欄位語意修正**：Aerodrome `positions()` 第 5 欄回傳 `tickSpacing`（非 fee pips），`getPoolFromTokens` 加入 `'Aerodrome_1'` 對應，`feeTierForStats` 強制設為 `0.000085`
- [x] **BBEngine Aerodrome tickSpacing 修正**：`runBBEngine()` 加入 `feeTier === 0.000085` → `tickSpacing = 1`
- [x] **Hybrid 手續費計算**：`computePendingFees` 在 PancakeSwap 上 CALL_EXCEPTION（無 `feeGrowthGlobal` selector）；改為混合策略：Aerodrome → `fetchAerodromeGaugeFees()`（voter → gauge → `stakedContains` → `pendingFees` 或 `collect.staticCall`），Uniswap/PancakeSwap → `collect.staticCall({ from: owner })`，最終 fallback `tokensOwed0/1`
- [x] **BB lowerPrice 夾值 Bug 修正**：移除 `Math.max(0.00000001, lowerPrice)`，Aerodrome tick-ratio 價格 ~2.9e-12 被夾成 `1e-8` 導致 `tickOffsetLower < 0`，最終 BB 顯示 `99.69 ~ 0.029`（上下顛倒）；改為 `Math.max(sma - maxOffset, sma - k * stdDev)` 確保下界永遠 > 0
- [x] **Startup 執行順序修正**：啟動時改為 `PoolScanner → PositionScanner → BBEngine → RiskManager`（`activePositions` 先填充，BBEngine 才有池子可算），5 分鐘 cron 仍維持 `BBEngine → PositionScanner` 順序（使用預計算 BB 避免重複 API）

### ✅ 階段四：Telegram 報告優化（已完成）

- [x] **合併報告**：廢棄逐位置發送，改為 `sendConsolidatedReport` 單一訊息
- [x] **各池收益排行**：顯示全部池子 APR 由高到低，標記所有有持倉的池子
- [x] **排序指令**：`/sort size|apr|unclaimed|health`，狀態保存於 Bot 實例
- [x] **倉位標頭識別**：顯示錢包尾碼（`0xabc...1234`）與 TokenId
- [x] **手機排版優化**：`formatPositionBlock` 改為每行 ≤ 40 字元，分組顯示
- [x] **/explain 指令**：發送完整指標計算公式說明
- [x] **建倉時間戳**：`syncFromChain` 自動查詢 NFT mint Transfer 事件，快取於 in-memory

### ✅ 階段五：系統穩定性（已完成）

- [x] **狀態持久化**：`PriceBuffer`、`volCache`、`openTimestampCache`、Bot 排序偏好 存入 `data/state.json`（`src/utils/stateManager.ts`）
- [x] **記憶體管理**：`volCache` 集中至 `src/utils/cache.ts`，改用 `lru-cache`（max: 100）
- [ ] **API 防封鎖**：GeckoTerminal 請求補上 `User-Agent` Header（跳過）
- [x] **動態 Gas Oracle**：`src/utils/rpcProvider.ts` 新增 `fetchGasCostUSD()`，即時取得 `maxFeePerGas × GAS_UNITS × ETH_PRICE`，5 分鐘快取；`RiskManager.analyzePosition()` 接受 `gasCostUSD?` 參數
- [x] **Pool Address 輸入校驗**：`PoolScanner.fetchPoolStats()` 加入 `/^0x[0-9a-fA-F]{40}$/` 驗證
- [x] **rpcRetry 補強**：除 rate-limit 外，新增對 `SERVER_ERROR`（502/503）的重試邏輯，避免公共節點瞬斷直接失敗
- [x] **OpenTimestampService**：`src/services/OpenTimestampService.ts`，以 NPM 合約為單位批次掃描 Transfer 事件，所有 tokenId 合併成一次 `getLogs`（`topics[3]` OR filter），不再每個 tokenId 各掃一次；`PositionScanner.syncFromChain()` 改為三階段（發現 → 批次取時間戳 → 建構 seedPositions）
- [x] **Aerodrome unclaimed fees 修正**：`collect.staticCall` 補上 `{ from: owner }`，讓 `isAuthorizedForToken` 驗證通過；舊版無 from 導致 Aerodrome 手續費永遠為 $0
- [x] **addPrice 門檻修正**：從 `< 1e-9` 改為 `<= 0`，修正 Aerodrome tick-ratio（~2.9e-12）被誤判為無效價格的問題
- [x] **BB fallback 最小資料量**：從 `< 2` 改為 `< 5` 筆才 fallback，避免冷啟動時 std dev ≈ 0 導致 BB 帶寬接近零；fallback 標籤從 `'Unknown'` 改為 `'資料累積中'`

### ✅ 階段五-B：Log 系統重構（已完成）

- [x] **logger.ts 強化**：新增 `section()` 分隔線方法、level icon（`·` / `!` / `✖`）、INFO 訊息套用 service 顏色
- [x] **週期分隔線**：每 5 分鐘 cron 加入 `─── 5m cycle ───` / `─── ready ───` 視覺分隔
- [x] **訊息類別 emoji**：`⛓` 鏈上、`🌐` API 請求、`💾` 快取、`📍` 倉位、`✅` 完成、`🔄` 重新觸發
- [x] **去除重複前綴**：移除所有訊息內 `[ServiceName]` 冗餘前綴（tag 已標示）

### 🔴 階段五-C：positions.log 可讀性優化（待處理）

- [ ] **positions.log 格式重構**：目前為原始 JSON，改為仿 Telegram 報告的文字格式，每筆快照排版如下：

```
[2026-03-06 17:05] ━━ #1675918 PancakeSwap 0.01% ━━
倉位 $12,400 | APR 67.2% | 健康 94/100
👛 0xaBcD...1234
💹 當前 0.02921 | Low Vol (震盪市)
  你的: 0.02803 ~ 0.03054
  BB:   0.02628 ~ 0.03213
💸 Unclaimed $4.6 | IL +$18.2 🟢
⏱ Breakeven 0天 | Compound ✅
────────────────────────────────
```

  - 修改位置：`src/utils/logger.ts` `positionLogger` 的 `format`（改為 `printf` 純文字）
  - 修改位置：`src/services/PositionScanner.ts` `logPositionSnapshots()`（傳入格式化字串而非 JSON 物件）
  - 每個 5 分鐘週期的快照之間加入分隔線，方便區分時間點

### ✅ 階段五-D：Telegram 報告優化（已完成）

- [x] **總覽區塊**：報告最上方新增總倉位 USD、Unclaimed、總獲利 USD+%（`PnlCalculator.calculatePortfolioSummary()`）
- [x] **開倉資訊取代淨APR**：改顯示 `⏳ 開倉 X天X小時 · 獲利 +X.XX%`，邏輯集中於 `PnlCalculator.calculateOpenInfo()`
- [x] **Breakeven 優化**：IL ≥ 0 時顯示「盈利中」取代天數
- [x] **Compound 獨立換行**：`🔄 Compound` 另起一行，不再與 Breakeven 同行
- [x] **價格區間樹狀格式**：`├ 你的` / `└ BB` 改善 CJK 與 ASCII 標籤的對齊問題
- [x] **ILCalculator → PnlCalculator**：重命名並新增 `calculateOpenInfo()`、`calculatePortfolioSummary()`；錢包計數改用 `/^0x[0-9a-fA-F]{40}$/` 正則過濾
- [x] **倉位標頭改版**：移除 APR，改顯示 `倉位 $xxx | 本金 $xxx | 健康 xx/100`；新增 `PnlCalculator.getInitialCapital(tokenId)` static method 讀取 `.env` 設定值
- [x] **組合總覽加入本金**：`PortfolioSummary` 新增 `totalInitialCapital` 欄位，Telegram 總覽區塊顯示合計本金

### 🔴 階段五-E：Aerodrome Unclaimed 顯示 $0.0 修正（待處理）

- [ ] **Aerodrome Gauge 手續費取值失敗**：質押至 Gauge 的倉位 `fetchAerodromeGaugeFees()` 目前回傳 0，`tokensOwed0/1` fallback 對 staked NFT 也為 0（NPM 倉位已清零）
  - 調查方向：Aerodrome Gauge 合約的 `earned()` / `fees()` / `rewardPerToken()` 等函式；或透過 Gauge 合約直接讀取累積手續費
  - 相關檔案：`src/services/PositionScanner.ts` → `fetchAerodromeGaugeFees()`
  - 相關合約：`AERO_GAUGE_ABI`（`src/config/abis.ts`）、Voter `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5`

### 🟡 階段六：計算精度與測試（待處理）

- [x] **INITIAL_INVESTMENT_USD 維護**：已改為 `.env` 編號變數（`INITIAL_INVESTMENT_<tokenId>`）
- [x] **TRACKED_TOKEN_IDS 維護**：已改為 `.env` 編號變數（`TRACKED_TOKEN_<tokenId>=<DEX>`）
- [ ] **重構 PnlCalculator & RiskManager**：與 `@uniswap/v3-sdk` 原生數學對齊
- [ ] **擴充 Jest 測試**：動態 Gas 閾值、零 TVL、極端 Tick、最大波動率等邊界情境

### 🔵 階段七：架構整理（待處理）

- [ ] **整合共用型別**：`PoolStats`、`BBResult`、`PositionRecord`、`RiskAnalysis` 移至 `src/types/index.ts`

### 📄 階段八：部署（待處理）

- [ ] **新增 Dockerfile**：包含 Railway 部署指南

### 🟡 階段九：啟動速度優化（部分待處理）

- [x] **Round-robin RPC**：`nextProvider()` 串行呼叫自動輪換節點，分散負載
- [x] **移除死節點**：`base.meowrpc.com` 返回 308，已從 `RPC_FALLBACKS` 移除
- [x] **State 恢復 positions**：重啟時若 wallet 配置未變，直接從 `state.json` 恢復 tokenId 清單，跳過 `syncFromChain`（省 20-50s）
- [x] **DexScreener 價格快取**：BBEngine 的 WETH/cbBTC 價格快取 2 分鐘，同週期只打一次 API
- [ ] **PoolScanner 平行化**：`scanAllCorePools` 目前 5 個池子串行（~30s），改為 `Promise.all` 平行掃描
  - ⚠️ **注意 GeckoTerminal rate-limit**：`fetchPoolVolume` 用 GeckoTerminal 免費 API，429 很常見
  - 平行化前須確認：`poolVolCache`（30 分鐘 TTL）已命中時不發請求；第一次 cold-start 建議限制並發數（最多 2-3 個同時），或加入 Exponential Backoff + Jitter
  - slot0 RPC 呼叫已有 `nextProvider()` 輪換，平行化安全
  - `fetchPoolStats` 內的 DexScreener 呼叫（不同 URL per pool）可安全平行

