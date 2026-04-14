# Feature: Regime Engine V2 — Kalman/EWMA 前處理 + 長短分離 + 客觀 scoring

> Path B brainstorming 產出，日期 2026-04-13。交接給 `/plan-eng-review` 做對抗式 review，再進 Phase 2 執行。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由本檔更新。
>
> **📐 命名規則（CLAUDE.md line 101 強制）**：Stage 1-5 / Group 1.A / Task 1.A.1
>
> **來源**：office-hours 2026-04-13 戰略 review observation #1「regime engine 是單點失敗，signal quality 從未被正式驗證」→ 深入討論 collinearity / 暴跌延遲 / heteroskedasticity / consumer bias / evolution overfitting 等 6 個 challenge，收斂為本 plan 的 15 項改動。

## Context（為何要做）

- **觸發**：戰略 review 發現 regime engine 的 `computeRegimeVector()` 是所有策略的單點依賴（LP advisor / trend follow / 未來策略全部消費它），但 signal quality 從未被正式驗證
- **Surface 出的 5 個結構性問題**：
  1. **Collinearity**：CHOP(14) 跟 Hurst(20) 幾乎看同一段時間、同一件事（有沒有趨勢），additive scoring 等於把同一特徵的權重放大兩倍。假突破時 score 瞬間極端化，失去 softmax 的平滑初衷
  2. **暴跌偵測延遲**（乘法方案的反例）：CHOP 快速偵測到暴跌但 Hurst(100) 還沒反應 → 純乘法輸出 neutral → LP 在最關鍵時刻被困在 neutral
  3. **GIGO（Garbage In Garbage Out）**：regime engine 直接吃原始 OHLCV，DeFi 的插針 / 假突破 / 歷史波動殘留全部直接灌入 CHOP 跟 Hurst，分類品質嚴重受雜訊影響
  4. **Heteroskedasticity**：死水期 vol 極小、牛市 vol 極大，raw Z-score 在不同波動率環境下量級失真（死水期的微幅震盪被誇大為「比暴跌更劇烈」）
  5. **策略偏見 hardcode**：非對稱 scoring（LP 的恐懼放大）如果寫在 engine 裡，未來新策略（grid bot / CTA）收到的天氣預報會被 LP 偏見扭曲

- **核心解法**：
  - **Kalman + EWMA 前處理**：串聯在 regime engine 上游，過濾雜訊再餵入分類器
  - **長短分離**：CHOP(14) 看短期（現在在不在震盪），Hurst(100) 看長期（這個 pair 有沒有趨勢特性），兩者 decorrelate
  - **客觀 scoring**：engine 輸出中性機率，策略偏見放在 consumer 端
  - **Two-phase evolution**：引擎校準跟交易邏輯分開訓練，避免 15 維度的 curse

## Goal（「改完了」的定義）

1. 新建 `DynamicBandEngine`（Kalman + EWMA），pure function，含 unit tests
2. `deriveMarketStats()` 改用 Kalman center + EWMA stdDev，輸出 `NormalizedMarketData`（含 Z-score `normalizedReturns[]` + `smoothedCandles[]`）
3. `computeRegimeVector()` 改為客觀 neutral scoring（decorrelated 乘法），Hurst 吃 normalizedReturns、CHOP 吃 smoothedCandles
4. LP advisor 端加 **CHOP panic shortcut**（raw CHOP < threshold → 直接 exit，不等 regime vector）+ **sensitivity multiplier**
5. Genome evolution 改為 **Two-Phase**（Phase A 引擎 4 維 / Phase B 交易邏輯 11 維）+ **risk-adjusted fitness function**
6. `regimeSignalAudit()` 跑 A/B 比較（old raw vs new Kalman+EWMA），含 **DefenseEV** 指標
7. **DefenseEV > 1** 且 **trendVsRangeRatio 提升** → pass；否則 fail
8. `npm test` 全綠；`tsc --noEmit` 零 error
9. 既有 LP PositionAdvisor 21 個 tests + 其他 regression 全綠

## Non-goal（明確不做）

- ❌ **Production 的 Hyperliquid 整合**：本 plan 只改 regime engine + LP consumer 端，不碰 perp execution
- ❌ **P1 trend follow 的 consumer 端 sensitivity tuning**：那是 `p1-trend-follow-strategy.md` 自己的 scope
- ❌ **新增第三個 regime 指標**（如 volume profile / order flow）：本次只 upgrade 現有 CHOP + Hurst，新指標另開 plan
- ❌ **Grid bot / CTA advisor 實作**：本 plan 只確保 engine 輸出客觀機率，consumer 實作由各自 strategy plan 負責
- ❌ **把 Kalman/EWMA 延伸到 MC engine 的 bootstrap 抽樣**：那是 MC engine 自己的 refactor，本 plan 只改 regime 上游

