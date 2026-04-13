---
paths: ["src/services/strategy/**", "src/services/position/**", "src/services/shadow/**", "src/bot/**"]
alwaysApply: false
description: "Position tracking mental model — 4 layer × N strategy 矩陣"
---

# Position Tracking Model — 4 層 × N 策略矩陣

> 本 rule 定義 DexBot 所有 position tracking 的概念模型，所有新增 strategy / tracking 功能必須對號入座。衍生自 `i-position-tracking-alignment.md` brainstorm（2026-04-11）。

## 核心原則

Position tracking 是一個 **二維矩陣**：

- **Layer 軸（角色維度，forever stable）**：4 種「問題類型」
- **Strategy 軸（可擴充）**：目前 1 個策略 class（LP），未來 P1+ 加入 FundingRate / Options / ...

## 4 層角色（strategy-agnostic）

| Layer | 回答的問題 | Ownership / lifecycle |
|---|---|---|
| **L0 Reality** | 現在鏈上實際是什麼狀態？ | 策略自有 scanner，in-memory only，重啟從 seed (tokenId list) 重 scan |
| **L1 Advice** | advisor 當下對這些倉位有什麼意見？該開？該關？ | 策略自有 state tracker，持久化到 `state.json` 的 `<strategy>AdvisorState` key |
| **L2 Counterfactual** | 如果聽了 advisor 的建議，結果會怎樣？ | 策略自有 shadow driver，append-only JSONL 寫到 `storage/shadow/<strategy>/` |
| **L3 History** | 過去發生過什麼？已平倉倉位長什麼樣？ | 策略自有 archive writer，append-only JSONL 寫到 `storage/history/<strategy>/` |

### 層之間的硬規則

- **L0 是唯一 truth**，其他層**只能讀不能改 L0**
- **L1 / L2 互不干擾**：shadow 不影響 real advice；real advice 不污染 shadow
- **L3 append-only**，歷史不可 mutate
- **Derived views**（close reason counter、advice tracking feedback loop）**不寫 L0-L3**，只讀

## Matrix 現狀

```
                │ L0              │ L1                  │ L2              │ L3              │
────────────────┼─────────────────┼─────────────────────┼─────────────────┼─────────────────┤
LP (v3/v4/aero/ │ PositionScanner │ lpPositionAdvisor   │ lpShadowDriver  │ lpClosedPosArch │
 pancake 共用)  │ .positions      │ State (P0 Stage 3)  │ (backtest St 2) │ ive (未建, gap) │
                │ ✅ 既有          │ 📋 待建              │ 📋 待建          │ ⚠ 技術債        │
────────────────┼─────────────────┼─────────────────────┼─────────────────┼─────────────────┤
FundingRate     │ FundingRate     │ FundingRate         │ FundingRate     │ FundingRate     │
(P1 future)     │ Scanner         │ AdvisorState        │ ShadowDriver    │ Archive         │
────────────────┼─────────────────┼─────────────────────┼─────────────────┼─────────────────┤
Options (P3+)   │ 留給未來 brainstorm                                                         │
```

**Derived views**（非層，跨層投影）：
- Close reason counter → L3 `closeReason` 欄位的 aggregate → 路徑待定（P2 雜項決定）
- Advice tracking feedback loop → L1 決策 + 後續 cycle 的 L0 軌跡 → 路徑待定（P2 雜項決定）

## 目錄 & 命名 convention

**Strategy plugin 檔案住在 `src/services/strategy/<strategy>/`**：

```
src/services/strategy/
├── BollingerBands.ts / MonteCarloEngine.ts / ...   ← grandfathered，跨策略共用工具 + 舊既有程式
├── lp/                                              ← LP strategy plugin
│   ├── positionAdvisor.ts                           ← L1 純函數集（PR 3 已建）
│   ├── positionStateTracker.ts                      ← L1 state machine（P0 Stage 3 待建）
│   └── lpShadowDriver.ts                            ← L2 shadow driver（backtest Stage 2 待建）
├── fundingRate/                                     ← 未來 P1
│   └── ...
```

**既有檔案 grandfathered**：`MonteCarloEngine.ts` / `BollingerBands.ts` / `PnlCalculator.ts` / `rebalance.ts` 等留在 `src/services/strategy/` root。語意為「跨策略共用工具」或「舊既有程式碼」。未來 P1 refactor 可能會搬，但**本 rule 不要求立即搬**。

**測試位置**：`tests/services/` flat（既有慣例），**不**鏡射 source 的 `lp/` 巢狀結構。測試檔名含策略關鍵字即可（例如 `PositionAdvisor.test.ts`）。

