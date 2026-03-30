```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║                       ███╗   ███╗ █████╗  ██████╗ ██╗                       ║
║                       ████╗ ████║██╔══██╗██╔════╝ ██║                       ║
║                       ██╔████╔██║███████║██║  ███╗██║                       ║
║                       ██║╚██╔╝██║██╔══██║██║   ██║██║                       ║
║                       ██║ ╚═╝ ██║██║  ██║╚██████╔╝██║                       ║
║                       ╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝                       ║
║                                                                              ║
║                  MAGI SYSTEM — MULTI-AGENT GENERAL INTELLIGENCE             ║
║                        BASE NETWORK STRATEGIC ADVISORY                      ║
╠══════════════════╦═══════════════════════╦═══════════════════════════════════╣
║  MELCHIOR · 1    ║    BALTHASAR · 2      ║         CASPER · 3               ║
║  [AS SCIENTIST]  ║    [AS MOTHER]        ║         [AS WOMAN]               ║
╠══════════════════╬═══════════════════════╬═══════════════════════════════════╣
║                  ║                       ║                                   ║
║  CLAUDE OPUS     ║   GOOGLE GEMINI       ║   X GROK                         ║
║  Anthropic       ║   DeepMind            ║   xAI                            ║
║                  ║                       ║                                   ║
║  PATTERN:        ║  PATTERN:             ║  PATTERN:                         ║
║  Deep reasoning  ║  Multimodal context   ║  Real-time data                  ║
║  Risk analysis   ║  Broad knowledge      ║  Market sentiment                 ║
║  Code synthesis  ║  Cross-domain ref.    ║  Social signals                  ║
║                  ║                       ║                                   ║
║  VOTE: APPROVED  ║  VOTE: APPROVED       ║  VOTE: APPROVED                  ║
║                  ║                       ║                                   ║
╠══════════════════╩═══════════════════════╩═══════════════════════════════════╣
║                                                                              ║
║              >> MAGI CONSENSUS: EXECUTE DEXBOT MONITORING <<                ║
║                    ALL THREE SYSTEMS ONLINE — STANDBY                       ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

# DexBot — Base Network DEX 流動性監測機器人

純背景監測腳本，透過 Telegram 推播 Uniswap V3 / Uniswap V4 / PancakeSwap V3 / Aerodrome Slipstream 流動性池的 APR、BB 區間建議、IL 風險評估與複利訊號。不執行任何鏈上交易。支援多錢包監測與鎖倉倉位追蹤（Aerodrome Gauge / PancakeSwap MasterChef）。

---

## 環境變數

在專案根目錄建立 `.env` 檔案：

| 變數名稱 | 必填 | 說明 |
|----------|------|------|
| `RPC_URL` | 否 | Base 主網 RPC 端點（預設：`https://mainnet.base.org`） |
| `WALLET_ADDRESS_1` | 否 | 第一個監測錢包地址（啟動種子；後續可透過 `/wallet add` 動態新增） |
| `WALLET_ADDRESS_2` | 否 | 第二個監測錢包地址（可繼續增加 `_3`, `_4`...） |
| `BOT_TOKEN` | 是 | Telegram Bot Token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `CHAT_ID` | 是 | Telegram 接收推播的 Chat ID |
| `FAST_STARTUP` | 否 | 設為 `true` 時跳過啟動時的完整初始掃描（TokenPrice → PoolScanner → PositionScanner → BBEngine → RiskManager），改為 5 秒後直接進入第一輪 cron 週期。適合本地開發快速進入循環，避免每次重啟都要等待 2~3 分鐘的初始掃描；**不建議在生產環境啟用**（第一輪報告前 BB 與風險指標尚未計算完成） |

> `INITIAL_INVESTMENT_<tokenId>` 與 `TRACKED_TOKEN_<tokenId>` 已移除。本金與鎖倉設定改透過 Telegram `/invest` 指令管理，並持久化至 `state.json`。

> 若所有 `WALLET_ADDRESS_N` 均未設定且 `state.json` 無錢包紀錄，則跳過倉位掃描，僅推播池子 APR 排行。

`.env` 範例：

```env
RPC_URL=https://your-quicknode-endpoint.quiknode.pro/your-key/
WALLET_ADDRESS_1=0xYourFirstWalletAddress
WALLET_ADDRESS_2=0xYourSecondWalletAddress
BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
CHAT_ID=-100123456789
```

### 使用 dotenvx 管理環境變數（推薦）

