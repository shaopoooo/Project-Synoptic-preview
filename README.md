# DexBot

> 量化 DeFi LP 機器人 — Base 鏈上的 V3 流動性倉位管理 + Monte Carlo 開倉建議 + 自演化 regime engine

DexBot 是一個運行於 Cloudflare Railway 的長駐 bot，負責監控 Uniswap V3 / Aerodrome 等 DEX 上的 LP 倉位，週期性跑 Monte Carlo 模擬、偵測市場 regime（trend / range / neutral），並透過 Telegram 推送開倉、持有、rebalance、關倉等操作建議。

## ✨ Features

| 狀態 | 功能 | 說明 |
|------|------|------|
| ✅ | **Self-Learning Regime Engine** (PR #19) | Continuous regime vector + evolutionary search + walk-forward validation + blended bootstrap，含 Telegram `/regime` 指令 |
| ✅ | **Sharpe-like MC Scoring** (PR #20) | MC score 從 `mean/|cvar95|` 改為 `mean/std`，避免 cvar→0 時公式爆炸 |
| 📋 | **Position Advice System** | open / hold / rebalance / close 四場景建議，3-gate hysteresis 防 spam，per-positionId LRU cooldown |
| 📋 | **Backtest Verification** | offline replay grid search + shadow mode counterfactual + Phase 5c manual tune trigger |
| 📋 | **Cloudflare R2 Backup** | daily mirror sync + weekly tar.gz archive + 手動 CLI restore，搭配 analysis 攤平索引層 |

📋 = Phase 1 規劃完成，待 Phase 2 實作。完整 plan 見 `.claude/plans/`。

## 🏗️ Architecture

### Pipeline 拆分（嚴格規範）

- **Phase 0 (Prefetch)**：所有外部 IO 集中此階段（RPC、API、檔案讀寫）
- **Phase 1 (Compute)**：純函式運算，禁止 `await` / RPC / API
- 違反此原則會導致回測不穩定

### Cron 排程

| Cron | 頻率 | 用途 |
|------|------|------|
| 主 cycle | 10 min | prefetch → mcEngine → recommendOpen |
| Position monitor | 10 min（錯開 5 min） | classifyExit / shouldClose |
| New position discovery | 1 hour | syncFromChain |
| R2 daily mirror | 03:00 (Asia/Taipei) | data/ + logs/ → R2 |
| R2 weekly archive | 週日 04:00 | tar.gz → R2 archives/ |
| Shadow analyze | 週日 23:00 | counterfactual + Telegram 週報 |

### Regime Engine 運算流程

Regime engine 負責判斷每個 LP 池子當前處於「震盪（range）」、「趨勢（trend）」還是「中立（neutral）」狀態。所有 LP 開倉建議、MC 模擬的 bootstrap 抽樣權重都依賴此分類。

**輸入**：per-pool 的 `HourlyReturn[]`（1h K 線，含 high / low / close / log return `r`）

**三軌指標計算**（`src/services/strategy/MarketRegimeAnalyzer.ts`）：

| Track | 指標 | 公式 | 意義 |
|-------|------|------|------|
| 1a | **CHOP**（Choppiness Index） | `100 × log10(Σ(high-low) / totalRange) / log10(n)` | > 55 震盪（LP 友善）、< 45 趨勢（LP 危險） |
| 1b | **Hurst**（R/S Analysis） | R/S 回歸斜率 H | < 0.5 均值回歸（LP 友善）、> 0.5 趨勢延續 |
| 2 | **ATR**（Average True Range） | `avg(high-low)` over n candles | 開倉區間半寬的最小值 |
| 3 | **Percentile P5/P95** | 歷史 close 的第 5 / 95 百分位 | 開倉區間的天花板 |

**兩種輸出**：

1. **硬分類** `analyzeRegime()` → `MarketRegime.signal`：
   ```
   range   = CHOP > 55 AND Hurst < 0.52  （雙重確認才判定震盪）
   trend   = CHOP < 45 OR  Hurst > 0.65  （單一觸發就判定趨勢）
   neutral = 其他
   ```
   用途：`segmentByRegime()` 把歷史 returns 分到 range / trend / neutral 三個 bucket

2. **連續機率向量** `computeRegimeVector()` → `RegimeVector { range, trend, neutral }`：
   ```
   rangeScore  = (CHOP - threshold) / 100 + (threshold - Hurst) / 1
   trendScore  = (threshold - CHOP) / 100 + (Hurst - threshold) / 1
   neutralScore = 0
   → softmax(temperature T) → 三分量總和 = 1
   ```
   用途：MC engine 的 blended bootstrap 權重（決定從哪個 regime bucket 抽樣的機率）

**Genome 參數**（`RegimeGenome`，9 個基因）：

所有閾值（CHOP/Hurst thresholds、窗口大小、sigmoid 溫度 T）由 **Self-Learning Regime Engine**（PR #19）的演化搜索 + walk-forward validation 自動調整，不需手動 tune。

```
prefetchAll() → HourlyReturn[] per pool
      │
      ▼
  analyzeRegime()     → signal (hard: range/trend/neutral)
  computeRegimeVector() → { range: 0.6, trend: 0.3, neutral: 0.1 }
  segmentByRegime()   → [range bucket, trend bucket, neutral bucket]
  computeRangeGuards() → { atrHalfWidth, p5, p95 }
      │
      ▼
  MC Engine: blended bootstrap (per-step 按 regimeVector 權重選 bucket 抽樣)
      │
      ▼
  LP 開倉建議 / PositionAdvisor
```

相關檔案：`src/services/strategy/MarketRegimeAnalyzer.ts`、`src/types/index.ts`（`RegimeVector` / `RegimeGenome` / `MarketRegime`）、`src/runners/mcEngine.ts`、`src/services/strategy/MonteCarloEngine.ts`

### 核心設計原則

- **AppState 注入式**：所有 Service 透過參數注入 AppState，禁止直接修改全域狀態
- **Pure Functions**：所有計算邏輯集中在 `utils/math.ts`，使用原生 BigInt（禁用 decimal.js）
- **TypeScript strict**：禁止 `any`
- **錯誤處理**：所有 RPC 呼叫包 `rpcRetry`，API 失敗 fallback 到本地快取並記錄 `appState.cycleWarnings`
- **Telegram 解耦**：`src/bot/` 只能格式化文字 + 發送，業務邏輯在 `src/services/`

## 🛠️ Tech Stack

- **Runtime**：Node.js + TypeScript（strict）+ ts-node
- **環境變數**：[`@dotenvx/dotenvx`](https://dotenvx.com/)（加密管理 .env）
- **DEX 互動**：`@uniswap/v3-sdk` + `ethers` v6
- **Telegram**：`grammy`
- **HTTP**：`axios`
- **檔案系統**：`fs-extra`
- **測試**：Jest（TDD 紀律）
- **部署**：Cloudflare Railway（含 Persistent Volume）
- **備份**：Cloudflare R2（free tier 10 GB）

## 🚀 Getting Started

### Prerequisites

- Node.js（建議透過 nvm 管理版本）
- 一個 Telegram bot token（向 [@BotFather](https://t.me/BotFather) 申請）
- 你的 Telegram chat ID（或群組 ID）
- CoinGecko Pro API key
- TheGraph subgraph API key
- （Optional）Cloudflare R2 帳號 + bucket

### Installation

```bash
git clone <repo-url>
cd DexBot
npm ci
```

> ⚠️ 一律使用 `npm ci`，**不要**用 `npm install`（會破壞 lock file 的精確版本固定）。

### 環境變數設定（dotenvx）

DexBot 使用 `@dotenvx/dotenvx` 管理環境變數。所有 npm scripts 都會自動透過 dotenvx 載入 `.env`，**不需要**自己手動 source。

```bash
# 1. 複製範本
cp .env.example .env

# 2. 編輯 .env，填入實際值
# 範例：
#   BOT_TOKEN=123456:ABC...
#   CHAT_ID=-100123456789
#   COINGECKO_API_KEY=CG-...
#   SUBGRAPH_API_KEY=...
#   R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com   (optional)
#   R2_ACCESS_KEY_ID=...                                       (optional)
#   R2_SECRET_ACCESS_KEY=...                                   (optional)
```

#### 加密敏感變數（建議）

dotenvx 支援把 `.env` 內的值就地加密，避免明文 commit 風險：

```bash
# 加密單一變數
npx dotenvx set BOT_TOKEN "123456:ABC..." --encrypt

# .env 內會變成 encrypted:BPx... 形式
# 對應的解密 key 會自動寫入 .env.keys（必須加進 .gitignore）
```

執行時 dotenvx 會自動用 `.env.keys` 解密：

```bash
npm run dev   # dotenvx 自動處理加解密
```

#### 部署到 Railway

在 Railway dashboard → DexBot service → Variables 把上述變數**逐一**設定（不要 commit `.env` 或 `.env.keys`）。

## 📜 Scripts

| 指令 | 用途 |
|------|------|
| `npm run dev` | 完整開發模式（dotenvx 載入 .env + 完整啟動流程） |
| `npm run dev:fast` | 快速啟動模式（跳過初始 block scan，適合快速 iteration） |
| `npm test` | 跑 Jest 單元測試 |
| `npm run dryrun` | Dry Run 模式（不執行任何真實交易，純模擬） |
| `npm run backtest` | Legacy 歷史回測（將被 `.claude/plans/p0-backtest-verification.md` 取代） |
| `npm run backfill` | 從 GeckoTerminal 補抓歷史 OHLCV 到 `data/ohlcv/` |
| `npm start` | 直接執行 `src/index.ts`（不載入 .env，極少使用） |

### 套件安裝鐵律

新增 npm 套件前必須**全部**滿足：

1. **版本年齡 ≥ 7 天**（防供應鏈攻擊）：
   ```bash
   npm view <package> time --json
   ```
2. **版本號精確固定**：禁止 `^` / `~` 前綴（例如 `"ethers": "6.16.0"`，不是 `"^6.16.0"`）
3. **commit `package-lock.json`**，部署用 `npm ci`

## 📁 Project Structure

```
src/
├── bot/         # Telegram interface — 只做 UI，禁止業務邏輯
├── runners/     # Cron pipelines（mcEngine、positionMonitor 等）
├── services/    # 業務邏輯（DeFi、strategy、regime、market）
├── types/       # TypeScript 型別定義
├── utils/       # Pure functions、AppState、math
├── config/      # 環境變數 + 常數
├── scripts/     # Standalone CLI scripts（如 backfillOhlcv）
└── backtest/    # 歷史回測（legacy + 未來的 framework / v3lp 子目錄）

data/            # OHLCV 快取、diagnostics.jsonl、未來的 shadow log（R2-backed）
logs/            # Service logs（combined.log、error.log）
tests/           # Jest 測試
.claude/         # AI agent 配置
├── docs/        # CLAUDE.md 子文件（plan-lifecycle / git-workflow / dev-commands / skills）
├── plans/       # Feature plan 檔案（<priority>-<slug>.md）
├── rules/       # 自動載入的程式碼規則（pipeline、math、naming 等）
├── hooks/       # Git hooks（pre-push 守門 plan 刪除）
└── skills/      # 專案自訂 Claude skills
```

## 🔄 Development Workflow

DexBot 採用結構化的 Phase 1 → Phase 2 → Phase 3 三階段工作流，所有規劃決策都集中在 `.claude/plans/<priority>-<slug>.md`。

### Phase 1（規劃）三條 intake path

| Path | 時機 | 流程 |
|------|------|------|
| **A** | Big feature，需求模糊 | `/office-hours` → `/plan-eng-review` → `brainstorming` |
| **B** | Medium feature，idea 清楚 | `brainstorming` → `/plan-eng-review` |
| **C** | Small feature，無設計爭議 | `cp TEMPLATE.md` 直接填寫 |

所有工具都直接修改 `.claude/plans/<priority>-<slug>.md`。

### Phase 2（執行）

- 在主目錄直接 `git checkout -b feature/<slug>`（**不**用 worktree）
- 觸發 superpowers `subagent-driven-development` / `executing-plans`
- 嚴格 RED-GREEN-REFACTOR
- Plan 內部用 **Stage / Group / Task** 三層階層
- 同 Stage 內不同 Group 可由多 subagent 並行

### Phase 3（發布）

```
1. npm test (auto)
2. /cso 資安掃描 (auto, warn-only)
3. /qa (skip for DexBot — 無 web UI)
4. /ship (auto): 刪 plan + 更新 tasks.md + bump version + CHANGELOG + push
5. 手動 gh pr create
6. Self-review + merge to dev
7. 想部署時手動 merge dev → main（Railway 自動 deploy）
```

完整工作流見 [`CLAUDE.md`](./CLAUDE.md) 與 [`.claude/docs/plan-lifecycle.md`](./.claude/docs/plan-lifecycle.md)。

## 🚢 Deployment

- **平台**：Cloudflare Railway
- **Volume**：持久化掛載到 `/app/data` 與 `/app/logs`
- **觸發**：手動 `dev → main` merge → Railway 自動 deploy
- **備份**：R2 daily mirror 03:00 + weekly archive 週日 04:00（prod bucket `tradingbot-backup`，archives/ 90 天 lifecycle cleanup）

### DR restore 在 Railway container 內執行

生產環境的 Railway image 只有 production dependencies，沒有 `ts-node`，所以本地常用的 `backup:restore-mirror` 在 Railway 上會失敗。改用 `:prod` 版本（直接跑已編譯的 `dist/scripts/*.js`）：

```bash
railway ssh                              # 進 running container
env | grep R2_                           # 確認 R2_* 四個 env 都有值
ls /app/data                             # 確認 volume 當前狀態
npm run backup:restore-mirror:prod       # 從 prod bucket 拉回 data/ + logs/
rm -rf /app/data.backup-* /app/logs.backup-*   # 清理 safety backup
exit
```

對應的三個 prod script：
- `npm run backup:restore-mirror:prod` — 從 R2 mirror 拉所有 `data/` + `logs/`
- `npm run backup:restore-archive:prod <weekIso>` — 下載指定週 archive 解壓覆蓋
- `npm run backup:list-archives:prod` — 列出 R2 上可用 archive

## 📊 Project Status

| 區塊 | 狀態 |
|------|------|
| Self-Learning Regime Engine | ✅ Shipped (PR #19) |
| Sharpe-like MC Scoring | ✅ Shipped (PR #20) |
| Cloudflare R2 Backup | ✅ Shipped (v0.2.0) |
| Position Advice System | 📋 Plan 完成，待實作 |
| Backtest Verification | 📋 Plan 完成，待實作 |

詳細路線圖見 [`.claude/tasks.md`](./.claude/tasks.md)。

## 🤝 Contributing

本專案目前由單人維護，遵循嚴格的 plan-driven workflow：

- 所有 feature 必須先有 `.claude/plans/<priority>-<slug>.md`
- 嚴格 TDD（測試先於實作）
- commit message 用繁體中文（不加 `Co-Authored-By` trailer）
- 完整規則見 [`CLAUDE.md`](./CLAUDE.md)
