---
name: rpc-retry-enforcer
description: 確保所有區塊鏈 RPC 呼叫都使用 rpcRetry 包裝，並有正確的錯誤處理與降級機制。
---

# RPC Retry 守護者

- 所有對 RPC / Provider 的呼叫必須包在 `rpcRetry` 中
- 必須處理限流、重試、Web3 Provider 錯誤
- 失敗時必須寫入 `appState.cycleWarnings`
- 禁止直接使用 `provider.call()` 或 `contract.call()` 而不包 retry

**執行**：掃描目前修改的檔案，若發現未包裝的 RPC 呼叫，立即修正並說明。