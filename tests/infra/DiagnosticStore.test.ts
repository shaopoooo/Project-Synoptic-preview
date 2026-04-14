import * as fs from 'fs-extra';
import * as path from 'path';
import { DiagnosticStore } from '../../src/infra/diagnosticStore';
import type { CycleDiagnostic } from '../../src/types';

const TEST_DIR = path.join(__dirname, '../__fixtures__/diag-test');
const TEST_FILE = path.join(TEST_DIR, 'diagnostics.jsonl');

function makeDiag(cycleNumber: number): CycleDiagnostic {
    return {
        cycleNumber,
        timestamp: Date.now(),
        durationMs: 1000,
        phase: { prefetchMs: 500, computeMs: 100, mcEngineMs: 400 },
        pools: [],
        activeGenomeId: null,
        summary: { totalPools: 0, goPools: 0, oldVersionSkipCount: 0, newVersionRecoveredCount: 0 },
    };
}

describe('DiagnosticStore', () => {
    let store: DiagnosticStore;

    beforeEach(async () => {
        await fs.remove(TEST_DIR);
        await fs.ensureDir(TEST_DIR);
        store = new DiagnosticStore(TEST_FILE, 48);
    });

    afterAll(async () => {
        await fs.remove(TEST_DIR);
    });

    it('should append diagnostic to JSONL file', async () => {
        await store.append(makeDiag(1));
        await store.append(makeDiag(2));
        const lines = (await fs.readFile(TEST_FILE, 'utf-8')).trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).cycleNumber).toBe(1);
        expect(JSON.parse(lines[1]).cycleNumber).toBe(2);
    });

    it('should maintain memory buffer with max size', async () => {
        const smallStore = new DiagnosticStore(TEST_FILE, 3);
        for (let i = 1; i <= 5; i++) {
            await smallStore.append(makeDiag(i));
        }
        const recent = smallStore.getRecent();
        expect(recent).toHaveLength(3);
        expect(recent[0].cycleNumber).toBe(3);
        expect(recent[2].cycleNumber).toBe(5);
    });

    it('should return recent N entries', async () => {
        for (let i = 1; i <= 10; i++) {
            await store.append(makeDiag(i));
        }
        const last3 = store.getRecent(3);
        expect(last3).toHaveLength(3);
        expect(last3[0].cycleNumber).toBe(8);
    });

    it('should compute benchmark stats', async () => {
        for (let i = 1; i <= 10; i++) {
            await store.append({
                ...makeDiag(i),
                durationMs: i * 100,
                phase: { prefetchMs: i * 50, computeMs: i * 10, mcEngineMs: i * 40 },
            });
        }
        const stats = store.getBenchmarkStats();
        expect(stats.count).toBe(10);
        expect(stats.total.avg).toBeCloseTo(550, 0);
        expect(stats.prefetch.avg).toBeCloseTo(275, 0);
    });
});
