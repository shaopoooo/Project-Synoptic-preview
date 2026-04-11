// R2 Mirror Sync 主邏輯
// 對應 .claude/plans/i-r2-backup.md Decisions #3-5, #14, #15

import {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { promises as fs, Dirent } from 'fs';
import * as path from 'path';
import { R2_BUCKET } from './r2Client';
import { createServiceLogger } from '../../utils/logger';
import type {
    MirrorPlan,
    MirrorResult,
    AnalysisMirrorResult,
} from '../../types/backup';

const log = createServiceLogger('R2Mirror');

/** Decisions #1-2: 全包 data/ + logs/，新增子目錄自動涵蓋 */
const MIRROR_PATHS = ['data/', 'logs/'] as const;

/** Decision #14: 並行上傳限制 5 */
const UPLOAD_CONCURRENCY = 5;

/**
 * Decision #15: Analysis 攤平規則（R2 backup brainstorm ratification 2026-04-11）
 *
 * 對 data/ 內符合的檔案，在主 mirror 結束後額外上傳到攤平的 analysis/ prefix。
 * 原始檔案仍透過正常 mirror sync 進入 R2 對應路徑；這層是索引攤平，不取代主 mirror。
 */
const ANALYSIS_FLATTEN_RULES: ReadonlyArray<{
    pattern: RegExp;
    rename: (match: RegExpExecArray) => string;
}> = [
    {
        // data/backtest-results/<date>/summary.md → analysis/backtest-<date>-summary.md
        pattern: /^data\/backtest-results\/([^/]+)\/summary\.md$/,
        rename: (m) => `analysis/backtest-${m[1]}-summary.md`,
    },
    {
        // data/backtest-results/<date>/config-snapshot.json → analysis/backtest-<date>-config.json
        pattern: /^data\/backtest-results\/([^/]+)\/config-snapshot\.json$/,
        rename: (m) => `analysis/backtest-${m[1]}-config.json`,
    },
    {
        // data/shadow/analysis/<weekIso>.md → analysis/shadow-<weekIso>.md
        pattern: /^data\/shadow\/analysis\/([^/]+)\.md$/,
        rename: (m) => `analysis/shadow-${m[1]}.md`,
    },
];

/**
 * 測試注入選項：允許 test 指定 baseDir 避免 process.chdir 的平行測試副作用。
 * Production 呼叫時 options 省略，baseDir 預設 = process.cwd()。
 * 此為 plan 介面的微小擴展（`runMirrorSync(client)` 仍可正常呼叫），不改變語意。
 */
export interface MirrorOptions {
    baseDir?: string;
}

interface LocalFile {
    /** 相對於 baseDir 的 POSIX 路徑（用於 R2 key） */
    localPath: string;
    /** 絕對路徑（用於實際檔案讀取） */
    absolutePath: string;
    sizeBytes: number;
}

/** 遞迴走訪目錄下的所有檔案；目錄不存在時回傳空陣列（不 throw） */
async function walkLocalFiles(baseDir: string, relativeDir: string): Promise<LocalFile[]> {
    const absDir = path.join(baseDir, relativeDir);
    let entries: Dirent[];
    try {
        entries = (await fs.readdir(absDir, {
            withFileTypes: true,
            recursive: true,
        })) as Dirent[];
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw err;
    }

    const files: LocalFile[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;

        // Node 20+ has entry.parentPath; older Node uses entry.path
        const parentPath =
            (entry as unknown as { parentPath?: string }).parentPath ??
            (entry as unknown as { path?: string }).path ??
            absDir;
        const absolutePath = path.join(parentPath, entry.name);

        const stat = await fs.stat(absolutePath);
        // Normalize to POSIX separators for R2 keys
        const localPath = path
            .relative(baseDir, absolutePath)
            .split(path.sep)
            .join('/');

        files.push({
            localPath,
            absolutePath,
            sizeBytes: stat.size,
        });
    }
    return files;
}

/** 列出 R2 指定 prefix 下所有物件，含 pagination */
async function listR2Objects(
    client: S3Client,
    prefix: string,
): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    let continuationToken: string | undefined;
    do {
        const resp = await client.send(
            new ListObjectsV2Command({
                Bucket: R2_BUCKET,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }),
        );
        if (resp.Contents) {
            for (const obj of resp.Contents) {
                if (obj.Key && typeof obj.Size === 'number') {
                    map.set(obj.Key, obj.Size);
                }
            }
        }
        continuationToken = resp.NextContinuationToken;
    } while (continuationToken);
    return map;
}

/**
 * Decision #4: Diff 策略 = path + size 比對
 * Decision #5: 只增不減（不處理 R2 上多的檔案）
 */
function diffFiles(
    localFiles: LocalFile[],
    remoteMap: Map<string, number>,
): MirrorPlan {
    const toUpload: MirrorPlan['toUpload'] = [];
    let unchanged = 0;
    let totalSizeBytes = 0;

    for (const local of localFiles) {
        const remoteSize = remoteMap.get(local.localPath);
        if (remoteSize === undefined) {
            toUpload.push({
                localPath: local.localPath,
                r2Key: local.localPath,
                sizeBytes: local.sizeBytes,
                reason: 'new',
            });
            totalSizeBytes += local.sizeBytes;
        } else if (remoteSize !== local.sizeBytes) {
            toUpload.push({
                localPath: local.localPath,
                r2Key: local.localPath,
                sizeBytes: local.sizeBytes,
                reason: 'size_changed',
            });
            totalSizeBytes += local.sizeBytes;
        } else {
            unchanged++;
        }
    }

    return { toUpload, unchanged, totalSizeBytes };
}

