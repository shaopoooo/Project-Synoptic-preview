# DexBot

> Regime-driven 量化 DeFi 交易系統 — 以自演化 Regime Engine 為決策核心，衍生多種市場策略

核心理念：**Regime Engine 是唯一的「氣象中心」，所有交易策略都是這份天氣預報的消費者**。Regime Engine 判斷市場處於「震盪（range）」、「趨勢（trend）」還是「中立（neutral）」，各策略根據自己的風險偏好解讀這份客觀報告，做出不同的交易決策。

## 🏛️ 系統架構（Regime 為核心的資料流）

```
OHLCV (1H K 線，per-pool)
│
▼
┌─────────────────────────────────────────────────────────┐
│  Regime Engine（氣象中心，客觀）                          │
│                                                         │
│  Stage 1: deriveMarketStats                             │
│    └─ Kalman Filter (零滯後中軌) + EWMA (快速波動率)     │
│    └─ → normalizedReturns (Z-score) + smoothedCandles    │
│                                                         │
│  Stage 2: computeRegimeVector                            │
│    ├─ CHOP(14h) 短期震盪度 ← smoothedCandles            │
│    ├─ Hurst(100h) 長期趨勢持續性 ← normalizedReturns    │
│    └─ → RegimeVector { range, trend, neutral }           │
│         (客觀機率，無策略偏見)                            │
│                                                         │
│  Genome: 15 維可演化參數                                  │
│    └─ 演化搜索 + walk-forward validation 自動調參        │
└─────────────────────────────────────────────────────────┘
         │
         │ RegimeVector (天氣預報廣播)
         │
    ┌────┴────┬──────────────┬──────────────────────┐
    ▼         ▼              ▼                      ▼
┌────────┐ ┌──────────┐ ┌─────────────┐    ┌──────────────┐
│Strategy│ │ MC Engine │ │ Strategy #2 │    │ Future       │
│ #1     │ │           │ │ Trend Follow│    │ Strategies   │
│ V3 LP  │ │ Bootstrap │ │ (研究中)    │    │ (SOL / Grid  │
│        │ │ + scoring │ │             │    │  / Options)  │
│ short  │ │ regime-   │ │ long vol    │    │              │
│  vol   │ │ weighted  │ │ pair trade  │    │              │
└───┬────┘ └─────┬─────┘ └──────┬──────┘    └──────────────┘
    │            │               │
    ▼            ▼               ▼
 LP open/     Score /         Perp entry/
 close/hold   range calc      exit decisions
    │            │               │
    └──────┬─────┘               │
           ▼                     ▼
    Telegram Alerts         (未來: 自動執行)
```

**設計原則**：Regime Engine 輸出**中性機率**（P(range), P(trend), P(neutral)），各策略自己決定怎麼解讀。LP 策略放大 trend 恐懼（快出慢進），Trend Follow 策略需要更強確認才進場。氣象中心不帶情緒。

## ✨ Features

### 已 Ship

| 功能 | PR | 說明 |
|------|-----|------|
| **Self-Learning Regime Engine** | #19 | Continuous regime vector + evolutionary search + walk-forward validation + blended bootstrap |
| **Sharpe-like MC Scoring** | #20 | `mean/std` 取代 `mean/|cvar95|` |
| **Cloudflare R2 Backup** | v0.2.0 | Daily mirror + weekly archive + manual CLI restore |
| **PositionAdvisor 純函數** | #28 | `recommendOpen` / `classifyExit` / `shouldClose`，住 `src/engine/lp/` |

### 進行中

| 功能 | PR | 狀態 |
|------|-----|------|
| **Backtest Verification Harness** | PR 4 | Batch 1+2 完成，Batch 3 進行中。含 `regimeSignalAudit` side-output |
| **Storage 統一結構** | PR 6 (待) | `i-unify-storage` Stage 3-4 |

### 已規劃（`.claude/plans/` 完整 plan 已寫）

| 功能 | Plan | 說明 |
|------|------|------|
| **P0 Position Advice System** | `p0-position-advice-system.md` | LP 四場景建議 + 3-gate hysteresis + shadow mode |
| **P1 Trend Follow Strategy** | `p1-trend-follow-strategy.md` | BTC/ETH pair trade (long vol wing)，regime-driven entry/exit，research-first backtest validation |
| **Regime Engine V2** | `t-regime-engine-v2.md` | Kalman+EWMA 前處理 + 長短分離 + 客觀 scoring + two-phase evolution |

