import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Storage config module tests (i-unify-storage Stage 2).
 *
 * 注意：`STORAGE_ROOT` 與 `STORAGE_PATHS` 是 module-level const，於 require 時
 * 凍結。因此 env var 相關測試必須用 `jest.isolateModules` + 修改 process.env
 * 再重新 require，取得帶有新 env 的新 module instance。
 */

describe('src/config/storage', () => {
    const ORIGINAL_ENV = process.env.STORAGE_ROOT;

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
            delete process.env.STORAGE_ROOT;
        } else {
            process.env.STORAGE_ROOT = ORIGINAL_ENV;
        }
    });

    test('STORAGE_ROOT 未設時 fallback 到 "./storage"', () => {
        delete process.env.STORAGE_ROOT;
        jest.isolateModules(() => {
            const mod = require('../../src/config/storage');
            expect(mod.STORAGE_ROOT).toBe('./storage');
            expect(mod.STORAGE_PATHS.shadow).toBe('./storage/shadow');
        });
    });

    test('STORAGE_ROOT=/custom/path 時 STORAGE_PATHS.shadow === "/custom/path/shadow"', () => {
        process.env.STORAGE_ROOT = '/custom/path';
        jest.isolateModules(() => {
            const mod = require('../../src/config/storage');
            expect(mod.STORAGE_ROOT).toBe('/custom/path');
            expect(mod.STORAGE_PATHS.shadow).toBe('/custom/path/shadow');
            expect(mod.STORAGE_PATHS.shadowAnalysis).toBe('/custom/path/shadow/analysis');
            expect(mod.STORAGE_PATHS.backtestResults).toBe('/custom/path/backtest-results');
            expect(mod.STORAGE_PATHS.ohlcv).toBe('/custom/path/ohlcv');
            expect(mod.STORAGE_PATHS.diagnostics).toBe('/custom/path/diagnostics');
            expect(mod.STORAGE_PATHS.debug).toBe('/custom/path/debug');
            expect(mod.STORAGE_PATHS.positions).toBe('/custom/path/positions');
            expect(mod.STORAGE_PATHS.bot).toBe('/custom/path/bot');
        });
    });

    test('STORAGE_PATHS 共 8 個 entries（7 個領域 + shadowAnalysis 捷徑）', () => {
        jest.isolateModules(() => {
            const { STORAGE_PATHS } = require('../../src/config/storage');
            const keys = Object.keys(STORAGE_PATHS);
            expect(keys).toEqual(
                expect.arrayContaining([
                    'shadow',
                    'shadowAnalysis',
                    'backtestResults',
                    'ohlcv',
                    'diagnostics',
                    'debug',
                    'positions',
                    'bot',
                ]),
            );
            expect(keys.length).toBe(8);
        });
    });

    test('storageSubpath("shadow", "foo.jsonl") 產生正確 path', () => {
        process.env.STORAGE_ROOT = '/tmp/storage-test';
        jest.isolateModules(() => {
            const { storageSubpath } = require('../../src/config/storage');
            expect(storageSubpath('shadow', 'foo.jsonl')).toBe(
                path.join('/tmp/storage-test', 'shadow', 'foo.jsonl'),
            );
        });
    });

    test('storageSubpath 支援多層子路徑', () => {
        process.env.STORAGE_ROOT = '/tmp/storage-test';
        jest.isolateModules(() => {
            const { storageSubpath } = require('../../src/config/storage');
            expect(storageSubpath('backtestResults', '2026-04-11', 'summary.md')).toBe(
                path.join('/tmp/storage-test', 'backtest-results', '2026-04-11', 'summary.md'),
            );
        });
    });

    describe('ensureStorageDir', () => {
        let tmpRoot: string;

        beforeEach(() => {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
            process.env.STORAGE_ROOT = tmpRoot;
        });

        afterEach(() => {
            if (fs.existsSync(tmpRoot)) {
                fs.rmSync(tmpRoot, { recursive: true, force: true });
            }
        });

        test('冪等 — 連續呼叫兩次不 throw', () => {
            jest.isolateModules(() => {
                const { ensureStorageDir } = require('../../src/config/storage');
                expect(() => ensureStorageDir('shadow')).not.toThrow();
                expect(() => ensureStorageDir('shadow')).not.toThrow();
                expect(fs.existsSync(path.join(tmpRoot, 'shadow'))).toBe(true);
            });
        });

        test('建立中間層目錄（shadowAnalysis 會連同 shadow/ 一起建）', () => {
            jest.isolateModules(() => {
                const { ensureStorageDir } = require('../../src/config/storage');
                ensureStorageDir('shadowAnalysis');
                expect(fs.existsSync(path.join(tmpRoot, 'shadow'))).toBe(true);
                expect(fs.existsSync(path.join(tmpRoot, 'shadow', 'analysis'))).toBe(true);
            });
        });

        test('所有 8 個領域皆可建立', () => {
            jest.isolateModules(() => {
                const { ensureStorageDir, STORAGE_PATHS } = require('../../src/config/storage');
                for (const domain of Object.keys(STORAGE_PATHS)) {
                    expect(() => ensureStorageDir(domain)).not.toThrow();
                    expect(fs.existsSync(STORAGE_PATHS[domain])).toBe(true);
                }
            });
        });
    });
});
