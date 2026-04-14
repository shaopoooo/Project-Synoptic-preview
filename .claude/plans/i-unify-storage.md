# Feature: 統一持久化儲存結構（Unify Storage Layout）

> Path B brainstorming 產出，日期 2026-04-11。交接給 `/plan-eng-review` 做對抗式 review，再進 Phase 2 執行。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由本檔更新。
>
> **📐 命名規則對齊紀錄（2026-04-11）**：本 plan 初版誤用 `Stage A/B/C` + `Group B.1` 命名，違反 CLAUDE.md line 101 明定的 `Stage 1` / `Group 1.A` / `Task 1.A.1` 三層階層規則。已於 post-brainstorm 階段全面 rename：
> - `Stage A / A.5 / B / C` → `Stage 1 / 2 / 3 / 4`
> - `Group A.1` → `Group 1.A`；`Group A.5` → `Group 2.A`
> - `Group B.2 / B.3 / B.4 / B.5 / B.6` → `Group 3.A / 3.B / 3.C / 3.D / 3.E`
> - 原 `Group B.1`（Config 常數集中）已被重分配為 Stage 2 的 Group 2.A，不再出現在 Stage 3
>
> 未來新 plan 一律遵循 CLAUDE.md line 101 的命名規則，參考 `.claude/plans/TEMPLATE.md`。

## Context（為何要做）

- **直接導火線**：Railway volume 每 service 只能掛 1 個，但 DexBot 目前同時需要 `/app/data` + `/app/logs` 兩個持久化目錄。短期又踩過 Railway volume mount 首次掛載時 owner = `root:root`、container 跑 non-root USER 寫入被拒的 EACCES 問題。
- **深層動機**：單 volume 限制只是外部壓力，真正的目的是**趁機重整 data 語意**，讓未來 6 個月新增持久化目錄零 infra 摩擦。這是一次 **(ii) Proactive** 重構，不是 (i) Reactive 補丁。
- **Framing 決定**：本次 brainstorming 第一題就鎖定 (ii) Proactive，所有後續決策（P2 flat 結構、R2 單 prefix 收斂、Clean break rollback 策略）都是這個前提的自然推論。若未來重新評估覺得應該變 (i) Reactive，整個 plan 需重 brainstorm。
- **平台前提**：Railway 單 volume 限制確認，**未來會遷離 Railway**，因此本次重構必須保持 portable，禁止引入 Railway-specific hack。

## Goal（「改完了」的定義）

1. Railway 只掛 **1 個 volume**，mount 在 `/app/storage`
2. `/app/storage/` 下有 7 個領域子目錄：`shadow/` / `backtest-results/` / `ohlcv/` / `diagnostics/` / `debug/` / `positions/`（預留） / `bot/`（預留）
3. Repo 內**零硬編碼** `/app/data` 或 `/app/logs`（`rg` 驗證為空）
4. R2 mirror 的 `MIRROR_PATHS` 縮到 **1 個 prefix**（`storage/`），`ANALYSIS_FLATTEN_RULES` 已刪除
5. Dockerfile 有明確 `app` user + 固定 UID 1001，entrypoint 有 `chown -R` + `mkdir -p` skeleton 步驟，container 以 non-root USER 啟動不再踩 EACCES
6. `p0-position-advice-system.md` 與 `p0-backtest-verification.md` 兩個 P0 plan 內所有路徑字串已改成 `storage/...`（paper reservation 完成）
7. 新增持久化目錄的 SOP 寫進 plan 末尾「Extending storage」段落（零額外 infra 動作）

## Non-goal（明確不做）

- ❌ **Telegram ops 指令**（backup/restore/backfill 以 TG 指令取代 SSH）— 拆成獨立 future plan，`.claude/tasks.md` 會新增 follow-up
- ❌ **Diagnostics 日切 rotation**（`YYYY-MM-DD.jsonl` 形式）— 本次只做子目錄升格，rotation 留 future work
- ❌ **舊 R2 prefix 資料遷移** — 凍結 legacy `data/` + `logs/` 不搬，不 copy 到新 `storage/` prefix
- ❌ **Backward-compat 讀舊 archive** — `r2Restore.ts` Clean break，T ~ T+數天窗內若 DR 靠人工 untar
- ❌ **自動化 rollback procedure** — roll forward 為預設策略，不設計正規 rollback workflow
- ❌ **One-shot migration script** — `γ` 策略，不搬 live 資料，新結構從零開始
- ❌ **Dockerfile 以外的安全加固**（seccomp / AppArmor / read-only rootfs）— scope creep

## Decisions（已定案，執行階段不得動搖）

### D1 — Framing = (ii) Proactive，真正重整語意
- (i) Reactive 框架下最小補丁會是「logs 搬進 `data/logs/` 加層 wrapper」，純 path rename 無語意改善，違反 brainstorming 意圖
- 結論：採用 P2 flat 結構，徹底打散 `data/` vs `logs/` 二分法

### D2 — Timing = β-tight（與 PR 5a + PR 5b 的較晚者同 release window）
- Stage 1 paper reservation **現在做**（改 P0 plan 路徑字串 + Railway PRE-FLIGHT）
- **Stage 2 config module foundation 也現在做**（post-review 優化 2026-04-11）：`src/infra/storage.ts` + `ensureStorageDir()` + test 提前建立，讓 P0 Stage 2-5 + backtest Stage 1-3 的新 code 第一行起就 import `STORAGE_PATHS`，**消除 Stage 3 Group 3.A 對 P0 新檔的「write-then-rewrite」浪費**
- Stage 3 實作 + deploy **與 PR 5a + PR 5b 的較晚者同天或緊鄰 1–2 天**（PR 5 後已拆分為 PR 5a P0 軌道 / PR 5b backtest 軌道）
- **硬約束**：Stage 3 不得與 PR 5a / 5b 較晚者相隔超過 1 週，否則 γ 假設（歷史斷層可接受）失效，需回頭改寫 α migration script
- Stage 2 **不受**硬約束限制 — 它是一個純 additive 的 util module，不碰 Railway、不碰 Dockerfile、不碰 R2 結構，可以**單獨**先 merge 到 dev，提前服務 P0 / backtest 的 code 寫作

