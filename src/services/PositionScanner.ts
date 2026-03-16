import { ethers } from 'ethers';
import { config } from '../config';
import { appState, ucWalletAddresses, ucTrackedPositions, ucGetOpenTimestamp, ucUpsertPosition, ucFindWallet } from '../utils/AppState';
import { buildLogPositionBlock, buildLogSnapshotHeader } from '../utils/formatter';
import { BBResult, RawChainPosition, Dex } from '../types';
import { createServiceLogger, positionLogger } from '../utils/logger';
import { rpcRetry, nextProvider } from '../utils/rpcProvider';
import { findMintTimestampMs } from './ChainEventScanner';
import { PositionRecord } from '../types';
import { TOKEN_DECIMALS } from '../utils/tokenInfo';
import path from 'path';
import fs from 'fs-extra';


const log = createServiceLogger('PositionScanner');

export class PositionScanner {

    /** In-memory position store */
    private static positions: PositionRecord[] = [];
    private static syncedWallets = new Set<string>();
    /** 已確認關閉（liquidity=0）的 tokenId，O(1) 查詢用 */
    private static closedTokenIds = new Set<string>();

    /**
     * 從 appState.userConfig 恢復已知倉位（跳過 chain scan）。
     */
    static restoreDiscoveredPositions() {
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
    static restoreFromUserConfig() {
        for (const wallet of appState.userConfig.wallets)
            for (const pos of wallet.positions)
                if (pos.closed) this.closedTokenIds.add(pos.tokenId);
        if (this.closedTokenIds.size > 0)
            log.info(`💾 closed positions restored: ${[...this.closedTokenIds].join(', ')}`);
    }

    /** 建立空的 seed PositionRecord（等待下一輪 fetchAll 填充鏈上資料） */
    private static _makeSeedPosition(
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
            unclaimed0: '0', unclaimed1: '0', unclaimed2: '0',
            unclaimedFeesUSD: 0, fees0USD: 0, fees1USD: 0, fees2USD: 0,
            token2Symbol: '', isStaked: false,
            overlapPercent: 0, ilUSD: null, breakevenDays: 0, healthScore: 0,
            regime: '資料累積中', lastUpdated: 0,
            openTimestampMs,
            volSource: 'pending', priceSource: 'pending', bbFallback: false,
        };
    }

    static async syncFromChain(skipTimestampScan = false) {
        const walletAddresses = ucWalletAddresses(appState.userConfig);
        if (walletAddresses.length === 0) {
            log.info('no wallets configured, skipping chain sync');
            return;
        }

        type Discovery = { tokenId: string; dex: Dex; ownerWallet: string };
        const dexes: Dex[] = ['UniswapV3', 'PancakeSwapV3', 'Aerodrome', 'UniswapV4'];
        const discovered: Discovery[] = [];

        for (const walletAddress of walletAddresses) {
            const wShort = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
            log.info(`⛓  sync  ${wShort}`);

            for (const dex of dexes) {
                try {
                    const npmAddress = config.NPM_ADDRESSES[dex];
                    if (!npmAddress) continue;

                    // V4 uses a separate ABI (getPoolAndPositionInfo instead of positions())
                    const abi = dex === 'UniswapV4' ? config.V4_NPM_ABI : config.NPM_ABI;
                    const npmContract = new ethers.Contract(npmAddress, abi, nextProvider());
                    const balance = await rpcRetry(
                        () => npmContract.balanceOf(walletAddress),
                        `${dex}.balanceOf`
                    );
                    log.info(`📍 ${dex}  ${balance} NFT(s) found  ${wShort}`);

                    for (let i = 0; i < Number(balance); i++) {
                        const tokenId = await rpcRetry(
                            () => npmContract.tokenOfOwnerByIndex(walletAddress, i),
                            `${dex}.tokenOfOwnerByIndex(${i})`
                        );
                        const tokenIdStr = tokenId.toString();
                        if (this.closedTokenIds.has(tokenIdStr)) {
                            log.info(`  → #${tokenIdStr} (skipped — closed)`);
                            continue;
                        }
                        log.info(`  → #${tokenIdStr}`);
                        discovered.push({ tokenId: tokenIdStr, dex, ownerWallet: walletAddress });
                    }
                } catch (error) {
                    log.error(`NPM.balanceOf failed  ${dex}  ${wShort}: ${error}`);
                }
            }

            this.syncedWallets.add(walletAddress);
        }

        // 補入手動追蹤的 TokenId（鎖倉於 Gauge 等情境）
        const discoveredIds = new Set(discovered.map(d => d.tokenId));
        for (const tp of ucTrackedPositions(appState.userConfig)) {
            if (discoveredIds.has(tp.tokenId)) continue;
            log.info(`📍 manual  #${tp.tokenId} (${tp.dexType})`);
            discovered.push({ tokenId: tp.tokenId, dex: tp.dexType, ownerWallet: tp.ownerWallet });
        }

        // 將新發現的倉位寫入 appState.userConfig，使 openTimestamp 等配置一併持久化
        for (const d of discovered) {
            if (this.closedTokenIds.has(d.tokenId)) continue;
            appState.userConfig = ucUpsertPosition(
                appState.userConfig, d.ownerWallet, d.tokenId,
                { dexType: d.dex, externalStake: d.ownerWallet === 'manual' }
            );
        }

        const activeDiscovered = discovered.filter(d => !this.closedTokenIds.has(d.tokenId));
        this.positions = activeDiscovered.map(d =>
            this._makeSeedPosition(d.tokenId, d.dex, d.ownerWallet,
                ucGetOpenTimestamp(appState.userConfig, d.tokenId))
        );

        log.info(`✅ chain sync done: ${this.positions.length} position(s) loaded`);
    }

