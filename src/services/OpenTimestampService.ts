import { ethers } from 'ethers';
import { createServiceLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay } from '../utils/rpcProvider';

const logger = createServiceLogger('OpenTimestampService');

// `${tokenId}_${dex}` → open timestamp (ms)
const cache = new Map<string, number>();

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const FROM_ZERO_TOPIC = ethers.zeroPadValue(ethers.ZeroAddress, 32);
const CHUNK = 2_000;
const LOOKBACK = 25_000_000;

export interface TimestampRequest {
    tokenId: string;
    npmAddress: string;
    dex: string;
}

export class OpenTimestampService {
    /**
     * Fetch open timestamps for all given positions.
     * Groups tokenIds by NPM contract — each NPM gets ONE backward scan with all
     * its tokenIds batched into a single `topics[3]` OR filter, eliminating the
     * N-scans-per-wallet problem.
     *
     * Already-cached tokenIds are skipped.
     * Returns a map of `${tokenId}_${dex}` → timestamp (ms).
     */
    static async fetchAll(requests: TimestampRequest[]): Promise<Record<string, number>> {
        // Skip already-cached
        const pending = requests.filter(r => !cache.has(`${r.tokenId}_${r.dex}`));

        if (pending.length === 0) {
            logger.info('all open timestamps already cached');
        } else {
            // Group by NPM address
            const byNpm = new Map<string, TimestampRequest[]>();
            for (const r of pending) {
                const key = r.npmAddress.toLowerCase();
                if (!byNpm.has(key)) byNpm.set(key, []);
                byNpm.get(key)!.push(r);
            }

            for (const [npmAddress, group] of byNpm.entries()) {
                await this.scanNpm(npmAddress, group);
            }
        }

        // Collect results from cache
        const result: Record<string, number> = {};
        for (const r of requests) {
            const key = `${r.tokenId}_${r.dex}`;
            if (cache.has(key)) result[key] = cache.get(key)!;
        }
        return result;
    }

    private static async scanNpm(npmAddress: string, group: TimestampRequest[]) {
        // Build a map: tokenIdTopic → request (for O(1) lookup when logs arrive)
        const pendingMap = new Map<string, TimestampRequest>();
        for (const r of group) {
            const topic = ethers.zeroPadValue(ethers.toBeHex(BigInt(r.tokenId)), 32);
            pendingMap.set(topic, r);
        }
        const allTopics = Array.from(pendingMap.keys());

        logger.info(`⛓  scanning ${group.length} tokenId(s) on NPM ${npmAddress.slice(0, 10)}…`);

        let currentBlock: number;
        try {
            currentBlock = await rpcRetry(() => rpcProvider.getBlockNumber(), 'getBlockNumber');
        } catch (e: any) {
            logger.warn(`getBlockNumber failed: ${e.message}`);
            return;
        }

        const startBlock = Math.max(0, currentBlock - LOOKBACK);

        for (let toBlock = currentBlock; toBlock >= startBlock && pendingMap.size > 0; toBlock -= CHUNK) {
            const fromBlock = Math.max(startBlock, toBlock - CHUNK + 1);
            try {
                const logs = await rpcProvider.getLogs({
                    address: npmAddress,
                    topics: [TRANSFER_TOPIC, FROM_ZERO_TOPIC, null, allTopics],
                    fromBlock,
                    toBlock,
                });

                for (const entry of logs) {
                    const tokenIdTopic = entry.topics[3];
                    const req = pendingMap.get(tokenIdTopic);
                    if (!req) continue;

                    const block = await rpcRetry(
                        () => rpcProvider.getBlock(entry.blockNumber),
                        `getBlock(${entry.blockNumber})`
                    );
                    if (block) {
                        const tsMs = block.timestamp * 1000;
                        const cacheKey = `${req.tokenId}_${req.dex}`;
                        cache.set(cacheKey, tsMs);
                        pendingMap.delete(tokenIdTopic);
                        logger.info(`💾 #${req.tokenId} opened at block ${block.number} (${new Date(tsMs).toISOString().slice(0, 10)})`);
                    }
                }
            } catch (e: any) {
                logger.warn(`chunk ${fromBlock}–${toBlock} failed: ${e.message}`);
            }
            await delay(50);
        }

        if (pendingMap.size > 0) {
            const missing = Array.from(pendingMap.values()).map(r => `#${r.tokenId}`).join(', ');
            logger.warn(`${pendingMap.size} tokenId(s) not found within last ${LOOKBACK} blocks: ${missing}`);
        }
    }
}

/** Export cache snapshot for state persistence. */
export function getOpenTimestampSnapshot(): Record<string, number> {
    return Object.fromEntries(cache.entries());
}

/** Restore cache from a persisted snapshot. */
export function restoreOpenTimestamps(data: Record<string, number>) {
    for (const [k, v] of Object.entries(data)) {
        cache.set(k, v);
    }
}
