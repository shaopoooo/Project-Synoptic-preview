import { ethers } from 'ethers';
import { config } from '../config';
import { appState, ucWalletAddresses, ucGetOpenTimestamp, ucUpsertPosition, ucFindWallet } from '../utils/AppState';
import { buildLogPositionBlock, buildLogSnapshotHeader } from '../utils/formatter';
import { BBResult, RawChainPosition, Dex, PositionRecord } from '../types';
import { createServiceLogger } from '../utils/logger';
import { rpcRetry, nextProvider } from '../utils/rpcProvider';
import { TOKEN_DECIMALS } from '../utils/tokenInfo';
import path from 'path';
import fs from 'fs-extra';
import { NpmContractReader } from './NpmContractReader';
import { StakeDiscovery } from './StakeDiscovery';
import { TimestampFiller } from './TimestampFiller';


const log = createServiceLogger('PositionScanner');

export class PositionScanner {

    /** In-memory position store */
    private positions: PositionRecord[] = [];
    private syncedWallets = new Set<string>();
    /** 已確認關閉（liquidity=0）的 tokenId，O(1) 查詢用 */
    closedTokenIds = new Set<string>();

    private chainFetcher = new NpmContractReader();
    private stakeDiscovery = new StakeDiscovery();
    private timestampFiller = new TimestampFiller();

    /**
     * 從 appState.userConfig 恢復已知倉位（跳過 chain scan）。
     */
    restoreDiscoveredPositions() {
        const wallets = ucWalletAddresses(appState.userConfig);
        const allPositions: PositionRecord[] = [];

        for (const wallet of appState.userConfig.wallets) {
            for (const wp of wallet.positions) {
                if (wp.closed) continue;
                allPositions.push(this._makeSeedPosition(wp.tokenId, wp.dexType, wallet.address, wp.openTimestamp));
            }
        }

        this.positions = allPositions;
        wallets.forEach(w => this.syncedWallets.add(w));
        log.info(`✅ positions restored from state: ${allPositions.length} position(s), chain sync skipped`);
    }

    /** 從 appState.userConfig 恢復已關閉的 tokenId 到 in-memory Set。 */
    restoreFromUserConfig() {
        for (const wallet of appState.userConfig.wallets)
            for (const pos of wallet.positions)
                if (pos.closed) this.closedTokenIds.add(pos.tokenId);
        if (this.closedTokenIds.size > 0)
            log.info(`💾 closed positions restored: ${[...this.closedTokenIds].join(', ')}`);
    }

    /** 建立空的 seed PositionRecord（等待下一輪 fetchAll 填充鏈上資料） */
    private _makeSeedPosition(
        tokenId: string, dex: Dex, ownerWallet: string, openTimestampMs?: number
    ): PositionRecord {
        return {
            tokenId, dex,
            poolAddress: '', feeTier: 0,
            token0Symbol: '', token1Symbol: '',
            ownerWallet,
            liquidity: '0',
            tickLower: 0, tickUpper: 0,
            minPrice: '0', maxPrice: '0',
            currentTick: 0, currentPriceStr: '0',
            positionValueUSD: 0,
            amount0: 0, amount1: 0,
            unclaimed0: '0', unclaimed1: '0', unclaimed2: '0',
            unclaimedFeesUSD: 0, fees0USD: 0, fees1USD: 0, fees2USD: 0,
            token2Symbol: '', isStaked: false,
            overlapPercent: 0, ilUSD: null, breakevenDays: 0, healthScore: 0,
            regime: '資料累積中', lastUpdated: 0,
            openTimestampMs,
            volSource: 'pending', priceSource: 'pending', bbFallback: false,
        };
    }

    async syncFromChain(_skipTimestampScan = false) {
        const walletAddresses = ucWalletAddresses(appState.userConfig);
        if (walletAddresses.length === 0) {
            log.info('no wallets configured, skipping chain sync');
            return;
        }

        const { discovered, syncedWallets } = await this.chainFetcher.discoverFromChain(
            walletAddresses, this.closedTokenIds
        );

        syncedWallets.forEach(w => this.syncedWallets.add(w));
        this.positions = discovered.map(d =>
            this._makeSeedPosition(d.tokenId, d.dex, d.ownerWallet,
                ucGetOpenTimestamp(appState.userConfig, d.tokenId))
        );

        log.info(`✅ chain sync done: ${this.positions.length} position(s) loaded`);
    }

