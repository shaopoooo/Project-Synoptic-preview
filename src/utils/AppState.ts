/**
 * AppState — single source of truth for the three shared mutable arrays.
 *
 * Replaces the module-level `let latestPools / activePositions / latestBBs`
 * vars in index.ts. All pipeline functions read and write through this object
 * so it's easy to reason about data ownership and to mock in tests.
 */
import { PoolStats, PositionRecord, BBResult, Dex, WalletPosition, WalletEntry, UserConfig, PoolConfig } from '../types';
import { config } from '../config';
import { isValidWalletAddress } from './validation';


// ─── UserConfig helper functions ─────────────────────────────────────────────

/** 所有合法 0x 錢包地址 */
export function ucWalletAddresses(cfg: UserConfig): string[] {
    return cfg.wallets
        .map(w => w.address)
        .filter(a => isValidWalletAddress(a));
}

/** 取得 tokenId 的初始本金（搜尋所有錢包） */
export function ucInitialInvestment(cfg: UserConfig, tokenId: string): number {
    for (const wallet of cfg.wallets) {
        const pos = wallet.positions.find(p => p.tokenId === tokenId);
        if (pos && pos.initial > 0) return pos.initial;
    }
    return 0;
}

/** 取得 tokenId 的 openTimestamp（搜尋所有錢包） */
export function ucGetOpenTimestamp(cfg: UserConfig, tokenId: string): number | undefined {
    for (const wallet of cfg.wallets) {
        const pos = wallet.positions.find(p => p.tokenId === tokenId);
        if (pos) return pos.openTimestamp;
    }
    return undefined;
}

/** 找出擁有 tokenId 的 wallet address（搜尋所有錢包） */
export function ucFindWallet(cfg: UserConfig, tokenId: string): string | undefined {
    for (const wallet of cfg.wallets) {
        if (wallet.positions.some(p => p.tokenId === tokenId)) return wallet.address;
    }
    return undefined;
}

/** 有效池清單：優先使用 userConfig.pools，fallback 至 config.POOLS。 */
export function ucPoolList(cfg: UserConfig): PoolConfig[] {
    return cfg.pools && cfg.pools.length > 0 ? cfg.pools : config.POOLS;
}

export type { PoolConfig };

/** 所有 externalStake=true 的倉位（手動追蹤的鎖倉 NFT） */
export function ucTrackedPositions(cfg: UserConfig): Array<{ tokenId: string; dexType: Dex; ownerWallet: string }> {
    const result: Array<{ tokenId: string; dexType: Dex; ownerWallet: string }> = [];
    for (const wallet of cfg.wallets) {
        for (const pos of wallet.positions) {
            if (pos.externalStake && !pos.closed) {
                result.push({ tokenId: pos.tokenId, dexType: pos.dexType, ownerWallet: wallet.address });
            }
        }
    }
    return result;
}

/**
 * 在指定 wallet 的 dex[] 中新增或更新 WalletPosition。
 * 若 walletAddress 不在 wallets 中，自動建立新 WalletEntry。
 */
export function ucUpsertPosition(
    cfg: UserConfig,
    walletAddress: string,
    tokenId: string,
    update: Partial<Omit<WalletPosition, 'tokenId'>>,
): UserConfig {
    const walletIdx = cfg.wallets.findIndex(
        w => w.address.toLowerCase() === walletAddress.toLowerCase()
    );

    if (walletIdx < 0) {
        // 新增 WalletEntry
        const newPos: WalletPosition = {
            tokenId,
            dexType: update.dexType ?? 'UniswapV3',
            initial: update.initial ?? 0,
            externalStake: update.externalStake ?? false,
            openTimestamp: update.openTimestamp,
        };
        return { wallets: [...cfg.wallets, { address: walletAddress, positions: [newPos] }] };
    }

    const wallet = cfg.wallets[walletIdx];
    const posIdx = wallet.positions.findIndex(p => p.tokenId === tokenId);

    let newPositions: WalletPosition[];
    if (posIdx < 0) {
        const newPos: WalletPosition = {
            tokenId,
            dexType: update.dexType ?? 'UniswapV3',
            initial: update.initial ?? 0,
            externalStake: update.externalStake ?? false,
            openTimestamp: update.openTimestamp,
        };
        newPositions =[...wallet.positions, newPos];
    } else {
        newPositions =wallet.positions.map((p, i) =>
            i === posIdx ? { ...p, ...update } : p
        );
    }

    const newWallets = cfg.wallets.map((w, i) =>
        i === walletIdx ? { ...w, positions: newPositions } : w
    );
    return { wallets: newWallets };
}

/** 從所有 wallet 中移除指定 tokenId 的 WalletPosition */
export function ucRemovePosition(cfg: UserConfig, tokenId: string): UserConfig {
    return {
        wallets: cfg.wallets.map(w => ({
            ...w,
            dex: w.positions.filter(p => p.tokenId !== tokenId),
        })),
    };
}

// ─── Env seed ─────────────────────────────────────────────────────────────────

function buildUserConfigFromEnv(): UserConfig {
    const wallets: WalletEntry[] = config.WALLET_ADDRESSES.map(address => ({
        address,
        positions: [],
    }));

    return { wallets };
}

// ─── AppState class ───────────────────────────────────────────────────────────

class AppState {
    pools: PoolStats[] = [];
    positions: PositionRecord[] = [];
    bbs: Record<string, BBResult> = {};

    /** Runtime-adjustable BB k values (default from config, overridable via /bbk) */
    bbKLowVol: number = config.BB_K_LOW_VOL;
    bbKHighVol: number = config.BB_K_HIGH_VOL;

    /**
     * User-configurable via Telegram; seeded from .env on first boot,
     * then persisted in state.json and managed dynamically.
     * Also replaces the separate openTimestamps / discoveredPositions records.
     */
    userConfig: UserConfig = buildUserConfigFromEnv();

    readonly lastUpdated = {
        poolScanner: 0,
        positionScanner: 0,
        bbEngine: 0,
        riskManager: 0,
    };

    /** Remove BB entries whose pools are no longer in activePositions. */
    pruneStaleBBs(): void {
        const active = new Set(this.positions.map(p => p.poolAddress.toLowerCase()));
        for (const k of Object.keys(this.bbs)) {
            if (!active.has(k)) delete this.bbs[k];
        }
    }
}

export const appState = new AppState();
