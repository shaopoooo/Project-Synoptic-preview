# Feature: Cloudflare R2 Backup（DR + Dev Access）

> 本檔案由 gstack 在 Phase 1 結尾產出，作為交接給 superpowers (Phase 2) 的正式契約。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由 gstack 更新。

## Context（為何要做）

- **來源**：
  - 對話 brainstorming session（2026-04-10）— 與 P0 開倉建議系統 plan 並行開出的獨立 plan
  - 動機事件：發現 Railway 部署後 `data/` 與 `logs/` 不易在本地開發時取得，且 Railway Volume 僅防 redeploy 清檔，不防 volume / Railway 帳號層級的災難

- **動機與商業價值**：
  - **DR（Disaster Recovery）**：保護 5 個月以上累積的 OHLCV 歷史資料、`diagnostics.jsonl`、未來的 shadow log 與 backtest 結果。volume 損毀 / Railway 帳號出事 / 換機時，可從 R2 還原
  - **Dev Access**：本地開發、debug、跑 backtest 時，可拉取生產資料到本地分析，不需要 SSH 進 container 用 tar 暫包
  - **Stage 2 shadow mode 的前置條件**：未來 shadow log 會以每月歸檔 jsonl 累積，必須有穩定的 backup 機制
  - **與 P0 plan 並行**：本 plan 與 `.claude/plans/p0-position-advice-system.md` 的 Stage 2 並行開發，獨立 PR

## Decisions（已定案，執行階段不得動搖）

### 範圍與目的
1. **雙用途設計**：DR + Dev Access 共用同一份 backup，全包 `data/` 與 `logs/`。不為了優化儲存而排除任何子目錄
2. **未來新增的 `data/` 子目錄自動涵蓋**：例如 `data/shadow/`、`data/backtest-results/`、`data/genomes/` 不需修改 backup 設定

### 上傳策略
3. **Mirror sync（每日）+ Weekly archive（每週）雙軌**
   - Mirror sync：每日 03:00 (Asia/Taipei)，將本地檔案 diff 後上傳到 R2 對應路徑，**永遠是最新狀態**
   - Weekly archive：每週日 04:00 (Asia/Taipei)，將 `data/` + `logs/` 打包成 `archives/<weekIso>.tar.gz` 上傳，**提供 point-in-time recovery**
4. **Diff 策略 = path + size 比對**：本地檔案的 size 與 R2 物件的 size 不同（或路徑不存在於 R2）即上傳。**不做 hash 比對**，因為使用情境只有 append-only 與整檔覆蓋兩種，size 比對足夠
5. **Mirror sync 不刪除 R2 上的多餘檔案**：避免誤刪生產資料；只增不減

### 技術選型
6. **純 JS 實作（`@aws-sdk/client-s3` + Node `tar`）**，無系統依賴
   - Bot Dockerfile 不需修改
   - 錯誤處理走 `createServiceLogger` 與 `appState.cycleWarnings`
   - 單元測試用 `aws-sdk-client-mock`
7. **In-bot cron**（與既有 mcEngine cycle 同進程）
   - 用 `node-cron` 排程
   - 與既有 cron pattern（mcEngine、position monitor、shadow analyze）一致
   - 個別 `isRunning` flag 防並發

### Retention
8. **R2 lifecycle rules 自動清理**
   - 規則：`archives/` 路徑物件年齡 > 90 天自動刪除
   - 在 R2 dashboard 設定，bot code 完全不做 retention 邏輯
   - `data/` 與 `logs/` 路徑**不套用**任何 retention（mirror 永遠是最新狀態）

### 失敗處理
9. **任何 cron run 級失敗 → 立即推 Telegram alert**
   - 不設容忍門檻（即第 1 次失敗就推，不等連續 N 次）
   - 單檔上傳失敗在 mirror 內部記錄為 errors，整個 run 若有任何 error 即視為 cron run 失敗
   - 失敗訊息含失敗檔案清單與 error 內容，方便 debug

