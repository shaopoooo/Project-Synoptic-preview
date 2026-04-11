# Changelog

All notable changes to DexBot will be documented in this file.

## [0.2.0] - 2026-04-11

### Added
- **Cloudflare R2 Backup 子系統**（DR + Dev Access 雙用途）
  - Daily mirror sync（03:00 Asia/Taipei）：`data/` + `logs/` diff 後上傳到 R2，path + size 比對策略，只增不減。並行上傳限制 5，避免吃光 Railway 頻寬
  - Weekly archive（週日 04:00 Asia/Taipei）：`data/` + `logs/` 打包成 `archives/<weekIso>.tar.gz`，提供 point-in-time recovery；R2 lifecycle rule 90 天自動清理
  - Analysis 攤平索引層：`data/backtest-results/<date>/summary.md` 與 `data/shadow/analysis/<weekIso>.md` 自動攤平到 R2 `analysis/` prefix，依檔名排序看完整時間軸，永久保留
  - `sendBackupFailure` Telegram 告警：任一 cron run 失敗即推，含失敗檔案清單，不設容忍門檻
- 三個手動 CLI restore 腳本
  - `npm run backup:restore-mirror` — 從 R2 mirror 拉回 `data/` + `logs/`（含 safety backup rename + 失敗 rollback 機制）
  - `npm run backup:restore-archive <weekIso>` — 下載指定週 archive 解壓覆蓋本地
  - `npm run backup:list-archives` — 列出 R2 上可用 archive
- `npm run backup:smoke-mirror`：手動驗證 CLI，不啟動 bot 主排程即可對 dev bucket 觸發一次 mirror sync，含 prod bucket 防呆 5 秒等待
- R2_BUCKET 從 env 讀取（default `tradingbot-backup`），支援本地 dev bucket / Railway prod bucket 雙組 token 分離
- `src/types/backup.ts`：MirrorPlan / MirrorResult / AnalysisMirrorResult / ArchiveResult / RestoreResult / ArchiveListing 六個型別
- `.env.sample` 新增 R2 區塊

### Changed
- `src/index.ts` main 啟動流程整合 `createR2Client() + startBackupCron()`；env 缺失時 warn 並略過，不阻擋 bot 主流程
- `.gitignore` 新增 `data.backup-*/` 與 `logs.backup-*/` 模式，防止 restore 產生的 safety backup 被誤 commit

### Security
- **修復 restoreMirror path traversal (HIGH，CSO audit finding #1)**：若 R2 credentials 被盜，攻擊者原本可上傳 `data/../../../.ssh/authorized_keys` 之類的 key，restore 時會逃出 baseDir 寫到 admin 家目錄。新增 `isSafeRelativePath()` 四層檢查（拒絕絕對路徑、拒絕 `..` segment、第一段必須是 `data`/`logs` 白名單、`path.resolve` 後必須仍在 baseDir 之內）
- **restoreArchive tar.x hardening (MEDIUM，CSO audit finding #2)**：`tar.x` 加 filter callback，每個 entry 經同樣檢查再放行；defense-in-depth 疊加在 node-tar v7 預設的 `..` strip 之上
- R2 API token scoping：prod / dev bucket 各一組 token，Object Read & Write 限定單一 bucket（不給 account-level），縮小 blast radius
- 37 個 unit tests 覆蓋 r2Mirror / r2Archive / r2Restore，含 3 個 security regression tests

### Dependencies
- `@aws-sdk/client-s3@3.1024.0` runtime
- `tar@7.5.13` runtime
- `node-cron@4.2.1` runtime
- `aws-sdk-client-mock@4.1.0` dev
- 所有新 dep 通過 7 天版本年齡規則（最新的 `@aws-sdk/client-s3` 發佈已 8 天）

## [0.1.1] - 2026-04-10

### Changed
- **MC score 公式改為 Sharpe-like (`mean / std`)**：取代舊的 `mean / |cvar95|`，避免 cvar95 → 0 時 score 爆炸成天文數字。退化分佈（`std < 1e-6`）回傳 `score = 0`。為 P0 開倉建議系統的 `score > 0.5` 門檻判斷舖路。
- `MCSimResult` 新增 `std` 與 `score` 兩個欄位，score 從 runner 上提到 MC 引擎的內在屬性
- `mcEngine.ts:165` 不再自己算 score，改讀 `c.mc.score`

### Added
- `MCSimParams` 新增 optional `rng?: () => number`，預設 `Math.random`，測試時可注入 `seedrandom` 取得位元相等的決定論結果
- `tests/services/MonteCarloEngine.test.ts`：5 個新測試（M1.1 Sharpe 正常 / M1.2 退化 / M1.3 負 mean / M1.4 rng 決定論 / M2.1 canary snapshot 鎖住 11 個欄位）
- `seedrandom@3.0.5` (devDependency) — 測試專用的決定論 RNG

## [0.1.0] - 2026-04-10

### Added
- Self-Learning Regime Engine：continuous sigmoid+softmax regime vector 取代硬分類，fully soft CVaR gate
- ParameterGenome 模組：9 個可演化基因參數（CHOP/Hurst 門檻、sigmoid 溫度、ATR 窗口、CVaR 安全係數）
- EvolutionEngine：selection/crossover/mutation/seed/immortal 演化搜索
- WalkForwardValidator：4 窗口滾動驗證 + maxDD 30% hard gate
- Blended Bootstrap：MC 模擬按 regime vector 加權從分桶抽樣
- CoinGecko Pro 歷史數據管線：150 天 1H OHLCV 回填 + 每 cycle 增量更新
- DiagnosticStore：JSONL append-only + 環形緩衝，供 /diagnostic 和 /benchmark 查詢
- Telegram 指令：/regime status|candidates|apply|evolve、/diagnostic、/benchmark
- backfillOhlcv.ts 腳本 + `npm run backfill` 指令

### Changed
- MC Engine 解耦 BB：從歷史蠟燭推導 MarketStats（sma/stdDev1H/volatility30D），不再依賴 PoolMarketService
- PoolScanner volume 改讀本地 OHLCV，消除 GeckoTerminal 429
- Prefetch 精簡：移除 fetchPositions/fetchFees/fetchBBs/bandwidthTracker
- index.ts 精簡至 121 行：startup 抽出、per-phase 計時、CycleDiagnostic 收集
- 所有池子價格正規化為相對比率（sma ≈ 1.0），跨池可比較
- PoolScanner vol/TVL/farmApr log 降級為 debug

### Removed
- 硬 trend skip（mcEngine.ts:109-114 的 `if (regime.signal === 'trend') continue`）
- compute.ts、reporting.ts、backgroundTasks.ts（regime engine 驗證不需要）
- CycleData 中的 rawPositions/feeMaps/gasCostUSD/bandwidthAvg30D/marketSnapshots

### Fixed
- CoinGecko Pro pool address 不需要 base_ 前綴（修正 404）
- stdDev1H 已是相對比率，移除多餘的 /sma（修正區間寬度接近零）
- guards 從 USD 轉比率空間（修正 ATR/stdDev1H 單位不匹配）
- prefetch 後加回 appState.commit（修正 MC engine 讀不到 pools）

### Security
- 新增 Telegram Bot Chat ID 授權中間件
- npm audit fix（23→16 漏洞）
- Dockerfile 加 USER app non-root
- package.json 所有版本號精確固定（移除 ^）
- GitHub Actions SHA-pinned
- .gitignore 補 .env.* 萬用字元
