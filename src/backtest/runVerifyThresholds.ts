#!/usr/bin/env ts-node
/**
 * backtest:verify-thresholds — 離線 threshold 驗證工具
 *
 * 執行流程：
 *   1. 讀取 OHLCV 檔案（from STORAGE_PATHS.ohlcv 或 OHLCV_DIR env override）
 *   2. extractFeatures → ReplayFeature[]
 *   3. temporalSplit → train / val / test 三段
 *   4. train 段跑 coarse grid search + fine grid → chosen thresholds
 *   5. val 段驗證 chosen thresholds 通過 absolute floor
 *   6. test 段最終 pass/fail
 *   7. sensitivity analysis（tvlMultiplier {0.5, 1.0, 2.0}）
 *   8. 寫 summary.md 到 STORAGE_PATHS.backtestResults/<date>/
 *
 * Usage:
 *   npm run backtest:verify-thresholds
 *   OHLCV_DIR=data/ohlcv npm run backtest:verify-thresholds  # override OHLCV path
 */

import * as fs from 'fs';
import * as path from 'path';
import { STORAGE_PATHS, ensureStorageDir } from '../infra/storage';
import { extractFeatures } from './v3lp/featureExtractor';
import { V3LpReplayDriver } from './v3lp/replayDriver';
import { runCoarseGrid, selectTopCandidates, runFineGrid } from './framework/gridSearcher';
import type { SweepResult } from './framework/gridSearcher';
import { runSensitivity } from './framework/sensitivityRunner';
import type { SensitivityResult } from './framework/sensitivityRunner';
import { aggregateOutcomes } from './framework/outcomeAggregator';
import type { AggregatedMetrics } from './framework/outcomeAggregator';
import { auditRegimeSignal } from './framework/regimeSignalAudit';
import type { RegimeAuditResult } from './framework/regimeSignalAudit';
import {
    TRAIN_START_TS, VAL_START_TS, TEST_START_TS, TEST_END_TS,
    COARSE_GRID, FINE_GRID_TOP_N,
} from './config';
import type { OhlcvStore } from '../market/HistoricalDataService';
import type { ReplayFeature } from '../types/replay';
import type { ThresholdSet } from '../types/replay';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('BacktestVerify');

// ─── Summary 建構參數 ──────────────────────────────────────────────────────

interface SummaryParams {
    chosenThreshold: ThresholdSet;
    trainMetrics: AggregatedMetrics;
    valMetrics: AggregatedMetrics;
    testMetrics: AggregatedMetrics;
    testPassed: boolean;
    valPassed: boolean;
    sensitivity: { results: SensitivityResult[]; isRobust: boolean };
    planHypothesis: ThresholdSet;
    hypothesisMetrics: AggregatedMetrics;
    coarseResultCount: number;
    fineResultCount: number;
    poolCount: number;
    featureCount: number;
    regimeAudit: RegimeAuditResult;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // 1. Load OHLCV files
    const ohlcvDir = process.env.OHLCV_DIR ?? STORAGE_PATHS.ohlcv;
    log.info(`載入 OHLCV 目錄: ${ohlcvDir}`);

    if (!fs.existsSync(ohlcvDir)) {
        log.error(`OHLCV 目錄不存在: ${ohlcvDir}。設定 OHLCV_DIR env var 指向實際路徑。`);
        process.exit(1);
    }

    const files = fs.readdirSync(ohlcvDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
        log.error(`OHLCV 目錄下無 .json 檔案: ${ohlcvDir}`);
        process.exit(1);
    }

    const stores: OhlcvStore[] = files.map(f => {
        const content = fs.readFileSync(path.join(ohlcvDir, f), 'utf-8');
        return JSON.parse(content) as OhlcvStore;
    });
    log.info(`載入 ${stores.length} 個 pool 的 OHLCV 資料`);

