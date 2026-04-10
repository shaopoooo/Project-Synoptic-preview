# Changelog

All notable changes to DexBot will be documented in this file.

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
