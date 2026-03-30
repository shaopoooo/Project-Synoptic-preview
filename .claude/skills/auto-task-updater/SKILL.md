---
name: auto-task-updater
description: 對話結束時自動更新 .claude/tasks.md。使用時機：每次任務完成、發現新待辦時。
---

# 任務自動更新器

每次對話結束前執行以下動作：
1. 檢查目前完成的任務
2. 使用 /project:todo done 語法或直接 edit 更新 tasks.md
3. 把新發現的待辦事項加到 Backlog 或 Active
4. 最後回覆「tasks.md 已自動更新」

永遠保持 tasks.md 是最新狀態。