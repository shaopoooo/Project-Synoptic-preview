# Feature: P0 Backtest Verification（PositionAdvisor 閾值驗證系統）

> 本檔案由 gstack 在 Phase 1 結尾產出，作為交接給 superpowers (Phase 2) 的正式契約。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由 gstack 更新。

## Context（為何要做）

- **來源**：
  - 對話 brainstorming session（2026-04-10），代號 B2
  - 與 `.claude/plans/p0-position-advice-system.md` 並行的子 plan，負責驗證 PositionAdvisor 閾值的訊號品質
  - P0 plan 原本只寫「用 24h+ live data 驗證」，本 plan 把這個語焉不詳的描述展開為完整可執行設計

- **動機與商業價值**：
  - PositionAdvisor 的核心決策依賴幾個關鍵閾值：`sharpeOpen`、`sharpeClose`、`atrMultiplier`，這些當前都是經驗值
  - **未經驗證就 ship 等於把使用者當白老鼠**：閾值錯誤會造成 advice 太頻繁（轟炸）或太稀疏（錯過機會）
  - 必須在 P0 進入生產之前，用歷史 OHLCV 資料系統性地驗證閾值合理性
  - Ship 之後也需要持續監測閾值是否漂移，提供動態調整的機制
  - **未來多策略場景**：P1 plan 已決定加入 FundingRateStrategy 等新策略，本 backtest 框架必須支援未來擴展，但**現在不過早抽象**

## Decisions（已定案，執行階段不得動搖）

### 整體方法

1. **Hybrid 三階段驗證架構**
   - **Stage 1 — Offline Replay**（ship 前一次性）：用 5 個月 OHLCV 歷史資料跑 grid search，選出 initial thresholds，必須通過絕對底線才允許 ship
   - **Stage 2 — Shadow Mode**（ship 後持續）：每 cycle 寫 ShadowSnapshot 到月歸檔 jsonl，每週日跑 counterfactual analyze 並推送 Telegram 週報
   - **Stage 3 — Manual Tune**（被觸發才執行）：偵測到連續 2 週同方向紅標時，開新 brainstorming session 討論調整案，**不**自動改 config

### 三項驗證指標

2. **指標 A — vs HODL outperformance**
   - 公式：`(LP_final_value - HODL_final_value) / HODL_final_value`
   - 商業敘事指標，使用者直接看的數字
3. **指標 C — Hit Rate**
   - 公式：`sum(in-range hours) / lifetime hours`
   - 訊號可信度指標，binary 性質
4. **指標 D — LP Net Profit**
   - 公式：`fee_income - impermanent_loss - gas_cost`
   - 絕對 LP 賺賠指標
5. **三指標加權**：`0.4 × A_normalized + 0.3 × C_normalized + 0.3 × D_normalized`（min-max normalize）

### Outcome Window

6. **自然生命週期 + 7 天 hard cap**
   - hypothetical position 開倉後，由同一份 PositionAdvisor 邏輯判定何時關倉
   - close 條件觸發任一條件即結算：trend_shift / il_threshold / opportunity_lost / timeout
   - 若 7 天內 close 都未觸發 → 強制結算，closeReason='hard_cap_7d'
   - 同時驗證 open 與 close 兩側的閾值品質

### Pass/Fail 標準

7. **絕對底線**（防災難）
   - `A > 0`（vs HODL 必須贏）
   - `D > 0`（LP 淨利必須為正）
   - `C ≥ 0.5`（hit rate 過半）
   - 任一條件不通過 → P0 不 ship，退回 Decisions review
8. **相對最佳**（在通過絕對底線的組合中，選加權分數最高）
9. **Sanity benchmark**：把 plan 原 hypothesis（Sharpe 0.5, ATR 2×）放進 grid，回報它的排名，作為「直覺準度」的參考

### 兩 Pass 架構（避免重複計算）

10. **Pass 1 — Feature Extraction**（跑一次）
    - 對每個池子的每根歷史 candle，跑 mcEngine + regime engine + 範圍計算
    - 輸出 `data/backtest-results/<date>/features.jsonl` 作為快取
    - 使用固定 seed = cycleIdx 確保可重現
11. **Pass 2 — Decision Sweep**（每個閾值組合跑一次）
    - 從 features cache 讀取，純記憶體運算
    - 每組 sweep 在秒級完成

### 兩階段 Grid Search（Coarse → Fine）

12. **粗 grid**（Pass 1 raw 模式，不啟用 hysteresis）
    - `Sharpe (open)`: {0.30, 0.40, 0.50, 0.60, 0.70, 0.80}
    - `Sharpe (close)`: {0.20, 0.30, 0.40}
    - `ATR multiplier`: {1.5, 2.0, 2.5, 3.0}
    - 共 6 × 3 × 4 = 72 組合
13. **Top-5 篩選**：粗 grid 結果中通過絕對底線的組合，按加權分數排序，取 top 5 進細 grid
14. **細 grid**（Pass 2 full-state 模式，啟用 hysteresis）
    - 對每個 top-5 候選做 ±1 格鄰域展開（每軸 ±0.05 / ±0.25）
    - 共 5 × 27 = 135 組合
    - 加上原 72 粗組合，總 sweep 數 = 207

### Cycle 粒度與資料對齊

15. **Replay cycle 粒度 = 1 小時**（對齊 OHLCV）
    - 生產環境 cycle 是 10 分鐘，但 OHLCV 是小時級
    - replay 模擬「每小時一個 cycle」，這是必要的簡化，不影響閾值驗證的本質

### Temporal Split（B4，60/20/20）

16. **強制時序切分**
    - Train (60%): 2025-11-10 → 2026-01-21（~72 天）
    - Validation (20%): 2026-01-22 → 2026-02-29（~39 天）
    - Test (20%): 2026-03-01 → 2026-04-10（~41 天）
    - 邊界寫死在 `src/backtest/config.ts`
