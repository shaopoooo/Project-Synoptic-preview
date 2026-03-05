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
| 震盪市 | 30D 年化波動率 < 40% | `k = 1.8` |
| 趨勢市 | 30D 年化波動率 ≥ 40% | `k = 2.5` |

---

## 5. 倉位監測與錢包掃描（Position Scanner）

- **倉位結構**：$20k 全額投入單池，不設 Buffer 緩衝倉
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

每 5 分鐘或觸發預警時發送：

```
[2026-03-02 17:05] 最高 APR 池: Pancake 0.01% (APR 67.2%)
建議 BB 區間: 0.0298 – 0.0312 cbBTC/WETH
Unclaimed: $12.4 | IL: -$8.7 | Breakeven: 14 天
Compound Signal: ✅ Unclaimed $12.4 > Threshold $7.1
Health Score: 94/100 | Regime: Low Vol
```

---

## 10. 安全性備註

本 Bot 為**純背景監測腳本**，`npm audit` 回報的相依套件漏洞在當前架構下風險為零，原因如下：

- **無 Web Server**：無外部接收 payload 或 cookie 的介面
- **無動態合約編譯**：不使用 `solc` 或 `mocha`，無 RCE 風險
- **無私鑰簽發**：純監測模式，未引入錢包私鑰進行鏈上寫入

> 在純監測階段，可安全忽略 `cookie`、`serialize-javascript`、`elliptic` 等套件的升級警告。

---

## 11. 重構任務清單

### 🔴 高優先（系統安全與穩定性）

- [ ] **狀態持久化**：將 `PriceBuffer`、`volCache` 存入 `data/state.json`（使用 `fs-extra`）
- [ ] **記憶體管理**：將 `PoolScanner.ts` 與 `BBEngine.ts` 中的無上限 `Map` 替換為 `lru-cache`
- [x] **RPC 備援**：`src/utils/rpcProvider.ts` 已實作 `FallbackProvider`（QuickNode → Alchemy → 公共節點）+ `rpcRetry` 重試機制
- [ ] **API 防封鎖**：GeckoTerminal 請求缺少 `User-Agent` Header；已有 retry/backoff 但需補強
- [ ] **動態 Gas Oracle**：`RiskManager.ts:25` 中 `COMPOUND_GAS_COST_USD = 1.5` 為硬編碼，需改為透過 Provider 即時取得 `maxFeePerGas`
- [ ] **輸入清洗**：對外部傳入的 Pool Address 加入 `/^0x[0-9a-fA-F]{40}$/` 正則校驗

### 🟡 中優先（計算精度與測試）

- [ ] **重構 ILCalculator & RiskManager**：與 `@uniswap/v3-sdk` 原生數學對齊
- [ ] **擴充 Jest 測試**：覆蓋動態 Gas 閾值與邊界情境（零 TVL、極端 Tick、最大波動率等）

### 🔵 核心重構

- [x] **拆分 `config/index.ts`**：已完成分離 `env.ts` / `constants.ts` / `abis.ts`，`index.ts` 統一匯出
- [ ] **整合共用型別**：`PoolStats`、`BBResult`、`PositionRecord`、`RiskAnalysis` 等介面分散各檔案，應移至 `src/types/index.ts`
- [ ] **優化 PositionScanner.ts**：`scanPosition()` 內部同時呼叫 `PoolScanner.fetchPoolStats()` 與 `BBEngine.computeDynamicBB()`，在 `updateAllPositions()` 迴圈中造成重複 RPC 呼叫

### 📄 部署與文件

- [x] **README.md**：已建立，完整記錄環境變數、架構與啟動方式
- [ ] **新增 Dockerfile**：包含 Railway 部署指南

---

## 12. 現有程式碼重點摘要（供 Claude Code 快速定位）

### 核心資料流（每 5 分鐘 cron）

```
src/index.ts
  runPoolScanner()      → PoolScanner.scanAllCorePools()
  runPositionScanner()  → PositionScanner.updateAllPositions()
  runBBEngine()         → BBEngine.computeDynamicBB()
  runRiskManager()      → RiskManager.analyzePosition()
  runBotService()       → TelegramBotService.sendFormattedReport()
```

### 已知問題定位

| 問題 | 檔案 | 行號 |
|------|------|------|
| 硬編碼 Gas $1.5 | `src/services/RiskManager.ts` | L25 |
| 無上限 `Map` (volCache) | `src/services/PoolScanner.ts` | L26 |
| 無上限 `Map` (volCache) | `src/services/BBEngine.ts` | L32 |
| 缺少 User-Agent Header | `src/services/PoolScanner.ts` | L56, L88 |
| 缺少 User-Agent Header | `src/services/BBEngine.ts` | L61, L183 |
| 無 Pool Address 輸入校驗 | `src/services/PoolScanner.ts` | `fetchPoolStats()` 入口 |
| `PriceBuffer` 重啟後消失 | `src/services/BBEngine.ts` | L159 |
| 重複 RPC 呼叫 | `src/services/PositionScanner.ts` | `scanPosition()` L196–L199 |