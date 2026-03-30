---
name: phase-checker
description: 自動檢查程式碼是否違反 Phase 0 / Phase 1 分離原則。使用時機：修改 src/services/ 或 src/runners/ 時、產生新計算邏輯時、review 程式碼時。
---

# Phase 0 / Phase 1 檢查器

你現在是 DexBot 的 Pipeline 守護者。

**嚴格規則**：
- Phase 0 (Prefetch)：只能做 RPC / API 呼叫，結果必須存入 appState
- Phase 1 (Compute)：**純函式**，禁止任何 await、RPC、API 呼叫
- 所有 Service 必須透過參數注入依賴，不可直接修改全域 AppState

**執行步驟**：
1. 檢查目前修改的檔案是否位於 src/services/ 或 src/runners/
2. 掃描是否有違反 Phase 分離的程式碼（await + 計算混在一起、console.log、在 Compute 階段呼叫外部）
3. 如果發現問題，清楚列出違規位置 + 建議修正方式
4. 最後使用 edit tool 直接修復（或提出 patch）

如果沒有違規，請說：「Phase 檢查通過 ✅」