    // ── 輸出目錄（提前建立，供 features.jsonl 快取使用）────────────────────
    const date = new Date().toISOString().slice(0, 10);
    const outputDir = path.join(STORAGE_PATHS.backtestResults, date);
    ensureStorageDir('backtestResults');
    fs.mkdirSync(outputDir, { recursive: true });

    // 2. Feature extraction（含 features.jsonl 快取 — Plan Decision #10）
    const featuresPath = path.join(outputDir, 'features.jsonl');
    let allFeatures: ReplayFeature[];

    if (fs.existsSync(featuresPath) && !process.env.FORCE_EXTRACT) {
        log.info(`偵測到 features 快取: ${featuresPath}，跳過 Pass 1 extraction`);
        const lines = fs.readFileSync(featuresPath, 'utf-8').trim().split('\n');
        allFeatures = lines.map(l => JSON.parse(l) as ReplayFeature);
        log.info(`從快取載入 ${allFeatures.length} 筆 features`);
    } else {
        log.info('開始 Pass 1 feature extraction...');
        allFeatures = extractFeatures(stores);
        log.info(`產出 ${allFeatures.length} 筆 ReplayFeature`);

        // 寫入 features.jsonl 快取
        const featuresContent = allFeatures.map(f => JSON.stringify(f)).join('\n') + '\n';
        fs.writeFileSync(featuresPath, featuresContent, 'utf-8');
        log.info(`features.jsonl 快取寫入完成 (${allFeatures.length} 筆, ${(Buffer.byteLength(featuresContent) / 1024 / 1024).toFixed(1)} MB)`);
    }

    // 2.5 Regime signal 品質審計
    const regimeAudit = auditRegimeSignal(allFeatures);
    log.info(`Regime audit: trendVsRangeRatio=${regimeAudit.trendVsRangeRatio}, flipFlopRate=${regimeAudit.flipFlopRate}`);

    // 3. Temporal split by filtering features
    const trainFeatures = allFeatures.filter(f => f.ts >= TRAIN_START_TS && f.ts < VAL_START_TS);
    const valFeatures = allFeatures.filter(f => f.ts >= VAL_START_TS && f.ts < TEST_START_TS);
    const testFeatures = allFeatures.filter(f => f.ts >= TEST_START_TS && f.ts < TEST_END_TS);

    log.info(`Temporal split: train=${trainFeatures.length}, val=${valFeatures.length}, test=${testFeatures.length}`);

    if (trainFeatures.length === 0 || valFeatures.length === 0 || testFeatures.length === 0) {
        log.error('某段資料為空，可能 OHLCV 時間範圍不足。需要 2025-11-10 ~ 2026-04-10 的資料。');
        process.exit(1);
    }

    // 4. Train: coarse grid + fine grid
    log.info('=== Train phase: coarse grid (72 combos) ===');
    const trainDriver = new V3LpReplayDriver(trainFeatures);
    const coarseResults: SweepResult[] = runCoarseGrid(trainFeatures, trainDriver, COARSE_GRID);
    log.info(`Coarse grid 完成: ${coarseResults.length} 組結果`);

    const topCandidates = selectTopCandidates(coarseResults, FINE_GRID_TOP_N);
    log.info(`Top-${FINE_GRID_TOP_N} candidates (通過 absolute floor): ${topCandidates.length} 組`);

