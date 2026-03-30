/**
 * dryrun.ts — One-shot scan without starting the Telegram bot or cron scheduler.
 * Useful for verifying config, RPC connectivity, and data pipeline output.
 *
 * Usage: npm run dryrun
 */
import { positionScanner } from './services/position/PositionScanner';
import { prefetchAll } from './runners/prefetch';
import { computeAll } from './runners/compute';
import { appState } from './utils/AppState';
import { createServiceLogger } from './utils/logger';

const log = createServiceLogger('Dryrun');

async function main() {
    log.section('DexBot dryrun — single-pass scan (no Telegram, no cron)');

    // 1. Sync positions from chain
    log.info('Syncing positions from chain...');
    await positionScanner.syncFromChain();

    // 2. Prefetch (Phase 0) — token prices, pools, BBs, raw positions, fees, gas
    log.info('Running prefetchAll...');
    const data = await prefetchAll();
    if (!data) {
        log.error('prefetchAll failed — aborting dryrun');
        process.exit(1);
    }

    // 3. Compute (Phase 1) — aggregate, PnL, risk, rebalance
    log.info('Running computeAll...');
    const result = computeAll(data);
    positionScanner.updatePositions(result.positions);
    appState.commit(data, { positions: positionScanner.getTrackedPositions() });

    // 4. Print results
    log.info('Results:');
    for (const pos of appState.positions) {
        const poolData = data.pools.find(
            p => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
        );
        const bb = data.marketSnapshots[pos.poolAddress.toLowerCase()];
        const risk = pos.riskAnalysis;
        const label = poolData
            ? `${poolData.dex} ${(poolData.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`
            : pos.dex;
        const walletShort = pos.ownerWallet
            ? `${pos.ownerWallet.slice(0, 6)}...${pos.ownerWallet.slice(-4)}`
            : '?';
        log.info(
            `[#${pos.tokenId}] ${label} | ${walletShort}\n` +
            `  Value $${pos.positionValueUSD.toFixed(0)} | APR ${poolData ? (poolData.apr * 100).toFixed(1) : '?'}% | Health ${risk?.healthScore ?? '?'}/100\n` +
            `  Price ${pos.currentPriceStr} | Range ${pos.minPrice}~${pos.maxPrice}\n` +
            `  BB    ${pos.bbMinPrice ?? '?'}~${pos.bbMaxPrice ?? '?'} | ${bb?.regime ?? '?'}\n` +
            `  Unclaimed $${pos.unclaimedFeesUSD.toFixed(1)} | IL ${pos.ilUSD === null ? 'N/A' : `$${pos.ilUSD.toFixed(1)}`}\n` +
            `  Breakeven ${risk?.ilBreakevenDays ?? '?'}d | Compound ${risk?.compoundSignal ? 'YES' : 'no'}`
        );
    }

    log.section('dryrun complete');
}

main().catch(e => {
    console.error('Dryrun failed:', e);
    process.exit(1);
});
