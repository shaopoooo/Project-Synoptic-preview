---
paths: ["**/*"]
alwaysApply: true
description: "安全性原則"
---

# 安全性原則

- 私鑰與 API Key 僅存於 `.env`，**絕對禁止** commit 到程式碼
- 所有外部呼叫必須有錯誤處理與降級機制
- Dry Run 模式下不得執行真實交易