### D3 — 結構 = P2 flat, domain-based, 無 data/logs wrapper
- 頂層 mount = `/app/storage`（候選 `state/` / `persist/` 都有語意缺陷，`storage/` 最中性）
- 領域子目錄直接在 `/app/storage/` 下，不多一層 `data/`
- Winston transport 輸出改名為 `storage/debug/`，避免 `logs/` 名稱跟 production state 混淆

### D4 — Diagnostics 升格為子目錄但不日切
- `data/diagnostics.jsonl` → `storage/diagnostics/diagnostics.jsonl`
- 檔名暫不動，rotation 是獨立決策留 future work

### D5 — winston `storage/debug/` **仍進 R2 mirror**
- 雖然 production code 不會回讀 debug log（brainstorming Q1c-4 = a），但保留 R2 off-site 備份作為**人類 debug 的災難恢復介質**
- 成本：每日 mirror 多傳一份 debug log，可接受

### D6 — R2 結構：單 prefix `storage/`，廢除 `ANALYSIS_FLATTEN_RULES`
- `MIRROR_PATHS = ['storage/']`
- 廢除 `analysis/` top-level flatten 層，所有 weekly report 直接在 `storage/shadow/analysis/<weekIso>.md` 原生位置
- Archive tar root = `storage/`（`tar -C /app -cf ... storage`），unpack 後直接是 `storage/...`

### D7 — 舊 R2 prefix = 凍結，Clean break
- Legacy `data/` + `logs/` prefix 凍結，不搬不刪（依賴 R2 lifecycle rule 或 30 天後手動清理）
- `r2Restore.ts` **只**認 `storage/` 結構，移除所有 `data/` + `logs/` 解析分支
- Dev bucket 舊實驗資料同樣凍結

### D8 — Dockerfile = 明確 `app` user + 固定 UID 1001
- 不沿用 `node:*-slim` 官方 `node` user（UID 可能跨 base version 飄移）
- `RUN groupadd -g 1001 app && useradd -u 1001 -g app -m app`
- 之後所有 chown / USER 指令都用 `app:app`

### D9 — Entrypoint 每次啟動都跑 chown -R，但**不** mkdir（Eng review A3.α）
- `chown -R app:app /app/storage` 就好，**不**在 entrypoint 建立領域骨架
- 領域目錄的建立責任下放給**消費者 service**（logger / diagnosticStore / shadow writer 等），在 init 時各自呼叫 `fs.mkdirSync(dir, { recursive: true })`
- 理由：避免 entrypoint shell 與 `STORAGE_PATHS` 常數兩份真相，保持 DRY — 新增領域時只改 `src/infra/storage.ts` 一處
- **不**用 marker 檔判斷首次 / redeploy，最簡單 worst-case safeguard
- 接受 volume 大時啟動 +N 秒 chown 成本（見 Smoke Test Checklist boot-time baseline）

### D10 — `STORAGE_ROOT` env var，本地 / prod 單一差異點
- Prod：`STORAGE_ROOT=/app/storage`
- 本地 dev 預設：`./storage`（若未設 env var）
- Code 一律 `path.join(process.env.STORAGE_ROOT ?? './storage', 'shadow', ...)`

### D11 — Migration 當天策略 = γ 凍結 + 停機 15–60 分鐘
- 停機 migration（`railway service pause`）
- 手動產一份 insurance tarball（`tar czf /tmp/pre-migration.tar.gz /app/data /app/logs` 再 `railway volume download` 到本地），保留 **7 天**
- 不寫 migration script，不搬舊 live 資料
- 接受：P0 Stage 2 shadow observer 歷史斷層幾天（因為 β-tight timing，不是幾週）

### D12 — Rollback = roll-forward 為預設
- 不設計 L1 / L2 rollback procedure
- Insurance tarball 7 天是 nuclear option，不是正規 workflow
- 若 migration 後發現 bug → 修 bug 再 deploy，不 revert

### D13 — TG ops 指令拆獨立 plan
- 本 plan 不碰 backup/restore/backfill 的 TG 介面
- `.claude/tasks.md` Stage 1 task 3 新增 follow-up 登記
- DR runbook 末尾寫 Future Work 注記：「未來 TG ops plan 上線後本 runbook 大部分被取代」

### D14 — DR runbook 獨立於 plan
- 執行 runbook 放 `docs/ops/dr-runbook.md`（新建）
- Plan 本身不複製 runbook 指令內容，只留指針
- 原因：規劃文件（思考記錄）與運維文件（執行速查）應分離

### D15 — 測試策略 = 刪光重寫 + 3 類新 regression
- 既有 27 個 backup 測試因 R2 結構全改，**刪光重寫**新 suite
- 新增三類 regression：
  - `α` Path guard：`rg "'/app/data'|'/app/logs'"` under `src/` 應為空，寫成 CI-enforceable test
  - `β` Entrypoint smoke：`docker build` + `docker run` 驗證 skeleton 存在 + owner = app:app + USER 非 root
  - `γ` R2 round-trip：mirror → clear local → restore → content hash match

## Rejected（已否決，subagent 不得再提）

