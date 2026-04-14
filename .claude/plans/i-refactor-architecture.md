# Feature: 目錄架構重構（領域驅動）

> 本檔案由 gstack 在 Phase 1 結尾產出，作為交接給 superpowers (Phase 2) 的正式契約。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由 gstack 更新。

## Context（為何要做）
- 來源：`/office-hours` 2026-04-14，design doc 已 APPROVED
- Design doc：`~/.gstack/projects/shaopoooo-dexbot/shao-dev-design-20260414-041800.md`
- 動機：現有目錄以技術分層（runners/services/utils）為組織原則，隨著策略多元化（LP → trend follow → 更多），開發者無法直覺判斷「這個資料夾在做什麼」。趁程式碼量可控（~80 source files）時重構為領域驅動結構。
- 商業價值：降低新增策略的認知負擔，每個策略有獨立子資料夾，共用元件在 engine/shared/

## Decisions（已定案，執行階段不得動搖）
- D1: 採用領域驅動分類（market/engine/backtest/bot/infra）而非技術分層（runners/services/utils）
- D2: engine/ 內部分 shared/（跨策略共用）和 lp/（LP 策略專屬），未來新策略加 engine/{strategy}/
- D3: shared/ 判斷準則：被 2+ 策略引用，或屬於通用分析工具預期被未來策略引用
- D4: position 資料抓取歸 market/position/，position 決策邏輯歸 engine/lp/
- D5: utils/ 消失，內容分散到 infra/（基礎設施）和 bot/（formatter）
- D6: types/ 本次不拆分，保持獨立目錄不動
- D7: 一次性大搬遷（Approach A），一個 branch 一個 PR
- D8: 純搬檔 + 改 import，不改任何邏輯

## Rejected（已否決，subagent 不得再提）
- ❌ 分批搬遷（Approach B）：過渡期 import 混亂，中間 commit 可能 tsc 不過
- ❌ 獨立 position/ 頂層目錄：拆開後 position/ 只剩資料抓取，跟 market 重疊
- ❌ types/index.ts 拆分：本次不做，留後續獨立 PR
- ❌ 保留 runners/：內容分散到 market（prefetch）、engine/lp（mcEngine）、infra（startup）

## Constraints（必須遵守的專案規則）
- 純搬檔 + 改 import，**禁止修改任何業務邏輯**
- TypeScript strict、禁止 `any`
- commit message 用繁體中文，不加 Co-Authored-By
- 所有 `.claude/rules/`、`.claude/plans/`、`README.md`、`.claude/tasks.md` 裡的路徑引用必須一併更新

## 搬遷對照表

### Source files（git mv）

