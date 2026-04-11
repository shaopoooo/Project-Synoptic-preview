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

/**
 * Decision #11: Safety backup 機制
 *
 * 對現有目錄（data/ 與 logs/）做「就地重命名」成
 * `data.backup-<timestamp>/` 與 `logs.backup-<timestamp>/`。
 *
 * 回傳 safety backup 的「父路徑」——一個包含 data.backup-<ts> 與 logs.backup-<ts>
 * 的虛擬位置（實際上兩個目錄都在 baseDir 下，共享同一個 timestamp）。
 * 外部只取 safetyBackupPath 中的 timestamp 即可找到對應檔案。
 */
async function createSafetyBackup(baseDir: string): Promise<{
    /** 虛擬父目錄：`<baseDir>/__safety-<timestamp>` 的概念，實際回傳對應的 data.backup-<ts> 目錄 */
    safetyBackupPath: string;
    /** 被搬走的目錄清單：原始路徑 → safety 路徑 */
    moved: Array<{ original: string; safety: string }>;
}> {
    const ts = Date.now();
    const moved: Array<{ original: string; safety: string }> = [];

    for (const name of RESTORE_PATHS) {
        const original = path.join(baseDir, name);
        const safety = path.join(baseDir, `${name}.backup-${ts}`);
        try {
            await fs.rename(original, safety);
            moved.push({ original, safety });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            // 原目錄不存在 → skip，不算 moved
        }
    }

    // 回傳 data.backup-<ts> 作為代表路徑（測試用來檢查 safety backup 存在）
    // 若 data/ 原本不存在，回退到 logs.backup-<ts>
    const safetyBackupPath = moved[0]?.safety ?? path.join(baseDir, `__no-safety-${ts}`);
    return { safetyBackupPath, moved };
}

/** Rollback：把 safety backup 重命名回原位置，同時清除已下載到新位置的檔案 */
async function rollbackSafetyBackup(
    baseDir: string,
    moved: Array<{ original: string; safety: string }>,
): Promise<void> {
    for (const { original, safety } of moved) {
        // 先刪掉可能半路下載到新位置的東西
        await fs.rm(original, { recursive: true, force: true });
        // safety → original
        try {
            await fs.rename(safety, original);
        } catch (err) {
            log.warn(
                `Rollback failed for ${original}: ${err instanceof Error ? err.message : String(err)}`,
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
        await tar.x({ file: tmpTarPath, cwd: baseDir });

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
                        restoredCount++;
                        // parentPath compat
                        const parent =
                            (e as unknown as { parentPath?: string }).parentPath ??
                            (e as unknown as { path?: string }).path ??
                            dir;
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
