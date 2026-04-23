# 蒙地卡羅模擬引擎

> MC 引擎的核心邏輯：bootstrap 抽樣、路徑生成、PnL 計算、候選區間評估。
>
> 數據如何進入系統 → 見 `data-pipeline.md`
> Regime 引擎細節 → 見 `regime-engine.md`

---

## 1. MC 引擎在系統中的角色

蒙地卡羅引擎是系統的**核心決策引擎**。它回答一個問題：

> 「在這個池子、用這個區間佈倉，未來 14 天我會賺還是賠？」

它**不預測**價格方向，而是用歷史數據模擬 10,000 種可能的未來，統計得出期望報酬和風險。

**來源：** `src/engine/shared/MonteCarloSimulator.ts`

---

## 2. 核心思想：Historical Bootstrap（非參數化）

MC engine **不假設任何理論分佈**（不是 GBM、不是 normal distribution）。它直接從 720 根真實歷史 K 線的 log return pool 中**有放回抽樣**，生成未來價格路徑。

這意味著：
- 天生攜帶**胖尾效應**（真實市場的極端事件就在 pool 裡）
- 天生攜帶**波動率叢集**（歷史窗口如果包含高波動期，抽到高波動 return 的機率更高）
- **不需要估計參數**（不需要算 μ 和 σ 然後代入公式）

---

## 3. 單條路徑生成（`runOnePath`）

```
輸入（RunOnePathParams object）：
  returns[720]      — 歷史 log return pool（bootstrap 母體）
  P0                — 初始價格
  Pa, Pb            — 佈倉區間 [lower, upper]
  L                 — 流動性常數（由 capital + P0 + Pa + Pb 算出）
  hourlyFeesBase    — 每小時費收（在 range 內時累加）
  horizonHours      — 336（14天 × 24小時）
  segments?         — regime 分桶後的 return pools
  regimeVector?     — regime 機率向量（加權抽樣用）
  blockSize?        — Block Bootstrap 每次連續取樣步數（預設 4）
  transitionMatrix? — 3×3 regime 轉移矩陣（null = 固定 regime）
  initialRegime?    — 模擬起始 regime
```

模擬迴圈支援三種抽樣模式：

```
currentRegime = initialRegime ?? regimeVector 最高權重

for h = 0; h < horizonHours; :

    // ① Transition Matrix：每個 block 開始時擲骰切換 regime
    if transitionMatrix:
        currentRegime = sampleNextRegime(matrix, currentRegime, rng)

    // ② Block Bootstrap（blockSize > 1 + segments）：
    //    從 currentRegime 的 bucket 連續取 blockSize 個 return
    //    保留短期波動率叢集和自相關性
    if segments + regimeVector + blockSize > 1:
        block = sampleBlock(segments, currentRegime, blockSize, rng)
        for ret in block:
            if h >= horizonHours: break     // 截斷
            P *= exp(ret)
            if Pa < P < Pb: fees += hourlyFeesBase; hoursInRange++
            h++

    // ③ Legacy single-point（blockSize=1 + segments）：V1 相容
    elif segments + regimeVector:
        ret = sampleBlended(segments, regimeVector, rng)
        // ... 同上單步

    // ④ 無 segments：均勻抽樣
    else:
        ret = returns[random(0, 719)]
        // ... 同上單步

結算：
  vlp = computeLpValueToken0(L, P_final, Pa, Pb)
  pnlRatio = (fees + vlp) / capital - 1
```

**V1 退化路徑：** `blockSize=1 + 無 transitionMatrix` → 行為與升級前完全一致。

---

## 4. Block Bootstrap（`sampleBlock`）

**來源：** `src/engine/shared/transitionMatrix.ts`

單點抽樣改為**區塊抽樣**。每次從 regime bucket 連續取 `MC_BLOCK_SIZE`（預設 4）根 return，保留短期波動率叢集和自相關性。

```
設計比喻：
  Transition Matrix 負責「宏觀天氣預報」（決定這個 block 經歷哪種天氣）
  Block Bootstrap 負責「微觀物理實境」（在選定天氣下播放一段真實歷史錄影帶）
```

- `blockSize = 1` → 退化為現有單點抽樣（V1 相容）
- bucket 長度 ≥ blockSize 但 startIdx 越界時 wrap around（`idx = (startIdx + b) % bucketLen`）
- **bucket.length < blockSize → fallback 到 neutral**（避免 wrap around 產生 `[A,B,A,B]` 假性循環污染 CVaR）
- 最後一個 block 超出 horizon 時截斷到剩餘步數
- **Regime Sampling Fallback (D13)：** target bucket 不存在或空 → 降級為 neutral bucket

### Episode 邊界自相關性斷裂

