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

純背景監測腳本，透過 Telegram 推播 Uniswap V3 / PancakeSwap V3 / Aerodrome Slipstream 流動性池的 APR、BB 區間建議、IL 風險評估與複利訊號。不執行任何鏈上交易。支援多錢包監測與鎖倉倉位追蹤（Aerodrome Gauge）。

---

## 環境變數

在專案根目錄建立 `.env` 檔案：

| 變數名稱 | 必填 | 說明 |
|----------|------|------|
| `RPC_URL` | 否 | Base 主網 RPC 端點（預設：`https://mainnet.base.org`） |
| `WALLET_ADDRESS_1` | 否 | 第一個監測錢包地址 |
| `WALLET_ADDRESS_2` | 否 | 第二個監測錢包地址（可繼續增加 `_3`, `_4`...） |
| `SUBGRAPH_API_KEY` | 是 | [The Graph](https://thegraph.com/) API 金鑰（用於 Uniswap / PancakeSwap 子圖查詢） |
| `BOT_TOKEN` | 是 | Telegram Bot Token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `CHAT_ID` | 是 | Telegram 接收推播的 Chat ID |
| `INITIAL_INVESTMENT_<tokenId>` | 否 | 各倉位初始本金 USD，用於 IL / 淨 APR 計算（如 `INITIAL_INVESTMENT_123456=1000`） |
| `TRACKED_TOKEN_<tokenId>` | 否 | 手動追蹤鎖倉倉位，值為 DEX 名稱（如 `TRACKED_TOKEN_123456=Aerodrome`） |

> 若所有 `WALLET_ADDRESS_N` 均未設定，則跳過倉位掃描，僅推播池子 APR 排行。

`.env` 範例：

```env
RPC_URL=https://your-quicknode-endpoint.quiknode.pro/your-key/
WALLET_ADDRESS_1=0xYourFirstWalletAddress
WALLET_ADDRESS_2=0xYourSecondWalletAddress
SUBGRAPH_API_KEY=your_graph_api_key
BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
CHAT_ID=-100123456789

# 各倉位初始本金（格式：INITIAL_INVESTMENT_<tokenId>=<USD>）
INITIAL_INVESTMENT_123456=1000.0
INITIAL_INVESTMENT_789012=500.0

# 鎖倉於 Gauge 的倉位（格式：TRACKED_TOKEN_<tokenId>=<DEX>）
TRACKED_TOKEN_789012=Aerodrome
```

### 使用 dotenvx 管理環境變數（推薦）

[dotenvx](https://dotenvx.com) 支援加密 `.env`、多環境切換，適合在 CI/CD 或共享環境使用。

```bash
# 安裝（一次性）
npm install -g @dotenvx/dotenvx

# 設定單一變數（自動寫入 .env）
npx dotenvx set BOT_TOKEN 123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
npx dotenvx set CHAT_ID -100123456789
npx dotenvx set SUBGRAPH_API_KEY your_graph_api_key

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
├── index.ts                    # 主進入點：cron 排程、服務協調
├── dryrun.ts                   # 乾跑測試用（不啟動 Telegram）
├── config/
│   ├── env.ts                  # 環境變數讀取（process.env）
│   ├── constants.ts            # 常數（池地址、子圖端點、快取 TTL）
│   ├── abis.ts                 # 合約 ABI（NPM、Pool）
│   └── index.ts                # 統一匯出入口
├── services/
│   ├── PoolScanner.ts          # APR 掃描（DexScreener + The Graph + GeckoTerminal）
│   ├── BBEngine.ts             # 動態布林通道（20 SMA + 30D 波動率）
│   ├── PositionScanner.ts      # LP NFT 倉位監測（On-chain RPC）
│   ├── RiskManager.ts          # 風險評估（Health Score、IL Breakeven、EOQ 複利訊號）
│   ├── ILCalculator.ts         # 絕對 PNL 計算（相對初始本金）
│   └── rebalance.ts            # 再平衡建議（純計算，不執行交易）
├── bot/
│   └── TelegramBot.ts          # Telegram 推播格式化
├── backtest/
│   └── BacktestEngine.ts       # 歷史回測引擎
├── scripts/
│   └── fetchHistoricalData.ts  # 抓取回測用歷史 OHLCV 資料
└── utils/
    ├── logger.ts               # Winston 彩色 logger（console + 檔案輪轉）
    ├── math.ts                 # BigInt 固定精度數學工具
    └── rpcProvider.ts          # FallbackProvider + rpcRetry
```

日誌輸出至 `logs/`（自動建立）：

- `combined.log`：全量日誌（最大 5MB × 5 份）
- `error.log`：僅錯誤（最大 5MB × 3 份）
- `positions.log`：倉位快照 JSON 歷史（最大 10MB × 10 份）

---

## 監測池（Base Network）

| 協議 | 交易對 | 費率 | 合約地址 |
|------|--------|------|----------|
| PancakeSwap V3 | WETH/cbBTC | 0.01% | `0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3` |
| PancakeSwap V3 | WETH/cbBTC | 0.05% | `0xd974d59e30054cf1abeded0c9947b0d8baf90029` |
| Uniswap V3 | WETH/cbBTC | 0.05% | `0x7aea2e8a3843516afa07293a10ac8e49906dabd1` |
| Uniswap V3 | WETH/cbBTC | 0.30% | `0x8c7080564b5a792a33ef2fd473fba6364d5495e5` |
| Aerodrome Slipstream | WETH/cbBTC | 0.0085% | `0x22aee3699b6a0fed71490c103bd4e5f3309891d5` |

---

## 核心資料流（每 5 分鐘）

```
PoolScanner → BBEngine → PositionScanner → RiskManager → TelegramBot
```

1. **PoolScanner**：從 DexScreener 取得 TVL；The Graph（Uniswap/PancakeSwap）或 GeckoTerminal（Aerodrome）取得成交量；計算各池 APR
2. **BBEngine**：先行計算所有池的布林通道（避免 PositionScanner 重複呼叫 GeckoTerminal），維護 in-memory 小時價格緩衝區，計算 20 SMA + 動態 k 值，產出建議 Tick 區間
3. **PositionScanner**：掃描多個錢包的 LP NFT（含 `TRACKED_TOKEN_<tokenId>` 鎖倉倉位），注意 Aerodrome NPM `positions()` 回傳 `tickSpacing` 而非 `fee`；使用預計算 BB；以 sqrtPrice 數學計算倉位現值；首次發現倉位時自動查鏈取得建倉時間戳
4. **RiskManager**：計算 Health Score、IL Breakeven Days、EOQ Compound Signal、drift 警告
5. **TelegramBot**：合併所有倉位為單一報告推播，支援 `/sort` 排序切換

---

## Telegram 推播格式

每 5 分鐘推播單一合併報告，所有倉位依選定排序鍵由大到小排列：

```
[2026-03-06 17:05] 倉位監控報告 (2 個倉位 | 排序: 倉位大小 ↓)

━━ #1 PancakeSwap 0.01% ━━
APR 67.2% | 倉位 $12,400 | 健康 94/100
淨APR 51.3% (IL年化 -15.9%)
👛 0xaBcD...1234 · #1675918
💹 當前 0.02921 | Low Vol (震盪市)
  你的: 0.02803 ~ 0.03054
  BB:   0.02628 ~ 0.03213
💸 Unclaimed $4.6 | IL +$18.2 🟢
⏱ Breakeven 0天 · Compound ✅ $4.6 > $0.1

━━ #2 Aerodrome 0.0085% ━━
APR 29.4% | 倉位 $7,800 | 健康 61/100
👛 0xdEfA...5678 · #56328282
💹 當前 0.02905 | High Vol (趨勢市)
  你的: 0.02700 ~ 0.03100
  BB:   0.02550 ~ 0.03300
💸 Unclaimed $2.1 | IL -$95.0 🔴
⏱ Breakeven 22天 · Compound ❌ $2.1 < $5.8
⚠️ DRIFT 重疊 71.3% (建議依 BB 重建倉)

📊 各池收益排行:
🥇 PancakeSwap 0.01% — APR 67.2% | TVL $1,234K ◀ 你的倉位
🥈 Aerodrome 0.0085% — APR 29.4% | TVL $987K ◀ 你的倉位
🥉 Uniswap 0.05% — APR 18.6% | TVL $543K

⏱ 資料更新時間:
- Pool: 17:05 | Position: 17:05
- BB Engine: 17:05 | Risk: 17:05
```

**選用欄位（有條件才顯示）：**
- `淨APR`：需設定 `INITIAL_INVESTMENT_<tokenId>` 且倉位有建倉時間戳
- `⚠️ RED_ALERT`：IL Breakeven Days > 30 天，建議減倉
- `⚠️ HIGH_VOLATILITY_AVOID`：當前頻寬 > 2× 30D 平均頻寬，建議觀望
- `⚠️ DRIFT`：BB 重疊度 < 80%，附再平衡策略名稱與 Gas 估算

### Telegram 指令

| 指令 | 說明 |
|------|------|
| `/start` | 啟動 Bot，確認連線正常 |
| `/sort size` | 依倉位大小（USD）排序（預設） |
| `/sort apr` | 依 APR 排序 |
| `/sort unclaimed` | 依未領手續費排序 |
| `/sort health` | 依 Health Score 排序 |
| `/sort` | 查看目前排序及所有選項 |
| `/explain` | 顯示所有指標的計算公式說明 |

---

## RPC 備援機制

`src/utils/rpcProvider.ts` 使用 `ethers.FallbackProvider`，節點優先順序：

1. `RPC_URL`（環境變數，主節點）
2. `https://base-rpc.publicnode.com`
3. `https://1rpc.io/base`
4. `https://base.meowrpc.com`

所有 RPC 呼叫透過 `rpcRetry()` 包裝，支援指數退避自動重試（最多 3 次）。

---

## 資料來源優先順序

**成交量 / APR**
1. The Graph（Uniswap Messari Schema 或 Native Schema）
2. GeckoTerminal OHLCV Day（最多 3 次重試，10s 延遲）
3. 過期快取（stale cache）
4. 零值

**BB 波動率**
1. GeckoTerminal OHLCV Day（30 天）
2. 預設 50% 年化波動率

**BB 小時價格**
1. In-memory `PriceBuffer`（每次掃描更新）
2. GeckoTerminal OHLCV Hour（初始 backfill，每次掃描少於 20 筆時觸發）

---

## 動態布林通道（BBEngine）

| 市場狀態 | 條件 | k 值 |
|----------|------|------|
| 低波動 | 30D 年化波動率 < 50% | `k = 1.2` |
| 高波動 | 30D 年化波動率 >= 50% | `k = 1.8` |

價格區間上限為 SMA ±10%（`maxOffset = sma * 0.10`）。

---

## IL 計算設定

本系統採用「絕對美元盈虧（Absolute PNL）」：

```
PNL = (LP 倉位現值 + 累計已領/未領手續費) - 初始投入本金
```

在 `.env` 中以 `INITIAL_INVESTMENT_<tokenId>=<USD>` 格式設定各倉位建倉本金：

```env
INITIAL_INVESTMENT_123456=1000.0
INITIAL_INVESTMENT_789012=500.0
```

未設定的 Token ID 顯示「未設定歷史本金」，IL 與淨 APR 計算為 0。

---

## 鎖倉倉位追蹤（Aerodrome Gauge）

Aerodrome 倉位質押至 Gauge 後，NFT 轉移至 Gauge 合約，`balanceOf(wallet) = 0`，無法透過正常掃描找到。
在 `.env` 中以 `TRACKED_TOKEN_<tokenId>=<DEX>` 格式手動指定需追蹤的 Token ID：

```env
TRACKED_TOKEN_789012=Aerodrome
```

系統會在錢包掃描完成後，額外從鏈上讀取這些 Token ID 並加入監測清單。
開倉時間戳會自動透過查詢 NFT `Transfer` 事件（from=0x0）從鏈上取得並快取。

---

## EOQ 複利訊號

```
Threshold = sqrt(2 × 本金 × Gas費用 × 24h費率)
當 Unclaimed Fees > Threshold 時，發送 COMPOUND_SIGNAL
```

注意：目前 Gas 費用為硬編碼 `$1.5`（待改為動態 Oracle）。

---

## 安全性備註

本 Bot 為純背景監測腳本：

- **無 Web Server**：無外部接收 payload 的介面
- **無私鑰**：純監測模式，不執行任何鏈上寫入
- **無動態編譯**：不使用 `solc`，無 RCE 風險

`npm audit` 回報的 `cookie`、`serialize-javascript`、`elliptic` 等套件漏洞在此架構下風險為零，可安全忽略。
