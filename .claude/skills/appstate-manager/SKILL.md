---
name: appstate-manager
description: 確保正確使用 AppState（只讀取、不直接修改），所有 Service 必須透過參數注入。
---

# AppState 管理守護者

- 禁止 Service 直接修改 `global AppState`
- 所有依賴必須透過建構子或參數注入
- Prefetch 階段負責寫入 AppState
- Compute 階段只能讀取 AppState

**執行**：檢查新/修改的 Service，若違反立即提出修正 patch。