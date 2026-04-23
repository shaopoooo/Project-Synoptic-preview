# Backtest 框架

> Live vs Backtest 差異、Walk-Forward 時間切分、Grid Search 閾值驗證、GA Gap Penalty、Gate 2 三層架構。
>
> MC 引擎本體 → 見 `mc-engine.md`

---

## 1. Live 模式 vs Backtest 模式的差異

| 面向 | Live（`lpMcRunner.ts`） | Backtest（`featureExtractor.ts`） |
|------|------|------|
| **數據來源** | API 即時拉取 | `storage/ohlcv/` 靜態檔案 |
| **MC paths** | 10,000 | 1,000（節省 10× 運算量） |
| **RNG** | `Math.random()`（每次不同） | `seedrandom(cycleIdx)`（固定 seed，可重現） |
| **區間 Pa/Pb** | 由 sigma × stdDev 計算（多個候選） | 由 P5/P95 歷史百分位（固定） |
| **Regime** | V3（production，tsRank [0,1]） | V3（同 Live，含 TsRankTracker） |
| **Block Bootstrap** | blockSize=4（segments 有效時啟用） | 不使用（D17：避免效能衝擊） |
| **Transition Matrix** | 計算 + 診斷 log（未接入 MC） | 計算 + 診斷 log（未接入 MC） |
| **決策邏輯** | `shouldClose + classifyExit` 統一純函數 | `shouldClose + classifyExit` 統一純函數（不再有 inline 重複） |
| **Fee 計算** | `pool.apr × capitalEfficiency` | `candleVolume × 24 × fee × (capital/TVL) × capitalEfficiency` |
| **Tranche 比例** | `computeDynamicCoreRatio(regimeVector)` | `backtestCapitalMode=dynamic` 同 Live；`step` 為舊版 step-function（0/0.3/0.6/1.0） |
| **資本配置模式** | 固定 dynamic | `BACKTEST_CAPITAL_MODE: dynamic \| step`（預設 dynamic） |
| **輸出** | `appState.strategies[poolId]` | `ReplayFeature[]`（含 mcScore/mcMean/mcStd/mcCvar95） |

### Backtest 特殊處理

- **前 720 小時 null 化：** `cycleIdx < 720` 直接輸出 null feature（歷史不足，不跑 MC）
- **normFactor：** 取 720 窗口 close 均值，所有價格除以它 → 正規化空間，跨時期可比
- **固定 seed：** `seedrandom(String(cycleIdx))` 確保同一 cycle 永遠跑出相同結果
- **V2 快速模式：** `precomputeNormalizedDataCache()` 預算所有 preset×pool×cycle 的 NormalizedMarketData，`overrideRegime()` 只需查表 + 純數學，加速 ~100×
- **時間注入：** Backtest 傳入 `candle.ts * 1000` 作為 `nowMs`，確保 `shouldClose` 不依賴 `Date.now()`

---

## 2. Score 如何影響 PositionAdvisor

MC engine 的 `score`（mean/std）寫入 `appState.strategies[poolId].score`，PositionAdvisor 用它做決策：

```
recommendOpen():
    if score > sharpeOpen（連續 2 cycle）→ 建議開倉
    if 0.3 < score < 0.5                → 灰色帶，不動作
    if score < 0.3                       → 不建議

shouldClose(nowMs):
    if score < sharpeClose（連續 2 cycle）→ opportunity_lost，建議關倉
```

**nowMs 參數設計：**

| 呼叫場景 | nowMs 來源 | 其他 Reactor 值 |
|----------|------------|----------------|
| Backtest replay | `candle.ts * 1000` | 由 OHLCV 衍生（無即時 feed） |
| Shadow 模式 | `Date.now()` | 真實 velocityZScore、volumeSpikeRatio |
| Live 模式 | `Date.now()` | 真實 Reactor 即時信號 |

**MC score 是整個系統唯一的「值不值得做」量化指標。** Regime engine 決定「市場現在是什麼狀態」，MC engine 決定「在這個狀態下做 LP 划不划算」。