`segmentByRegimeV3` 的 regime bucket 混合了不同時段的 returns。blockSize=4 時約 ~14% 的 blocks 會跨 episode 邊界，自相關性在該邊界斷裂。已知限制，不追蹤 episode 邊界（複雜度不值得）。平均 episode 持續 ~29.5 小時，86% 的 blocks 在單一 episode 內。

---

## 5. Regime Transition Matrix（`computeTransitionMatrix`）

**來源：** `src/engine/shared/transitionMatrix.ts`

取代固定 regime 貫穿全程。模擬中每個 block 起始時依 3×3 馬可夫轉移機率擲骰決定 regime。

```
建構步驟：
  1. 用 sliding window 對每個小時呼叫 computeRegimeVectorV3() 得到 soft vector，
     再以 argmax 取得 hard label（range / trend / neutral）
  2. 統計跨 stride 步的轉移次數 → 3×3 count matrix
     stride = blockSize，確保 P(regime_t → regime_{t+blockSize}) 的時間尺度
     與模擬迴圈一致（避免用逐時機率應用在 4 小時跨度）
  3. Laplacian Smoothing：所有 count + 1，防止零機率死胡同
  4. 正規化：每 row 除以 row sum = 1.0

模擬時：
  起始 regime = regimeVector argmax（最高權重分量）
  每個 block 開始 → sampleNextRegime(matrix, current, rng) → 擲骰切換
```

**已知限制（V3 狀態）：**
- `computeTransitionMatrix` 已升級使用 `computeRegimeVectorV3` + argmax（`computeTransitionMatrixV3`），不再依賴 V1 `analyzeRegime`。
- **目前未接入 live 流程（Stage 1 鎖定 Mode 2）。** `lpMcRunner` 未呼叫 `computeTransitionMatrixV3`，`calcCandidateRanges` / `calcTranchePlan` 也未轉發 transitionMatrix 參數。Live MC 仍使用固定 regime 貫穿全程。整合排程見 `.claude/tasks.md`（Transition Matrix live 整合）。

---

## 6. Regime-Weighted Blended Bootstrap（`sampleBlended`，V1 路徑）

blockSize=1 時的 legacy 路徑，MC engine 與 regime engine 的交會點。

**不使用 regime 時：** 均勻從 720 個 return 中隨機抽。

**使用 regime 時：** 先依 regime vector 權重選 bucket，再從該 bucket 抽：

```
步驟：
  1. segmentByRegimeV3() 把 720 個 return 分成 3 桶（argmax 離散化）：
     - range bucket:   regime='range' 時期的 returns
     - trend bucket:   regime='trend' 時期的 returns
     - neutral bucket: regime='neutral' 時期的 returns
     （< 50 samples 的 bucket 併入 neutral）
  
  2. 每步抽樣：
     r = random()
     cumulative = 0
     for each bucket:
         cumulative += regimeVector[bucket.regime]
         if r <= cumulative:
             return bucket.returns[random()]
```

**效果：** 如果當前 regime 偏 range（regimeVector.range=0.7），模擬路徑的 return 主要來自歷史上 range 時期的 return（波動較小、均值回歸），而非 trend 時期的 return（波動大、方向性強）。

---

## 7. LP 價值計算（`computeLpValueToken0`）

模擬結束時，算 LP 倉位在終價 P_final 的 token0 價值：

```
if P ≤ Pa:          // 價格低於區間下界：只剩 token0
    V = L × (1/√Pa - 1/√Pb)

if P ≥ Pb:          // 價格高於區間上界：只剩 token1（換算成 token0）
    V = L × (√Pb - √Pa) / P

if Pa < P < Pb:     // 在 range 內：同時持有兩種 token
    V = L × (1/√P - 1/√Pb) + L × (√P - √Pa) / P
```

這是 Uniswap V3 concentrated liquidity 的標準公式。

---

## 8. PnL 計算（Interpretation B）

```
PnL_ratio = (fees_accumulated + V_LP(P_final)) / capital - 1
```

**Interpretation B = 純 token0 HODL 基準：** 不管幣價漲跌，只衡量「做 LP 是否比純持 token0 更好」。

- PnL > 0：LP 賺到比純持幣多
- PnL < 0：LP 不如純持幣（通常是被 IL 吃掉）
- PnL = 0：打平

---

## 9. 統計匯總（10,000 條路徑）

```
排序 pnlRatios[] (升序)

mean    = 算術平均
std     = 標準差
median  = 中位數
score   = mean / std                    // Sharpe-like（std < 1e-6 時歸零）

CVaR95  = 最差 5% 路徑的平均 PnL        // 尾部風險
VaR95   = 第 5 百分位的 PnL              // 損失門檻

p5, p25, p50, p75, p95                  // 完整百分位分佈
inRangeDays = 平均每條路徑在 range 內的天數
```

---

## 10. Go / No-Go 決策（CVaR Gate）

