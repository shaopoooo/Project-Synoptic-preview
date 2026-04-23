# HMM 與 LightGBM 協作架構

> **⚠️ V3 更新（v0.4.0）：** 本文件撰寫於 V3 之前。以下內容需注意：
> - V3 Regime Engine 不使用 HMM — 改用 `computeRegimeVectorV3`（multitf-vol + FTG 映射）
> - 文中「HMM Forward Filter → belief」的角色已由 `RegimeVector` 取代
> - 協作模式的「HMM belief 作為 LightGBM 特徵」→ 改讀為「RegimeVector 作為 LightGBM 特徵」
> - HMM 仍完整實作於 `transitionMatrix.ts`，可作為 LightGBM Round 2 的額外特徵
> - LightGBM 完整文件待 `t-triple-barrier-lightgbm` plan 完成後撰寫
>
> 原始文件保留供參考。實作細節見 `.claude/plans/t-triple-barrier-lightgbm.md`（LightGBM）。
> 2026-04-20 分析定案。

## 一句話

HMM 回答「我在哪」，LightGBM 回答「我該做什麼」。兩者協作，不競爭。

## 各自的角色

```
                ┌─────────────────────────┐
                │      市場數據 (OHLCV)     │
                └────────┬────────────────┘
                         │
           ┌─────────────┴─────────────┐
           ▼                           ▼
   ┌───────────────┐          ┌────────────────┐
   │  HMM Forward  │          │  LightGBM      │
   │  Filter       │          │  (ONNX)        │
   │               │          │                │
   │  輸入: 單一    │          │  輸入: 多特徵   │
   │  indicator    │          │  (12+ OHLCV    │
   │  (CHOP/Hurst) │          │   衍生)        │
   │               │          │                │
   │  輸出:        │          │  輸出:          │
   │  P(range)     │          │  P(profit)     │
   │  P(trend)     │          │  P(loss)       │
   │  P(neutral)   │          │  P(timeout)    │
   └───────┬───────┘          └───────┬────────┘
           │                          │
           ▼                          ▼
   ┌───────────────┐          ┌────────────────┐
   │ LP 參數調整    │          │ 開/關倉決策     │
   │ Dynamic Tranche│          │ 風險曝險調整    │
   │ MC path gen   │          │                │
   └───────────────┘          └────────────────┘
```

| | HMM | LightGBM |
|---|---|---|
| 問題 | 市場在什麼狀態？ | 下單結果會怎樣？ |
| 模型類型 | 生成式（狀態分布） | 判別式（特徵→結果） |
| 標籤 | 不需要（無監督） | 需要（triple-barrier） |
| 外部特徵 | 困難 | 天生強項 |
| Regime 轉換 | 內建（transition matrix） | 沒有 |
| 可解釋性 | 高（μ/σ per state） | 中（SHAP） |
| 語言 | TypeScript 原生 | Python 訓練 + ONNX 推論 |
| 現有基礎 | ~70%（缺 emission + forward filter） | 從零 |

## 協作模式

### 模式 1：HMM 的 belief 作為 LightGBM 的特徵

```
OHLCV → HMM Forward Filter → belief = [0.2, 0.7, 0.1]
                                         │
                                         ▼
         LightGBM features = [return_1h, vol_24h, ..., hmm_trend=0.7, hmm_range=0.2]
                                         │
                                         ▼
                              P(profit) = 0.6 → 開倉
```

HMM 的 state belief 變成 LightGBM 的 3 個額外特徵。LightGBM 自動學會「當 HMM 認為是 trend 但 vol 很低時，其實不用怕」這種非線性關係。

### 模式 2：LightGBM override HMM

```
HMM says: P(trend) = 0.8 → 系統準備放寬 LP 區間
LightGBM says: P(profit) = 0.7 → 但模型預測下單會獲利

→ 保持窄區間（LightGBM 的 profit 信號 override HMM 的 trend 警告）
```

LightGBM 有更多資訊（多特徵），在特定情境下比 HMM 更準確。用 LightGBM 的 confidence 作為 HMM decision 的 veto gate。

### 模式 3：分層負責

```
HMM → 控制 MC 模擬的 path generation（已有的用途）
      控制 Dynamic Tranche 的 core ratio

LightGBM → 控制 shouldOpen / shouldClose 的最終決策
           控制 position sizing（風險曝險比例）
```

各管各的，不互相干擾。HMM 管「環境設定」，LightGBM 管「行動決策」。

## 執行順序

```
Phase 1: t-regime-feature-exploration (TypeScript)
│
├── Stage 0: raw CHOP/Hurst IC
│   ├── |IC| > 0.05 → 修 mapping，不需要 HMM 也不需要 LightGBM
│   ├── |IC| 0.03~0.05 → HMM Forward Filter（D20）
│   │   ├── HMM IC > 0.05 → HMM 就夠了
│   │   └── 不夠 → Stage 1
│   └── |IC| ≤ 0.03 → Stage 1（新特徵）
│
├── Stage 1-5: 新特徵探索
│   └── 結果 → IC 框架評估 + triple-barrier target 交叉驗證
│
Phase 2: t-triple-barrier-lightgbm (Python)
│ 用 Phase 1 識別的有用特徵 + triple-barrier labels 訓練 LightGBM
│ 先 BTC/USDT 驗證，再 ETHBTC ratio
│
Phase 3: 整合（需獨立 plan）
│ ONNX 部署 + 協作模式選擇（1/2/3）
│ HMM belief 作為 LightGBM 特徵 or 分層負責
```

**關鍵：Phase 2 依賴 Phase 1 的結果。** Phase 1 的 IC 框架告訴你哪些特徵有用（線性預測力），Phase 2 的 LightGBM 測試這些特徵的非線性組合是否更強。如果 Phase 1 找到 |IC| > 0.05 的特徵，Phase 2 仍然有價值（可能發現 IC 框架看不到的交互效果）。

## 「用結果推結果」的診斷

MFT 哲學批評傳統技術指標是「用結果推結果」。

**CHOP/Hurst 確實是。** 它們從過去價格算出來，是後照鏡。

**HMM 的 transition matrix 不是。** 它回答的是「如果現在在 range，接下來轉到 trend 的機率是多少」，這是前瞻性推理。但如果輸入的 regime label 本身是 noise（IC ≈ 0），轉移矩陣算出來也是 noise 的轉移，沒有意義。

**LightGBM 取決於特徵。** 如果餵入的是 OHLCV 衍生特徵（returns, vol, ATR），它仍然是「結果推結果」，只是用非線性方式。真正的突破在於加入 MFT 領先因子（funding rate, 清算水位, LP 深度），這些是結構性信號，不是價格衍生。

**結論：框架不是問題，特徵才是。** HMM 和 LightGBM 都是好框架。關鍵是餵入有因果機制的領先特徵，而不是滯後指標。
