# Regime Engine — V1 vs V2 技術比較

> V1（production）與 V2（實驗中）的指標、scoring、演化、audit 結果比較。
>
> Regime 如何影響 MC 抽樣 → 見 `mc-engine.md` §6
> Price series 修正對 signal quality 的影響 → 見 `price-series-verification.md`

---

## 1. 使用的指標（相同底層，不同輸入）

兩版共用 `src/engine/shared/indicators.ts` 的底層函數，但**餵入的資料不同**：

| 指標 | V1 | V2 |
|------|----|----|
| **CHOP** | `calculateCHOP(candles, chopWindow)` — 原始 OHLCV | `calculateCHOP(rawCandles, chopWindow)` — 同樣原始 OHLCV（保留絕對振幅） |
| **Hurst** | `calculateHurst(candles.map(c => c.r), hurstMaxLag)` — **原始 log returns** | `calculateHurst(normalizedReturns, hurstMaxLag)` — **Z-score 正規化 returns**（3σ clamp） |
| **ATR** | 直接算，用於 RangeGuards | 不在 V2 scoring 裡用，但 audit 框架仍用 |

**差異關鍵：** V2 的 Hurst 吃的是 `(close - kalmanCenter) / max(ewmaStdDev, baselineVol)` 的 Z-score，不是 raw return。這移除了價格量級的影響（2023 低波動 vs 2024 高波動），但保留了**結構記憶**（趨勢持續性 vs 均值回歸）。

### 指標公式速查

**CHOP（Choppiness Index）**：`100 × log₁₀(ATRsum / totalRange) / log₁₀(n)`
- 範圍 [0, 100]，> 61.8 高度震盪，< 38.2 強趨勢
- ATRsum = Σ(high - low)，totalRange = max(high) - min(low)

**Hurst（R/S 分析）**：log-linear regression on (log(lag), log(avg R/S))
- 範圍 [0, 1]，H > 0.5 趨勢延續，H < 0.5 均值回歸，H ≈ 0.5 隨機遊走
- 對每個 lag (4 ~ maxLag) 分 chunk，算 R/S = (max累積偏差 - min累積偏差) / stddev
- 斜率即 Hurst 指數

**ATR**：`avg(high - low)` over last n candles（簡化版 True Range）

---

## 2. 前處理：V2 獨有的 DynamicBandEngine

V1 **完全無狀態** — 每次呼叫直接算指標。

V2 多了一個**有狀態的前處理層**（`src/engine/shared/DynamicBandEngine.ts`）：

```
Kalman Filter（追蹤 price center，零滯後）
    state: x (center estimate), p (error covariance)
    model: random walk (xPred = x, no drift)
    update: K = p / (p + r), x += K × innovation

EWMA Variance（追蹤波動率，快速反應）
    residual = close - kalmanCenter
    ewmaVar = (1 - α) × ewmaVar + α × residual²
    stdDev = √ewmaVar
```

**Phase A 演化**搜索 Kalman/EWMA 的三個參數：`q`（process noise）、`r`（measurement noise）、`alpha`（EWMA 衰減）。

**NormalizedMarketData 輸出**（`src/engine/shared/marketDataNormalizer.ts`）：

| 欄位 | 用途 |
|------|------|
| `kalmanCenter` | 動態追蹤的價格中軌 |
| `ewmaStdDev` | 即時波動率估計 |
| `baselineVol` | 整段窗口 log returns 的 stddev |
| `normalizedReturns[]` | 每根 K 線的 Z-score `= (close - center) / max(ewmaStdDev, baselineVol, 1e-8)`，clamp [-3, +3] → 餵 Hurst |
| `rawCandles` | 原封不動 → 餵 CHOP |

---

## 3. Scoring 邏輯（最核心的差異）

### V1：加法 scoring + 不對稱硬分類

**來源：** `src/engine/shared/MarketRegimeAnalyzer.ts`

```typescript
// Soft vector（softmax）
rangeScore = (chop - chopRangeThreshold) / 100 + (hurstRangeThreshold - hurst) / 1
trendScore = (chopTrendThreshold - chop) / 100 + (hurst - hurstTrendThreshold) / 1
neutralScore = 0.0  // 固定基準

// Hard signal（保守版）
if (chop > 55 AND hurst < 0.52)        → 'range'   // 雙重確認才敢說 range
if (chop < 45 OR  hurst > 0.65)        → 'trend'   // 任一觸發就喊 trend
else                                    → 'neutral'
```