---

## 2a. tsRank 平穩化

### 問題背景

raw `multiTfVolRatio` 的數值分佈隨市場結構漂移，直接映射到 Genome 閾值（如 `volRatio > 1.5`）導致不同時期的 regime 信號不可比。

### TsRankTracker

`TsRankTracker` 將 raw 指標值轉換為 **[0, 1] 百分位**，實現跨時期平穩化：

```
TsRankTracker:
    window   = 720h（預設，約 30 天）
    WARMUP   = 168 根 candle（7 天，未達不輸出有效 rank）
    輸出     = 當前值在過去 window 內的排名百分位
```

### 使用方式

```
computeRegimeVectorV3WithTsRank(candles, idx, tracker)
    └─ 取代舊版 computeRegimeVectorV3（直接用 raw 值）
    └─ 對每個輸入維度呼叫 tracker.update(raw) → 取得 [0,1] rank
```

### Genome 參數空間更新

| 版本 | volRatio 閾值範圍 | 說明 |
|------|-----------------|------|
| V2 | `[0.8, 3.0]`（raw 值） | 依賴市場絕對數值，易過擬合 |
| V3 | `[0.0, 1.0]`（百分位） | 百分位穩定，跨時期可比 |

---

## 3. 時間切分（Walk-Forward）

```
|←── Train ──→|←── Val ──→|←── Test ──→|
2025-05-01     2026-01-22   2026-03-01   2026-04-10
     (~9 月)       (~5 週)      (~6 週)
```

| 切分 | 用途 | 時間 |
|------|------|------|
| **Train** | Phase A 引擎校準 + Phase B 前期演化 | 2025-05-01 ~ 2026-01-22 |
| **Validation** | Phase B 後期演化 + 超參數選擇 | 2026-01-22 ~ 2026-03-01 |
| **Test（OOS）** | V1 vs V2 A/B audit，絕對底線驗證 | 2026-03-01 ~ 2026-04-10 |

**嚴格隔離：** Test 區間的數據在 Phase A/B 完全不可見，防止 data leakage。

---

## 4. Grid Search（Backtest 驗證 PositionAdvisor 閾值）

Backtest 在 Test 區間跑 replay，用不同的 threshold 組合測試：

```
COARSE_GRID:
    sharpeOpen:     [0.30, 0.40, 0.50, 0.60, 0.70, 0.80]    × 6
    sharpeClose:    [0.05, 0.10, 0.15, 0.20, 0.30]           × 5
    atrMultiplier:  [1.5, 2.0, 2.5, 3.0]                     × 4
    ───────────────────────────────────────
    Total:          120 組合
```

**注意：** `atrMultiplier` 現在直接傳入 `classifyExit()`，不再在 replay loop 內有 inline 重複邏輯。所有出場分類統一走 `shouldClose + classifyExit` 純函數路徑。

每組 threshold 跑完整 Test 區間 replay → 開/關假想倉位 → 計算三項指標：

| 指標 | 公式 | 絕對底線 |
|------|------|---------|
| **A — vs HODL 跑贏** | `(LP_final - HODL_final) / HODL_final` | > 0 |
| **C — Hit Rate** | `in-range 小時數 / 總存活小時數` | ≥ 50% |
| **D — LP 淨利** | `fee_income - IL - gas_cost` | > 0 |

三項全過的組合中，用 `0.4×A + 0.3×C + 0.3×D` 加權分數選最佳。

---

## 5. GA Gap Penalty（過擬合防禦）

### 問題背景

GA 演化的 Genome 可能過擬合 Train 區間，在 OOS 出現明顯性能落差（gap）。

### 訓練資料 IS/OOS 切分

```
splitTrainIsOos(trainData, ratio=0.7):
    IS  = 前 70%（用於 GA fitness 評估）
    OOS = 後 30%（用於 gap 計算）
```

### computePenalizedFitness

