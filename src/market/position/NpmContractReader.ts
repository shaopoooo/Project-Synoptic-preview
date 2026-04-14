import { ethers } from 'ethers';
import { config } from '../../config';
import { appState, ucWalletAddresses, ucTrackedPositions, ucUpsertPosition, ucFindWallet, ucPoolList } from '../../infra/AppState';
import { Dex, NpmPositionData, RawChainPosition } from '../../types';
import { createServiceLogger } from '../../infra/logger';
import { rpcRetry, nextProvider } from '../../infra/rpcProvider';
import { feeTierToTickSpacing } from '../../infra/utils/math';

const log = createServiceLogger('NpmContractReader');

export type DiscoveredPosition = { tokenId: string; dex: Dex; ownerWallet: string };

export class NpmContractReader {

    /**
     * 掃描所有錢包的 NFT，回傳發現的倉位（不含已關閉的）。
     * 同時更新 appState.userConfig（持久化來源）。
     * 回傳已成功掃描的錢包地址清單。
     */
    async discoverFromChain(
        walletAddresses: string[],
        closedTokenIds: Set<string>,
    ): Promise<{ discovered: DiscoveredPosition[]; syncedWallets: string[] }> {
        const dexes: Dex[] = ['UniswapV3', 'PancakeSwapV3', 'Aerodrome', 'UniswapV4'];
        const discovered: DiscoveredPosition[] = [];
        const syncedWallets: string[] = [];

        for (const walletAddress of walletAddresses) {
            const wShort = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
            log.info(`⛓  sync  ${wShort}`);

            for (const dex of dexes) {
                try {
                    const npmAddress = config.NPM_ADDRESSES[dex];
                    if (!npmAddress) continue;

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
                        if (closedTokenIds.has(tokenIdStr)) {
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

            syncedWallets.push(walletAddress);
        }

        // 補入手動追蹤的 TokenId（鎖倉於 Gauge 等情境）
        const discoveredIds = new Set(discovered.map(d => d.tokenId));
        for (const tp of ucTrackedPositions(appState.userConfig)) {
            if (discoveredIds.has(tp.tokenId)) continue;
            log.info(`📍 manual  #${tp.tokenId} (${tp.dexType})`);
            discovered.push({ tokenId: tp.tokenId, dex: tp.dexType, ownerWallet: tp.ownerWallet });
        }

        // 將新發現的倉位寫入 appState.userConfig
        for (const d of discovered) {
            if (closedTokenIds.has(d.tokenId)) continue;
            appState.userConfig = ucUpsertPosition(
                appState.userConfig, d.ownerWallet, d.tokenId,
                { dexType: d.dex, externalStake: d.ownerWallet === 'manual' }
            );
        }

        return {
            discovered: discovered.filter(d => !closedTokenIds.has(d.tokenId)),
            syncedWallets,
        };
    }

    /**
     * 批次取得所有倉位的鏈上 NPM 資料。
     * 回傳成功的原始資料，以及本次掃描中 NFT 已銷毀的 tokenId 清單（供 PositionScanner 清理狀態）。
     */
    async fetchNpmData(
        positions: { tokenId: string; dex: Dex; ownerWallet: string; openTimestampMs?: number }[],
        closedTokenIds: Set<string>,
    ): Promise<{ rawPositions: RawChainPosition[]; burnedTokenIds: string[] }> {
        const rawPositions: RawChainPosition[] = [];
        const burnedTokenIds: string[] = [];

        for (const pos of positions) {
            const result = await this._fetchNpmData(pos.tokenId, pos.dex, pos.ownerWallet, pos.openTimestampMs);
            if (result === 'burned') {
                burnedTokenIds.push(pos.tokenId);
            } else if (result !== null) {
                rawPositions.push(result);
            } else {
                log.warn(`#${pos.tokenId} npm fetch failed, position will keep stale record`);
            }
        }

        return { rawPositions, burnedTokenIds };
    }

    /**
     * 根據 token pair 和 fee 查找 pool 地址。
     */
    getPoolFromTokens(_tokenA: string, _tokenB: string, fee: number, dex: Dex): string | null {
        // Aerodrome NPM 對部分倉位回傳 tickSpacing=1 而非 fee pips=85，統一對應到 85
        const lookupPips = (dex === 'Aerodrome' && fee === 1) ? 85 : fee;
        const entry = ucPoolList(appState.userConfig).find(
            p => p.dex === dex && Math.round(p.fee * 1_000_000) === lookupPips
        );
        return entry?.address ?? null;
    }

    /**
     * 取得單一倉位的鏈上 NPM 資料（V3/PancakeSwap/Aerodrome）。
     * 回傳 'burned' 表示 NFT 已銷毀（已更新 appState），null 表示其他錯誤。
     */
    private async _fetchNpmData(
        tokenId: string,
        dex: Dex,
        ownerWallet: string,
        openTimestampMs?: number,
    ): Promise<RawChainPosition | 'burned' | null> {
        if (dex === 'UniswapV4') {
            return this._fetchV4NpmData(tokenId, ownerWallet, openTimestampMs);
        }
        try {
            const npmAddress = config.NPM_ADDRESSES[dex];
            const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());

            const owner = await rpcRetry(() => npmContract.ownerOf(tokenId), `${dex}.ownerOf(${tokenId})`);
            const position = await rpcRetry(() => npmContract.positions(tokenId), `${dex}.positions(${tokenId})`) as NpmPositionData;

            const feeTier = Number(position.fee);
            const oShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
            log.info(`⛓  #${tokenId} ${dex}  owner ${oShort}  fee/tick=${feeTier}  liq=${position.liquidity}`);

            const poolAddress = this.getPoolFromTokens(position.token0, position.token1, feeTier, dex);
            if (!poolAddress) {
                log.warn(`#${tokenId} no pool match  fee/tick=${feeTier}  dex=${dex}`);
                return null;
            }

            // Aerodrome NPM 回傳的是 tickSpacing（非 fee pips），需個別轉換
            let feeTierForStats = feeTier / 1000000;
            if (dex === 'Aerodrome' && feeTier === 1) {
                feeTierForStats = 0.000085; // Aerodrome returns tickSpacing=1 as fee field
            }
            const tickSpacing = feeTierToTickSpacing(feeTierForStats);

            const ownerIsWallet = ucWalletAddresses(appState.userConfig).some(w => w.toLowerCase() === owner.toLowerCase());
            const isStaked = !ownerIsWallet;

            return {
                tokenId, dex, ownerWallet, owner, isStaked, position,
                poolAddress, feeTier, feeTierForStats, tickSpacing, openTimestampMs,
            };
        } catch (error: any) {
            const msg: string = error?.message ?? '';
            const isBurned = msg.includes('"ID"') || msg.includes('nonexistent token');
            if (isBurned) {
                const walletAddr = ucFindWallet(appState.userConfig, tokenId);
                if (walletAddr) {
                    appState.userConfig = ucUpsertPosition(appState.userConfig, walletAddr, tokenId, { closed: true });
                    log.info(`#${tokenId} NFT burned — auto-closed`);
                    return 'burned';
                }
            } else {
                log.error(`npm fetch failed  #${tokenId} (${dex}): ${error}`);
            }
            return null;
        }
    }

    /**
     * 取得 Uniswap V4 倉位的鏈上資料。
     * 從 V4 PositionManager 讀取 PoolKey + PositionInfo，並計算 poolId。
     */
    private async _fetchV4NpmData(
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
                tokenId, dex: 'UniswapV4', ownerWallet, owner, isStaked, position,
                poolAddress: poolId.toLowerCase(), feeTier, feeTierForStats, tickSpacing, openTimestampMs,
            };
        } catch (error) {
            log.error(`V4 npm fetch failed  #${tokenId}: ${error}`);
            return null;
        }
    }
}