## 🧠 Strategy #1: V3 LP（short volatility）

DexBot 目前唯一在 production 的策略。在 BTC/ETH 池子提供 V3 concentrated liquidity。

**經濟特性**：LP 本質上是 **short volatility on BTC/ETH ratio** — price 待在 range 內時賺手續費（= 收 vol premium），穿出 range 時被 IL 吃掉（= short vol 爆虧）。

**Regime Engine 的角色**：
- Range regime → LP 友善，推薦開倉
- Trend regime → LP 危險，推薦關倉或 hold
- LP Advisor 讀 `regimeVector.trend` × **sensitivity multiplier 1.5**（放大恐懼，快出慢進）
- 另有 **CHOP panic shortcut**：raw CHOP < 35 → 直接 exit（不等 regime vector，零延遲防禦暴跌）

**MC Engine 整合**：regime vector 的三分量（range / trend / neutral）作為 blended bootstrap 的抽樣權重。如果 regime 偏 trend，MC 模擬的未來路徑會有更多「趨勢延續型」的 returns。

## 📈 Strategy #2: Trend Follow（long volatility，研究中）

計畫中的第二策略。在 BTC/ETH ratio 上做 **perp pair trade**（long BTC-USD + short ETH-USD，或反向），由 regime engine 的 trend signal 驅動進出場。

**跟 LP 的 barbell 關係**：
- LP = short vol on ratio（range 賺、trend 虧）
- Trend Follow = long vol on ratio（trend 賺、range 不動）
- 合計 = 結構性 hedge，覆蓋所有 regime

**目前狀態**：Plan 完成（Path A 全流程 + eng review + brainstorming 定稿），0 個 Open Questions。Backtest-first，pass criteria gated（Sharpe ≥ 0.3 / DefenseEV ≥ 1.0）。

## 🔬 Backtest Engine

DexBot 採用 **research-first 紀律**：任何新策略或 regime engine 改動都必須先通過 backtest validation，才允許進 production。

**架構**（`src/backtest/`）：

```
src/backtest/
├── framework/                    # 策略無關的通用骨架
│   ├── walkForwardSplit.ts       # temporal train/val/test split
│   ├── outcomeAggregator.ts      # A/C/D 三指標 + 加權總分
│   └── regimeSignalAudit.ts      # regime signal quality side-output
├── v3lp/                         # Strategy #1 專用
│   └── featureExtractor.ts       # OHLCV → ReplayFeature[]（per-cycle 特徵）
└── trendFollow/                  # Strategy #2 專用（P1 plan scope）
    ├── runTrendFollowBacktest.ts  # 入口 script
    ├── perpPnlCalculator.ts      # per-leg P&L + funding rate model
    └── baselineCalculator.ts     # LP-alone / 50-50 hold / cash baselines
```

**Regime Signal Quality Audit**：每次 backtest 都附帶 regime engine 的分類品質報告（`trendVsRangeRatio` / `flipFlopRate` / `DefenseEV`），確保決策基座可靠。

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

### Regime Engine — 當前 V1 + 規劃中 V2

Regime engine 是整個系統的決策核心。所有策略（LP / Trend Follow / 未來策略）都消費它的輸出。

#### V1 — 當前 production（PR #19）

**輸入**：per-pool 的 `HourlyReturn[]`（1h K 線）

**指標**：

| 指標 | 公式 | 意義 |
|------|------|------|
| **CHOP(14)** | `100 × log10(Σ(high-low) / totalRange) / log10(n)` | > 55 震盪、< 45 趨勢 |
| **Hurst(20)** | R/S 回歸斜率 H | < 0.5 均值回歸、> 0.5 趨勢延續 |
| **ATR(14)** | `avg(high-low)` | 開倉區間半寬下限 |

**輸出**：`RegimeVector { range, trend, neutral }` — 連續機率向量（softmax），三分量總和 = 1

