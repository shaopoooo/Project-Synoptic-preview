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
4. 每次討論完後，必須使用 `/project:todo` 更新 `.claude/tasks.md`（輕量索引用）。
5. **強制產出 Plan 檔案**：gstack 在討論結束時，必須直接將結論寫成 `.claude/plans/<feature-name>.md`，作為交接給 Phase 2 的正式契約。此檔案由 gstack 撰寫、superpowers 只讀不寫。

#### Plan 檔案規格（gstack → superpowers 的唯一交接點）
Plan 檔案由 gstack 在 Phase 1 結尾產出，**格式與段落完全依照** `.claude/plans/TEMPLATE.md`。新增 feature 時直接複製該範本後填寫。**tasks.md 只是索引，真正的決策脈絡全部放在 plan 檔案**。

#### tasks.md 與 plans/ 的分工規則
- **正式 feature**（需決策、架構討論、TDD）→ **必須**在 `.claude/plans/<name>.md` 開 plan 檔案，`tasks.md` 只留一行索引：
  `- [ ] Regime Engine → .claude/plans/regime-engine.md`
- **雜項修繕**（typo、log level、bump 套件、調常數）→ **禁止**開 plan 檔案，直接寫在 `tasks.md` 的 `## 🧹 雜項` 區塊。
- 判斷準則：「這件事需要 subagent 依據決策脈絡執行嗎？」需要 → 開 plan；不需要 → 雜項。
- `tasks.md` 是總覽地圖，`plans/*.md` 是單一 feature 的契約；**兩者互補，不可取代**。

#### TODO 唯一來源：tasks.md
- **嚴禁**建立 `TODOS.md`、`TODO.md`、`todos.md` 或任何位於專案根目錄的待辦清單檔案。
- 所有 TODO、後續改進、deferred items、follow-up tasks **一律寫進** `.claude/tasks.md` 的對應優先級區塊（P0/P1/P2/P3/P4/雜項）。
- gstack skill（如 `/plan-eng-review`、`/plan-ceo-review`）的 outputs 若提到「加入 TODOS.md」**一律改為**「加入 `.claude/tasks.md` 的對應優先級」。
- 若發現專案根目錄出現 `TODOS.md`，必須**立即合併進 tasks.md 並刪除**。

### Phase 2: Strict Execution & TDD (由 superpowers 主導)
當進入開發與撰寫程式碼階段時：
1. **先讀 plan（只讀不寫）**：subagent 啟動前必須先讀 `.claude/plans/<feature-name>.md`，每個 subagent 的 prompt 必須明確引用 plan 的段落（例如「依據 plan 的 Decisions 第 2 點實作 X」）。plan 檔案由 gstack 維護，superpowers 執行階段**不得修改 plan 內容**。
2. 必須觸發 `superpowers` 的 `brainstorming` 來拆解微型任務（以 plan 的 Tasks 段落為基礎）。
3. 必須使用 `using-git-worktrees` 建立隔離的開發分支。
4. **強制規定：** 必須觸發 `subagent-driven-development` 與 `test-driven-development` (TDD)。
5. 嚴格遵守 RED-GREEN-REFACTOR 循環：先寫會失敗的測試，再寫最少量的邏輯讓測試通過，最後重構。沒有測試保護的程式碼一律退回。
6. **禁止偏離 plan**：若執行中發現 plan 有誤或需調整，必須停下來回到 Phase 1 請 gstack 更新 plan，superpowers 不得擅自改動 Decisions。

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

---

## 5. Git 分支策略（單人開發專用）

採用 **簡化版 GitHub Flow**，不使用 Git Flow（多人協作用的，對單人是負擔）。

### 分支結構
- `main` — 永遠可部署，等同線上 bot 正在跑的版本
- `dev` — 日常整合分支
- `feature/<name>` — 每個新功能 / 策略一個短命分支（壽命 ≤ 5 天）
- `fix/<name>` — bug 修復分支

### 強制規則
1. **一個 feature 一個分支**：命名如 `feature/regime-engine`、`fix/rpc-retry`，不得長期存活。
2. **feature → dev 必須走 PR**：即使自己 review 自己，也要走 PR 流程，讓 CI 擋住壞程式碼並留下變更紀錄。
3. **dev → main 走 PR**：main 只接受來自 dev 的 PR，**禁止**直接 commit 到 main。
4. **版本以 tag 標記**：每次發布用 `v<major>.<minor>.<patch>.<build>` tag，對應 CHANGELOG，出事時可快速 `git checkout <tag>` 回滾。
5. **優先用 worktree 取代 stash**：配合 `superpowers:using-git-worktrees`，主線 bot 可持續運行，新功能在另一個 worktree 開發，互不干擾。
6. **失敗分支直接刪除**：實驗失敗不要留著，`git branch -D` 清掉。單人開發的好處是不用顧慮別人。
7. **禁止 force push 到 `main` 與 `dev`**：只允許 force push 到自己的 `feature/*` 與 `fix/*` 分支。