# Plan 檔案生命週期與工作流程

> 本文件是 DexBot 規劃系統的權威文件。CLAUDE.md 只保留摘要，細節在這。

---

## 📐 任務階層

```
Level 1: Feature
   └── 一份 .claude/plans/<priority>-<slug>.md 對應一個 feature
   └── 命名規則見「Plan 檔案命名」段落

Level 2: Stage
   └── 可上線 / 測試的里程碑
   └── 1 PR ≥ 1 Stage（一個 PR 可包多個 Stage，上限暫不限制）
   └── 命名：Stage 1, Stage 2, ...

Level 3: Group
   └── subagent 並行邊界
   └── 同 Stage 內的不同 Group 可由多個 subagent 並行
   └── 並行條件：Group 間沒有共用檔案，不會 merge conflict
   └── 命名：Group 1.A, Group 1.B, ...（前綴 = Stage 編號）

Level 4: Task
   └── subagent 最小執行單位（一個 RED / GREEN / REFACTOR / VERIFY 動作）
   └── Group 內 sequential
   └── 命名：Task 1.A.1, Task 1.A.2, ...
```

### 並行可能性視覺化

```
Stage 1
├── Group 1.A ────┐
│   ├── 1.A.1     │ subagent 1
│   ├── 1.A.2     │ (sequential within group)
│   └── 1.A.3 ────┘
├── Group 1.B ────┐
│   ├── 1.B.1     │ subagent 2 ← 與 1.A 並行
│   └── 1.B.2 ────┘
└── Group 1.C ────┐
    └── 1.C.1     │ subagent 3 ← 與 1.A、1.B 並行
                  ┘

⏬ 全部 Group 完成 → Stage 1 ship → PR merge
```

---

## 📦 Plan 檔案命名

### 檔名格式

```
.claude/plans/<priority>-<feature-slug>.md
```

### 優先級前綴

| 前綴 | 含意 |
|------|------|
| `p0` ~ `p4` | 產品優先級（user-facing feature） |
| `i` | Infrastructure（DevOps、backup、monitoring） |
| `t` | Tech debt（重構、優化） |
| `b` | Bug fix（嚴重 bug 才需要 plan） |

### Slug 規則

- kebab-case
- 簡短但描述性
- 不含日期（git history 自有時序）

### 範例

| 檔名 | 對應 feature |
|------|-------------|
| `p0-position-advice-system.md` | P0 開倉建議系統主功能 |
| `p0-backtest-verification.md` | P0 閾值驗證（與上面是不同 feature，依寬鬆隔離原則可獨立） |
| `i-r2-backup.md` | Infra：Cloudflare R2 backup |
| `t-runner-refactor.md` | Tech debt：runner 精簡 |

---

## 🛣️ 三條 Intake Path

依 feature 規模與清晰度，從以下三條路徑擇一進入 Phase 1。

### Path A：Big Feature（需求模糊，需要先 discover）

```
1. /office-hours              ← gstack 互動發掘需求
   ↓ 直接寫到 .claude/plans/<priority>-<slug>.md
   ↓
2. /plan-ceo-review (option)  ← gstack 商業 review
   ↓ 修改同檔案
   ↓
3. /plan-eng-review            ← gstack 技術 review（必要）
   ↓ 修改同檔案
   ↓
4. /plan-ceo-review (option)  ← gstack 商業 review 第二輪（可選）
   ↓ 修改同檔案
   ↓
5. brainstorming (Claude)     ← Claude 互動式 Q&A，最終定稿
   ↓ 修改同檔案，補完 Decisions / Rejected / Stage / Group / Task 結構
   ↓
6. → Phase 2 執行
```

**何時用 Path A**：feature 從零開始、商業影響大、需要先發掘問題本質。

**範例**：原本的 P0 Position Advice System

### Path B：Medium Feature（idea 清楚，需要 design refinement）

```
1. brainstorming (Claude)     ← Claude 互動式 Q&A，逐 Section 確認
   ↓ 直接寫到 .claude/plans/<priority>-<slug>.md
   ↓
2. /plan-eng-review            ← gstack 對抗式 review（必要）
   ↓ 修改同檔案
   ↓
3. → Phase 2 執行
```

