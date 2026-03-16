import { ethers } from 'ethers';
import { config } from '../config';
import { appState, ucWalletAddresses } from '../utils/AppState';
import { createServiceLogger } from '../utils/logger';
import { rpcRetry, nextProvider } from '../utils/rpcProvider';
import { FeeQueryResult, RewardsQueryResult, Dex } from '../types';


const log = createServiceLogger('FeeCalculator');

export class FeeCalculator {
    /**
     * Fetch unclaimed LP fees for a position.
     * Strategy depends on dex and staked state.
     */
    static async fetchUnclaimedFees(
        tokenId: string,
        dex: Dex,
        owner: string,
        ownerIsWallet: boolean,
        poolAddress: string,
        position: any,
        poolTick: number,
        isStaked: boolean,
        npmAddress: string,
    ): Promise<FeeQueryResult> {
        // UniswapV4: fees computed from StateView feeGrowth math (V4 has no collect())
        if (dex === 'UniswapV4') {
            return this._fetchV4Fees(tokenId, poolAddress, position.tickLower, position.tickUpper, BigInt(position.liquidity), owner);
        }

        const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());
        let depositorWallet = ownerIsWallet ? owner : '';
        let unclaimed0 = 0n;
        let unclaimed1 = 0n;
        let source = 'unknown';