**特點：**
- 加法：CHOP 和 Hurst 各自獨立貢獻分數，一個高另一個低可以互相抵銷
- 不對稱：Range 要 AND（保守），Trend 只要 OR（敏感）— **策略偏見 hardcode**
- neutralScore 固定 = 0，neutral 永遠是「兩邊都不夠強」的剩餘態

### V2：乘法 scoring + 零策略偏見

**來源：** `src/engine/shared/MarketRegimeAnalyzerV2.ts`

```typescript
// 先把指標映射到 [0, 1] 的「傾向度」
chopTrendness  = sigmoid(chopScale × (chopTrendThreshold - chop) / 10)
chopRangeness  = sigmoid(chopScale × (chop - chopRangeThreshold) / 10)
hurstTrendness = sigmoid(hurstScale × (hurst - hurstTrendThreshold) × 10)
hurstRangeness = sigmoid(hurstScale × (hurstRangeThreshold - hurst) × 10)

// 乘法 scoring（雙重確認）
trendScore   = chopTrendness × hurstTrendness        // 兩個都說 trend 才算
rangeScore   = chopRangeness × hurstRangeness         // 兩個都說 range 才算
neutralScore = (1-chopTrendness)(1-chopRangeness)(1-hurstTrendness)(1-hurstRangeness)

// 最後 softmax with temperature T
```

**特點：**
- 乘法：一個指標說 trend 另一個不說 → trendScore ≈ 0。**不能互相抵銷**，必須雙重確認
- 對稱：Range 和 Trend 用完全相同的邏輯，**零策略偏見**
- neutral 有獨立計算（四維乘積），不是剩餘態
- `chopScale` / `hurstScale` 是 GA 可搜索的

**數學含義：**
- V1 加法 = OR 邏輯的軟化版（一個指標夠強就夠了）
- V2 乘法 = AND 邏輯的軟化版（兩個指標都要同意）

---

## 4. Genome 搜索空間

| 參數 | V1 範圍 | V2 範圍 | 差異 |
|------|---------|---------|------|
| `chopRangeThreshold` | [45, 70] | [45, 70] | 相同 |
| `chopTrendThreshold` | [30, 55] | [38, 55] | V2 下界收緊（防退化） |
| `chopWindow` | [7, 28] | [7, 28] | 相同 |
| `hurstRangeThreshold` | [0.40, 0.60] | [0.40, 0.60] | 相同 |
| `hurstTrendThreshold` | [0.55, 0.80] | [0.55, 0.80] | 相同 |
| `hurstMaxLag` | [10, 40] | [20, 150] | V2 允許更長記憶 |
| `sigmoidTemp` | [0.1, 5.0] | [0.5, 3.0] | V2 收緊（防極端） |
| `atrWindow` | [7, 28] | [7, 28] | 相同 |
| `cvarSafetyFactor` | [1.0, 5.0] | [1.0, 5.0] | 相同 |
| `chopScale` | — | [0.5, 3.0] | **V2 新增** |
| `hurstScale` | — | [0.5, 3.0] | **V2 新增** |
| `enginePresetIdx` | — | [0, 9] 離散 | **V2 新增** |
| **總維度** | **9** | **12**（11連續+1離散） | +3 維 |

---

## 5. 演化引擎

| 面向 | V1 `EvolutionEngine.ts` | V2 `EvolutionEngineV2.ts` |
|------|-------|-------|
| **Phase 數量** | 1 phase（所有參數一起搜） | 2 phases（分離關注） |
| **Phase A** | 無 | 4 維：Kalman q/r + EWMA alpha → min `MSE(ln(ewmaVar), ln(parkinsonVar))` |
| **Phase B** | 全部參數 | 12 維：交易邏輯 + Phase A top-10 preset 離散選擇 |
| **Population** | 固定 20 | 可配置（Phase A: 100, Phase B: 50） |
| **Fitness V1** | walk-forward backtest PnL | — |
| **Fitness Phase A** | — | `-MSE(ln(ewmaStdDev²), ln(parkinsonVariance))` |
| **Fitness Phase B** | — | `PnL - W₁×MaxDD - W₂×HarmfulFlipFlops`（W₁=1, W₂=0.5） |
| **Genome repair** | 無 | `repairGenomeV2()`：強制語意正確性 |
| **Range penalty** | 無 | 零 range episode → fitness ×0.3 |
| **Operators** | crossover(5) + mutate(3) + seed(2) | crossover(25%) + mutate(15%) + seed(10%) |
| **Dimension mask** | 無 | 支持只 mutate 指定維度 |