17. **三段驗證流程**
    - Train：跑 C4 adaptive grid search，選出「候選最佳閾值」
    - Validation：把 train 選出的閾值套到 val window，檢查仍通過絕對底線且加權分數 ≥ top 20%
    - Test：把 val 通過的閾值跑最終 pass/fail，這個結果決定是否 ship

### Fee Income 計算與 Sensitivity

18. **Fee 估算公式**
    ```
    hourly_fee = candle.volume × pool.fee_tier × (position_capital / pool_tvl_proxy) × in_range_multiplier
    ```
19. **Sensitivity 分析**：整個 grid search 跑 3 次，分別用 `tvl_multiplier ∈ {0.5, 1.0, 2.0}`
    - 三次都指向同一批 top-3 thresholds → robust，寫入 P0 plan
    - 三次結果差異大 → summary.md 標註敏感度警告，降低 Stage 1 決策權重

### Pool Universe

20. **全 7 池**（A1）
    - 不分 ETH pool / stablecoin pool 等子類
    - 異質性的雜訊由 walk-forward validation 與 sensitivity 自然處理

### Framework / Strategy 兩層架構（多策略未來的關鍵決策）

21. **物理隔離 + 不過早抽象**
    - 共用 framework 放 `src/backtest/framework/`（GridSearcher / WalkForwardSplit / OutcomeAggregator / SensitivityRunner）
    - V3 LP 特定 code 放 `src/backtest/v3lp/`（featureExtractor / replayDriver / outcomeCalculator）
    - Shadow mode 同樣 framework / v3lp 兩層
    - **暫時不抽 `StrategyBacktest` interface**（等 P1 加 FundingRateStrategy 時才抽）
    - 對應 CLAUDE.md「Three similar lines is better than premature abstraction」原則

### Shadow Mode 設計

22. **`ShadowSnapshot` 型別與 `ReplayFeature` 解耦**
    - 兩者各自獨立的 type 定義，不共用 schema
    - 共用的核心決策邏輯由 PositionAdvisor 純函數提供（single source of truth）
23. **每 cycle all-candidate snapshot**
    - 主 cycle 結束時，對每個池子組裝一筆 ShadowSnapshot
    - 寫入 `data/shadow/<YYYY-MM>.jsonl`（月歸檔）
24. **ShadowSnapshot 含完整 debug 欄位**
    - `currentThresholds`（記錄當下生產用的閾值版本）
    - `hysteresisCounters`（記錄當下 hysteresis 累積狀態）
    - 增加約 90 bytes / snapshot，年增約 300 MB，在 R2 free tier 內
25. **schemaVersion = 1** inline 在每筆 snapshot，未來 schema 演進的 migration 依據

### 邏輯共用機制

26. **PositionAdvisor pure functions = 單一決策來源**
    - Stage 1 `replayDriver` 與 Stage 2 `shadowAnalyzer` 都直接呼叫 advisor 的 3 個函數（`recommendOpen` / `classifyExit` / `shouldClose`）
    - **不**引入 sweeper / adapter / SweeperInput 中間抽象
    - Driver 各自寫一份「迭代邏輯 + hypothetical position state 維護」（V3 LP 約 80 行 each）

### Weekly Telegram 報告

27. **報告結構**：
    - 當前閾值、當前 A/C/D、加權分數
    - **Per-pool A 指標表格**（7 池 × A%）
    - 最佳替代閾值與差距
    - **Sample advice**：1 best + 1 worst（依「預期 vs 實現差距」排序）
    - 狀態：✅ Stable / 🟡 Yellow / 🚨 Red
    - 連結到完整報告 markdown
28. **三態狀態定義**：
    - 🟢 Stable：bestAlt 與 current 差距 < 50% 紅色門檻
    - 🟡 Yellow：差距 50%-100% 紅色門檻
    - 🚨 Red：差距 ≥ 紅色門檻
29. **紅色門檻**：
    - `|sharpeOpen 差距| ≥ 0.1`
    - `|sharpeClose 差距| ≥ 0.1`
    - `|atrMultiplier 差距| ≥ 0.25`
30. **連續 4 週 Yellow → 軟提示**（不正式 trigger Stage 3）

### Stage 3 Trigger 邏輯

31. **嚴格 trigger 條件**（A2 + B1 + C1 組合）
    - **A2**：連續 2 週紅標
    - **B1**：嚴格連續，中間任何非 Red 都打斷
    - **C1**：嚴格同方向（單一閾值軸獨立判斷，必須兩週對同一軸朝同方向）
32. **Trigger 後行為**
    - 推 Telegram「Stage 3 trigger」通知，含「連續 N 週建議 X 軸朝 Y 方向 +Z」
    - **不**自動改 config
    - 由 admin 決定是否開新 brainstorming session
    - 若決定調整 → 走正常 plan 流程（新開 plan 檔案 → TDD → ship）
    - 若決定不調 → 在週報註記「judged as noise」

### Sample Advice 選擇標準

33. **依「預期 vs 實現差距」排序**
    - Best = `realized A - expected A` 最高（超預期最多）
    - Worst = `realized A - expected A` 最低（落後預期最多）
    - 衡量 advisor 的預測準度，不是賺多少
    - 數量：1 best + 1 worst（共 2 筆）

### `.gitignore` 與 Analysis 索引層

34. **完全排除 backtest-results 與 shadow log**
    ```gitignore
    data/backtest-results/
    data/shadow/
    ```
35. **R2 backup 增加 analysis/ 雙路徑 mirror**（已寫入 `.claude/plans/i-r2-backup.md` Decision #15）
    - `data/backtest-results/<date>/summary.md` → `analysis/backtest-<date>-summary.md`
    - `data/shadow/analysis/<weekIso>.md` → `analysis/shadow-<weekIso>.md`
    - 攤平命名讓 R2 console list 即可看到完整時間軸

### PR 切分