### Restore
10. **僅提供手動 CLI restore，不做 auto-bootstrap**
    - `npm run backup:restore-mirror` — 從 R2 mirror 拉所有檔案到本地（覆蓋）
    - `npm run backup:restore-archive <weekIso>` — 下載指定週的 archive、解壓覆蓋本地
    - `npm run backup:list-archives` — 列出 R2 上所有可用 archive
11. **Restore 安全機制**：開始前先把現有 `data/` + `logs/` 重命名為 `<dir>.backup-<ts>/`，失敗自動 rollback，成功後 admin 手動清理

### Bucket 與排程
12. **R2 bucket 名稱**：`tradingbot-backup`
13. **Cron 排程時間**（Asia/Taipei）：
    - Daily mirror：`0 3 * * *`（每日 03:00）
    - Weekly archive：`0 4 * * 0`（每週日 04:00）
    - 與既有 cron 全部錯開

### Concurrency
14. **Mirror sync 並行上傳限制 5**（自寫 semaphore），避免吃光 Railway 頻寬

### Analysis 雙路徑 mirror（R2 backup brainstorm ratification 2026-04-11）
15. **Analysis 結果攤平到 R2 `analysis/` prefix**
    - 主 mirror sync 結束後，額外執行 `mirrorAnalysisToFlatPrefix()`
    - 來源 → 目標映射（攤平命名，不加日期目錄結構）：
      - `data/backtest-results/<date>/summary.md` → `analysis/backtest-<date>-summary.md`
      - `data/backtest-results/<date>/config-snapshot.json` → `analysis/backtest-<date>-config.json`
      - `data/shadow/analysis/<weekIso>.md` → `analysis/shadow-<weekIso>.md`
    - 攤平命名包含「類型 + 日期」，list 即可依檔名排序看到完整時間軸
    - 原始檔案仍透過正常 mirror sync 進入 R2 對應路徑，本決策僅追加索引層，不取代主 mirror
    - **不適用任何 lifecycle**（永久保留，有審計價值）
    - 實作位置：`mirrorAnalysisToFlatPrefix()` 在 `r2Mirror.ts` 同檔案內，不拆獨立模組
    - 失敗處理與主 mirror 一致：失敗即推 Telegram

    > **Ratification 紀錄**：本 Decision 最初由 B2（p0-backtest-verification）brainstorm 順手追加，違反 plan 獨立性原則。2026-04-11 對 R2 backup plan 補跑一輪 brainstorm 正式 ratify，依 R2 backup plan 自身視角確認 5 個子題（責任歸屬 / 攤平命名 / 不套 lifecycle / 同檔案實作 / 維持為 #15）後納入。

## Rejected（已否決，subagent 不得再提）

- ❌ **每日 tar.gz 全量 snapshot 取代 mirror**：拉單一檔案要下載整包再 untar，DX 太差；重複資料浪費儲存
- ❌ **純 mirror 不做 weekly archive**：失去 point-in-time recovery 能力；若資料被覆蓋成爛版本只能拿到爛版本
- ❌ **Append-only event log**：對已是 append-only 的 jsonl 是過度工程；對 logs 不適用
- ❌ **Shell out 到 `rclone`**：增加 Dockerfile 系統依賴；錯誤訊息要從 stderr 解析；與專案技術棧不一致
- ❌ **Shell out 到 `aws-cli`**：同上理由
- ❌ **混合技術棧**（mirror 用 rclone、archive 用 JS）：兩套技術棧維護負擔加倍
- ❌ **Railway native cron service（獨立 service）**：需要 Railway Pro plan（成本）；跨 service Volume 共用支援有限；部署複雜度增加
- ❌ **GitHub Actions 外部觸發**：跨服務整合對單人開發是 over-engineering；公網跨服務慢；多一層 secret 攻擊面
- ❌ **child_process fork Node 子進程隔離**：多寫 wrapper code 換來的隔離在當前資料量級無實際好處
- ❌ **永久保留所有 archive**：1 年後超過 R2 free tier；實際上不會回去看 1 年前的 backup
- ❌ **GFS（grandfather-father-son）retention**：對單人 bot 是 overkill；50+ 行 retention 邏輯且容易在月底/年底出 bug
- ❌ **自寫 retention cleanup cron**：30 行有狀態 IO 程式碼換 R2 lifecycle 0 行 server-side 規則
- ❌ **失敗連續 N 次才推 Telegram**：原本提案連續 3 天 mirror 失敗才推；user 否決，要求第 1 次失敗就推
- ❌ **Bot 啟動時 auto-bootstrap**：隱性行為可能在 R2 設錯時意外覆蓋現有資料；啟動時間變長；隱藏邏輯難 debug
- ❌ **Auto-bootstrap with env flag opt-in**：env flag 不在 git 中，未來看到怪行為不會立刻想到 flag 影響
- ❌ **`bootstrap` script alias**：與 `restore-mirror` 重複，無額外價值
- ❌ **Mirror 雙向 sync（刪除 R2 多餘檔）**：誤刪生產資料風險過高，不值得換取「乾淨」
- ❌ **ETag / hash 比對**：使用情境只有 append-only 與整檔覆蓋，size 比對已足夠且更便宜
- ❌ **Per-file restore**：restore 只支援整個 mirror 或整個 archive，不做逐檔還原
- ❌ **多 backup destination**：只支援單一 R2 bucket
- ❌ **Plan 標註時間預估**：違反 CLAUDE.md「Avoid giving time estimates」原則

