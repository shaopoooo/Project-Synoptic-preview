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

### Phase 1 — 規劃與架構

新 feature 從以下三條 intake path 擇一進入。所有工具（gstack 與 Claude）都**直接修改** `.claude/plans/<priority>-<feature-slug>.md`，這是唯一 source of truth（不在 `~/.gstack/` 留中間檔）。

#### Path A — Big Feature（需求模糊，需要先 discover）
1. `/office-hours` → 直接寫到 `.claude/plans/<priority>-<slug>.md`
2. `/plan-ceo-review`（optional，可多輪）→ 修改同檔案
3. `/plan-eng-review`（必要）→ 修改同檔案
4. `brainstorming`（必要，最後一步定稿）→ 修改同檔案
5. → Phase 2 執行

#### Path B — Medium Feature（idea 清楚）
1. `brainstorming`（必要，第一步）→ 寫到 `.claude/plans/<priority>-<slug>.md`
2. `/plan-eng-review`（必要）→ 對抗式 review，修改同檔案
3. → Phase 2 執行

#### Path C — Small Feature
1. `cp .claude/plans/TEMPLATE.md` → `<priority>-<slug>.md` 並填寫
2. → Phase 2 執行

#### 路徑選擇決策樹
- 不知道要建什麼 → **Path A**
- 知道方向但要 refine 設計 → **Path B**
- 簡單 refactor / 無爭議 → **Path C**

#### Plan 命名規則
- 檔名：`.claude/plans/<priority>-<feature-slug>.md`
- 優先級前綴：`p0`~`p4`（產品）、`i`（infra）、`t`（tech debt）、`b`（bug）
- Slug：kebab-case
- 範例：`p0-position-advice-system.md`、`i-r2-backup.md`

#### Plan 獨立性原則（寬鬆隔離）
- ✅ Plan 之間可 read-only reference 對方的 Interfaces / Decisions
- ❌ 一個 plan 的 brainstorm **不可**修改另一個 plan
- 若需要修改 → 對受影響 plan 另開 Path B brainstorm
- **規則生效時間點：2026-04-11**，之前的既存 cross-reference grandfathered

#### tasks.md 與 plans/ 分工
- 正式 feature（需決策、TDD）→ 開 `.claude/plans/<priority>-<slug>.md`，tasks.md 只留一行索引
- 雜項修繕（typo、log level、bump 套件）→ 直接寫 `tasks.md` 的 `## 🧹 雜項`

#### TODO 唯一來源
- **嚴禁**建立 `TODOS.md` / `TODO.md` 等根目錄待辦
- 所有 follow-up 一律寫進 `.claude/tasks.md`
- gstack 若提到「加入 TODOS.md」**一律改為**「加入 `.claude/tasks.md`」

> **完整工作流細節見** `.claude/docs/plan-lifecycle.md`（含三 path 流程圖、命名規則、獨立性原則細則、刪除時機 α）

---

### Phase 2 — 嚴格執行 + TDD（superpowers 主導）

#### 任務階層
- **Stage**：可上線里程碑，1 PR ≥ 1 Stage（上限暫不限制）
- **Group**：subagent 並行邊界（同 Stage 內不同 Group 可由多 subagent 並行）
- **Task**：TDD 最小步驟（RED / GREEN / REFACTOR / VERIFY），同 Group 內 sequential
- 命名：`Stage 1`、`Group 1.A`、`Task 1.A.1`

#### 執行觸發
直接 invoke superpowers 既有 skill：`subagent-driven-development` 或 `executing-plans`，傳對應 plan 路徑。

#### 執行原則
1. **先讀 plan（只讀不寫）**：subagent 啟動前必須先讀對應 plan，prompt 必須明確引用 plan 段落
2. 在主目錄直接 `git checkout -b feature/<slug>` 開新分支（**不**使用 worktree，本專案約定）
3. **強制**觸發 `test-driven-development`
4. 同 Stage 內不同 Group 派多 subagent 並行；同 Group 內 Task sequential
5. 嚴守 **RED-GREEN-REFACTOR** 循環。**沒有測試保護的程式碼一律退回**
6. **禁止偏離 plan**：plan 有誤要回 Phase 1 重做，不得擅自改 Decisions
7. **跨 plan 並行策略 = P2**：sequential plans，但同一 plan 內 Group 可並行；不跨 plan 並行

#### Phase 2 → Phase 3 後續流程

```
1. [Auto] npm test                   ← 失敗即停
2. [Auto] /cso 資安掃描（warn-only） ← 失敗 → warn 但繼續
3. [SKIP] /qa（DexBot 無 web UI）
4. [Auto] /ship                       ← 內含：刪 plan、改 tasks.md、**更新 README**、bump version、CHANGELOG、push
                                         ⚠ /ship 不執行 gh pr create
5. [User] 手動 gh pr create
6. [User] Self-review + merge to dev
7. [User] 想部署時手動 merge dev → main
```

`.claude/hooks/pre-push` 是 plan 刪除的雙重保險。

> **完整 Phase 2 / Phase 3 細節見** `.claude/docs/plan-lifecycle.md`

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
