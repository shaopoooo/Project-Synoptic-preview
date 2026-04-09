/**
 * diagnosticStore.ts — Cycle 診斷數據的持久化與查詢
 *
 * JSONL append-only 儲存 + 記憶體環形緩衝（最近 N 筆供 Telegram cmd 查詢）。
 * 超過 10MB 自動 rotation。
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { createServiceLogger } from './logger';
import type { CycleDiagnostic } from '../types';

const log = createServiceLogger('DiagStore');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface BenchmarkStats {
    count: number;
    total:    { avg: number; p95: number; max: number };
    prefetch: { avg: number; p95: number; max: number };
    compute:  { avg: number; p95: number; max: number };
    mcEngine: { avg: number; p95: number; max: number };
    goRate: number;
    avgRecovered: number;
}

export class DiagnosticStore {
    private buffer: CycleDiagnostic[] = [];
    private readonly filePath: string;
    private readonly maxBuffer: number;

    constructor(filePath: string, maxBuffer = 48) {
        this.filePath = filePath;
        this.maxBuffer = maxBuffer;
    }

    async append(diag: CycleDiagnostic): Promise<void> {
        this.buffer.push(diag);
        if (this.buffer.length > this.maxBuffer) {
            this.buffer.shift();
        }

        try {
            await fs.ensureDir(path.dirname(this.filePath));

            try {
                const stat = await fs.stat(this.filePath);
                if (stat.size > MAX_FILE_SIZE_BYTES) {
                    const date = new Date().toISOString().slice(0, 10);
                    const rotated = this.filePath.replace('.jsonl', `.${date}.jsonl`);
                    await fs.rename(this.filePath, rotated);
                    log.info(`DiagStore: rotated to ${path.basename(rotated)}`);
                }
            } catch {
                // File doesn't exist, no rotation needed
            }

            await fs.appendFile(this.filePath, JSON.stringify(diag) + '\n');
        } catch (e) {
            log.error('DiagStore: append failed', e);
        }
    }

    getRecent(n?: number): CycleDiagnostic[] {
        if (n === undefined) return [...this.buffer];
        return this.buffer.slice(-n);
    }

    getBenchmarkStats(): BenchmarkStats {
        const data = this.buffer;
        const count = data.length;
        if (count === 0) {
            return {
                count: 0,
                total: { avg: 0, p95: 0, max: 0 },
                prefetch: { avg: 0, p95: 0, max: 0 },
                compute: { avg: 0, p95: 0, max: 0 },
                mcEngine: { avg: 0, p95: 0, max: 0 },
                goRate: 0,
                avgRecovered: 0,
            };
        }

        const percentile = (arr: number[], p: number) => {
            const sorted = [...arr].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length * p / 100)] ?? 0;
        };
        const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

        const totals = data.map(d => d.durationMs);
        const prefetches = data.map(d => d.phase.prefetchMs);
        const computes = data.map(d => d.phase.computeMs);
        const mcEngines = data.map(d => d.phase.mcEngineMs);

        const totalGoals = data.reduce((s, d) => s + d.summary.goPools, 0);
        const totalPools = data.reduce((s, d) => s + d.summary.totalPools, 0);
        const totalRecovered = data.reduce((s, d) => s + d.summary.newVersionRecoveredCount, 0);

        return {
            count,
            total:    { avg: avg(totals),    p95: percentile(totals, 95),    max: Math.max(...totals) },
            prefetch: { avg: avg(prefetches), p95: percentile(prefetches, 95), max: Math.max(...prefetches) },
            compute:  { avg: avg(computes),  p95: percentile(computes, 95),  max: Math.max(...computes) },
            mcEngine: { avg: avg(mcEngines), p95: percentile(mcEngines, 95), max: Math.max(...mcEngines) },
            goRate: totalPools > 0 ? totalGoals / totalPools : 0,
            avgRecovered: totalRecovered / count,
        };
    }
}