### 結構方向
- ❌ **方向 A（symlink 魔法）**：`/app/storage` volume + symlink `/app/data` → `/app/storage/data`。理由：製造額外抽象層換取零新語意，symlink 在 ops 除錯時最難找根因
- ❌ **方向 C（外部化 logs 到 CloudWatch / Loki / R2 stream）**：引入新外部依賴違反 β「決策現在做、搬運延後」精神；1c-4 = a 使 C 失去主要動機
- ❌ **P1 結構（`/app/storage/{data,logs}/...` wrapper）**：偽 Proactive，純 path rename 不改語意，違反 D1 framing
- ❌ **P2+（連 `debug/` 都拆成多層）**：過度設計，winston noise 不需要領域分類

### 命名
- ❌ **`/app/state/`** 作頂層：backtest-results 不算 state，語意違和
- ❌ **`/app/persist/`** 作頂層：過於 technical，可讀性差
- ❌ **`storage/logs/`** 保留舊名：與 production state 語意混淆，與 D3 精神衝突
- ❌ **`storage/runtime-logs/`**：雖然語意最精確但名稱冗長，`debug/` 夠用

### Migration
- ❌ **α one-shot migration script**：違反 γ 選擇，且 DexBot 單人 ops 下手動 tarball 已足夠
- ❌ **Blue-green deploy**（Railway 雙 service cutover）：複雜度與費用 2x，單人 ops 不划算
- ❌ **Dual-write 過渡（N 天同時寫新舊 prefix）**：違反 Clean break 精神，製造 2 套真相

### Rollback
- ❌ **L1 code-only revert + Railway mount 切回舊 config**：Railway 不一定支援 config snapshot，不賭它；且違反 D12 roll-forward 精神
- ❌ **`bin/safe-restore.sh` bash script**：DR 頻率極低，腳本本身需測試反而增加維護成本；markdown runbook 足夠

### 一般原則
- ❌ **Plan 標註時間預估**：違反 CLAUDE.md「Avoid giving time estimates」原則
- ❌ **把 TG ops 指令塞進本 plan**：違反 CLAUDE.md Plan 獨立性原則（2026-04-11 生效），且會 block 本重構無限延長

## Constraints（必須遵守的專案規則）

- **CLAUDE.md Plan 獨立性原則**（2026-04-11 生效）：本 plan 只能 read-only reference 其他 plan 的 Interfaces / Decisions，不得修改他 plan 的內容。**例外**：Stage 1 task 1 + task 2 對 P0 plans 的 paper reservation 字串修改**屬於本 plan scope 內的直接操作**，並在本 plan 的 Decision D2 授權下執行。
- **`.claude/rules/architecture.md`**：重構涉及 `src/market/`、`src/engine/` 與 `src/infra/`，必須維持 AppState 注入原則。新建的 `src/infra/storage.ts` 屬 util 層，無副作用。
- **`.claude/rules/logging-errors.md`**：winston transport 路徑改動必須通過 `createServiceLogger` 集中點，禁止散落 logger 建立。
- **`.claude/rules/security.md`**：entrypoint chown 指令不得暴露 env var，Dockerfile 不得 `ADD .env`。`app` user 的 UID 1001 屬於可接受範圍（避開 root 0 與常見 daemon UID < 1000）。
- **`.claude/rules/naming.md`**：`src/infra/storage.ts` 採 camelCase，exported constant `STORAGE_PATHS` 採 UPPER_SNAKE。
- **TypeScript strict + 禁 `any`**：路徑 helper function 必須 typed。
- **禁止 `console.log`**：所有路徑錯誤必須透過 `createServiceLogger` 或 `appState.cycleWarnings` 回報。

## Interfaces（API 契約）

### `src/infra/storage.ts` — NEW

```ts
// 單一事實來源，所有 persist 路徑都從這裡取
export const STORAGE_ROOT = process.env.STORAGE_ROOT ?? './storage';

// 所有 entries 皆為「目錄」，不放檔案路徑（Eng review CQ1：避免 dir/file 語意混搭）
export const STORAGE_PATHS = {
  shadow: `${STORAGE_ROOT}/shadow`,
  shadowAnalysis: `${STORAGE_ROOT}/shadow/analysis`,
  backtestResults: `${STORAGE_ROOT}/backtest-results`,
  ohlcv: `${STORAGE_ROOT}/ohlcv`,
  diagnostics: `${STORAGE_ROOT}/diagnostics`,
  debug: `${STORAGE_ROOT}/debug`,
  positions: `${STORAGE_ROOT}/positions`, // 預留，Stage 1 不使用
  bot: `${STORAGE_ROOT}/bot`,             // 預留，Stage 1 不使用
} as const;

// 檔名由消費者組合，e.g. path.join(STORAGE_PATHS.diagnostics, 'diagnostics.jsonl')
// 若未來需要集中管理檔名常數，可新增 STORAGE_FILES，現階段不必要

export function storageSubpath(domain: keyof typeof STORAGE_PATHS, ...parts: string[]): string;

// 領域目錄的初始化（由每個消費者 service 在 init 時呼叫，取代 entrypoint 的 mkdir）
// 冪等；recursive 建立中間層；失敗時 throw 讓 service 自己決定 fallback
export function ensureStorageDir(domain: keyof typeof STORAGE_PATHS): void;
```

### `src/infra/backup/r2Mirror.ts` — MODIFY

```ts
// 舊: MIRROR_PATHS = ['data/', 'logs/']
// 新:
export const MIRROR_PATHS = ['storage/'] as const;

// 刪除: ANALYSIS_FLATTEN_RULES（不再需要，原生結構直接 mirror）
```

### `src/infra/backup/r2Archive.ts` — MODIFY

