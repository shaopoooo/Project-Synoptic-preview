/**
 * backupListArchives.ts — 列出 R2 上所有可用的 weekly archive
 *
 * Usage: npm run backup:list-archives
 *
 * 對應 .claude/plans/i-r2-backup.md Stage 2 Decision #10
 *
 * 輸出格式：
 *   weekIso       size       lastModified
 *   2026-W15     2.3 MB     2026-04-12T04:00:00.000Z
 *   ...
 */

import { createR2Client } from '../infra/backup/r2Client';
import { listArchives } from '../infra/backup/r2Restore';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('BackupListArchives');

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function main(): Promise<void> {
    const client = createR2Client();
    const archives = await listArchives(client);

    if (archives.length === 0) {
        log.info('No archives found in R2 bucket');
        process.exit(0);
    }

    log.info(`Found ${archives.length} archives (newest first):`);
    // 純文字表格輸出（不用 logger 格式化避免干擾對齊）
    process.stdout.write('\n');
    process.stdout.write('  weekIso      size          lastModified\n');
    process.stdout.write('  ─────────    ──────────    ──────────────────────────\n');
    for (const a of archives) {
        const size = formatBytes(a.sizeBytes).padEnd(10);
        const iso = a.lastModified.toISOString();
        process.stdout.write(`  ${a.weekIso}      ${size}    ${iso}\n`);
    }
    process.stdout.write('\n');
    process.exit(0);
}

main().catch((err) => {
    log.error(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
});
