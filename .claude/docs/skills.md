# 可用 Skill 清單

## 專案自訂 Skill（`.claude/skills/`）

Claude 會自動判斷何時使用，也可以手動 `/skill-name` 觸發。

| Skill | 用途 |
|-------|------|
| `phase-checker` | 檢查程式碼是否違反 Phase 0 / Phase 1 分離原則 |
| `pure-function-enforcer` | 確保計算邏輯是 Pure Function，集中在 `utils/math.ts`，使用 BigInt |
| `rpc-retry-enforcer` | 確保所有 RPC 呼叫都包 `rpcRetry` |
| `appstate-manager` | Service 只讀 AppState，不直接修改；透過參數注入 |
| `security-checker` | 掃描硬編碼私鑰 / API Key / `.env` 洩漏 |
| `telegram-formatter-guard` | Bot 模組只做格式化與發送，禁止業務邏輯 |
| `dex-adapter-generator` | 產生新 DEX 的 Adapter（V3/V4/Aerodrome/PancakeSwap） |
| `auto-task-updater` | 對話結束時自動更新 `.claude/tasks.md` |

## GStack Skill

| 類別 | Skill |
|------|-------|
| **規劃與審查** | `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/autoplan` |
| **設計** | `/design-consultation`, `/design-shotgun`, `/design-html`, `/design-review` |
| **開發與品質** | `/review`, `/investigate`, `/codex`, `/plan-devex-review`, `/devex-review` |
| **瀏覽與測試** | `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/setup-browser-cookies` |
| **部署與監控** | `/ship`, `/land-and-deploy`, `/setup-deploy`, `/canary`, `/benchmark` |
| **安全與防護** | `/cso`, `/careful`, `/freeze`, `/guard`, `/unfreeze` |
| **其他** | `/retro`, `/learn`, `/gstack-upgrade` |

**強制規則：網頁瀏覽必須使用 `/browse`**

## Superpowers Skill

在背景自動攔截並強制執行 TDD 與子代理人工作流，不需手動呼叫。關鍵 skill：

- `brainstorming` — 拆解微型任務
- ~~`using-git-worktrees`~~ — **本專案不使用**，改為直接在主目錄 `git checkout -b feature/<name>`
- `subagent-driven-development` — 多 subagent 並行執行
- `test-driven-development` — RED-GREEN-REFACTOR 循環
- `writing-plans` / `executing-plans` — 計劃的撰寫與執行（本專案由 gstack 負責寫，superpowers 只讀）