**何時用 Path B**：你已知方向、需要設計 refinement、不需要從零發掘。

**範例**：本對話的 R2 Backup、B2 Backtest Verification

### Path C：Small Feature（決策少，直接寫）

```
1. cp .claude/plans/TEMPLATE.md → .claude/plans/<priority>-<slug>.md
   ↓ 1-2 個短問題確認
   ↓
2. → Phase 2 執行
```

**何時用 Path C**：單一檔案修改、明確 refactor、無設計決策。

### 路徑選擇決策樹

```
你有新 feature / 想法
        │
        ▼
   能用一句話講清楚要建什麼嗎？
        │
   ┌────┴────┐
   │ 不能     │ 能
   │         │
   ▼         ▼
 Path A   有任何「我不知道該怎麼設計」的點？
          │
       ┌──┴──┐
       │ 有   │ 沒有
       │     │
       ▼     ▼
     Path B  Path C
```

### 各 Path 的工具職責

| 工具 | Path A | Path B | Path C |
|------|--------|--------|--------|
| `/office-hours` | ✅ 必要 | ❌ | ❌ |
| `/plan-ceo-review` | ⚠️ optional × N | ❌ | ❌ |
| `/plan-eng-review` | ✅ 必要 | ✅ 必要 | ❌ |
| `brainstorming` | ✅ 必要（最後一步） | ✅ 必要（第一步） | ❌ |
| 寫 plan 檔案 | ✅ | ✅ | ✅ |

**重要原則**：所有工具都**直接修改 `.claude/plans/<priority>-<slug>.md`**，不在 `~/.gstack/` 留中間檔案。`.claude/plans/` 是唯一 source of truth。

---

## 🔒 Plan 獨立性原則（寬鬆隔離）

### 規則

- ✅ **允許**：Plan A 的 Tasks / Constraints 可以 read-only reference 到 Plan B 的 Interfaces / Decisions
- ✅ **允許**：Plan A 的 Constraints 段落可宣告「依賴 Plan B 的某項已實作」
- ❌ **禁止**：Plan A 的 brainstorm 修改 Plan B 的 Decisions / Interfaces / Tasks
- ❌ **禁止**：跨 plan 修改 = 「順手 amend 別的 plan」

### 違反規則時的處理

若 brainstorm 過程發現需要修改另一個 plan：

1. **停下來**，不要動筆改另一個 plan
2. 警告 user：「此 brainstorm 的結論影響到 `<other-plan>.md`」
3. 建議：對 `<other-plan>.md` 另開一輪 Path B brainstorm 來 ratify 修改
4. 等 user 決定（接受跨 plan brainstorm，或調整當前 brainstorm 避免影響）

### 類比

把 plan 想成「獨立的 npm 套件」：
- 你的 package 可以 `import` 別人的 public API（read-only reference）
- 你不能直接修改別人 package 的 source code
- 若需要別人 package 加新功能，必須提 issue 給該 package 維護者

### Grandfathering

規則生效時間點：**2026-04-11**（本對話）

之前的 plan 之間既存的 cross-reference 與 amendment 視為 grandfathered，不溯及既往。新 brainstorm 必須遵守。

---

## 🗓️ Plan 刪除時機（規則 α）

**位置**：feature 完成後、開 PR **之前**，feature 分支上的**最後一個獨立 commit**。

**為什麼在 PR 之前**
- plan 是「執行前的契約」，一旦實作完成，契約就失效
- PR diff 同時呈現「實作 + plan 消失」是最強的完成訊號
- 歷史由 git log 保留，需要時可還原

**標準刪除 commit**
```bash
git rm .claude/plans/<priority>-<slug>.md
git commit -m "chore(plan): 移除已完成的 <feature-slug> plan"
```

**還原歷史 plan**
```bash
git log --all -- .claude/plans/<priority>-<slug>.md
git show <sha>:.claude/plans/<priority>-<slug>.md
```

---

## 🛡️ Pre-push Hook 守門