**Phase A 的意義：** V1 直接用 raw return stddev 估波動率。V2 先用 Phase A 校準 Kalman + EWMA（找到最佳的「怎麼量波動率」），再用 Phase B 搜索「怎麼用波動率做決策」。兩個問題分開優化。

---

## 6. Signal Quality Audit（V2 獨有）

V1 **完全沒有 signal quality 審計**。

### 6a. Regime Signal Audit（`src/backtest/framework/regimeSignalAudit.ts`）

| 指標 | 定義 | 判定標準 |
|------|------|---------|
| `trendVsRangeRatio` | trend avg\|move\| / range avg\|move\| | > 2.0 強，< 1.0 反向 |
| `flipFlopRate` | 短命 episode / 總切換數 | 越低越穩定 |
| `pctWithinAtr24h` | range episode 24h 內留在 ATR band 的比例 | 越高越準 |
| `avgTrendDurationHours` | trend episode 平均持續時間 | V1 ≈ 7.2h |
| `DefenseEV` | V2 避開的 IL / V2 錯過的 fee | ≥ 1.0 Gate 1 |

### 6b. Signal Quality Statistics（`src/backtest/framework/regimeSignalQuality.ts`）

| 指標 | 定義 | 四次 audit 結果 |
|------|------|----------------|
| **Spearman IC** | rank(trend score) vs rank(forward 12h realized vol) | **-0.07 ~ -0.14**（結構性負） |
| **Precision** | 預測 trend 且真有大波動 / 預測 trend 總數 | 低 |
| **Recall** | 預測 trend 且真有大波動 / 真有大波動總數 | V2 修後 23%（>V1 19.5%） |
| **F1** | 2×P×R/(P+R) | V2 修後 0.202（>V1 0.181） |
| **KS Test** | trend 期間 \|return\| 分佈 vs non-trend 的 max CDF 差距 | D > 0.1, p < 0.01 |

### 6c. Price Series 對 Signal Quality 的影響

2026-04-17 驗證發現：先前四次 audit 使用 USD 價格而非 pool 原生 ratio，修正後 V1 IC 從 +0.10 降至 -0.02，tail events 暴跌 84%。詳見 `price-series-verification.md`。

---

## 7. 部署門檻（V2 Gate 系統）

| Gate | 條件 | 結果 |
|------|------|------|
| **Gate 0 — Signal Quality** | accuracy + F1 或 IC 合格 | 不過 → REJECT |
| **Gate 1 — DefenseEV** | `savedIL/missedFees ≥ 1.0` 且 `feesV2 ≥ 0.8×feesV1` | 不過 → REJECT |
| **CONSERVATIVE** | Gate 0 + Gate 1 都過但不夠強 | 保守部署 |
| **FULL** | 全面通過 + 強指標 | 可信賴部署 |

V1 沒有任何量化部署門檻。

---

## 8. 四次 Audit 結果

| | Audit 1（舊 genome） | Audit 2（fitness fix） | Audit 3（重跑） | Audit 4（窗口壓縮） |
|---|---|---|---|---|
| **變更** | Signal quality 上線 | W₁:2→1 + repairGenome + range penalty | 同 fitness 完整重跑 | chopWindow [4,14] hurstMaxLag [10,40] |
| **ETH mode** | REJECT | CONSERVATIVE | CONSERVATIVE | CONSERVATIVE |
| **BTC mode** | CONSERVATIVE | REJECT | REJECT | REJECT |
| **ETH IC** | -0.071 | -0.099 | — | -0.094 |
| **BTC IC** | -0.133 | — | — | -0.135 |
| **ETH F1** | 0.341 | 0.202 | — | 0.051 |
| **關鍵發現** | ETH genome 退化 | 修復退化，IC 仍負 | BTC 持續 REJECT | IC 不隨窗口改變 |

