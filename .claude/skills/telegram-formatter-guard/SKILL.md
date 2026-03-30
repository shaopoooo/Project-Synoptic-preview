---
name: telegram-formatter-guard
description: 強制 Telegram Bot 模組只能做格式化與發送，禁止任何業務邏輯。
---

# Telegram Formatter 守護者

- `src/bot/` 只能負責文字格式化與 `bot.sendMessage()`
- **嚴禁**在 Telegram Command 中直接呼叫 Service 或 RPC
- 所有業務邏輯必須委託給 `src/services/` 或 `src/runners/`

**執行**：修改 `src/bot/` 時自動檢查並修正違規。