| 來源 | 目標 |
|------|------|
| `src/runners/prefetch.ts` | `src/market/prefetch.ts` |
| `src/runners/mcEngine.ts` | `src/engine/lp/mcEngine.ts` |
| `src/runners/WalkForwardValidator.ts` | `src/engine/shared/WalkForwardValidator.ts` |
| `src/runners/startup.ts` | `src/infra/startup.ts` |
| `src/services/market/PoolScanner.ts` | `src/market/PoolScanner.ts` |
| `src/services/market/PoolMarketService.ts` | `src/market/PoolMarketService.ts` |
| `src/services/market/HistoricalDataService.ts` | `src/market/HistoricalDataService.ts` |
| `src/services/market/TokenPriceService.ts` | `src/market/TokenPriceService.ts` |
| `src/services/dex/FeeCalculator.ts` | `src/market/dex/FeeCalculator.ts` |
| `src/services/dex/FeeFetcher.ts` | `src/market/dex/FeeFetcher.ts` |
| `src/services/events/EventLogScanner.ts` | `src/market/events/EventLogScanner.ts` |
| `src/services/events/StakeDiscovery.ts` | `src/market/events/StakeDiscovery.ts` |
| `src/services/position/PositionScanner.ts` | `src/market/position/PositionScanner.ts` |
| `src/services/position/PositionAggregator.ts` | `src/market/position/PositionAggregator.ts` |
| `src/services/position/NpmContractReader.ts` | `src/market/position/NpmContractReader.ts` |
| `src/services/position/TimestampFiller.ts` | `src/market/position/TimestampFiller.ts` |
| `src/services/strategy/MonteCarloEngine.ts` | `src/engine/shared/MonteCarloEngine.ts` |
| `src/services/strategy/MarketRegimeAnalyzer.ts` | `src/engine/shared/MarketRegimeAnalyzer.ts` |
| `src/services/strategy/EvolutionEngine.ts` | `src/engine/shared/EvolutionEngine.ts` |
| `src/services/strategy/ParameterGenome.ts` | `src/engine/shared/ParameterGenome.ts` |
| `src/services/strategy/RiskManager.ts` | `src/engine/shared/RiskManager.ts` |
| `src/services/strategy/PnlCalculator.ts` | `src/engine/shared/PnlCalculator.ts` |
| `src/services/strategy/BollingerBands.ts` | `src/engine/shared/BollingerBands.ts` |
| `src/services/strategy/PositionCalculator.ts` | `src/engine/lp/PositionCalculator.ts` |
| `src/services/strategy/rebalance.ts` | `src/engine/lp/rebalance.ts` |
| `src/services/strategy/lp/positionAdvisor.ts` | `src/engine/lp/positionAdvisor.ts` |
| `src/services/backup/backupCron.ts` | `src/infra/backup/backupCron.ts` |
| `src/services/backup/r2Archive.ts` | `src/infra/backup/r2Archive.ts` |
| `src/services/backup/r2Client.ts` | `src/infra/backup/r2Client.ts` |
| `src/services/backup/r2Mirror.ts` | `src/infra/backup/r2Mirror.ts` |
| `src/services/backup/r2Restore.ts` | `src/infra/backup/r2Restore.ts` |
| `src/utils/AppState.ts` | `src/infra/AppState.ts` |
| `src/utils/stateManager.ts` | `src/infra/stateManager.ts` |
| `src/utils/logger.ts` | `src/infra/logger.ts` |
| `src/utils/rpcProvider.ts` | `src/infra/rpcProvider.ts` |
| `src/utils/diagnosticStore.ts` | `src/infra/diagnosticStore.ts` |
| `src/utils/formatter.ts` | `src/bot/formatter.ts` |
| `src/utils/math.ts` | `src/infra/utils/math.ts` |
| `src/utils/cache.ts` | `src/infra/utils/cache.ts` |
| `src/utils/validation.ts` | `src/infra/utils/validation.ts` |
| `src/utils/tokenInfo.ts` | `src/infra/utils/tokenInfo.ts` |
| `src/utils/BandwidthTracker.ts` | `src/infra/utils/BandwidthTracker.ts` |
| `src/config/storage.ts` | `src/infra/storage.ts` |

### Test files（git mv）

| 來源 | 目標 |
|------|------|
| `tests/services/PositionAdvisor.test.ts` | `tests/engine/lp/positionAdvisor.test.ts` |
| `tests/services/rebalance.test.ts` | `tests/engine/lp/rebalance.test.ts` |
| `tests/services/MonteCarloEngine.test.ts` | `tests/engine/shared/MonteCarloEngine.test.ts` |
| `tests/services/RegimeVector.test.ts` | `tests/engine/shared/RegimeVector.test.ts` |
| `tests/services/EvolutionEngine.test.ts` | `tests/engine/shared/EvolutionEngine.test.ts` |
| `tests/services/ParameterGenome.test.ts` | `tests/engine/shared/ParameterGenome.test.ts` |
| `tests/services/RiskManager.test.ts` | `tests/engine/shared/RiskManager.test.ts` |
| `tests/services/PnlCalculator.test.ts` | `tests/engine/shared/PnlCalculator.test.ts` |
| `tests/services/BBEngine.test.ts` | `tests/engine/shared/BBEngine.test.ts` |
| `tests/services/BlendedBootstrap.test.ts` | `tests/engine/shared/BlendedBootstrap.test.ts` |
| `tests/services/HistoricalDataService.test.ts` | `tests/market/HistoricalDataService.test.ts` |
| `tests/services/LocalOhlcvVolume.test.ts` | `tests/market/LocalOhlcvVolume.test.ts` |
| `tests/services/deriveMarketStats.test.ts` | `tests/market/deriveMarketStats.test.ts` |
| `tests/services/DiagnosticStore.test.ts` | `tests/infra/DiagnosticStore.test.ts` |
| `tests/services/fastStartup.test.ts` | `tests/infra/fastStartup.test.ts` |
| `tests/services/backup/r2Archive.test.ts` | `tests/infra/backup/r2Archive.test.ts` |
| `tests/services/backup/r2Mirror.test.ts` | `tests/infra/backup/r2Mirror.test.ts` |
| `tests/services/backup/r2Restore.test.ts` | `tests/infra/backup/r2Restore.test.ts` |
| `tests/config/storage.test.ts` | `tests/infra/storage.test.ts` |