/**
 * Decision #14: 自寫 semaphore 限制並行數
 * 不用 p-limit（雖然已在 deps）是為了遵守 plan 的 "自寫 semaphore" 字面決策。
 */
function createSemaphore(maxConcurrent: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    return async function run<T>(fn: () => Promise<T>): Promise<T> {
        if (active >= maxConcurrent) {
            await new Promise<void>((resolve) => queue.push(resolve));
        }
        active++;
        try {
            return await fn();
        } finally {
            active--;
            const next = queue.shift();
            if (next) next();
        }
    };
}

async function uploadFile(
    client: S3Client,
    absolutePath: string,
    r2Key: string,
): Promise<void> {
    const body = await fs.readFile(absolutePath);
    await client.send(
        new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: r2Key,
            Body: body,
        }),
    );
}

/**
 * Mirror sync：本地 data/ + logs/ → R2（diff 後上傳，不刪除 R2 多餘檔）
 *
 * 失敗處理（Decision #9）：
 * - 單檔失敗 → 記錄到 errors，其他檔案繼續
 * - 整個 run 結束後 ok = (errors.length === 0)
 * - caller 決定是否推 Telegram
 */
export async function runMirrorSync(
    client: S3Client,
    options: MirrorOptions = {},
): Promise<MirrorResult> {
    const baseDir = options.baseDir ?? process.cwd();
    const startedAt = Date.now();

    // 1. Walk local files across all MIRROR_PATHS
    const allLocalFiles: LocalFile[] = [];
    for (const mirrorPath of MIRROR_PATHS) {
        const files = await walkLocalFiles(baseDir, mirrorPath);
        allLocalFiles.push(...files);
    }

    // 2. List R2 objects across all prefixes
    const remoteMap = new Map<string, number>();
    for (const mirrorPath of MIRROR_PATHS) {
        const prefixMap = await listR2Objects(client, mirrorPath);
        for (const [k, v] of prefixMap) {
            remoteMap.set(k, v);
        }
    }

    // 3. Diff
    const plan = diffFiles(allLocalFiles, remoteMap);
    log.info(
        `Mirror plan: ${plan.toUpload.length} to upload, ${plan.unchanged} unchanged, ${plan.totalSizeBytes} bytes`,
    );

    // 4. Upload with semaphore
    const errors: MirrorResult['errors'] = [];
    let uploadedCount = 0;
    let uploadedBytes = 0;

    const sem = createSemaphore(UPLOAD_CONCURRENCY);
    const localByPath = new Map(allLocalFiles.map((f) => [f.localPath, f]));

    await Promise.all(
        plan.toUpload.map((entry) =>
            sem(async () => {
                const local = localByPath.get(entry.localPath);
                if (!local) {
                    errors.push({
                        path: entry.localPath,
                        message: 'local file not found at upload time',
                    });
                    return;
                }
                try {
                    await uploadFile(client, local.absolutePath, entry.r2Key);
                    uploadedCount++;
                    uploadedBytes += entry.sizeBytes;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push({ path: entry.localPath, message });
                    log.warn(`Mirror upload failed: ${entry.localPath} - ${message}`);
                }
            }),
        ),
    );

    return {
        startedAt,
        finishedAt: Date.now(),
        uploadedCount,
        uploadedBytes,
        failedCount: errors.length,
        errors,
        ok: errors.length === 0,
    };
}

/**
 * Decision #15: 將 analysis 結果攤平到 R2 `analysis/` prefix
 *
 * 呼叫時機：主 mirror sync 結束後額外執行（Stage 3 cron 整合時在 runMirrorSync 後
 * 串一次呼叫，或獨立呼叫）。
 *
 * 不適用任何 lifecycle（永久保留，有審計價值）。
 */
export async function mirrorAnalysisToFlatPrefix(
    client: S3Client,
    options: MirrorOptions = {},
): Promise<AnalysisMirrorResult> {
    const baseDir = options.baseDir ?? process.cwd();
    const startedAt = Date.now();

    const flattenedFiles: AnalysisMirrorResult['flattenedFiles'] = [];
    const errors: AnalysisMirrorResult['errors'] = [];

    // 只需要掃 data/（rules 全部針對 data/ 內的路徑）
    const dataFiles = await walkLocalFiles(baseDir, 'data/');

    for (const file of dataFiles) {
        for (const rule of ANALYSIS_FLATTEN_RULES) {
            const match = rule.pattern.exec(file.localPath);
            if (match) {
                const r2Key = rule.rename(match);
                try {
                    await uploadFile(client, file.absolutePath, r2Key);
                    flattenedFiles.push({
                        source: file.absolutePath,
                        r2Key,
                        sizeBytes: file.sizeBytes,
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push({ source: file.absolutePath, message });
                    log.warn(
                        `Analysis flatten upload failed: ${file.localPath} → ${r2Key} - ${message}`,
                    );
                }
                break; // 一個檔案只對應一條 rule
            }
        }
    }

    return {
        startedAt,
        finishedAt: Date.now(),
        flattenedFiles,
        failedCount: errors.length,
        errors,
        ok: errors.length === 0,
    };
}
