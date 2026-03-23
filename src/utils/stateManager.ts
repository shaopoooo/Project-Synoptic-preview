/**
 * stateManager.ts — 跨重啟狀態持久化
 * 將各模組的 in-memory 快取序列化至 data/state.json，
 * 下次啟動時自動從檔案恢復，避免 cold-start 重新爬蟲。
 */
import * as fs from 'fs-extra';
import { rename } from 'fs/promises';
import * as path from 'path';
import { createServiceLogger } from './logger';
import { bbVolCache, poolVolCache, snapshotCache, restoreCache } from './cache';
import { Dex, UserConfig, WalletEntry, WalletPosition, SortBy, DiscoveredPosition, PersistedState } from '../types';
import { ucUpsertPosition } from './AppState';
import { config } from '../config';

const log = createServiceLogger('State');
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const TMP_FILE   = STATE_FILE + '.tmp';

const { DEX_MIGRATION } = config;

/**
 * 將舊版 state.json（有 openTimestamps / discoveredPositions）遷移至新版 UserConfig 格式。
 * 若 state 已為新格式（有 userConfig），直接返回。
 */
function migrateToUserConfig(raw: PersistedState): UserConfig | undefined {
    if (raw.userConfig) {
        // 若 userConfig 為舊版平坦格式（上一次重構留下的 walletAddresses/initialInvestments/trackedTokens）
        const oldCfg = raw.userConfig as any;
        if ('walletAddresses' in oldCfg) {
            log.info('userConfig: migrating from flat format → wallet-centric format');
            const wallets: WalletEntry[] = (oldCfg.walletAddresses as string[]).map((address: string) => ({
                address,
                positions: [] as WalletPosition[],
            }));
            const posMap: Record<string, Partial<WalletPosition>> = {};
            for (const [id, amt] of Object.entries(oldCfg.initialInvestments ?? {})) {
                posMap[id] = { ...posMap[id], initial: amt as number };
            }
            for (const [id, dexType] of Object.entries(oldCfg.trackedTokens ?? {})) {
                posMap[id] = { ...posMap[id], externalStake: true, dexType: dexType as Dex };
            }
            if (Object.keys(posMap).length > 0 && wallets.length > 0) {
                wallets[0].positions.push(...Object.entries(posMap).map(([tokenId, p]) => ({
                    tokenId,
                    dexType: p.dexType ?? 'UniswapV3' as Dex,
                    initial: p.initial ?? 0,
                    externalStake: p.externalStake ?? (p as any).tracked ?? false,
                })));
            }
            return { wallets };
        }
        return raw.userConfig;
    }

    // 完全沒有 userConfig — 從 discoveredPositions + openTimestamps 遷移
    if (!raw.discoveredPositions || raw.discoveredPositions.length === 0) return undefined;

    log.info('userConfig: migrating from discoveredPositions + openTimestamps → wallet-centric format');

    let cfg: UserConfig = { wallets: [] };

    // 先從 syncedWallets 建立空 WalletEntry
    for (const addr of raw.syncedWallets ?? []) {
        cfg = ucUpsertPosition(cfg, addr, '__placeholder__', { dexType: 'UniswapV3', initial: 0, externalStake: false });
        // 移除 placeholder
        cfg = {
            wallets: cfg.wallets.map(w =>
                w.address.toLowerCase() === addr.toLowerCase()
                    ? { ...w, positions: [] }
                    : w
            ),
        };
    }

    // 依 discoveredPositions 填入各 wallet 的 dex[]
    for (const dp of raw.discoveredPositions) {
        const migratedDex = (DEX_MIGRATION[dp.dex as string] ?? dp.dex) as Dex;
        const wallet = dp.ownerWallet === 'manual'
            ? (raw.syncedWallets?.[0] ?? 'manual')
            : dp.ownerWallet;
        const tsKey = `${dp.tokenId}_${dp.dex}`;
        const openTimestamp = raw.openTimestamps?.[tsKey];
        cfg = ucUpsertPosition(cfg, wallet, dp.tokenId, {
            dexType: migratedDex,
            initial: 0,
            externalStake: dp.ownerWallet === 'manual',
            openTimestamp,
        });
    }

    return cfg;
}