36. **Stage 1 與 Stage 2 屬於不同 PR**
    - Stage 1（offline replay tool）= PR 4，獨立、不入生產
    - Stage 2（shadow infrastructure）= PR 5 的一部分（與 P0 plan 的 Stage 3-5 同 PR）
    - PR 4 跑出 grid search 結果 → 把 chosen thresholds 寫進 PR 5 的 config
    - 詳細 PR 切分見 P0 plan 結尾的「PR 切分」段落

## Rejected（已否決，subagent 不得再提）

### 整體方法
- ❌ **純 Offline Replay 不做 Shadow Mode**：ship 後沒有 feedback loop，無法偵測 regime drift
- ❌ **純 Shadow Mode 不做 Offline Replay**：第一週 ship 沒有 baseline，使用者當白老鼠
- ❌ **純 Live Accumulation（無 backtest 階段）**：使用者承受未驗證閾值的轟炸風險

### 指標選擇
- ❌ **單一 PnL vs HODL 指標**：忽略風險，可能大賺一次但每次都在 drawdown 邊緣跳
- ❌ **單一 Sharpe of realized position**：在單倉位尺度太雜訊
- ❌ **單一 Hit Rate**：忽略大小，一次小命中 = 一次大命中
- ❌ **單一 Composite LP Profit**：缺乏 baseline 對照，無法判斷「相對好壞」

### Pass/Fail 設計
- ❌ **絕對閾值（任意數字）**：缺乏依據，市場壞時所有閾值都不通過會卡住
- ❌ **純相對最佳**：沒有品質 floor，可能選出「跟所有其他選項一樣爛、但剛好最不爛」的閾值
- ❌ **Baseline 對照勝率（vs always_recommend / never_recommend）**：在 LP 低樣本領域容易產生「統計不顯著 vs 實質顯著」爭論
- ❌ **絕對 + Baseline 雙重檢查**：對單人決策過度複雜

### Outcome Window
- ❌ **固定 N 小時 outcome window**：只驗證 open 決策，close 邏輯完全沒被檢驗
- ❌ **多個固定 window 並存**：資料量暴增，分析時要決定哪個 window 才是主要指標
- ❌ **Outcome = 下一次 advice 發出前的時段**：window 邊界武斷
- ❌ **無 hard cap**：若 close 條件永遠不觸發，position 會無限延長

### Fee Income
- ❌ **固定假設 APR（與 legacy BacktestEngine 相同的 40%）**：不同 pool APR 差異極大
- ❌ **用「當前觀察 APR」作 proxy**：snapshot trap，當前 APR ≠ 歷史 APR
- ❌ **加 concentrated liquidity multiplier 修正**：premature optimization，引入 range width 非線性偏好
- ❌ **放棄絕對 D，只用相對 D**：破壞 `D > 0` 絕對底線的物理意義

### Pool Universe
- ❌ **只用 ETH-based pools**：人工分類本身會污染驗證
- ❌ **分組獨立 grid search**：違反 plan 目前「全域統一閾值」的假設

### Train/Test Split
- ❌ **單一全期跑完**：過擬合風險高
- ❌ **80/20 split**：若最後 1 個月剛好特殊狀態，結論被單一事件污染
- ❌ **Walk-forward validation**（B3）：對 single-dev 過重，雖然這是 P1 plan 的方向但 backtest plan 不需要這麼複雜
- ❌ **隨機切分（非時序）**：lookahead bias，未來資料洩漏到訓練集

### Grid 密度
- ❌ **粗 grid 9 組**：峰值可能落在格子之間
- ❌ **細 grid 77 組**：解讀成本高，肉眼看 77 組結果不切實際
- ❌ **中 grid 24 組固定**：捨棄精準定位
- ❌ **C4 adaptive**：選擇 C4 的理由就在 Decisions

### 架構抽象
- ❌ **Sweeper + Adapter 中間層**：硬塞 sweeper 中間層干擾 PositionAdvisor 作為 single source of truth
- ❌ **100% 複製兩份決策邏輯**：兩份漂移風險高
- ❌ **直接寫 `StrategyBacktest` interface**：只有 V3 LP 一個 implementation，premature abstraction
- ❌ **flat 結構（不分 framework / strategy 子目錄）**：未來 P1 加 FundingRate 時要大重構

### Shadow Mode
- ❌ **省略 debug 欄位**（currentThresholds / hysteresisCounters）：debug 場景的成本不對稱
- ❌ **schema 共用**（ReplayFeature 與 ShadowSnapshot 用同一型別）：未來 schema 演進綁手綁腳
- ❌ **Bot 啟動時 auto-bootstrap shadow log**：違反 PositionAdvisor 「fire-and-forget logger」原則

### Telegram 報告
- ❌ **無 per-pool 拆解**：debug 困難
- ❌ **加「與上週比較」trend**：增加噪音，4 週移動平均更複雜
- ❌ **Sample advice 用 PnL / D 排序**：只看大小，無法衡量 advisor 預測準度
- ❌ **Sample advice 4 筆**：訊息過長
- ❌ **Sample advice 只看 worst**：失去正面回饋

### Stage 3 Trigger
- ❌ **1 週紅標就 trigger**（A1）：單週雜訊容易誤觸發
- ❌ **3 週紅標才 trigger**（A3）：反應太慢
- ❌ **Yellow 視為弱 Red 填補（B2）**：增加邏輯分支與測試 case
- ❌ **取消同方向（C2/C3）**：方向反覆翻轉的閾值調整會被下週反向動

