import { ethers } from 'ethers';
import { config } from '../config';
import { PoolScanner } from './PoolScanner';
import { BBEngine, BBResult } from './BBEngine';
import { RiskManager } from './RiskManager';
import { RebalanceService, RebalanceSuggestion } from './rebalance';
import { PnlCalculator } from './PnlCalculator';
import { createServiceLogger, positionLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay, nextProvider } from '../utils/rpcProvider';
import { OpenTimestampService, TimestampRequest } from './OpenTimestampService';
import { DiscoveredPosition } from '../utils/stateManager';

const log = createServiceLogger('PositionScanner');

export interface PositionRecord {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    poolAddress: string;
    feeTier: number;
    token0Symbol: string;
    token1Symbol: string;
    ownerWallet: string;

    // Live Snapshot 
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    minPrice: string;
    maxPrice: string;
    bbMinPrice?: string; // Natively scaled BB lower bound
    bbMaxPrice?: string; // Natively scaled BB upper bound
    currentTick: number;
    currentPriceStr: string;
    positionValueUSD: number;

    // Fees & IL
    unclaimed0: string;
    unclaimed1: string;
    unclaimedFeesUSD: number;
    collectedFeesUSD: number;

    // Risk
    overlapPercent: number;
    ilUSD: number | null;
    breakevenDays: number;
    healthScore: number;
    regime: string;

    // Metadata
    lastUpdated: number;
    openTimestampMs?: number; // 建倉區塊時間 (ms)，從鏈上 Transfer 事件取得
    volSource: string;    // e.g. 'The Graph (PancakeSwap)', 'GeckoTerminal', 'stale cache'
    priceSource: string;  // e.g. 'The Graph (Uniswap)', 'GeckoTerminal'
    bbFallback: boolean;  // True if BBEngine failed and returned a fallback
    rebalance?: RebalanceSuggestion;
}

export class PositionScanner {

    /** In-memory position store (replaces positions.json) */
    private static positions: PositionRecord[] = [];
    private static syncedWallets = new Set<string>();

    /**
     * Fetches LP NFT positions from on-chain for the configured wallet.
     * Called once at startup to seed the in-memory state.
     * Open timestamps are fetched in one batched scan per NPM via OpenTimestampService.
     */
    /**
     * 查詢 Aerodrome Slipstream 手續費。
     * 策略：
     *  1. 若 ownerOf = gauge（已 stake）→ 嘗試 gauge.pendingFees(tokenId)
     *  2. 若未 stake → 嘗試 collect.staticCall({from: owner})
     *  3. 任一失敗 → 回退至 NPM positions() 的 tokensOwed
     */
    private static async fetchAerodromeGaugeFees(
        tokenId: string,
        owner: string,
        poolAddress: string,
        position: any,
    ): Promise<{ fees0: bigint; fees1: bigint; source: string }> {
        const tokensOwedFallback = {
            fees0: BigInt(position.tokensOwed0),
            fees1: BigInt(position.tokensOwed1),
            source: 'tokensOwed',
        };

        try {
            // 1. 查詢 gauge 地址
            const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
            const gaugeAddress: string = await rpcRetry(() => voter.gauges(poolAddress), 'aero.voter.gauges');
            if (!gaugeAddress || gaugeAddress === ethers.ZeroAddress) {
                log.warn(`#${tokenId} no Aerodrome gauge found for pool`);
                return tokensOwedFallback;
            }
            log.info(`🏛  #${tokenId} gauge ${gaugeAddress.slice(0, 10)}`);

            const gauge = new ethers.Contract(gaugeAddress, config.AERO_GAUGE_ABI, nextProvider());
            const isStaked: boolean = await rpcRetry(
                () => gauge.stakedContains(owner, tokenId),
                'aero.gauge.stakedContains'
            );

            if (isStaked) {
                // 2a. 已 stake：嘗試 gauge.pendingFees(tokenId)
                try {
                    const [f0, f1] = await rpcRetry(
                        () => gauge.pendingFees(tokenId),
                        'aero.gauge.pendingFees'
                    );
                    return { fees0: BigInt(f0), fees1: BigInt(f1), source: 'gauge.pendingFees' };
                } catch {
                    log.warn(`#${tokenId} gauge.pendingFees unavailable, falling back`);
                    return tokensOwedFallback;
                }
            } else {
                // 2b. 未 stake：collect.staticCall({from: owner})
                try {
                    const npmAddress = config.NPM_ADDRESSES['Aerodrome'];
                    const npm = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());
                    const MAX_UINT128 = 2n ** 128n - 1n;
                    const collected = await npm.collect.staticCall(
                        { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
                        { from: owner }
                    );
                    return { fees0: BigInt(collected[0]), fees1: BigInt(collected[1]), source: 'collect.staticCall' };
                } catch (e: any) {
                    log.warn(`#${tokenId} collect.staticCall failed: ${e.message}`);
                    return tokensOwedFallback;
                }
            }
        } catch (e: any) {
            log.warn(`#${tokenId} gauge query failed: ${e.message}`);
            return tokensOwedFallback;
        }
    }