`.claude/hooks/pre-push` 會在推送 `feature/*` 或 `fix/*` 分支時檢查對應 plan 是否還留著，作為漏刪 plan 的安全網。

**完整規則、安裝方式與停用方法見** `.claude/docs/hooks.md`。

---

## 🚫 禁止事項

- **禁止** `.claude/plans/archive/` 或任何歷史資料夾。歷史一律由 git 負責。
- **禁止** subagent 在 Phase 2 修改 plan 檔案。若發現 plan 有誤，必須停下來回 Phase 1 重新 brainstorm。
- **禁止**偏離 plan 的 Decisions 段落自行決策。
- **禁止** 一次 brainstorm 修改多份 plan（見「Plan 獨立性原則」）。
- **禁止** 在 plan / spec 標註時間預估（依 CLAUDE.md「Avoid giving time estimates」原則）。
- **禁止** gstack 工具把產出留在 `~/.gstack/`，必須直接寫到 `.claude/plans/<priority>-<slug>.md`。

---

## 🔄 Phase 2 執行原則

1. 讀對應 plan 檔案 → 找對應 Stage → 開 feature branch（**不**用 worktree，直接在主目錄 `git checkout -b feature/<slug>`）
2. 同 Stage 內不同 Group 可派多個 subagent 並行
3. 同 Group 內 Task 嚴格 sequential（RED → GREEN → REFACTOR → VERIFY）
4. **禁止偏離 plan**：plan 有誤要回 Phase 1 重做（不可在 Phase 2 偷改 Decisions）
5. **跨 plan 並行策略 = P2**：sequential plans，但同一 plan 內的 Group 可並行；不跨 plan 並行（避免 merge conflict）
6. **Phase 2 觸發指令**：直接 invoke superpowers 既有 skill `subagent-driven-development` 或 `executing-plans`（傳 plan 路徑）

---

## 🚢 Phase 2 → Phase 3 後續流程（條件式）

當 plan 內所有 Stage 的 Group 都完成、測試 GREEN 後：

```
Phase 2 完成
═══════════════════════════════

1. [Auto Claude] 本地 npm test 全綠
   ↓ 失敗即停

2. [Auto Claude] /cso 資安掃描
   ↓ warn-only：失敗 → 顯示警告，繼續流程
   ↓ 警告若需處理可加進 tasks.md 雜項區塊

3. [SKIP for DexBot] /qa
   ↓ DexBot 無 web UI，永遠跳過
   ↓ 未來若有 UI feature 才觸發

4. [Auto Claude] /ship
   /ship 內部會處理：
   a. git rm .claude/plans/<priority>-<slug>.md（規則 α）
   b. git commit -m "chore(plan): 移除已完成的 <slug> plan"
   c. 修改 tasks.md：把該 PR 條目移到「✅ 已完成」段落
   d. **更新 README.md**：若本次 feature 改變了 Features 表、Tech Stack、Architecture、Scripts、Project Structure 任何一段，必須同步更新 README 對應段落
   e. 整理 commit history（bisectable chunks）
   f. bump version（package.json，唯一 version source of truth）
   g. update CHANGELOG.md
   h. push feature 分支到 origin
   ⚠ /ship **不**執行 gh pr create（user 偏好手動建 PR）

5. [Manual User] 手動建 PR
   - gh pr create 或走 GitHub web UI
   - 自訂 PR 標題 / body / reviewer

6. [Manual User] Self-review + merge PR 到 dev

7. [Manual User] 想部署時：手動 merge dev → main
   - Railway 自動 deploy
   - 不使用 /land-and-deploy
   - 不使用 /retro

═══════════════════════════════
```

### 失敗處理原則

- **Step 1 (npm test) 失敗**：立刻停，回去修
- **Step 2 (/cso) 失敗**：顯示警告但繼續（advisory only）。若警告嚴重，user 可手動停下處理
- **Step 4 (/ship) 失敗**：立刻停，看錯誤訊息決定後續
- **Step 5/6/7 (manual)**：user 自己處理失敗

### Pre-push hook 雙重保險

`.claude/hooks/pre-push` 仍然啟用。即使 /ship 漏刪 plan，hook 會在推送時偵測未刪 plan 並互動式詢問。這是 step 4a 之外的安全網。