    /** Returns the current in-memory tracked positions. */
    static getTrackedPositions(): PositionRecord[] {
        return this.positions;
    }

    /**
     * Fetch raw NPM chain data for all tracked positions.
     * Handles unsynced wallet detection and returns RawChainPosition[].
     * Called by index.ts; results are passed to PositionAggregator.aggregateAll().
     */
    static async fetchAll(): Promise<RawChainPosition[]> {
        const unsyncedWallets = ucWalletAddresses(appState.userConfig).filter(w => !this.syncedWallets.has(w));
        if (unsyncedWallets.length > 0) {
            log.info(`🔄 ${unsyncedWallets.length} new wallet(s) detected, re-syncing chain`);
            await this.syncFromChain();
        }

        if (this.positions.length === 0) {
            log.info('no tracked positions, skipping fetch');
            return [];
        }

        const rawPositions: RawChainPosition[] = [];
        for (const pos of this.positions) {
            const raw = await this._fetchNpmData(pos.tokenId, pos.dex, pos.ownerWallet, pos.openTimestampMs);
            if (raw) {
                rawPositions.push(raw);
            } else {
                log.warn(`#${pos.tokenId} npm fetch failed, position will keep stale record`);
            }
        }
        return rawPositions;
    }

    /**
     * Update in-memory positions with newly assembled PositionRecords.
     * Positions missing from assembled (failed scan) keep their stale record.
     * Preserves ownerWallet when ownerOf returns a gauge contract.
     */
    static updatePositions(assembled: PositionRecord[]) {
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
                this.closedTokenIds.add(prev.tokenId);
                // Persist closed flag into WalletPosition
                const ownerWallet = ucFindWallet(appState.userConfig, prev.tokenId) ?? prev.ownerWallet;
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
     * Optional: Generate a text report of positions to a log file.
     * Call this at the end of the analysis pipeline.
     */
    static logSnapshots(positions: PositionRecord[], bb?: BBResult | null, kLow?: number, kHigh?: number) {
        if (positions.length === 0) return;
        const outputs = positions.map(pos => buildLogPositionBlock(pos, TOKEN_DECIMALS, bb));

        const header = buildLogSnapshotHeader(bb, kLow, kHigh);
        const logContent = header + '\n\n' + outputs.join('\n\n') + '\n\n';

        const logDir = path.join(__dirname, '../../logs');
        fs.ensureDirSync(logDir);
        fs.appendFileSync(path.join(logDir, 'positions.log'), logContent);
        log.info(`✅ positions.log written  ${positions.length} position(s)`);
    }

    /**
     * Fetch raw NPM data for a single position — ownerOf + positions().
     * Dispatches to V4-specific method for UniswapV4 positions.
     * Returns null on failure.
     */
    private static async _fetchNpmData(
        tokenId: string,
        dex: Dex,
        ownerWallet: string,
        openTimestampMs?: number,
    ): Promise<RawChainPosition | null> {
        if (dex === 'UniswapV4') {
            return this._fetchV4NpmData(tokenId, ownerWallet, openTimestampMs);
        }
        try {
            const npmAddress = config.NPM_ADDRESSES[dex];
            const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());

            const owner = await rpcRetry(() => npmContract.ownerOf(tokenId), `${dex}.ownerOf(${tokenId})`);
            const position = await rpcRetry(() => npmContract.positions(tokenId), `${dex}.positions(${tokenId})`);

            const feeTier = Number(position.fee);
            const oShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
            log.info(`⛓  #${tokenId} ${dex}  owner ${oShort}  fee/tick=${feeTier}  liq=${position.liquidity}`);

            const poolAddress = this.getPoolFromTokens(position.token0, position.token1, feeTier, dex);
            if (!poolAddress) {
                log.warn(`#${tokenId} no pool match  fee/tick=${feeTier}  dex=${dex}`);
                return null;
            }

            // Aerodrome NPM 回傳的是 tickSpacing（非 fee pips），需個別轉換
            let tickSpacing = 60;
            let feeTierForStats = feeTier / 1000000;
            if (feeTier === 100) tickSpacing = 1;
            else if (feeTier === 500) tickSpacing = 10;
            else if (feeTier === 85) tickSpacing = 1;
            else if (dex === 'Aerodrome' && feeTier === 1) {
                tickSpacing = 1;
                feeTierForStats = 0.000085;
            }

            const ownerIsWallet = ucWalletAddresses(appState.userConfig).some(w => w.toLowerCase() === owner.toLowerCase());
            const isStaked = !ownerIsWallet;

            return {
                tokenId,
                dex,
                ownerWallet,
                owner,
                isStaked,
                position,
                poolAddress,
                feeTier,
                feeTierForStats,
                tickSpacing,
                openTimestampMs,
            };
        } catch (error) {
            log.error(`npm fetch failed  #${tokenId} (${dex}): ${error}`);
            return null;
        }
    }