export async function loadState(): Promise<PersistedState | null> {
    try {
        if (!(await fs.pathExists(STATE_FILE))) return null;
        let raw: PersistedState;
        try {
            raw = await fs.readJson(STATE_FILE) as PersistedState;
        } catch (parseErr: any) {
            log.error(`state.json 解析失敗，略過載入: ${parseErr.message}`);
            return null;
        }
        if (typeof raw !== 'object' || raw === null) {
            log.error('state.json 格式錯誤（非物件），略過載入');
            return null;
        }

        const userConfig = migrateToUserConfig(raw);
        if (userConfig) {
            // 遷移舊版頂層欄位到 userConfig
            if (raw.sortBy && userConfig.sortBy === undefined)
                userConfig.sortBy = raw.sortBy as SortBy;
            if (raw.intervalMinutes && userConfig.intervalMinutes === undefined)
                userConfig.intervalMinutes = raw.intervalMinutes;
            if (raw.bbKLowVol !== undefined && userConfig.bbKLowVol === undefined)
                userConfig.bbKLowVol = raw.bbKLowVol;
            if (raw.bbKHighVol !== undefined && userConfig.bbKHighVol === undefined)
                userConfig.bbKHighVol = raw.bbKHighVol;
            // 舊版 closedTokenIds[] → 標記對應 WalletPosition.closed = true
            if (raw.closedTokenIds?.length) {
                const closedSet = new Set(raw.closedTokenIds);
                for (const wallet of userConfig.wallets) {
                    for (const pos of wallet.positions) {
                        if (closedSet.has(pos.tokenId)) pos.closed = true;
                    }
                }
            }
            raw.userConfig = userConfig;
        }

        const tsKeys = Object.keys(raw.openTimestamps ?? {}).length;
        const dpKeys = (raw.discoveredPositions ?? []).length;
        const wallets = raw.userConfig?.wallets.length ?? 0;
        const totalPositions = raw.userConfig?.wallets.reduce((s, w) => s + w.positions.length, 0) ?? 0;
        log.info(`💾 state loaded — wallets: ${wallets}, positions: ${totalPositions}${dpKeys > 0 ? ` (migrated ${dpKeys} discoveredPositions)` : ''}${tsKeys > 0 ? ` (migrated ${tsKeys} timestamps)` : ''}`);
        return raw;
    } catch (e: any) {
        log.warn(`state load failed: ${e.message}`);
        return null;
    }
}

export async function saveState(
    priceBuffer: Record<string, Record<string, number>>,
    bandwidthWindows?: Record<string, number[]>,
    userConfig?: UserConfig,
    stakeDiscoveryLastBlock?: Record<string, number>,
): Promise<void> {
    try {
        await fs.ensureDir(path.dirname(STATE_FILE));
        const state: PersistedState = {
            volCacheBB:   snapshotCache(bbVolCache),
            volCachePool: snapshotCache(poolVolCache),
            priceBuffer,
            bandwidthWindows,
            stakeDiscoveryLastBlock,
            userConfig,
        };
        // 原子寫入：先寫暫存檔，成功後 rename，避免 SIGINT 截斷導致 JSON 損毀
        await fs.writeJson(TMP_FILE, state, { spaces: 2 });
        await rename(TMP_FILE, STATE_FILE);
    } catch (e: any) {
        log.warn(`state save failed: ${e.message}`);
    }
}

export function restoreState(state: PersistedState) {
    restoreCache(bbVolCache,   state.volCacheBB   ?? {});
    restoreCache(poolVolCache, state.volCachePool ?? {});
}
