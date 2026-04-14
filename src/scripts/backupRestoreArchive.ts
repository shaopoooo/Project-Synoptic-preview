/**
 * backupRestoreArchive.ts — 下載指定週的 archive 並解壓到本地
 *
 * Usage: npm run backup:restore-archive -- 2026-W15
 *
 * 對應 .claude/plans/i-r2-backup.md Stage 2 Decision #10
 *
 * 安全機制（Decision #11）：開始前會把現有 data/ 與 logs/ 重命名為 safety
 * backup，失敗自動 rollback，成功後留在原地等 admin 手動清理。
 */

import { createR2Client } from '../infra/backup/r2Client';
import { restoreArchive } from '../infra/backup/r2Restore';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('BackupRestoreArchive');

async function main(): Promise<void> {
    // argv[0]=node, argv[1]=script, argv[2]=weekIso
    const weekIso = process.argv[2];
    if (!weekIso) {
        log.error('Usage: npm run backup:restore-archive -- <weekIso>');
        log.error('Example: npm run backup:restore-archive -- 2026-W15');
        log.error('Use `npm run backup:list-archives` to see available archives');
        process.exit(1);
    }

    if (!/^\d{4}-W\d{2}$/.test(weekIso)) {
        log.error(`Invalid weekIso format: "${weekIso}". Expected "YYYY-Www" (e.g. 2026-W15)`);
        process.exit(1);
    }

    log.info(`Starting R2 archive restore: ${weekIso}`);
    const client = createR2Client();
    const result = await restoreArchive(client, weekIso);

    if (result.ok) {
        log.info(
            `Restore archive success: ${result.restoredCount} files, ${result.restoredBytes} bytes`,
        );
        log.info(`Safety backup retained at: ${result.safetyBackupPath}`);
        log.info('After verifying the restore, you can manually clean up the safety backup:');
        log.info(`  rm -rf ${result.safetyBackupPath}`);
        process.exit(0);
    } else {
        log.error(`Restore archive failed: ${result.error}`);
        log.error('Existing data/ and logs/ have been rolled back to their original state');
        process.exit(1);
    }
}

main().catch((err) => {
    log.error(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