    /**
     * 從 pool 直接計算 pending unclaimed fees，不依賴 NPM collect。
     * 使用 Uniswap V3 標準公式：
     *   feeGrowthInside = feeGrowthGlobal - feeGrowthBelow(tickLower) - feeGrowthAbove(tickUpper)
     *   fees = liquidity × (feeGrowthInside - feeGrowthInsideLast) / 2^128
     * 所有運算使用 BigInt 並以 mod 2^256 處理 Solidity uint256 wraparound。
     */
    private static async computePendingFees(
        poolAddress: string,
        dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome',
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

        // feeGrowthBelow: currentTick >= tickLower → use outside as-is, else flip
        const below0 = currentTick >= tickLower ? lo0 : sub256(fgg0, lo0);
        const below1 = currentTick >= tickLower ? lo1 : sub256(fgg1, lo1);
        // feeGrowthAbove: currentTick < tickUpper → use outside as-is, else flip
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

    /**
     * 從 state 恢復已探索的倉位清單，並標記 wallet 已同步（跳過 chain scan）。
     * 呼叫端需確認 syncedWallets 與當前 config.WALLET_ADDRESSES 一致。
     */
    static restoreDiscoveredPositions(
        discovered: DiscoveredPosition[],
        wallets: string[],
        timestamps: Record<string, number>
    ) {
        const seedPositions: PositionRecord[] = discovered.map(d => ({
            tokenId: d.tokenId,
            dex: d.dex,
            poolAddress: '',
            feeTier: 0,
            token0Symbol: '',
            token1Symbol: '',
            ownerWallet: d.ownerWallet,
            liquidity: '0',
            tickLower: 0,
            tickUpper: 0,
            minPrice: '0',
            maxPrice: '0',
            currentTick: 0,
            currentPriceStr: '0',
            positionValueUSD: 0,
            unclaimed0: '0',
            unclaimed1: '0',
            unclaimedFeesUSD: 0,
            collectedFeesUSD: 0,
            overlapPercent: 0,
            ilUSD: null,
            breakevenDays: 0,
            healthScore: 0,
            regime: '資料累積中',
            lastUpdated: 0,
            openTimestampMs: timestamps[`${d.tokenId}_${d.dex}`],
            volSource: 'pending',
            priceSource: 'pending',
            bbFallback: false,
        }));
        this.positions = seedPositions;
        wallets.forEach(w => this.syncedWallets.add(w));
        log.info(`✅ positions restored from state: ${seedPositions.length} position(s), chain sync skipped`);
    }

    /** 取得目前 discovered positions 快照，供 stateManager 儲存。 */
    static getDiscoveredSnapshot(): DiscoveredPosition[] {
        return this.positions.map(p => ({ tokenId: p.tokenId, dex: p.dex, ownerWallet: p.ownerWallet }));
    }

    static async syncFromChain() {
        if (config.WALLET_ADDRESSES.length === 0) {
            log.info('no wallets configured, skipping chain sync');
            return;
        }

        // Phase 1: discover all tokenIds — 全部 wallet × DEX 平行掃描
        type Discovery = { tokenId: string; dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'; ownerWallet: string };
        const dexes: ('Uniswap' | 'PancakeSwap' | 'Aerodrome')[] = ['Uniswap', 'PancakeSwap', 'Aerodrome'];

        // 全串行：公共 RPC 節點無法承受並發，wallet × DEX 依序執行
        const discovered: Discovery[] = [];

        for (const walletAddress of config.WALLET_ADDRESSES) {
            const wShort = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
            log.info(`⛓  sync  ${wShort}`);

            for (const dex of dexes) {
                try {
                    const npmAddress = config.NPM_ADDRESSES[dex];
                    if (!npmAddress) continue;

                    const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());
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
        for (const [tokenId, dex] of Object.entries(config.TRACKED_TOKEN_IDS)) {
            if (discoveredIds.has(tokenId)) continue;
            log.info(`📍 manual  #${tokenId} (${dex})`);
            discovered.push({ tokenId, dex: dex as 'Uniswap' | 'PancakeSwap' | 'Aerodrome', ownerWallet: 'manual' });
        }

        // Phase 2: batch-fetch open timestamps — one scan per NPM contract
        const timestampRequests: TimestampRequest[] = discovered
            .filter(d => !!config.NPM_ADDRESSES[d.dex])
            .map(d => ({ tokenId: d.tokenId, npmAddress: config.NPM_ADDRESSES[d.dex], dex: d.dex }));

        const timestamps = await OpenTimestampService.fetchAll(timestampRequests);

        // Phase 3: build seedPositions
        const seedPositions: PositionRecord[] = discovered.map(d => ({
            tokenId: d.tokenId,
            dex: d.dex,
            poolAddress: '',
            feeTier: 0,
            token0Symbol: '',
            token1Symbol: '',
            ownerWallet: d.ownerWallet,
            liquidity: '0',
            tickLower: 0,
            tickUpper: 0,
            minPrice: '0',
            maxPrice: '0',
            currentTick: 0,
            currentPriceStr: '0',
            positionValueUSD: 0,
            unclaimed0: '0',
            unclaimed1: '0',
            unclaimedFeesUSD: 0,
            collectedFeesUSD: 0,
            overlapPercent: 0,
            ilUSD: null,
            breakevenDays: 0,
            healthScore: 0,
            regime: '資料累積中',
            lastUpdated: 0,
            openTimestampMs: timestamps[`${d.tokenId}_${d.dex}`],
            volSource: 'pending',
            priceSource: 'pending',
            bbFallback: false,
        }));

        this.positions = seedPositions;
        log.info(`✅ chain sync done: ${this.positions.length} position(s) loaded`);
    }

    /**
     * Returns the current in-memory tracked positions.
     */
    static getTrackedPositions(): PositionRecord[] {
        return this.positions;
    }

    /**
     * Log position snapshots to the dedicated positions.log (append-only history).
     */
    private static logPositionSnapshots(positions: PositionRecord[]) {
        for (const pos of positions) {
            positionLogger.info('position_snapshot', {
                tokenId: pos.tokenId,
                dex: pos.dex,
                pool: pos.poolAddress,
                feeTier: pos.feeTier,
                liquidity: pos.liquidity,
                currentTick: pos.currentTick,
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                price: pos.currentPriceStr,
                minPrice: pos.minPrice,
                maxPrice: pos.maxPrice,
                positionValueUSD: pos.positionValueUSD,
                unclaimed0: pos.unclaimed0,
                unclaimed1: pos.unclaimed1,
                unclaimedFeesUSD: pos.unclaimedFeesUSD,
                ilUSD: pos.ilUSD,
                healthScore: pos.healthScore,
                regime: pos.regime,
                breakevenDays: pos.breakevenDays,
                overlapPercent: pos.overlapPercent
            });
        }
    }

    /**
     * Core routine to scan a specific NFT position, fetch live data, compute IL & BB overlap, and update the record.
     */
    static async scanPosition(tokenId: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome', precomputedBB?: BBResult | null): Promise<PositionRecord | null> {
        try {
            const npmAddress = config.NPM_ADDRESSES[dex];
            const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());

            // Fetch live position details
            const owner = await rpcRetry(() => npmContract.ownerOf(tokenId), `${dex}.ownerOf(${tokenId})`);
            const position = await rpcRetry(() => npmContract.positions(tokenId), `${dex}.positions(${tokenId})`);

            const feeTier = Number(position.fee);
            const oShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
            log.info(`⛓  #${tokenId} ${dex}  owner ${oShort}  fee/tick=${feeTier}  liq=${position.liquidity}`);

            const poolAddress = await this.getPoolFromTokens(position.token0, position.token1, feeTier, dex);
            if (!poolAddress) {
                log.warn(`#${tokenId} no pool match  fee/tick=${feeTier}  dex=${dex}`);
                return null;
            }

            // Fetch live pool info & BB Engine
            // Aerodrome NPM 回傳的是 tickSpacing（非 fee pips），需個別轉換
            let tickSpacing = 60;
            let feeTierForStats = feeTier / 1000000; // 預設：fee pips → 小數費率
            if (feeTier === 100) tickSpacing = 1; // 0.01%
            else if (feeTier === 500) tickSpacing = 10; // 0.05%
            else if (feeTier === 85) tickSpacing = 1; // Aerodrome fee=85 → 0.0085%
            else if (dex === 'Aerodrome' && feeTier === 1) {
                // tickSpacing=1 對應 0.0085% 池
                tickSpacing = 1;
                feeTierForStats = 0.000085;
            }

            const poolStats = await PoolScanner.fetchPoolStats(poolAddress, dex, feeTierForStats);
            if (!poolStats) {
                log.warn(`#${tokenId} fetchPoolStats returned null  ${poolAddress.slice(0, 10)}`);
                return null;
            }

            // 優先使用外部預計算的 BB（由 runBBEngine 統一計算），避免重複 API 呼叫
            const bb = precomputedBB !== undefined
                ? precomputedBB
                : await BBEngine.computeDynamicBB(poolAddress, dex, tickSpacing, poolStats.tick);

            // 手續費計算策略：
            // - Aerodrome: collect.staticCall 始終回傳 0，改用 feeGrowth 數學計算
            // - Uniswap / PancakeSwap: collect.staticCall({ from: owner }) 穩定可用
            let unclaimed0 = 0n;
            let unclaimed1 = 0n;
            if (dex === 'Aerodrome') {
                const gaugeResult = await this.fetchAerodromeGaugeFees(tokenId, owner, poolAddress, position);
                unclaimed0 = gaugeResult.fees0;
                unclaimed1 = gaugeResult.fees1;
                log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [${gaugeResult.source}]`);
            } else {
                // Uniswap / PancakeSwap: use collect.staticCall with {from: owner}
                try {
                    const MAX_UINT128 = 2n ** 128n - 1n;
                    const collected = await npmContract.collect.staticCall(
                        {
                            tokenId,
                            recipient: owner,
                            amount0Max: MAX_UINT128,
                            amount1Max: MAX_UINT128,
                        },
                        { from: owner }
                    );
                    unclaimed0 = BigInt(collected[0]);
                    unclaimed1 = BigInt(collected[1]);
                    log.info(`💸 #${tokenId} fees  ${unclaimed0} / ${unclaimed1}`);
                } catch (e: any) {
                    // Fallback: use tokensOwed from positions() call
                    log.warn(`#${tokenId} collect.staticCall failed (${dex}): ${e.message} — using tokensOwed`);
                    unclaimed0 = BigInt(position.tokensOwed0);
                    unclaimed1 = BigInt(position.tokensOwed1);
                }
            }

            // --- Address token decimal conversion for prices and amounts ---
            // On Base, WETH = 18 decimals, cbBTC = 8 decimals.
            const wethAddr = '0x4200000000000000000000000000000000000006'.toLowerCase();
            const cbbtcAddr = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'.toLowerCase();
            const t0 = position.token0.toLowerCase();
            const t1 = position.token1.toLowerCase();
            const dec0 = (t0 === cbbtcAddr) ? 8 : 18;
            const dec1 = (t1 === cbbtcAddr) ? 8 : 18;

            const fee0Normalized = Number(unclaimed0) / Math.pow(10, dec0);
            const fee1Normalized = Number(unclaimed1) / Math.pow(10, dec1);

            // 從 BBEngine 取得動態現價（避免硬編碼）
            const wethPrice = bb?.ethPrice || 0;
            const cbbtcPrice = bb?.cbbtcPrice || 0;
            const price0 = (t0 === cbbtcAddr) ? cbbtcPrice : wethPrice;
            const price1 = (t1 === cbbtcAddr) ? cbbtcPrice : wethPrice;

            const unclaimedFeesUSD = (fee0Normalized * price0) + (fee1Normalized * price1);

            // (Moved calculation down below positionValueUSD)

            let overlapPercent = 0;
            let breakevenDays = 0;
            let healthScore = 0;
            let regime = 'Unknown';

            // Convert ticks to human-readable prices: price = 1.0001^tick * 10^(dec0 - dec1)
            const tickToPrice = (t: number) => Math.pow(1.0001, t) * Math.pow(10, dec0 - dec1);

            // Note: If t0 is WETH and t1 is cbBTC, price is cbBTC per WETH (~0.038)
            // If we want WETH per cbBTC, we'd invert it. We'll leave it as Token1/Token0 natively to match DexScreener convention for this pair.
            const minPrice = tickToPrice(Number(position.tickLower)).toFixed(8);
            const maxPrice = tickToPrice(Number(position.tickUpper)).toFixed(8);
            const currentPrice = tickToPrice(poolStats.tick).toFixed(8);

            let bbMinPrice: string | undefined;
            let bbMaxPrice: string | undefined;
            if (bb) {
                // Determine native scaled prices for BB ticks to match minPrice/maxPrice format
                bbMinPrice = tickToPrice(bb.tickLower).toFixed(8);
                bbMaxPrice = tickToPrice(bb.tickUpper).toFixed(8);
            }

            // LP 倉位本金計算：Uniswap V3 sqrtPrice 數學
            // sqrtPrice = sqrtPriceX96 / 2^96 (raw token1/token0 units)
            const sqrtPriceCurrent = Number(poolStats.sqrtPriceX96) / (2 ** 96);
            const sqrtPriceLower = Math.sqrt(Math.pow(1.0001, Number(position.tickLower)));
            const sqrtPriceUpper = Math.sqrt(Math.pow(1.0001, Number(position.tickUpper)));
            const liq = Number(position.liquidity);

            let posAmount0Raw = 0;
            let posAmount1Raw = 0;
            if (sqrtPriceCurrent <= sqrtPriceLower) {
                // 價格低於區間下界：倉位全為 token0
                posAmount0Raw = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
            } else if (sqrtPriceCurrent >= sqrtPriceUpper) {
                // 價格高於區間上界：倉位全為 token1
                posAmount1Raw = liq * (sqrtPriceUpper - sqrtPriceLower);
            } else {
                // 價格在區間內：混合
                posAmount0Raw = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
                posAmount1Raw = liq * (sqrtPriceCurrent - sqrtPriceLower);
            }

            const posAmount0Normalized = posAmount0Raw / Math.pow(10, dec0);
            const posAmount1Normalized = posAmount1Raw / Math.pow(10, dec1);
            const positionValueUSD = posAmount0Normalized * price0 + posAmount1Normalized * price1;

            // PNL = (LP 倉位現值 + 未領手續費) - 初始投入
            const exactIL = PnlCalculator.calculateAbsolutePNL(tokenId, positionValueUSD, unclaimedFeesUSD);

            // Fetch Risk Analysis
            const riskState = {
                capital: 1000, // Mock Capital for now
                tickLower: Number(position.tickLower),
                tickUpper: Number(position.tickUpper),
                unclaimedFees: unclaimedFeesUSD,
                cumulativeIL: exactIL ?? 0,
                feeRate24h: poolStats.apr / 365
            };

            let rebalanceSuggestion: RebalanceSuggestion | undefined;

            if (bb) {
                const risk = RiskManager.analyzePosition(riskState, bb, poolStats.dailyFeesUSD, 0, 0);
                overlapPercent = risk.driftOverlapPct;
                breakevenDays = risk.ilBreakevenDays;
                healthScore = risk.healthScore;
                regime = bb.regime;

                const token0Sym = t0 === cbbtcAddr ? 'cbBTC' : 'WETH';
                const token1Sym = t1 === cbbtcAddr ? 'cbBTC' : 'WETH';

                const rb = RebalanceService.getRebalanceSuggestion(
                    parseFloat(currentPrice),
                    bb,
                    unclaimedFeesUSD,
                    breakevenDays,
                    positionValueUSD,
                    token0Sym,
                    token1Sym
                );
                if (rb) rebalanceSuggestion = rb;
            }

            const record: PositionRecord = {
                tokenId,
                dex,
                poolAddress,
                feeTier: feeTierForStats,
                token0Symbol: t0 === cbbtcAddr ? 'cbBTC' : 'WETH',
                token1Symbol: t1 === cbbtcAddr ? 'cbBTC' : 'WETH',
                ownerWallet: owner,

                liquidity: position.liquidity.toString(),
                tickLower: Number(position.tickLower),
                tickUpper: Number(position.tickUpper),
                minPrice,
                maxPrice,
                bbMinPrice,
                bbMaxPrice,
                currentTick: poolStats.tick,
                currentPriceStr: currentPrice.toString(),
                positionValueUSD,

                unclaimed0: unclaimed0.toString(),
                unclaimed1: unclaimed1.toString(),
                unclaimedFeesUSD,
                collectedFeesUSD: 0, // Needs event listener to track historical collections
                rebalance: rebalanceSuggestion,

                overlapPercent,
                ilUSD: exactIL,
                breakevenDays,
                healthScore,
                regime,

                lastUpdated: Date.now(),
                volSource: poolStats.volSource ?? 'unknown',
                priceSource: bb && !bb.isFallback ? `The Graph / GeckoTerminal` : 'RPC (Fallback)',
                bbFallback: bb ? !!bb.isFallback : true,
            };

            return record;

        } catch (error) {
            log.error(`scan failed  #${tokenId} (${dex}): ${error}`);
            return null;
        }
    }

    /**
     * Helper to find a pool address given two tokens and a fee.
     * Uses Uniswap V3 Factory. (Pancake is similar).
     */
    private static async getPoolFromTokens(tokenA: string, tokenB: string, fee: number, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'): Promise<string | null> {
        // Key = `${dex}_${fee}` 避免不同 DEX 相同 fee tier 碰撞（例如 Uniswap 與 PancakeSwap 都有 fee=500）
        const map: Record<string, string> = {
            'PancakeSwap_100':  config.POOLS?.PANCAKE_WETH_CBBTC_0_01  || '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
            'PancakeSwap_500':  config.POOLS?.PANCAKE_WETH_CBBTC_0_05  || '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
            'Uniswap_500':      config.POOLS?.UNISWAP_WETH_CBBTC_0_05  || '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
            'Uniswap_3000':     config.POOLS?.UNISWAP_WETH_CBBTC_0_3   || '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
            'Aerodrome_85':     config.POOLS?.AERO_WETH_CBBTC_0_0085   || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5',
            'Aerodrome_1':      config.POOLS?.AERO_WETH_CBBTC_0_0085   || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5', // Aerodrome NPM 回傳 tickSpacing 而非 fee
        };
        return map[`${dex}_${fee}`] || null;
    }

    /**
     * Update all tracked positions: re-scan from chain and log snapshots.
     */
    static async updateAllPositions(latestBBs: Record<string, BBResult> = {}) {
        const unsyncedWallets = config.WALLET_ADDRESSES.filter(w => !this.syncedWallets.has(w));
        if (unsyncedWallets.length > 0) {
            log.info(`🔄 ${unsyncedWallets.length} new wallet(s) detected, re-syncing chain`);
            await this.syncFromChain();
        }

        if (this.positions.length === 0) {
            log.info('no tracked positions, skipping update');
            return;
        }

        const updated: PositionRecord[] = [];
        for (const pos of this.positions) {
            const precomputedBB = pos.poolAddress ? latestBBs[pos.poolAddress.toLowerCase()] : undefined;
            const freshData = await this.scanPosition(pos.tokenId, pos.dex, precomputedBB);
            if (freshData) {
                if (Number(freshData.liquidity) === 0) {
                    log.warn(`#${pos.tokenId} on-chain liquidity=0 — position may be closed`);
                }
                updated.push({ ...pos, ...freshData, lastUpdated: Date.now() });
            } else {
                log.warn(`#${pos.tokenId} scan failed, keeping stale record`);
                updated.push(pos);
            }
        }

        this.positions = updated;

        // Log snapshots to dedicated positions.log for historical audit
        this.logPositionSnapshots(updated);

        log.info(`✅ ${updated.length} position(s) refreshed`);
    }
}

// Re-export from OpenTimestampService so stateManager keeps a stable import path.
export { getOpenTimestampSnapshot, restoreOpenTimestamps } from './OpenTimestampService';
