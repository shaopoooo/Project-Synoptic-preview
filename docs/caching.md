# 快取架構

> 系統中所有快取機制的完整清單：記憶體 LRU、磁碟 OHLCV、狀態持久化。

---

## 1. 快取總覽

| 快取 | 位置 | 上限 | TTL | 持久化 |
|------|------|------|-----|--------|
| volatilityCache | 記憶體 LRU | 100 | 6h | state.json |
| poolVolCache | 記憶體 LRU | 100 | 30m | state.json |
| PriceBuffer | 記憶體 Map | 24h/pool | 按年齡修剪 | state.json |
| priceCache（Binance） | 記憶體 Map | 無限制 | 每 cycle 清除 | 否 |
| tokenPrices | 記憶體物件 | 1 份 | 2m | 否 |
| gasCostCache | 記憶體物件 | 1 份 | 5m | 否 |
| bandwidthTracker | 記憶體陣列 | 8,640/pool | 滑動窗口 | state.json |
| OHLCV Store | 磁碟 JSON | 3,600/pool | 永久 | 永久 |

---

## 2. LRU 快取（`src/infra/utils/cache.ts`）

兩個 LRU 快取實例，共用相同的 eviction 策略（超過 max size 時淘汰最久未使用的 entry）。

### volatilityCache — 30 天年化波動率

```
Key:    poolAddress
Value:  { vol: number, expiresAt: number }
Max:    100 entries
TTL:    6 小時（BB_VOL_CACHE_TTL_MS）
```

- **寫入**：`PoolMarketService.fetchDailyVol()` 成功取得後寫入
- **讀取**：BB 計算、RiskManager 風險評估
- **Fallback**：API 失敗且過期 → `BB_FALLBACK_VOL`（50%）

### poolVolCache — Pool 交易量

```
Key:    poolAddress
Value:  { daily: number, avg7d: number, source: string, expiresAt: number }
Max:    100 entries
TTL:    30 分鐘（POOL_VOL_CACHE_TTL_MS）
```

- **寫入**：`computePoolVolume(poolAddress, candles)` 從本地 OHLCV 計算後寫入
- **讀取**：Pool stats、fee 計算
- **來源**：本地 OHLCV candles（由 `syncAllOhlcv` 預先取得，零 API）
- **Fallback**：candles 不足（< 24 根）→ daily=0, avg7d=0

---

## 3. PriceBuffer — 小時收盤價（`PoolMarketService`）

```
結構:   Map<poolAddress, Map<hourTimestamp, price>>
保留:   每 pool 最近 24 小時
修剪:   addPrice() 時自動刪除 > 24h 的 entry
```

- **寫入**：每 cycle `refreshPriceBuffer()` 用鏈上 tick 價格更新當前小時
- **讀取**：`computeDynamicBB()` 取最近 20 個小時價格算 SMA / stdDev
- **序列化**：`getPriceBufferSnapshot()` → `state.json` 的 `priceHistory` 欄位

---

## 4. priceCache — Binance Per-Cycle 快取（`PriceSeriesProvider`）

```
結構:   Map<symbol, RawCandle[]>     // e.g. 'ETHBTC' → candles
生命週期: 單一 cycle
清除:   每 cycle 開始時 clearPriceCache()
```

- **目的**：同一 cycle 內多個 pool 用同一個 Binance symbol（如 ETHBTC）時，只打一次 API
- **寫入**：`resolveReturnsLive()` → `fetchBinanceKlines()` 成功後寫入
- **讀取**：同 cycle 的其他 pool 查同 symbol → cache hit
- **不持久化**

---

## 5. tokenPrices — Token 即時價格（`TokenPriceService`）

```
結構:   { ethPrice, cbbtcPrice, cakePrice, aeroPrice, fetchedAt }
TTL:    2 分鐘（TOKEN_PRICE_CACHE_TTL_MS）
```

- **來源**：DexScreener API（4 token 平行 `Promise.allSettled()`）
- **Fallback**：單一 token fetch 失敗 → 保留上次 cache 的價格
- **讀取**：PositionAggregator（USD 估值）、報告格式化、BB 計算
- **不持久化**（重啟後重新 fetch）

---

## 6. gasCostCache — Gas 成本估計（`rpcProvider`）

```
結構:   { usd: number, expiresAt: number }
TTL:    5 分鐘（GAS_COST_CACHE_TTL_MS）
```

- **計算**：`maxFeePerGas × GAS_UNITS_COMPOUND × ethPrice`
- **來源**：RPC `getFeeData()`（live gas price）+ DexScreener（ETH/USD）
- **Fallback**：fetch 失敗 → `GAS_COST_FALLBACK_USD`（$1.50）
- **不持久化**

---

## 7. bandwidthTracker — BB 頻寬滑動窗口（`BandwidthTracker`）

