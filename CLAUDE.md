# CLAUDE.md — DexBot V1 多 DEX 策略（小市值版）

> 本文件為 Claude Code CLI 專案規則文件。貼入專案根目錄後，Claude Code 將自動讀取並遵循所有規範。

---

## 1. 專案核心定位

- **資本規模**：$20,000 USD（單池上限 100%）
- **執行模式**：純監測 + 手動執行（Telegram Bot 推播訊號）
- **收益目標**：每月淨利 $250–$500（年化目標 15%–30%）
- **技術選型**：Node.js + TypeScript、`@uniswap/v3-sdk`、`grammyjs`（Telegram）、`ethers.js`

---

## 2. 系統韌性與穩定性【高優先】

### 狀態持久化
- 核心狀態（`PriceBuffer`、`volCache`）必須於重啟後保留
- 使用 `fs-extra` 將狀態儲存至 `data/state.json`
- 每次啟動時優先讀取此檔案進行恢復

### 記憶體管理
- **禁止**使用無上限的原生 `Map` 作為快取
- 所有快取一律改用 `lru-cache`，防止記憶體無限增長

### RPC 備援與防卡死
- 使用 `FallbackProvider`，節點順序：QuickNode → Alchemy → 公共節點
- 所有 RPC 呼叫必須設定**顯式超時**與**重試上限**
- 禁止讓 Base RPC 延遲導致程序無限掛起

### API 防封鎖（GeckoTerminal）
- 所有 Axios 請求必須加上適當的 `Headers` 與 `User-Agent`
- 實作 **Exponential Backoff + Jitter**，防範 HTTP 429 錯誤

### 動態 Gas 預估
- **禁止**硬編碼 Gas 費用（例如 `$1.5`）
- 一律透過 `Provider` 即時取得 `maxFeePerGas`

### 輸入清洗
- 所有外部傳入的 Pool Address 必須經過嚴格的正則表達式校驗
- 格式範例：`/^0x[0-9a-fA-F]{40}$/`
- 不合法輸入應拒絕處理並記錄錯誤，不允許程式崩潰

---

## 3. APR Scanner 模組

- **掃描頻率**：每 5 分鐘
- **目標鏈**：Base Network
- **目的**：鎖定手續費效率最高的流動性池

### 核心監測池地址

| 協議 | 費率 | 合約地址 |
|------|------|----------|
| Pancake V3 | 0.01% | `0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3` |
| Pancake V3 | 0.05% | `0xd974d59e30054cf1abeded0c9947b0d8baf90029` |
| Uniswap V3 | 0.05% | `0x7aea2e8a3843516afa07293a10ac8e49906dabd1` |
| Uniswap V3 | 0.30% | `0x8c7080564b5a792a33ef2fd473fba6364d5495e5` |
| Aerodrome Slipstream | 0.0085% | `0x22aee3699b6a0fed71490c103bd4e5f3309891d5` |

### APR 計算公式

```
24h 手續費 = 24h 交易量 × 費率
APR = (24h 手續費 / TVL) × 365
```

---

## 4. 動態布林通道引擎（BB Engine）

- **均線週期**：20 SMA
- **時間框架**：1 小時
- **Tick 轉換**：使用 `@uniswap/v3-sdk` 的 `TickMath` 搭配 `nearestUsableTick`

### 動態 k 值規則

| 市場狀態 | 條件 | k 值 |
|----------|------|------|
| 震盪市 | 30D 年化波動率 < 50% | `k = 1.2` |
| 趨勢市 | 30D 年化波動率 ≥ 50% | `k = 1.8` |

---

## 5. 倉位監測與錢包掃描（Position Scanner）