---

## 9. Pipeline 全景圖

```
V1:
  candles → CHOP(raw) ──┐
                         ├→ 加法 scoring → softmax → RegimeVector
  returns → Hurst(raw) ─┘

  (single-phase GA 直接搜 9 個參數)


V2:
  candles → DynamicBandEngine ──→ NormalizedMarketData
            (Kalman + EWMA)         ├── rawCandles → CHOP(raw)
                                    └── Z-score returns → Hurst(normalized)
                                                    ↓
                                    sigmoid × 乘法 scoring → softmax → RegimeVector

  Phase A GA (4D): Kalman q/r + EWMA α → top 10 preset
  Phase B GA (12D): 交易邏輯 + preset 選擇 → PnL - MaxDD - FlipFlop

  Signal Quality Audit: IC / F1 / KS → Gate 0/1 → FULL/CONSERVATIVE/REJECT
```

---

## 10. CHOP + Hurst 在 Ratio Data 上無效（2026-04-19 終極驗證）

### 驗證過程

MC Engine Upgrade（v0.3.0）和 Price Series Fix（PR #38）完成後，用 `verifySignalQuality.ts` 跑完整的四組對比（V1/V2 × USD/Ratio），確認 CHOP + Hurst 在 ratio data 上的預測力。

**驗證工具：** `npm run verify:signal-quality`（V1）和 `V2_MODE=1 npm run verify:signal-quality`（V2）
**數據：** 2 pool（Aerodrome + UniswapV3），MC_PATHS=100，ETHBTC 裁切至 pool 重疊窗口 5000 candles
**量測指標：**
- IC（Spearman Rank Correlation）：regime trend score 與未來 12h realized vol 的 rank 相關
- F1（Precision-Recall）：trend signal 是否對應實際 >3% 的大波動
- KS（Kolmogorov-Smirnov）：trend 和 non-trend 期間的 |return| 分佈差異

### 四組結果

| | V1 + USD | V1 + Ratio | V2 + USD | V2 + Ratio |
|---|---|---|---|---|
| **IC** | **+0.143** | +0.003 | +0.110 | -0.008 |
| **F1** | 0.274 | 0.051 | 0.093 | 0.033 |
| **KS p** | 0.000 | 0.054 | 0.102 | 0.000 |
| Precision | 0.246 | 0.029 | 0.232 | 0.038 |
| Recall | 0.309 | 0.202 | 0.058 | 0.029 |
| Tail Events | 1836 | 312 | 1836 | 312 |

### 結論

1. **Ratio data 上 IC ≈ 0（V1 和 V2 皆然）。** CHOP + Hurst 對 BTC/ETH ratio 的未來波動率沒有預測力，統計上等同隨機。不管是加法 scoring（V1）還是乘法 scoring（V2），結果一樣。

2. **之前四次 audit 的「穩定負 IC」（-0.07 ~ -0.14）部分來自 USD data 偏差。** Ratio data 上 IC 是零而非負，「反讀」假設不成立。

3. **USD 空間有弱預測力但不是交易標的。** V1 + USD 的 IC = +0.143 統計顯著，但實際在做的是 BTC/ETH ratio LP，USD 空間的預測力跟交易績效無關。

4. **V2 乘法 scoring 比 V1 差。** V2 + USD IC = 0.110 < V1 的 0.143；V2 + USD Recall 從 31% 崩潰到 5.8%。乘法 AND 的雙重確認要求太嚴格，導致幾乎不喊 trend。

5. **Tail events 暴跌 83%（1836 → 312）。** BTC/ETH ratio 的 12h >3% 波動極少（兩幣高度正相關 ρ ≈ 0.85），CHOP + Hurst 在低波動序列上沒有有效的 label 可學。

### 根因分析

CHOP + Hurst 量測的是**價格序列本身的動量/均值回歸特性**。在 USD 空間，BTC 價格有明確的趨勢和震盪交替，指標有弱預測力。但 BTC/ETH ratio 的波動來自兩個高度相關資產的**差異化走勢**（一方獨立走強），這種動態不是動量或均值回歸，而是**相關性結構的變化**。CHOP + Hurst 看不到這個。