    /**
     * Fetch raw chain data for a Uniswap V4 position.
     * Reads PoolKey + PositionInfo from V4 PositionManager; computes poolId from PoolKey.
     */
    private static async _fetchV4NpmData(
        tokenId: string,
        ownerWallet: string,
        openTimestampMs?: number,
    ): Promise<RawChainPosition | null> {
        try {
            const npmAddress = config.NPM_ADDRESSES['UniswapV4'];
            const npmContract = new ethers.Contract(npmAddress, config.V4_NPM_ABI, nextProvider());

            const owner = await rpcRetry(() => npmContract.ownerOf(tokenId), `V4.ownerOf(${tokenId})`);
            const [poolKey, positionInfoPacked] = await rpcRetry(
                () => npmContract.getPoolAndPositionInfo(tokenId),
                `V4.getPoolAndPositionInfo(${tokenId})`
            );
            const liquidity = await rpcRetry(
                () => npmContract.getPositionLiquidity(tokenId),
                `V4.getPositionLiquidity(${tokenId})`
            );

            // Decode packed PositionInfo: bits 0-23 = tickLower (int24), bits 24-47 = tickUpper (int24)
            const info = BigInt(positionInfoPacked.toString());
            const TICK_MASK = (1n << 24n) - 1n;
            const tickLower = Number(BigInt.asIntN(24, info & TICK_MASK));
            const tickUpper = Number(BigInt.asIntN(24, (info >> 24n) & TICK_MASK));

            // Compute poolId = keccak256(abi.encode(PoolKey))
            const abiCoder = ethers.AbiCoder.defaultAbiCoder();
            const poolId = ethers.keccak256(abiCoder.encode(
                ['address', 'address', 'uint24', 'int24', 'address'],
                [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
            ));

            const feeTier = Number(poolKey.fee);
            const tickSpacing = Number(poolKey.tickSpacing);
            const feeTierForStats = feeTier / 1_000_000;

            // Normalize position to match V3 shape expected by PositionAggregator
            const position = {
                token0: poolKey.currency0.toLowerCase(),
                token1: poolKey.currency1.toLowerCase(),
                fee: poolKey.fee,
                tickLower,
                tickUpper,
                liquidity,
                // feeGrowth values not available from PositionManager; V4 FeeCalculator reads from StateView
                feeGrowthInside0LastX128: 0n,
                feeGrowthInside1LastX128: 0n,
                tokensOwed0: 0n,
                tokensOwed1: 0n,
            };

            const ownerIsWallet = ucWalletAddresses(appState.userConfig).some(w => w.toLowerCase() === owner.toLowerCase());
            const isStaked = !ownerIsWallet;
            const oShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
            log.info(`⛓  #${tokenId} UniswapV4  owner ${oShort}  fee=${feeTier}  tick=[${tickLower},${tickUpper}]  liq=${liquidity}`);

            return {
                tokenId,
                dex: 'UniswapV4',
                ownerWallet,
                owner,
                isStaked,
                position,
                poolAddress: poolId.toLowerCase(),
                feeTier,
                feeTierForStats,
                tickSpacing,
                openTimestampMs,
            };
        } catch (error) {
            log.error(`V4 npm fetch failed  #${tokenId}: ${error}`);
            return null;
        }
    }

    /**
     * Helper to find a pool address given two tokens and a fee.
     */
    private static getPoolFromTokens(tokenA: string, tokenB: string, fee: number, dex: Dex): string | null {
        const map: Record<string, string> = {
            'PancakeSwapV3_100': config.POOLS?.PANCAKEV3_WETH_CBBTC_0_01   || '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
            'PancakeSwapV3_500': config.POOLS?.PANCAKEV3_WETH_CBBTC_0_05   || '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
            'UniswapV3_500':     config.POOLS?.UNISWAPV3_WETH_CBBTC_0_05   || '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
            'UniswapV3_3000':    config.POOLS?.UNISWAPV3_WETH_CBBTC_0_3    || '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
            'Aerodrome_85':      config.POOLS?.AERODROME_WETH_CBBTC_0_0085  || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5',
            'Aerodrome_1':       config.POOLS?.AERODROME_WETH_CBBTC_0_0085  || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5',
        };
        return map[`${dex}_${fee}`] || null;
    }

    /**
     * 背景補齊缺少 openTimestampMs 的倉位建倉時間。
     * 失敗超過 TIMESTAMP_MAX_FAILURES 次後標記為 -1（顯示 N/A），停止重試。
     */
    /**
     * 背景補齊缺少 openTimestamp 的倉位。
     * 找到後立即更新 appState.userConfig 並呼叫 saveStateCallback 持久化。
     * 失敗次數已合併至 openTimestamp=-1（N/A 哨兵值），不再維護獨立 Map。
     */
    static async fillMissingTimestamps(saveStateCallback?: () => Promise<void>): Promise<void> {
        // openTimestamp=undefined → 待查；openTimestamp=-1 → 已放棄（N/A）
        const missing = this.positions.filter(p => p.openTimestampMs === undefined);
        if (missing.length === 0) return;

        log.info(`⏳ fillMissingTimestamps  ${missing.length} token(s) pending`);

        const failures = new Map<string, number>(); // 本次執行期間的失敗計數
        let filled = 0;

        for (const pos of missing) {
            const npmAddress = config.NPM_ADDRESSES[pos.dex];
            if (!npmAddress) continue;

            const tsMs = await findMintTimestampMs(pos.tokenId, npmAddress);
            if (tsMs !== null) {
                // 更新 in-memory positions
                this.positions = this.positions.map(p =>
                    p.tokenId === pos.tokenId ? { ...p, openTimestampMs: tsMs } : p
                );
                // 更新 appState.userConfig（持久化來源）
                appState.userConfig = ucUpsertPosition(
                    appState.userConfig,
                    pos.ownerWallet,
                    pos.tokenId,
                    { openTimestamp: tsMs }
                );
                filled++;
                if (saveStateCallback) {
                    await saveStateCallback().catch(e => log.error(`Timestamp saveState failed: ${e}`));
                }
            } else {
                const cnt = (failures.get(pos.tokenId) ?? 0) + 1;
                failures.set(pos.tokenId, cnt);
                if (cnt >= config.TIMESTAMP_MAX_FAILURES) {
                    log.warn(`⏳ #${pos.tokenId} timestamp lookup failed ${cnt} times — marking N/A`);
                    this.positions = this.positions.map(p =>
                        p.tokenId === pos.tokenId ? { ...p, openTimestampMs: -1 } : p
                    );
                    appState.userConfig = ucUpsertPosition(
                        appState.userConfig, pos.ownerWallet, pos.tokenId, { openTimestamp: -1 }
                    );
                }
            }
        }

        if (filled > 0) log.info(`✅ fillMissingTimestamps  ${filled} timestamp(s) filled`);
    }
}