## Constraints（必須遵守的專案規則）

- **`.claude/rules/architecture.md`**：
  - Service 必須透過參數注入依賴（`r2Client` 由 caller 建立並傳入，不在 service 內部建立）
  - 不直接修改 AppState（backup service 只讀本地檔案系統）
  - 新功能必須先更新 `.claude/tasks.md`（在本 plan 完成 brainstorm 後立即更新）

- **`.claude/rules/pipeline.md`（Phase 0 / Phase 1 分離）**：
  - Backup service 屬於 **Phase 0 抓取 / IO 層**（涉及檔案 IO + R2 網路 IO）
  - 不可被 mcEngine 等 Phase 1 計算層直接呼叫
  - Cron job 觸發是合法呼叫點

- **`.claude/rules/naming.md`**：
  - Service 模組：`camelCase.ts`（`r2Mirror.ts`、`r2Archive.ts`、`r2Restore.ts`、`backupCron.ts`）
  - Client wrapper：`r2Client.ts`（不是 class，是 factory function）
  - TypeScript strict，**禁止 `any`**
  - 常數：`UPPER_SNAKE_CASE`（`MIRROR_PATHS`、`UPLOAD_CONCURRENCY`、`R2_BUCKET`）

- **`.claude/rules/logging-errors.md`**：
  - 禁用 `console.log`，統一 `createServiceLogger('R2Mirror' / 'R2Archive' / ...)`
  - 失敗推送走 `appState.cycleWarnings` + Telegram alertService
  - 不要 retry 內建（單次失敗即推 Telegram，由 admin 決定要不要手動重試）

- **`.claude/rules/security.md`**：
  - R2 credentials 只存 `.env` 與 Railway environment variables，**絕對禁止** commit
  - `.env.example` 只標示變數名稱與空值
  - R2 API token 限定權限到單一 bucket（`tradingbot-backup`），不給帳號級權限
  - 套件版本固定 + 7 天年齡規則：`@aws-sdk/client-s3`、`tar`、`node-cron`、`aws-sdk-client-mock` 安裝時用 `npm view <pkg> time --json` 確認

- **`.claude/rules/telegram.md`**：
  - `src/bot/alertService.ts` 只能格式化文字 + 發送，不可呼叫 r2 service
  - backup service 失敗時組好結構化 result object 傳給 alertService，alertService 負責中文格式化

## Interfaces（API 契約）

### `src/types/backup.ts`（NEW）

