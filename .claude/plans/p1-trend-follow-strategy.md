# Feature: Trend Follow Strategy via Perp (P1 Phase 1)

> Path A brainstorming 產出，日期 2026-04-12。`/office-hours` → 下一步是 `/plan-eng-review`（可選 `/plan-ceo-review`）→ `superpowers:brainstorming` 定稿 → Phase 2 執行。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由本檔更新。
>
> **📐 對齊規則**：本 plan 遵守 `.claude/rules/position-tracking.md` 的 4 層 × N 策略矩陣 model。`trendFollow` 是新的 strategy class（新 column），跟既有 `lp` column 平行。檔案目錄 `src/engine/trendFollow/`。
>
> **⚠ 取代 `tasks.md` P1 舊版 brainstorm**：`tasks.md` 的 P1 Universal Strategy Engine 段落（含 Phase 1-3 detailed task list）是 2026-04 前的舊流程遺產，有 disclaimer 明確說「不具執行合約效力」。本 plan 正式**取代**那個段落的 Phase 1 部分 — 舊 Phase 1 的 framework-first 思路被拒絕，改採 strangler fig + 單一策略 wedge。`tasks.md` 該段落啟動本 plan 後應改為一行 index 指向本檔。

## Context（為何要做）

- **來源**：
  - `/office-hours` 2026-04-12：研究驅動 (d) + LP 漏洞痛點 (a 補強)，refuted 舊版 P1「通用框架 + 多策略插件」的 platform trap framing
  - 前置已 ship：Self-Learning Regime Engine (PR #19, 2026-04-10) — 提供 per-pool `regimeVector = { range, trend, neutral }`
  - 前置已 ship：PR 3 PositionAdvisor 純函數 (PR #28, 2026-04-12) — LP 策略的 L1 advisor，對齊 matrix model 住 `src/engine/lp/`
  - 前置已 ship：`.claude/rules/position-tracking.md` matrix model rule (2026-04-12, commit `37ebadf`) — 定義新策略必須住 `src/engine/<name>/`

- **動機 — 真實痛點**：
  - V3 LP 本質上是 **short volatility on the BTC/ETH ratio**（range-bound 時賺 fees，穿 range 時被 IL 吃掉）
  - 使用者在 live test 觀察過**錯過大行情**的具體事件（Q2 = ii）：LP 只賺 ~0.5% fees，同時段方向性曝險會賺 15%+
  - 使用者明確要求「**利用波動放大收益**」，不只是「波動期間不虧錢」
  - Regime Engine 已經在 classify per-pool regime，但它的 trend signal **目前沒有 actionable downstream**（LP advisor 只會 close、不會主動取得方向性曝險）
  - 使用者願意承擔方向性（「我原本沒有判斷方向的好方法，現在有做了我願意嘗試」）

- **核心 insight**：**trend follow via perp 是 strategy class，不是 "LP 的附件"**。BTC/ETH 是此 class 的第一個 instance（敘事上 "補 LP 的 short-vol 短板"），未來 SOL standalone 可能是第二個 instance（敘事上 "pure 方向性 speculation"）。兩個 instance 共用 signal 邏輯，只有 execution adapter 不同。

- **Research vs Production**：本 plan 是 **research-first, production-gated**。deliverable 是 backtest validation 報告，不是 production code。只有通過 pass criteria 才進 production。

## Goal（「改完了」的定義）

1. `src/engine/trendFollow/` 目錄存在，含 `trendAdvisor.ts` (pool-agnostic pure logic) + `executionAdapter.ts` (interface) + `adapters/pairTradeAdapter.ts` (BTC/ETH 實作) + `instances/btcEthInstance.ts` (config)
2. `src/engine/shared/MarketRegimeAnalyzer.ts` 加一個 signed trend direction scalar（由 `computeRegimeVector()` 輸出）
3. **一份 backtest 報告** in `storage/backtest-results/<date>/trend-follow-btceth-summary.md`，包含：
   - 6 個月 BTC/ETH ratio 歷史 × 固定 entry/exit rules 的 P&L
   - Sharpe ratio / 勝率 / max drawdown / trade count
   - 對 3 個 baselines 的相對表現：LP-alone / 50-50 BTC+ETH hold / cash
   - Pass/fail 判定（對照 pass criteria）
4. **Pass criteria 已定**（本 plan Stage 4 brainstorm，之前為 Open Question）
5. **若 pass**: 開新 plan 處理 production integration；**若 fail**: 寫 retrospective 文件 + 刪 plan（符合 Phase 2 α 規則）
6. `npm test` 全綠；`tsc --noEmit` 零 error

## Non-goal（明確不做）

- ❌ **Production deployment**：本 plan 只做 backtest validation。進 production 是 follow-up plan 的 scope
- ❌ **FundingRateStrategy / StrategyAllocator / LLM Strategy Advisor / Paper Trading / GP 表達式樹**：全部是 tasks.md P1 舊版 brainstorm 的 artifacts，跟本 plan 的 wedge 精神衝突。本 plan 不做、也不預留
- ❌ **Framework / IStrategy interface 抽象**：strangler fig — 當前只有 1 個策略 class (`trendFollow`)，抽象沒有 data 支撐。等 strategy #2 / #3 出現再 brainstorm framework
- ❌ **Paper trading system**：研究階段用 backtest 就夠，paper trading 是 production 前的額外 gate，屬於 follow-up plan
- ❌ **SOL standalone instance（Case B）**：獨立 strategy instance，需要獨立 brainstorm 驗證「SOL 的 regime signal quality」，不在本 plan scope
- ❌ **多池子 LP 套用 trend follow**：使用者目前只 LP 在 BTC/ETH 一個池子，沒有其他 LP 池子可套用此策略
- ❌ **Donchian breakout 獨立驗證（Approach B）**：office-hours 討論的對照實驗，降級為 tasks.md P2 follow-up，不在本 plan 的 wedge scope
- ❌ **MC engine 延伸到 perp EV（Approach C）**：太早做會混淆 research variable，等 wedge 驗證 edge 存在後才值得考慮
- ❌ **Options / delta-neutral gamma scalping / vol arb**：鏈上流動性不足，個人實作 overkill，不在任何近期 plan 的 scope

## Decisions（已定案，執行階段不得動搖）

### D1 — Framing = Research driven, pain-backed
- 來源: Q1 = (d) 研究驅動 + Q2 = (ii) 錯過大行情實測
- 目標不是「通用多策略框架」，是「驗證 regime engine trend signal 能否 actionable」
- 成敗以 **研究產出** 為準，不以 production ship 為準

### D2 — Strategy class = trend follow via perp，不是 "LP volatility wing"
- Office-hours Case B (SOL standalone) 揭露：同樣邏輯可跑在非 LP 資產上
- 結論：strategy identity = **trend follow**（行為），不是 **LP complement**（敘事）
- BTC/ETH instance 的 "LP complement" 敘事保留在 plan context，**不**影響 code 結構
- 未來 SOL instance 是**同一個 strategy class 的第二個 instance**，不是新 class

### D3 — Wedge = Approach A（subscribe regime signal），B / C 延後
- 選 A 因為：直接測試 research 核心命題（regime signal 可變現嗎？）、失敗成本最低、reuse 最大、research variable 集中
- B（Donchian 獨立對照）→ 移到 tasks.md P2 follow-up，本 plan 不做
- C（MC engine 延伸）→ 拒絕，原因是 research variable 會糾纏三件事
- 單一 entry rule: `regimeVector.trend` weight 超過 threshold 觸發
- 單一 exit rule: `regimeVector.range` weight 恢復至 dominant 或 trade 到達 time stop

### D4 — Execution = Pair trade on BTC-USD + ETH-USD perps
- BTC/ETH LP 池子的 native price = ratio，不是 absolute BTC 或 absolute ETH
- 方向性曝險必須透過 **pair trade**（long 一條腿 + short 另一條腿）才能精確對應 ratio 曝險
- Venue = Hyperliquid（鏈上 perp 流動性最佳，跟 Base / Aerodrome 生態兼容）
- Fixed USD notional per leg, **不**做 Kelly / volatility scaling / leverage optimization

### D5 — Direction derivation = signed scalar from recent returns
- `computeRegimeVector()` 目前輸出 magnitude 但無方向
- 加一個 `trendDirection: number` 欄位（+1 / -1 / 0），由 `sign(sum(last N hours of log returns))` 計算
- **N = 24**（24 小時，brainstorming 定稿確認）。理由：平衡 noise / responsiveness，跟 DexBot OHLCV 24h 計算窗口對齊
- 這是對 regime engine 的**唯一修改**，不影響 LP advisor

### D6 — Pool-parameterized module from day 1（P6 強化版）
- `trendAdvisor.ts` 吃 `(pool, regimeSignal, params)` 吐 `Decision`（純邏輯，pool 作為參數，不 hardcode BTC/ETH）
- `executionAdapter.ts` 是 interface，定義 `openPosition(direction, size)` / `closePosition(positionId)`
- `adapters/pairTradeAdapter.ts` 實作 BTC/ETH 需要的 pair trade 邏輯
- 未來 SOL instance 可加 `adapters/singleLegAdapter.ts` **without** 改動 trendAdvisor
- 這**不是** framework — 只是一個 2-method interface + 兩個實作的基本 separation

### D7 — Backtest-first, pass criteria gated production
- Deliverable = `storage/backtest-results/<date>/trend-follow-btceth-summary.md`
- 只有 pass criteria 達標才允許開 follow-up plan 處理 production
- **Pass criteria 已定（brainstorming 定稿 2026-04-13）**：
  - Sharpe ≥ **0.3**（trend follow 勝率天然低，0.3 = "signal 存在" 合理門檻）
  - vs LP baseline ≥ **+0 pp**（LP + trend follow 合計不低於 LP alone — 止血價值）
  - Max drawdown ≤ **20%**（pair trade 天然 DD 低，20% 保守）
  - Trade count ≥ **10**（6 個月最少 10 筆，統計最小門檻）
  - Win rate ≥ **30%**（trend follow 天然 30-40%，低於 30% = noise）

### D8 — Matrix model 對齊
- `trendFollow` = 新 strategy class column
- L0 Reality: 自己的 perp 部位，不共享 LP 的 `PositionScanner`
- L1 Advice: `trendAdvisor.ts`（本 plan 新建）
- L2 Counterfactual: 沿用本 plan 的 backtest 產出作為初版 shadow（未來另開 shadow observer）
- L3 History: trade archive，格式對齊 position-tracking rule 但**不實作**（留給 production 階段）
- Persistence: `state.json.trendFollowAdvisorState` namespace, backtest output in `storage/backtest-results/`

### D9 — 取代 tasks.md P1 舊版
- tasks.md P1 段落的 Phase 1 task list (MC 三層拆分、IStrategy interface、V3LPStrategy plugin、MC engine refactor) 被本 plan 明確**拒絕**
- 拒絕理由：framework-first 思路，當前只有 1 個策略 class 不值得抽象
- tasks.md P1 段落啟動本 plan 後應改寫：保留 disclaimer、保留 Phase 2a-3 未取代部分、把 Phase 1 替換為「see p1-trend-follow-strategy.md」

### D10 — Backtest 必須 model funding rate（Eng review A5=5A，從 Open Question 3 升級）
- `perpPnlCalculator.ts` 加一個 `fundingRatePer8h: number` 參數（default 0.03%）
- 每個 trade 的 P&L 扣除 `持倉小時數 / 8 × fundingRatePer8h × notional × 2 legs` 的 funding cost
- 理由：pair trade 72h time stop 下 funding drag 0.18-1.8%，研究階段不能假設零 funding，否則 Sharpe / P&L 都 systematically overestimate

### D11 — Backtest 需要 BTC-USD + ETH-USD 個別 price series（Eng review A4=4B）
- Pair trade 的 per-leg P&L 需要每條腿的**個別 USD 價格**，不是 BTC/ETH ratio
- **Data source = CoinGecko API**（brainstorming OQ6=a 定稿）：`/coins/{id}/ohlc` endpoint，1h granularity，用多次 query 覆蓋 6 個月
- 不接受 ratio 近似（4A）— user 明確要求精確 per-leg P&L

### D12 — Slippage model = 固定 5 bps per leg（brainstorming OQ4=b 定稿）
- 每條 perp leg 扣 **0.05%**（5 bps）slippage
- Pair trade 合計 ~0.1%/trade（兩條腿各扣）
- 理由：BTC + ETH perp 在 Hyperliquid 的 typical market impact 量級
- `perpPnlCalculator.ts` 加 `slippageBps: number` 參數（default 5）

### D13 — `STORAGE_PATHS.trendFollowState` 現在預留（brainstorming OQ5=b 定稿）
- 在 `src/infra/storage.ts` 新增 `trendFollowState: storage/trend-follow` entry
- Stage 3 backtest 不用（只用 `backtestResults`），但 live 階段（p1-trend-follow-production.md）會用
- 預留成本 = 零，跟 i-unify-storage 的 paper reservation 精神一致
- **注意**：此 entry 應在本 plan Stage 1 或前置步驟加入，因為 `i-position-tracking-alignment` Phase 2 的 storage.ts 擴充可能已跑完，需要另開一個 additive commit

## Rejected（已否決，subagent 不得再提）

### Framing
- ❌ **"通用策略框架 + 多策略插件"**（舊 P1 core framing）：platform trap — 當前只有 1 個策略，抽象沒有 data 支撐
- ❌ **"LP volatility wing"**（office-hours 中期 framing）：太窄，SOL standalone case 塞不進去。真正 identity 是 trend follow strategy class
- ❌ **"Multi-strategy portfolio" 一次建好**：違反 research discipline (一次驗一個變數)

### Strategy 選擇
- ❌ **(A) Pure perp directional 無 entry rule**：沒有 signal = 沒有 edge，等於 random trading
- ❌ **(B) Options straddle / strangle**：鏈上 options 流動性差 (Lyra / Premia / Aevo 都還在 bootstrap)
- ❌ **(C) Current implementation — Donchian**：對照實驗有價值但會 confound research variable，降級至 P2 follow-up
- ❌ **(D) MC-driven EV maximization**：糾纏三個 hypothesis，延後到 wedge 驗證 edge 存在後
- ❌ **(E) Vol arbitrage (implied vs realized)**：鏈上 vol surface 不存在
- ❌ **(F) Gamma scalping**：專業機構策略，個人實作 overkill

### Wedge approach
- ❌ **Approach B (Donchian indicator)** as main wedge：違反 research variable isolation 原則，只能當對照實驗 → P2
- ❌ **Approach C (MC engine 延伸)** as main wedge：複雜度高、同時驗證三件事
- ❌ **先蓋 ISignal / IStrategy interface 再填策略**：rule of three 未達、platform trap
- ❌ **Framework 抽象 `PricePathGenerator` / `RiskMetrics`**（舊 P1 Phase 1 task）：violation of strangler fig，等 strategy #2 + #3 才考慮

### Execution
- ❌ **Single-leg perp for BTC/ETH**：池子是 ratio-denominated，單腿無法精確對應曝險
- ❌ **Hardcode BTC/ETH in trendAdvisor**：違反 D6 pool-parameterized
- ❌ **Kelly sizing / volatility scaling**：free parameters 太多、research scope creep
- ❌ **Leverage > 1x**：加風險不加 edge，research 階段禁用

### Scope
- ❌ **包含 SOL standalone instance**：獨立 brainstorm，不同 baseline、不同 pass criteria
- ❌ **包含 FundingRate / StrategyAllocator / LLM advisor / Paper trading / GP**：舊 P1 artifacts，跟本 plan 精神衝突
- ❌ **同時測 2-3 個 instances**：失去 wedge discipline
- ❌ **Production deployment**：research plan，不碰 live trading

### 一般原則
- ❌ **Plan 標註時間預估**：違反 CLAUDE.md "Avoid giving time estimates"

## Constraints（必須遵守的專案規則）

- **`.claude/rules/position-tracking.md`**：trendFollow 是新 strategy class column，必須住 `src/engine/trendFollow/`。Matrix model 嚴格 boundary（L0 read-only truth、L1/L2 隔離、L3 append-only）適用
- **`.claude/rules/architecture.md`**：`trendAdvisor` 是 pure function module，不是 class。參數注入，不修改全域 AppState
- **`.claude/rules/pipeline.md`**：`trendAdvisor` 屬於 Phase 1 (compute)，不含 I/O。`executionAdapter` 屬於 Phase 0 (prefetch) 或 runner 層，所有 RPC 用 `rpcRetry`
- **`.claude/rules/math.md`**：Perp P&L 計算必須用 BigInt 或精確數學，集中至 `infra/utils/math.ts` 或本 module 的 pure math helper
- **`.claude/rules/naming.md`**：純函式 camelCase (`trendAdvisor.ts`)、Interface `IExecutionAdapter`、TypeScript strict 禁 `any`
- **`.claude/rules/logging-errors.md`**：execution adapter 的 RPC 失敗必須 log + 寫入 `appState.cycleWarnings`
- **`.claude/rules/security.md`**：Hyperliquid API key 只存 `.env`，禁止 commit
- **CLAUDE.md 命名規則**：Stage 1 / Group 1.A / Task 1.A.1，**不**用 Stage A/B/C
- **CLAUDE.md Plan 獨立性原則**：本 plan 只讀不寫其他 plan。**例外**：Stage 5 task 對 `tasks.md` P1 段落的 rewrite 屬於本 plan scope 內的合法操作
- **i-position-tracking-alignment Phase 2 依賴**：本 plan 的 `src/engine/trendFollow/` 路徑依賴該 plan 的 Stage 3 storage.ts 擴充（加 `STORAGE_PATHS.trendFollowState` 之類的 entry？ — 見 Open Question 2）

## Interfaces（API 契約）

### Data flow（Eng review A1）

```
┌──────────────┐     ┌──────────────┐     ┌────────────────┐     ┌──────────────┐
│ Regime Engine │────►│ trendAdvisor │────►│ IExecution     │────►│ PairTrade    │
│ (PR #19)     │     │ (pure fn)    │     │ Adapter        │     │ Adapter      │
│              │     │              │     │ (interface)    │     │ (impl)       │
│ regimeVector │     │ TrendDecision│     │                │     │ via          │
│ + direction  │     │ open/close/  │     │ openPosition() │     │ IPerpClient  │
│   scalar     │     │ hold         │     │ closePosition()│     │ (BacktestSim │
└──────────────┘     └──────────────┘     └────────────────┘     │  or Hyper)   │
       ▲                                                          └──────────────┘
       │ HourlyReturn[]                                                  │
       │ from pool OHLCV                                                 ▼
┌──────────────┐     ┌──────────────┐                           ┌──────────────┐
│ prefetchAll  │     │ BTC-USD +    │                           │ BacktestResult│
│ (existing)   │     │ ETH-USD      │──► perpPnlCalculator ───►│ P&L / Sharpe │
└──────────────┘     │ price series │    (per-leg accurate)     │ / baselines  │
                     │ (A4=4B 新增) │                           └──────────────┘
                     └──────────────┘
```

### `src/engine/trendFollow/types.ts` — NEW（含 PoolRef + IPerpClient）

```ts
// PoolRef：最小 pool 識別型別（Eng review A2）
export interface PoolRef {
  poolAddress: string;
  dex: Dex;
}

// IPerpClient：perp venue 抽象（Eng review A3 = 3A）
// BacktestPerpSim 跟未來 HyperliquidClient 都 implement 此 interface
export interface IPerpClient {
  submitOrder(asset: string, side: 'long' | 'short', sizeUsd: number): Promise<{ fillPrice: number; fillSize: number }>;
  closeOrder(asset: string, positionId: string): Promise<{ fillPrice: number; pnlUsd: number }>;
  getOpenPositions(): Promise<Array<{ asset: string; side: 'long' | 'short'; entryPrice: number; size: number }>>;
}
```

### `src/engine/trendFollow/trendAdvisor.ts` — NEW

```ts
// Pool-agnostic pure function. 吃 regime signal + pool context 吐 decision。
// 不做 I/O、不 import adapter implementation（只 import interface）

export interface TrendAdvisorParams {
  trendWeightThreshold: number;    // entry 觸發：trend weight 超過此值
  rangeWeightReentryThreshold: number;  // exit 觸發：range weight 恢復至此值
  directionLookbackHours: number;  // N for signed direction scalar (default 24)
  timeStopHours: number;           // hard time stop（避免 regime signal 卡住）
}

// Discriminated union（Eng review CQ1）— direction 只在 action=open 時存在
export type TrendDecision =
  | { action: 'open'; direction: 'long-ratio' | 'short-ratio'; reason: string }
  | { action: 'close'; reason: string }
  | { action: 'hold'; reason: string };

export function recommendTrendAction(
  pool: PoolRef,                               // which pool's regime signal to consume
  regimeVector: RegimeVector,                  // from PR #19 regime engine
  directionScalar: number,                     // +1/-1/0, from regime engine (D5)
  currentPosition: TrendPosition | null,       // existing trend follow position, null if flat
  params: TrendAdvisorParams,
  now: number,                                  // current timestamp, for time stop
): TrendDecision;
```

### `src/engine/trendFollow/executionAdapter.ts` — NEW

```ts
// Interface — NOT implementation. trendAdvisor 輸出 decision，adapter 翻成具體 trades。

export interface IExecutionAdapter {
  readonly name: string;  // e.g. 'pair-trade-btc-eth'

  /** 開倉：依方向 + notional 回傳具體 trades。異步因為要呼叫 perp venue API */
  openPosition(
    direction: 'long-ratio' | 'short-ratio',
    notionalUsd: number,
  ): Promise<TrendPosition>;

  /** 平倉：依 position id 平掉所有相關 legs */
  closePosition(positionId: string): Promise<TrendClosedPosition>;

  /** 查詢：回傳 adapter 持有中的 positions（backtest 時為 memory, live 時為 venue API） */
  getOpenPositions(): Promise<TrendPosition[]>;
}

export interface TrendPosition {
  id: string;
  pool: PoolRef;
  direction: 'long-ratio' | 'short-ratio';
  legs: PerpLeg[];                      // 1 leg (single-leg) or 2 legs (pair trade)
  openedAt: number;
  notionalUsd: number;
}

export interface PerpLeg {
  asset: string;          // 'BTC-USD' / 'ETH-USD' / 'SOL-USD' / ...
  side: 'long' | 'short';
  entryPrice: number;
  size: number;           // in base asset units
}

export interface TrendClosedPosition extends TrendPosition {
  closedAt: number;
  pnlUsd: number;
  pnlPct: number;
  closeReason: string;
}
```

### `src/engine/trendFollow/adapters/pairTradeAdapter.ts` — NEW

```ts
// BTC/ETH 專用 pair trade adapter
// 每個 open: 一次產生 2 legs (BTC-USD + ETH-USD 相反方向)
// 未來 SOL 會新增 singleLegAdapter.ts 在同目錄

import { IExecutionAdapter, TrendPosition, TrendClosedPosition } from '../executionAdapter';

export class PairTradeAdapter implements IExecutionAdapter {
  readonly name = 'pair-trade';

  constructor(
    private perpClient: IPerpClient,                           // injected (Eng review A3=3A, 解耦具體實作)
    private longAsset: string,                                 // 'BTC-USD'
    private shortAsset: string,                                // 'ETH-USD'
    private hedgeRatio: number,                                // notional ratio between legs (default 1:1)
  ) {}

  async openPosition(direction: 'long-ratio' | 'short-ratio', notionalUsd: number): Promise<TrendPosition> {
    // long-ratio = long BTC + short ETH
    // short-ratio = short BTC + long ETH
    // ...
  }

  async closePosition(positionId: string): Promise<TrendClosedPosition> { /* ... */ }
  async getOpenPositions(): Promise<TrendPosition[]> { /* ... */ }
}
```

### `src/engine/trendFollow/instances/btcEthInstance.ts` — NEW

```ts
// BTC/ETH instance 的 configuration — 獨立檔案方便未來加 solInstance.ts 等

export const BTC_ETH_TREND_FOLLOW_CONFIG: TrendAdvisorParams = {
  trendWeightThreshold: 0.6,          // 占位值，Stage 2 backtest tune
  rangeWeightReentryThreshold: 0.5,
  directionLookbackHours: 24,
  timeStopHours: 72,
};

export const BTC_ETH_POOL_REF: PoolRef = {
  // 實際 pool 地址，BTC/ETH on Aerodrome or PancakeSwap V3
  // 從 userConfig.wallets[].positions 或 appState.pools 取得
};
```

### `src/engine/shared/MarketRegimeAnalyzer.ts` — MODIFY（+ direction scalar）

```ts
// 擴充 RegimeVector type (在 src/types/index.ts)
export interface RegimeVector {
  range: number;
  trend: number;
  neutral: number;
  trendDirection: number;   // ← NEW: +1 / -1 / 0, sign of recent returns sum
}

// 擴充 computeRegimeVector() 實作
export function computeRegimeVector(
  candles: HourlyReturn[],
  genome: RegimeGenome,
  directionLookback = 24,   // ← NEW param
): RegimeVector {
  // ... 既有邏輯 ...
  const recentReturns = candles.slice(-directionLookback).map(c => c.r);
  const sum = recentReturns.reduce((s, r) => s + r, 0);
  const trendDirection = Math.sign(sum);
  return { range, trend, neutral, trendDirection };
}
```

**影響面**：`LpPositionAdvisor` 也會看到新的 `trendDirection` 欄位但**忽略它**（LP 邏輯不依賴方向）。零回歸風險。

### Backtest runner — `src/backtest/runTrendFollowBacktest.ts` — NEW

```ts
// Reuse p0-backtest-verification framework。新增 perp trade P&L simulator

interface BacktestResult {
  totalReturn: number;        // %
  sharpeRatio: number;
  maxDrawdown: number;        // %
  winRate: number;            // %
  tradeCount: number;
  baselines: {
    lpAloneReturn: number;    // 同期 LP hodl 的 return
    halfHalfHold: number;     // 50% BTC + 50% ETH hold
    cash: number;             // 0
  };
  verdict: 'pass' | 'fail';
  passCriteriaDetail: Record<string, 'pass' | 'fail' | 'n/a'>;
}
```

## Test Plan（TDD 起點，RED 階段測試清單）

### `tests/services/strategy/trendFollow/trendAdvisor.test.ts` — NEW

**規則邏輯 tests（pure function，無 mock）：**
- [ ] RED: `recommendTrendAction` 回傳 'hold' 當 regime trend weight < threshold 且無 position
- [ ] RED: 回傳 'open long-ratio' 當 trend weight 超 threshold + direction = +1 + 無 position
- [ ] RED: 回傳 'open short-ratio' 當 trend weight 超 threshold + direction = -1 + 無 position
- [ ] RED: 回傳 'hold' 當 trend weight 超 threshold 但已有 position
- [ ] RED: 回傳 'close' 當 range weight 恢復 reentry threshold + 已有 position
- [ ] RED: 回傳 'close' 當 trade 持有時間超過 timeStopHours（time stop）
- [ ] RED: direction = 0 時回傳 'hold'（方向不明確不進場）
- [ ] RED: current position 方向與 new signal 相反時 → 先 close，下一 cycle 才可能 open（不允許 flip 連續動作）

### `tests/services/strategy/trendFollow/pairTradeAdapter.test.ts` — NEW

**Adapter 邏輯 tests（mock `BacktestPerpSim`）：**
- [ ] RED: `openPosition('long-ratio', 1000)` 產生 2 legs: BTC-USD long $1000 + ETH-USD short $1000
- [ ] RED: `openPosition('short-ratio', 1000)` 產生反向 2 legs
- [ ] RED: `closePosition()` 同時平兩條 legs，回傳合併 P&L
- [ ] RED: `hedgeRatio` 非 1:1 時（例如 1.2）leg sizing 正確
- [ ] RED: 單腿 fill 失敗時整個 position 回滾（atomic）

### `tests/services/strategy/MarketRegimeAnalyzer.test.ts` — MODIFY

**新增 direction scalar tests：**
- [ ] RED: `computeRegimeVector()` 輸出 `trendDirection = +1` 當 recent 24h returns sum > 0
- [ ] RED: 輸出 `trendDirection = -1` 當 sum < 0
- [ ] RED: 輸出 `trendDirection = 0` 當 sum == 0
- [ ] RED: 既有 LP positionAdvisor 測試在 `trendDirection` 被加入後**全部仍綠**（回歸保護）

### `tests/backtest/trendFollow/perpPnlCalculator.test.ts` — NEW（Eng review T1A）

**Per-leg P&L 計算 tests（pure function，無 mock）：**
- [ ] RED: long BTC-USD $1000 at 50000, exit at 52000 → P&L = +$40 (+4%)
- [ ] RED: short ETH-USD $1000 at 3000, exit at 2800 → P&L = +$66.67 (+6.67%)
- [ ] RED: pair trade combined P&L = 兩條腿加總
- [ ] RED: funding rate deduction（0.03% per 8h × 24h 持倉 = 3 periods × 2 legs）→ P&L 減少對應金額
- [ ] RED: zero-duration trade（即開即關）→ P&L ≈ 0
- [ ] RED: entryPrice = 0 → throw error（不是 NaN 傳播）

### `tests/backtest/trendFollow/baselineCalculator.test.ts` — NEW（Eng review T2A）

**Baseline 計算 tests（pure function，無 mock）：**
- [ ] RED: LP-alone baseline（range period → positive fees, trending → negative IL）
- [ ] RED: 50-50 hold baseline（BTC +10% ETH +5% → 合計 +7.5%）
- [ ] RED: cash baseline = 0%
- [ ] RED: 手動算的 reference value 對比（golden test）

### `tests/backtest/trendFollow/runBacktest.test.ts` — NEW

**Backtest runner integration tests：**
- [ ] RED: fixture 餵入一個明確 trending period（假資料，ratio 持續上升）→ 回傳 non-zero trade count + positive P&L
- [ ] RED: fixture 餵入一個 range-bound period → trade count = 0（沒有 signal 觸發）
- [ ] RED: fixture 餵入 whipsaw period（signal flips 多次）→ 確認 time stop 正確觸發、沒有無限交易
- [ ] RED: 輸出 summary markdown 格式正確、含 3 個 baselines 對照

### `tests/integration/trendFollowEndToEnd.test.ts` — NEW

**End-to-end smoke test（跑完整小樣本 backtest）：**
- [ ] RED: 用 **30 天真實 OHLCV** 跑完整 backtest pipeline，verify 沒 crash、沒 NaN、沒 infinite P&L
- [ ] RED: 輸出的 summary.md 存在於 `storage/backtest-results/<date>/` 路徑（不是 hardcode）

## Tasks（subagent 執行順序）

### Stage 1 — 核心純邏輯 + Types + Advisor tests

**Group 1.A / Types & interfaces（sequential，blocking）**

1. **NEW** `src/engine/trendFollow/types.ts`：`TrendAdvisorParams` / `TrendDecision` / `TrendPosition` / `PerpLeg` / `TrendClosedPosition` type definitions
2. **NEW** `src/engine/trendFollow/executionAdapter.ts`：`IExecutionAdapter` interface definition（無實作）
3. **VERIFY**：`tsc --noEmit` 零 error

**Group 1.B / TrendAdvisor pure function（TDD）**

4. **RED**：寫 `tests/services/strategy/trendFollow/trendAdvisor.test.ts` 8 個 cases（見 Test Plan）
5. **GREEN**：實作 `src/engine/trendFollow/trendAdvisor.ts` 純函數
6. **REFACTOR**：確認無 `any` / strict 通過 / 命名一致（camelCase）

### Stage 2 — Regime engine direction scalar + PairTradeAdapter

**Group 2.A / Direction scalar（TDD，regression guard）**

7. **RED**：寫 `tests/services/strategy/MarketRegimeAnalyzer.test.ts` 新增 4 個 direction scalar cases
8. **GREEN**：`src/types/index.ts` 的 `RegimeVector` interface 加 `trendDirection: number`
9. **GREEN**：`src/engine/shared/MarketRegimeAnalyzer.ts` 的 `computeRegimeVector()` 加 direction 計算
10. **VERIFY**：既有 LP 相關 tests **全部仍綠**（特別是 `PositionAdvisor.test.ts` 21 個 cases）

**Group 2.B / PairTradeAdapter（TDD）**

11. **NEW**：`src/engine/trendFollow/adapters/BacktestPerpSim.ts`（backtest mode 用 mock，不做 RPC）
12. **RED**：寫 `tests/services/strategy/trendFollow/pairTradeAdapter.test.ts` 5 cases
13. **GREEN**：實作 `src/engine/trendFollow/adapters/pairTradeAdapter.ts`
14. **REFACTOR**：atomic rollback 邏輯、P&L 精度

**Group 2.C / BTC/ETH instance config**

15. **NEW**：`src/engine/trendFollow/instances/btcEthInstance.ts`（配置常數 + pool ref）

### Stage 3 — Backtest runner（TDD + integration）

**Group 3.A / Data source + Runner skeleton**

16. **NEW**：`src/backtest/trendFollow/fetchIndividualPrices.ts`（D11：取得 BTC-USD + ETH-USD 歷史 OHLCV，data source = CoinGecko API 或 exchange API，覆蓋 ≥ 6 個月。輸出格式對齊既有 `HourlyReturn[]` 或類似 typed array）
17. **NEW**：`src/backtest/trendFollow/runTrendFollowBacktest.ts` 入口 script
18. **REUSE**：參考 `p0-backtest-verification` 的 `runVerifyThresholds.ts` 架構（如果已存在）
19. **NEW**：`src/backtest/trendFollow/perpPnlCalculator.ts`（pure function，給定 entry/exit price per-leg 算 P&L + D10 funding rate deduction）
20. **NEW**：`src/backtest/trendFollow/baselineCalculator.ts`（LP alone / 50-50 hold / cash 的同期 return 計算，需要 BTC-USD + ETH-USD 個別 series）

**Group 3.B / P&L + baseline tests（Eng review T1A + T2A）**

21. **RED**：寫 `tests/backtest/trendFollow/perpPnlCalculator.test.ts` 6 cases
22. **GREEN**：perpPnlCalculator 實作（含 D10 flat-rate funding model）
23. **RED**：寫 `tests/backtest/trendFollow/baselineCalculator.test.ts` 4 cases
24. **GREEN**：baselineCalculator 實作

**Group 3.C / Runner integration tests**

25. **RED**：寫 `tests/backtest/trendFollow/runBacktest.test.ts` 4 cases（含 whipsaw edge case）
26. **GREEN**：完成 runner 實作
27. **RED**：寫 `tests/integration/trendFollowEndToEnd.test.ts` end-to-end smoke test
28. **GREEN**：實測 30 天真實 BTC/ETH OHLCV

**Group 3.D / Output format**

29. **NEW**：`src/backtest/trendFollow/summaryFormatter.ts`（產出 markdown summary，含 P&L / Sharpe / DD / 勝率 / 3 baselines 對照表 / pass/fail verdict）

### Stage 4 — Pass criteria definition + 6-month run

**Group 4.A / Pass criteria 已定（brainstorming 定稿 2026-04-13，見 D7）**

30. **VERIFY**：確認 pass criteria 已寫進 `summaryFormatter.ts` 的 verdict logic：
    - Sharpe ≥ 0.3
    - vs LP baseline ≥ +0 pp
    - Max drawdown ≤ 20%
    - Trade count ≥ 10
    - Win rate ≥ 30%
    - 五個全 pass = verdict PASS，任一 fail = verdict FAIL（在 summary.md 逐條標記）

**Group 4.B / 6-month run**

31. **RUN**：執行 `npm run backtest:trend-follow` 跑 6 個月 BTC/ETH 歷史（使用 D11 的 BTC-USD + ETH-USD 個別 price series）
32. **ANALYZE**：人工檢視 summary.md，對照 pass criteria 產出 verdict
33. **DECISION**：
    - **If pass** → Stage 5.A（勝利路徑）
    - **If fail** → Stage 5.B（失敗路徑）

### Stage 5.A — Pass path（若通過 criteria）

**Group 5.A / 產出 production follow-up plan**

34. **NEW**：`.claude/plans/p1-trend-follow-production.md`（新 plan，獨立 brainstorm scope）— 涵蓋 live deploy、Hyperliquid 實作（HyperliquidClient implements IPerpClient）、paper trading gate、monitoring、kill switch、position sizing refinement
35. **UPDATE**：`.claude/tasks.md` 路線圖加入新節點
36. **COMMIT**：本 plan 刪除（Phase 2 α 規則），artifacts（backtest report）留在 `storage/backtest-results/`

### Stage 5.B — Fail path（若未通過）

**Group 5.B / Retrospective doc**

34. **NEW**：`.claude/docs/p1-trend-follow-retrospective.md`（分析失敗原因：是 signal quality 不夠？還是 funding rate 吃掉 edge？還是 BTC/ETH ratio 在這 6 個月本來就不 trendy？）
35. **UPDATE**：`.claude/tasks.md` 的 P1 段落加入失敗記錄 + 下一個 idea 的 follow-up
36. **COMMIT**：本 plan 刪除

## Smoke Test Checklist

### Stage 1-3 完成時
- [ ] `npx tsc --noEmit` 零 error
- [ ] `npm test` 全綠（既有 153+ tests + 新增 trend follow tests ≥ 25 個）
- [ ] `rg "trendFollow" src/` 有 hits，verify 檔案在正確位置
- [ ] `rg "trendDirection" src/` 確認 regime engine 有更新
- [ ] `rg "positionStateTracker" src/` 仍然為空（本 plan 沒影響 LP column）

### Stage 4 執行前
- [ ] Pass criteria 數字已寫進本 plan 的 D7 段落（不是 open question）
- [ ] `src/backtest/trendFollow/` 下所有 test 綠
- [ ] Backtest 可以 dry-run 成功（小樣本不 crash）

### Stage 4 執行後
- [ ] `storage/backtest-results/<date>/trend-follow-btceth-summary.md` 存在
- [ ] Summary 含 6 個核心指標（Sharpe / 勝率 / DD / trade count / 3 baselines）
- [ ] Verdict 明確（pass 或 fail，不含糊）

## Open Questions — ✅ 全部已 resolve（brainstorming 定稿 2026-04-13）

1. ~~**Pass criteria 具體數字**~~ → **已寫入 D7**（Sharpe ≥ 0.3 / vs LP ≥ +0 pp / DD ≤ 20% / trades ≥ 10 / win rate ≥ 30%）
2. ~~**`directionLookbackHours` tune**~~ → **D5 確認 N = 24**
3. ~~**Funding rate 在 backtest 裡怎麼 model**~~ → **已升級為 D10**（flat-rate 0.03%/8h/leg）
4. ~~**Slippage model**~~ → **已升級為 D12**（固定 5 bps per leg）
5. ~~**`STORAGE_PATHS.trendFollowState`**~~ → **已升級為 D13**（現在預留 `storage/trend-follow`）
6. ~~**BTC-USD + ETH-USD OHLCV 資料來源**~~ → **已寫入 D11**（CoinGecko API）

**本 plan 無剩餘 Open Questions。所有執行參數已定案。**

## Risks

- **R1 / Regime signal direction 不穩** (confidence 7/10)
  - `sign(sum of last 24h returns)` 是最簡版本，可能 flip 頻繁 → false signal 多
  - Mitigation: 本 plan 接受此風險，Stage 4 backtest 會暴露問題，若嚴重則 Stage 5.B retrospective 分析原因

- **R2 / Pair trade execution basis risk** (confidence 9/10)
  - 兩條 leg 無法保證同時同價 fill，short-term basis risk
  - Mitigation: backtest 模擬裡假設零 basis，加 Open Question 4 flag；live 階段另開 plan 處理

- **R3 / Funding rate drain** (confidence 8/10)
  - 持倉時間若 > 幾小時，funding rate (typically 0.01-0.1% per 8h) 會吃掉 edge
  - Mitigation: D3 的 timeStop 設 72h 避免無限持倉；backtest 需 model funding cost（Open Question 3）

- **R4 / Backtest survivorship bias** (confidence 6/10)
  - 6 個月 BTC/ETH 資料可能剛好是 trending 或 range-bound period，不 representative
  - Mitigation: 跑不同 6 個月窗口做 walk-forward；Stage 4 analysis 要檢查 P&L 是否集中在少數 trades

- **R5 / LP 策略受 direction scalar 加入影響** (confidence 3/10, 低但需 guard)
  - `trendDirection` 欄位加到 `RegimeVector` type 後，LP 相關 code 若誤用會產生 silent bug
  - Mitigation: Stage 2 task 10 強制既有 21 個 LP tests 全綠才能進下一 stage

- **R6 / Matrix model gap — L3 archive 未實作** (confidence 5/10)
  - 本 plan 沒處理 trade archive (L3)，trend follow trade history 沒歸檔機制
  - Mitigation: 研究階段 backtest 產出就是歷史紀錄，production 階段另開 plan 處理 L3

- **R7 / `tasks.md` P1 段落 rewrite 可能遺漏** (confidence 4/10)
  - Stage 5 對 tasks.md P1 段落的 rewrite 可能漏掉跟 Phase 1 相關的某些舊內容
  - Mitigation: Stage 5 task 明確要求 `rg "Phase 1.*MC 三層拆分"` grep 驗證

## 與其他 plan 的依賴

| Plan | 依賴點 | 處理 |
|---|---|---|
| `i-position-tracking-alignment.md` Stage 2-6 | Matrix model rule 自動載入 + `STORAGE_PATHS` 擴充 | 本 plan Stage 1-3 需要該 plan Phase 2 已完成或同步進行 |
| `p0-position-advice-system.md` Stage 3-5 (PR 5a) | LP positionAdvisor state 整合 `stateManager` | 無衝突，兩者是 matrix 不同 column |
| `p0-backtest-verification.md` Stage 1 (PR 4) | Backtest framework 架構 | 本 plan Stage 3 reuse 該 plan 的 framework skeleton |
| Future `p1-trend-follow-production.md` | Stage 5.A 產出 | 本 plan pass 時才產生 |
| Future `p1-trend-follow-sol-instance.md` | SOL standalone instance | 與本 plan 獨立，不阻擋 |

**本 plan 啟動順序建議**：
- **前置條件**：`i-position-tracking-alignment` Phase 2 應先執行（Stage 2 CLAUDE.md rule 索引 + Stage 3 storage.ts 擴充）
- **並行 OK**：P0 PR 5a / PR 5b 的 LP-specific work 跟本 plan 不同 column，可並行
- **不阻擋**：本 plan 不需要等 P0 ship，研究驅動不依賴 production 狀態

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 5 issues found, 0 critical gaps — all resolved inline (A3=3A / A4=4B / A5=5A / T1=T1A / T2=T2A) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | N/A (無 UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Eng review 修改摘要**（2026-04-13，已全部套用）：
- **A1**：新增 data flow ASCII 圖（Interfaces 段落開頭）
- **A2**：定義 `PoolRef` type + 新增 `IPerpClient` interface（types.ts NEW 段落）
- **A3 → 3A**：`PairTradeAdapter` constructor 從 `HyperliquidClient | BacktestPerpSim` 改為 `IPerpClient`（解耦具體實作）
- **A4 → 4B**：Backtest 必須取得 BTC-USD + ETH-USD 個別 price series（不接受 ratio 近似）。Stage 3 新增 task 16 `fetchIndividualPrices.ts`，資料來源 = CoinGecko API（brainstorming OQ6 定稿）
- **A5 → 5A → D10**：Funding rate 從 Open Question 3 升級為 D10 決策（flat-rate model 0.03% per 8h per leg，必須實作）
- **CQ1**：`TrendDecision` 改為 discriminated union（direction 只在 action='open' 時存在）
- **T1 → T1A**：新增 `perpPnlCalculator.test.ts` 6 cases（per-leg P&L + funding deduction + zero-duration + NaN guard）
- **T2 → T2A**：新增 `baselineCalculator.test.ts` 4 cases（LP-alone + 50-50 hold + cash + golden test）
- **Task renumber**：Stage 3 task 16→29，Stage 4 task 30→33，Stage 5 task 34→36（新增 data source + P&L/baseline test Groups）

**UNRESOLVED:** 0

**VERDICT:** ENG CLEARED — Path A 第 3 步通過。下一步：`superpowers:brainstorming` 定稿（Path A 第 4 步）→ Phase 2 執行。
