// RED 階段：r2Restore.ts 9 個測試案例
// 對應 .claude/plans/i-r2-backup.md Test Plan 段落

import {
    S3Client,
    GetObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { promises as fs, createReadStream } from 'fs';
import { Readable } from 'stream';
import * as path from 'path';
import * as os from 'os';
import * as tar from 'tar';
import {
    restoreMirror,
    restoreArchive,
    listArchives,
} from '../../../src/services/backup/r2Restore';

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

async function listDir(p: string): Promise<string[]> {
    try {
        return await fs.readdir(p);
    } catch {
        return [];
    }
}

/** 建立符合 AWS SDK v3 GetObjectCommand 回傳 shape 的 body stream */
function makeBody(content: string | Buffer) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    return sdkStreamMixin(Readable.from(buffer));
}

describe('restoreMirror', () => {
    let tmpBase: string;

    beforeEach(async () => {
        s3Mock.reset();
        tmpBase = await createTmpDir('r2restore-base-');
    });

    afterEach(async () => {
        // 清理 tmpBase 與可能留下的 safety backup 目錄
        const parent = path.dirname(tmpBase);
        const siblings = await fs.readdir(parent);
        for (const name of siblings) {
            if (name.startsWith(path.basename(tmpBase))) {
                await fs.rm(path.join(parent, name), { recursive: true, force: true });
            }
        }
    });

    it('既有 data/ 內容被搬入 data/.backup-<ts>/（in-mount safety backup）', async () => {
        // Arrange: 本地已有 data/ 與 logs/
        // 重要：Railway volume 是 mount point，safety backup 必須在 mount 內部
        await writeFixture(tmpBase, 'data/existing.json', 'old');
        await writeFixture(tmpBase, 'logs/old.log', 'old log');

        // R2 list：data/ 有 1 檔，logs/ 空
        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return { Contents: [{ Key: 'data/new.json', Size: 3 }] };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).callsFake(async () => ({ Body: makeBody('new') }));

        // Act
        const result = await restoreMirror(client, { baseDir: tmpBase });

        // Assert
        expect(result.ok).toBe(true);
        // safetyBackupPath 形如 <baseDir>/data/.backup-<ts>，位於原 data/ 內部
        expect(result.safetyBackupPath).toMatch(/[/\\]data[/\\]\.backup-\d+$/);
        expect(result.safetyBackupPath.startsWith(path.join(tmpBase, 'data'))).toBe(true);
        const safetyContents = await listDir(result.safetyBackupPath);
        expect(safetyContents).toContain('existing.json');
        // 原 data/ 目錄仍存在（mount point 未被 rename），並含新下載的檔案
        expect(await exists(path.join(tmpBase, 'data', 'new.json'))).toBe(true);
    });

    it('R2 上 5 檔被下載到本地 data/', async () => {
        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return {
                    Contents: [
                        { Key: 'data/a.json', Size: 1 },
                        { Key: 'data/b.json', Size: 1 },
                        { Key: 'data/c.json', Size: 1 },
                        { Key: 'data/d.json', Size: 1 },
                        { Key: 'data/e.json', Size: 1 },
                    ],
                };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).callsFake(async () => ({
            Body: makeBody('x'),
        }));

        const result = await restoreMirror(client, { baseDir: tmpBase });

        expect(result.ok).toBe(true);
        expect(result.restoredCount).toBe(5);
        const dataFiles = await listDir(path.join(tmpBase, 'data'));
        expect(dataFiles.sort()).toEqual(['a.json', 'b.json', 'c.json', 'd.json', 'e.json']);
    });

    it('下載失敗 → 自動 rollback（既有 data/ 還原）', async () => {
        await writeFixture(tmpBase, 'data/existing.json', 'valuable');

        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return { Contents: [{ Key: 'data/new.json', Size: 3 }] };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).rejects(new Error('network down'));

        const result = await restoreMirror(client, { baseDir: tmpBase });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('network down');
        // Rollback：既有 data/existing.json 應該回到原位
        const existingContent = await fs.readFile(
            path.join(tmpBase, 'data', 'existing.json'),
            'utf8',
        );
        expect(existingContent).toBe('valuable');
    });

    it('惡意 R2 key 含 ".." → 被跳過，不寫出 baseDir 外的檔案', async () => {
        // 威脅模型：R2 credentials 被盜 → 攻擊者上傳惡意 key 到 data/ prefix
        // 預期：restoreMirror 辨識 ".." segment，跳過該檔，其他合法檔照常下載，
        // 最終 result.ok=true（單檔跳過不視為整批失敗）。
        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return {
                    Contents: [
                        { Key: 'data/legit.json', Size: 4 },
                        { Key: 'data/../../../etc/pwned', Size: 4 },
                    ],
                };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).callsFake(async () => ({ Body: makeBody('evil') }));

        const result = await restoreMirror(client, { baseDir: tmpBase });

        expect(result.ok).toBe(true);
        // 合法檔有寫入
        expect(await exists(path.join(tmpBase, 'data', 'legit.json'))).toBe(true);
        // 惡意檔不應該出現在 baseDir 外
        const parent = path.dirname(tmpBase);
        expect(await exists(path.join(parent, 'etc', 'pwned'))).toBe(false);
        // restoredCount 只計合法檔
        expect(result.restoredCount).toBe(1);
    });

    it('R2 key 不屬於白名單 prefix → 被跳過', async () => {
        // 即便 listObjects Prefix='data/'，R2 字串比對可能回傳 'data-other/xxx'
        // 或 'dataX/...'。防守性地要求第一段必須是 RESTORE_PATHS 白名單之一。
        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return {
                    Contents: [
                        { Key: 'data/ok.json', Size: 2 },
                        { Key: 'other/evil.json', Size: 2 },
                    ],
                };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).callsFake(async () => ({ Body: makeBody('x') }));

        const result = await restoreMirror(client, { baseDir: tmpBase });

        expect(result.ok).toBe(true);
        expect(await exists(path.join(tmpBase, 'data', 'ok.json'))).toBe(true);
        expect(await exists(path.join(tmpBase, 'other', 'evil.json'))).toBe(false);
        expect(result.restoredCount).toBe(1);
    });

    it('directory marker key（data/ 或 data）被跳過不視為檔案', async () => {
        // 場景：CF R2 console UI 上傳時可能建立 zero-byte directory placeholder
        // key = 'data/' 或 'data'，舊版會嘗試 fs.writeFile('/app/data') → EISDIR
        // （因為 /app/data 本身是 mount point 目錄）
        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return {
                    Contents: [
                        { Key: 'data/', Size: 0 },              // trailing slash marker
                        { Key: 'data', Size: 0 },               // bare prefix, no slash
                        { Key: 'data/real.json', Size: 4 },     // 合法檔
                    ],
                };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).callsFake(async () => ({ Body: makeBody('real') }));

        const result = await restoreMirror(client, { baseDir: tmpBase });

        expect(result.ok).toBe(true);
        // 合法檔正常寫入
        expect(await exists(path.join(tmpBase, 'data', 'real.json'))).toBe(true);
        // restoredCount 只計合法檔（directory marker 兩個都被跳）
        expect(result.restoredCount).toBe(1);
    });

    it('成功後 data.backup-<ts>/ 留在原地（admin 手動清）', async () => {
        await writeFixture(tmpBase, 'data/old.json', 'legacy');

        s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
            if (input.Prefix === 'data/') {
                return { Contents: [{ Key: 'data/new.json', Size: 3 }] };
            }
            return { Contents: [] };
        });
        s3Mock.on(GetObjectCommand).callsFake(async () => ({ Body: makeBody('new') }));

        const result = await restoreMirror(client, { baseDir: tmpBase });

        expect(result.ok).toBe(true);
        // safety backup 目錄應該還在
        expect(await exists(result.safetyBackupPath)).toBe(true);
    });
});

