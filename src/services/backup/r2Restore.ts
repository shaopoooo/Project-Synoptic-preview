// R2 Restore 邏輯（Stage 2）
// 對應 .claude/plans/i-r2-backup.md Decisions #10-11（手動 CLI restore + safety backup 機制）

import {
    S3Client,
    GetObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { promises as fs, createWriteStream } from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { R2_BUCKET } from './r2Client';
import { createServiceLogger } from '../../utils/logger';
import type { RestoreResult, ArchiveListing } from '../../types/backup';

const log = createServiceLogger('R2Restore');

/** Decision #10: restore 來源與 Decision #1 的 mirror 一致 */
const RESTORE_PATHS = ['data', 'logs'] as const;

/**
 * 驗證一個相對路徑（R2 key 或 tar entry path）是否安全可解壓/下載到 baseDir 下：
 *
 * 1. 第一個 segment 必須是 RESTORE_PATHS 白名單之一（`data` 或 `logs`）
 * 2. 任何 segment 都不可以是 `..`
 * 3. 經過 path.resolve 後必須仍在 baseDir 之內（double-check，防 Unicode 繞過）
 *
 * 對應 CSO audit Finding #1（path traversal in restoreMirror）與 #2（tar.x hardening）。
 * 威脅模型：攻擊者拿到 R2 write credentials，上傳惡意 key 到 mirror 或 archive。
 * 若無此檢查，`path.join(baseDir, '../../.ssh/authorized_keys')` 會逃出 baseDir。
 */
export function isSafeRelativePath(
    relativePath: string,
    baseDir: string,
): boolean {
    if (!relativePath) return false;

    // 拒絕絕對路徑（`/etc/xxx` 或 Windows 碟機）
    if (path.isAbsolute(relativePath)) return false;

    // 以 POSIX 分隔符切（R2 key 是 POSIX 格式）
    const segments = relativePath.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return false;

    // 任一 segment 為 '..' 立刻拒絕
    if (segments.some((s) => s === '..')) return false;

    // 第一段必須是白名單
    if (!(RESTORE_PATHS as readonly string[]).includes(segments[0])) return false;

    // 最後再 path.resolve 比對，防 Unicode / 不可見字元繞過
    const resolvedTarget = path.resolve(baseDir, relativePath);
    const resolvedBase = path.resolve(baseDir);
    if (
        resolvedTarget !== resolvedBase &&
        !resolvedTarget.startsWith(resolvedBase + path.sep)
    ) {
        return false;
    }

    return true;
}

/** 預設暫存目錄（與 r2Archive 一致） */
const DEFAULT_TMP_DIR = '/tmp/dexbot-backup';

export interface RestoreOptions {
    /** 還原的目標根目錄（預設 process.cwd()） */
    baseDir?: string;
    /** restoreArchive 用的 tar 暫存目錄 */
    tmpDir?: string;
}

/** 把 S3 Body（Readable 或帶 stream mixin）讀成 Buffer */
async function bodyToBuffer(body: unknown): Promise<Buffer> {
    if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
        const arr = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        return Buffer.from(arr);
    }
    if (body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    throw new Error('Unknown S3 Body type');
}

/** 把 S3 Body 寫入檔案（streaming） */
async function bodyToFile(body: unknown, targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
        const arr = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        await fs.writeFile(targetPath, Buffer.from(arr));
        return;
    }
    if (body instanceof Readable) {
        await pipeline(body, createWriteStream(targetPath));
        return;
    }
    throw new Error('Unknown S3 Body type');
}

/** Safety backup 子目錄前綴（hidden，避免被一般 glob 掃到） */
const SAFETY_BACKUP_PREFIX = '.backup-';

/** 是否為 safety backup 子目錄（用於排除掃描 / 搬移時 skip self） */
function isSafetyBackupDir(name: string): boolean {
    return name.startsWith(SAFETY_BACKUP_PREFIX);
}

/**
 * Decision #11: Safety backup 機制
 *
 * **Railway volume 相容性**：`/app/data` 是掛載點（bind mount），核心層級禁止
 * `rename` 掛載點本身（EBUSY），跨掛載邊界 rename 子檔也會拿 EXDEV。因此 safety
 * backup 必須建在 **掛載內部** 的 hidden 子目錄（`data/.backup-<ts>/`），把原本
 * 的子項 rename 進去；這樣所有操作都在同一個 filesystem。
 *
 * 對每個 RESTORE_PATHS 目錄：
 *   1. 若目錄不存在或為空 → skip（不建立空 safety backup）
 *   2. 建立 `<baseDir>/<name>/.backup-<ts>/`
 *   3. 把 `<name>/` 下除了 `.backup-*` 以外的所有子項 rename 進 safety 目錄
 *
 * 回傳 moved：restore 流程若失敗，rollbackSafetyBackup 會據此還原。
 */
