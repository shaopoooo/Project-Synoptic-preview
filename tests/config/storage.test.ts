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
            expect(mod.STORAGE_PATHS.shadowLp).toBe('./storage/shadow/lp');
            expect(mod.STORAGE_PATHS.history).toBe('./storage/history');
        });
    });

    test('STORAGE_ROOT=/custom/path 時 STORAGE_PATHS 各 entry 路徑正確', () => {
        process.env.STORAGE_ROOT = '/custom/path';
        jest.isolateModules(() => {
            const mod = require('../../src/config/storage');
            expect(mod.STORAGE_ROOT).toBe('/custom/path');
            expect(mod.STORAGE_PATHS.backtestResults).toBe('/custom/path/backtest-results');
            expect(mod.STORAGE_PATHS.ohlcv).toBe('/custom/path/ohlcv');
            expect(mod.STORAGE_PATHS.diagnostics).toBe('/custom/path/diagnostics');
            expect(mod.STORAGE_PATHS.debug).toBe('/custom/path/debug');
            expect(mod.STORAGE_PATHS.positions).toBe('/custom/path/positions');
            expect(mod.STORAGE_PATHS.bot).toBe('/custom/path/bot');
            expect(mod.STORAGE_PATHS.shadowLp).toBe('/custom/path/shadow/lp');
            expect(mod.STORAGE_PATHS.shadowLpAnalysis).toBe('/custom/path/shadow/lp/analysis');
            expect(mod.STORAGE_PATHS.history).toBe('/custom/path/history');
            expect(mod.STORAGE_PATHS.historyLp).toBe('/custom/path/history/lp');
        });
    });

    test('STORAGE_PATHS 共 10 個 entries（6 共享領域 + 2 shadow LP + 2 history）', () => {
        jest.isolateModules(() => {
            const mod = require('../../src/config/storage');
            const { STORAGE_PATHS } = mod;
            const keys = Object.keys(STORAGE_PATHS);
            expect(keys).toEqual(
                expect.arrayContaining([
                    'backtestResults',
                    'ohlcv',
                    'diagnostics',
                    'debug',
                    'positions',
                    'bot',
                    'shadowLp',
                    'shadowLpAnalysis',
                    'history',
                    'historyLp',
                ]),
            );
            expect(keys.length).toBe(10);
            // 已刪除 legacy entries — runtime assertion（compile-time check via
            // keyof typeof STORAGE_PATHS 由上述 10-entry exact list 覆蓋）
            expect('shadow' in STORAGE_PATHS).toBe(false);
            expect('shadowAnalysis' in STORAGE_PATHS).toBe(false);
        });
    });

    test('storageSubpath("shadowLp", "2026-04.jsonl") 產生正確 path', () => {
        process.env.STORAGE_ROOT = '/tmp/storage-test';
        jest.isolateModules(() => {
            const { storageSubpath } = require('../../src/config/storage');
            expect(storageSubpath('shadowLp', '2026-04.jsonl')).toBe(
                path.join('/tmp/storage-test', 'shadow', 'lp', '2026-04.jsonl'),
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

        test('冪等 — 連續呼叫兩次不 throw（shadowLp）', () => {
            jest.isolateModules(() => {
                const { ensureStorageDir } = require('../../src/config/storage');
                expect(() => ensureStorageDir('shadowLp')).not.toThrow();
                expect(() => ensureStorageDir('shadowLp')).not.toThrow();
                expect(fs.existsSync(path.join(tmpRoot, 'shadow'))).toBe(true);
                expect(fs.existsSync(path.join(tmpRoot, 'shadow', 'lp'))).toBe(true);
            });
        });

        test('建立中間層目錄（shadowLpAnalysis 會連同 shadow/ 與 shadow/lp/ 一起建）', () => {
            jest.isolateModules(() => {
                const { ensureStorageDir } = require('../../src/config/storage');
                ensureStorageDir('shadowLpAnalysis');
                expect(fs.existsSync(path.join(tmpRoot, 'shadow'))).toBe(true);
                expect(fs.existsSync(path.join(tmpRoot, 'shadow', 'lp'))).toBe(true);
                expect(fs.existsSync(path.join(tmpRoot, 'shadow', 'lp', 'analysis'))).toBe(true);
            });
        });

        test('建立 historyLp 會連同 history/ 一起建', () => {
            jest.isolateModules(() => {
                const { ensureStorageDir } = require('../../src/config/storage');
                ensureStorageDir('historyLp');
                expect(fs.existsSync(path.join(tmpRoot, 'history'))).toBe(true);
                expect(fs.existsSync(path.join(tmpRoot, 'history', 'lp'))).toBe(true);
            });
        });

        test('所有 10 個領域皆可建立', () => {
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
