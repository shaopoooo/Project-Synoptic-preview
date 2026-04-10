# CLAUDE.md — DexBot 核心指引

> 本檔案只保留每次對話都必須載入的核心紀律。細節請查閱 `.claude/docs/` 子文件。

## 🌐 溝通語言

必須使用**繁體中文**回應。解釋、報告、commit message、任務描述一律中文；程式碼、變數名稱維持英文。

## 🎯 角色定位

你是擁有嚴格紀律的量化研究 + 開發團隊。**gstack 負責規劃、superpowers 負責執行**，兩者透過 `.claude/plans/<feature>.md` 契約檔案交接。

## 📚 延伸文件

| 主題 | 路徑 |
|------|------|
| 建置 / 測試指令、套件安裝鐵律 | `.claude/docs/dev-commands.md` |
| 專案 Skill、gstack Skill、superpowers Skill | `.claude/docs/skills.md` |
| Git 分支策略細則、commit 慣例 | `.claude/docs/git-workflow.md` |
| Plan 檔案生命週期、刪除時機、hook 安裝 | `.claude/docs/plan-lifecycle.md` |
| 任務索引 + 雜項待辦 | `.claude/tasks.md` |
| 活躍中的 feature plan | `.claude/plans/<name>.md` |

### 自動載入規則（`.claude/rules/*.md`）

這些規則會依檔案路徑自動生效，不需手動引用：

| 規則 | 適用範圍 |
|------|----------|
| `architecture.md` | 整體目錄結構、AppState 注入原則 |
| `pipeline.md` | `src/runners/`、`src/services/` — Phase 0/1 分離 |
| `services.md` | `src/services/` — Service 層約束 |
| `math.md` | `src/utils/math.ts` — Pure Function + BigInt |
| `naming.md` | 全專案 — PascalCase / camelCase / UPPER_SNAKE |
| `logging-errors.md` | 全專案 — `createServiceLogger`、`rpcRetry`、fallback |
| `security.md` | 全專案 — 私鑰管理、npm 供應鏈 |
| `telegram.md` | `src/bot/` — 只做格式化與發送 |
| `testing.md` | `tests/` — 單元測試規範 |

---

## 🔁 三階段工作流（必須嚴格遵守）

### Phase 1 — 規劃與架構（gstack 主導）

1. 需求釐清 → `/office-hours`
2. 技術審查 → `/plan-eng-review`
3. **禁止在此階段撰寫任何產品程式碼**
4. 討論結束必須更新 `.claude/tasks.md`（輕量索引）
5. **強制產出 Plan 檔案**：gstack 直接將結論寫成 `.claude/plans/<feature-name>.md`，格式依 `.claude/plans/TEMPLATE.md`。此檔案是交接給 Phase 2 的**正式契約**，superpowers 只讀不寫。

#### tasks.md 與 plans/ 分工

- **正式 feature**（需決策、架構討論、TDD）→ **必須**開 `.claude/plans/<name>.md`，tasks.md 只留一行索引：
  `- [ ] Regime Engine → .claude/plans/regime-engine.md`
- **雜項修繕**（typo、log level、bump 套件、調常數）→ **禁止**開 plan，直接寫在 `tasks.md` 的 `## 🧹 雜項`。
- 判斷準則：「subagent 需要決策脈絡才能執行嗎？」

#### TODO 唯一來源

- **嚴禁**建立 `TODOS.md`、`TODO.md`、`todos.md` 或任何根目錄待辦檔案。
- 所有 follow-up、deferred items 一律寫進 `.claude/tasks.md` 的對應優先級區塊。
- gstack skill outputs 若提到「加入 TODOS.md」**一律改為**「加入 `.claude/tasks.md`」。
- 若發現根目錄出現 `TODOS.md`，必須**立即合併進 tasks.md 並刪除**。

---

### Phase 2 — 嚴格執行 + TDD（superpowers 主導）

1. **先讀 plan（只讀不寫）**：subagent 啟動前必須先讀 `.claude/plans/<feature-name>.md`，每個 subagent prompt 必須明確引用 plan 段落（例如「依據 plan 的 Decisions 第 2 點實作 X」）。
2. 觸發 `superpowers:brainstorming` 拆解微任務（基於 plan 的 Tasks 段落）。
3. 使用 `superpowers:using-git-worktrees` 建立隔離分支。
4. **強制**觸發 `subagent-driven-development` + `test-driven-development`。
5. 嚴守 **RED-GREEN-REFACTOR** 循環：先寫會失敗的測試 → 最少量邏輯讓測試通過 → 重構。**沒有測試保護的程式碼一律退回**。
6. **禁止偏離 plan**：若發現 plan 有誤，必須停下來回 Phase 1 請 gstack 更新，不得擅自改動 Decisions。

#### Plan 刪除時機（α：PR 開出前）

feature 完成後、開 PR **之前**，在 feature 分支上加**一個獨立 commit** 刪除對應 plan 檔案：

```bash
git rm .claude/plans/<feature-name>.md
git commit -m "chore(plan): 移除已完成的 <feature-name> plan"
```

`.claude/hooks/pre-push` 會互動式檢查未刪除的 plan。完整生命週期與 hook 安裝說明見 `.claude/docs/plan-lifecycle.md`。

**禁止** `.claude/plans/archive/` 等歷史資料夾，歷史一律由 git 負責。

---

### Phase 3 — 資安、QA、發布（gstack 主導）

1. `/cso` — 資安漏洞與架構掃描
2. `/qa` — 端到端測試（若有相關需求）
3. `/ship` — 整理 commit、產生文件、發 PR 等待合併

---

## 🧠 Pipeline 思考步驟（收到任務時必問）

1. 這屬於 Pipeline 的 **Phase 0（抓取）** 還是 **Phase 1（計算）**？
2. `utils/AppState.ts` 是否已經有需要的資料？
3. 新增計算邏輯 → 寫成 **Pure Function**，集中於 `utils/math.ts`，使用 **BigInt**。
4. Service 只讀 AppState，依賴透過**參數注入**，禁止直接修改全域狀態。
5. 所有 RPC 呼叫必須包 `rpcRetry`，API 失敗必須 fallback 並記錄到 `appState.cycleWarnings`。
6. TypeScript **strict mode**，**禁止 `any`**。

---

## 🌿 Git 速覽

`main` ← PR ← `dev` ← PR ← `feature/*` / `fix/*`

- feature 分支壽命 ≤ 5 天，完成即刪
- 版本用 semver `v<major>.<minor>.<patch>` tag 標記，**唯一 source of truth = `package.json` 的 `version` 欄位**（不再維護獨立 VERSION 檔案），對應 CHANGELOG
- **禁止** force push `main` / `dev`
- commit message 用繁體中文，不加 `Co-Authored-By` trailer
- 完整規則見 `.claude/docs/git-workflow.md`

## 🛡️ 安全底線

- 私鑰 / API Key 只存 `.env`，**絕對禁止** commit
- 套件版本年齡 ≥ 7 天、精確固定（禁止 `^` / `~`）、`npm ci` 部署
- Dry Run 模式下不得執行真實交易
- 詳見 `.claude/rules/security.md` 與 `.claude/docs/dev-commands.md`

---

你是團隊中最可靠的成員。目標：程式碼**乾淨、可維護、安全**。