```ts
/** Mirror sync 計劃 */
export interface MirrorPlan {
  toUpload: Array<{
    localPath: string;       // 例如 'data/ohlcv/0x22ae...json'
    r2Key: string;           // 與 localPath 相同
    sizeBytes: number;
    reason: 'new' | 'size_changed';
  }>;
  unchanged: number;
  totalSizeBytes: number;
}

/** Mirror sync 結果 */
export interface MirrorResult {
  startedAt: number;
  finishedAt: number;
  uploadedCount: number;
  uploadedBytes: number;
  failedCount: number;
  errors: Array<{ path: string; message: string }>;
  ok: boolean;               // failedCount === 0
}

/** Analysis flatten upload 結果（B2 brainstorm 追加） */
export interface AnalysisMirrorResult {
  startedAt: number;
  finishedAt: number;
  flattenedFiles: Array<{ source: string; r2Key: string; sizeBytes: number }>;
  failedCount: number;
  errors: Array<{ source: string; message: string }>;
  ok: boolean;
}

/** Weekly archive 結果 */
export interface ArchiveResult {
  startedAt: number;
  finishedAt: number;
  weekIso: string;           // "2026-W15"
  archiveSizeBytes: number;
  r2Key: string;             // "archives/2026-W15.tar.gz"
  ok: boolean;
  error: string | null;
}

/** Restore 結果（mirror / archive 共用） */
export interface RestoreResult {
  startedAt: number;
  finishedAt: number;
  restoredCount: number;
  restoredBytes: number;
  safetyBackupPath: string;  // 例如 'data.backup-1712822400000'
  ok: boolean;
  error: string | null;
}

/** Archive 列表項目 */
export interface ArchiveListing {
  weekIso: string;
  sizeBytes: number;
  lastModified: Date;
  r2Key: string;
}
```

### `src/services/backup/r2Client.ts`（NEW）

```ts
import { S3Client } from '@aws-sdk/client-s3';

export const R2_BUCKET = 'tradingbot-backup';

/** 建立 R2 S3 client。讀 env：R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY */
export function createR2Client(): S3Client;
```

### `src/services/backup/r2Mirror.ts`（NEW）

```ts
import type { S3Client } from '@aws-sdk/client-s3';
import type { MirrorResult, AnalysisMirrorResult } from '../../types/backup';

const MIRROR_PATHS: readonly string[] = ['data/', 'logs/'] as const;
const UPLOAD_CONCURRENCY = 5;

/** Analysis 攤平來源 → 目標 prefix 對映（B2 brainstorm 追加） */
const ANALYSIS_FLATTEN_RULES: ReadonlyArray<{
  glob: string;          // 例如 'data/backtest-results/*/summary.md'
  rename: (localPath: string) => string;  // 攤平命名規則
}> = [/* see Decisions #15 */] as const;

/** Mirror sync：本地檔案 → R2（diff 後上傳，不刪除 R2 多餘檔） */
export async function runMirrorSync(client: S3Client): Promise<MirrorResult>;

/**
 * 將 analysis 結果攤平到 R2 `analysis/` prefix（在主 mirror sync 之後執行）
 * 不適用 90 天 lifecycle，永久保留
 */
export async function mirrorAnalysisToFlatPrefix(client: S3Client): Promise<AnalysisMirrorResult>;
```

### `src/services/backup/r2Archive.ts`（NEW）

```ts
import type { S3Client } from '@aws-sdk/client-s3';
import type { ArchiveResult } from '../../types/backup';

/** Weekly archive：data/ + logs/ tar.gz 上傳到 R2 archives/<weekIso>.tar.gz */
export async function runWeeklyArchive(client: S3Client): Promise<ArchiveResult>;
```

### `src/services/backup/r2Restore.ts`（NEW）

```ts
import type { S3Client } from '@aws-sdk/client-s3';
import type { RestoreResult, ArchiveListing } from '../../types/backup';

/** 從 R2 mirror 拉所有 data/ + logs/ 到本地（含 safety backup 機制） */
export async function restoreMirror(client: S3Client): Promise<RestoreResult>;

/** 下載指定週的 archive 並解壓到本地（含 safety backup 機制） */
export async function restoreArchive(client: S3Client, weekIso: string): Promise<RestoreResult>;

/** 列出 R2 上所有可用的 archive，依 lastModified 降序 */
export async function listArchives(client: S3Client): Promise<ArchiveListing[]>;
```

