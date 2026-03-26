---
paths: ["src/runners/**", "src/services/**"]
alwaysApply: false
description: "Phase 0 / Phase 1 Pipeline 原則"
---

# Phase 0 / Phase 1 Pipeline 原則

- **嚴格分離 I/O 與純計算**
- **Phase 0 (Prefetch)**：所有 RPC / API 呼叫必須集中在此階段並行處理
  - 使用 `rpcRetry`
  - 結果存入 `appState`
- **Phase 1 (Compute)**：**純函式**，禁止任何 `await`、RPC、API
  - 輸入：從 `appState` 或 Prefetch 結果取得
  - 輸出：計算結果物件
- 違反此原則會導致回測不穩定與效能問題