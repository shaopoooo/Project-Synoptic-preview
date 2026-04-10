# Plan 檔案生命週期

## 總覽

```
gstack 寫契約          →  .claude/plans/<name>.md 建立
feature 分支開發        →  subagent 讀 plan 做 TDD（只讀）
實作 + 測試完成         →  本地 npm test 全綠
刪除 plan（獨立 commit） →  git rm + chore commit
git push                →  pre-push hook 檢查通過
開 PR                   →  review 看到「實作 + plan 消失」
merge 到 dev            →  乾淨，無額外清理步驟
```

## Plan 檔案規格

- **位置**：`.claude/plans/<feature-name>.md`
- **範本**：`.claude/plans/TEMPLATE.md`（新增 feature 時直接複製填寫）
- **撰寫者**：gstack 在 Phase 1 結尾產出
- **使用者**：superpowers subagent **只讀不寫**
- **段落**：Context / Decisions / Rejected / Constraints / Interfaces / Test Plan / Tasks

## 刪除時機（時機 α：PR 開出前）

**為什麼在 PR 之前**
- plan 是「執行前的契約」，一旦實作完成，契約就失效
- PR diff 同時呈現「實作 + plan 消失」是最強的完成訊號
- 歷史由 git log 保留，需要時可還原

**還原歷史 plan**
```bash
git log --all -- .claude/plans/<name>.md
git show <sha>:.claude/plans/<name>.md
```

**標準刪除 commit**
```bash
git rm .claude/plans/<feature-name>.md
git commit -m "chore(plan): 移除已完成的 <feature-name> plan"
```

## Pre-push Hook 守門

`.claude/hooks/pre-push` 會在推送 `feature/*` 或 `fix/*` 分支時：
1. 從分支名推導對應的 plan 檔案名
2. 若 plan 仍存在，互動式詢問 `[y/N]` 是否繼續推送
3. 預設 N（取消推送），避免手滑

**WIP 推送情境**：plan 未刪除是正常的，回 `y` 繼續。

## 初次 clone / 換機器安裝 hook

```bash
ln -s ../../.claude/hooks/pre-push .git/hooks/pre-push
chmod +x .claude/hooks/pre-push
```

## 禁止事項

- **禁止** `.claude/plans/archive/` 或任何歷史資料夾。歷史一律由 git 負責。
- **禁止** superpowers 修改 plan 檔案。若發現 plan 有誤，必須停下來回 Phase 1 請 gstack 更新。
- **禁止**偏離 plan 的 Decisions 段落自行決策。
