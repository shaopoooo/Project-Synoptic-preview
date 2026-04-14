// R2 Weekly Archive 主邏輯
// 對應 .claude/plans/i-r2-backup.md Decision #3（weekly tar.gz + 90d lifecycle）

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import { R2_BUCKET } from './r2Client';
import { createServiceLogger } from '../logger';
import type { ArchiveResult } from '../../types/backup';

const log = createServiceLogger('R2Archive');

/** Decision #3: 打包 data/ + logs/ */
const ARCHIVE_SOURCES = ['data/', 'logs/'] as const;

/** 預設暫存目錄（Railway 容器內 /tmp 可寫） */
const DEFAULT_TMP_DIR = '/tmp/dexbot-backup';

export interface ArchiveOptions {
    /** 打包來源的根目錄（預設 process.cwd()） */
    baseDir?: string;
    /** tar 暫存檔存放目錄（預設 /tmp/dexbot-backup） */
    tmpDir?: string;
    /** 注入時鐘（用於測試與 deterministic weekIso） */
    now?: Date;
}

/**
 * 依 ISO 8601 計算某個日期所屬的 "YYYY-Www" 格式。
 *
 * ISO week 規則：
 * - 週以週一開始、週日結束
 * - 第 1 週是包含第一個週四的那一週
 * - year-week 的 "year" 是該週週四所在的年份（可能與月曆年不同）
 */
export function getCurrentWeekIso(date: Date = new Date()): string {
    // 複製避免 mutation
    const d = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    // 把日期 shift 到該週的週四（ISO week year 的錨）
    const dayNum = d.getUTCDay() || 7; // 週日 0 → 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);

    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(
        ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );

    const ww = String(weekNum).padStart(2, '0');
    return `${d.getUTCFullYear()}-W${ww}`;
}

/**
 * Weekly archive：打包 data/ + logs/ 成 tar.gz 上傳到 R2 archives/<weekIso>.tar.gz
 *
 * 失敗處理（Decision #9）：
 * - tar 打包失敗 → 回傳 ok=false，tmp 檔已清理
 * - 上傳失敗 → 回傳 ok=false，tmp 檔已清理（finally 區塊）
 * - 成功 → 回傳 ok=true
 */
export async function runWeeklyArchive(
    client: S3Client,
    options: ArchiveOptions = {},
): Promise<ArchiveResult> {
    const baseDir = options.baseDir ?? process.cwd();
    const tmpDir = options.tmpDir ?? DEFAULT_TMP_DIR;
    const now = options.now ?? new Date();

    const startedAt = Date.now();
    const weekIso = getCurrentWeekIso(now);
    const tmpFileName = `${weekIso}.tar.gz`;
    const archivePath = path.join(tmpDir, tmpFileName);
    const r2Key = `archives/${weekIso}.tar.gz`;

    try {
        await fs.mkdir(tmpDir, { recursive: true });

        // 1. tar streaming 打包（失敗會 throw）
        await tar.c(
            {
                gzip: true,
                file: archivePath,
                cwd: baseDir,
            },
            [...ARCHIVE_SOURCES],
        );

        // 2. 讀取整個 tarball 成 Buffer 後上傳
        //    不用 createReadStream：stream 是 lazy open，aws-sdk-client-mock 環境下
        //    PutObject mock 直接 resolve 不消耗 stream，於是 finally 刪檔後 stream
        //    才延遲 open() → ENOENT。Buffer 上傳是原子操作，無此 race。
        //    Tarball 在 /tmp 且本專案 data + logs 總量 ~3 MB，memory footprint 可接受。
        const body = await fs.readFile(archivePath);
        await client.send(
            new PutObjectCommand({
                Bucket: R2_BUCKET,
                Key: r2Key,
                Body: body,
                ContentLength: body.length,
            }),
        );

        log.info(`Archive ${weekIso} uploaded, ${body.length} bytes`);
        return {
            startedAt,
            finishedAt: Date.now(),
            weekIso,
            archiveSizeBytes: body.length,
            r2Key,
            ok: true,
            error: null,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Archive failed: ${weekIso} - ${message}`);
        return {
            startedAt,
            finishedAt: Date.now(),
            weekIso,
            archiveSizeBytes: 0,
            r2Key,
            ok: false,
            error: message,
        };
    } finally {
        // 成功與失敗都清理 tmp 檔
        await fs.unlink(archivePath).catch(() => {
            /* 檔案可能根本沒建立成功，忽略 */
        });
    }
}
