/**
 * Storage path 集中管理（i-unify-storage Stage 2）。
 *
 * 單一事實來源：所有 persist 目錄都從 `STORAGE_PATHS` 取，**禁止**在其他檔案
 * hardcode `'data/...'` 或 `'/app/...'` 字串路徑。
 *
 * 領域子目錄採 P2 flat 結構，無 `data/` 或 `logs/` wrapper：
 *   `<STORAGE_ROOT>/{shadow,backtest-results,ohlcv,diagnostics,debug,positions,bot}`
 *
 * 本地 dev（未設 env）：`./storage/...`
 * Prod（Railway）：`STORAGE_ROOT=/app/storage` → `/app/storage/...`
 *
 * 詳見 `.claude/plans/i-unify-storage.md` D3 / D10 決策。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 儲存根目錄 — prod 為 `/app/storage`，本地 dev fallback 為 `./storage`。 */
export const STORAGE_ROOT: string = process.env.STORAGE_ROOT ?? './storage';

/**
 * 所有領域子目錄的絕對 / 相對路徑常數。
 *
 * - 所有 entries 皆為「目錄」，不放檔案路徑（避免 dir/file 語意混搭）。
 * - 檔名由消費者組合：`path.join(STORAGE_PATHS.diagnostics, 'diagnostics.jsonl')`。
 * - 若未來需要集中管理檔名常數，可新增 `STORAGE_FILES`，現階段不必要。
 */
export const STORAGE_PATHS = {
    shadow: `${STORAGE_ROOT}/shadow`,
    shadowAnalysis: `${STORAGE_ROOT}/shadow/analysis`,
    backtestResults: `${STORAGE_ROOT}/backtest-results`,
    ohlcv: `${STORAGE_ROOT}/ohlcv`,
    diagnostics: `${STORAGE_ROOT}/diagnostics`,
    debug: `${STORAGE_ROOT}/debug`,
    positions: `${STORAGE_ROOT}/positions`,
    bot: `${STORAGE_ROOT}/bot`,
} as const;

/** 領域 key 型別，避免誤傳 `'../evil'` 等非法 domain（compile-time 守護）。 */
export type StorageDomain = keyof typeof STORAGE_PATHS;

/**
 * 組合子路徑。
 * 使用 `path.join` 處理斜線正規化，避免 `foo//bar` 或跨平台反斜線問題。
 *
 * @example
 *   storageSubpath('shadow', 'foo.jsonl')
 *   // → './storage/shadow/foo.jsonl'
 *   storageSubpath('backtestResults', '2026-04-11', 'summary.md')
 *   // → './storage/backtest-results/2026-04-11/summary.md'
 */
export function storageSubpath(domain: StorageDomain, ...parts: string[]): string {
    return path.join(STORAGE_PATHS[domain], ...parts);
}

/**
 * 領域目錄初始化（消費者 service 在 init 時各自呼叫）。
 *
 * - 冪等：多次呼叫不 throw。
 * - `recursive: true` 會自動建立中間層目錄（例如 `shadowAnalysis` 會連同
 *   父目錄 `shadow/` 一起建）。
 * - 失敗時 throw，讓呼叫端決定 fallback / log 策略（符合
 *   `.claude/rules/logging-errors.md`：不在 util 層 swallow 錯誤）。
 *
 * 理由：entrypoint `chown -R` 之後不再 mkdir 領域骨架（i-unify-storage D9），
 * 建立責任下放到每個消費者避免「entrypoint shell 跟 STORAGE_PATHS 兩份真相」。
 */
export function ensureStorageDir(domain: StorageDomain): void {
    fs.mkdirSync(STORAGE_PATHS[domain], { recursive: true });
}