```ts
// tar root 從 [data, logs] 改為 storage
// 舊: tar -C /app -cf archives/<weekIso>.tar.gz data logs
// 新: tar -C /app -cf archives/<weekIso>.tar.gz storage
export const ARCHIVE_TAR_ROOT = 'storage';
```

### `src/infra/backup/r2Restore.ts` — MODIFY

```ts
// 刪除所有 'data/' + 'logs/' 分支解析
// 只認 storage/ 頂層
// isSafeRelativePath 白名單從 [data, logs] 改為 [storage]
export const RESTORE_ROOTS = ['storage/'] as const;
```

### `Dockerfile` — MODIFY

```dockerfile
# 新增：明確建 app user + 固定 UID
RUN groupadd -g 1001 app && useradd -u 1001 -g app -m app

# 新增：entrypoint script
COPY bin/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

USER app
CMD ["node", "dist/index.js"]
```

### `bin/docker-entrypoint.sh` — NEW

```bash
#!/usr/bin/env bash
set -eu

# Root-phase: 僅做 chown，skeleton 由消費者 service 自己建（A3.α）
# 這讓 entrypoint 跟 STORAGE_PATHS 解耦 —— 新增領域不用改 shell
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /app/storage
  exec gosu app "$@"
fi

# 非 root 啟動時直接 exec（本地 dev，STORAGE_ROOT=./storage）
exec "$@"
```

**為何這麼短**：Eng review A3 指出如果 entrypoint hardcode 7 個子目錄，就跟 `STORAGE_PATHS` 常數兩份真相，違反 DRY 且「新增領域必須同步改 shell」是明顯的技術債陷阱。解法是把 skeleton 建立責任下放到每個消費者 service（透過 `ensureStorageDir()` helper），entrypoint 只做它唯一無可取代的事：權限修正。

## Test Plan（TDD 起點，RED 階段測試清單）

### `tests/config/storage.test.ts` — NEW
- [ ] RED: `STORAGE_ROOT` 未設時 fallback 到 `./storage`
- [ ] RED: `STORAGE_ROOT=/custom/path` 時 `STORAGE_PATHS.shadow === '/custom/path/shadow'`
- [ ] RED: `storageSubpath('shadow', 'foo.jsonl')` 產生正確 path
- [ ] RED: 不接受 domain = `'../evil'`，拋出 type error（編譯時）
- [ ] RED: `ensureStorageDir('shadow')` 冪等 — 連呼叫兩次不 throw
- [ ] RED: `ensureStorageDir` 會建立中間層目錄（`shadow/analysis` 也要在）

### `tests/services/backup/r2Mirror.test.ts` — REWRITE（原檔刪光重寫）
- [ ] RED: `MIRROR_PATHS` 只有 `'storage/'` 一個 entry
- [ ] RED: mirror 流程對 `storage/shadow/foo.jsonl` 正常上傳
- [ ] RED: mirror 不嘗試處理 `ANALYSIS_FLATTEN_RULES`（該 const 已不存在）
- [ ] RED: mirror 會包含 `storage/debug/`（D5 決策驗證）

### `tests/services/backup/r2Archive.test.ts` — REWRITE
- [ ] RED: `ARCHIVE_TAR_ROOT === 'storage'`
- [ ] RED: 產出的 tar 頂層是 `storage/`，不是 `data/` + `logs/`
- [ ] RED: tar 包含所有 7 個領域子目錄（即使有些為空）

### `tests/services/backup/r2Restore.test.ts` — REWRITE
- [ ] RED: `RESTORE_ROOTS` 只有 `'storage/'`
- [ ] RED: 餵入舊格式 tar（`data/` + `logs/` 頂層）必須**拒絕**並回報「unsupported legacy format, see DR runbook」（D7 Clean break）
- [ ] RED: 餵入新格式 tar（`storage/` 頂層）正常 restore
- [ ] RED: `isSafeRelativePath` 拒絕 `storage/../etc/passwd`

> **A2.α 澄清**：migration 當天的 insurance tarball **不**經過 `r2Restore.ts` 還原；它只是 nuclear-option 的手動 tar 檔，DR runbook 要明確寫「`r2Restore.ts` 會拒絕它，必須改用 `tar xzf` + `mv` + `chown` 的手動步驟」。這個拒絕行為本身是**正確的設計**，不是 bug。

### `tests/regression/path-guard.test.ts` — NEW（α 類）
- [ ] RED: `rg "'/app/data'|'/app/logs'" src/` 結果為空（靜態檢查）
- [ ] RED: `rg "\"data/shadow\"|\"data/backtest" src/` 結果為空
- [ ] RED: 所有 path 必須經過 `storageSubpath()` 或 `STORAGE_PATHS` 常數

### `tests/regression/entrypoint-smoke.test.ts` — NEW（β 類）
- [ ] RED: `docker build` 成功
- [ ] RED: 啟動 container 後 `/app/storage` 存在且 owner = `app:app`（UID 1001）
- [ ] RED: Process UID 非 0（`id -u` 回 1001）
- [ ] RED: **gosu handoff 顯式驗證**（T1）—`ps -o uid,pid,ppid,cmd` 確認 node process UID = 1001 且 parent = entrypoint（代表 `exec gosu` 真的切換了身份，不是靜默 fallback 到 root）
- [ ] RED: 注意：因 A3.α，entrypoint **不**建立領域骨架；本測試不檢查 `/app/storage/shadow` 等子目錄存在（那是消費者 service 的責任，由各自 unit test 覆蓋）

### `tests/regression/r2-roundtrip.test.ts` — NEW（γ 類）
- [ ] RED: 寫入 fake shadow log → mirror to dev bucket → clear local → restore → 內容 hash 一致
- [ ] RED: 寫入 fake debug log → mirror → clear → restore → 內容 hash 一致（D5 驗證）
- [ ] RED: archive → unpack → 7 個領域目錄結構正確