        if (dex === 'Aerodrome') {
            try {
                if (isStaked) {
                    const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
                    const canonicalGauge: string = await rpcRetry(
                        () => voter.gauges(poolAddress),
                        'aero.voter.gauges'
                    );
                    log.info(`🏛  #${tokenId} owner=${owner.slice(0, 10)}  canonicalGauge=${canonicalGauge?.slice(0, 10) ?? 'none'}`);

                    let pendingFeesOk = false;
                    if (canonicalGauge && canonicalGauge !== ethers.ZeroAddress) {
                        const gauge = new ethers.Contract(canonicalGauge, config.AERO_GAUGE_ABI, nextProvider());

                        if (!depositorWallet) {
                            for (const wallet of ucWalletAddresses(appState.userConfig)) {
                                try {
                                    if (await gauge.stakedContains(wallet, BigInt(tokenId))) {
                                        depositorWallet = wallet;
                                        break;
                                    }
                                } catch {}
                            }
                        }

                        if (depositorWallet) {
                            try {
                                const [f0, f1] = await gauge.pendingFees(tokenId);
                                unclaimed0 = BigInt(f0);
                                unclaimed1 = BigInt(f1);
                                log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [canonical_gauge.pendingFees]`);
                                source = 'gauge.pendingFees';
                                pendingFeesOk = true;
                            } catch {
                                // gauge _stakes 狀態不一致，靜默降級
                            }
                        } else {
                            log.info(`#${tokenId} gauge owns NFT but not staked → skip pendingFees`);
                        }
                    }

                    if (!pendingFeesOk) {
                        try {
                            const MAX_UINT128 = 2n ** 128n - 1n;
                            const collected = await npmContract.collect.staticCall(
                                { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
                                { from: owner }
                            );
                            unclaimed0 = BigInt(collected.amount0);
                            unclaimed1 = BigInt(collected.amount1);
                            log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [npm.collect.staticCall from gauge]`);
                            source = 'collect.staticCall';
                            // 只有在 collect.staticCall 返回非零時才視為成功；
                            // staked 倉位 LP fees 由 gauge 追蹤，NPM 可能返回 0 即使有費用累積
                            if (unclaimed0 > 0n || unclaimed1 > 0n) pendingFeesOk = true;
                        } catch (e: any) {
                            log.warn(`#${tokenId} collect.staticCall from gauge failed: ${e.message}`);
                        }
                    }

                    // 第 3 級 fallback：pool feeGrowth 數學計算（與 unstaked path 相同邏輯）
                    // staked 倉位的 feeGrowthInside0LastX128 仍由 NPM 正確記錄，pool 層的
                    // feeGrowthGlobal 也持續累積，差值即為累積 pending fees。
                    if (!pendingFeesOk) {
                        try {
                            const { fees0, fees1 } = await this.computePendingFees(
                                poolAddress, dex, poolTick,
                                position.tickLower, position.tickUpper,
                                BigInt(position.liquidity),
                                BigInt(position.feeGrowthInside0LastX128),
                                BigInt(position.feeGrowthInside1LastX128),
                                BigInt(position.tokensOwed0),
                                BigInt(position.tokensOwed1),
                            );
                            unclaimed0 = fees0;
                            unclaimed1 = fees1;
                            log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [staked.pool.feeGrowth]`);
                            source = 'pool.feeGrowth';
                            pendingFeesOk = true;
                        } catch (e: any) {
                            log.warn(`#${tokenId} staked aero feeGrowth fallback failed: ${e.message}`);
                        }
                    }

                    if (!pendingFeesOk) {
                        unclaimed0 = BigInt(position.tokensOwed0);
                        unclaimed1 = BigInt(position.tokensOwed1);
                        source = 'tokensOwed';
                        log.warn(`#${tokenId} staked aero: all fee methods failed, using tokensOwed (conservative)`);
                    }
                } else {
                    // Unstaked: pool feeGrowth math
                    const { fees0, fees1 } = await this.computePendingFees(
                        poolAddress, dex, poolTick,
                        position.tickLower, position.tickUpper,
                        BigInt(position.liquidity),
                        BigInt(position.feeGrowthInside0LastX128),
                        BigInt(position.feeGrowthInside1LastX128),
                        BigInt(position.tokensOwed0),
                        BigInt(position.tokensOwed1),
                    );
                    unclaimed0 = fees0;
                    unclaimed1 = fees1;
                    source = 'pool.feeGrowth';
                    log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [pool.feeGrowth]`);
                }
            } catch (e: any) {
                log.warn(`#${tokenId} aero fees failed: ${e.message} — using tokensOwed`);
                unclaimed0 = BigInt(position.tokensOwed0);
                unclaimed1 = BigInt(position.tokensOwed1);
                source = 'tokensOwed';
            }
        } else {
            // Uniswap / PancakeSwap
            try {
                const MAX_UINT128 = 2n ** 128n - 1n;
                const collected = await npmContract.collect.staticCall(
                    { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
                    { from: owner }
                );
                unclaimed0 = BigInt(collected[0]);
                unclaimed1 = BigInt(collected[1]);
                source = 'collect.staticCall';
                log.info(`💸 #${tokenId} fees  ${unclaimed0} / ${unclaimed1}`);
            } catch (e: any) {
                log.warn(`#${tokenId} collect.staticCall failed (${dex}): ${e.message} — using tokensOwed`);
                unclaimed0 = BigInt(position.tokensOwed0);
                unclaimed1 = BigInt(position.tokensOwed1);
                source = 'tokensOwed';
            }
        }

        return { unclaimed0, unclaimed1, depositorWallet, source };
    }

    /**
     * Fetch third-party rewards (AERO for Aerodrome staked, CAKE for PancakeSwap).
     */
    static async fetchThirdPartyRewards(
        tokenId: string,
        dex: Dex,
        owner: string,
        ownerIsWallet: boolean,
        poolAddress: string,
        isStaked: boolean,
        depositorWallet: string,
        aeroPrice: number,
        cakePrice: number,
    ): Promise<RewardsQueryResult> {
        let unclaimed2 = 0n;
        let fees2USD = 0;
        let token2Symbol = '';
        let updatedDepositorWallet = depositorWallet;

        // AERO rewards (Aerodrome staked)
        if (dex === 'Aerodrome' && isStaked && depositorWallet) {
            try {
                const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
                const canonicalGauge: string = await rpcRetry(
                    () => voter.gauges(poolAddress),
                    'aero.voter.gauges.earned'
                );
                if (canonicalGauge && canonicalGauge !== ethers.ZeroAddress) {
                    const gauge = new ethers.Contract(canonicalGauge, config.AERO_GAUGE_ABI, nextProvider());
                    const earned: bigint = await gauge.earned(depositorWallet, tokenId);
                    unclaimed2 = BigInt(earned);
                    if (unclaimed2 > 0n) {
                        const aeroNormalized = Number(unclaimed2) / 1e18;
                        fees2USD = aeroNormalized * aeroPrice;
                        token2Symbol = 'AERO';
                        log.info(`💸 #${tokenId} AERO  ${aeroNormalized.toFixed(6)}  ($${fees2USD.toFixed(3)})  [gauge.earned]`);
                    }
                }
            } catch (e: any) {
                log.warn(`#${tokenId} aero gauge.earned failed: ${e.message}`);
            }
        }

        // CAKE rewards (PancakeSwap MasterChef V3)
        if (dex === 'PancakeSwapV3') {
            const candidates = ownerIsWallet
                ? (config.PANCAKE_MASTERCHEF_V3 ? [config.PANCAKE_MASTERCHEF_V3] : [])
                : [owner, ...(config.PANCAKE_MASTERCHEF_V3 && owner.toLowerCase() !== config.PANCAKE_MASTERCHEF_V3.toLowerCase() ? [config.PANCAKE_MASTERCHEF_V3] : [])];

            for (const addr of candidates) {
                try {
                    const masterchef = new ethers.Contract(addr, config.PANCAKE_MASTERCHEF_V3_ABI, nextProvider());
                    const pending = await masterchef.pendingCake(tokenId);
                    unclaimed2 = BigInt(pending);
                    if (unclaimed2 > 0n) {
                        const resolvedCakePrice = cakePrice;
                        const cakeNormalized = Number(unclaimed2) / 1e18;
                        fees2USD = cakeNormalized * resolvedCakePrice;
                        token2Symbol = 'CAKE';
                        log.info(`💸 #${tokenId} CAKE  ${cakeNormalized.toFixed(6)}  ($${fees2USD.toFixed(3)})  [${addr.slice(0, 10)}]`);
                    }
                    if (!updatedDepositorWallet) {
                        try {
                            const info = await masterchef.userPositionInfos(tokenId);
                            if (info.user && info.user !== ethers.ZeroAddress) updatedDepositorWallet = info.user;
                        } catch {}
                    }
                    break;
                } catch {
                    // not staked or not MasterChef, try next
                }
            }
        }

        return { unclaimed2, fees2USD, token2Symbol, depositorWallet: updatedDepositorWallet };
    }

    /**
     * Compute pending fees from pool feeGrowth math (Uniswap V3 formula).
     */
    /**
     * Compute unclaimed fees for a Uniswap V4 position using StateView.
     * V4 has no collect() — fees are derived from feeGrowthInside delta × liquidity.
     */
    private static async _fetchV4Fees(
        tokenId: string,
        poolId: string,
        tickLower: number,
        tickUpper: number,
        liquidity: bigint,
        owner: string,
    ): Promise<FeeQueryResult> {
        const Q128 = 2n ** 128n;
        const U256_MAX = 2n ** 256n;
        const sub256 = (a: bigint, b: bigint) => ((a - b) % U256_MAX + U256_MAX) % U256_MAX;

        const stateView = new ethers.Contract(config.V4_STATE_VIEW, config.V4_STATE_VIEW_ABI, nextProvider());
        const positionManager = config.NPM_ADDRESSES['UniswapV4'];
        // salt = bytes32(tokenId) — used to distinguish positions with same owner + range
        const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);

        const [posInfo, feeGrowthInside] = await Promise.all([
            rpcRetry(
                () => stateView.getPositionInfo(poolId, positionManager, tickLower, tickUpper, salt),
                `V4.getPositionInfo(${tokenId})`
            ),
            rpcRetry(
                () => stateView.getFeeGrowthInside(poolId, tickLower, tickUpper),
                `V4.getFeeGrowthInside(${poolId.slice(0, 10)})`
            ),
        ]);

        const lastFg0 = BigInt(posInfo.feeGrowthInside0LastX128);
        const lastFg1 = BigInt(posInfo.feeGrowthInside1LastX128);
        const curFg0  = BigInt(feeGrowthInside.feeGrowthInside0X128);
        const curFg1  = BigInt(feeGrowthInside.feeGrowthInside1X128);

        const fees0 = liquidity * sub256(curFg0, lastFg0) / Q128;
        const fees1 = liquidity * sub256(curFg1, lastFg1) / Q128;

        log.info(`💸 #${tokenId} V4 fees  ${fees0} / ${fees1}  [StateView.feeGrowth]`);
        return { unclaimed0: fees0, unclaimed1: fees1, depositorWallet: owner, source: 'V4.StateView.feeGrowth' };
    }

    private static async computePendingFees(
        poolAddress: string,
        dex: Dex,
        currentTick: number,
        tickLower: number,
        tickUpper: number,
        liquidity: bigint,
        feeGrowthInside0LastX128: bigint,
        feeGrowthInside1LastX128: bigint,
        tokensOwed0: bigint,
        tokensOwed1: bigint,
    ): Promise<{ fees0: bigint; fees1: bigint }> {
        const poolAbi = dex === 'Aerodrome' ? config.AERO_POOL_ABI : config.POOL_ABI;
        const pool = new ethers.Contract(poolAddress, poolAbi, nextProvider());
        const Q128 = 2n ** 128n;
        const U256 = 2n ** 256n;
        const sub256 = (a: bigint, b: bigint) => ((a - b) % U256 + U256) % U256;

        const [fg0, fg1, tLower, tUpper] = await Promise.all([
            rpcRetry(() => pool.feeGrowthGlobal0X128(), 'feeGrowthGlobal0X128'),
            rpcRetry(() => pool.feeGrowthGlobal1X128(), 'feeGrowthGlobal1X128'),
            rpcRetry(() => pool.ticks(tickLower), `ticks(${tickLower})`),
            rpcRetry(() => pool.ticks(tickUpper), `ticks(${tickUpper})`),
        ]);

        const fgg0 = BigInt(fg0); const fgg1 = BigInt(fg1);
        const lo0 = BigInt(tLower.feeGrowthOutside0X128);
        const lo1 = BigInt(tLower.feeGrowthOutside1X128);
        const hi0 = BigInt(tUpper.feeGrowthOutside0X128);
        const hi1 = BigInt(tUpper.feeGrowthOutside1X128);

        const below0 = currentTick >= tickLower ? lo0 : sub256(fgg0, lo0);
        const below1 = currentTick >= tickLower ? lo1 : sub256(fgg1, lo1);
        const above0 = currentTick < tickUpper ? hi0 : sub256(fgg0, hi0);
        const above1 = currentTick < tickUpper ? hi1 : sub256(fgg1, hi1);

        const inside0 = sub256(sub256(fgg0, below0), above0);
        const inside1 = sub256(sub256(fgg1, below1), above1);

        const pending0 = liquidity * sub256(inside0, feeGrowthInside0LastX128) / Q128;
        const pending1 = liquidity * sub256(inside1, feeGrowthInside1LastX128) / Q128;

        return {
            fees0: pending0 + tokensOwed0,
            fees1: pending1 + tokensOwed1,
        };
    }
}