### Plan 與 PR 結構
- ❌ **B2 全部塞進 P0 plan**：P0 plan 體積爆炸
- ❌ **完全分離（不做索引）**：讀 P0 plan 看不到 backtest 存在
- ❌ **2 PR 大粒度**：5000+ 行 PR 對單人 review 是災難
- ❌ **bot 自動 commit weekly markdown 到 git**：自動 push 是反 pattern
- ❌ **手動 cp 到 docs/backtest-history/**：依賴人工紀律

### 一般原則
- ❌ **Plan 標註時間預估**：違反 CLAUDE.md「Avoid giving time estimates」原則

## Constraints（必須遵守的專案規則）

- **`.claude/rules/architecture.md`**：
  - Service / driver 必須透過參數注入依賴
  - Backtest tool 不直接修改生產 AppState
  - 新 feature 必須先更新 `.claude/tasks.md`

- **`.claude/rules/pipeline.md`（Phase 0 / Phase 1 分離）**：
  - Backtest harness 是 **offline 工具**，不在生產 cycle 內
  - shadow logger 在生產 cycle 結尾呼叫，屬於 fire-and-forget IO（不阻擋主邏輯）
  - 所有 backtest 計算必須是 pure function（無外部 IO）

- **`.claude/rules/math.md`**：
  - Outcome calculator、grid searcher、walk-forward split 全部 pure function
  - 共用數學工具集中在 `utils/math.ts`
  - 禁用 decimal.js，使用原生 BigInt 或既有 V3 SDK Math

- **`.claude/rules/naming.md`**：
  - 純函式模組：`camelCase.ts`
  - 型別檔案放 `src/types/`，命名 `replay.ts` / `shadow.ts`（依當前單策略命名，未來多策略再加 suffix）
  - TypeScript strict，**禁止 `any`**
  - 常數：`UPPER_SNAKE_CASE`

- **`.claude/rules/services.md`**：
  - 複雜金融邏輯（fee income、IL、HODL counterfactual、weighted scoring）必須有清楚的中文註解 + 公式推導
  - DEX 差異封裝在 v3lp 子目錄，未來新策略走 fundingRate 等子目錄

- **`.claude/rules/logging-errors.md`**：
  - 禁用 `console.log`，統一 `createServiceLogger`
  - feature extraction 中 mcEngine 失敗 → 該 cycle 寫 null 並 log warning，不中斷整體 extract
  - shadow logger 失敗 → push 到 `appState.cycleWarnings`，不 throw

- **`.claude/rules/security.md`**：
  - Backtest 不涉及私鑰、API key
  - shadow log 不應包含敏感資料（不要把 wallet address 完整 hash 寫進去）

- **`.claude/rules/telegram.md`**：
  - `src/bot/alertService.ts` 的新方法（`sendShadowWeeklyReport`、`sendPhase5cTrigger`）只負責格式化 + 發送
  - 業務邏輯（counterfactual 計算、紅標判定）在 `shadowAnalyzer` / `phase5cTrigger`

- **`.claude/rules/testing.md`**：
  - 60 個 RED 測試在實作前完成
  - mock S3Client 用 `aws-sdk-client-mock`（與 R2 backup plan 一致）
  - 本地檔案 fixtures 用 jest tmp dir

- **依賴**：
  - 本 plan 依賴 `.claude/plans/p0-position-advice-system.md` 的 PositionAdvisor 純函數已實作
  - 本 plan 依賴 `.claude/plans/i-r2-backup.md` 的 R2 backup 已 ship（為 shadow log 提供 backup）

## Interfaces（API 契約）

### `src/types/replay.ts`（NEW，Stage 1 專用）

```ts
import type { RegimeVector } from './index';

/** Stage 1 用：從 OHLCV replay 產出的 per-pool per-cycle 特徵 */
export interface ReplayFeature {
  poolId: string;
  poolLabel: string;
  ts: number;                  // unix seconds
  cycleIdx: number;            // 從 0 開始

  // mcEngine 產出（固定 seed = cycleIdx）
  mcScore: number | null;
  mcMean: number | null;
  mcStd: number | null;
  mcCvar95: number | null;

  // regime engine 產出
  regime: RegimeVector | null;

  // 範圍候選
  PaNorm: number | null;
  PbNorm: number | null;
  atrHalfWidth: number | null;

  // 當下市場狀態
  currentPriceNorm: number;
  candleVolume: number;
  poolTvlProxy: number;
  poolFeeTier: number;
}

/** Decision sweep 時用：hypothetical position 的生命週期追蹤 */
export interface HypotheticalPosition {
  positionId: string;          // `${poolId}:${openTs}`
  poolId: string;
  openedAtCycle: number;
  openedAtTs: number;
  openPriceNorm: number;
  PaNorm: number;
  PbNorm: number;
  initialCapital: number;
  feesAccumulated: number;
  outOfRangeSinceMs: number | null;
  closedAtCycle: number | null;
  closedAtTs: number | null;
  closeReason: 'trend_shift' | 'il_threshold' | 'opportunity_lost' | 'timeout' | 'hard_cap_7d' | null;
}

/** A/C/D 三指標的結算結果 */
export interface PositionOutcome {
  position: HypotheticalPosition;
  durationHours: number;
  expectedReturnPct: number;   // 開倉時 mcEngine 的 expected return

  // A 指標
  lpFinalValue: number;
  hodlFinalValue: number;
  outperformancePct: number;

  // C 指標
  hitRate: number;

  // D 指標
  feeIncome: number;
  impermanentLoss: number;
  gasCost: number;
  lpNetProfit: number;
}

/** Threshold 三軸組合 */
export interface ThresholdSet {
  sharpeOpen: number;
  sharpeClose: number;
  atrMultiplier: number;
}

/** Grid search 的 search space */
export interface GridSpace {
  sharpeOpen: readonly number[];
  sharpeClose: readonly number[];
  atrMultiplier: readonly number[];
}
```

### `src/types/shadow.ts`（NEW，Stage 2 專用，與 ReplayFeature 解耦）

```ts
import type { RegimeVector } from './index';
import type { ThresholdSet } from './replay';