### `tests/integration/dr-dryrun.test.ts` — NEW（Eng review T2：DR runbook 自動化驗證）

**目的**：把 DR runbook 的「手動 tar xzf + mv + chown」步驟序列跑一次 dry-run，確保 runbook 本身不會因為打字錯或邏輯錯而失效。

- [ ] RED: 建構假的舊結構 fixture（`/tmp/fake-old/data/shadow/foo.jsonl` + `/tmp/fake-old/logs/error.log`）
- [ ] RED: `tar czf /tmp/fake-insurance.tgz -C /tmp/fake-old data logs` 產出 insurance tarball 模擬
- [ ] RED: 按 runbook 指令序列（`mkdir -p /tmp/fake-new/storage && tar xzf ... -C /tmp/fake-new && mv /tmp/fake-new/data/* /tmp/fake-new/storage/ && mv /tmp/fake-new/logs/* /tmp/fake-new/storage/debug/`）執行
- [ ] RED: 斷言 `/tmp/fake-new/storage/shadow/foo.jsonl` 與 `/tmp/fake-new/storage/debug/error.log` 存在且內容 byte-equal fixture
- [ ] RED: 執行完自動清理 /tmp 下 fixture

**為何值得**：A2.α 採純手動 restore，如果 runbook 指令序列在緊急時打錯、漏字、順序錯，人會卡在凌晨三點的 DR 現場。這個測試**直接驗證 runbook 本身的可執行性**，價值遠高於寫成本（Node `child_process.execSync` 跑 shell 即可，無需真 container）。

### `tests/services/backup/diagnosticStore.test.ts` — MODIFY
- [ ] RED: 寫入路徑 = `STORAGE_PATHS.diagnosticsFile`（不再是 `data/diagnostics.jsonl`）
- [ ] RED: 若父目錄不存在會自動建立（entrypoint 之外的 safety net）

### `tests/utils/logger.test.ts` — MODIFY
- [ ] RED: winston file transport 路徑 = `STORAGE_PATHS.debug`
- [ ] RED: error.log 與 combined.log 都落在 `storage/debug/`

## Tasks（subagent 執行順序）

### Stage 1 — Paper reservation（現在就做，不 deploy，純 dev commit）

**Group 1.A / Paper reservation（sequential）**

1. **MODIFY** `.claude/plans/p0-position-advice-system.md`：所有 `data/shadow/` 字串改成 `storage/shadow/`，`data/positions-cache/`（若有）改成 `storage/positions/`。在 plan 頂部加註記「路徑已對齊 i-unify-storage 的 P2 結構（paper reservation by Stage 1 / 2026-04-11）」
2. **MODIFY** `.claude/plans/p0-backtest-verification.md`：所有 `data/backtest-results/` → `storage/backtest-results/`，同樣加 paper reservation 註記
3. **MODIFY** `.claude/tasks.md`：新增 follow-up 條目 `[ ] Future: TG 指令取代 SSH 操作 (backup / restore / backfill) — 需獨立 Path B brainstorm，注意 .claude/rules/telegram.md（bot 只能 format/send，需先設計 ops service layer）`
4. **VERIFY**：`rg "data/shadow\|data/backtest\|data/positions" .claude/plans/` 只剩本 plan 自己的 Rejected 段落提到歷史字串
5. **PRE-FLIGHT**（Eng review A4.α）：在 Railway staging project 手動實測「能否**不刪除現有 volume** 情況下改 mount path 從 `/app/data` 到 `/app/storage`」。把結果（可 rename / 必須 delete+recreate / 其他行為）寫進本 plan 的 Risks 段落 R1。此測試**阻斷**後續 Stage 4 規劃：若必須 delete+recreate，Stage 4 task 38 的順序要重排（先下載 insurance tarball 到本地 → delete volume → recreate → deploy → smoke test；insurance tarball 就永遠留在本地不回上 Railway）
6. **COMMIT**：single commit `docs(plans): paper-reserve storage/ paths for i-unify-storage (Stage 1)`

### Stage 2 — Config module foundation（post-review 優化，獨立 merge 到 dev）

**目的**：把 `src/infra/storage.ts` 的建立從 Stage 3 拉出來提前做，讓 P0 Stage 2-5 + backtest Stage 1-3 的新 code 從第一行起就 import `STORAGE_PATHS`，消除 Stage 3 Group 3.A 對 P0 新檔的 write-then-rewrite 浪費。

**特性**：
- 純 additive TS util module，不碰 Railway / Dockerfile / R2 / 現有 service
- 可以在 dev branch 單獨 merge，**不受** D2 硬約束
- Merge 後立刻讓 PR 3 (P0 Stage 2) / PR 4 (backtest Stage 1) / PR 5a (P0 Stage 3-5) / PR 5b (backtest Stage 2-3) 第一行就用新常數

**Group 2.A / Config module（sequential, TDD）**

7. **RED**：寫 `tests/config/storage.test.ts`，涵蓋 `STORAGE_ROOT` fallback、`STORAGE_PATHS` 7 個領域、`storageSubpath()`、`ensureStorageDir()` 冪等 + 中間層建立
8. **GREEN**：新建 `src/infra/storage.ts`，export `STORAGE_ROOT`、`STORAGE_PATHS`、`storageSubpath()`、`ensureStorageDir()`（interface 見 Interfaces 段落）
9. **REFACTOR**：確認 TypeScript strict 通過、無 `any`、`STORAGE_PATHS` 所有 entry 皆為目錄（無檔案路徑，CQ1）
10. **COMMIT**：single commit `feat(config): add storage path module for i-unify-storage Stage 2`
11. **Merge 到 dev**：獨立 PR 或直接 commit（由你決定），目的是讓 P0 / backtest plan 的執行階段 subagent 可以 import 這個 module