```
結構:   Record<poolAddress, number[]>    // 時序排列的 bandwidth 值
上限:   8,640 entries/pool（30 天 × 288 cycles/day @ 5min）
淘汰:   FIFO（超過上限刪最舊）
```

- **寫入**：每 cycle BB 計算後 `update(poolAddress, bandwidth)`
- **讀取**：`getAvg()` 回傳 30 天平均 bandwidth，用於 BB pattern detection（squeeze / expansion）
- **持久化**：`state.json` 的 `rpcBandwidthWindows` 欄位

---

## 8. OHLCV Store — 磁碟歷史數據（`HistoricalDataService`）

```
路徑:   storage/ohlcv/coingecko-pro/{pair}/{poolAddress}.json
        storage/ohlcv/binance/{coin}/*.json
格式:   OhlcvStore { poolAddress, network, lastFetchedTs, candles[] }
深度:   150 天（3,600 根 1H candle per pool）
寫入:   atomic（先寫 .tmp 再 rename，防 SIGINT 損壞）
```

- **首次**：CoinGecko Pro API 分頁回填 150 天
- **增量**：每次只 fetch `lastFetchedTs` 之後的 gap + 1 根 overlap
- **過濾**：寫入前過濾未完結蠟燭（`ts >= currentHourTs`），確保只保留已結算的完整小時
- **Merge**：`mergeCandles()` 同 ts 保留 volume 較高的
- **永久保留**，不過期

---

## 9. 狀態持久化層（`state.json`）

所有標記「持久化」的快取統一透過 `stateManager` 寫入 `data/state.json`。

```typescript
PersistedState {
  volatilityCache,           // LRU snapshot
  poolVolumeCache,           // LRU snapshot
  priceHistory,              // PriceBuffer snapshot
  rpcBandwidthWindows,       // BandwidthTracker snapshot
  stakeDiscoveryLastBlock,   // 增量掃描進度
  userConfig,                // 錢包 + 倉位 seed
  shadowAdvisorState         // L2 虛擬倉位狀態
}
```

- **Save**：每 cycle 結束 + graceful shutdown（atomic write）
- **Restore**：啟動時 `loadState()` → `restoreCache()`，跳過已過期的 entry
- **Recovery**：parse 失敗 → 警告並 cold start（空狀態）

---

## 10. 資料新鮮度層級

```
即時        鏈上 tick（RPC，每 cycle）
  ↓
2 分鐘      Token 即時價格（DexScreener）
  ↓
5 分鐘      Gas 成本估計（RPC + DexScreener）
  ↓
每 cycle     PriceBuffer 小時價、Binance ratio price
  ↓
30 分鐘     Pool 交易量（本地 OHLCV 計算）
  ↓
6 小時      30D 年化波動率
  ↓
永久        OHLCV 磁碟快取 150 天（CoinGecko Pro，增量更新）
```

---

## 11. Fallback 策略總覽

| 快取 | API 失敗時 |
|------|-----------|
| volatilityCache | stale cache → `BB_FALLBACK_VOL`（50%） |
| poolVolCache | candles 不足 → daily=0, avg7d=0 |
| priceCache（Binance） | 改用 pool OHLCV（USD，σ 偏高 1.4×）+ `cycleWarning` |
| tokenPrices | 保留上次價格；全部失敗 → throw |
| gasCostCache | `GAS_COST_FALLBACK_USD`（$1.50） |

所有 fallback 都偏保守方向（波動率偏高 → 區間偏寬 → CVaR 更嚴）。

---

## 12. Alert Cooldowns（`alertService.ts`）

```
結構:   LRUCache<string, number>   // key = "ks:{poolKey}" 或 "shadow:{poolAddress}"
Max:    100 entries
持久化: 不持久化（重啟後清空）
```

三種 cooldown 防止同類告警重複推播：

| 類型 | Key 前綴 | TTL | 用途 |
|------|---------|-----|------|
| Kill Switch | `ks:` | 4 小時（`KILL_SWITCH_ALERT_COOLDOWN_MS`） | 邊界震盪時避免狂轟 |
| Shadow Advice | `shadow:` | 1 小時（`SHADOW_ALERT_COOLDOWN_MS`） | 同池 per-pool 降噪 |

不持久化是可接受的 — 重啟後短暫的重複告警遠比遺漏告警安全。

---

## 13. Rate Limiting

| API | 限制 | 處理方式 |
|-----|------|---------|
| Binance Public | 無顯式限制 | priceCache 確保同 symbol 每 cycle 只 fetch 一次 |
| DexScreener | 隱式限制 | `Promise.allSettled()` 容錯，失敗保留舊值 |
| CoinGecko Pro | API key，30 calls/min | 分頁 + 500ms 間隔 |
