---
paths: ["src/market/**", "src/engine/**", "src/infra/utils/math.ts"]
alwaysApply: false
description: "數學運算規範"
---

# 數學運算規範

- **禁止使用 decimal.js**
- 核心計算統一使用原生 `BigInt` 或 `@uniswap/v3-sdk` 的 Math 工具
- 所有數學函式必須是 **Pure Function**（無副作用）
- 關鍵計算邏輯集中在 `src/infra/utils/math.ts`