### `src/services/backup/backupCron.ts`（NEW）

```ts
import type { S3Client } from '@aws-sdk/client-s3';
import type { AlertService } from '../../bot/alertService';

/** 啟動兩個 cron job：daily mirror（03:00 Taipei）、weekly archive（週日 04:00 Taipei） */
export function startBackupCron(client: S3Client, alertService: AlertService): void;
```

### `src/bot/alertService.ts`（MODIFY）

```ts
// 新增方法
sendBackupFailure(
  type: 'mirror' | 'archive',
  result: MirrorResult | ArchiveResult,
): Promise<void>;
```

### `src/scripts/`（NEW，CLI 入口）

```ts
// src/scripts/backupRestoreMirror.ts
// src/scripts/backupRestoreArchive.ts  (argv[2] = weekIso)
// src/scripts/backupListArchives.ts
// 三個檔案都是 standalone Node script：載入 .env → createR2Client → 呼叫對應 r2Restore 函數 → 輸出結果到 stdout
```

### `package.json`（MODIFY）— 新增 npm scripts

```json
{
  "scripts": {
    "backup:restore-mirror": "dotenvx run -f .env -- ts-node src/scripts/backupRestoreMirror.ts",
    "backup:restore-archive": "dotenvx run -f .env -- ts-node src/scripts/backupRestoreArchive.ts",
    "backup:list-archives": "dotenvx run -f .env -- ts-node src/scripts/backupListArchives.ts"
  }
}
```

### `.env.example`（MODIFY）— 新增變數