### 跨 plan 並行（P2 策略）

同一個 plan 內的 Group 可由多 subagent 並行（前提：Group 間無檔案重疊）。**不**跨 plan 並行——若想加速兩個 plan，sequential 完成 plan A → 再 sequential 完成 plan B。

跨 plan 並行的需求只在「真的同時急 ship 兩個獨立 feature」才考慮。另一種更常見的並行需求——「A 施工中、同時想 brainstorm B」——見下一節「並行規劃模式」。

---

## 🔀 並行規劃模式（第二 clone 工作站）

### 問題

subagent 正在 `feature/A` 跑 Phase 2 實作，同時你想 brainstorm 一個全新 feature B。若在同一個 working tree 開 brainstorm，B 的 plan 檔會落進 `feature/A` 的 working tree，污染該 branch 的 diff。

本專案約定**不使用 git worktree**（見 CLAUDE.md），所以唯一乾淨的解法是：開第二個 git clone 當「規劃工作站」。

### 目錄結構

```
~/Documents/project/DexBot           # 主 repo：跑 subagent、施工 feature/A
~/Documents/project/DexBot-planning  # 第二 clone：永遠停在 dev，只做 brainstorm
```

第二 clone 用 `git clone <origin>` 正常複製，不是 worktree，擁有完整獨立 `.git`，IDE / tooling 不會搞混。

### 工作流程

```
┌─ 主 repo（DexBot）─────────────────┐   ┌─ 規劃 repo（DexBot-planning）─┐
│ feature/A：subagent 執行 Phase 2   │   │ dev：brainstorm feature B      │
│                                    │   │ ↓                              │
│                                    │   │ 寫 .claude/plans/<p>-b.md      │
│                                    │   │ ↓                              │
│                                    │   │ commit 到本地 dev              │
│                                    │   │ ↓                              │
│                                    │   │ git push origin dev            │
└────────────────────────────────────┘   └────────────────────────────────┘
                 │                                    │
                 │  A 收工、切回 dev 時               │
                 │  git pull origin dev ──────────────┘
                 │  自動拿到 plan B
                 ▼
       主 repo 也有 plan B，開始 Phase 2
```

### 同步策略

- **規劃 repo → 主 repo**：brainstorm 完 commit + push 到遠端 `dev`；主 repo 之後 `git pull` 時自然帶回
- **主 repo → 規劃 repo**：主 repo feature 合併進 dev 後，規劃 repo 下次 brainstorm 前先 `git pull`，確保看到最新 plan 狀態
- 兩邊 `dev` 都以 **origin/dev** 為唯一 source of truth

### 適用時機

- ✅ 施工中的 feature A 還要 1 天以上，期間想 brainstorm 下一個 feature B
- ✅ B 的 brainstorm 需要完整 repo context（grep 現有 code、看 CLAUDE.md）
- ❌ 只想快速記個想法 → 直接寫 `.claude/tasks.md` 🧹 雜項區塊即可，不需要開第二 clone
- ❌ 想修改 feature A 正在使用的 plan → 違反「禁止偏離 plan」，應先暫停施工回 Phase 1

### 常見錯誤

- **在規劃 repo 切 feature branch 施工**：規劃 repo 的角色是**只讀 + 寫 plan 檔案**，不跑 subagent、不寫 code。若要施工 B，等 A 收工後在主 repo 開 `feature/B`
- **忘記 push dev**：commit 留在規劃 repo 本地 → 主 repo pull 不到 → 等於白 brainstorm。每次 commit 完務必 push
- **兩邊同時改 dev**：理論上可能衝突，實務上 brainstorm 只動 `.claude/plans/` 新檔案，主 repo 的 dev 不會碰這個路徑，衝突機率極低

---

## 📁 與 tasks.md 的關係

- `tasks.md` 是**索引**：每份 plan 在對應優先級區塊只留一行索引
- `tasks.md` 也是**雜項待辦落點**：不值得開 plan 的小修繕直接寫在 `🧹 雜項`
- 完整決策脈絡在 plan 檔案內，不在 tasks.md
