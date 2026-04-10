# Git 分支策略（單人開發專用）

採用 **簡化版 GitHub Flow**，不使用 Git Flow。

## 分支結構

```
main   (永遠可部署，等同線上 bot 版本)
 ↑ PR
dev    (日常整合分支)
 ↑ PR
feature/<name>   fix/<name>   (短命分支，壽命 ≤ 5 天)
```

## 強制規則

1. **一個 feature 一個分支**
   - 命名：`feature/regime-engine`、`fix/rpc-retry`
   - 不得長期存活，完成即刪

2. **feature → dev 必須走 PR**
   - 即使自己 review 自己，也要走 PR 流程
   - 讓 CI 擋住壞程式碼並留下變更紀錄

3. **dev → main 必須走 PR**
   - `main` **禁止**直接 commit
   - 只接受來自 `dev` 的 PR

4. **版本以 tag 標記**
   - 格式：`v<major>.<minor>.<patch>.<build>`（例：`v0.1.0.0`）
   - 對應 `CHANGELOG.md`
   - 出事時可快速 `git checkout <tag>` 回滾

5. **優先用 worktree 取代 stash**
   - 配合 `superpowers:using-git-worktrees`
   - 主線 bot 可持續運行，新功能在另一個 worktree 開發，互不干擾

6. **失敗分支直接刪除**
   - 實驗失敗不要留著：`git branch -D <name>`
   - 單人開發的好處是不用顧慮別人

7. **禁止 force push 到 `main` 與 `dev`**
   - 只允許 force push 到自己的 `feature/*` 與 `fix/*` 分支

## Commit Message 慣例

- 使用繁體中文
- 不加 `Co-Authored-By` trailer
- 格式參考最近 commit：`feat(<scope>): <描述>` / `fix(<scope>): <描述>` / `chore(<scope>): <描述>`