    if (topCandidates.length === 0) {
        log.error('粗 grid 無任何組合通過 absolute floor (A>0, D>0, C>=0.5)。');

        // ── Diagnostic dump：印出 72 組的 A/C/D 幫助診斷 ─────────────────
        log.info('=== Diagnostic: coarse grid 全 72 組 A/C/D dump ===');
        const sorted = [...coarseResults].sort((a, b) => b.metrics.weightedRaw - a.metrics.weightedRaw);
        // Top 10 (最接近通過的)
        log.info('--- Top 10 by weightedRaw ---');
        for (const r of sorted.slice(0, 10)) {
            const t = r.threshold;
            const m = r.metrics;
            const flags = [
                m.A > 0 ? '' : 'A≤0',
                m.D > 0 ? '' : 'D≤0',
                m.C >= 0.5 ? '' : 'C<0.5',
            ].filter(Boolean).join(', ');
            log.info(
                `  sharpeOpen=${t.sharpeOpen} sharpeClose=${t.sharpeClose} atr=${t.atrMultiplier}` +
                ` → A=${m.A.toFixed(6)} C=${m.C.toFixed(4)} D=${m.D.toFixed(2)} weighted=${m.weightedRaw.toFixed(4)}` +
                ` | FAIL: ${flags || '(none?)'}`,
            );
        }
        // Bottom 3 (最差的)
        log.info('--- Bottom 3 ---');
        for (const r of sorted.slice(-3)) {
            const t = r.threshold;
            const m = r.metrics;
            log.info(
                `  sharpeOpen=${t.sharpeOpen} sharpeClose=${t.sharpeClose} atr=${t.atrMultiplier}` +
                ` → A=${m.A.toFixed(6)} C=${m.C.toFixed(4)} D=${m.D.toFixed(2)}`,
            );
        }
        // Summary stats
        const allA = coarseResults.map(r => r.metrics.A);
        const allC = coarseResults.map(r => r.metrics.C);
        const allD = coarseResults.map(r => r.metrics.D);
        const zeroOutcome = coarseResults.filter(r => r.metrics.A === 0 && r.metrics.C === 0 && r.metrics.D === 0);
        log.info(`--- Aggregate ---`);
        log.info(`  A: min=${Math.min(...allA).toFixed(6)} max=${Math.max(...allA).toFixed(6)} avg=${(allA.reduce((s,v)=>s+v,0)/allA.length).toFixed(6)}`);
        log.info(`  C: min=${Math.min(...allC).toFixed(4)} max=${Math.max(...allC).toFixed(4)} avg=${(allC.reduce((s,v)=>s+v,0)/allC.length).toFixed(4)}`);
        log.info(`  D: min=${Math.min(...allD).toFixed(2)} max=${Math.max(...allD).toFixed(2)} avg=${(allD.reduce((s,v)=>s+v,0)/allD.length).toFixed(2)}`);
        log.info(`  全 0 結果 (A=0, C=0, D=0): ${zeroOutcome.length} / ${coarseResults.length}`);
        log.info(`  A>0 的組合數: ${allA.filter(a => a > 0).length}`);
        log.info(`  D>0 的組合數: ${allD.filter(d => d > 0).length}`);
        log.info(`  C>=0.5 的組合數: ${allC.filter(c => c >= 0.5).length}`);

        // ── Per-position outcome dump（取最佳組合的前 10 筆倉位） ──────────
        if (sorted.length > 0) {
            const bestThreshold = sorted[0].threshold;
            log.info(`--- Per-position dump (best combo: sharpeOpen=${bestThreshold.sharpeOpen} sharpeClose=${bestThreshold.sharpeClose} atr=${bestThreshold.atrMultiplier}) ---`);
            const bestDriver = new V3LpReplayDriver(trainFeatures);
            const bestOutcomes = bestDriver.run(bestThreshold, 'raw');
            log.info(`  Total positions opened: ${bestOutcomes.length}`);
            for (const o of bestOutcomes.slice(0, 10)) {
                const p = o.position;
                log.info(
                    `  [${p.poolId.slice(0, 8)}] open@cycle${p.openedAtCycle} close@cycle${p.closedAtCycle ?? '?'} reason=${p.closeReason ?? 'null'}` +
                    ` dur=${o.durationHours}h` +
                    ` | fees=$${o.feeIncome.toFixed(2)} IL=$${o.impermanentLoss.toFixed(2)} gas=$${o.gasCost.toFixed(2)}` +
                    ` | lpFinal=$${o.lpFinalValue.toFixed(2)} hodl=$${o.hodlFinalValue.toFixed(2)}` +
                    ` | A=${o.outperformancePct.toFixed(6)} C=${o.hitRate.toFixed(4)} D=${o.lpNetProfit.toFixed(2)}`,
                );
            }
            if (bestOutcomes.length > 10) {
                log.info(`  ... (${bestOutcomes.length - 10} more positions omitted)`);
            }
        }

        log.info('=== End diagnostic ===');

        writeSummaryAndExit(coarseResults.length, 0, stores.length, allFeatures.length);
        return;
    }