/** Stage 2 用：生產環境每 cycle 的快照 */
export interface ShadowSnapshot {
  schemaVersion: 1;
  cycleNumber: number;
  ts: number;                  // unix ms
  poolId: string;
  poolLabel: string;

  // mcEngine 產出
  mcScore: number | null;
  mcMean: number | null;
  mcStd: number | null;
  mcCvar95: number | null;

  // regime engine 產出
  regime: RegimeVector | null;

  // 候選範圍
  PaNorm: number | null;
  PbNorm: number | null;
  atrHalfWidth: number | null;

  // 當下市場狀態
  currentPriceNorm: number;
  currentPriceRaw: number;

  // 本 cycle 實際 advisor 行為
  triggered: {
    open: boolean;
    close: boolean;
    rebalance: boolean;
  };

  // 當下生產用的閾值（debug 欄位）
  currentThresholds: ThresholdSet;

  // 倉位狀態（若該池有倉位）
  positionState: {
    positionId: string;
    inRange: boolean;
    outOfRangeSinceMs: number | null;
    cumulativeIlPct: number | null;
  } | null;

  // Hysteresis 狀態（debug 欄位）
  hysteresisCounters: {
    openCounter: number;
    closeCounter: number;
  };
}

/** 三態狀態 */
export type ShadowStatus = 'stable' | 'yellow' | 'red';

/** 週分析結果 */
export interface WeeklyAnalysis {
  weekIso: string;             // "2026-W15"
  periodStart: number;
  periodEnd: number;
  totalSnapshots: number;
  activeThresholds: ThresholdSet;

  // 當前閾值下的 A/C/D
  current: { A: number; C: number; D: number; weighted: number };

  // 每池 A 指標
  perPoolA: Array<{ poolLabel: string; A: number }>;

  // Counterfactual 結果
  alternatives: Array<{
    threshold: ThresholdSet;
    A: number;
    C: number;
    D: number;
    weighted: number;
  }>;
  bestAlternative: ThresholdSet;

  // 狀態
  status: ShadowStatus;
  redFlagAxis: 'sharpeOpen' | 'sharpeClose' | 'atrMultiplier' | null;
  redFlagDirection: 'up' | 'down' | null;

  // Sample advice
  sampleBest: {
    poolLabel: string;
    openedTs: number;
    rangeWidthPct: number;
    expectedA: number;
    realizedA: number;
    closeReason: string;
  } | null;
  sampleWorst: typeof sampleBest;
}
```

### `src/backtest/framework/`（策略無關）

```ts
// gridSearcher.ts
export function runCoarseGrid(
  features: ReplayFeature[],
  driver: V3LpReplayDriver,
  space: GridSpace,
): SweepResult[];

export function selectTopCandidates(results: SweepResult[], topN: number): ThresholdSet[];

export function runFineGrid(
  features: ReplayFeature[],
  driver: V3LpReplayDriver,
  topCandidates: ThresholdSet[],
): SweepResult[];

// walkForwardSplit.ts
export interface TemporalSplit {
  trainStart: number;
  trainEnd: number;
  valStart: number;
  valEnd: number;
  testStart: number;
  testEnd: number;
}
export function temporalSplit(
  startTs: number,
  endTs: number,
  ratios: { train: number; val: number; test: number },
): TemporalSplit;

// outcomeAggregator.ts
export interface AggregatedMetrics {
  A: number;
  C: number;
  D: number;
  weighted: number;
  passesAbsoluteFloor: boolean;
}
export function aggregateOutcomes(outcomes: PositionOutcome[]): AggregatedMetrics;

// sensitivityRunner.ts
export interface SensitivityResult {
  tvlMultiplier: number;
  topThresholds: ThresholdSet[];
}
export function runSensitivity(
  features: ReplayFeature[],
  driver: V3LpReplayDriver,
  space: GridSpace,
): {
  results: SensitivityResult[];
  isRobust: boolean;
};
```

### `src/backtest/v3lp/`（V3 LP 特定）

```ts
// featureExtractor.ts
export async function extractFeatures(
  ohlcvFiles: string[],
): Promise<ReplayFeature[]>;

// replayDriver.ts
export class V3LpReplayDriver {
  constructor(private features: ReplayFeature[]);
  run(threshold: ThresholdSet, mode: 'raw' | 'full-state'): PositionOutcome[];
}

// outcomeCalculator.ts
export function computeOutcome(
  position: HypotheticalPosition,
  featuresInLifecycle: ReplayFeature[],
  tvlMultiplier: number,
): PositionOutcome;
```

### `src/services/shadow/`（Stage 2）

```ts
// shadowLogger.ts
export async function writeShadowSnapshots(
  snapshots: ShadowSnapshot[],
): Promise<void>;

// v3lp/shadowDriver.ts
export class V3LpShadowDriver {
  constructor(private snapshots: ShadowSnapshot[]);
  runCounterfactual(currentThresholds: ThresholdSet): {
    current: AggregatedMetrics;
    alternatives: Array<{ threshold: ThresholdSet; metrics: AggregatedMetrics }>;
  };
}

// framework/weeklyAnalyzer.ts
export async function runWeeklyAnalysis(): Promise<WeeklyAnalysis>;

// framework/phase5cTrigger.ts
export interface Phase5cDecision {
  shouldTrigger: boolean;
  reason: string;
  detectedAxis?: 'sharpeOpen' | 'sharpeClose' | 'atrMultiplier';
  detectedDirection?: 'up' | 'down';
}
export function checkPhase5cTrigger(history: WeeklyAnalysis[]): Phase5cDecision;

