// RED 階段：r2Archive.ts 6 個測試案例
// 對應 .claude/plans/i-r2-backup.md Test Plan 段落

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    runWeeklyArchive,
    getCurrentWeekIso,
} from '../../../src/services/backup/r2Archive';

const s3Mock = mockClient(S3Client);
const client = new S3Client({ region: 'auto' });

async function createTmpDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFixture(baseDir: string, relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

describe('getCurrentWeekIso', () => {
    it('2026-04-12（週日）→ "2026-W15"', () => {
        // ISO 8601 week: 2026-01-01 是週四 → W01 = 2025-12-29 ~ 2026-01-04
        // 2026-04-12 (週日) 落在 W15 (2026-04-06 ~ 2026-04-12)
        const sunday = new Date(Date.UTC(2026, 3, 12)); // month 是 0-indexed，3 = April
        expect(getCurrentWeekIso(sunday)).toBe('2026-W15');
    });
});

describe('runWeeklyArchive', () => {
    let tmpBaseDir: string;
    let tmpWorkDir: string;

    beforeEach(async () => {
        s3Mock.reset();
        tmpBaseDir = await createTmpDir('r2archive-base-');
        tmpWorkDir = await createTmpDir('r2archive-work-');

        // 建立 fixture 檔案讓 tar 有東西可以打包
        await writeFixture(tmpBaseDir, 'data/a.json', '{"a":1}');
        await writeFixture(tmpBaseDir, 'logs/combined.log', 'log line');
    });

    afterEach(async () => {
        await fs.rm(tmpBaseDir, { recursive: true, force: true });
        await fs.rm(tmpWorkDir, { recursive: true, force: true });
    });

    it('tar 打包成功 + 上傳成功 → ok=true, error=null', async () => {
        s3Mock.on(PutObjectCommand).resolves({});

        const fixedNow = new Date(Date.UTC(2026, 3, 12)); // 2026-W15
        const result = await runWeeklyArchive(client, {
            baseDir: tmpBaseDir,
            tmpDir: tmpWorkDir,
            now: fixedNow,
        });

        expect(result.ok).toBe(true);
        expect(result.error).toBeNull();
        expect(result.weekIso).toBe('2026-W15');
        expect(result.r2Key).toBe('archives/2026-W15.tar.gz');
        expect(result.archiveSizeBytes).toBeGreaterThan(0);
        expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(1);
        expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Key).toBe(
            'archives/2026-W15.tar.gz',
        );
    });

    it('tar 打包失敗 → ok=false, error 含原因', async () => {
        // baseDir 指向一個不存在的路徑，tar 來源不存在 → tar 會失敗
        const invalidBase = path.join(tmpBaseDir, 'does-not-exist-nested');
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await runWeeklyArchive(client, {
            baseDir: invalidBase,
            tmpDir: tmpWorkDir,
            now: new Date(Date.UTC(2026, 3, 12)),
        });

        expect(result.ok).toBe(false);
        expect(result.error).not.toBeNull();
        // 沒有上傳（tar 失敗就不該走到 upload）
        expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(0);
    });

    it('上傳失敗 → ok=false, error 含原因', async () => {
        s3Mock.on(PutObjectCommand).rejects(new Error('S3 upload rejected'));

        const result = await runWeeklyArchive(client, {
            baseDir: tmpBaseDir,
            tmpDir: tmpWorkDir,
            now: new Date(Date.UTC(2026, 3, 12)),
        });

        expect(result.ok).toBe(false);
        expect(result.error).not.toBeNull();
        expect(result.error).toContain('S3 upload rejected');
    });

    it('完成後 /tmp 暫存檔被刪除（成功 case）', async () => {
        s3Mock.on(PutObjectCommand).resolves({});

        const fixedNow = new Date(Date.UTC(2026, 3, 12));
        await runWeeklyArchive(client, {
            baseDir: tmpBaseDir,
            tmpDir: tmpWorkDir,
            now: fixedNow,
        });

        // 預期的 tmp 檔路徑
        const expectedTmpPath = path.join(tmpWorkDir, '2026-W15.tar.gz');
        expect(await exists(expectedTmpPath)).toBe(false);
    });

    it('完成後 /tmp 暫存檔被刪除（失敗 case，finally 區塊）', async () => {
        s3Mock.on(PutObjectCommand).rejects(new Error('upload fail'));

        const fixedNow = new Date(Date.UTC(2026, 3, 12));
        await runWeeklyArchive(client, {
            baseDir: tmpBaseDir,
            tmpDir: tmpWorkDir,
            now: fixedNow,
        });

        // 即使上傳失敗，tmp 檔也應被清理
        const expectedTmpPath = path.join(tmpWorkDir, '2026-W15.tar.gz');
        expect(await exists(expectedTmpPath)).toBe(false);
    });
});