## Decisions（已定案，執行階段不得動搖）

### D1 — 長短分離：CHOP(14) 短期 + Hurst(100) 長期
- CHOP 的 `chopWindow` 保持 14（短期「現在在不在走方向」）
- Hurst 的 `hurstMaxLag` 從 20 改為 100（長期「這個 pair 有沒有 persistent trend 特性」）
- 資料需求：Hurst 需 `candles.length >= 200`（720h MC 窗口遠超）
- **效果**：兩者的資料重疊度從 ~100% 降到 ~10%，消除 collinearity

### D2 — Kalman + EWMA 前處理（DynamicBandEngine）
- 新建 `DynamicBandEngine` class（pure math 遞迴，無 I/O）
- Kalman filter：追蹤 price center（零滯後中軌）
- EWMA：追蹤 price variance / stdDev（快速反應波動率）
- 暖機 loop：將 720h 歷史 K 線從第 1 根跑到第 720 根，讓內部狀態收斂
- 輸出：`{ centerPrice, stdDev, bandwidth }`

### D3 — `deriveMarketStats()` 升級為 `NormalizedMarketData`
- 暖機 loop 產出 Kalman center + EWMA stdDev
- **baselineVol = log returns 的 stddev**（不是 price level 的 stddev — 修正 reference impl bug）
- **effectiveVol = max(ewmaStdDev, baselineVol, 1e-8)**（C1 heteroskedasticity floor）
- **Z-score：`Z_t = (close - kalmanCenter) / effectiveVol`** → `normalizedReturns[]` 給 Hurst
- **3σ 削峰：`smoothedHigh = min(rawHigh, center + 3σ)`** → `smoothedCandles[]` 給 CHOP

### D4 — 客觀 neutral scoring（C2 修正）
- `computeRegimeVector()` 輸出的 `RegimeVector { range, trend, neutral }` 是**未加工的中性機率**
- `trendScore = chopTrendness × hurstTrendness`（乘法，雙重確認）
- `rangeScore = (1 - chopTrendness) × (1 - hurstTrendness)`（乘法，雙重確認）
- **零策略偏見**。非對稱邏輯交給 consumer 端

### D5 — Consumer 端偏見（不在 engine 裡）
- **LP advisor**：
  - CHOP panic shortcut：raw CHOP < `LP_CHOP_PANIC_THRESHOLD` → 直接 exit（不等 regime vector）
  - Sensitivity multiplier：`effectiveTrend = rv.trend × LP_TREND_SENSITIVITY`（default 1.5）
- **Trend follow advisor**（P1 plan 自己處理）：
  - Lower sensitivity：`effectiveTrend = rv.trend × TF_SENSITIVITY`（default 0.8）
  - Confirmation delay：2-4 cycles after trend signal 才進場
- **每個策略自己決定怎麼解讀氣象中心的客觀輸出**

### D6 — Two-Phase Evolution（解 15 維 curse）
- **Phase A（引擎校準）**：4 維搜索
  - 參數：`kalmanQ` / `kalmanR` / `ewmaAlpha` / `clipSigma`
  - Fitness：Kalman+EWMA 預測的波動率 vs 未來 4h 實現波動率的 MSE 最小化
  - 鎖定 Phase A 最佳參數，進 Phase B 不再動
- **Phase B（交易邏輯）**：11 維搜索
  - 參數：chopWindow / chopRangeThreshold / chopTrendThreshold / hurstMaxLag / hurstRangeThreshold / hurstTrendThreshold / sigmoidTemp / chopScale / hurstScale / atrWindow / cvarSafetyFactor
  - Fitness：risk-adjusted（見 D7）
  - Monthly rolling walk-forward（3-month train / 1-month test）

### D7 — Risk-adjusted Fitness Function
- `Fitness = TotalPnL - W₁ × MaxDrawdown - W₂ × HarmfulFlipFlopCount`
- W₁ / W₂ 是 hardcoded weights（不 evolve，人類決定風險容忍度）
- 禁止純 PnL fitness（會產出暴利但脆弱的參數）