    async scanStakedPositions(): Promise<void> {
        const walletAddresses = ucWalletAddresses(appState.userConfig);
        if (walletAddresses.length === 0) return;
        await this.stakeDiscovery.scan(walletAddresses, this.closedTokenIds);
    }

    /** Returns the current in-memory tracked positions. */
    getTrackedPositions(): PositionRecord[] {
        return this.positions;
    }

    /**
     * Fetch raw NPM chain data for all tracked positions.
     * Handles unsynced wallet detection and returns RawChainPosition[].
     * Called by index.ts; results are passed to PositionAggregator.aggregateAll().
     */
    async fetchAll(): Promise<RawChainPosition[]> {
        const unsyncedWallets = ucWalletAddresses(appState.userConfig).filter(w => !this.syncedWallets.has(w));
        if (unsyncedWallets.length > 0) {
            log.info(`🔄 ${unsyncedWallets.length} new wallet(s) detected, re-syncing chain`);
            await this.syncFromChain();
        }

        if (this.positions.length === 0) {
            log.info('no tracked positions, skipping fetch');
            return [];
        }

        const { rawPositions, burnedTokenIds } = await this.chainFetcher.fetchNpmData(
            this.positions, this.closedTokenIds
        );

        // Handle burned NFTs: clean up state
        for (const tokenId of burnedTokenIds) {
            this.closedTokenIds.add(tokenId);
            this.positions = this.positions.filter(p => p.tokenId !== tokenId);
            log.info(`#${tokenId} NFT burned — auto-closed, removed from tracking`);
        }

        return rawPositions;
    }

    /**
     * Update in-memory positions with newly assembled PositionRecords.
     * Positions missing from assembled (failed scan) keep their stale record.
     * Preserves ownerWallet when ownerOf returns a gauge contract.
     */
    updatePositions(assembled: PositionRecord[]) {
        const assembledMap = new Map(assembled.map(p => [p.tokenId, p]));
        const updated: PositionRecord[] = [];
        for (const prev of this.positions) {
            const fresh = assembledMap.get(prev.tokenId);
            if (!fresh) {
                log.warn(`#${prev.tokenId} not in assembled batch, keeping stale record`);
                updated.push(prev);
                continue;
            }
            if (Number(fresh.liquidity) === 0) {
                const ownerWallet = ucFindWallet(appState.userConfig, prev.tokenId) ?? prev.ownerWallet;
                const walletEntry = appState.userConfig.wallets.find(
                    w => w.address.toLowerCase() === ownerWallet.toLowerCase()
                );
                const isExternal = walletEntry?.positions.find(p => p.tokenId === prev.tokenId)?.externalStake ?? false;
                if (isExternal) {
                    // externalStake 倉位不自動關閉：可能是 RPC 返回過時區塊導致 liquidity=0
                    log.warn(`#${prev.tokenId} liquidity=0 but externalStake=true — keeping stale record (possible stale RPC data)`);
                    updated.push(prev);
                    continue;
                }
                this.closedTokenIds.add(prev.tokenId);
                appState.userConfig = ucUpsertPosition(appState.userConfig, ownerWallet, prev.tokenId, { closed: true });
                log.info(`#${prev.tokenId} liquidity=0 — marked closed, removed from tracking`);
                continue; // drop from positions, will not be scanned again
            }
            const isKnownWallet = ucWalletAddresses(appState.userConfig).some(
                w => w.toLowerCase() === fresh.ownerWallet.toLowerCase()
            );
            const ownerWallet = isKnownWallet ? fresh.ownerWallet : prev.ownerWallet;
            updated.push({
                ...prev,
                ...fresh,
                ownerWallet,
                openTimestampMs: fresh.openTimestampMs ?? prev.openTimestampMs,
                lastUpdated: Date.now(),
            });
        }
        this.positions = updated;
        log.info(`✅ ${assembled.length} position(s) refreshed`);
    }

