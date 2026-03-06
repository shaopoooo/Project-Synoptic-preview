/**
 * stateManager.ts — 跨重啟狀態持久化
 * 將各模組的 in-memory 快取序列化至 data/state.json，
 * 下次啟動時自動從檔案恢復，避免 cold-start 重新爬蟲。
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { createServiceLogger } from './logger';
import { bbVolCache, poolVolCache, snapshotCache, restoreCache, BBVolEntry, PoolVolEntry } from './cache';

const log = createServiceLogger('State');
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');

export interface DiscoveredPosition {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    ownerWallet: string;
}

export interface PersistedState {
    volCacheBB:   Record<string, BBVolEntry>;
    volCachePool: Record<string, PoolVolEntry>;
    priceBuffer:  Record<string, Record<string, number>>;  // poolAddr → hourTs → price
    openTimestamps: Record<string, number>;                 // `${tokenId}_${dex}` → ms
    sortBy: string;
    // 已探索的倉位清單（跳過 syncFromChain）
    discoveredPositions?: DiscoveredPosition[];
    syncedWallets?: string[];   // 當時掃描的 wallet 列表，用於判斷配置是否變更
}

export async function loadState(): Promise<PersistedState | null> {
    try {
        if (!(await fs.pathExists(STATE_FILE))) return null;
        const raw = await fs.readJson(STATE_FILE) as PersistedState;
        const bbKeys   = Object.keys(raw.volCacheBB   ?? {}).length;
        const poolKeys = Object.keys(raw.volCachePool ?? {}).length;
        const tsKeys   = Object.keys(raw.openTimestamps ?? {}).length;
        log.info(`💾 state loaded — BB vols: ${bbKeys}, pool vols: ${poolKeys}, timestamps: ${tsKeys}`);
        return raw;
    } catch (e: any) {
        log.warn(`state load failed: ${e.message}`);
        return null;
    }
}

export async function saveState(
    priceBuffer: Record<string, Record<string, number>>,
    openTimestamps: Record<string, number>,
    sortBy: string,
    discoveredPositions?: DiscoveredPosition[],
    syncedWallets?: string[],
): Promise<void> {
    try {
        await fs.ensureDir(path.dirname(STATE_FILE));
        const state: PersistedState = {
            volCacheBB:   snapshotCache(bbVolCache),
            volCachePool: snapshotCache(poolVolCache),
            priceBuffer,
            openTimestamps,
            sortBy,
            discoveredPositions,
            syncedWallets,
        };
        await fs.writeJson(STATE_FILE, state, { spaces: 2 });
    } catch (e: any) {
        log.warn(`state save failed: ${e.message}`);
    }
}

export function restoreState(state: PersistedState) {
    restoreCache(bbVolCache,   state.volCacheBB   ?? {});
    restoreCache(poolVolCache, state.volCachePool ?? {});
}