### D8 — Harmful Flip-Flop 定義
- `HarmfulFlipFlop = 切換為 Trend 後 4h 內，price 沒有穿出 ATR band，且 regime 又切回 Range/Neutral 的次數`
- 只懲罰「虛驚一場的 trend 誤判」
- 如果切 Trend 後 price 真的動了（即使後來回來），**不算 harmful**

### D9 — DefenseEV 作為最終 pass/fail 判定
- `DefenseEV = Σ(Saved_IL) / Σ(Missed_Fees)`
  - Saved_IL = 因提早撤退躲過的 Impermanent Loss
  - Missed_Fees = 因提早撤退少賺的 LP fees
- **Pass criteria：DefenseEV ≥ 1.0**（每少賺 $1 fees 至少救回 $1 IL）
- 加分：trendVsRangeRatio (new) > trendVsRangeRatio (old) + flipFlopRate 改善

### D10 — Genome search space 邊界（DeFi 實戰驗證值）
- `kalmanQ`：[0.00001, 0.001]（price 飄移率）
- `kalmanR`：[0.005, 0.05]（觀測雜訊），**約束 R ≥ 10 × Q**
- `ewmaAlpha`：[0.10, 0.35]（DeFi 比傳統金融快）
- `clipSigma`：hardcode 3（未來可 evolve，search [2.5, 5]）

## Rejected（已否決，subagent 不得再提）

### Scoring 方案
- ❌ **Additive scoring（現狀）**：CHOP + Hurst 相加 = 雙重計算同一特徵，假突破時 score 極端化
- ❌ **Pure multiplicative for trend（初版乘法）**：暴跌第 1 小時 Hurst(100) 還沒反應 → trendScore = 0.09 → LP 被困在 neutral 看著本金被 IL 吞掉
- ❌ **非對稱 scoring 寫在 engine 裡（初版 asymmetric）**：LP 偏見 hardcode 進氣象中心，未來 grid bot / CTA 收到扭曲的天氣預報
- ❌ **max(CHOP, Hurst) 取代 sum（初版 fix A）**：只取最強信號，丟失另一個指標的資訊

### Evolution 方案
- ❌ **15 維一起搜索**：維度詛咒，GA 卡在 local optima
- ❌ **純 PnL fitness**：會演化出「牛市暴利、暴跌破產」的參數
- ❌ **Raw flip-flop count 當 penalty**：新版引擎更敏銳 → flip-flop 天然更高，但不代表更差

### Data 處理
- ❌ **baselineVol 用 price level stddev**：跟 ewmaStdDev（returns stddev）量級不同，max() 永遠取 baselineVol → EWMA 失效
- ❌ **不做前處理直接升級 scoring**：GIGO — scoring 改再好，吃的資料還是雜訊

## Constraints（必須遵守的專案規則）

- **`.claude/rules/pipeline.md`**：DynamicBandEngine 跟 deriveMarketStats 屬於 Phase 0（prefetch 階段的 compute），computeRegimeVector 屬於 Phase 1（純函式）。Kalman 暖機 loop 在 Phase 0 跑完
- **`.claude/rules/position-tracking.md`**：regime engine 是跨 strategy column 的 upstream infrastructure。改動 regime engine 不改任何策略的 L1/L2/L3 ownership
- **`.claude/rules/architecture.md`**：DynamicBandEngine 是 pure function module，不是 class with state（或者是 class with explicit state injection）
- **`.claude/rules/math.md`**：Kalman / EWMA 計算用原生 Number（不需要 BigInt，浮點精度足夠）
- **`.claude/rules/testing.md`**：每個新 pure function 必須有 unit test
- **CLAUDE.md 命名規則**：Stage 1 / Group 1.A / Task 1.A.1

## Interfaces（API 契約）

### `src/engine/shared/DynamicBandEngine.ts` — NEW

```ts
export interface BandState {
    centerPrice: number;    // Kalman filtered center
    stdDev: number;         // EWMA standard deviation
    bandwidth: number;      // upper - lower band width
}

export class DynamicBandEngine {
    constructor(
        private q: number,      // Kalman process noise
        private r: number,      // Kalman measurement noise
        private alpha: number,  // EWMA decay factor
    ) {}

    /** 餵入一根 K 線的 close，推進內部狀態 */
    update(close: number): BandState;

    /** 重置內部狀態（unit test 用） */
    reset(): void;
}
```

### `NormalizedMarketData` — NEW（`deriveMarketStats` 的回傳型別）

