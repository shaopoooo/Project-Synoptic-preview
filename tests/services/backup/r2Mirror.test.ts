// RED 階段：r2Mirror.ts 12 個測試案例
// 對應 .claude/plans/i-r2-backup.md Test Plan 段落
// 本檔案應在 r2Mirror.ts 實作完成前寫好，全部失敗

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runMirrorSync,
  mirrorAnalysisToFlatPrefix,
} from '../../../src/services/backup/r2Mirror';

const s3Mock = mockClient(S3Client);
const client = new S3Client({ region: 'auto' });

/** 建立 jest tmp dir fixture，回傳路徑，測試結束自動清理 */
async function createTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r2mirror-test-'));
    return dir;
}

/** 遞迴建立目錄並寫入檔案 */
async function writeFixture(baseDir: string, relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
}

/** 測試用的 mock 選項：指向 tmp baseDir */
type MirrorTestOptions = {
    baseDir: string;
};

describe('runMirrorSync', () => {
    let tmpDir: string;

    beforeEach(async () => {
        s3Mock.reset();
        tmpDir = await createTmpDir();
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('本地有 3 檔、R2 全空 → 全部被上傳', async () => {
        // Arrange: 本地建立 3 個檔案
        await writeFixture(tmpDir, 'data/ohlcv/a.json', '{"a":1}');
        await writeFixture(tmpDir, 'data/diagnostics.jsonl', 'line1\n');
        await writeFixture(tmpDir, 'logs/combined.log', 'log content');

        // R2 list 回傳空
        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        // Act
        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        // Assert
        expect(result.ok).toBe(true);
        expect(result.uploadedCount).toBe(3);
        expect(result.failedCount).toBe(0);
        expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(3);
    });

    it('本地與 R2 完全一致（path + size）→ 不上傳任何檔案', async () => {
        await writeFixture(tmpDir, 'data/ohlcv/a.json', '{"a":1}');
        const sizeOfA = Buffer.byteLength('{"a":1}', 'utf8');

        s3Mock.on(ListObjectsV2Command).resolves({
            Contents: [{ Key: 'data/ohlcv/a.json', Size: sizeOfA }],
        });
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.ok).toBe(true);
        expect(result.uploadedCount).toBe(0);
        expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(0);
    });

    it('本地某檔 size 變大 → 該檔被重新上傳（reason=size_changed 意圖）', async () => {
        await writeFixture(tmpDir, 'data/diagnostics.jsonl', 'line1\nline2\nline3\n');
        const newSize = Buffer.byteLength('line1\nline2\nline3\n', 'utf8');

        // R2 上的舊 size 小於本地
        s3Mock.on(ListObjectsV2Command).resolves({
            Contents: [{ Key: 'data/diagnostics.jsonl', Size: newSize - 10 }],
        });
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.uploadedCount).toBe(1);
        const putCalls = s3Mock.commandCalls(PutObjectCommand);
        expect(putCalls.length).toBe(1);
        expect(putCalls[0].args[0].input.Key).toBe('data/diagnostics.jsonl');
    });

    it('R2 上有額外檔案不在本地 → 不刪、不報錯（只增不減）', async () => {
        await writeFixture(tmpDir, 'data/ohlcv/a.json', '{"a":1}');

        // R2 上除了本地有的檔，還有一個本地沒有的 obsolete 檔
        s3Mock.on(ListObjectsV2Command).resolves({
            Contents: [
                { Key: 'data/ohlcv/a.json', Size: Buffer.byteLength('{"a":1}', 'utf8') },
                { Key: 'data/ohlcv/obsolete.json', Size: 100 },
            ],
        });
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.ok).toBe(true);
        // 沒有刪除請求，只有零次上傳（都一致）
        expect(result.uploadedCount).toBe(0);
        // 也不應該 throw 或 report error
        expect(result.failedCount).toBe(0);
    });

    it('本地巢狀目錄 → r2Key 路徑保持完全相同', async () => {
        await writeFixture(tmpDir, 'data/ohlcv/0x22aee3699b6a0fed.json', '{}');
        await writeFixture(tmpDir, 'logs/combined.log', '');

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        const putCalls = s3Mock.commandCalls(PutObjectCommand);
        const keys = putCalls.map((c) => c.args[0].input.Key).sort();
        expect(keys).toContain('data/ohlcv/0x22aee3699b6a0fed.json');
        expect(keys).toContain('logs/combined.log');
    });

    it('上傳 5 檔 → PutObjectCommand 被呼叫 5 次', async () => {
        for (let i = 0; i < 5; i++) {
            await writeFixture(tmpDir, `data/file${i}.json`, `{"i":${i}}`);
        }

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(s3Mock.commandCalls(PutObjectCommand).length).toBe(5);
    });

    it('concurrency limit 5 → 同時 inflight 不超過 5', async () => {
        // 建立 12 個檔案，足以讓多數卡在 semaphore 上
        for (let i = 0; i < 12; i++) {
            await writeFixture(tmpDir, `data/file${i}.json`, `{"i":${i}}`);
        }

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

        let inflight = 0;
        let maxInflight = 0;
        s3Mock.on(PutObjectCommand).callsFake(async () => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            // 模擬 async 上傳，讓 concurrency 展開
            await new Promise((r) => setTimeout(r, 20));
            inflight--;
            return {};
        });

        await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(maxInflight).toBeGreaterThan(0);
        expect(maxInflight).toBeLessThanOrEqual(5);
    });

    it('單檔上傳失敗 → errors 含該檔，其他檔繼續', async () => {
        await writeFixture(tmpDir, 'data/good1.json', '1');
        await writeFixture(tmpDir, 'data/bad.json', '2');
        await writeFixture(tmpDir, 'data/good2.json', '3');

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

        // 讓 bad.json 的上傳失敗，其他成功
        s3Mock.on(PutObjectCommand).callsFake(async (input) => {
            if (input.Key === 'data/bad.json') {
                throw new Error('network error');
            }
            return {};
        });

        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.ok).toBe(false);
        expect(result.failedCount).toBe(1);
        expect(result.uploadedCount).toBe(2);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].path).toContain('bad.json');
        expect(result.errors[0].message).toContain('network error');
    });

    it('整批上傳完成 → ok === (errors.length === 0)', async () => {
        await writeFixture(tmpDir, 'data/a.json', '1');
        await writeFixture(tmpDir, 'data/b.json', '2');

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.errors.length).toBe(0);
        expect(result.ok).toBe(true);
    });

    it('本地 data/ 目錄不存在 → 不 throw，回傳 ok=true, uploadedCount=0', async () => {
        // 只建 logs/，沒有 data/
        await writeFixture(tmpDir, 'logs/only.log', 'x');

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await runMirrorSync(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.ok).toBe(true);
        // logs/only.log 會被上傳，但 data/ 不存在不應導致 throw
        expect(result.uploadedCount).toBe(1);
    });
});