async function createSafetyBackup(baseDir: string): Promise<{
    /** 代表路徑：第一個有 safety backup 的目錄（供測試與外部檢查 exists） */
    safetyBackupPath: string;
    /** 被搬走的目錄清單：原始目錄 → 其內部的 safety 子目錄 */
    moved: Array<{ original: string; safety: string }>;
}> {
    const ts = Date.now();
    const moved: Array<{ original: string; safety: string }> = [];

    for (const name of RESTORE_PATHS) {
        const original = path.join(baseDir, name);

        let children: string[];
        try {
            children = await fs.readdir(original);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
        }

        // 過濾掉既有的 safety backup 目錄（避免巢狀備份）
        const payload = children.filter((c) => !isSafetyBackupDir(c));
        if (payload.length === 0) continue;

        const safety = path.join(original, `${SAFETY_BACKUP_PREFIX}${ts}`);
        await fs.mkdir(safety, { recursive: true });

        for (const child of payload) {
            await fs.rename(
                path.join(original, child),
                path.join(safety, child),
            );
        }
        moved.push({ original, safety });
    }

    const safetyBackupPath =
        moved[0]?.safety ?? path.join(baseDir, `__no-safety-${ts}`);
    return { safetyBackupPath, moved };
}

/**
 * Rollback：把 safety backup 內的子項 rename 回原目錄，同時清除 restore 過程中
 * 已經寫入原目錄的新檔案。注意：**不能** 動原目錄（mount point）本身。
 */