### Stage 3 — Code + Infra 實作（與 PR 5a + PR 5b 較晚者同 release window）

**注意**：原 Stage 3「Config 常數集中」Group 已被**重分配為 Stage 2**（post-review 優化），Stage 3 從既有服務 path 替換開始。Group 3.A scope 也縮小 — 只需改**既有服務**，P0 新建服務（shadow observer / backtest writer）在 Stage 2 merge 後已直接用 `STORAGE_PATHS`。

**Group 3.A / 既有服務路徑替換（scope 縮小）**

因 A3.α entrypoint 不再建立領域骨架，每個消費者 service 必須在 init 時呼叫 `ensureStorageDir(<domain>)`。

12. **MODIFY** `src/infra/logger.ts`：winston file transport 路徑改用 `STORAGE_PATHS.debug`；init 時呼叫 `ensureStorageDir('debug')`
13. **MODIFY** `src/infra/diagnosticStore.ts`：寫入路徑改用 `path.join(STORAGE_PATHS.diagnostics, 'diagnostics.jsonl')`；init 時呼叫 `ensureStorageDir('diagnostics')`
14. **MODIFY** OHLCV 相關（`src/market/prefetch.ts` / `src/scripts/backfillOhlcv.ts` / 其他）：路徑改用 `STORAGE_PATHS.ohlcv`；加 `ensureStorageDir('ohlcv')`
15. **VERIFY**：`rg "'/app/data'|'/app/logs'|\"data/|\"logs/" src/` 為空；`rg "STORAGE_PATHS" src/services/shadow src/backtest` 應看到 P0 / backtest 新檔從第一行就使用新常數（若無則代表 Stage 2 未服務到執行階段）

**Group 3.A 縮減的原因**：原 task 13（MODIFY Shadow observer）與 task 14（MODIFY Backtest-results writer）已消失，因為 P0 / backtest 的執行階段 subagent 在 Stage 2 merge 後寫 code 時**直接使用** `STORAGE_PATHS`，不存在需要 refactor 的 hardcoded string。

**Group 3.B / Dockerfile & Entrypoint**

16. **NEW** `bin/docker-entrypoint.sh`（只做 chown + gosu exec，不 mkdir，見 Interfaces 段落）
17. **MODIFY** `Dockerfile`：新建 `app` user (UID 1001)、安裝 `gosu`、複製 entrypoint、`USER app`、保留 `ENTRYPOINT`
18. **RED**：寫 `tests/regression/entrypoint-smoke.test.ts`（含 gosu handoff 顯式驗證）
19. **GREEN**：`docker build` + `docker run` 本地驗證 owner + UID + gosu handoff

**Group 3.C / Backup 測試刪光重寫**

20. **DELETE** `tests/services/backup/*.test.ts` 全 27 個既有檔案（git rm）
21. **NEW** `tests/services/backup/r2Mirror.test.ts`（見 Test Plan）
22. **NEW** `tests/services/backup/r2Archive.test.ts`
23. **NEW** `tests/services/backup/r2Restore.test.ts`
24. **NEW** `tests/regression/path-guard.test.ts`
25. **NEW** `tests/regression/r2-roundtrip.test.ts`
26. **NEW** `tests/integration/dr-dryrun.test.ts`（Eng review T2：DR runbook 可執行性自動驗證）

**Group 3.D / R2 結構收斂**

27. **MODIFY** `src/infra/backup/r2Mirror.ts`：`MIRROR_PATHS = ['storage/']`、**刪除** `ANALYSIS_FLATTEN_RULES` 常數與所有引用
28. **MODIFY** `src/infra/backup/r2Archive.ts`：`ARCHIVE_SOURCES` / tar 指令改用 `storage/` 單根
29. **MODIFY** `src/infra/backup/r2Restore.ts`：刪除 legacy 分支、`RESTORE_ROOTS = ['storage/']`、`isSafeRelativePath` 白名單收斂
30. **MODIFY** `src/infra/backup/backupCron.ts`（若有路徑 log）：對齊新常數
31. **VERIFY**：所有 backup 測試 GREEN

**Group 3.E / Docs**

32. **NEW** `docs/ops/dr-runbook.md`：包含
    - 新結構 manual restore 指令（railway ssh = root，`tar xzf ... -C /app` → `chown -R app:app /app/storage`）
    - Clean break 說明：pre-refactor archive 無法用 `r2Restore.ts` 自動還原
    - **Insurance tarball 手動 restore 流程**（A2.α）：明確指出 `r2Restore.ts` 會拒絕舊格式，必須改用 `tar xzf` + `mv data/* storage/` + `mv logs/* storage/debug/` + `chown -R app:app /app/storage` 的指令序列
    - Insurance tarball 7 天保留期提醒
    - Future Work 注記：未來 TG ops plan 上線後本 runbook 大部分被取代
33. **MODIFY** `README.md`：更新 storage 結構章節
34. **MODIFY** `CHANGELOG.md`：新增重構條目
35. **MODIFY** `.env.sample`：新增 `STORAGE_ROOT=./storage`

### Stage 4 — Deploy & 觀察

#### Migration day state machine（Eng review A1）