    /**
     * Validate and execute an unstake request.
     * Returns a result object so TelegramBot only needs to format the message.
     *
     * Outcomes:
     *  'closed'       — liquidity=0, marked closed automatically
     *  'still_staked' — NFT still in Gauge, unstake blocked
     *  'ok'           — externalStake cleared, will be picked up by wallet scan
     *  'not_found'    — tokenId not in userConfig
     */
    async unstake(tokenId: string): Promise<
        | { status: 'closed' }
        | { status: 'still_staked'; owner: string }
        | { status: 'ok' }
        | { status: 'not_found' }
        | { status: 'chain_error'; error: string }
    > {
        const walletAddr = ucFindWallet(appState.userConfig, tokenId);
        if (!walletAddr) return { status: 'not_found' };

        const walletPos = appState.userConfig.wallets
            .flatMap(w => w.positions)
            .find(p => p.tokenId === tokenId);
        const dex = walletPos?.dexType ?? 'Aerodrome';
        const npmAddr = config.NPM_ADDRESSES[dex];

        if (npmAddr) {
            try {
                const npm = new ethers.Contract(npmAddr, config.NPM_ABI, nextProvider());
                const [posData, owner] = await Promise.all([
                    rpcRetry(() => npm.positions(tokenId), `positions(${tokenId})`),
                    rpcRetry(() => npm.ownerOf(tokenId), `ownerOf(${tokenId})`).catch(() => null),
                ]);

                if (Number(posData.liquidity) === 0) {
                    this.closedTokenIds.add(tokenId);
                    appState.userConfig = ucUpsertPosition(appState.userConfig, walletAddr, tokenId, { externalStake: false, closed: true });
                    this.positions = this.positions.filter(p => p.tokenId !== tokenId);
                    log.info(`#${tokenId} unstake: liquidity=0, marked closed`);
                    return { status: 'closed' };
                }

                const knownWallets = ucWalletAddresses(appState.userConfig).map(a => a.toLowerCase());
                if (owner && !knownWallets.includes(owner.toLowerCase())) {
                    log.warn(`#${tokenId} unstake blocked: NFT still in ${owner}`);
                    return { status: 'still_staked', owner };
                }
            } catch (e: any) {
                // NFT burned: Aerodrome reverts "ID", ERC721 reverts "nonexistent token"
                const msg: string = e.message ?? '';
                const isBurned = msg.includes('"ID"') || msg.includes('nonexistent token');
                if (isBurned) {
                    this.closedTokenIds.add(tokenId);
                    appState.userConfig = ucUpsertPosition(appState.userConfig, walletAddr, tokenId, { externalStake: false, closed: true });
                    this.positions = this.positions.filter(p => p.tokenId !== tokenId);
                    log.info(`#${tokenId} unstake: NFT burned, marked closed`);
                    return { status: 'closed' };
                }
                log.warn(`#${tokenId} unstake chain check failed: ${e.message}`);
                return { status: 'chain_error', error: e.message };
            }
        }

        appState.userConfig = ucUpsertPosition(appState.userConfig, walletAddr, tokenId, { externalStake: false });
        log.info(`#${tokenId} unstake: externalStake cleared`);
        return { status: 'ok' };
    }

    /**
     * Optional: Generate a text report of positions to a log file.
     * Call this at the end of the analysis pipeline.
     */
    async logSnapshots(positions: PositionRecord[], bb?: BBResult | null, kLow?: number, kHigh?: number) {
        if (positions.length === 0) return;
        const outputs = positions.map(pos => buildLogPositionBlock(pos, TOKEN_DECIMALS, bb));

        const header = buildLogSnapshotHeader(bb, kLow, kHigh);
        const logContent = header + '\n\n' + outputs.join('\n\n') + '\n\n';

        const logDir = path.join(__dirname, '../../logs');
        await fs.ensureDir(logDir);
        await fs.appendFile(path.join(logDir, 'positions.log'), logContent);
        log.info(`✅ positions.log written  ${positions.length} position(s)`);
    }

    async fillMissingTimestamps(saveStateCallback?: () => Promise<void>): Promise<void> {
        this.positions = await this.timestampFiller.fill(this.positions, saveStateCallback);
    }
}

/** 全域單例，供 index.ts / dryrun.ts 使用 */
export const positionScanner = new PositionScanner();
