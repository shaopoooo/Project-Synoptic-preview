---
name: pure-function-enforcer
description: 確保數學與計算邏輯是 Pure Function，使用 BigInt 且集中在 utils/math.ts。使用時機：新增 PnL、Risk、Rebalance 等計算邏輯時。
---

# Pure Function 守護者

- 所有數學運算必須是 **Pure Function**（無副作用、無 await）
- 禁止使用 decimal.js → 一律使用 BigInt 或 @uniswap/v3-sdk Math
- 核心計算請集中在 `src/utils/math.ts`
- 複雜金融邏輯必須在函式上方加上中文註解 + 公式推導

**執行**：掃描新/修改的計算函式，若不符合立即修正並說明。