describe('restoreArchive', () => {
    let tmpBase: string;
    let tmpWork: string;

    beforeEach(async () => {
        s3Mock.reset();
        tmpBase = await createTmpDir('r2restore-arch-base-');
        tmpWork = await createTmpDir('r2restore-arch-work-');
    });

    afterEach(async () => {
        const parent = path.dirname(tmpBase);
        const siblings = await fs.readdir(parent);
        for (const name of siblings) {
            if (name.startsWith(path.basename(tmpBase))) {
                await fs.rm(path.join(parent, name), { recursive: true, force: true });
            }
        }
        await fs.rm(tmpWork, { recursive: true, force: true });
    });

    /** 建立一份真實的 tar.gz fixture 供下載 mock 使用 */
    async function createFixtureTarball(contents: Record<string, string>): Promise<Buffer> {
        const sourceDir = await createTmpDir('r2restore-src-');
        try {
            for (const [relPath, content] of Object.entries(contents)) {
                await writeFixture(sourceDir, relPath, content);
            }
            const tarPath = path.join(tmpWork, `fixture-${Date.now()}.tar.gz`);
            await tar.c(
                { gzip: true, file: tarPath, cwd: sourceDir },
                Object.keys(contents).map((k) => k.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i),
            );
            return await fs.readFile(tarPath);
        } finally {
            await fs.rm(sourceDir, { recursive: true, force: true });
        }
    }

    it('不存在的 weekIso → throw descriptive error', async () => {
        // 模擬 GetObject 回傳 NoSuchKey
        const err = new Error('The specified key does not exist') as Error & { name: string };
        err.name = 'NoSuchKey';
        s3Mock.on(GetObjectCommand).rejects(err);

        const result = await restoreArchive(client, '2026-W99', {
            baseDir: tmpBase,
            tmpDir: tmpWork,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/2026-W99|not exist|NoSuchKey/i);
    });

    it('下載成功 → tar.x 解壓到本地，覆蓋 data/ 與 logs/', async () => {
        const tarball = await createFixtureTarball({
            'data/restored.json': '{"r":1}',
            'logs/restored.log': 'restored log',
        });

        s3Mock.on(GetObjectCommand).resolves({ Body: makeBody(tarball) });

        const result = await restoreArchive(client, '2026-W15', {
            baseDir: tmpBase,
            tmpDir: tmpWork,
        });

        expect(result.ok).toBe(true);
        const dataContent = await fs.readFile(
            path.join(tmpBase, 'data', 'restored.json'),
            'utf8',
        );
        expect(dataContent).toBe('{"r":1}');
        const logContent = await fs.readFile(
            path.join(tmpBase, 'logs', 'restored.log'),
            'utf8',
        );
        expect(logContent).toBe('restored log');
    });

    it('惡意 tar 含非白名單 entry → 跳過該 entry，不寫出 baseDir 外', async () => {
        // 威脅模型：攻擊者拿到 R2 write creds，上傳惡意 archives/<week>.tar.gz
        // tar 內容包含非白名單 prefix（例如 "other/"）
        // 預期：strict + filter 會拒絕該 entry，合法 data/ entry 照常解壓
        const evilSource = await createTmpDir('r2restore-evil-src-');
        try {
            await writeFixture(evilSource, 'data/legit.json', '{"ok":1}');
            await writeFixture(evilSource, 'other/evil.json', '{"pwn":1}');

            const tarPath = path.join(tmpWork, `evil-${Date.now()}.tar.gz`);
            await tar.c(
                { gzip: true, file: tarPath, cwd: evilSource },
                ['data', 'other'],
            );
            const tarball = await fs.readFile(tarPath);
            s3Mock.on(GetObjectCommand).resolves({ Body: makeBody(tarball) });

            const result = await restoreArchive(client, '2026-W15', {
                baseDir: tmpBase,
                tmpDir: tmpWork,
            });

            expect(result.ok).toBe(true);
            // 合法 entry 被解壓
            expect(
                await exists(path.join(tmpBase, 'data', 'legit.json')),
            ).toBe(true);
            // 非白名單 entry 被拒
            expect(
                await exists(path.join(tmpBase, 'other', 'evil.json')),
            ).toBe(false);
        } finally {
            await fs.rm(evilSource, { recursive: true, force: true });
        }
    });

    it('tar.x 失敗 → rollback 既有 data/', async () => {
        // 先建立原有 data/
        await writeFixture(tmpBase, 'data/original.json', 'keepme');

        // 回傳一個不是合法 tar.gz 的 body（會讓 tar.x 失敗）
        s3Mock.on(GetObjectCommand).resolves({ Body: makeBody('not a tar.gz') });

        const result = await restoreArchive(client, '2026-W15', {
            baseDir: tmpBase,
            tmpDir: tmpWork,
        });

        expect(result.ok).toBe(false);
        // Rollback：原檔還在
        const original = await fs.readFile(
            path.join(tmpBase, 'data', 'original.json'),
            'utf8',
        );
        expect(original).toBe('keepme');
    });
});

describe('listArchives', () => {
    beforeEach(() => {
        s3Mock.reset();
    });

    it('R2 上有 5 個 archive → 回傳 5 筆，依 lastModified 降序', async () => {
        const mkDate = (daysAgo: number) =>
            new Date(Date.now() - daysAgo * 86400 * 1000);

        s3Mock.on(ListObjectsV2Command).resolves({
            Contents: [
                { Key: 'archives/2026-W11.tar.gz', Size: 1000, LastModified: mkDate(28) },
                { Key: 'archives/2026-W15.tar.gz', Size: 2000, LastModified: mkDate(0) },
                { Key: 'archives/2026-W12.tar.gz', Size: 1100, LastModified: mkDate(21) },
                { Key: 'archives/2026-W14.tar.gz', Size: 1800, LastModified: mkDate(7) },
                { Key: 'archives/2026-W13.tar.gz', Size: 1500, LastModified: mkDate(14) },
            ],
        });

        const result = await listArchives(client);

        expect(result).toHaveLength(5);
        // 降序：最新的在前
        expect(result[0].weekIso).toBe('2026-W15');
        expect(result[1].weekIso).toBe('2026-W14');
        expect(result[2].weekIso).toBe('2026-W13');
        expect(result[3].weekIso).toBe('2026-W12');
        expect(result[4].weekIso).toBe('2026-W11');
        expect(result[0].r2Key).toBe('archives/2026-W15.tar.gz');
        expect(result[0].sizeBytes).toBe(2000);
    });

    it('R2 上 0 個 archive → 回傳空陣列，不 throw', async () => {
        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

        const result = await listArchives(client);

        expect(result).toEqual([]);
    });
});
