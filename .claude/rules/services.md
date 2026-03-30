---
paths: ["src/services/**"]
alwaysApply: false
description: "Service 開發規範"
---

# Service 開發規範

- 不同 DEX（Uniswap V3/V4、Aerodrome、PancakeSwap）的差異必須封裝在 Adapter 層
- 禁止在主邏輯中寫大量 `if/else` 判斷 DEX 類型
- 所有 Service 建構子應接受依賴（Dependency Injection）
- 複雜金融邏輯（如 PnL、Risk、Rebalance）必須寫清楚的中文註解 + 公式推導