```
computePenalizedFitness(genome, isData, oosData, alpha):
    fitnessIS  = evaluate(genome, isData)
    fitnessOOS = evaluate(genome, oosData)
    gap        = (fitnessIS - fitnessOOS) / abs(fitnessIS)

    if gap > 0.30:
        penalizedFitness = fitnessIS × (1 - alpha × (gap - 0.30))
    else:
        penalizedFitness = fitnessIS
```

| 參數 | 說明 | 預設值 |
|------|------|--------|
| `gap > 30%` | 觸發懲罰的門檻 | 30% |
| `alpha` | 懲罰強度係數 | 1.0 |
| `GA_PENALTY_ALPHA` | CLI 環境變數覆寫 | `1.0` |

**效果：** alpha=1.0 時，gap=40% 的 Genome 會被削減 10% fitness，讓 GA 傾向選擇 IS/OOS 表現均衡的個體。

---

## 6. backtestCapitalMode A/B

| 模式 | 環境變數設定 | 行為 |
|------|------------|------|
| **dynamic**（預設） | `BACKTEST_CAPITAL_MODE=dynamic` | 使用 `computeDynamicCoreRatio(regimeVector)`，與 Live 行為一致 |
| **step** | `BACKTEST_CAPITAL_MODE=step` | 使用舊版 step-function：0 / 0.3 / 0.6 / 1.0，用於回歸對照 |

**使用建議：** 正式 backtest 應以 `dynamic` 為主（與 production 行為對齊）；`step` 模式保留用於與 V2 歷史結果對照。

---

## 7. Gate 2 三層架構

Gate 2 是 Genome 上線前的最終品質關卡，採用三層遞進篩選：

### Layer 1 — Hard Filter（強制通過/淘汰）

```
條件：Fee/IL Ratio > 1.2
結果：< 1.2 → 直接淘汰，不進入後續分析
```

費用收入必須至少超過無常損失 20%，確保策略在最基本的成本效益層面可行。

### Layer 2 — Shadow Telemetry（多維度健康指標）

在 Shadow 模式（使用真實 Reactor 信號但不實際開倉）下收集：

| 指標 | 說明 | 健康範圍 |
|------|------|---------|
| **FeeRatio APR** | 年化費用收益率 | > 基準 APR |
| **DefenseEV** | 防禦性出場的期望值 | > 0 |
| **ReactorPrecision** | Reactor 信號精準度（觸發後成功防禦比例） | ≥ 60% |
| **PureAlpha Sharpe** | 去除市場 beta 後的純 alpha 夏普比率 | > 0.5 |

### Layer 3 — Survivor Distribution（存活組合分佈）

統計通過 Layer 1+2 的組合在不同 threshold 下的性能分佈：

```
Survivor Distribution:
    p25    = 第 25 百分位表現（下限保障）
    median = 中位數表現（典型期望）
    p75    = 第 75 百分位表現（上限潛力）
```

**決策邏輯：** p25 > 底線 且 median > 目標，才視為 Gate 2 通過。單一最佳組合不代表策略健康，需要整體分佈評估。

---

## 8. featureExtractor `toHourlyReturns` 未 DRY 的理由

`PriceSeriesProvider.ohlcvToHourlyReturns` 語義為 `slice(1)`（輸出長度 = n-1，丟棄首根）。`featureExtractor.toHourlyReturns` 保留全部 candle（i=0 的 r 設為 0，輸出長度 = n）。`extractFeatures` 以 `cycleIdx` 同時索引 `store.candles[cycleIdx]` 和 `hourlyReturns[cycleIdx]`，兩者必須等長。改用 `slice(1)` 會偏移所有 cycleIdx，破壞 MC 歷史窗口邊界。

---

## 9. outcomeCalculator 時間常態化

```
overlapDays = (lastTs - firstTs) / 86400    // 精確到小時，不取整
dailyNetProfit = lpNetProfit / overlapDays
tradesPerWeek = 7 / overlapDays             // 每倉位 = 1 trade
guard: overlapDays ≤ 0 || !isFinite → null
```