### 不動的檔案
- `src/backtest/**` — 不動
- `src/bot/TelegramBot.ts`, `src/bot/alertService.ts`, `src/bot/reportService.ts`, `src/bot/commands/**` — 不動
- `src/config/abis.ts`, `src/config/constants.ts`, `src/config/env.ts`, `src/config/index.ts` — 不動
- `src/scripts/**` — 不動
- `src/types/**` — 不動
- `src/index.ts`, `src/dryrun.ts` — 不動
- `tests/backtest/**` — 不動

## Interfaces（API 契約）

無新增 interface。所有 export/import 維持原樣，只改路徑。

## Test Plan（TDD 起點）

本次不新增測試。驗證方式：
- `npx tsc --noEmit` 零 error
- `npm test` 全綠（現有 171+ tests）
- `grep -rn "from '.*services/" src/ tests/` 零結果
- `grep -rn "from '.*runners/" src/ tests/` 零結果
- `grep -rn "from '.*utils/" src/ tests/` 零結果（除了 `infra/utils/` 的合法引用）

## Tasks（執行順序）

### Stage 1: 搬檔 + 修 import + 驗證（單一 PR）

**Group 1.A: 建立目錄結構 + git mv 所有檔案**
- Task 1.A.1: 建立新目錄結構（mkdir -p）
- Task 1.A.2: git mv 所有 source files（按搬遷對照表）
- Task 1.A.3: git mv 所有 test files（按搬遷對照表）
- Task 1.A.4: 刪除空的舊目錄（runners/, services/, utils/）

**Group 1.B: 修正所有 import path**
- Task 1.B.1: 修正 src/ 下所有 import（tsc --noEmit 驅動，迭代至零 error）
- Task 1.B.2: 修正 tests/ 下所有 import
- Task 1.B.3: 驗證 grep 無殘留舊路徑

**Group 1.C: 更新文件路徑引用**
- Task 1.C.1: 更新 `.claude/rules/*.md` 中的路徑
- Task 1.C.2: 更新 `.claude/plans/*.md` 中的路徑
- Task 1.C.3: 更新 `.claude/tasks.md` 中的路徑
- Task 1.C.4: 更新 `README.md` 中的架構段落
- Task 1.C.5: 更新 `CLAUDE.md` 中的路徑引用（如有）

**Group 1.D: 最終驗證**
- Task 1.D.1: `npx tsc --noEmit` 零 error
- Task 1.D.2: `npm test` 全綠
- Task 1.D.3: grep 驗證無殘留舊路徑 import
- Task 1.D.4: 確認 `src/` 下只剩 market/, engine/, backtest/, bot/, config/, infra/, types/, scripts/, index.ts, dryrun.ts

## Pass Criteria
- `npm test` 全綠
- `npx tsc --noEmit` 零 error
- `grep -rn "from '.*services/" src/ tests/` 零結果
- `grep -rn "from '.*runners/" src/ tests/` 零結果
- 頂層只剩預期的資料夾