```ts
export interface NormalizedMarketData {
    kalmanCenter: number;
    ewmaStdDev: number;
    bandwidth: number;
    baselineVol: number;              // log returns stddev over full window
    normalizedReturns: number[];      // Z-score 陣列 → 餵 Hurst
    smoothedCandles: SmoothedCandle[];  // 3σ 削峰 → 餵 CHOP
}

export interface SmoothedCandle {
    high: number;       // min(rawHigh, kalmanCenter + 3σ)
    low: number;        // max(rawLow, kalmanCenter - 3σ)
    close: number;      // kalmanCenter
    rawClose: number;   // 保留原始值
}
```

### `computeRegimeVector()` — MODIFY（Stage 3）

```ts
// 簽名改為接收 NormalizedMarketData 而非 raw HourlyReturn[]
export function computeRegimeVector(
    marketData: NormalizedMarketData,
    genome: RegimeGenome,
): RegimeVector {
    const chop  = calculateCHOP(marketData.smoothedCandles, genome.chopWindow);
    const hurst = calculateHurst(marketData.normalizedReturns, genome.hurstMaxLag);
    // ... sigmoid → neutral multiplicative scoring → softmax
}
```

### LP Advisor — MODIFY（consumer 端，Stage 3 Group 3.B）

```ts
function lpInterpretRegime(
    rv: RegimeVector,
    chopRaw: number,            // 原始 CHOP（未 smooth，用於 panic shortcut）
    config: LpRegimeConfig,
): number {
    if (chopRaw < config.chopPanicThreshold) return 0.95;
    return rv.trend * config.trendSensitivity;
}
```

### `RegimeGenome` — MODIFY（新增 6 個基因，9 → 15 維）

```ts
export interface RegimeGenome {
    // 既有 9 個
    id: string;
    chopRangeThreshold: number;
    chopTrendThreshold: number;
    chopWindow: number;
    hurstRangeThreshold: number;
    hurstTrendThreshold: number;
    hurstMaxLag: number;          // baseline: 20 → 100
    sigmoidTemp: number;
    atrWindow: number;
    cvarSafetyFactor: number;
    // 新增 6 個
    kalmanQ: number;              // [0.00001, 0.001]
    kalmanR: number;              // [0.005, 0.05], R ≥ 10Q
    ewmaAlpha: number;            // [0.10, 0.35]
    chopScale: number;            // sigmoid sensitivity for CHOP
    hurstScale: number;           // sigmoid sensitivity for Hurst
    clipSigma: number;            // 3σ clipping, hardcode 3 initially
}
```

## Test Plan（TDD 起點，RED 階段測試清單）

### `tests/services/strategy/DynamicBandEngine.test.ts` — NEW
- [ ] RED: 餵入常數 price 序列 → center 收斂到該常數、stdDev → 0
- [ ] RED: 餵入線性上升序列 → center 追蹤斜率、stdDev 反映 step size
- [ ] RED: 餵入一根極端插針後回歸 → center 不跟著跳（R > Q 確保 smoothing）
- [ ] RED: reset() 後重跑得到相同結果（deterministic）
- [ ] RED: Q=0 → center 完全不動（純 prior）; R=0 → center 完全跟著 close（零 smoothing）

### `tests/services/strategy/deriveMarketStats.test.ts` — NEW or MODIFY
- [ ] RED: baselineVol 用 log returns stddev（不是 price level）— golden test 對比手算值
- [ ] RED: effectiveVol = max(ewmaStdDev, baselineVol) — 死水期 ewmaStdDev < baselineVol → 用 baselineVol
- [ ] RED: Z-score 在死水期不暴衝（baselineVol floor 生效）
- [ ] RED: smoothedCandles 的 high/low 被 3σ clip — 餵入一根 10σ 插針 → smoothedHigh ≤ center + 3σ
- [ ] RED: normalizedReturns.length === rawCandles.length

### `tests/services/strategy/MarketRegimeAnalyzer.test.ts` — MODIFY
- [ ] RED: computeRegimeVector 吃 NormalizedMarketData 而非 raw HourlyReturn[]
- [ ] RED: CHOP 吃 smoothedCandles、Hurst 吃 normalizedReturns
- [ ] RED: 乘法 scoring：trendScore = chopTrendness × hurstTrendness
- [ ] RED: 既有 LP PositionAdvisor 21 個 tests **全部仍綠**（regression guard）

### `tests/services/strategy/lp/lpRegimeInterpreter.test.ts` — NEW
- [ ] RED: CHOP < panic threshold → return 0.95（不管 regime vector）
- [ ] RED: CHOP >= panic threshold → return rv.trend × sensitivity
- [ ] RED: sensitivity = 1.5 時 rv.trend = 0.5 → effective = 0.75