// v3lp/shadowReportFormatter.ts
export function formatWeeklyReport(analysis: WeeklyAnalysis): string;
```

### `src/bot/alertService.ts`（MODIFY）

```ts
sendShadowWeeklyReport(analysis: WeeklyAnalysis): Promise<void>;
sendPhase5cTrigger(decision: Phase5cDecision): Promise<void>;
```

### `src/runners/mcEngine.ts`（MODIFY）

在 cycle 結尾、advisor 判斷完成後，組裝 ShadowSnapshot[] 並 fire-and-forget 呼叫 shadowLogger。**這個整合屬於 P0 plan Stage 4 task 17.5 的範疇**。

### `package.json`（MODIFY）— 新增 npm scripts

```json
{
  "scripts": {
    "backtest:phase5a": "dotenvx run -f .env -- ts-node src/backtest/runPhase5aBacktest.ts"
  }
}
```

## Test Plan（TDD 起點，RED 階段的測試清單）

**測試先行原則**：所有 60 個測試在實作前完成 RED 階段。
**Mock 策略**：S3Client 用 `aws-sdk-client-mock`；本地檔案系統用 jest tmp dir；mcEngine 用固定 seed 確保可重現。

### Group 1: Framework 層

#### `tests/backtest/framework/gridSearcher.test.ts` — 6 cases
- [ ] RED: 粗 grid 給定 6×3×4=72 組合，sweeper 被呼叫 72 次
- [ ] RED: Top-5 篩選邏輯：72 組結果中，按加權分數排序選 top 5 進細 grid
- [ ] RED: 細 grid 對每個 top-5 候選做 ±1 格鄰域展開，產生 27×5=135 組
- [ ] RED: 通過絕對底線（A>0, D>0, C≥50%）的組合才進 top-5 ranking
- [ ] RED: 全部組合都不通過絕對底線 → 回傳 `noFeasibleThreshold` 結果而非 throw
- [ ] RED: 加權公式 `0.4A + 0.3C + 0.3D` 在 min-max normalize 後計算正確

#### `tests/backtest/framework/walkForwardSplit.test.ts` — 4 cases
- [ ] RED: 60/20/20 temporal split 對 153 天資料 → train 92 天、val 31 天、test 30 天
- [ ] RED: split 邊界不重疊（train 結束日期 + 1 = val 起始日期）
- [ ] RED: split 結果是時序連續的，不是隨機抽樣
- [ ] RED: 短資料（< 30 天）→ throw 明確錯誤訊息

#### `tests/backtest/framework/outcomeAggregator.test.ts` — 5 cases
- [ ] RED: 給定一組 PositionOutcome[]，正確聚合 A 為 mean(outperformancePct)
- [ ] RED: C 為 mean(hitRate)
- [ ] RED: D 為 sum(lpNetProfit)
- [ ] RED: 絕對底線檢查：A=0.01, D=1, C=0.51 → 通過；A=-0.01 → 失敗
- [ ] RED: 加權分數 = 0.4×A_norm + 0.3×C_norm + 0.3×D_norm

#### `tests/backtest/framework/sensitivityRunner.test.ts` — 3 cases
- [ ] RED: 對 TVL multiplier ∈ {0.5, 1.0, 2.0} 各跑一次完整 grid search
- [ ] RED: 三次結果指向同一批 top-3 thresholds → robust=true
- [ ] RED: 三次結果指向不同 thresholds → robust=false，summary.md 含警告

### Group 2: V3 LP Strategy 層

#### `tests/backtest/v3lp/featureExtractor.test.ts` — 5 cases
- [ ] RED: 從 OHLCV 7 池資料 extract → 每池每 hour 一筆 ReplayFeature
- [ ] RED: 固定 seed = cycleIdx → 同一份 OHLCV 兩次 extract 結果完全相同
- [ ] RED: mcEngine 在某 cycle 失敗 → 該 ReplayFeature 的 mc 欄位為 null，不中斷整體 extract
- [ ] RED: regime engine 在某 cycle 失敗 → 該 ReplayFeature 的 regime 欄位為 null
- [ ] RED: extract 結果按 (poolId, ts) 唯一，無重複

#### `tests/backtest/v3lp/replayDriver.test.ts` — 7 cases
- [ ] RED: 模式 'raw'（不啟用 hysteresis）— score 過門檻立即視為觸發
- [ ] RED: 模式 'full-state'（啟用 hysteresis）— 連續 2 cycle 過門檻才觸發
- [ ] RED: open advice 觸發後在 hypothetical positions Map 內建立 entry
- [ ] RED: hypothetical position 在 close 條件（trend / il / opportunity / timeout）觸發時被結算到 outcomes
- [ ] RED: hard cap 7 天到期 → 強制結算，closeReason='hard_cap_7d'
- [ ] RED: rebalance（穿出 + 深度淺 + range regime）→ 模擬關舊倉開新倉，扣 gas
- [ ] RED: 收尾時還開著的 position → 用最後 feature 強制結算

#### `tests/backtest/v3lp/outcomeCalculator.test.ts` — 6 cases
- [ ] RED: A 指標 = (LP final value - HODL final value) / HODL final value
- [ ] RED: C 指標 = sum(in-range hours) / lifetime hours
- [ ] RED: D 指標 = fee_income - IL - gas_cost
- [ ] RED: fee_income 計算 = Σ(hourly_fee × in_range_multiplier)，hourly_fee = volume × fee_tier × (capital / pool_tvl)
- [ ] RED: IL 計算用 V3 constant product 公式
- [ ] RED: HODL counterfactual 用倉位開啟時的 50/50 split 加上實際價格變化

### Group 3: Shadow 層

#### `tests/backtest/shadow/shadowLogger.test.ts` — 4 cases
- [ ] RED: snapshot 寫入 `data/shadow/<YYYY-MM>.jsonl`（月歸檔）
- [ ] RED: snapshot 含 `currentThresholds` + `hysteresisCounters` 完整 debug 欄位
- [ ] RED: 寫檔失敗 → log warning + push appState.cycleWarnings，不 throw
- [ ] RED: schemaVersion = 1 永遠 inline 在 snapshot

#### `tests/backtest/shadow/v3lp/shadowDriver.test.ts` — 5 cases
- [ ] RED: 從 ShadowSnapshot[] 重建 hypothetical positions
- [ ] RED: counterfactual sweep 對 (current ± 鄰域) 跑 16-25 組替代閾值
- [ ] RED: 每組替代閾值的 A/C/D 計算結果與 ReplayDriver 一致（共用 outcomeCalculator）
- [ ] RED: 紅標判定：|bestAlt.sharpeOpen - current| > 0.1 → status='red'
- [ ] RED: 黃標判定：差距 50%-100% 紅色門檻 → status='yellow'

#### `tests/backtest/shadow/framework/weeklyAnalyzer.test.ts` — 4 cases
- [ ] RED: 讀過去 7 天的 shadow log（可能跨月歸檔）
- [ ] RED: 呼叫 v3lp shadowDriver 跑 counterfactual
- [ ] RED: 組裝 WeeklyAnalysis 物件並寫入 `data/shadow/analysis/<weekIso>.md`
- [ ] RED: 呼叫 alertService.sendShadowWeeklyReport 推送 Telegram

#### `tests/backtest/shadow/framework/phase5cTrigger.test.ts` — 6 cases
- [ ] RED: 最近 2 週都是 Red 且 sharpeOpen 同方向 → trigger=true
- [ ] RED: 最近 2 週都是 Red 但 sharpeOpen 方向相反 → trigger=false（C1 嚴格同方向）
- [ ] RED: 最近 2 週是 Red, Yellow → trigger=false（B1 嚴格連續）
- [ ] RED: 最近 2 週是 Red, Green → trigger=false
- [ ] RED: 最近 4 週是 Yellow, Yellow, Yellow, Yellow → soft notice in telegram，trigger=false
- [ ] RED: history < 2 週 → trigger=false, reason='資料不足'

### Group 4: Telegram Report Formatter

#### `tests/backtest/shadow/v3lp/shadowReportFormatter.test.ts` — 5 cases
- [ ] RED: 包含 per-pool A 指標表格（7 池 × A% 欄位）
- [ ] RED: 包含 sample advice（best + worst by 預期 vs 實現差距）
- [ ] RED: status='stable' → 訊息含 ✅
- [ ] RED: status='yellow' → 訊息含 🟡 + 提示文字
- [ ] RED: status='red' → 訊息含 🚨 + 紅標細節

### TDD 守則
- 每個測試先 **RED**（執行 → 失敗）
- 寫最少程式碼讓測試 **GREEN**
- **REFACTOR** 階段不改測試行為
- 嚴禁先寫實作再補測試

## Tasks（subagent 執行順序）

### Stage 1 — Offline Replay Tool（PR 4）

#### Group A: 型別與 framework 骨架（TDD）

1. **NEW**: 建立 `src/types/replay.ts`，寫入 `ReplayFeature`、`HypotheticalPosition`、`PositionOutcome`、`ThresholdSet`、`GridSpace` 型別
2. **RED**: 寫 `tests/backtest/framework/walkForwardSplit.test.ts` 4 cases
3. **GREEN**: 實作 `src/backtest/framework/walkForwardSplit.ts`
4. **RED**: 寫 `tests/backtest/framework/outcomeAggregator.test.ts` 5 cases
5. **GREEN**: 實作 `src/backtest/framework/outcomeAggregator.ts`

#### Group B: V3 LP feature extraction（TDD）

6. **RED**: 寫 `tests/backtest/v3lp/featureExtractor.test.ts` 5 cases
7. **GREEN**: 實作 `src/backtest/v3lp/featureExtractor.ts`
   - 載入 OHLCV、對齊時間軸、逐 hour 跑 mcEngine + regime engine（固定 seed = cycleIdx）
   - 輸出 `data/backtest-results/<date>/features.jsonl`
   - mcEngine 失敗 → 寫 null + log warning，不中斷

#### Group C: V3 LP outcome calculator（TDD）

8. **RED**: 寫 `tests/backtest/v3lp/outcomeCalculator.test.ts` 6 cases
9. **GREEN**: 實作 `src/backtest/v3lp/outcomeCalculator.ts`
   - 含 A 指標、C 指標、D 指標
   - fee income 公式 + V3 constant product IL 公式
   - HODL counterfactual

#### Group D: V3 LP replay driver（TDD）

10. **RED**: 寫 `tests/backtest/v3lp/replayDriver.test.ts` 7 cases
11. **GREEN**: 實作 `src/backtest/v3lp/replayDriver.ts` `V3LpReplayDriver` class
    - 內部維護 `Map<positionId, HypotheticalPosition>`
    - 每 feature 先檢查現有 position 的 close / rebalance
    - 再檢查空池子的 open recommend
    - 收尾時強制結算
    - 直接呼叫 `positionAdvisor.ts` 的 3 個 pure functions（不引入 sweeper / adapter）

#### Group E: Grid search 與 sensitivity（TDD）

12. **RED**: 寫 `tests/backtest/framework/gridSearcher.test.ts` 6 cases
13. **GREEN**: 實作 `src/backtest/framework/gridSearcher.ts`
    - 粗 grid 72 組
    - Top-5 篩選邏輯
    - 細 grid 鄰域展開
14. **RED**: 寫 `tests/backtest/framework/sensitivityRunner.test.ts` 3 cases
15. **GREEN**: 實作 `src/backtest/framework/sensitivityRunner.ts`
    - 對 TVL multiplier ∈ {0.5, 1.0, 2.0} 各跑一次
    - 比對 top-3 thresholds 一致性

#### Group F: 入口 script + summary 輸出

16. **NEW**: 建立 `src/backtest/config.ts`，硬編碼 train/val/test 日期邊界與 grid 範圍
17. **NEW**: 建立 `src/backtest/runPhase5aBacktest.ts` 入口 script
    - 載入 OHLCV → feature extraction → temporal split → grid search × 3 sensitivity runs → 寫 summary.md
    - 含「pass/fail 絕對底線」邏輯：train + val + test 三段都必須通過
18. **NEW**: 修改 `package.json`，新增 `backtest:phase5a` script
19. **VERIFY**: 在本地執行 `npm run backtest:phase5a`，產出 `data/backtest-results/<date>/summary.md`
20. **REVIEW**: 人工檢視 summary.md，記錄 chosen thresholds，準備寫入 PR 5 的 PositionAdvisor config

### Stage 2 — Shadow Infrastructure（與 P0 plan Stage 3-5 同 PR，即 PR 5）

> **注意**：本 group 的 task 與 P0 plan Stage 3-5 屬於同一個 PR，subagent 在執行 PR 5 時要把兩 plan 的 task 列表合併處理。

#### Group G: ShadowSnapshot 型別與 Logger

21. **NEW**: 建立 `src/types/shadow.ts`，寫入 `ShadowSnapshot`、`WeeklyAnalysis`、`ShadowStatus` 型別
22. **RED**: 寫 `tests/backtest/shadow/shadowLogger.test.ts` 4 cases
23. **GREEN**: 實作 `src/services/shadow/shadowLogger.ts`
    - `writeShadowSnapshots()` 寫入月歸檔 jsonl
    - 失敗 → log warning + push cycleWarnings，不 throw

#### Group H: V3 LP Shadow Driver（counterfactual sweep）

24. **RED**: 寫 `tests/backtest/shadow/v3lp/shadowDriver.test.ts` 5 cases
25. **GREEN**: 實作 `src/services/shadow/v3lp/shadowDriver.ts` `V3LpShadowDriver` class
    - 從 ShadowSnapshot[] 重建 hypothetical positions
    - 對 current 閾值的小鄰域跑 counterfactual sweep（共用 `outcomeCalculator.ts`）
    - 紅黃綠三態判定

#### Group I: Weekly Analyzer 與 Stage 3 Trigger

26. **RED**: 寫 `tests/backtest/shadow/framework/weeklyAnalyzer.test.ts` 4 cases
27. **GREEN**: 實作 `src/services/shadow/framework/weeklyAnalyzer.ts` `runWeeklyAnalysis()`
    - 讀過去 7 天的 shadow log
    - 呼叫 v3lp shadowDriver
    - 寫入 `data/shadow/analysis/<weekIso>.md`
28. **RED**: 寫 `tests/backtest/shadow/framework/phase5cTrigger.test.ts` 6 cases
29. **GREEN**: 實作 `src/services/shadow/framework/phase5cTrigger.ts` `checkPhase5cTrigger()`
    - A2 + B1 + C1 嚴格邏輯
    - 連續 4 週 Yellow → soft notice flag

#### Group J: Telegram Report Formatter

30. **RED**: 寫 `tests/backtest/shadow/v3lp/shadowReportFormatter.test.ts` 5 cases
31. **GREEN**: 實作 `src/services/shadow/v3lp/shadowReportFormatter.ts` `formatWeeklyReport()`
    - 中文格式
    - per-pool A 表格 + sample advice + 三態狀態

#### Group K: Cron 整合與 alertService

32. **MODIFY**: `src/bot/alertService.ts` 新增 `sendShadowWeeklyReport()` + `sendPhase5cTrigger()` 方法
33. **MODIFY**: `src/runners/mcEngine.ts` cycle 結尾新增「組裝 ShadowSnapshot[] + fire-and-forget shadowLogger」邏輯（**這個動作已在 P0 plan Stage 4 task 17.5 列出**）
34. **MODIFY**: `src/index.ts` 啟動流程新增「週日 23:00 (Asia/Taipei) cron 觸發 weeklyAnalyzer」+ `isShadowAnalyzeRunning` guard
35. **VERIFY**: 手動觸發 weeklyAnalyzer（暫時改 cron expression），確認完整流程：讀 log → 跑 analyze → 寫 markdown → 推 Telegram

#### Group L: Smoke Test（Stage 2 進入生產）

36. **VERIFY**: 部署到 Railway，觀察主 cycle 是否每 10 分鐘寫一筆 ShadowSnapshot 到 `data/shadow/<YYYY-MM>.jsonl`
37. **VERIFY**: 第一個週日 23:00 自動觸發 weeklyAnalyzer，確認 Telegram 收到週報
38. **VERIFY**: 模擬紅標情境（例如手動修改 currentThresholds 讓 best alternative 偏離很大），確認紅標在 Telegram 正確顯示
39. **VERIFY**: R2 backup 的 analysis 雙路徑生效（檢查 R2 console 的 `analysis/shadow-<weekIso>.md`）

### 完成標準

- **Stage 1（PR 4）**:
  - 所有 36 個 framework + v3lp 測試 GREEN
  - 本地執行 `npm run backtest:phase5a` 產出 `summary.md`
  - summary.md 顯示 train + val + test 三段全部通過絕對底線
  - chosen thresholds 已記錄供 PR 5 使用
- **Stage 2（PR 5 的一部分）**:
  - 所有 24 個 shadow 測試 GREEN
  - 部署後第一個 10 分鐘 cycle 寫出 ShadowSnapshot
  - 第一個週日 23:00 收到 Telegram 週報
  - 紅標情境模擬成功
  - R2 backup 的 analysis/ 雙路徑包含週報 markdown
- **Stage 3（無實作，純文件）**:
  - 操作流程已寫入本 plan 的 Decisions #32
  - 連續 2 週紅標 + 同方向時 alertService 自動推送通知
- **總共 60 個 RED 測試全部 GREEN**
- **跑 `/cso`** 通過資安檢查（特別檢查 shadow log 不含敏感資料）
- **PR 4 與 PR 5 各自完成「最後 commit 刪除 plan」**（依 CLAUDE.md Phase 2 規則 α）：PR 4 不刪本 plan（PR 5 才會刪），PR 5 同時刪除本 plan 與 P0 plan
