/**
 * backupRestoreMirror.ts — 從 R2 mirror 拉所有 data/ + logs/ 到本地
 *
 * Usage: npm run backup:restore-mirror
 *
 * 對應 .claude/plans/i-r2-backup.md Stage 2 Decision #10
 *
 * 安全機制（Decision #11）：開始前會把現有 data/ 與 logs/ 重命名為
 * data.backup-<ts>/ 與 logs.backup-<ts>/，失敗自動 rollback，成功後留在
 * 原地等 admin 手動清理。
 */

import { createR2Client } from '../infra/backup/r2Client';
import { restoreMirror } from '../infra/backup/r2Restore';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('BackupRestoreMirror');

async function main(): Promise<void> {
    log.info('Starting R2 mirror restore to current directory');
    const client = createR2Client();
    const result = await restoreMirror(client);

    if (result.ok) {
        log.info(
            `Restore mirror success: ${result.restoredCount} files, ${result.restoredBytes} bytes`,
        );
        log.info(`Safety backup retained at: ${result.safetyBackupPath}`);
        log.info('After verifying the restore, you can manually clean up the safety backup:');
        log.info(`  rm -rf ${result.safetyBackupPath}`);
        process.exit(0);
    } else {
        log.error(`Restore mirror failed: ${result.error}`);
        log.error('Existing data/ and logs/ have been rolled back to their original state');
        process.exit(1);
    }
}

main().catch((err) => {
    log.error(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