async function rollbackSafetyBackup(
    baseDir: string,
    moved: Array<{ original: string; safety: string }>,
): Promise<void> {
    void baseDir;
    for (const { original, safety } of moved) {
        // 1. 刪除 restore 過程中寫入 original/ 的新檔（保留 safety 目錄本身）
        try {
            const currentChildren = await fs.readdir(original);
            for (const child of currentChildren) {
                const childPath = path.join(original, child);
                if (childPath === safety) continue; // 保留 safety dir
                await fs.rm(childPath, { recursive: true, force: true });
            }
        } catch (err) {
            log.warn(
                `Rollback cleanup failed for ${original}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        // 2. 把 safety 內容搬回 original/
        try {
            const safetyChildren = await fs.readdir(safety);
            for (const child of safetyChildren) {
                await fs.rename(
                    path.join(safety, child),
                    path.join(original, child),
                );
            }
            // 3. 移除空的 safety 目錄
            await fs.rmdir(safety);
        } catch (err) {
            log.warn(
                `Rollback restore failed for ${original}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

/**
 * 從 R2 mirror 把所有 data/ + logs/ 檔案拉回本地。
 *
 * 流程：
 * 1. 對現有 data/ 與 logs/ 做 safety backup（rename）
 * 2. List R2 的 data/ 與 logs/ prefix
 * 3. 逐檔 GetObject 寫到本地
 * 4. 失敗 → rollback（還原 safety backup）
 * 5. 成功 → safety backup 留在原地，admin 手動清理
 */
export async function restoreMirror(
    client: S3Client,
    options: RestoreOptions = {},
): Promise<RestoreResult> {
    const baseDir = options.baseDir ?? process.cwd();
    const startedAt = Date.now();

    const safety = await createSafetyBackup(baseDir);

    let restoredCount = 0;
    let restoredBytes = 0;

    try {
        // List + download data/ and logs/
        for (const prefix of RESTORE_PATHS) {
            let continuationToken: string | undefined;
            do {
                const resp = await client.send(
                    new ListObjectsV2Command({
                        Bucket: R2_BUCKET,
                        Prefix: `${prefix}/`,
                        ContinuationToken: continuationToken,
                    }),
                );
                const contents = resp.Contents ?? [];
                for (const obj of contents) {
                    if (!obj.Key) continue;
                    // CSO Finding #1: path traversal guard
                    if (!isSafeRelativePath(obj.Key, baseDir)) {
                        log.warn(
                            `Refusing to restore suspicious R2 key outside baseDir / whitelist: ${obj.Key}`,
                        );
                        continue;
                    }
                    const getResp = await client.send(
                        new GetObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }),
                    );
                    const targetPath = path.join(baseDir, obj.Key);
                    await bodyToFile(getResp.Body, targetPath);
                    restoredCount++;
                    restoredBytes += obj.Size ?? 0;
                }
                continuationToken = resp.NextContinuationToken;
            } while (continuationToken);
        }

        log.info(`Restore mirror done: ${restoredCount} files, ${restoredBytes} bytes`);
        return {
            startedAt,
            finishedAt: Date.now(),
            restoredCount,
            restoredBytes,
            safetyBackupPath: safety.safetyBackupPath,
            ok: true,
            error: null,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Restore mirror failed, rolling back: ${message}`);
        await rollbackSafetyBackup(baseDir, safety.moved);
        return {
            startedAt,
            finishedAt: Date.now(),
            restoredCount,
            restoredBytes,
            safetyBackupPath: safety.safetyBackupPath,
            ok: false,
            error: message,
        };
    }
}

/**
 * 下載指定週的 archive 並解壓到本地。
 *
 * 流程：
 * 1. 對現有 data/ 與 logs/ 做 safety backup
 * 2. GetObject archives/<weekIso>.tar.gz → 寫入 tmp
 * 3. tar.x 解壓到 baseDir
 * 4. 失敗 → rollback + 清 tmp
 * 5. 成功 → safety backup 留在原地，tmp 清理
 */
export async function restoreArchive(
    client: S3Client,
    weekIso: string,
    options: RestoreOptions = {},
): Promise<RestoreResult> {
    const baseDir = options.baseDir ?? process.cwd();
    const tmpDir = options.tmpDir ?? DEFAULT_TMP_DIR;
    const startedAt = Date.now();
    const r2Key = `archives/${weekIso}.tar.gz`;
    const tmpTarPath = path.join(tmpDir, `restore-${weekIso}.tar.gz`);

    const safety = await createSafetyBackup(baseDir);

    try {
        await fs.mkdir(tmpDir, { recursive: true });

        // 1. Download archive to tmp
        const getResp = await client.send(
            new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
        );
        await bodyToFile(getResp.Body, tmpTarPath);

        // 2. tar.x extract into baseDir
        //    CSO Finding #2: strict + filter hardening。node-tar v7 預設已 strip
        //    絕對路徑與 '..'，這裡再加白名單 filter 作為 defense-in-depth。
        await tar.x({
            file: tmpTarPath,
            cwd: baseDir,
            filter: (entryPath: string) => {
                if (!isSafeRelativePath(entryPath, baseDir)) {
                    log.warn(
                        `tar.x skipping entry outside whitelist / baseDir: ${entryPath}`,
                    );
                    return false;
                }
                return true;
            },
        });

        // 3. 計算 restored 檔案數（粗略：扫描 extracted 目錄）
        let restoredCount = 0;
        let restoredBytes = 0;
        for (const name of RESTORE_PATHS) {
            const dir = path.join(baseDir, name);
            try {
                const entries = (await fs.readdir(dir, {
                    withFileTypes: true,
                    recursive: true,
                })) as import('fs').Dirent[];
                for (const e of entries) {
                    if (e.isFile()) {
                        // parentPath compat
                        const parent =
                            (e as unknown as { parentPath?: string }).parentPath ??
                            (e as unknown as { path?: string }).path ??
                            dir;
                        // 排除 safety backup 子目錄下的檔案（舊資料，不算 restored）
                        const rel = path.relative(dir, path.join(parent, e.name));
                        if (rel.split(path.sep).some(isSafetyBackupDir)) continue;
                        restoredCount++;
                        const stat = await fs.stat(path.join(parent, e.name));
                        restoredBytes += stat.size;
                    }
                }
            } catch {
                // 目錄可能不存在
            }
        }

        log.info(`Restore archive ${weekIso} done: ${restoredCount} files`);
        return {
            startedAt,
            finishedAt: Date.now(),
            restoredCount,
            restoredBytes,
            safetyBackupPath: safety.safetyBackupPath,
            ok: true,
            error: null,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Restore archive ${weekIso} failed, rolling back: ${message}`);
        await rollbackSafetyBackup(baseDir, safety.moved);
        return {
            startedAt,
            finishedAt: Date.now(),
            restoredCount: 0,
            restoredBytes: 0,
            safetyBackupPath: safety.safetyBackupPath,
            ok: false,
            error: message.includes(weekIso) ? message : `${weekIso}: ${message}`,
        };
    } finally {
        await fs.unlink(tmpTarPath).catch(() => {
            /* 檔案可能沒建成功 */
        });
    }
}

/**
 * 列出 R2 上所有可用的 archive，依 lastModified 降序（最新在前）
 */
export async function listArchives(client: S3Client): Promise<ArchiveListing[]> {
    const listings: ArchiveListing[] = [];
    let continuationToken: string | undefined;

    do {
        const resp = await client.send(
            new ListObjectsV2Command({
                Bucket: R2_BUCKET,
                Prefix: 'archives/',
                ContinuationToken: continuationToken,
            }),
        );
        for (const obj of resp.Contents ?? []) {
            if (!obj.Key) continue;
            // archives/2026-W15.tar.gz → 2026-W15
            const match = /^archives\/(\d{4}-W\d{2})\.tar\.gz$/.exec(obj.Key);
            if (!match) continue;
            listings.push({
                weekIso: match[1],
                sizeBytes: obj.Size ?? 0,
                lastModified: obj.LastModified ?? new Date(0),
                r2Key: obj.Key,
            });
        }
        continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    // 降序：最新在前
    listings.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return listings;
}
