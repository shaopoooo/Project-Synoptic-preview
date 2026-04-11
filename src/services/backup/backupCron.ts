// R2 Backup Cron 整合
// 對應 .claude/plans/i-r2-backup.md Stage 3
//
// 職責：
// - 註冊兩個 node-cron job（Daily mirror 03:00 / Weekly archive 週日 04:00，Asia/Taipei）
// - isRunning guard 防並發
// - try/catch：內部例外或 result.ok=false → 透過 alertService.sendBackupFailure 推 Telegram

import cron, { ScheduledTask } from 'node-cron';
import type { S3Client } from '@aws-sdk/client-s3';

import { runMirrorSync } from './r2Mirror';
import { runWeeklyArchive } from './r2Archive';
import { sendBackupFailure } from '../../bot/alertService';
import { createServiceLogger } from '../../utils/logger';
import type { MirrorResult, ArchiveResult } from '../../types/backup';

const log = createServiceLogger('BackupCron');

/** Decision #13: 每日 03:00 (Asia/Taipei) */
const DAILY_MIRROR_CRON = '0 3 * * *';
/** Decision #13: 每週日 04:00 (Asia/Taipei) */
const WEEKLY_ARCHIVE_CRON = '0 4 * * 0';
const TIMEZONE = 'Asia/Taipei';

/** 並發 guard（module-scoped，符合既有 mcEngine / positionMonitor pattern） */
let isMirrorRunning = false;
let isArchiveRunning = false;

export type SendAlertFn = (msg: string) => Promise<void>;

/**
 * 執行一次 mirror job（可獨立呼叫以做測試或手動觸發）。
 *
 * - isMirrorRunning guard：若已在跑則略過本次 tick
 * - runMirrorSync 本身不 throw（只增不減），但保險起見外層 try/catch 仍存在
 * - 任一 run 失敗（errors.length > 0 或 throw）即視為失敗 → sendBackupFailure
 */
export async function runMirrorJob(
    client: S3Client,
    sendAlert: SendAlertFn,
): Promise<void> {
    if (isMirrorRunning) {
        log.info('Mirror job skipped — previous run still in progress');
        return;
    }
    isMirrorRunning = true;
    try {
        log.info('Daily mirror sync start');
        const result: MirrorResult = await runMirrorSync(client);
        if (result.ok) {
            log.info(
                `Daily mirror sync ok — uploaded ${result.uploadedCount} files ` +
                `(${result.uploadedBytes} bytes) in ${result.finishedAt - result.startedAt}ms`,
            );
        } else {
            log.error(`Daily mirror sync failed — ${result.failedCount} files errored`);
            await sendBackupFailure('mirror', result, sendAlert).catch((e) =>
                log.error('sendBackupFailure (mirror) threw', e),
            );
        }
    } catch (e) {
        // runMirrorSync 自身理論上不會 throw，但若發生（例如 env 缺失）仍需告警
        log.error('Daily mirror sync threw', e);
        const fallback: MirrorResult = {
            startedAt: Date.now(),
            finishedAt: Date.now(),
            uploadedCount: 0,
            uploadedBytes: 0,
            failedCount: 1,
            errors: [{ path: '(mirror run)', message: e instanceof Error ? e.message : String(e) }],
            ok: false,
        };
        await sendBackupFailure('mirror', fallback, sendAlert).catch((err) =>
            log.error('sendBackupFailure (mirror fallback) threw', err),
        );
    } finally {
        isMirrorRunning = false;
    }
}

/**
 * 執行一次 archive job（可獨立呼叫以做測試或手動觸發）。
 */
export async function runArchiveJob(
    client: S3Client,
    sendAlert: SendAlertFn,
): Promise<void> {
    if (isArchiveRunning) {
        log.info('Archive job skipped — previous run still in progress');
        return;
    }
    isArchiveRunning = true;
    try {
        log.info('Weekly archive start');
        const result: ArchiveResult = await runWeeklyArchive(client);
        if (result.ok) {
            log.info(
                `Weekly archive ok — ${result.weekIso} (${result.archiveSizeBytes} bytes) ` +
                `in ${result.finishedAt - result.startedAt}ms`,
            );
        } else {
            log.error(`Weekly archive failed — ${result.error ?? 'unknown'}`);
            await sendBackupFailure('archive', result, sendAlert).catch((e) =>
                log.error('sendBackupFailure (archive) threw', e),
            );
        }
    } catch (e) {
        log.error('Weekly archive threw', e);
        const fallback: ArchiveResult = {
            startedAt: Date.now(),
            finishedAt: Date.now(),
            weekIso: '(unknown)',
            archiveSizeBytes: 0,
            r2Key: '',
            ok: false,
            error: e instanceof Error ? e.message : String(e),
        };
        await sendBackupFailure('archive', fallback, sendAlert).catch((err) =>
            log.error('sendBackupFailure (archive fallback) threw', err),
        );
    } finally {
        isArchiveRunning = false;
    }
}

/**
 * 啟動兩個 cron job：
 * - Daily mirror 03:00 Asia/Taipei
 * - Weekly archive 週日 04:00 Asia/Taipei
 *
 * 回傳兩個 ScheduledTask，方便 shutdown 時 stop 或測試時手動觸發。
 */
export function startBackupCron(
    client: S3Client,
    sendAlert: SendAlertFn,
): { mirrorTask: ScheduledTask; archiveTask: ScheduledTask } {
    const mirrorTask = cron.schedule(
        DAILY_MIRROR_CRON,
        () => {
            void runMirrorJob(client, sendAlert);
        },
        { timezone: TIMEZONE },
    );

    const archiveTask = cron.schedule(
        WEEKLY_ARCHIVE_CRON,
        () => {
            void runArchiveJob(client, sendAlert);
        },
        { timezone: TIMEZONE },
    );

    log.info(
        `BackupCron started — daily mirror "${DAILY_MIRROR_CRON}" / weekly archive "${WEEKLY_ARCHIVE_CRON}" (${TIMEZONE})`,
    );
    return { mirrorTask, archiveTask };
}

/** 測試用：重置 isRunning flags（正式程式碼不呼叫） */
export function __resetRunningFlagsForTest(): void {
    isMirrorRunning = false;
    isArchiveRunning = false;
}
