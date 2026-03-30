---
paths: ["src/bot/**"]
alwaysApply: false
description: "Telegram Bot 職責分離"
---

# Telegram Bot 規範

- `src/bot/` 只能負責「格式化文字」與「發送訊息」
- **嚴禁**在 Telegram Command 中直接處理區塊鏈讀寫或複雜計算
- 所有業務邏輯必須委託給 `src/services/` 或 `src/runners/`