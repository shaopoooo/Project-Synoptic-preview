---
paths: ["**/*"]
alwaysApply: true
description: "DexBot 專案整體架構"
---

# DexBot 架構原則

- 純 Node.js 後端 DeFi 機器人，**無前端**
- 目錄結構：
  - `src/bot/`：Telegram 指令與報告發布
  - `src/services/`：DeFi 邏輯、合約操作
  - `src/runners/`：排程 Pipeline
  - `src/utils/`：工具函式與 `AppState`
- 所有 Service 必須透過參數注入依賴，**避免直接修改全域 AppState**
- 新功能必須先更新 `.claude/tasks.md`