describe('mirrorAnalysisToFlatPrefix (Decision #15)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        s3Mock.reset();
        tmpDir = await createTmpDir();
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('data/backtest-results/<date>/summary.md → analysis/backtest-<date>-summary.md', async () => {
        await writeFixture(
            tmpDir,
            'data/backtest-results/2026-04-12/summary.md',
            '# summary\n',
        );

        s3Mock.on(PutObjectCommand).resolves({});

        const result = await mirrorAnalysisToFlatPrefix(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.ok).toBe(true);
        expect(result.flattenedFiles.length).toBe(1);
        expect(result.flattenedFiles[0].r2Key).toBe('analysis/backtest-2026-04-12-summary.md');
        expect(result.flattenedFiles[0].source).toContain('data/backtest-results/2026-04-12/summary.md');

        const putCalls = s3Mock.commandCalls(PutObjectCommand);
        expect(putCalls.length).toBe(1);
        expect(putCalls[0].args[0].input.Key).toBe('analysis/backtest-2026-04-12-summary.md');
    });

    it('data/shadow/analysis/<weekIso>.md → analysis/shadow-<weekIso>.md', async () => {
        await writeFixture(
            tmpDir,
            'data/shadow/analysis/2026-W15.md',
            '# weekly\n',
        );

        s3Mock.on(PutObjectCommand).resolves({});

        const result = await mirrorAnalysisToFlatPrefix(client, { baseDir: tmpDir } as MirrorTestOptions);

        expect(result.ok).toBe(true);
        expect(result.flattenedFiles.length).toBe(1);
        expect(result.flattenedFiles[0].r2Key).toBe('analysis/shadow-2026-W15.md');

        const putCalls = s3Mock.commandCalls(PutObjectCommand);
        expect(putCalls.length).toBe(1);
        expect(putCalls[0].args[0].input.Key).toBe('analysis/shadow-2026-W15.md');
    });
});