    log.info('=== Train phase: fine grid (neighborhood expansion) ===');
    const fineResults: SweepResult[] = runFineGrid(trainFeatures, trainDriver, topCandidates);
    log.info(`Fine grid 完成: ${fineResults.length} 組結果`);

    // Best from fine grid
    const bestFine = selectTopCandidates(fineResults, 1);
    if (bestFine.length === 0) {
        log.error('Fine grid 無任何組合通過 absolute floor。退回 Decisions review。');
        writeSummaryAndExit(coarseResults.length, fineResults.length, stores.length, allFeatures.length);
        return;
    }

    const chosenThreshold = bestFine[0];
    log.info(`Chosen threshold: sharpeOpen=${chosenThreshold.sharpeOpen}, sharpeClose=${chosenThreshold.sharpeClose}, atrMultiplier=${chosenThreshold.atrMultiplier}`);

    // 5. Validation: run chosen threshold on val set
    log.info('=== Validation phase ===');
    const valDriver = new V3LpReplayDriver(valFeatures);
    const valOutcomes = valDriver.run(chosenThreshold, 'full-state');
    const valMetrics = aggregateOutcomes(valOutcomes);

    if (!valMetrics.passesAbsoluteFloor) {
        log.error(`Validation 不通過 absolute floor: A=${valMetrics.A.toFixed(4)}, C=${valMetrics.C.toFixed(4)}, D=${valMetrics.D.toFixed(2)}`);
    } else {
        log.info(`Validation 通過: A=${valMetrics.A.toFixed(4)}, C=${valMetrics.C.toFixed(4)}, D=${valMetrics.D.toFixed(2)}`);
    }

    // 6. Test: final pass/fail
    log.info('=== Test phase ===');
    const testDriver = new V3LpReplayDriver(testFeatures);
    const testOutcomes = testDriver.run(chosenThreshold, 'full-state');
    const testMetrics = aggregateOutcomes(testOutcomes);

    const testPassed = testMetrics.passesAbsoluteFloor;
    if (testPassed) {
        log.info(`Test 通過: A=${testMetrics.A.toFixed(4)}, C=${testMetrics.C.toFixed(4)}, D=${testMetrics.D.toFixed(2)}`);
    } else {
        log.error(`Test 不通過: A=${testMetrics.A.toFixed(4)}, C=${testMetrics.C.toFixed(4)}, D=${testMetrics.D.toFixed(2)}`);
    }

    // 7. Sensitivity analysis
    log.info('=== Sensitivity analysis (tvlMultiplier: 0.5, 1.0, 2.0) ===');
    const trainDriverForSensitivity = new V3LpReplayDriver(trainFeatures);
    const sensitivity = runSensitivity(trainFeatures, trainDriverForSensitivity, COARSE_GRID);
    log.info(`Sensitivity robust: ${sensitivity.isRobust}`);

    // 8. Sanity benchmark: plan hypothesis (Sharpe 0.5, ATR 2x)
    const planHypothesis: ThresholdSet = { sharpeOpen: 0.5, sharpeClose: 0.3, atrMultiplier: 2.0 };
    const hypothesisOutcomes = testDriver.run(planHypothesis, 'full-state');
    const hypothesisMetrics = aggregateOutcomes(hypothesisOutcomes);

