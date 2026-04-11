/**
 * backupSmokeMirror.ts — 手動觸發一次 mirror sync（Stage 5 smoke test 用）
 *
 * Usage: npm run backup:smoke-mirror
 *
 * 對應 .claude/plans/i-r2-backup.md Stage 5 Task 24 的 dev 驗證版本：
 * 在不啟動 bot 主排程的情況下，直接對當前 R2_BUCKET（建議指向 dev bucket）
 * 跑一次 runMirrorSync，用來確認：
 *   - credentials 是否可用
 *   - endpoint / bucket 是否正確
 *   - data/ + logs/ 能否正確 diff + 上傳
 *   - analysis flatten 是否正確產出
 *
 * ⚠️ 注意：這會真的把本地 data/ + logs/ 上傳到 R2_BUCKET。
 * 生產 bucket 請不要跑，只在 dev bucket 驗證。
 */

import { createR2Client, R2_BUCKET } from '../services/backup/r2Client';
import { runMirrorSync } from '../services/backup/r2Mirror';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('BackupSmokeMirror');

async function main(): Promise<void> {
    log.info(`Smoke test target bucket: ${R2_BUCKET}`);
    if (!R2_BUCKET.includes('dev')) {
        log.warn(
            `Bucket "${R2_BUCKET}" 名稱不含 "dev"，確認這不是 prod bucket 後再繼續`,
        );
        log.warn('5 秒後繼續，Ctrl+C 可中斷');
        await new Promise((r) => setTimeout(r, 5000));
    }

    const client = createR2Client();
    const result = await runMirrorSync(client);

    log.info('Smoke test result:');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    if (result.ok) {
        log.info(
            `Mirror sync ok — uploaded ${result.uploadedCount} files ` +
            `(${result.uploadedBytes} bytes) in ${result.finishedAt - result.startedAt}ms`,
        );
        process.exit(0);
    } else {
        log.error(`Mirror sync failed — ${result.failedCount} files errored`);
        for (const err of result.errors) {
            log.error(`  ${err.path} — ${err.message}`);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    log.error(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
