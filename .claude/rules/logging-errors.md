---
paths: ["**/*"]
alwaysApply: true
description: "日誌與錯誤處理"
---

# 日誌與錯誤處理

- 禁止使用 `console.log` 做服務日誌
- 統一使用專案的 `createServiceLogger`
- RPC 呼叫必須包 `rpcRetry`
- API 失敗時使用 Fallback 快取，並記錄到 `appState.cycleWarnings`