    // 9. Train metrics for chosen threshold（full-state mode）
    const trainOutcomes = trainDriver.run(chosenThreshold, 'full-state');
    const trainMetrics = aggregateOutcomes(trainOutcomes);

    // 10. Write summary.md
    const summaryPath = path.join(outputDir, 'summary.md');
    const summaryContent = buildSummaryMarkdown({
        chosenThreshold,
        trainMetrics,
        valMetrics,
        testMetrics,
        testPassed,
        valPassed: valMetrics.passesAbsoluteFloor,
        sensitivity,
        planHypothesis,
        hypothesisMetrics,
        coarseResultCount: coarseResults.length,
        fineResultCount: fineResults.length,
        poolCount: stores.length,
        featureCount: allFeatures.length,
        regimeAudit,
    });

    fs.writeFileSync(summaryPath, summaryContent, 'utf-8');
    log.info(`Summary 寫入: ${summaryPath}`);

    // Exit code based on test result
    if (!testPassed || !valMetrics.passesAbsoluteFloor) {
        log.error('FAIL — P0 不 ship，退回 Decisions review');
        process.exit(1);
    }

    log.info('PASS — chosen thresholds 可寫入 PR 5 config');
}

// ─── 快速失敗 summary（coarse/fine grid 找不到可行解時） ────────────────────

function writeSummaryAndExit(
    coarseCount: number,
    fineCount: number,
    poolCount: number,
    featureCount: number,
): void {
    const date = new Date().toISOString().slice(0, 10);
    const outputDir = path.join(STORAGE_PATHS.backtestResults, date);
    ensureStorageDir('backtestResults');
    fs.mkdirSync(outputDir, { recursive: true });

    const summaryPath = path.join(outputDir, 'summary.md');
    const content = [
        '# Backtest Threshold 驗證報告',
        '',
        `> 產出時間：${new Date().toISOString()}`,
        '',
        '## 結果：FAIL',
        '',
        'Grid search 未找到通過 absolute floor (A>0, D>0, C>=0.5) 的 threshold 組合。',
        '',
        '## 元資料',
        '',
        `| 項目 | 值 |`,
        `|------|-----|`,
        `| Pool 數量 | ${poolCount} |`,
        `| Feature 筆數 | ${featureCount} |`,
        `| Coarse grid 結果數 | ${coarseCount} |`,
        `| Fine grid 結果數 | ${fineCount} |`,
        '',
    ].join('\n');

    fs.writeFileSync(summaryPath, content, 'utf-8');
    log.info(`Summary 寫入: ${summaryPath}`);
    process.exit(1);
}

// ─── Summary markdown 產出 ─────────────────────────────────────────────────

function formatMetricsRow(label: string, m: AggregatedMetrics): string {
    const pass = m.passesAbsoluteFloor ? 'PASS' : 'FAIL';
    return `| ${label} | ${m.A.toFixed(4)} | ${m.C.toFixed(4)} | ${m.D.toFixed(2)} | ${m.weightedRaw.toFixed(4)} | ${pass} |`;
}