```
expectedFeesRatio = (dailyFeesToken0 / capital) × inRangeDays
safetyFloor = max(expectedFeesRatio, 1e-6)
cvarThreshold = -(safetyFloor × CVAR_SAFETY_FACTOR)    // 預設 1.5×

go = (CVaR95 > cvarThreshold)
```

**白話：** 最差 5% 路徑的平均虧損，不能超過預期費收的 1.5 倍。如果超過 → 這個區間的風險太高，不建議佈倉。

---

## 11. 候選區間評估（`calcCandidateRanges`）

MC engine 不只跑一個區間，而是測試多個 sigma 候選：

```
sigma 候選 = [1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.0] × ATR
                                                       ↑
                                             ATR_K_CANDIDATES

對每個 k:
    sigma = k × atrHalfWidth / stdDev1H
    lowerPrice = sma / (1 + sigma × stdDev1H)
    upperPrice = sma × (1 + sigma × stdDev1H)
    
    → 跑 MC simulation → 得到 MCSimResult
    → 過 CVaR gate → go / no-go

所有 go 的候選中，選 score（Sharpe-like）最高的
```

**寬區間 vs 窄區間的 trade-off：**
- 窄區間（低 sigma）：高 capital efficiency → 高 fee APR，但容易被打穿 → 高 IL 風險
- 寬區間（高 sigma）：低被打穿風險，但 fee APR 低 → 可能不值得做

MC engine 的 score 自動平衡這個 trade-off。

---

## 12. 雙倉佈局（`calcTranchePlan`）+ Dynamic Tranche

除了最佳單一區間，MC engine 還計算雙倉方案。

**升級前（V1）：** 固定 70/30 比例。
**升級後：** 由 `computeDynamicCoreRatio(regimeVector)` 動態決定比例。

```
公式：
  signal = regimeVector.range - (TREND_PENALTY × regimeVector.trend)
  coreRatio = clamp(BASE_RATIO + SENSITIVITY × signal, MIN_CORE, MAX_CORE)

設計理由：LP 對 Trend 和 Range 的反應應該非對稱 —
  Trend 是毒藥（1.5× 懲罰），Range 是解藥（1× 獎勵）。
```

| 情境 | Range | Trend | signal | coreRatio | V1 |
|------|-------|-------|--------|-----------|-----|
| 大晴天 | 0.8 | 0.1 | +0.65 | **0.90** | 0.70 |
| 不明朗 | 0.3 | 0.3 | -0.15 | **0.59** | 0.70 |
| 暴風雨 | 0.1 | 0.7 | -0.95 | **0.50** | 0.70 |
| null | — | — | 0 | **0.65** | 0.70 |

| 倉位 | 資金比例 | 區間 | 角色 |
|------|---------|------|------|
| **Core**（主倉） | 動態（50%~90%） | ±1.5σ（緊貼現價） | 高 APR 主力，正常賺 fee |
| **Buffer**（緩衝倉） | 餘量（10%~50%） | -3σ ~ -5σ（下方深水區） | 平時 OTM 不耗 gas，主倉被打穿後接落刀 |

---

## 13. 關鍵常數一覽

### MC 引擎常數

| 常數 | 值 | 意義 |
|------|-----|------|
| `MC_NUM_PATHS` | 10,000（live）/ 1,000（backtest） | 模擬路徑數 |
| `MC_HORIZON_DAYS` | 14 | 模擬天數 |
| `MC_WINDOW_HOURS` | 720 | Bootstrap 母體大小（30 天） |
| `MC_BLOCK_SIZE` | 4 | Block Bootstrap 每次連續取樣步數 |
| `CVAR_SAFETY_FACTOR` | 1.5 | CVaR gate 倍數 |
| `INITIAL_CAPITAL` | 1.0（live）/ 10,000（backtest） | 資金單位 |
| `POOL_TVL_PROXY` | 實際 pool 數據（live）/ $1M（backtest） | fee 計算分母 |

### Dynamic Tranche 常數

| 常數 | 值 | 意義 |
|------|-----|------|
| `TREND_PENALTY` | 1.5 | Trend 懲罰倍數（非對稱） |
| `TRANCHE_BASE_RATIO` | 0.65 | 中性時 core 比例 |
| `TRANCHE_SENSITIVITY` | 0.4 | signal 放大係數 |
| `TRANCHE_MIN_CORE` | 0.5 | core 下界（暴風雨） |
| `TRANCHE_MAX_CORE` | 0.9 | core 上界（大晴天） |
| `TRANCHE_CORE_SIGMA` | 1.5 | 主倉區間 σ 倍數 |
| `TRANCHE_BUFFER_SIGMA_NEAR` | 3 | 緩衝倉近端 σ |
| `TRANCHE_BUFFER_SIGMA_FAR` | 5 | 緩衝倉遠端 σ |

所有新增常數預設值為合理初始估計，正式校準交由 `t-parameter-validation`。
