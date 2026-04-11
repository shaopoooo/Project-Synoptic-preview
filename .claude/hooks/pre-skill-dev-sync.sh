#!/usr/bin/env bash
# PreToolUse hook for Skill tool — 並行規劃模式專用
# 在 brainstorming / office-hours 啟動前同步 origin/dev，確保規劃時拿到最新 plan context。
#
# Hook 策略：
#   - dev 分支 → fast-forward merge only（絕不產生 merge commit）
#   - 其他分支（例如主 repo 的 feature/*）→ 只 fetch + 警告，不動 working tree
#   - 任何 git 失敗都不阻擋 skill 啟動（離線可繼續）
#
# 啟用條件（本檔案 commit 到所有 clone，但啟用是 per-clone 決定）：
#   需要在該 clone 的 .claude/settings.local.json 設定 PreToolUse/Skill hook 指向本腳本。
#   settings.local.json 由全域 gitignore 排除，不會污染 repo。
#
# 預期啟用位置：~/Documents/project/DexBot-planning（規劃工作站，永遠在 dev）
# 預期不啟用：主 repo DexBot（大多時間在 feature 分支施工，不該 auto-pull）
#
# stdin: Claude Code hook JSON，需要 tool_input.skill
# 觸發條件：skill 名稱包含 "brainstorming" 或 "office-hours"

set -u

skill=$(jq -r '.tool_input.skill // ""' 2>/dev/null || echo "")

case "$skill" in
  *brainstorming*|*office-hours*)
    ;;
  *)
    exit 0
    ;;
esac

git fetch origin dev -q >/dev/null 2>&1 || {
  echo "ℹ️  無法 fetch origin/dev（離線或無 origin？），跳過同步"
  exit 0
}

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "$branch" = "dev" ]; then
  if git merge --ff-only origin/dev >/dev/null 2>&1; then
    echo "✅ [$skill] dev 已同步到最新 origin/dev"
  else
    echo "ℹ️  [$skill] dev 無法 ff-merge（可能有本地未 push 的 commit）"
  fi
else
  echo "⚠️  [$skill] 目前在 '$branch' 分支，已 fetch origin/dev 但未 merge"
  echo "   若這是規劃 repo，應該固定在 dev，建議 git checkout dev 後再繼續"
fi

exit 0
