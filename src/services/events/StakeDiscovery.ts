import { ethers } from 'ethers';
import { config } from '../../config';
import { appState, ucWalletAddresses, ucUpsertPosition, ucPoolList } from '../../utils/AppState';
import { createServiceLogger } from '../../utils/logger';
import { rpcRetry, nextProvider } from '../../utils/rpcProvider';

const log = createServiceLogger('StakeDiscovery');

export class StakeDiscovery {

    /**
     * 掃描 ERC-721 Transfer(from=wallet, to=stakingContract) 事件，自動發現質押倉位。
     * 所有錢包合併為單次 OR-filter getLogs 掃描，避免 N 錢包 × M chunks 的重複消耗。
     * 採增量掃描：首次用 STAKE_DISCOVERY_LOOKBACK_BLOCKS（約 3 天），之後只掃新 block。
     */
    async scan(walletAddresses: string[], closedTokenIds: Set<string>): Promise<void> {
        if (walletAddresses.length === 0) return;
        await this._scanAllWallets(walletAddresses, closedTokenIds);
    }

    private async _scanAllWallets(walletAddresses: string[], closedTokenIds: Set<string>): Promise<void> {
        const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

        let latestBlock: number;
        try {
            latestBlock = await rpcRetry(() => nextProvider().getBlockNumber(), 'getBlockNumber');
        } catch {
            log.warn(`StakeDiscovery: getBlockNumber failed, skipping`);
            return;
        }

        // 所有錢包取最早的 fromBlock，統一掃描範圍
        const fromBlock = walletAddresses.reduce((min, w) => {
            const last = appState.stakeDiscoveryLastBlock[w.toLowerCase()] ?? 0;
            const from = last > 0
                ? last + 1
                : Math.max(0, latestBlock - config.STAKE_DISCOVERY_LOOKBACK_BLOCKS);
            return Math.min(min, from);
        }, Infinity);

        if (fromBlock > latestBlock) return;

        const paddedWallets = walletAddresses.map(w => ethers.zeroPadValue(w.toLowerCase(), 32));
        // topic1（from）→ 錢包地址映射，用於掃描結果分配
        const walletByPadded = new Map(
            walletAddresses.map(w => [ethers.zeroPadValue(w.toLowerCase(), 32).toLowerCase(), w])
        );

        const totalBlocks = latestBlock - fromBlock + 1;
        const walletLabel = walletAddresses.map(w => w.slice(0, 8) + '…').join(', ');
        log.info(`🔍 StakeDiscovery: 掃描 [${walletLabel}]，block ${fromBlock.toLocaleString()}–${latestBlock.toLocaleString()}（共 ${totalBlocks.toLocaleString()} blocks）`);

        // 樂觀標記：掃描開始前先寫入 latestBlock，確保 gracefulShutdown 能存到最新進度
        for (const w of walletAddresses) {
            appState.stakeDiscoveryLastBlock[w.toLowerCase()] = latestBlock;
        }

        const knownIds = new Set(
            appState.userConfig.wallets.flatMap(w => w.positions.map(p => p.tokenId))
        );
        let newFound = 0;

        // ── PancakeSwap V3 → MasterChef ──────────────────────────────────────
        const mcAddress = config.PANCAKE_MASTERCHEF_V3;
        const pancakeNpm = config.NPM_ADDRESSES['PancakeSwapV3'];
        if (mcAddress && pancakeNpm) {
            const paddedMC = ethers.zeroPadValue(mcAddress.toLowerCase(), 32);
            const logs = await this._getLogsChunked(
                pancakeNpm, [TRANSFER_TOPIC, paddedWallets, paddedMC],
                fromBlock, latestBlock, `PancakeStake [${walletLabel}]`,
            );
            for (const entry of logs) {
                const tokenId = BigInt(entry.topics[3]).toString();
                if (closedTokenIds.has(tokenId) || knownIds.has(tokenId)) continue;
                const ownerWallet = walletByPadded.get(entry.topics[1].toLowerCase());
                if (!ownerWallet) continue;
                try {
                    const mc = new ethers.Contract(mcAddress, config.PANCAKE_MASTERCHEF_V3_ABI, nextProvider());
                    const info = await mc.userPositionInfos(tokenId);
                    if (info.user.toLowerCase() !== ownerWallet.toLowerCase()) continue;
                } catch (e: any) {
                    log.warn(`StakeDiscovery: userPositionInfos(#${tokenId}) failed — ${e.message?.slice(0, 80)}`);
                    continue;
                }
                log.info(`🔍 #${tokenId} 自動偵測質押（PancakeSwapV3 MasterChef @ ${ownerWallet.slice(0, 8)}…）`);
                appState.userConfig = ucUpsertPosition(appState.userConfig, ownerWallet, tokenId, { dexType: 'PancakeSwapV3', externalStake: true });
                knownIds.add(tokenId);
                newFound++;
            }
        }

        // ── Aerodrome → Gauge ────────────────────────────────────────────────
        const aeroNpm = config.NPM_ADDRESSES['Aerodrome'];
        if (aeroNpm) {
            const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
            const aeroPools = ucPoolList(appState.userConfig).filter(p => p.dex === 'Aerodrome');
            const gaugeAddresses: string[] = [];
            for (const pool of aeroPools) {
                try {
                    const gauge: string = await voter.gauges(pool.address);
                    if (gauge && gauge !== ethers.ZeroAddress) gaugeAddresses.push(gauge.toLowerCase());
                } catch {}
            }
            if (gaugeAddresses.length > 0) {
                const paddedGauges = gaugeAddresses.map(g => ethers.zeroPadValue(g, 32));
                const logs = await this._getLogsChunked(
                    aeroNpm, [TRANSFER_TOPIC, paddedWallets, paddedGauges],
                    fromBlock, latestBlock, `AeroStake [${walletLabel}]`,
                );
                for (const entry of logs) {
                    const tokenId = BigInt(entry.topics[3]).toString();
                    if (closedTokenIds.has(tokenId) || knownIds.has(tokenId)) continue;
                    const ownerWallet = walletByPadded.get(entry.topics[1].toLowerCase());
                    if (!ownerWallet) continue;
                    const gaugeAddr = ethers.getAddress('0x' + entry.topics[2].slice(26));
                    try {
                        const gauge = new ethers.Contract(gaugeAddr, config.AERO_GAUGE_ABI, nextProvider());
                        const isStaked: boolean = await gauge.stakedContains(ownerWallet, BigInt(tokenId));
                        if (!isStaked) continue;
                    } catch (e: any) {
                        log.warn(`StakeDiscovery: stakedContains(#${tokenId}) failed — ${e.message?.slice(0, 80)}`);
                        continue;
                    }
                    log.info(`🔍 #${tokenId} 自動偵測質押（Aerodrome Gauge ${gaugeAddr.slice(0, 10)} @ ${ownerWallet.slice(0, 8)}…）`);
                    appState.userConfig = ucUpsertPosition(appState.userConfig, ownerWallet, tokenId, { dexType: 'Aerodrome', externalStake: true });
                    knownIds.add(tokenId);
                    newFound++;
                }
            }
        }

        log.info(`🔍 StakeDiscovery 完成${newFound > 0 ? `，新增 ${newFound} 質押倉位` : '，未發現新質押倉位'}`);
    }

