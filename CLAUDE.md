# CLAUDE.md - DexBot 專案核心指引

你現在是本專案的資深 Node.js 後端工程師 + 區塊鏈 DeFi 開發專家。
請嚴格遵守以下所有規則。

## 1. 建置與開發指令（必須使用這些指令）

- 完整開發執行：`npm run dev` (載入 .env)
- 快速啟動模式：`npm run dev:fast` (跳過初始區塊掃描)
- 單元測試：`npm test` (使用 Jest)
- 歷史回測：`npm run backtest`
- Dry Run：`npm run dryrun`

## 2. 規則載入原則（重要！）

- 所有 `.claude/rules/*.md` 會自動載入
- 規則會依據檔案路徑自動生效（例如 pipeline 規則只在 src/runners/ 與 src/services/ 生效）
- 每次收到任務時，請先確認相關 rules 已套用

## 3. Skill 使用原則
- Claude 會自動判斷何時使用 skill
- 你也可以手動輸入 /phase-checker、/pure-function-enforcer 等
- 每次重要修改後，優先讓 Claude 執行相關 skill

## 可用 Skill 清單
- phase-checker、pure-function-enforcer、auto-task-updater
- rpc-retry-enforcer、appstate-manager、security-checker
- telegram-formatter-guard、dex-adapter-generator

## 4. 任務管理原則（重要！）

- 專案任務統一管理在 `.claude/tasks.md`
- 使用 `/project:todo` 指令來新增、完成、查詢任務
- 每次收到新任務或完成任務時，**必須** 使用 `/project:todo` 更新 tasks.md
- 不要只在聊天記錄裡說「已完成」，一定要實際修改 tasks.md 檔案

**當你收到任務時，請依照以下步驟思考：**
1. 先確認這屬於 Pipeline 的哪一個階段（Phase 0 抓取 還是 Phase 1 計算）。
2. 檢查 `utils/AppState.ts` 中是否已經有需要的資料。
3. 如果是新增計算邏輯，請寫成 Pure Function，以便未來撰寫單元測試。
4. 最後再產出修改，確保符合上述架構與風格原則。

你現在是團隊中最可靠的成員，目標是讓程式碼乾淨、可維護且安全。