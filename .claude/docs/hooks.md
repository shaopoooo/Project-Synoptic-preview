# Hooks 規則與設定

本專案目前使用兩種 hook，分屬不同機制，**不要混淆**：

| Hook | 機制 | 觸發點 | 目的 |
|------|------|--------|------|
| `.claude/hooks/pre-push` | Git hook | `git push` 前 | 阻止漏刪 plan 就推送 |
| `.claude/hooks/pre-skill-dev-sync.sh` | Claude Code PreToolUse hook | 呼叫 `Skill` 工具前 | 規劃類 skill 啟動前自動同步 `origin/dev` |

兩個 hook 檔案本身會被 commit 到 repo，但**啟用**是 per-clone 決定。新 clone / 換機器時需手動安裝，否則 hook 不會生效。

---

## 1. `pre-push`（Git hook）

### 規則

推送 `feature/*` 或 `fix/*` 分支時：

1. 從分支名推導對應 plan 檔案：`feature/<slug>` → `.claude/plans/<slug>.md`
2. 若該 plan 仍存在於 HEAD，顯示警告並互動式詢問 `[y/N]`
3. 預設 `N`（取消推送），避免手滑漏刪

對應規則來源：CLAUDE.md Phase 1「刪除時機 α」— feature 完成後應在 PR 開出前的最後一個 commit 刪除 plan。

### WIP push 情境

plan 未刪是正常的（功能尚未完成），回 `y` 繼續即可。

### 安裝方式（每個 clone 一次）

```bash
ln -s ../../.claude/hooks/pre-push .git/hooks/pre-push
chmod +x .claude/hooks/pre-push
```

採用 symlink 而非 copy，這樣更新 hook 腳本不用重裝。

### 驗證是否已啟用

```bash
ls -la .git/hooks/pre-push
# 應該看到 symlink 指向 ../../.claude/hooks/pre-push
```

### 停用（臨時）

```bash
git push --no-verify
```

⚠️ 只在確認 plan 已正確處理時使用，**不要**養成習慣。

---

## 2. `pre-skill-dev-sync.sh`（Claude Code PreToolUse hook）

### 規則

在 Claude Code 即將呼叫 `Skill` 工具前觸發。只對**規劃類 skill** 生效：

- `brainstorming`
- `office-hours`

行為（依當前分支）：

| 當前分支 | 行為 |
|----------|------|
| `dev` | `git fetch origin dev` → `git merge --ff-only origin/dev`，失敗不阻擋 |
| 其他分支 | 只 `git fetch`，不動 working tree，並在 stderr 顯示警告 |
| 離線 / 無 origin | 印訊息後跳過，不阻擋 skill 啟動 |

**設計原則**：

- 只做 fast-forward merge，**絕不**產生 merge commit
- 任何 git 失敗都不阻擋 skill 啟動（離線時仍可規劃）
- 預期啟用位置 = `DexBot-planning`（規劃工作站，永遠在 `dev`）
- 預期**不啟用**位置 = 主 repo `DexBot`（大多時間在 feature 分支施工，不該被 auto-pull）

### 啟用方式（per-clone）

編輯 `.claude/settings.local.json`（此檔案被全域 gitignore 排除，不會污染 repo）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/pre-skill-dev-sync.sh",
            "timeout": 15,
            "statusMessage": "同步 origin/dev..."
          }
        ]
      }
    ]
  }
}
```

欄位說明：

- `matcher: "Skill"` — 只在 `Skill` 工具被呼叫時觸發
- `type: "command"` — 執行 shell 指令
- `command` — 相對於專案根目錄的腳本路徑
- `timeout` — 秒數，超時不阻擋
- `statusMessage` — 執行時顯示在 UI 的訊息

`brainstorming` / `office-hours` 的篩選由**腳本內部**處理（判斷 stdin JSON 的 `tool_input.skill`），不是靠 matcher。

### 驗證是否已啟用

下次呼叫 `/brainstorming` 或 `/office-hours` 時，終端應顯示：

```
✅ [brainstorming] dev 已同步到最新 origin/dev
```

若沒出現任何訊息，檢查：

1. `.claude/settings.local.json` 是否存在且格式正確
2. `pre-skill-dev-sync.sh` 是否有 `chmod +x`
3. 當前分支是否為 `dev`（其他分支會走警告路徑）

### 停用

從 `.claude/settings.local.json` 移除對應段落即可，或整個刪除該檔案。

---

## 新增 hook 的指引

### Git hook（pre-commit / pre-push / ...）

1. 在 `.claude/hooks/` 建立腳本，用 `#!/usr/bin/env bash`
2. `chmod +x` 並 commit 到 repo
3. 在本文件新增規則與安裝指令
4. 通知所有 clone 執行 `ln -s` 安裝

### Claude Code hook（PreToolUse / PostToolUse / ...）

1. 腳本放 `.claude/hooks/`（與 git hook 同目錄，靠副檔名或命名區分）
2. 在 `.claude/settings.local.json`（per-clone）或 `.claude/settings.json`（全 repo）註冊
3. **預設寫進 `settings.local.json`**，只有真正該 repo 共用的 hook 才進 `settings.json`
4. 在本文件新增規則與啟用 JSON 片段

### 腳本撰寫鐵律

- `set -u`（或 `set -eu`，視容錯需求）
- 解析 stdin JSON 一律用 `jq`，並提供 fallback（`|| echo ""`）
- 任何失敗路徑（離線、無 origin、指令缺失）都要**安全退出**，不阻擋主流程
- 訊息一律繁體中文，與專案 CLAUDE.md 一致
- 禁止在 hook 裡做 `git push` / `rm -rf` / 發送外部請求等副作用過大的操作