**已知問題**（戰略 review 2026-04-13 發現，詳見 `t-regime-engine-v2.md`）：
- CHOP(14) 跟 Hurst(20) 高度共線性（看同一段時間同一件事）→ score 被雙重放大
- 直接吃 raw OHLCV → 插針 / 假突破 / 歷史波動殘留全部灌入分類器
- Walk-forward validation 驗的是「穩定性」不是「正確性」

#### V2 — 規劃中（`t-regime-engine-v2.md`，待 eng review）

```
Raw OHLCV
    │
    ▼
DynamicBandEngine (Kalman + EWMA)    ← 新增前處理層
    ├── kalmanCenter (零滯後中軌)
    ├── ewmaStdDev (快速波動率)
    ├── effectiveVol = max(ewma, baselineVol)  ← 防 heteroskedasticity
    │
    ├──► Z-score → normalizedReturns[]  ← 餵 Hurst (vol-normalized)
    └──► 3σ 削峰 → smoothedCandles[]    ← 餵 CHOP (抗插針)
              │
              ▼
    CHOP(14h) 短期    ×    Hurst(100h) 長期    ← 長短分離 decorrelate
              │                    │
              └──── 客觀乘法 ──────┘
                       │
                       ▼
              RegimeVector (中性機率，零策略偏見)
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           LP (×1.5)  TF (×0.8) Future strategies
           + CHOP     + delay   (各自解讀)
             panic
```

**核心改進**：
- Kalman+EWMA 過濾雜訊後再餵入分類器（GIGO → clean data）
- CHOP(14) 看「現在」+ Hurst(100) 看「長期特性」→ 消除共線性
- Engine 輸出客觀中性機率，策略偏見放在 consumer 端
- Two-Phase Evolution（引擎 4 維 + 交易邏輯 11 維），防 15 維 overfitting
- Pass/fail：DefenseEV（Saved_IL / Missed_Fees）≥ 1.0

相關檔案：`src/engine/shared/MarketRegimeAnalyzer.ts`、`src/types/index.ts`、`src/engine/lp/mcEngine.ts`、`src/engine/shared/MonteCarloEngine.ts`

### 核心設計原則

- **AppState 注入式**：所有 Service 透過參數注入 AppState，禁止直接修改全域狀態
- **Pure Functions**：所有計算邏輯集中在 `infra/utils/math.ts`，使用原生 BigInt（禁用 decimal.js）
- **TypeScript strict**：禁止 `any`
- **錯誤處理**：所有 RPC 呼叫包 `rpcRetry`，API 失敗 fallback 到本地快取並記錄 `appState.cycleWarnings`
- **Telegram 解耦**：`src/bot/` 只能格式化文字 + 發送，業務邏輯在 `src/market/`、`src/engine/`

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

| 區塊 | 狀態 | Plan |
|------|------|------|
| Self-Learning Regime Engine | ✅ Shipped (PR #19) | — |
| Sharpe-like MC Scoring | ✅ Shipped (PR #20) | — |
| Cloudflare R2 Backup | ✅ Shipped (v0.2.0) | — |
| PositionAdvisor 純函數 | ✅ Shipped (PR #28) | — |
| Position Tracking Matrix Model | ✅ Shipped (PR #29) | `.claude/rules/position-tracking.md` |
| Backtest Verification Harness | 🔧 PR 4 進行中 | `p0-backtest-verification.md` |
| Position Advice System (cycle integration) | 📋 Plan 完成 | `p0-position-advice-system.md` |
| Storage 統一結構 | 📋 Plan 完成 | `i-unify-storage.md` |
| **Trend Follow Strategy (P1)** | 📋 Plan 定稿 (Path A 全完成) | `p1-trend-follow-strategy.md` |
| **Regime Engine V2** | 📋 Plan 完成 (待 eng review) | `t-regime-engine-v2.md` |

詳細路線圖見 [`.claude/tasks.md`](./.claude/tasks.md)。

## 🤝 Contributing

本專案目前由單人維護，遵循嚴格的 plan-driven workflow：

- 所有 feature 必須先有 `.claude/plans/<priority>-<slug>.md`
- 嚴格 TDD（測試先於實作）
- commit message 用繁體中文（不加 `Co-Authored-By` trailer）
- 完整規則見 [`CLAUDE.md`](./CLAUDE.md)