### `tests/backtest/framework/regimeSignalAudit.test.ts` — MODIFY
- [ ] RED: DefenseEV 計算正確（Saved_IL / Missed_Fees）
- [ ] RED: HarmfulFlipFlop 只計算「4h 內價格沒動又切回」的次數

## Tasks（subagent 執行順序）

### Stage 1 — DynamicBandEngine（Kalman + EWMA）

**Group 1.A / Engine（TDD）**

1. **RED**：寫 `tests/services/strategy/DynamicBandEngine.test.ts` 5 cases
2. **GREEN**：新建 `src/engine/shared/DynamicBandEngine.ts`
3. **REFACTOR**：確認 pure math（無 I/O）、TypeScript strict、no any

### Stage 2 — deriveMarketStats 升級 + Z-score + smoothedCandles

**Group 2.A / NormalizedMarketData（TDD）**

4. **RED**：寫 deriveMarketStats tests 5 cases（baselineVol / effectiveVol / Z-score / 3σ clip / length）
5. **GREEN**：修改 `deriveMarketStats()` 回傳 `NormalizedMarketData`，整合 DynamicBandEngine 暖機 loop
6. **REFACTOR**：確認 baselineVol 用 log returns（不是 price level）

**Group 2.B / 下游適配**

7. **MODIFY**：`src/engine/lp/mcEngine.ts` 中 `runMCEngine()` 呼叫 `deriveMarketStats()` 的 call site，接收新 interface
8. **VERIFY**：tsc --noEmit 零 error、既有 tests 全綠

### Stage 3 — Regime scoring 改造 + consumer 偏見

**Group 3.A / 客觀 scoring（TDD）**

9. **RED**：寫 MarketRegimeAnalyzer.test.ts 新增 4 cases（NormalizedMarketData 輸入 / 乘法 scoring / CHOP smoothed / Hurst normalized）
10. **GREEN**：修改 `computeRegimeVector()` 簽名 + 實作
11. **MODIFY**：`calculateCHOP()` 接受 `SmoothedCandle[]`（或 overload）
12. **MODIFY**：`calculateHurst()` 接受 `normalizedReturns: number[]`，maxLag default 改 100
13. **VERIFY**：既有 LP PositionAdvisor 21 個 tests 全綠

**Group 3.B / LP consumer 端（TDD）**

14. **RED**：寫 `tests/services/strategy/lp/lpRegimeInterpreter.test.ts` 3 cases
15. **GREEN**：新建 `src/engine/lp/lpRegimeInterpreter.ts`（CHOP panic shortcut + sensitivity multiplier）
16. **MODIFY**：LP advisor call chain 整合 lpRegimeInterpreter

### Stage 4 — Two-Phase Genome Evolution

**Group 4.A / Phase A 引擎校準**

17. **MODIFY**：`RegimeGenome` type 新增 6 個基因（kalmanQ / kalmanR / ewmaAlpha / chopScale / hurstScale / clipSigma）
18. **NEW**：Phase A fitness function（Kalman+EWMA 預測波動率 vs 實現波動率 MSE）
19. **RUN**：Phase A evolution（4 維，population 100, generations 50），鎖定最佳引擎參數

**Group 4.B / Phase B 交易邏輯**

20. **MODIFY**：Phase B fitness function = `PnL - W₁ × MaxDD - W₂ × HarmfulFlipFlop`
21. **RUN**：Phase B evolution（11 維，monthly rolling walk-forward：3-month train / 1-month test）
22. **VERIFY**：一波流 vs rolling 的 P&L 差異 < 20%（overfitting 檢查）

### Stage 5 — A/B 驗證 + DefenseEV

**Group 5.A / Audit 擴充**

23. **MODIFY**：`regimeSignalAudit.ts` 新增 DefenseEV 計算 + HarmfulFlipFlop metric
24. **RED**：新增 regimeSignalAudit.test.ts 2 cases（DefenseEV + HarmfulFlipFlop）
25. **GREEN**：實作

**Group 5.B / A/B 比較跑完**

26. **RUN**：6 個月 BTC/ETH 歷史，分別用 old regime engine (A) 跟 new v2 (B) 跑 audit
27. **COMPARE**：
    - `trendVsRangeRatio`: B > A?
    - `HarmfulFlipFlopRate`: B < A?
    - `DefenseEV`: B ≥ 1.0?
