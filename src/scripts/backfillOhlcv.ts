/**
 * backfillOhlcv.ts — 一次性回填所有 POOLS 的 150 天 1H OHLCV
 *
 * Usage: npx ts-node src/scripts/backfillOhlcv.ts
 */

import { syncHistoricalData, loadOhlcvStore } from '../market/HistoricalDataService';
import { config } from '../config';
import { createServiceLogger } from '../infra/logger';

const log = createServiceLogger('Backfill');

async function main() {
    if (!config.COINGECKO_API_KEY) {
        log.error('COINGECKO_API_KEY 未設定，請在 .env 中加入');
        process.exit(1);
    }

    const pools = config.POOLS;
    log.info(`開始回填 ${pools.length} 個池子的歷史 OHLCV（目標 ${config.HISTORICAL_BACKFILL_DAYS} 天）`);

    for (const pool of pools) {
        log.info(`── ${pool.dex} ${pool.address.slice(0, 10)}…`);
        const candles = await syncHistoricalData(pool.address);
        const store = await loadOhlcvStore(pool.address);
        const count = store?.candles.length ?? 0;
        const target = config.HISTORICAL_BACKFILL_DAYS * 24;
        const status = count >= target ? '✅' : `⚠️ ${count}/${target}`;
        log.info(`  ${status} ${count} 根蠟燭`);
    }

    log.info('回填完成');
}

main().catch(e => { console.error('Backfill failed:', e); process.exit(1); });
