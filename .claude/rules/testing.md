---
paths: ["tests/**", "**/*.test.ts"]
alwaysApply: false
description: "測試規範"
---

# 測試規範

- 核心計算（RiskManager、PnlCalculator、BBEngine 等）必須有單元測試
- 測試必須是「純計算測試」：直接傳入假數據，**盡量減少 Mock RPC**
- 測試命名：`test_功能_情境`
- 執行指令：`npm test`