## Plugin contract (conceptual)

每個策略 class 應該提供一組符合以下 interface 的模組（目前僅概念存在，LP 尚未形式上實作；P1 實作 FundingRate 時會順便把 LP 包一層 adapter）：

```ts
interface IStrategyTrackingPlugin {
  readonly name: StrategyClass;  // 'lp' | 'fundingRate' | ...

  // L0: 誰負責從外界（鏈、API）抓資料
  createScanner(deps): IReadOnlyPositionScanner<TPosition>;

  // L1: 誰負責 advice 狀態機
  createAdvisorStateTracker(deps): IAdvisorStateTracker<TAdviceState>;

  // L2: 誰負責 shadow counterfactual（optional）
  createShadowDriver?(deps): IShadowDriver<TShadowSnapshot>;

  // L3: 誰負責歷史歸檔（optional）
  createArchiveWriter?(deps): IArchiveWriter<TArchivedPosition>;
}
```

## Persistence 路徑約束

所有路徑**必須**經過 `src/config/storage.ts` 的 `STORAGE_PATHS` 常數，**禁止** hardcode 字串：

| Layer | 策略 | 路徑 |
|---|---|---|
| L1 | 任何 | `state.json` 的 `<strategy>AdvisorState` namespace |
| L2 | LP | `storage/shadow/lp/<YYYY-MM>.jsonl` + `storage/shadow/lp/analysis/<weekIso>.md` |
| L2 | FundingRate (future) | `storage/shadow/fundingRate/<YYYY-MM>.jsonl` |
| L3 | LP (未建) | `storage/history/lp/<YYYY>.jsonl` |
| L3 | FundingRate (future) | `storage/history/fundingRate/<YYYY>.jsonl` |

**注意**：`STORAGE_PATHS` 目前只有 `shadow` base path 跟 `shadowAnalysis`，**還沒有**策略子路徑常數（`shadowLp` / `history` / `historyLp`）。`i-position-tracking-alignment.md` Stage 3 task 會補上這些 entries。

## Derived views 規則

Derived views 是 aggregate 或投影，**不是層**。特性：

- **不寫 L0-L3**
- **只讀**
- 可以出現在 `storage/diagnostics/` 或獨立 top-level（例如 `storage/advice-tracking/`），**不**塞進策略子目錄
- 寫入路徑由各自的 brainstorm 決定，本 rule 不強制

## 嚴格邊界（違反以下即為 bug）

1. **L0 絕對是 read-only truth**：任何 service 都不能寫 `positionScanner.positions.push(...)` 或類似突變。唯一寫入者是 scanner 自己在 `scan()` 裡整個陣列重建。
2. **L1 state 必須跨 cycle 累積**：hysteresis counter 重啟不能歸零，必須從 `state.json` restore。
3. **L2 絕對不影響 real advice**：shadow driver 不能呼叫 `lpPositionAdvisorStateTracker.commit()` 或類似動作。兩者隔離。
4. **L3 append-only**：歷史紀錄寫完就凍結，不 update。要修正用新的 append 紀錄覆蓋前一筆。
5. **Cross-strategy advice 不屬於任何 column**：例如「關 V3 LP 開 FundingRate perp」這種跨 column 決策由 P1 `StrategyAllocator` 處理，不屬於 L1。

## 已知 open questions（延後決定）

1. **`appState.positions` dead field**：目前宣告但無寫入點。處理方式（刪除 vs 補活）延後決定，寫進 `tasks.md` P3 follow-up
2. **Registry ownership**：`IStrategyTrackingPlugin` 的 registry 住哪（獨立 singleton / AppState extension）— 留給 P1 brainstorm
3. **Main cycle 是否遍歷 plugin registry**：目前 cycle 只跑 prefetch + MC engine，不觸發 scanner。P0 Stage 4 的「倉位狀態監控 cron」是唯一會用到 plugin L0 的地方
4. **Composite strategies**（例如 delta-neutral = LP + short perp）：用 "view across columns" 處理，不加 matrix 列
5. **無 position 生命週期的策略**（例如 arbitrage、market making）：**不屬於**本 model scope，未來另開獨立 brainstorm

## 不適用本 model 的情況

- **Arbitrage / market making**：沒有持續倉位、只有交易事件序列。不是 position tracking 而是 trade tracking，另開 model
- **Aggregate stats**（close reason counter 等）：derived views，不是層
- **User config seed data**（`userConfig.wallets[].positions` 的 `WalletPosition`）：使用者宣告要追蹤的 tokenId 清單，**不是** L0。只是 L0 scanner 重建時讀的 seed