[dotenvx](https://dotenvx.com) 支援加密 `.env`、多環境切換，適合在 CI/CD 或共享環境使用。

```bash
# 安裝（一次性）
npm install -g @dotenvx/dotenvx

# 設定單一變數（自動寫入 .env）
npx dotenvx set BOT_TOKEN 123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
npx dotenvx set CHAT_ID -100123456789

# 設定多個錢包
npx dotenvx set WALLET_ADDRESS_1 0xYourFirstWalletAddress
npx dotenvx set WALLET_ADDRESS_2 0xYourSecondWalletAddress

# 加密 .env（產生 .env.keys，請妥善保管）
npx dotenvx encrypt

# 使用加密 .env 啟動
npx dotenvx run -- npm start
```

> 加密後 `.env` 可安全提交至版本控制，`.env.keys` 請勿提交。

---

## 快速啟動

```bash
# 安裝依賴
npm install

# 正式啟動（每 5 分鐘排程 + Telegram 推播）
npm start

# 乾跑測試（不啟動 Bot，僅印出掃描結果）
npm run dryrun

# 歷史回測
npm run backtest

# 執行單元測試
npm test
```

---

## 專案架構

```
src/
├── index.ts                    # 主進入點：cron 排程協調（薄層，業務邏輯下移至 runners/）
├── dryrun.ts                   # 乾跑測試用（不啟動 Telegram）
├── types/
│   └── index.ts                # 共用型別定義（PositionRecord、MarketSnapshot、RiskAnalysis、OpeningStrategy、CycleData 等）
├── config/
│   ├── env.ts                  # 環境變數讀取（process.env）
│   ├── constants.ts            # 常數（池地址、快取 TTL、BB / EWMA / MC / Kill Switch 參數）
│   ├── abis.ts                 # 合約 ABI（NPM、Pool、V4 PositionManager / StateView）
│   └── index.ts                # 統一匯出入口
├── runners/                    # Phase 0 / Phase 1 Pipeline 協調層
│   ├── prefetch.ts             # Phase 0：所有 I/O 集中（TokenPrice → Pool → BB → Position → Fees → HistoricalReturns）
│   ├── compute.ts              # Phase 1：純計算（aggregate → PnL → Risk → Rebalance），禁止任何 await
│   ├── mcEngine.ts             # Bootstrap MC + CVaR score + 70/30 tranche；commit 後 fire-and-forget
│   ├── reporting.ts            # 快訊 / 完整報告排程輸出 + Kill Switch A 告警
│   └── backgroundTasks.ts      # 低優先背景任務（StakeDiscovery、TimestampFiller）
├── services/
│   ├── dex/                    # DEX 手續費抓取層
│   │   ├── FeeCalculator.ts    # 鏈上 fee growth 數學（V3 / V4 / Aerodrome / PancakeSwap）
│   │   └── FeeFetcher.ts       # 批次抓取所有倉位的未領取費用
│   ├── events/                 # 鏈上事件掃描
│   │   ├── EventLogScanner.ts  # 通用 getLogs 掃描器（ScanHandler 介面）
│   │   └── StakeDiscovery.ts   # ERC-721 Transfer 事件掃描，自動偵測質押倉位
│   ├── market/                 # 市場資料服務
│   │   ├── PoolMarketService.ts  # 動態 BB（SMA + EWMA stdDev）+ PriceBuffer + smaSlope
│   │   ├── PoolScanner.ts        # APR 掃描（DexScreener + GeckoTerminal）
│   │   └── TokenPriceService.ts  # 幣價抓取（WETH / cbBTC / CAKE / AERO）
│   ├── position/               # 倉位讀取與組裝
│   │   ├── NpmContractReader.ts  # 鏈上 NPM / V4 PositionManager 合約讀取
│   │   ├── PositionAggregator.ts # RawChainPosition → PositionRecord（純計算）
│   │   ├── PositionScanner.ts    # 倉位狀態管理（發現、更新、持久化）
│   │   └── TimestampFiller.ts    # 補齊缺少 openTimestampMs 的倉位
│   └── strategy/               # 策略與風險計算（Phase 1 純函式）
│       ├── BollingerBands.ts     # BB 型態判斷（squeeze / expansion / trending / normal）
│       ├── MarketRegimeAnalyzer.ts # CHOP + Hurst + ATR + Percentile 市場狀態分析
│       ├── MonteCarloEngine.ts   # Bootstrap MC（720H × 10,000 paths）+ CVaR₉₅ + 70/30 tranche
│       ├── PnlCalculator.ts      # 絕對 PNL、開倉資訊、組合總覽計算
│       ├── PositionCalculator.ts # /calc 開倉試算（讀取 appState.strategies，依資金量縮放）
│       ├── RiskManager.ts        # Health Score、IL Breakeven、EOQ 複利訊號、drift 警告
│       └── rebalance.ts          # 再平衡建議（純計算，不執行交易）
├── bot/
│   ├── TelegramBot.ts          # Telegram 指令路由 + 推播觸發
│   ├── reportService.ts        # 報告資料協調層（計算 → formatter → 字串輸出）
│   ├── alertService.ts         # Kill Switch A / B + 趨勢告警 + 非對稱撤倉推播
│   └── commands/               # 各 Telegram 指令模組
└── utils/
    ├── logger.ts               # Winston 彩色 logger（console + 檔案輪轉）
    ├── math.ts                 # 基礎數學工具（normalizeAmount、tickToPrice、capitalEfficiency、sub256）
    ├── formatter.ts            # 文字格式化（只接收 raw 數值，不含運算邏輯）
    ├── rpcProvider.ts          # FallbackProvider + rpcRetry + fetchGasCostUSD()
    ├── cache.ts                # LRU 快取實例（historicalReturnsCache）+ snapshot/restore
    ├── stateManager.ts         # 跨重啟狀態持久化（讀寫 data/state.json）
    ├── BandwidthTracker.ts     # 30D 帶寬滾動窗口（update / getAvg / snapshot / restore）
    ├── AppState.ts             # 全域共享狀態單例（pools / positions / marketSnapshots / strategies）
    ├── tokenInfo.ts            # Token 元資料（getTokenDecimals / getTokenSymbol）
    └── validation.ts           # 地址格式驗證（WALLET_ADDRESS_RE / POOL_ADDRESS_RE / POOL_V4_ID_RE）

data/
├── state.json                  # Bot 跨重啟快取（自動生成，首次 cron 週期後建立）
└── historical_weth_cbbtc_1H.json  # 回測用歷史 OHLCV K 棒（手動放入）
```

## 日誌分級與除錯指南 (Logging System)

DexBot 採用了高效且嚴謹的 **6 級日誌系統 (Winston)**，支援完整的物件參數展開 (`winston.format.splat()`) 與精準的 Error Stack Trace 擷取。

日誌輸出至 `logs/`（啟動時自動建立）：
- `combined.log`：全量日常日誌（最大 10MB × 7 份自動輪轉）
- `error.log`：僅紀錄 `fatal` / `error` 級別（最大 5MB × 3 份），包含完整的 Call Stack。
- `positions.log`：倉位快照歷史（唯讀 append-only，最大 10MB × 10 份）。

### 終端機色彩與對齊
每個模組（如 `[Main]`, `[PoolScanner]`, `[MCEngine]`）都有專屬 ANSI 識別色與對齊長度 (14 chars)，搭配專屬 Emoji 標籤，讓日誌流閱讀極度舒適。

### 6 級制定義

| 級別 | 方法 | 標籤 | 觸發情境與除錯價值 |
| :--- | :--- | :--- | :--- |
| **FATAL** | `log.fatal(msg, e)` | `🔥 FATAL` | **毀滅性崩潰**：系統當機、`state.json` 寫入失敗、API 完全斷線且無快取可依靠。若發生於週期內會立刻中斷該次循環。 |
| **ERROR** | `log.error(msg, e)` | `✖  ERROR` | **局部失敗**：單一池子計算失敗、次要 RPC 節點掛調，但系統仍可容錯繼行。 |
| **WARN** | `log.warn(msg, obj)`| `⚠  WARN` | **預期內異常 / 防護**：API Rate Limit (429) 指數退避、BB 趨勢市場跳過計算、Kill Switch 觸發。 |
| **INFO** | `log.info(msg)` | `·  INFO` | **大局生命週期**：`10m cycle` 起訖宣告、池子過濾總結、目前 ETH/BTC 價格快照、Webhook 推播成功。 |
| **DEBUG** | `log.debug(msg)` | `⚙  DEBUG` | **開發除錯 / 軌跡印證**：30D Vol 命中快取、增量歷史行情抓取詳情、MC 分析計算得出的 CHOP / Hurst / σ 數值、Fee 批次獲利明細。 |
| **TRACE** | `log.trace(msg, obj)`| `🔍 TRACE` | **參數傾印**：巨量負載追蹤。例如打印出 `NonfungiblePositionManager` 回傳的完整數十個 BigInt 原始物件，或是 MC 產生的所有 `candidates` 陣列。 |

> **💡 開發者除錯 Tip:** 永遠將 Error 物件作為「第二個參數」傳遞。例如 `log.error('Main loop failed', e)`。切勿使用 ``log.error(`failed: ${e}`)``，因為字串插值會銷毀錯位行號 (Stack Trace)！

### 如何觸發 Debug 或 Trace 模式？

透過設定環境變數 `LOG_LEVEL` 即可動態切換終端機的顯示級別（預設為 `info`，完全不印出雜訊）：

```bash
# 🐛 開啟開發除錯模式 (會印出 BB 推算、API命中快取等資訊)
LOG_LEVEL=debug npm start

# 🔍 開啟極度囉嗦模式 (會印出巨型 Payload、MC 矩陣等，抓蟲專用)
LOG_LEVEL=trace npm start
```

> **註**：無論終端機怎麼設定，`logs/combined.log` 永遠預設至少寫入 `debug` 級別以供事後調閱。若未來在雲端想讓 Log 檔案連 `trace` 都存，啟動時可加上 `FILE_LOG_LEVEL=trace`。

---

## 監測池（Base Network）

| 協議 | 交易對 | 費率 | 合約地址 / Pool ID |
|------|--------|------|-------------------|
| PancakeSwap V3 | WETH/cbBTC | 0.01% | `0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3` |
| PancakeSwap V3 | WETH/cbBTC | 0.05% | `0xd974d59e30054cf1abeded0c9947b0d8baf90029` |
| Uniswap V3 | WETH/cbBTC | 0.05% | `0x7aea2e8a3843516afa07293a10ac8e49906dabd1` |
| Uniswap V3 | WETH/cbBTC | 0.30% | `0x8c7080564b5a792a33ef2fd473fba6364d5495e5` |
| Aerodrome Slipstream | WETH/cbBTC | 0.0085% | `0x22aee3699b6a0fed71490c103bd4e5f3309891d5` |
| Uniswap V4 | ETH/cbBTC | 0.01% | `0x8fe985a6a484e89af85189f7efc20de0183d0c3415bf2a9ceefa5a7d1af879e5` (bytes32 poolId) |

---

## 策略引擎架構

```
╔═══════════════════════════════════════════════════════════════════════╗
║              DexBot — 開倉策略引擎 + 倉位監測架構                        ║
╚═══════════════════════════════════════════════════════════════════════╝

【每輪 Cron 週期】  index.ts → runCycle()

  ┌──────────────────────────────────────────────────────────────────┐
  │  Phase 0 — prefetch.ts（所有 I/O 集中，Phase 1 禁止 await）         │
  │                                                                  │
  │  Phase 0a（並行）                                                 │
  │    TokenPriceService → 取得 ETH / BTC / CAKE / AERO 幣價          │
  │    PoolScanner       → DexScreener TVL + GeckoTerminal OHLCV    │
  │                        計算 APR、farmApr、tvlUSD                  │
  │    PoolMarketService → 動態 BB（SMA + EWMA σ）+ smaSlope          │
  │                        → updateBandwidthAvg() → CycleData       │
  │                                                                  │
  │  Phase 0b（序列+jitter，避免 GeckoTerminal 429）                   │
  │    PositionScanner.fetchAll() → RawChainPosition[]               │
  │    FeeFetcher.fetchAll()      → 批次未領取費用                    │
  │    fetchHistoricalReturns()   → HourlyReturn[] per pool          │
  └──────────────────────────────────────────────────────────────────┘
                              ↓ CycleData
  ┌──────────────────────────────────────────────────────────────────┐
  │  Phase 1 — compute.ts（純計算，無副作用）                           │
  │                                                                  │
  │  PositionAggregator.aggregateAll()  → PositionRecord[]           │
  │    ↓ per position                                                │
  │  PnlCalculator  → ilUSD、profitRate、openedDays                  │
  │  RiskManager    → healthScore、EOQ compoundSignal、driftWarning  │
  │  RebalanceService → wait / dca / withdrawSingleSide 建議         │
  └──────────────────────────────────────────────────────────────────┘
                              ↓ CycleResult
  ┌──────────────────────────────────────────────────────────────────┐
  │  appState.commit()（唯一寫入點）                                   │
  │    pools / marketSnapshots / positions / cycleWarnings            │
  └──────────────────────────────────────────────────────────────────┘
                              ↓ （commit 後 fire-and-forget）
  ┌──────────────────────────────────────────────────────────────────┐
  │  mcEngine.ts → runMCEngine()（per pool）                          │
  │                                                                  │
  │  Track 0：BB 品質驗證                                             │
  │    isFallback / isWarmup → 清除舊策略，跳過                        │
  │                                                                  │
  │  Track 1：市場狀態過濾（MarketRegimeAnalyzer）                     │
  │    CHOP > 55 且 Hurst < 0.52 → 'range'（繼續計算）                │
  │    CHOP < 45 或 Hurst > 0.58 → 'trend'（清除策略 + 趨勢告警）      │
  │    volatility30D > 100%     → 極端波動，No-Go                    │
  │                                                                  │
  │  Track 2+3：ATR 護欄 + Percentile 天花板（computeRangeGuards）     │
  │                                                                  │
  │  Step 1：多 σ 候選評估（calcCandidateRanges）                      │
  │    k × ATR → sigma；Bootstrap MC 10,000 paths                    │
  │    go = CVaR₉₅ > safetyFloor（動態閾值）                          │
  │                                                                  │
  │  Step 2：最優 σ 選擇                                              │
  │    Score = mean / |CVaR₉₅|；選最高分                              │
  │    全部 No-Go → Kill Switch B 告警                                │
  │                                                                  │
  │  Step 3：70/30 分倉計畫（calcTranchePlan）                        │
  │    Core（70%）：最優 σ 對稱區間                                    │
  │    Buffer（30%）：依 smaSlope 決定方向（上升→上方 / 下降→下方）      │
  │                                                                  │
  │  → 寫入 appState.strategies[poolAddress]                         │
  └──────────────────────────────────────────────────────────────────┘
                              ↓
  ┌──────────────────────────────────────────────────────────────────┐
  │  reporting.ts → runBotService()                                   │
  │                                                                  │
  │  Kill Switch A：bandwidth > avg30D × 2.5 → 帶寬告警（4h cooldown）│
  │  快訊（預設 60min）/ 完整報告（預設 1440min）                        │
  │  /calc：讀取 appState.strategies，依使用者資金縮放分倉金額           │
  └──────────────────────────────────────────────────────────────────┘

【背景任務】  backgroundTasks.ts（主週期完成後觸發）
  StakeDiscovery.scan() → ERC-721 Transfer 事件，偵測新質押倉位
  TimestampFiller.fill() → 補齊缺少 openTimestampMs 的倉位
```

### 資料流說明

1. **PoolScanner**：從 DexScreener 取得 TVL；GeckoTerminal 取得成交量；計算各池 APR（含 PancakeSwap Farm APR、Aerodrome 鏈上 TVL 修正）
2. **PoolMarketService**：計算 20 SMA + EWMA stdDev（α=0.3, β=0.7）+ bbPattern（squeeze/expansion/trending/normal）；維護 in-memory PriceBuffer；Phase 0 計算 bandwidth 並更新 BandwidthTracker（Phase 1 只讀不寫）
3. **MonteCarloEngine**：Bootstrap 歷史對數報酬（720H）× 10,000 條路徑；計算各 ATR-based sigma 候選的 CVaR₉₅ 與 mean PnL ratio；以 CVaR-adjusted Score（mean/|CVaR₉₅|）選出最佳 sigma；輸出 70/30 分倉計畫
4. **MarketRegimeAnalyzer**：CHOP 指數（14根K線震盪強度）+ Hurst 指數（R/S 分析均值回歸）雙重過濾，趨勢市場直接跳過 MC 計算
5. **PositionScanner**：掃描多錢包 LP NFT；StakeDiscovery 自動偵測質押倉位；追蹤第三幣獎勵（CAKE / AERO）；NFT 已 burn 時自動標記 `closed=true`
6. **RiskManager**：Health Score、IL Breakeven Days、動態 EOQ Compound Threshold、drift 警告
7. **TelegramBot**：合併推播；支援 `/sort` 排序、`/calc` 開倉試算

---

## Telegram 推播格式

### 快訊（預設每 60 分鐘）

```
📡 [14:30] 快訊
💱 ETH $2,150 · BTC $70,273 · CAKE $1.370 · AERO $0.320
💼 總倉位 $20,200 · 未領取 $6.72
💰 獲利 +$276.82 (+1.38%) 🟢
🪙 持倉 20200U
   0.823 WETH(1770U) · 0.0₃412 cbBTC(2905U)
   3208 USDC(3208U) · 1240 AERO(397U)
📈 本週期手續費 +$1.23 (vs 13:30)
✅ #1675918 可複利 $4.62
⚠️ #56328282 DRIFT 重疊 71.3%
```

### 完整報告（預設每 1440 分鐘）

所有倉位依選定排序鍵由大到小排列：

```
[2026-03-22 14:30] 倉位監控報告 (2 個倉位 | 排序: 倉位大小 ↓)

📊 總覽  2 倉位 · 2 錢包
💼 總倉位 $20,200  ·  本金 $18,000  ·  未領取 $6.72
💱 ETH $2,150 · BTC $70,273 · CAKE $1.370 · AERO $0.320
💰 總獲利 +$276.8 (+1.38%) 🟢
📅 差異 倉位 +$12.5 · 未領取 +$0.30 · 獲利 +$8.2

━━ #1 PancakeSwap 0.01% ━━
👛 0xaBcD...1234 · #1675918
⏳ 開倉 4天3小時
💹 當前 0.02921 · Low Vol
 ├ 你的 0.02803 ~ 0.03054
 └ 建議 0.02628 ~ 0.03213
💼 倉位 $12,400 · 本金 $10,000 · 健康 94/100
📈 區間 APR 335.8% (效率 5.0×)
⌛ 收支 盈利中 · 獲利 +1.82%
📅 差異 倉位 +$12.5 · 未領取 +$0.30 · 獲利 +$8.2
💸 損益 +$18.2 🟢 · 無常損失 -$13.0 🔴
🪙 持倉 0.0₃2719 WETH · 0.0₅774 cbBTC
🔄 未領取 $4.62 ✅ > $0.1
     0.0₃2719 WETH ($0.56)
     0.0₅774 cbBTC ($0.54)

━━ #2 Aerodrome 0.0085% ━━
👛 0xdEfA...5678 · #56328282 🔒
⏳ 開倉 1天0小時
💹 當前 0.02905 · High Vol
 ├ 你的 0.02700 ~ 0.03100
 └ 建議 0.02550 ~ 0.03300
💼 倉位 $7,800 · 本金 $8,000 · 健康 61/100
⌛ 收支 22天
💸 損益 -$95.0 🔴
🪙 持倉 0.1513 WETH · 0.0₂581 cbBTC
🔄 未領取 $2.10 ❌ < $5.8
⚠️ DRIFT 重疊 71.3% · 💡 縮窄區間 (Gas $0.80)

📊 各池收益排行:
🥇 PancakeSwap 0.01% — APR 15.43%(手續費7.45%+農場7.98%) → 區間 77.2% · TVL $7,612K ◀ 你的倉位
🥈 Aerodrome 0.0085% — APR 29.4% → 區間 147.0% · TVL $987K ◀ 你的倉位
🥉 Uniswap 0.05% — APR 18.6% → 區間 93.0% · TVL $543K

⌛ 資料更新時間:
- Pool: 14:25 · Position: 14:28
- BB Engine: 14:20 · Risk: 14:28
📐 BB k: low=1.8  high=2.5
```

**選用欄位（有條件才顯示）：**
- `📅  差異`：第二次以後的完整報告才出現，顯示 vs 上次完整報告的變化量（總覽一行 + 每倉位一行）
- `⏳ 開倉`：需有建倉時間戳；`· 獲利 +X.XX%` 需設定本金
- `🔒`：倉位 NFT 已質押至 Gauge / MasterChef（`isStaked = true`）
- `無常損失`：在 `💸 損益` 同行，僅當初始本金已設時顯示
- `🪙 持倉`：LP 倉位中實際持有的 token0 / token1 數量，使用下標零緊湊格式
- `🔄` 逐幣明細：各幣種金額 > 0 時顯示
- `📈 區間 APR`：有 BB 且非 fallback 時顯示；`inRangeApr = poolApr × 資金效率乘數`
- `⚠️ RED_ALERT`：累計 IL 為負且 Breakeven Days > 30 天（盈利中不觸發）
- `⚠️ HIGH_VOLATILITY_AVOID`：當前頻寬 > 2× 30D 平均頻寬
- `⚠️ DRIFT`：BB 重疊度 < 80%，附再平衡策略名稱與 Gas 估算
- `💡 移倉回本 N 天`：池排行中，若切換到更高 APR 池的回本天數 ≤ 30 天才顯示

### Telegram 指令

| 指令 | 說明 |
|------|------|
| `/help` | 列出所有指令與用法 |
| `/start` | 啟動 Bot，確認連線正常 |
| `/sort <key>` | 倉位排序：`size`（預設）/ `apr` / `unclaimed` / `health` |
| `/sort` | 查看目前排序及所有選項 |
| `/interval <分鐘>` | 設定掃描間隔（10/20/30/60/120/180/240/360/480/720/1440） |
| `/interval` | 查看可用間隔選項 |
| `/report` | 查看目前快訊 / 完整報告排程設定 |
| `/report flash <分鐘>` | 設定快訊推播間隔（須 ≥ 掃描間隔，且為 10 倍數，預設 60） |
| `/report full <分鐘>` | 設定完整報告間隔（須 ≥ 快訊間隔，且為 10 倍數，預設 1440） |
| `/bbk` | 查看目前 BB k 值（low / high） |
| `/bbk <low> <high>` | 調整 BB 帶寬乘數，下個週期生效並持久化（例：`/bbk 1.8 2.5`） |
| `/compact` | 切換簡化訊息模式（toggle）：開啟時完整報告每倉位僅顯示 2 行核心數據 |
| `/config` | 顯示所有當前設定值（排程、排序、BB k 值、錢包清單） |
| `/explain` | 顯示所有指標的計算公式說明（含 BB k 值、再平衡策略） |
| `/wallet` | 列出所有已監測錢包 |
| `/wallet add <address>` | 新增監測錢包 |
| `/wallet rm <address>` | 移除監測錢包（同時刪除該錢包的所有倉位設定） |
| `/invest` | 列出所有倉位的本金與鎖倉設定 |
| `/invest <addr> <tokenId> <amount>` | 設定本金（USD）；amount=0 清除本金 |
| `/invest <addr> <tokenId> <amount> <dex>` | 設定本金並標記為鎖倉（`tracked=true`），dex 值：`UniswapV3` / `UniswapV4` / `PancakeSwapV3` / `PancakeSwapV2` / `Aerodrome` |
| `/untrack <tokenId>` | 取消鎖倉標記（`tracked=false`），保留本金設定 |
| `/unstake <tokenId>` | NFT 已從 Gauge/MasterChef 取回錢包後，清除 `externalStake` 標記並恢復正常掃描；若 NFT 仍在合約中會拒絕操作；若 NFT 已被 burn 或 `liquidity=0` 則自動標記為已關閉 |

---

## RPC 備援機制

`src/utils/rpcProvider.ts` 使用 `ethers.FallbackProvider`，節點優先順序：

1. `RPC_URL`（環境變數，主節點）
2. `https://base-rpc.publicnode.com`
3. `https://1rpc.io/base`

所有 RPC 呼叫透過 `rpcRetry()` 包裝，支援自動重試（最多 3 次，線性退避）。除 rate-limit（429）外，亦對 `SERVER_ERROR`（502/503 公共節點瞬斷）進行重試。

同模組亦提供 `fetchGasCostUSD()`：即時取得 `maxFeePerGas × 300k gas × ETH_USD`，結果快取 5 分鐘，失敗時 fallback $1.5。

---

## 狀態持久化

Bot 每次 5 分鐘 cron 週期結束後，將以下資料序列化至 `data/state.json`（首次執行後自動建立，無需手動設定）。

### JSON 結構示意

```json
{
  "volCacheBB":   { "0xpool...": { "vol30D": 0.52, "expiresAt": 1700000000000 } },
  "volCachePool": { "0xpool...": { "daily": 123456, "avg7d": 100000, "source": "GeckoTerminal", "expiresAt": 1700000000000 } },
  "priceBuffer":  { "0xpool...": { "1700000000": 0.02921, "1700003600": 0.02935 } },
  "bandwidthWindows": { "0xpool...": [0.00123, 0.00145, 0.00132] },
  "sortBy": "size",
  "intervalMinutes": 10,
  "bbKLowVol": 1.8,
  "bbKHighVol": 2.5,
  "closedTokenIds": ["1675918"],
  "userConfig": {
    "wallets": [
      {
        "address": "0xYourWallet...",
        "dex": [
          {
            "tokenId": "123456",
            "dexType": "PancakeSwapV3",
            "initial": 1000.0,
            "tracked": false,
            "openTimestamp": 1699000000000
          },
          {
            "tokenId": "789012",
            "dexType": "Aerodrome",
            "initial": 500.0,
            "tracked": true,
            "openTimestamp": 1700000000000
          }
        ]
      }
    ]
  }
}
```

### 各欄位 TTL 與來源

| 欄位 | TTL | 寫入時機 | 負責模組 |
|------|-----|----------|----------|
| `volCacheBB` | 6 小時 | BBEngine 每次計算後 | `BBEngine.ts` |
| `volCachePool` | 30 分鐘 | PoolScanner 每次計算後 | `PoolScanner.ts` |
| `priceBuffer` | 永久（滾動保留最近 24 筆） | 每次 tick 更新時 | `BBEngine.ts` |
| `bandwidthWindows` | 永久（滾動保留最近 8640 筆） | 每次 5 分鐘週期 | `BandwidthTracker.ts` |
| `sortBy` | 永久 | `/sort` 指令觸發時 | `TelegramBot.ts` |
| `intervalMinutes` | 永久 | `/interval` 指令觸發時 | `TelegramBot.ts` |
| `flashIntervalMinutes` | 永久 | `/report flash` 指令觸發時 | `TelegramBot.ts` |
| `fullReportIntervalMinutes` | 永久 | `/report full` 指令觸發時 | `TelegramBot.ts` |
| `bbKLowVol` / `bbKHighVol` | 永久 | `/bbk` 指令觸發時 | `TelegramBot.ts` |
| `closedTokenIds` | 永久 | 偵測到 `liquidity=0` 時自動加入 | `PositionScanner.ts` |
| `userConfig` | 永久 | `/wallet`、`/invest`、`/untrack` 指令觸發時；倉位發現時自動寫入 tokenId + openTimestamp | `TelegramBot.ts` / `PositionScanner.ts` |

### 啟動恢復決策流程

```
啟動
  └── loadState()
        ├── state.json 不存在 ──→ 全新啟動，執行 syncFromChain()
        └── 存在
              ├── 恢復 volCacheBB / volCachePool（LRU cache，過期項自動跳過）
              ├── 恢復 priceBuffer（BBEngine 直接使用，無需重新累積）
              ├── 恢復 userConfig（錢包清單、本金設定、鎖倉設定、開倉時間戳）
              ├── 恢復 sortBy（Telegram 排序偏好）
              └── 判斷是否跳過 syncFromChain：
                    條件：walletsUnchanged AND userConfig.wallets[].dex.length > 0
                    ├── 全部成立 ──→ restoreDiscoveredPositions()（秒級恢復）
                    └── 任一否   ──→ syncFromChain()（完整掃描，20–50s）
```

### 首次 vs 重啟行為對照

| 情境 | 執行 syncFromChain | 啟動耗時 |
|------|--------------------|----------|
| 首次啟動（無 state.json） | 是 | ~20–50s |
| 重啟（wallet 配置相同） | **否** | <1s |
| 重啟（新增 / 移除錢包） | 是 | ~20–50s |
| state.json 損毀或讀取失敗 | 是 | ~20–50s |

---

## 資料來源優先順序

**成交量 / APR**
1. GeckoTerminal OHLCV Day（最多 3 次重試，指數退避；DexScreener h24 常漏算 CL pool 成交量，僅作最終備援）
2. DexScreener h24（GeckoTerminal 無資料時使用）
3. 過期快取（stale cache）
4. 零值

> APR 公式：`(avgDailyVol × feeTier / TVL) × 365`；`avgDailyVol = (gecko24h + gecko7dAvg) / 2`（兩者皆有時）。PancakeSwap V3 另計算 CAKE 排放 APR（MasterChef V3 `getLatestPeriodInfo`）並疊加顯示。

**BB 波動率**
1. GeckoTerminal OHLCV Day（30 天）
2. 預設 50% 年化波動率

**BB 小時價格**
1. In-memory `PriceBuffer`（每次掃描以 `Math.pow(1.0001, tick)` tick-ratio 更新）
2. 冷啟動時若資料 < 5 筆，返回 fallback BB（±1000 ticks），標記「資料累積中」

---

## 外部 API 評估紀錄

### CoinMarketCap DEX API（2026-03 研究）

評估是否能取代 GeckoTerminal + DexScreener，結論：**不建議替換，現況已是最優組合**。

| 需求 | GeckoTerminal（現用） | DexScreener（現用） | CMC DEX API |
|------|----------------------|---------------------|-------------|
| Pool OHLCV（daily, 30d） | ✅ 免費，已驗證 | ❌ 無 | ⚠️ 有端點但 response schema 未驗證 |
| Pool TVL | ✅ `reserve_in_usd` 明確 | ✅ `liquidity.usd` | ⚠️ 有 `liquidity` 欄位，是否等於 TVL 未確認 |
| 24h Pool Volume | ✅ 主要來源 | ✅ fallback | ⚠️ 可能有，欄位名稱未確認 |
| Token Price（WETH/cbBTC/CAKE/AERO） | ❌ 無 | ✅ `/tokens/{addr}` | ✅ `/v2/quotes/latest`，功能最成熟 |
| Base network 支援 | ✅ | ✅ | ✅ DEXScan 已收錄 Base |
| CL Pool 成交量準確性 | ✅ 主因選用 | ⚠️ 常漏算 | ❓ 未知 |
| 免費額度 | 30 req/min，無上限 | 慷慨免費 | 10,000 credits/月（嚴格限制） |

**關鍵問題：**
- **TVL 不確定**：CMC 的 `liquidity` 欄位語意不明，可能是市場深度而非鎖倉 TVL，直接影響 APR 計算公式 `APR = vol × feeTier / TVL × 365`
- **費用**：免費層 10,000 credits/月遠不足，以目前掃描頻率估計需 Startup 方案（$79/月）；GeckoTerminal 免費無上限
- **CL Pool 成交量**：是否有 DexScreener 同樣的漏算問題未知，這正是選用 GeckoTerminal 為主要來源的原因

**替代路線**：若未來 GeckoTerminal 開始限速或收費，優先考慮 CoinGecko 付費 API（同一家公司，端點格式相同，只是提高 rate limit），而非改用 CMC。

---

## 數學公式參考

本節列出系統中所有核心公式，按計算層次排列。

---

### 基礎工具 (`utils/math.ts`)

| 公式 | 計算式 | 使用時機 |
|------|--------|---------|
| 代幣金額標準化 | `amount = raw / 10^decimals` | 合約 BigInt → JS number |
| Tick → 價格比率 | `ratio = 1.0001^tick` | 所有 tick-to-price 轉換 |
| Tick → 顯示價格 | `price = 1.0001^tick × 10^(dec0−dec1)` | UI 顯示、跨代幣計算 |
| 資本效率倍數 | `CE = 1 / (√(upper/sma) − √(lower/sma))` | 集中流動性槓桿效應 |
| uint256 環繞減法 | `sub256(a,b) = ((a−b) % U256 + U256) % U256` | Solidity `feeGrowth` 環繞計算 |

---

### 鏈上費用計算 (`services/dex/FeeCalculator.ts`)

**Uniswap V3 / Aerodrome 未領取費用（V3 fee growth 數學）：**

```
# 下邊界 (currentTick >= tickLower 時)
below0 = ticks[tickLower].feeGrowthOutside0X128
         else: sub256(fgglobal0, ticks[tickLower].feeGrowthOutside0X128)

# 上邊界 (currentTick < tickUpper 時)
above0 = ticks[tickUpper].feeGrowthOutside0X128
         else: sub256(fgglobal0, ticks[tickUpper].feeGrowthOutside0X128)

# 區間內累積費用
inside0 = sub256(sub256(fgglobal0, below0), above0)

# 未領取數量（含已到帳 tokensOwed）
pending0 = liquidity × sub256(inside0, feeGrowthInside0LastX128) / Q128
fees0    = pending0 + tokensOwed0
```

**Uniswap V4**（`feeGrowthInside` 由 StateView 直接提供，簡化版）：

```
fees0 = liquidity × sub256(curFg0, lastFg0) / Q128
```

**第三方獎勵：**
- Aerodrome：`aeroUSD = gauge.earned(wallet, tokenId) × aeroPrice`
- PancakeSwap：`cakeUSD = masterchef.pendingCake(tokenId) × cakePrice`

---

### 市場行情 (`services/market/PoolMarketService.ts`)

| 公式 | 計算式 | 使用時機 |
|------|--------|---------|
| Log 報酬率 | `r[i] = ln(close[i] / close[i−1])` | OHLCV → MC 輸入 |
| 30D 年化波動率 | `vol = √(Var(r)) × √365` | BB 初始化 |
| 1H 標準差（暖機期） | `σ₁H = sma × vol30D / √8760` | PriceBuffer < MIN_CANDLES 時 |
| 1H 標準差（EWMA） | `s[i] = α × p[i] + β × s[i−1]`，`σ₁H = √Var(s)` | 正常運行期（α=0.3, β=0.7） |
| SMA 斜率 | `slope = (avg(last5) − avg(prev5)) / avg(prev5)` | 趨勢方向判斷、buffer 方向選擇 |
| BB 邊界 | `upper = min(sma + maxOffset, sma + k×σ₁H)` | 建倉區間計算（maxOffset = sma×10%） |
| Tick 反推 | `tick = round(ln(price) / ln(1.0001))` | BB 邊界 → tick |
| 帶寬 | `bandwidth = (upper − lower) / sma` | Kill Switch A 判斷 |
| 偏度 | `skew = E[(r−μ)³] / σ³` | 歷史報酬率統計摘要 |
| 超額峰度 | `kurt = E[(r−μ)⁴] / σ⁴ − 3` | 歷史報酬率統計摘要 |

**APR 公式：**
```
avgDailyVol = (gecko24h + gecko7dAvg) / 2
APR = avgDailyVol × feeTier / TVL × 365
```

---

### 布林帶型態 (`services/strategy/BollingerBands.ts`)

```
bandwidth = (upper − lower) / sma

squeeze  : bandwidth < avg30D × BB_SQUEEZE_THRESHOLD    → 低波動壓縮
expansion: bandwidth > avg30D × BB_EXPANSION_THRESHOLD  → 高波動擴張
trending : expansion 且 |price−sma| > halfBand × threshold → 趨勢市場
normal   : 其他
```

使用時機：`PoolMarketService.computeDynamicBB` 輸出 `bbPattern` 欄位。

---

### 市場狀態分析 (`services/strategy/MarketRegimeAnalyzer.ts`)

**CHOP 指數（14根1H K線）：**
```
atrSum     = Σ(high_i − low_i)   # i ∈ 最近 n 根
totalRange = max(high) − min(low)
CHOP       = 100 × log10(atrSum / totalRange) / log10(n)

> 55 = 偏震盪（LP 友善）
< 45 = 偏趨勢（LP 風險高）
```

**Hurst 指數（R/S 分析，maxLag=20）：**
```
for lag = 4..20:
  for each chunk (size=lag):
    cumDev[i] = Σ(r[j] − mean)
    R/S = (max(cumDev) − min(cumDev)) / std(chunk)
  points.push({ x: ln(lag), y: ln(avg(R/S)) })
H = OLS 線性回歸斜率（clamp [0,1]）

H > 0.58 = 趨勢延續
H < 0.52 = 均值回歸（LP 友善）
```

**市場狀態判斷：**
```
range  : CHOP > 55 且 Hurst < 0.52  → 雙重確認震盪，MC 繼續計算
trend  : CHOP < 45 或 Hurst > 0.58  → 任一觸發，清除策略 + 趨勢告警
neutral: 其他
```

**ATR 護欄（Track 2）：**
```
ATR(14) = Σ(high_i − low_i) / 14   # 作為開倉區間的最小半寬
```

**Percentile 天花板（Track 3）：**
```
p5  = sorted_closes[n × 5%]
p95 = sorted_closes[n × 95%]        # 區間不得超出歷史 90% 分佈
```

---

### Monte Carlo 引擎 (`services/strategy/MonteCarloEngine.ts`)

**ATR → σ 換算（mcEngine.ts）：**
```
k_candidates = [1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.0]
sigma = k × atrHalfWidth / stdDev1H
```

**區間建構：**
```
maxOffset  = sma × BB_MAX_OFFSET_PCT
lowerPrice = max(sma − maxOffset, sma − sigma × stdDev1H)
upperPrice = min(sma + maxOffset, sma + sigma × stdDev1H)
```

**Bootstrap 單路徑（有放回抽樣）：**
```
P[t] = P[t−1] × exp(r_sampled)   # 每小時從歷史報酬率池抽樣
if P[t] ∈ [lower, upper]: fees += hourlyFeesBase
PnL_ratio = (fees + V_LP(P_T)) / capital − 1
```

**完整 MC 統計（10,000 條路徑）：**
```
mean   = Σ pnlRatio / n
CVaR95 = avg(最差 5% 路徑)

safetyFloor    = max(expectedFeesRatio, 1e−6)
cvarThreshold  = −(safetyFloor × CVAR_SAFETY_FACTOR)
go             = CVaR95 > cvarThreshold
```

**最優 σ 選擇：**
```
Score = mean / |CVaR₉₅|    # CVaR-adjusted 風險報酬比
best  = argmax(Score)
```

**70/30 分倉計畫：**
```
Core（70%）：  [sma − σ_core × σ₁H,  sma + σ_core × σ₁H]
Buffer（30%）：方向由 smaSlope 決定
  smaSlope ≥ 0（上升/橫盤）→ buffer 在 core 上方
    [sma + σ_near × σ₁H,  sma + σ_far × σ₁H]
  smaSlope < 0（下降）→ buffer 在 core 下方
    [sma − σ_far × σ₁H,   sma − σ_near × σ₁H]

CVaR95_combined = cvar_core × 0.70 + cvar_buffer × 0.30
```

**資本效率加速 APR：**
```
CE              = 1 / (√(upper/sma) − √(lower/sma))
dailyFeesToken0 = capital × (totalApr / 365) × CE
```

---

### 風險管理 (`services/strategy/RiskManager.ts`)

**倉位重疊度（Drift）：**
```
overlapLower = max(posLower, bbLower)
overlapUpper = min(posUpper, bbUpper)
overlapPct   = (overlapUpper − overlapLower) / (posUpper − posLower) × 100
driftWarning = overlapPct < 80%
```

**EOQ 複利門檻：**
```
threshold     = √(2 × positionValueUSD × gasCostUSD)
compoundSignal = unclaimedFees > threshold
```

**IL 回本天數：**
```
breakevenDays = |cumulativeIL| / dailyFeesUSD
redAlert      = cumulativeIL < 0 且 breakevenDays > 30
```

**健康分數（0–100）：**
```
netReturn   = unclaimedFees + cumulativeIL
roi         = netReturn / capital
healthScore = clamp(50 + roi × 1000, 0, 100)
# 50分 = 盈虧平衡；100分 = ROI ≥ +5%；0分 = ROI ≤ −5%
```

---

### 再平衡 (`services/strategy/rebalance.ts`)

**V3 代幣比例（決定 DCA 補入量）：**
```
sqrtP   = √currentPrice
sqrtP_L = √lowerPrice
sqrtP_U = √upperPrice

Amount0_virtual = (sqrtP_U − sqrtP) / (sqrtP × sqrtP_U)
Amount1_virtual = sqrtP − sqrtP_L
token0Weight    = Amount0_virtual × currentPrice / totalValue
token1Weight    = Amount1_virtual / totalValue
```

**漂移百分比：**
```
price > bbUpper: drift = (price − bbUpper) / bbUpper × 100
price < bbLower: drift = (bbLower − price) / bbLower × 100 × (−1)
|drift| < REBALANCE_DRIFT_MIN_PCT → return null（不建議操作）
```

**SD 動態偏移（withdrawSingleSide 區間中心調整）：**
```
sdAdj    = (bbUpper − bbMid) / k
sdOffset = REBALANCE_SD_OFFSET_RATIO × sdAdj × sign(price − bbMid)
```

---

### P&L 計算 (`services/strategy/PnlCalculator.ts`)

| 公式 | 計算式 | 使用時機 |
|------|--------|---------|
| 絕對 PnL | `PnL = (positionValueUSD + totalFees) − initialCapital` | 倉位損益追蹤 |
| 利潤率 | `profitRate = PnL / initialCapital × 100` | 個別倉位百分比 |
| 組合 PnL% | `totalPnLPct = ΣPnL / ΣinitialCapital × 100` | 整體投資組合績效 |

---

### 快速索引：公式 → 使用場景

| 場景 | 使用公式 |
|------|---------|
| **開倉決策** | CHOP + Hurst → 市場過濾；ATR × k → σ 候選；CVaR₉₅ 評分 → 最優 σ；`calcTranchePlan` → Core/Buffer 區間 |
| **持倉監控** | IL 回本天數 → redAlert；EOQ 門檻 → compoundSignal；重疊度 → driftWarning；健康分數 → UI |
| **市場告警** | bandwidth > avg30D × 2.5 → Kill Switch A；CVaR 全 No-Go → Kill Switch B；trend signal → 趨勢告警 |
| **再平衡** | driftPercent → 策略選擇；V3 代幣比例 → DCA 補入量 |
| **鏈上讀取** | feeGrowth 環繞減法 → 未領取費用；gauge.earned / pendingCake → 第三方獎勵 |

---

## 動態布林通道（BBEngine）

| 市場狀態 | 條件 | 預設 k 值 |
|----------|------|-----------|
| 低波動（震盪市） | 30D 年化波動率 < 50% | `k = 1.5`（`BB_K_LOW_VOL`） |
| 高波動（趨勢市） | 30D 年化波動率 ≥ 50% | `k = 2.0`（`BB_K_HIGH_VOL`） |

k 值可透過 Telegram `/bbk <low> <high>` 指令即時調整，重啟後從 `state.json` 恢復。

價格區間上限為 SMA ±10%（`maxOffset = sma * 0.10`）。stdDev 在資料 ≥ 5 筆時使用 EWMA（α=0.3, β=0.7）平滑計算；不足時由 30D 年化波動率換算 1H stdDev（`sma × vol / √8760`）。

BBEngine 同時輸出 `bandwidth`（`(upper-lower)/sma`）與 `bbPattern`（`squeeze` / `expansion` / `trending` / `normal`），供 MonteCarloEngine 的 Kill Switch 狀態機使用：bandwidth 突增超過 avg30D × 1.5 時，自動清除 MC 結果快取並強制重算。

---

## IL 計算設定

本系統採用兩種計算模式：

**倉位監測（絕對美元盈虧）**
```
PNL = (LP 倉位現值 + 累計已領/未領手續費) - 初始投入本金（USD）
```

**蒙地卡羅模擬（純 ETH 比率形式，Interpretation B）**
```
PnL_ratio = (fees_token0 + V_LP_token0(P_T)) / capital - 1
```
以「純持有 ETH」為基準線（HODL 比率 = 1），計算開倉是否能積累比單純持幣更多的 ETH。不受幣價漲跌影響，反映流動性供給的純粹 alpha。

透過 Telegram `/invest` 指令設定各倉位建倉本金（用於 USD PNL 顯示）：

```
/invest 0xYourWallet 123456 1000      # 設定 tokenId 123456 本金 $1000
/invest 0xYourWallet 789012 500       # 設定 tokenId 789012 本金 $500
/invest 0xYourWallet 123456 0         # 清除本金設定
```

設定會即時持久化至 `state.json`，重啟後自動恢復。未設定的 Token ID 不顯示獲利率與開倉資訊，ilUSD 為 null，不計入組合總獲利。

---

## 鎖倉倉位追蹤（Aerodrome Gauge）

倉位質押至 Gauge / MasterChef 後，NFT 轉移至合約，`balanceOf(wallet) = 0`，無法透過正常掃描找到。
透過 Telegram `/invest` 指令新增 DEX 參數即可標記為鎖倉追蹤：

```
/invest 0xYourWallet 789012 500 Aerodrome      # 設定本金 + Aerodrome Gauge 鎖倉
/invest 0xYourWallet 111111 0 PancakeSwapV3    # 只追蹤（不設本金）PancakeSwap MasterChef 鎖倉
/untrack 789012                                 # 取消鎖倉追蹤
```

支援 DEX 值：`UniswapV3` / `UniswapV4` / `PancakeSwapV3` / `PancakeSwapV2` / `Aerodrome`。

系統會在錢包掃描完成後，額外從鏈上讀取標記為 `tracked=true` 的 Token ID 並加入監測清單。
開倉時間戳透過 `ChainEventScanner`（`OpenTimestampHandler`）批次查詢 NFT `Transfer(from=0x0)` 事件。同一 NPM 合約的所有 tokenId 合併成單次 `getLogs`（`topics[3]` OR filter），支援分塊掃描（2000 blocks/chunk）與連續失敗中止（3 次），大幅減少 RPC 呼叫次數。結果持久化至 `state.json` 的 `userConfig` 欄位。

---

## EOQ 複利訊號

```
Threshold = √(2 × positionValueUSD × gasCostUSD)
當 unclaimedFeesUSD > Threshold 時，發送 COMPOUND_SIGNAL
```

公式來源：EOQ（Economic Order Quantity）模型，平衡「複利頻率增加的收益」與「每次複利的固定 Gas 成本」。

Gas 費用由 `fetchGasCostUSD()` 即時取得（`maxFeePerGas × 300k gas × ETH_USD`），5 分鐘快取，失敗時 fallback `$1.5`。

---

## Docker / Railway 部署

`.env` 不進 repo 也不進 image：

| 環境 | .env 來源 | 說明 |
|------|-----------|------|
| 本地 docker-compose | bind mount `.env` 進容器 | dotenvx 搭配 `DOTENV_PRIVATE_KEY` 解密 |
| Railway | Dashboard 直接填明文 | Railway 自身加密儲存，無需 dotenvx |

### 本地 docker-compose

```bash
# 1. 從 .env.keys 取得私鑰
export DOTENV_PRIVATE_KEY="key_..."

# 2. 第一次啟動 / 修改程式碼後（重新 build image）
docker compose up -d --build

# 只是重啟（未改程式碼）
docker compose restart

# 查看 log
docker compose logs -f

# 停止（保留 volume 資料）
docker compose down
```

> `docker compose up -d` 不加 `--build` 會沿用舊 image，修改程式碼後務必加上 `--build`。

### Railway 部署步驟

1. **建立 Railway 專案**
   Railway Dashboard → New Project → Deploy from GitHub repo（含 `Dockerfile`）

2. **設定環境變數**
   Railway Dashboard → Variables，逐一填入明文值（Railway 自行加密儲存）：

   | 變數 | 說明 |
   |------|------|
   | `RPC_URL` | Base 主 RPC（QuickNode / Alchemy 付費節點） |
   | `BOT_TOKEN` | Telegram Bot Token |
   | `CHAT_ID` | Telegram Chat ID |
   | `WALLET_ADDRESS_1` | 監控錢包地址（可加 `_2`, `_3`…；亦可啟動後透過 `/wallet add` 新增） |
   | `PANCAKE_MASTERCHEF_V3` | PancakeSwap MasterChef V3 地址（選填） |

   > 本金與鎖倉設定透過 Telegram `/invest` 指令管理，無需在 Railway Variables 設定。

3. **掛載 Volume（強烈建議）**
   Railway Dashboard → 你的服務 → Volumes → Add Volume，路徑設為 `/app/data`

   未掛載 Volume 時，每次重部署 `data/state.json` 會重置：
   - PriceBuffer 冷啟動，BB stdDev 需 ~20 小時才回到正常帶寬
   - volCache 重新請求 GeckoTerminal（可能觸發 429）
   - openTimestamps 需重新掃描鏈上 Transfer 事件（~20–50 秒）

4. **自動部署**
   推送至 `main` 分支後，Railway 自動重新建置並部署。

---

## 常見問題排除

### Bot 啟動後沒有推播訊息

1. 確認 `BOT_TOKEN` 與 `CHAT_ID` 設定正確（先在 Telegram 對 Bot 傳送 `/start`）
2. 查看 `logs/error.log` 是否有連線或認證錯誤
3. 確認 Bot 已被加入對話，且 `CHAT_ID` 為負數（群組）或正數（私訊）

### RPC 呼叫頻繁失敗 / CALL_EXCEPTION

1. 公共節點（`mainnet.base.org`）有速率限制，建議設定付費的 `RPC_URL`（QuickNode / Alchemy）
2. 查看 `logs/combined.log` 中 `rpcRetry` 的失敗記錄，確認是哪個合約呼叫失敗
3. 若是特定倉位的 timestamp 查詢失敗超過 3 次，系統會自動標記為 N/A 並停止重試，不影響其他功能

### GeckoTerminal 回傳 429（Too Many Requests）

Bot 已內建全局 rate limiter（每 1.5 秒一次請求），正常情況不應觸發。若仍發生：

1. 確認同台機器沒有其他程式也在打 GeckoTerminal API
2. 重啟後等待 1-2 分鐘，rate limiter 會自動恢復

### 倉位顯示「未設定歷史本金」或獲利率 N/A

透過 Telegram 設定本金：

```
/capital <tokenId> <amount>        # 設定本金 USD
/invest <addr> <tokenId> <amount> <dex>  # 同時設定本金 + 鎖倉標記
```

### 如何看 log

```bash
# 即時追蹤所有 log（含 INFO）
tail -f logs/combined.log

# 只看錯誤
tail -f logs/error.log

# 只看倉位快照（每 5 分鐘一次）
tail -f logs/positions.log

# 搜尋特定 tokenId 的記錄
grep "123456" logs/combined.log
```

log 檔案自動輪轉（`combined.log` 最大 5MB × 5 份，`positions.log` 最大 10MB × 10 份），不需手動清理。

### 重啟後 BB stdDev 很小 / 建議區間過窄

`state.json` 的 `priceBuffer` 保留最近 24 筆小時價格，重啟後會自動恢復。若資料累積不足 5 筆，BB 會顯示「資料累積中」並使用 30D 年化波動率換算的保守帶寬，約 20 小時後恢復正常。

若要加速：確保 `data/` 目錄（或 Railway Volume）正確掛載，避免每次重部署都清空 `state.json`。

---

## 安全性備註

本 Bot 為純背景監測腳本：

- **無 Web Server**：無外部接收 payload 的介面
- **無私鑰**：純監測模式，不執行任何鏈上寫入
- **無動態編譯**：不使用 `solc`，無 RCE 風險

`npm audit` 回報的 `cookie`、`serialize-javascript`、`elliptic` 等套件漏洞在此架構下風險為零，可安全忽略。

---

## 開發歷程

### ✅ 階段一：基礎建設

- **RPC 備援**：`FallbackProvider`（QuickNode → Alchemy → 公共節點）+ `rpcRetry`
- **config 拆分**：`env.ts` / `constants.ts` / `abis.ts` 分離，`index.ts` 統一匯出
- **README.md**：完整記錄環境變數、架構與啟動方式

### ✅ 階段二：多 DEX / 多錢包支援

- **新增 Aerodrome WETH/cbBTC 池**：fee=85 (0.0085%)，tickSpacing=1
- **池命名統一**：`{DEX}_{交易對}_{費率}` 格式（如 `UNISWAP_WETH_CBBTC_0_05`）
- **多錢包支援**：`WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 編號變數
- **getPoolFromTokens 碰撞修正**：key 改為 `${dex}_${fee}`，避免同費率不同 DEX 衝突
- **dex 型別擴充**：加入 `'Aerodrome'`

### ✅ 階段三：Bug 修正

- **IL 計算錯誤修正**：改用 Uniswap V3 sqrtPrice 數學計算 LP 倉位本金
- **Health Score 歸零修正**：連鎖修正（IL 正確後 ilRiskWeight 不再異常）
- **ilUSD 型別修正**：改為 `number | null`
- **Aerodrome slot0 ABI 修正**：新增 `AERO_POOL_ABI`（6 個回傳值，無 `feeProtocol`）
- **BBEngine 重複查詢修正**：執行順序改為 BBEngine → PositionScanner
- **BB lowerPrice 夾值 Bug 修正**：移除 `Math.max(0.00000001, lowerPrice)`，改為 `Math.max(sma - maxOffset, sma - k * stdDev)`
- **Hybrid 手續費計算**：Aerodrome / Uniswap / PancakeSwap 三路混合策略

### ✅ 階段四：Telegram 報告優化

- **合併報告**：`sendConsolidatedReport` 單一訊息
- **各池收益排行**：APR 由高到低，標記持倉池子
- **排序指令**：`/sort size|apr|unclaimed|health`
- **建倉時間戳**：自動查詢 NFT mint Transfer 事件
- **總覽區塊**：總倉位 USD、Unclaimed、總獲利（`PnlCalculator.calculatePortfolioSummary()`）
- **開倉資訊**：`⏳ 開倉 X天X小時 · 獲利 +X.XX%`
- **ILCalculator → PnlCalculator**：重命名，新增 `calculateOpenInfo()`、`calculatePortfolioSummary()`

### ✅ 階段五：系統穩定性與強化

- **狀態持久化**：`PriceBuffer`、`volCache`、openTimestampCache 存入 `data/state.json`
- **記憶體管理**：`volCache` 改用 `lru-cache`（max: 100）
- **動態 Gas Oracle**：`fetchGasCostUSD()`，5 分鐘快取
- **ChainEventScanner**：`ScanHandler` 介面統一所有 `getLogs` 掃描邏輯
- **第三幣獎勵支援**：PancakeSwap `pendingCake`、Aerodrome `gauge.earned`
- **isStaked 自動偵測**：`ownerOf` 回傳非已知錢包 → `isStaked=true`
- **BBEngine EWMA stdDev**：資料 ≥ 5 筆用 EWMA（α=0.3, β=0.7），不足時由 30D 年化波動率換算
- **常數集中化**：BB 參數、區塊掃描參數、Gas 常數全數移至 `constants.ts`

### ✅ 階段六：穩定性補強

- **SIGTERM 優雅關機**：`gracefulShutdown()` handler，`isShuttingDown` 旗標防競態
- **PriceBuffer 冷啟動缺口**：`refreshPriceBuffer()` 確保啟動首次計算有最新 on-chain 價格
- **GeckoTerminal 全局 rate limiter**：並發 1、最小間隔 1500ms；指數退避重試
- **Telegram 錯誤通知**：`sendCriticalAlert()`（30 分鐘 cooldown）
- **Timestamp 無限重試修正**：失敗超過 3 次後設 `-1`（N/A），停止重試

### ✅ 階段七：計算精度、優化

- **avg30DBandwidth 修正**：滾動窗口（8640 筆 = 30D × 288 次/天）
- **PoolScanner 平行化**：`Promise.allSettled` + `geckoLimiter`（≤ 2）
- **Rebalance Gas 即時化**：`getRebalanceSuggestion` 接受 `gasCostUSD?` 參數
- **BBEngine 方向性偏移**：`sdOffset = 0.3σ × direction`（強勢上移/弱勢下移）
- **BandwidthTracker 獨立工具類**：`src/utils/BandwidthTracker.ts`

### ✅ 階段八：PositionScanner 解耦

God Class 拆解為五段 Pipeline：

```
PositionScanner.fetchAll() → RawChainPosition[]
  → PositionAggregator.aggregateAll()（FeeCalculator）
  → index.ts PnL enrichment（PnlCalculator）
  → PositionScanner.updatePositions()
  → runRiskManager()（RiskManager + RebalanceService）
```

- 型別集中至 `src/types/index.ts`
- `FeeCalculator` / `PositionAggregator` 獨立服務
- `index.ts` 協調所有業務計算，PositionScanner 只負責鏈上資料讀取

### ✅ 階段十三：耦合問題修復（高優先部分）

- **PositionAggregator 重複呼叫 RiskManager 修正**：移除 bandwidth=0 的重複呼叫，統一由 `runRiskManager()` 負責
- **index.ts 全域狀態提取為 AppState**：`src/utils/AppState.ts` 單例，`pruneStaleBBs()` 取代 inline 迴圈
- **TelegramBot 解耦服務層**：Bot 只接收 `entries[]`，計算邏輯從 `PositionRecord` 欄位直接讀取
- **tickToPrice / tokenInfo 重複邏輯整合**：集中至 `src/utils/math.ts` 與 `src/utils/tokenInfo.ts`

### ✅ 階段十四：效能與架構地雷修復（高/中優先部分）

- **positions.log Health/Drift 顯示修正**：移至 `runRiskManager()` 末尾後才記錄快照
- **positions.log 時區統一**：全面改用 UTC（`getUTCHours()/getUTCMinutes()`）
- **冷啟動 BB isFallback 標記**：`isWarmupFallback` flag，`regime: '資料累積中'`
- **Cron Job Overlap 競態保護**：`isCycleRunning` flag + `try/finally`
- **aggregateAll 序列 RPC 改並行**：`p-limit`（concurrency=4）+ `Promise.allSettled`
- **Timestamp 背景搜尋即時儲存**：每找到一筆立刻持久化
- **RiskManager 魔術數字集中至 config**：`RED_ALERT_BREAKEVEN_DAYS`、`HIGH_VOLATILITY_FACTOR` 移至 `constants.ts`
- **formatPositionLog 提煉至 `formatter.ts`**
- **關閉倉位自動剔除**：`liquidity=0` 自動加入 `closedTokenIds`，重啟不重新掃描

### ✅ 階段十五：Uniswap V4 支援 + DEX 命名統一

- **Dex 型別版本號**：`'Uniswap'` → `'UniswapV3'`；`'PancakeSwap'` → `'PancakeSwapV3'`；新增 `'UniswapV4'`
- **V4 合約地址**：`V4_POOL_MANAGER`、`V4_POSITION_MANAGER`、`V4_STATE_VIEW`
- **PositionScanner V4**：`_fetchV4NpmData()`；packed PositionInfo 解碼（bits 0-23 = tickLower，bits 24-47 = tickUpper）
- **FeeCalculator V4**：`StateView.getPositionInfo()` + `getFeeGrowthInside()` delta 計算
- **PoolScanner V4**：`StateView.getSlot0(poolId)`；bytes32 poolId 驗證
- **stateManager DEX 遷移**：`loadState()` 自動將舊格式 `PancakeSwap→PancakeSwapV3`、`Uniswap→UniswapV3`

### ✅ 階段十六：Telegram 動態配置

- **UserConfig 中心化**：`WalletPosition { tokenId, dexType, initial, externalStake, openTimestamp, closed? }`
- **openTimestamps 合併入 userConfig**：移除 `state.json` 獨立欄位
- **全專案替換**：`.env` 靜態設定 → `ucWalletAddresses` / `ucInitialInvestment` / `ucTrackedPositions` helper
- **Telegram 指令**：`/wallet add|rm`、`/invest`、`/capital`、`/stake`、`/unstake`、`/dex`
- **`onUserConfigChange` 回呼**：每次 userConfig 變更立即持久化

### ✅ 階段十七：常數集中化與型別架構整理

- **`UserConfig` 型別移至 `src/types/index.ts`**
- **`UserConfig` 新增 Telegram 可修改欄位**：`sortBy`、`intervalMinutes`、`bbKLowVol`、`bbKHighVol`
- **`VALID_DEXES` / `DEX_MIGRATION` 移至 `constants.ts`**
- **`saveState` 簡化**：最終簽名 `saveState(priceBuffer, bandwidthWindows?, userConfig?)`
- **`setBbkCallback` / `getSortBy` / `setSortBy` 移除**：改透過 `onUserConfigChange` 統一持久化

### ✅ 階段十八：型別集中化、欄位重命名與指令重構

- **所有共用 interface 集中至 `src/types/index.ts`**：移除各模組死 re-export
- **`WalletEntry.dex[]` → `WalletEntry.positions[]`**
- **`WalletPosition.tracked` → `WalletPosition.externalStake`**
- **`closedTokenIds[]` 移除**：改用 `WalletPosition.closed?: boolean`，Set 於啟動時由 `restoreFromUserConfig()` 重建
- **`/invest` dexArg 必填**：移除 `UniswapV3` 預設值
- **無錢包冷啟動**：無錢包時跳過掃描等待 `/wallet add`
- **新增錢包自動觸發 chain scan**：`onUserConfigChange` 偵測新錢包後背景執行 `syncFromChain`

### ✅ P3 精度、測試基礎設施與 CI

- **PositionAggregator 浮點數精度**：`Math.sqrt(Math.pow(1.0001, tick))` 改用 `TickMath.getSqrtRatioAtTick(tick)` (uint160 Q96 → float)，消除大 tick 精度流失
- **Jest 基礎設施**：`jest.config.js`（已內建）+ ts-jest；`src/__tests__/` 目錄建立
- **RiskManager 單元測試**：Drift 計算（全重疊/零重疊/半重疊）、redAlert、highVolatility、EOQ compound、healthScore 邊界
- **PnlCalculator 單元測試**：absolutePNL（null capital / 盈虧兩向）、openInfo（undefined / -1 / 正常）、portfolioSummary（空/單錢包/多倉位 totalPnL）
- **BBEngine 單元測試**：PriceBuffer addPrice（無效值過濾、同小時覆蓋）、大小寫不敏感、serialize/restore 往返
- **rebalance.ts 單元測試**：drift < min → null、bbLower=0 → null、upward/downward drift 符號、Gas 超過 unclaimed/2 → 降級 wait
- **GitHub Actions CI**：`.github/workflows/ci.yml` — push/PR 自動跑 `tsc --noEmit` + `jest --no-coverage`（Node 22、ubuntu-latest）

### ✅ P2 可測試性改進

- **PositionScanner 全靜態類 → 可實例化**：移除所有 `static` 宣告，加入 `export const positionScanner = new PositionScanner()` 單例；`index.ts` / `dryrun.ts` 改用 singleton，為後續 Jest 覆蓋率鋪路
- **BBEngine PriceBuffer → 可注入**：`globalPriceBuffer` 模組級常數改為 `BBEngine._priceBuffer` 靜態屬性；匯出 `PriceBuffer` 類別；新增 `BBEngine._setPriceBuffer()` 供測試注入自訂 buffer
- **Docker Compose healthcheck**：`healthcheck` 以 `find /app/data/state.json -mmin -10` 確認容器未卡死（state.json 10 分鐘內有更新），interval=5m、start_period=2m

### ✅ P1 雜項清理

- **Wallet 地址正則集中**：`/^0x[0-9a-fA-F]{40}$/` 從 5 個檔案（`AppState`、`formatter`、`TelegramBot`、`PoolScanner`、`PnlCalculator`）集中至 `src/utils/validation.ts`；匯出 `WALLET_ADDRESS_RE`、`POOL_ADDRESS_RE`、`POOL_V4_ID_RE`、`isValidWalletAddress()`、`isValidPoolAddress()`、`isValidPoolV4Id()`
- **型別宣告確認**：`PnlCalculator` 與 `ChainEventScanner` 已無自定義 export type，型別均集中於 `src/types/index.ts`
- **README 常見問題章節**：新增「常見問題排除」章節（Bot 無推播、RPC 失敗、429、本金未設、如何看 log、BB 帶寬過窄）

### ✅ 測試目錄遷移

- **測試目錄遷移至根層**：`src/__tests__/` → `tests/services/`，符合「根目錄測試資料夾，依 src/ 子目錄分類」慣例
- **tsconfig.test.json**：新增測試專用 tsconfig（`rootDir: "."`），避免主編譯掃描 `tests/`
- **jest.config.js 更新**：`roots: ['<rootDir>/tests']`，ts-jest 改用 `tsconfig.test.json`

### ✅ 開倉模擬 — In-Range APR

- **`calculateCapitalEfficiency()`**：新增至 `src/utils/math.ts`；公式 `1 / (√(upperPrice/sma) - √(lowerPrice/sma))`，上限 100×
- **`PositionRecord.inRangeApr`**：新增欄位；`PositionAggregator.assemble()` 在 BB 非 fallback 時計算並填入
- **Telegram 位置區塊**：`💼` 行後新增 `📈 區間 APR X.X% (效率 X.X×)`（有 BB 才顯示）
- **各池收益排行**：格式由 `APR X.X%` 擴充為 `APR X.X% → 區間 Y.Y%`（`appState.bbs` 即時計算）
- **positions.log**：APR 欄位擴充為 `APR: X.X% (區間 Y.Y%)`
- **`/explain` 指令**：新增「區間 APR」指標說明（公式 + 適用條件）