### Regime 的有效使用方式

IC ≈ 0 不代表 regime 完全無用，而是不能當預測信號。有效的使用方式：

- **Context provider（已在用）：** `computeDynamicCoreRatio` 根據 regime 調整 core/buffer 資金分配。不需要 IC > 0，只需要分類一致性。
- **條件篩選器：** 不預測「什麼時候進場」，而是排除「什麼時候絕對不進場」。
- **倉位大小調節：** regime.range 高 → 多押，regime.trend 高 → 少押。長期正期望值不需要單次預測對。
- **不應用於：** `shouldClose` 的平倉觸發（`regime.trend > 0.6 → 平倉`），因為 trend signal 沒有預測力。

### 後續方向

見 `.claude/plans/t-regime-feature-exploration.md`（Cross-Asset Oracle 實驗）。核心思路：用 cross-asset 脫鉤特徵（rolling correlation、spread z-score、multi-timeframe vol ratio）取代 CHOP + Hurst，驗證是否能在 ratio data 上達到 IC > 0.05。

歷史修復歷程（四次 V2 audit、fitness rebalance、窗口壓縮實驗）見本文附錄。

### MC Engine 中的 Regime 依賴點

| 元件 | 用的 regime | 現狀 |
|------|-----------|------|
| `segmentByRegime` | V1 `analyzeRegime` | regime-weighted sampling ≈ 均勻抽樣（IC ≈ 0） |
| `computeTransitionMatrix` | V1 `analyzeRegime` | 基礎建設完成但未接入 live |
| `computeDynamicCoreRatio` | 只讀 `regimeVector.range/.trend` | 有效（context provider，不需要 IC > 0） |
| `shouldClose` | `regime.trend > 0.6` | **應移除或替換為即時信號**（IC ≈ 0，無預測力） |

---

## 附錄：V2 Audit 修復歷程（2026-04-16 ~ 04-17）

以下記錄 Regime V2 的四次 audit、fitness 修復、窗口壓縮實驗的完整過程，作為決策追溯。

### Fitness Rebalance（三管齊下）

第一次 audit 發現 ETH V2 genome 退化（`chopTrendThreshold > chopRangeThreshold`，語意倒置），根因是 `phaseBFitness` 的 MaxDD 懲罰 W₁=2 過重。修復：

1. W₁: 2 → 1（降低 MaxDD 懲罰）
2. `repairGenomeV2()`：強制 `chopRange > chopTrend + 2`、`hurstTrend > hurstRange + 0.05`
3. Range episode penalty：零 range episode → fitness ×0.3

### 四次 Audit 結果

| | Audit 1（舊 genome） | Audit 2（fitness fix） | Audit 3（重跑） | Audit 4（窗口壓縮） |
|---|---|---|---|---|
| **變更** | Signal quality 上線 | W₁:2→1 + repairGenome + range penalty | 同 fitness 完整重跑 | chopWindow [4,14] hurstMaxLag [10,40] |
| **ETH mode** | REJECT | CONSERVATIVE | CONSERVATIVE | CONSERVATIVE |
| **BTC mode** | CONSERVATIVE | REJECT | REJECT | REJECT |
| **ETH IC** | -0.071 | -0.099 | — | -0.094 |
| **BTC IC** | -0.133 | — | — | -0.135 |

### 窗口壓縮實驗（失敗）

將 chopWindow、hurstMaxLag、atrWindow 壓縮到更短時框，假設「更快的指標 = 更少的滯後 = IC 改善」。

結果：IC 與 fitness fix 版無統計差異（差值 < 1 SE ≈ 0.0325）。**IC 不隨指標速度改變，確認是指標本身的物理極限。**

### 2026-04-19 終極驗證（V1/V2 × USD/Ratio）

Price series fix + MC engine upgrade 後重新驗證，發現之前四次 audit 的「穩定負 IC」部分來自 USD data 偏差。Ratio data 上 IC ≈ 0（不是負的），CHOP + Hurst 對 ratio 動態完全無效。詳見本文 §10。