```
BOT STATE          VOLUME STATE            ACTION
==========         ============            ======
[running/old] ──► (old data+logs)          1. railway service pause
      │                                      │
      ▼                                      │
[paused]      ──► (old data+logs)          2. ssh: tar czf /tmp/pre-migration.tgz /app/data /app/logs
      │                                      │
      │                                      ▼
[paused]      ──► (frozen backup in /tmp)  3. railway volume download
      │                                      │      → ./insurance/pre-migration-$(date +%F).tgz
      │                                      ▼
[paused]      ──► (A4.α 結果決定路徑)      4a. [若可 rename] Railway dashboard 改 mount path
      │                                          to /app/storage
      │                                      4b. [若必須 recreate] delete volume →
      │                                          create new volume at /app/storage
      │                                      │
      │                                      ▼
[paused]      ──► (new empty vol)          5. git push / railway deploy Stage 3 merge
      │                                      │
      │                                      ▼
[booting]     ──► (chown only, A3.α)       6. entrypoint: chown -R app:app /app/storage
      │                                      │   → exec gosu app node dist/index.js
      │                                      ▼
[booting]     ──► (consumer mkdir on init) 7. service init: ensureStorageDir() 各自建子目錄
      │                                      │
      │                                      ▼
[running/new] ──► (storage/* populated)    8. smoke test (Stage 4 checklist)
      │                                      │
      │                                      ▼
[running/new] ──► (live)                   9. railway service resume
                                              │
      ROLLBACK WINDOW expires ─────────────► 10. T+7d: 刪 insurance tarball
                                              │
                                              ▼
                                              11. T+30d: 清理 R2 legacy data/+logs/ prefix
```

#### Tasks

36. **Migration 當天**（按上面 state machine 步驟 1–9 執行）：
    - `railway service pause`
    - `railway ssh` 進 old container：`tar czf /tmp/pre-migration.tar.gz /app/data /app/logs`
    - `railway volume download /tmp/pre-migration.tar.gz ./insurance/pre-migration-$(date +%F).tar.gz`
    - Railway dashboard 按 Stage 1 task 5 的 PRE-FLIGHT 結果，選擇 rename 或 delete+recreate 路徑
    - Deploy Stage 3 的 merge commit
    - Entrypoint 自動跑 chown（**不** mkdir，由消費者 service 各自 ensureDir）
    - `railway service resume`
37. **Smoke test**：執行 Smoke Test Checklist 下的所有項目（見本 plan 末尾）
38. **48h 觀察**：第一次 daily mirror + 第一次 weekly archive 跑完
39. **T+7d**：刪 insurance tarball
40. **T+30d**：手動清理 R2 legacy `data/` + `logs/` prefix（或設 lifecycle rule 自動過期）

## Smoke Test Checklist（Stage 4 驗證）

### Stage 3 本地驗證（deploy 前）
- [ ] `npm test` 全綠
- [ ] `STORAGE_ROOT=./storage npm run dev` 本地啟動，消費者 service init 後 `./storage/` 下領域目錄被自動建立（由 `ensureStorageDir()` 創建，**非** entrypoint）
- [ ] `STORAGE_ROOT=./storage npm run backup:smoke-mirror` 對 dev bucket 成功
- [ ] `STORAGE_ROOT=./storage npm run backup:restore-mirror` 從 dev bucket 還原成功
- [ ] `docker build .` 成功
- [ ] `docker run` 本地驗證 entrypoint chown + `app` user 啟動 + gosu handoff（UID 1001）
- [ ] `tests/integration/dr-dryrun.test.ts` 綠（DR runbook 指令序列可執行性驗證）

### Railway 上線當天
- [ ] Deploy 後 bot 第一個 cycle logs 無 EACCES
- [ ] **Boot time baseline**（Eng review P1）：從 Railway logs 找 container start → first cycle ready 的時間戳差，記錄為 baseline（e.g. `T+12s`）。未來每次 deploy 都觀察，若 > 60s 要評估 D9 marker 優化
- [ ] 第一個 cycle 的 `HistoricalReturns` 顯示 N/N 正常（不是 0/N）
- [ ] `railway ssh` 進去 `ls -la /app/storage/` 確認消費者 service 已建立應有的領域目錄且 owner = `app:app`
- [ ] `cat /app/storage/diagnostics/diagnostics.jsonl` 看得到新寫入

### 上線後 48h 觀察
- [ ] 第一次 daily R2 mirror 跑完，bucket 裡只有 `storage/` prefix 被寫入
- [ ] 第一次 weekly archive 跑完，`archives/<weekIso>.tar.gz` 的 tar root = `storage/`
- [ ] P0 Stage 2 的 shadow observer 開始寫 `storage/shadow/<yyyy-mm-dd>.jsonl`

## Extending storage（未來新增持久化目錄的 SOP）

當未來需要新增持久化領域（例如 `storage/telemetry/`）：

1. 在 `src/infra/storage.ts` 的 `STORAGE_PATHS` 加一個 entry（**唯一需要改的**程式碼檔案）
2. 消費者 service init 時呼叫 `ensureStorageDir('telemetry')`
3. 在本 plan 的本段下方登記（只為了追蹤成長）

**沒有其他步驟**。不用改 Railway volume config、不用改 `bin/docker-entrypoint.sh`（A3.α 已經把 entrypoint 跟領域清單解耦）、不用改 `r2Mirror.ts` `MIRROR_PATHS`（因為是單 prefix 全包）、不用改 `r2Archive.ts` tar root。這是本次重構的核心 payoff：**單一事實來源 = `STORAGE_PATHS`**。

## Risks

- **R1** ✅ **PRE-FLIGHT 實測結果（2026-04-11）**：Railway 允許直接**修改既有 volume 的 mount path**（不需 delete+recreate），但修改後**會要求重新部署**。對 Stage 4 task 36 的影響：
  - 採用 state machine 的 **4a 分支（rename 路徑）**，跳過 4b（delete+recreate）
  - Migration day 流程：`railway service pause` → ssh 產 insurance tarball → `railway volume download` → Railway dashboard rename mount path `/app/data` → `/app/storage` → `git push` trigger redeploy → entrypoint 自動 chown → `railway service resume`
  - 原有 volume 內容保留（但內容是舊 `data/`+`logs/` 結構，不會自動搬遷；γ 凍結策略下直接由新結構從零開始，舊內容靠 insurance tarball + R2 legacy prefix 作為 DR 後援）
  - **簡化效益**：無需處理「volume 消失後 tarball 留本地回不去」的 recreate 分支邊 case，migration day state machine 明顯收斂