28. **DECISION**：
    - Pass → 切換到 v2 作為 production regime engine
    - Fail → retrospective 分析哪個 stage 的假設錯了

## Smoke Test Checklist

### Stage 1-3 完成時
- [ ] `npx tsc --noEmit` 零 error
- [ ] `npm test` 全綠（既有 tests + 新增 ~20 個 regime v2 tests）
- [ ] LP PositionAdvisor 21 個 tests 未回歸
- [ ] `computeRegimeVector()` 吃 `NormalizedMarketData`（不再吃 raw `HourlyReturn[]`）

### Stage 4 完成時
- [ ] Phase A 最佳引擎參數已鎖定（Q / R / alpha / clipSigma）
- [ ] Phase B walk-forward 完成，一波流 vs rolling 差異 < 20%
- [ ] 新 genome baseline 已寫入 config

### Stage 5 完成時
- [ ] A/B 比較報告存在 `storage/backtest-results/<date>/regime-v2-audit.md`
- [ ] DefenseEV ≥ 1.0
- [ ] trendVsRangeRatio 改善

## Open Questions

1. **`calculateCHOP` 的 overload 設計**：吃 `SmoothedCandle[]` 還是 adapter function 把 SmoothedCandle 轉成 HourlyReturn 再餵？後者 backward compatible 但多一層轉換
2. **LP CHOP panic shortcut 的 threshold 值**：hardcode 35？還是也 evolve？
3. **Phase A fitness 的「未來 4h 實現波動率」怎麼算**：用 4h realized variance（Σr²）還是 4h ATR？
4. **W₁ / W₂ 的起始值**：人工決定 or 做一輪 sensitivity analysis？

## Risks

- **R1 / Kalman 的 Q/R 敏感度** (confidence 7/10)
  - Q/R 的比例決定 smoothing 強度，錯誤設定可能讓 Kalman 太遲鈍（miss real trend）或太敏感（跟 raw 一樣）
  - Mitigation：Phase A evolution 專門 tune 這個，fitness = prediction accuracy
  
- **R2 / 3σ 削峰可能過度平滑** (confidence 6/10)
  - 真實的大幅波動也會被 clip，CHOP 可能漏掉大行情的開始
  - Mitigation：LP 有 CHOP panic shortcut 作為 backup（讀 raw CHOP 不是 smoothed）

- **R3 / Two-Phase evolution 的 Phase A/B 耦合** (confidence 5/10)
  - Phase A 最佳的引擎參數不一定是 Phase B 最佳的交易參數的前提
  - Mitigation：如果 Stage 5 A/B 比較顯示 v2 < v1，回頭檢查是否 Phase A/B 需要 joint optimization（fallback 到 15 維一起搜索）

- **R4 / 既有 LP tests regression** (confidence 8/10)
  - `computeRegimeVector()` 簽名改了，下游 call site 全部要更新
  - Mitigation：Stage 3 task 13 強制 21 個 LP tests 全綠

- **R5 / Evolution 時間成本** (confidence 6/10)
  - Phase A + Phase B 兩輪 evolution 比現在的單輪慢 2x
  - Mitigation：Phase A 只有 4 維，收斂很快；Phase B 11 維但 search range bounded

## 與其他 plan 的依賴

| Plan | 依賴點 | 處理 |
|---|---|---|
| `p0-backtest-verification.md` PR 4 | `regimeSignalAudit.ts` 已在 PR 4 branch（commit `1dda605`） | Stage 5 的 A/B 比較 reuse 這個 function |
| `p1-trend-follow-strategy.md` | trend follow 消費 `regimeVector.trend` | 本 plan 改 regime engine 後 trend follow 的 signal 會變 — P1 的 backtest 需要跑在 V2 regime 上 |
| `i-unify-storage.md` | 無直接依賴 | — |
| `i-position-tracking-alignment.md` | regime engine 屬於跨 strategy 的 upstream infrastructure | 本 plan 不改 matrix model 的 column / layer ownership |

**啟動順序**：
- **前置條件**：PR 4 完成（backtest harness + regimeSignalAudit 已 ship）
- **並行 OK**：P1 trend follow 可以先用 V1 regime 跑 backtest，V2 通過後 re-run
- **不阻擋**：P0 PR 5a / PR 5b 的 LP work 可以先 ship，本 plan 的 LP consumer 端改動（Stage 3 Group 3.B）之後 additive commit

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | N/A (無 UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — 本 plan 為 brainstorming 產出初稿。下一步是 `/plan-eng-review`。