function buildSummaryMarkdown(params: SummaryParams): string {
    const {
        chosenThreshold: ct,
        trainMetrics, valMetrics, testMetrics,
        testPassed, valPassed,
        sensitivity,
        planHypothesis: ph,
        hypothesisMetrics,
        coarseResultCount, fineResultCount,
        poolCount, featureCount,
        regimeAudit: ra,
    } = params;

    const overallResult = testPassed && valPassed ? 'PASS' : 'FAIL';

    const lines: string[] = [
        '# Backtest Threshold 驗證報告',
        '',
        `> 產出時間：${new Date().toISOString()}`,
        '',
        `## 總結：${overallResult}`,
        '',
        '### 選出的 Threshold 組合',
        '',
        '| 參數 | 值 |',
        '|------|-----|',
        `| sharpeOpen | ${ct.sharpeOpen} |`,
        `| sharpeClose | ${ct.sharpeClose} |`,
        `| atrMultiplier | ${ct.atrMultiplier} |`,
        '',
        '### A / C / D 三指標（各階段）',
        '',
        '| 階段 | A (outperformance) | C (hit rate) | D (net profit) | weightedRaw | Floor |',
        '|------|-------------------|-------------|---------------|-------------|-------|',
        formatMetricsRow('Train', trainMetrics),
        formatMetricsRow('Validation', valMetrics),
        formatMetricsRow('Test', testMetrics),
        '',
        '### Plan Hypothesis 基準比較',
        '',
        `Plan 原始假設：sharpeOpen=${ph.sharpeOpen}, sharpeClose=${ph.sharpeClose}, atrMultiplier=${ph.atrMultiplier}`,
        '',
        '| 階段 | A (outperformance) | C (hit rate) | D (net profit) | weightedRaw | Floor |',
        '|------|-------------------|-------------|---------------|-------------|-------|',
        formatMetricsRow('Test (hypothesis)', hypothesisMetrics),
        '',
        '### Sensitivity 分析（TVL 乘數穩健性）',
        '',
        `穩健性判定：${sensitivity.isRobust ? 'ROBUST' : 'NOT ROBUST'}`,
        '',
        '| TVL 乘數 | Top Thresholds |',
        '|----------|---------------|',
        ...sensitivity.results.map(r => {
            const thresholds = r.topThresholds
                .map(t => `(${t.sharpeOpen}, ${t.sharpeClose}, ${t.atrMultiplier})`)
                .join(', ');
            return `| ${r.tvlMultiplier} | ${thresholds || '(none)' } |`;
        }),
        '',
        '### Regime Signal 品質審計',
        '',
        '| 指標 | 值 | 判讀 |',
        '|------|-----|------|',
        `| trendVsRangeRatio | ${ra.trendVsRangeRatio.toFixed(2)} | ${ra.trendVsRangeRatio > 2.0 ? '> 2.0 = 強 signal' : ra.trendVsRangeRatio >= 1.5 ? '1.5-2.0 = 可用' : '< 1.5 = 弱'} |`,
        `| flipFlopRate | ${ra.flipFlopRate.toFixed(3)} | ${ra.flipFlopRate < 0.2 ? '< 0.2 = 穩定' : ra.flipFlopRate > 0.5 ? '> 0.5 = 噪音' : '0.2-0.5 = 中等'} |`,
        `| avgTrendDuration | ${ra.avgTrendDurationHours.toFixed(1)}h | - |`,
        `| avgRangeDuration | ${ra.avgRangeDurationHours.toFixed(1)}h | - |`,
        `| trend 24h avg |price move| | ${ra.trendRegime.avgAbsMove24h.toFixed(2)}% | - |`,
        `| range 24h avg |price move| | ${ra.rangeRegime.avgAbsMove24h.toFixed(2)}% | - |`,
        `| range pctWithinAtr24h | ${(ra.rangeRegime.pctWithinAtr24h * 100).toFixed(1)}% | ${ra.rangeRegime.pctWithinAtr24h > 0.8 ? '> 80% = 好' : '< 80% = 待改善'} |`,
        '',
        '### 元資料',
        '',
        '| 項目 | 值 |',
        '|------|-----|',
        `| Pool 數量 | ${poolCount} |`,
        `| Feature 筆數 | ${featureCount} |`,
        `| Coarse grid 結果數 | ${coarseResultCount} |`,
        `| Fine grid 結果數 | ${fineResultCount} |`,
        `| Train window | 2025-11-10 ~ 2026-01-22 |`,
        `| Val window | 2026-01-22 ~ 2026-03-01 |`,
        `| Test window | 2026-03-01 ~ 2026-04-10 |`,
        '',
    ];

    return lines.join('\n');
}

main().catch(err => {
    log.error('Backtest verify failed:', err);
    process.exit(1);
});