    /**
     * getLogs 分塊掃描，連續失敗超過 3 次即中止。
     */
    private async _getLogsChunked(
        address: string,
        topics: (string | string[])[],
        fromBlock: number,
        toBlock: number,
        label = 'getLogs',
    ): Promise<ethers.Log[]> {
        const results: ethers.Log[] = [];
        let consecutiveFailures = 0;
        const totalBlocks = toBlock - fromBlock + 1;
        let lastProgressLog = fromBlock;
        const PROGRESS_INTERVAL = 10_000;
        for (let from = fromBlock; from <= toBlock; from += config.BLOCK_SCAN_CHUNK) {
            const to = Math.min(from + config.BLOCK_SCAN_CHUNK - 1, toBlock);
            try {
                const chunk = await rpcRetry(
                    () => nextProvider().getLogs({ address, topics, fromBlock: from, toBlock: to }),
                    `getLogs(${from}-${to})`,
                );
                results.push(...chunk);
                consecutiveFailures = 0;
            } catch (e: any) {
                consecutiveFailures++;
                log.warn(`_getLogsChunked ${from}–${to} failed (${consecutiveFailures}/3): ${e.message.slice(0, 80)}`);
                if (consecutiveFailures >= 3) break;
            }
            if (to - lastProgressLog >= PROGRESS_INTERVAL) {
                const scanned = to - fromBlock + 1;
                const pct = Math.floor(scanned / totalBlocks * 100);
                log.info(`🔍 ${label}: ${scanned.toLocaleString()}/${totalBlocks.toLocaleString()} blocks (${pct}%)`);
                lastProgressLog = to;
            }
        }
        return results;
    }
}