- **多錢包支援**：透過 `WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 環境變數設定，支援動態新增
- **Drift 門檻**：實際區間與建議區間重合度 < 80% 時，推播 `STRATEGY_DRIFT_WARNING`
- **RPC 優化**：消除 `PositionScanner.ts` 中多餘的重複 RPC 呼叫，提升效率

---

## 6. 最優複利算法（EOQ Compounding）

### 觸發公式

```
Threshold = sqrt(2 × P × G × Fee_Rate_24h)
```

- `P`：本金
- `G`：即時 Gas 費用（由 Dynamic Gas Oracle 提供，**禁止硬編碼**）
- `Fee_Rate_24h`：24 小時費率

### 訊號邏輯
- 當 `Unclaimed Fees > Threshold` 時，發送 `COMPOUND_SIGNAL`

---

## 7. 風險管理與健康評分【中優先】

### 計算精準度
- `ILCalculator` 與 `RiskManager` 的運算必須與 `@uniswap/v3-sdk` 保持一致
- 必要時全面重構，以 SDK 原生數學為主

### 測試覆蓋（Jest）
- 必須覆蓋動態 Gas 閾值計算
- 必須覆蓋各類邊界情境（極端波動、零 TVL、最大 Tick 等）

### Health Score 公式

```
Health Score = (Fee_Income / IL_Risk_Weight) × 100（上限 100 分）
IL Breakeven Days = 累計 IL（USD）/ (24h 手續費 / 24)
```

### 預警規則

| 條件 | 標記 | 建議行動 |
|------|------|----------|
| IL Breakeven Days > 30 天 | `RED_ALERT` | 建議減倉 |
| Bandwidth > 2× 30D 平均 | `HIGH_VOLATILITY_AVOID` | 建議觀望 |

---

## 8. 代碼架構規範

### 配置管理（`config/`）

```
config/
├── env.ts        # 環境變數（process.env 讀取）
├── constants.ts  # 常數（池地址、費率等）
├── abis.ts       # 合約 ABI
└── index.ts      # 統一匯出入口
```

### 型別管理（`types/`）

- 所有共用 `Interface` 與 `Type` 集中至 `src/types/index.ts`
- 禁止在各模組內定義跨模組使用的型別

### 部署文件要求

- `README.md`：清楚列出所有環境變數及說明
- `Dockerfile`：包含 Railway 部署設定指南

---

## 9. Telegram 推播格式

每 5 分鐘推播單一合併報告，支援 `/sort <key>` 指令切換排序：

```
[2026-03-06 16:10] 倉位監控報告 (2 個倉位 | 排序: 倉位大小 ↓)

─── #1 PancakeSwap 0.01% | APR 29.4% | 0xabc...1234 | #1675918 ───
當前價格: 0.02921 | 你的區間: 0.02803 - 0.03054
建議 BB 區間: 0.02628 - 0.03213
Unclaimed: $4.6 | IL: -$8.7 🔴 | Breakeven: 14 天
Compound: ✅ $4.6 > $0.1 | Health: 94/100 | Low Vol (震盪市)

📊 各池收益排行:
🥇 Aerodrome 0.0085% — APR 67.2% | TVL $1,234K
🥈 PancakeSwap 0.01% — APR 29.4% | TVL $987K ◀ 你的倉位