```bash
# Cloudflare R2 Backup
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

## Test Plan（TDD 起點，RED 階段的測試清單）

**測試先行原則**：所有 27 個測試在實作前完成 RED 階段。
**Mock 策略**：S3Client 用 `aws-sdk-client-mock` mock；本地檔案系統用 temporary fixtures（`tmp-promise` 或 jest tmp dir）。

### `tests/services/backup/r2Mirror.test.ts` — 12 cases

- [ ] RED: 本地有 3 檔、R2 全空 → MirrorPlan.toUpload 含 3 個項目
- [ ] RED: 本地與 R2 完全一致（path + size） → MirrorPlan.toUpload 為空陣列
- [ ] RED: 本地某檔 size 變大 → 該檔在 toUpload 內，reason='size_changed'
- [ ] RED: R2 上有額外檔案不在本地 → 不刪、不報錯（只增不減原則）
- [ ] RED: 本地巢狀目錄 `data/ohlcv/0x22ae...json` → r2Key 路徑保持完全相同
- [ ] RED: 上傳 5 檔 → S3Client.send PutObjectCommand 被呼叫 5 次
- [ ] RED: concurrency limit 5 → 同時 inflight 不超過 5（用 mock 計數驗證）
- [ ] RED: 單檔上傳失敗 → MirrorResult.errors 包含該檔，其他檔繼續上傳
- [ ] RED: 整批上傳完成 → MirrorResult.ok = (errors.length === 0)
- [ ] RED: 本地 data/ 目錄不存在 → 不 throw，回傳 ok=true, uploadedCount=0
- [ ] RED: `mirrorAnalysisToFlatPrefix` — `data/backtest-results/2026-04-12/summary.md` 存在 → 上傳到 `analysis/backtest-2026-04-12-summary.md`
- [ ] RED: `mirrorAnalysisToFlatPrefix` — `data/shadow/analysis/2026-W15.md` 存在 → 上傳到 `analysis/shadow-2026-W15.md`

### `tests/services/backup/r2Archive.test.ts` — 6 cases

- [ ] RED: tar 打包成功 + 上傳成功 → ArchiveResult.ok=true, error=null
- [ ] RED: tar 打包失敗 → ArchiveResult.ok=false, error 含原因
- [ ] RED: 上傳失敗 → ArchiveResult.ok=false, error 含原因
- [ ] RED: getCurrentWeekIso() 在 2026-04-12（週日）→ "2026-W15"
- [ ] RED: 完成後 /tmp 暫存檔被刪除（成功 case）
- [ ] RED: 完成後 /tmp 暫存檔被刪除（失敗 case，finally 區塊）

### `tests/services/backup/r2Restore.test.ts` — 9 cases

- [ ] RED: restoreMirror 既有 data/ 被重命名為 data.backup-<ts>/
- [ ] RED: restoreMirror R2 上 5 檔被下載到本地 data/
- [ ] RED: restoreMirror 下載失敗 → 自動 rollback（data.backup-<ts>/ 還原回 data/）
- [ ] RED: restoreMirror 成功後 data.backup-<ts>/ 留在原地（admin 手動清）
- [ ] RED: restoreArchive 不存在的 weekIso → throw with descriptive error
- [ ] RED: restoreArchive 下載成功 → tar.x 解壓到本地，覆蓋 data/ 與 logs/
- [ ] RED: restoreArchive tar.x 失敗 → rollback 既有 data/
- [ ] RED: listArchives R2 上有 5 個 archive → 回傳 5 筆，依 lastModified 降序
- [ ] RED: listArchives R2 上 0 個 archive → 回傳空陣列，不 throw

### TDD 守則
- 每個測試先 **RED**（執行 → 失敗）
- 寫最少程式碼讓測試 **GREEN**
- **REFACTOR** 階段不改測試行為
- 嚴禁先寫實作再補測試

## Tasks（subagent 執行順序）

### Stage 1 — r2Mirror + r2Archive（TDD）

1. **NEW**: 建立 `src/types/backup.ts`，寫入 5 個型別定義（MirrorPlan / MirrorResult / ArchiveResult / RestoreResult / ArchiveListing）
2. **NEW**: 建立 `src/services/backup/r2Client.ts`，實作 `createR2Client()` 與 `R2_BUCKET` 常數，含 env 缺失檢查
3. **RED**: 寫 `tests/services/backup/r2Mirror.test.ts` 10 cases，全部執行應失敗
4. **GREEN**: 實作 `src/services/backup/r2Mirror.ts`，包含 `runMirrorSync()`、內部 `buildMirrorPlan()`、`uploadFile()`、自寫 semaphore，逐一讓測試 GREEN
5. **RED**: 寫 `tests/services/backup/r2Archive.test.ts` 6 cases
6. **GREEN**: 實作 `src/services/backup/r2Archive.ts`，包含 `runWeeklyArchive()`、`getCurrentWeekIso()`，逐一讓測試 GREEN
6.5 **GREEN**: 在 `src/services/backup/r2Mirror.ts` 內新增 `mirrorAnalysisToFlatPrefix()` function 與 `ANALYSIS_FLATTEN_RULES` 常數，讓 r2Mirror.test.ts 內的 2 個 analysis flatten 測試 GREEN；修改 `runMirrorSync` 在主 sync 結束後呼叫 `mirrorAnalysisToFlatPrefix`
7. **REFACTOR**: 抽出 r2Mirror 與 r2Archive 共用的 helper（例如 retry wrapper、log formatter），保持 pure
8. **VERIFY**: 跑完整 test suite，確認所有 r2Mirror + r2Archive 測試 GREEN（含 analysis flatten）

### Stage 2 — r2Restore + CLI scripts（TDD）

9. **RED**: 寫 `tests/services/backup/r2Restore.test.ts` 9 cases
10. **GREEN**: 實作 `src/services/backup/r2Restore.ts` 的 3 個函數，含 safety backup rename + rollback 機制
11. **GREEN**: 建立 `src/scripts/backupRestoreMirror.ts`、`backupRestoreArchive.ts`、`backupListArchives.ts` 3 個 CLI 入口檔
12. **GREEN**: 修改 `package.json`，新增 3 個 `backup:*` npm scripts
13. **VERIFY**: r2Restore 測試 GREEN，且 `npm run backup:list-archives` 在本地能執行（會回傳空因為還沒上傳）

### Stage 3 — Cron 整合 + Telegram alert

14. **NEW**: 建立 `src/services/backup/backupCron.ts`，實作 `startBackupCron()`，含 `isMirrorRunning` / `isArchiveRunning` flag、`node-cron` 排程、try/catch + alertService 呼叫
15. **MODIFY**: `src/bot/alertService.ts` 新增 `sendBackupFailure()` 方法 + 中文 formatter（依 brainstorm Section 2.9 範例格式）
16. **MODIFY**: `src/index.ts`，啟動流程加入 `const r2Client = createR2Client(); startBackupCron(r2Client, alertService);`
17. **VERIFY**: 手動觸發兩個 cron（暫時改 cron expression 為下一分鐘），確認 fire-and-forget 行為與 isRunning guard 正確

### Stage 4 — R2 Bucket Setup（admin 手動）

18. **SETUP**: Cloudflare R2 Console 建立 bucket：`tradingbot-backup`
19. **SETUP**: 設定 lifecycle rule：`prefix=archives/`、`age > 90 days`、action=delete、status=enabled
20. **SETUP**: 建立 R2 API token：`dexbot-backup-token`，權限 `Object Read & Write`，limit 到 `tradingbot-backup` bucket，取得 endpoint / access key / secret
21. **SETUP**: Railway dashboard 設定 3 個 environment variables（R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）
22. **SETUP**: 修改 `.env.example`，加入 3 個 R2_* 變數的範例
23. **DEPLOY**: 觸發 Railway redeploy，觀察 logs 確認 `BackupCron started` 訊息

### Stage 5 — Smoke Test + Ship

24. **VERIFY**: Railway shell 內手動執行 `runMirrorSync`，確認 R2 console 看到 `data/` + `logs/` 出現
25. **VERIFY**: 模擬失敗（暫時把 R2_ACCESS_KEY 改錯），確認 Telegram alert 正確發出，含失敗檔案清單
26. **VERIFY**: 還原 credentials，下次 cron 確認自動恢復
27. **VERIFY**: 本地執行 `npm run backup:restore-mirror`，確認資料拉到本地 `data/` 與 `logs/`，且 safety backup `data.backup-<ts>/` 存在
28. **CLEANUP**: 刪除 safety backup 目錄（手動或 README 說明清理方式）
29. **SECURITY**: 跑 `/cso` 確認 R2 credentials 處理無安全漏洞，無 hardcoded secret
30. **SHIP**: 在 feature 分支最後 commit 刪除本 plan 檔案（依 CLAUDE.md Phase 2 規則 α），跑 `/ship` 整理 commit 並建 PR

### 完成標準

- 所有 27 個 unit tests GREEN（含 2 個 analysis flatten 測試）
- 手動 smoke test 通過：
  - mirror sync 真的在 R2 console 看到 `data/` + `logs/` 路徑
  - 若有 `data/backtest-results/<date>/summary.md` 或 `data/shadow/analysis/<weekIso>.md`，R2 console 看到 `analysis/` prefix 出現對應的攤平檔
  - 模擬失敗 → Telegram alert 含失敗檔案清單
  - `restore-mirror` 在本地測試成功，含 safety backup 機制
  - `list-archives` 能列出 R2 上的 archive
- 跑 `/cso` 通過資安檢查
- R2 lifecycle rule 在 dashboard 確認 enabled
- Railway 觀察 24h 後第一次自動 daily mirror 成功
- PR 描述含「依 CLAUDE.md Phase 2 規則 α 已刪除 plan 檔案」一行

### R2 路徑結構（最終版）

```
tradingbot-backup/                ← R2 bucket
├── data/                         ← 主 mirror（Decisions #1-7）
│   ├── ohlcv/
│   ├── diagnostics.jsonl
│   ├── shadow/                   ← Stage 2 後新增
│   ├── backtest-results/         ← Stage 1 一次性產出
│   └── genomes/
├── logs/                         ← 主 mirror
├── analysis/                     ← 攤平索引層（Decision #15，B2 brainstorm 追加）
│   ├── backtest-<date>-summary.md
│   ├── backtest-<date>-config.json
│   └── shadow-<weekIso>.md
└── archives/                     ← Weekly tar.gz（Decisions #3, lifecycle 90 天自動刪）
    └── <weekIso>.tar.gz
```
