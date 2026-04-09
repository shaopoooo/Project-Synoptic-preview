# Runner 精簡重構 — Design Spec

> Status: Approved
> Date: 2026-04-09
> Purpose: 砍掉 regime engine 驗證不需要的 pipeline，讓 cycle 只跑 prefetch → MC → diagnostic

---

## Problem

Regime engine (Phase 0.5-3) 已實作完成，需要 24h live validation。但目前 `runCycle` 仍在呼叫舊的 compute（PnL/Risk/Rebalance）、position scanning、reporting pipeline。這些與 regime engine 驗證無關，增加 cycle 耗時且混淆診斷數據。

## Goal

精簡後的 cycle：

```
prefetchAll (pools + prices + BB + historicalReturns)
  → runMCEngine (regime vector + blended bootstrap)
    → diagnosticStore.append
```

不再有 position、PnL、risk、rebalance、reporting。

---

## Delete Files

| File | Reason |
|------|--------|
| `src/runners/compute.ts` | cycle 不再呼叫 computeAll |
| `src/runners/reporting.ts` | cycle 不再呼叫 runBotService |
| `src/runners/backgroundTasks.ts` | cycle 不再觸發背景任務 |

## Modify Files

### `src/runners/prefetch.ts`

移除：
- `fetchPositions`（positionScanner.fetchAll）
- `fetchFees`（FeeFetcher.fetchAll）
- `bandwidthTracker.update` / `updateBandwidthAvg`
- `gasCostUSD` fetch
- CycleData 回傳中的 `rawPositions`、`feeMaps`、`gasCostUSD`、`bandwidthAvg30D`

保留：
- `fetchPools` — MC 引擎需要池子資料
- `fetchTokenPrices` — BB 計算需要幣價
- `fetchBBs` — MC 引擎需要 MarketSnapshot
- `fetchHistoricalReturnsForPools` — MC 引擎的 bootstrap 母體

### `src/types/index.ts`

`CycleData` interface 移除：
- `rawPositions: RawChainPosition[]`
- `feeMaps: Map<string, FetchedFees>`
- `gasCostUSD: number`
- `bandwidthAvg30D: Map<string, number>`

保留：
- `pools`
- `marketSnapshots`
- `tokenPrices`
- `historicalReturns`
- `warnings`

### `src/runners/startup.ts`

移除：
- `positionScanner` 相關 import 與呼叫（restoreFromUserConfig、restoreDiscoveredPositions）
- 初始掃描區塊（prefetchAll + computeAll + positionScanner.updatePositions + appState.commit）
- `computeAll` import
- `refreshPriceBuffer` 呼叫

保留：
- Bot 啟動（startBot、setUserConfigChangeCallback、registerDiagnostics）
- State restore（loadState、restoreState、restorePriceBuffer、bandwidthTracker.restore）

### `src/index.ts`

移除：
- `computeAll` import
- `runBotService` import
- `positionScanner` import
- `isStartupComplete` flag
- runCycle 內的 computeAll / positionScanner / runBotService / triggerStateSave 呼叫

runCycle 精簡為：
```ts
async function runCycle(): Promise<CycleDiagnostic | null> {
    const t0 = Date.now();

    const tP = Date.now();
    const data = await prefetchAll();
    const prefetchMs = Date.now() - tP;
    if (!data) return null;

    const tMC = Date.now();
    let mc: MCEngineDiagnostic | null = null;
    try {
        mc = await runMCEngine(
            data.historicalReturns,
            botService.sendAlert.bind(botService),
            appState.activeGenome ?? undefined,
        );
    } catch (e) { log.error('MCEngine', e); }
    const mcEngineMs = Date.now() - tMC;

    return {
        cycleNumber: ++cycleCount,
        timestamp: t0,
        durationMs: Date.now() - t0,
        phase: { prefetchMs, computeMs: 0, mcEngineMs },
        pools: mc?.poolResults ?? [],
        activeGenomeId: appState.activeGenome?.id ?? null,
        summary: mc?.summary ?? {
            totalPools: 0, goPools: 0,
            oldVersionSkipCount: 0, newVersionRecoveredCount: 0,
        },
    };
}
```

## Not Changed

- `src/runners/mcEngine.ts` — 核心，不動
- `src/runners/WalkForwardValidator.ts` — Phase 3 用，不動
- `src/services/**` — 被 prefetch/mcEngine 引用的模組不動
- `src/bot/**` — Telegram 指令不動
- `src/utils/**` — 工具模組不動
