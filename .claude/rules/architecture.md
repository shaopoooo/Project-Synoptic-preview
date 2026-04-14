---
paths: ["**/*"]
alwaysApply: true
description: "DexBot 專案整體架構"
---

# DexBot 架構原則

- 純 Node.js 後端 DeFi 機器人，**無前端**
- 目錄結構：
  - `src/bot/`：Telegram 指令與報告發布
  - `src/market/`：市場資料抓取、DEX 操作、事件監聽、倉位掃描
  - `src/engine/lp/`：LP 策略引擎（MC Engine 等）
  - `src/engine/shared/`：跨策略共用（WalkForwardValidator 等）
  - `src/infra/`：啟動流程、儲存、備份、工具函式與 `AppState`
- 所有 Service 必須透過參數注入依賴，**避免直接修改全域 AppState**
- 新功能必須先更新 `.claude/tasks.md`