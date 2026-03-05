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

純背景監測腳本，透過 Telegram 推播 Uniswap V3 / PancakeSwap V3 流動性池的 APR、BB 區間建議、IL 風險評估與複利訊號。不執行任何鏈上交易。

---

## 環境變數

在專案根目錄建立 `.env` 檔案：

| 變數名稱 | 必填 | 說明 |
|----------|------|------|
| `RPC_URL` | 否 | Base 主網 RPC 端點（預設：`https://mainnet.base.org`） |
| `WALLET_ADDRESS` | 否 | 要監測的錢包地址（留空則跳過倉位掃描） |
| `SUBGRAPH_API_KEY` | 是 | [The Graph](https://thegraph.com/) API 金鑰（用於 Uniswap / PancakeSwap 子圖查詢） |
| `BOT_TOKEN` | 是 | Telegram Bot Token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `CHAT_ID` | 是 | Telegram 接收推播的 Chat ID |

`.env` 範例：

```env
RPC_URL=https://your-quicknode-endpoint.quiknode.pro/your-key/
WALLET_ADDRESS=0xYourWalletAddress
SUBGRAPH_API_KEY=your_graph_api_key
BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
CHAT_ID=-100123456789
```

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

| 協議 | 費率 | 合約地址 |
|------|------|----------|
| PancakeSwap V3 | 0.01% | `0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3` |
| PancakeSwap V3 | 0.05% | `0xd974d59e30054cf1abeded0c9947b0d8baf90029` |
| Uniswap V3 | 0.05% | `0x7aea2e8a3843516afa07293a10ac8e49906dabd1` |
| Uniswap V3 | 0.30% | `0x8c7080564b5a792a33ef2fd473fba6364d5495e5` |

---

## 核心資料流（每 5 分鐘）

```
PoolScanner → PositionScanner → BBEngine → RiskManager → TelegramBot
```

1. **PoolScanner**：從 DexScreener 取得 TVL，The Graph 或 GeckoTerminal 取得成交量，計算各池 APR
2. **BBEngine**：維護 in-memory 小時價格緩衝區（24h），計算 20 SMA + 動態 k 值，產出建議 Tick 區間
3. **PositionScanner**：從鏈上掃描錢包內 LP NFT，計算 unclaimed fees、倉位現值、BB 重合度
4. **RiskManager**：計算 Health Score、IL Breakeven Days、EOQ Compound Signal、drift 警告
5. **TelegramBot**：格式化推播報告

---

## Telegram 推播格式

```
[2026-03-05 17:05] 監控池: Pancake 0.01% (APR 67.2%)
當前價格: 0.03045678 | 你的區間: 0.02980000 - 0.03120000
建議 BB 區間: 0.02980000 - 0.03120000
Unclaimed: $12.4 | IL (PNL): -$8.7 | Breakeven: 14 天
Compound Signal: ✅ Unclaimed $12.4 > Threshold $7.1
Health Score: 94/100 | Regime: Low Vol (震盪市)
```

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

在 `src/config/constants.ts` 的 `INITIAL_INVESTMENT_USD` 中設定各 Token ID 的建倉本金：

```typescript
INITIAL_INVESTMENT_USD: {
  '1675918': 1810.5,  // Token ID: 初始投入 USD
}
```

未設定的 Token ID 顯示「未設定歷史本金」，IL 計算為 0。

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