- **R2**：`chown -R` 對大 volume 啟動時間影響；volume < 2GB 時幾乎無感，> 10GB 時可能多 30 秒。Mitigation：Stage 4 smoke test 記錄 boot time baseline；若未來踩痛才改 D9 marker 版本
- **R3**：γ 凍結策略下，P0 Stage 2 shadow observer 在 migration 後連續性中斷；β-tight timing 讓斷層壓到幾天，可接受，但 P0 的 manual-tune trigger 需重新累積 N 週資料才能再次觸發
- **R4**：Clean break 下 T ~ T+7d 窗內若需 DR，手動程度高（SSH + tar + mv + chown）。Mitigation：DR runbook 寫清楚 + `tests/integration/dr-dryrun.test.ts` 定期驗證指令序列可執行性
- **R5**：Dockerfile 從 `node` user 換 `app` user 可能影響 `/app/node_modules`、build artifact 權限。Mitigation：Dockerfile 在 build stage 也用 `chown --chown=app:app`（Group 3.B task 17 的 acceptance criteria）
- **R6**：`gosu` 依賴 Debian/Ubuntu base image，若未來切 Alpine 需改用 `su-exec`。Mitigation：記錄於 DR runbook 的「未來遷離 Railway」注記
- **R7**（Eng review 衍生）：`ensureStorageDir()` 把骨架建立責任下放到消費者，若某個 service 忘記呼叫就會在首次寫入時 throw ENOENT。Mitigation：`tests/regression/path-guard.test.ts` 擴充一條靜態檢查 — 凡是 import `STORAGE_PATHS.X` 的檔案，同檔或同模組必須出現 `ensureStorageDir('X')` 呼叫

## 與其他 plan 的依賴

| Plan | 依賴點 | 處理 |
|---|---|---|
| `p0-position-advice-system.md` | Stage 2 shadow log 路徑 | Stage 1 task 1 paper-reserve |
| `p0-position-advice-system.md` | PositionAdvisor 未來 positions cache | Stage 3 預留 `storage/positions/` 骨架 |
| `p0-backtest-verification.md` | Stage 1 backtest-results 路徑 | Stage 1 task 2 paper-reserve |
| Future `i-tg-ops-commands.md`（未建） | ops layer persist state | Stage 3 預留 `storage/bot/` + Stage 1 task 3 tasks.md 登記 |

**Release 時序硬約束**（= D2）：Stage 3 merge 不得與 PR 5a / 5b 較晚者相隔超過 1 週。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 4 issues found, 2 test gaps, 0 critical gaps — all resolved inline |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0

**VERDICT:** ENG CLEARED — ready to implement. Path B 要求的必要 review 已通過。

**Eng review 修改摘要**（已全部套用至本 plan）：
- **A1**：Stage 4 新增 migration day state machine ASCII 圖
- **A2.α**：澄清 `r2Restore.ts` legacy rejection 不經過 insurance tarball；DR runbook 增加完整手動 restore 指令序列
- **A3.α**：Entrypoint 不再 mkdir 領域骨架，改由消費者 service 透過 `ensureStorageDir()` 自主建立，保持 `STORAGE_PATHS` 單一事實來源
- **A4.α**：Stage 1 新增 task 5 — Railway volume rename 行為 PRE-FLIGHT 實測，結果回寫 R1
- **CQ1**：`STORAGE_PATHS.diagnosticsFile` 移除，檔名由消費者組合，避免 dir/file 語意混搭
- **T1**：`entrypoint-smoke.test.ts` 增加 gosu handoff 顯式驗證（UID + ppid 比對）
- **T2**：新增 `tests/integration/dr-dryrun.test.ts` 驗證 DR runbook 指令序列可執行性
- **P1**：Stage 4 smoke test 增加 boot time baseline 記錄，未來長期監測 chown-R 成本
- **R7**：新增 risk — `ensureStorageDir` 漏呼叫的 fail-mode，由 path-guard 靜態檢查防禦

**Post-review 排序優化（2026-04-11，User approved option A）：**
- **Stage 2 提前執行**：原 Stage 3 的 config module group（`src/infra/storage.ts` + `ensureStorageDir()`）拉出來成為獨立 Stage 2，獨立 merge 到 dev branch，**不受** D2 硬約束
- **動機**：原 ordering 下 P0 Stage 4（PR 5a）寫 shadow observer 會 hardcode `./storage/shadow/...` 字串，PR 6 再把它 refactor 成 `STORAGE_PATHS.shadow` — 這是 write-then-rewrite 浪費，違反 DRY
- **效果**：P0 Stage 2-5 + backtest Stage 1-3 的新 code 從第一行就 import `STORAGE_PATHS`，Stage 3 Group 3.A scope 從 6 個 task 縮到 4 個（只改既有服務 logger / diagnosticStore / OHLCV，不再需要改 shadow observer / backtest writer）
- **代價**：Stage 3 敘事純度下降（原「Config 常數集中」group 被拆出），需要在 D2 加一條 exception
- **Task 編號調整**：Stage 2 佔用 7-11，原 Stage 3 Config group 從 plan 消失，Group 3.A 從 10-15 縮到 12-15；其餘 Group 3.B-3.E 與 Stage 4 編號不變（16-40）
