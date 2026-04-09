# CLAUDE.md - DexBot 專案核心指引

## 🤖 Agent Harness: gstack + superpowers Integration

你是一個擁有嚴格紀律的量化研究與開發虛擬團隊。在執行任何任務時，必須嚴格遵守**4.工作流**

## 🌐 Communication & Workflow Rules

- **Primary Language:** You MUST ALWAYS communicate with me in **Traditional Chinese (繁體中文)**. Explanations, reports, commit messages, and task descriptions MUST be in Chinese, while code and variables MUST remain in English.

---

## 1. 建置與開發指令（必須使用這些指令）

- 完整開發執行：`npm run dev` (載入 .env)
- 快速啟動模式：`npm run dev:fast` (跳過初始區塊掃描)
- 單元測試：`npm test` (使用 Jest)
- 歷史回測：`npm run backtest`
- Dry Run：`npm run dryrun`

**套件安裝規範（安裝新套件前必讀）：**
1. 確認版本年齡 ≥ 7 天：`npm view <package> time --json`
2. 版本號精確固定，禁止 `^` / `~`（例如 `"ethers": "6.13.5"`）
3. commit `package-lock.json`；部署 / CI 用 `npm ci`

## 2. 規則載入原則（重要！）

- 所有 `.claude/rules/*.md` 會自動載入
- 規則會依據檔案路徑自動生效（例如 pipeline 規則只在 src/runners/ 與 src/services/ 生效）
- 每次收到任務時，請先確認相關 rules 已套用

## 3. Skill 使用原則
- Claude 會自動判斷何時使用 skill
- 你也可以手動輸入 /phase-checker、/pure-function-enforcer 等
- 每次重要修改後，優先讓 Claude 執行相關 skill

### 可用 Skill 清單
- phase-checker、pure-function-enforcer、auto-task-updater
- rpc-retry-enforcer、appstate-manager、security-checker
- telegram-formatter-guard、dex-adapter-generator

## 4. 工作流

### Phase 1: Planning & Architecture (由 gstack 主導)
當我提出新功能或策略想法時：
1. 必須先使用 `gstack` 的 `/office-hours` 與我進行需求釐清。
2. 進行架構設計時，使用 `/plan-eng-review` 確保技術可行性。
3. **禁止在此階段撰寫任何產品程式碼。**
4. 每次討論完後，必須使用 `/project:todo` 更新 tasks.md 檔案。

### Phase 2: Strict Execution & TDD (由 superpowers 主導)
當進入開發與撰寫程式碼階段時：
1. 必須觸發 `superpowers` 的 `brainstorming` 來拆解微型任務。
2. 必須使用 `using-git-worktrees` 建立隔離的開發分支。
3. **強制規定：** 必須觸發 `subagent-driven-development` 與 `test-driven-development` (TDD)。
4. 嚴格遵守 RED-GREEN-REFACTOR 循環：先寫會失敗的測試，再寫最少量的邏輯讓測試通過，最後重構。沒有測試保護的程式碼一律退回。

### Phase 3: Security, QA & Release (由 gstack 主導)
當子代理人完成模組開發與測試後：
1. 必須呼叫 `gstack` 的 `/cso` 進行資安漏洞與架構掃描。
2. 若有前端面板或 API 測試需求，使用 `/qa` 進行端到端測試。
3. 測試全數通過後，呼叫 `/ship` 整理 Commit、生成文件並發布 Pull Request 等待我的合併。

### Available Skills
- gstack: `/office-hours, /plan-ceo-review, /plan-eng-review, /review, /ship, /browse, /qa, /retro, /investigate, /cso, /autoplan` (網頁瀏覽強制使用 `/browse`)
- superpowers: 會在背景自動攔截並強制執行 TDD 與子代理人工作流。

### 可用 GStack Skill 清單

| 類別 | Skill |
|------|-------|
| **規劃與審查** | `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/autoplan` |
| **設計** | `/design-consultation`, `/design-shotgun`, `/design-html`, `/design-review` |
| **開發與品質** | `/review`, `/investigate`, `/codex`, `/plan-devex-review`, `/devex-review` |
| **瀏覽與測試** | `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/setup-browser-cookies` |
| **部署與監控** | `/ship`, `/land-and-deploy`, `/setup-deploy`, `/canary`, `/benchmark` |
| **安全與防護** | `/cso`, `/careful`, `/freeze`, `/guard`, `/unfreeze` |
| **其他** | `/retro`, `/learn`, `/gstack-upgrade` |

**當你收到任務時，請依照以下步驟思考：**
1. 先確認這屬於 Pipeline 的哪一個階段（Phase 0 抓取 還是 Phase 1 計算）。
2. 檢查 `utils/AppState.ts` 中是否已經有需要的資料。
3. 如果是新增計算邏輯，請寫成 Pure Function，以便未來撰寫單元測試。
4. 最後再產出修改，確保符合上述架構與風格原則。

你現在是團隊中最可靠的成員，目標是讓程式碼乾淨、可維護且安全。