⏱ 資料更新時間:
- Pool: 16:10 | Position: 16:10
- BB Engine: 16:10 | Risk: 16:10
```

排序指令：`/sort size`、`/sort apr`、`/sort unclaimed`、`/sort health`

---

## 10. 安全性備註

本 Bot 為**純背景監測腳本**，`npm audit` 回報的相依套件漏洞在當前架構下風險為零，原因如下：

- **無 Web Server**：無外部接收 payload 或 cookie 的介面
- **無動態合約編譯**：不使用 `solc` 或 `mocha`，無 RCE 風險
- **無私鑰簽發**：純監測模式，未引入錢包私鑰進行鏈上寫入

> 在純監測階段，可安全忽略 `cookie`、`serialize-javascript`、`elliptic` 等套件的升級警告。

---

## 11. 任務清單

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
- [x] **倉位大小顯示**：Telegram 報告新增 `倉位大小: $xxx` 欄位
- [x] **Aerodrome Subgraph Invalid URL 修正**：`fetchPoolVolume` 加入 `if (!config.SUBGRAPHS[dex])` guard，無 subgraph 時直接跳至 GeckoTerminal
- [x] **Aerodrome NPM fee 欄位語意修正**：Aerodrome `positions()` 第 5 欄回傳 `tickSpacing`（非 fee pips），`getPoolFromTokens` 加入 `'Aerodrome_1'` 對應，`feeTierForStats` 強制設為 `0.000085`
- [x] **BBEngine Aerodrome tickSpacing 修正**：`runBBEngine()` 加入 `feeTier === 0.000085` → `tickSpacing = 1`

### ✅ 階段四：Telegram 報告優化（已完成）

- [x] **合併報告**：廢棄逐位置發送，改為 `sendConsolidatedReport` 單一訊息
- [x] **各池收益排行**：顯示全部池子 APR 由高到低，標記所有有持倉的池子
- [x] **排序指令**：`/sort size|apr|unclaimed|health`，狀態保存於 Bot 實例
- [x] **倉位標頭識別**：顯示錢包尾碼（`0xabc...1234`）與 TokenId
- [x] **手機排版優化**：`formatPositionBlock` 改為每行 ≤ 40 字元，分組顯示
- [x] **淨 APR 顯示**：費用APR + IL年化率（需建倉本金與鏈上 open timestamp）
- [x] **/explain 指令**：發送完整指標計算公式說明
- [x] **建倉時間戳**：`syncFromChain` 自動查詢 NFT mint Transfer 事件，快取於 in-memory

### 🔴 階段五：系統穩定性（待處理）

- [ ] **狀態持久化**：`PriceBuffer`、`volCache`、`openTimestampCache`、Bot 排序偏好 存入 `data/state.json`
- [ ] **記憶體管理**：`PoolScanner.ts` 與 `BBEngine.ts` 無上限 `Map` 改用 `lru-cache`
- [ ] **API 防封鎖**：GeckoTerminal 請求補上 `User-Agent` Header
- [ ] **動態 Gas Oracle**：`RiskManager.ts` `COMPOUND_GAS_COST_USD = 1.5` 改為即時 `maxFeePerGas`
- [ ] **Pool Address 輸入校驗**：`/^0x[0-9a-fA-F]{40}$/` 正則驗證

### 🟡 階段六：計算精度與測試（待處理）

- [x] **INITIAL_INVESTMENT_USD 維護**：已改為 `.env` 編號變數（`INITIAL_INVESTMENT_<tokenId>`）
- [x] **TRACKED_TOKEN_IDS 維護**：已改為 `.env` 編號變數（`TRACKED_TOKEN_<tokenId>=<DEX>`）
- [ ] **重構 ILCalculator & RiskManager**：與 `@uniswap/v3-sdk` 原生數學對齊
- [ ] **擴充 Jest 測試**：動態 Gas 閾值、零 TVL、極端 Tick、最大波動率等邊界情境

### ✅ 階段五-B：Log 系統重構（已完成）

- [x] **logger.ts 強化**：新增 `section()` 分隔線方法、level icon（`·` / `!` / `✖`）、INFO 訊息套用 service 顏色
- [x] **週期分隔線**：每 5 分鐘 cron 加入 `─── 5m cycle ───` / `─── ready ───` 視覺分隔
- [x] **訊息類別 emoji**：`⛓` 鏈上、`🌐` API 請求、`💾` 快取、`📍` 倉位、`✅` 完成、`🔄` 重新觸發
- [x] **去除重複前綴**：移除所有訊息內 `[ServiceName]` 冗餘前綴（tag 已標示）

### 🔵 階段七：架構整理（待處理）

- [ ] **整合共用型別**：`PoolStats`、`BBResult`、`PositionRecord`、`RiskAnalysis` 移至 `src/types/index.ts`

### 📄 階段八：部署（待處理）

- [ ] **新增 Dockerfile**：包含 Railway 部署指南

---

## 12. 現有程式碼重點摘要（供 Claude Code 快速定位）

### 核心資料流（每 5 分鐘 cron）

```
src/index.ts
  runPoolScanner()      → PoolScanner.scanAllCorePools()
  runBBEngine()         → BBEngine.computeDynamicBB()        ← 必須在 PositionScanner 之前
  runPositionScanner()  → PositionScanner.updateAllPositions(latestBBs)
  runRiskManager()      → RiskManager.analyzePosition()
  runBotService()       → TelegramBotService.sendConsolidatedReport()
```

### 環境變數（`.env`）

| 變數 | 說明 |
|------|------|
| `WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... | 監控錢包地址（逐號新增） |
| `RPC_URL` | Base 主 RPC |
| `SUBGRAPH_API_KEY` | The Graph API Key |
| `BOT_TOKEN` | Telegram Bot Token |
| `CHAT_ID` | Telegram Chat ID |

### 待處理問題定位

| 問題 | 檔案 | 位置 |
|------|------|------|
| 硬編碼 Gas $1.5 | `src/services/RiskManager.ts` | L25 |
| 無上限 `Map` (volCache) | `src/services/PoolScanner.ts` | L26 |
| 無上限 `Map` (volCache) | `src/services/BBEngine.ts` | L32 |
| 缺少 User-Agent Header | `src/services/PoolScanner.ts` | `fetchPoolVolume()` |
| 缺少 User-Agent Header | `src/services/BBEngine.ts` | `fetchDailyVol()` |
| 無 Pool Address 輸入校驗 | `src/services/PoolScanner.ts` | `fetchPoolStats()` 入口 |
| `PriceBuffer` 重啟後消失 | `src/services/BBEngine.ts` | `globalPriceBuffer` |