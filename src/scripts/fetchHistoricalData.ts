import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('FetchHistorical');

// WETH/cbBTC on Base (Uniswap 0.05% fee tier)
const TARGET_POOL = '0x7aea2e8a3843516afa07293a10ac8e49906dabd1';
const OUTPUT_DIR = path.join(__dirname, '../../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'historical_weth_cbbtc_1H.json');

async function run() {
    try {
        log.info(`Fetching 1000 hours of OHLCV data for pool ${TARGET_POOL} from GeckoTerminal...`);
        // We can fetch up to 1000 data points via free tier.
        const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${TARGET_POOL}/ohlcv/hour?limit=1000`;

        const res = await axios.get(url, { timeout: 15000 });

        if (res.data?.data?.attributes?.ohlcv_list) {
            const ohlcvList = res.data.data.attributes.ohlcv_list;
            // GeckoTerminal format: [timestamp, open, high, low, close, volume] (newest first)
            // Reverse it to be oldest first for chronological backtesting
            const sortedList = ohlcvList.reverse();

            await fs.ensureDir(OUTPUT_DIR);
            await fs.writeJson(OUTPUT_FILE, sortedList, { spaces: 2 });
            log.info(`✅ Successfully saved ${sortedList.length} hours of historical data to ${OUTPUT_FILE}`);
            log.info(`Data spanning from ${new Date(sortedList[0][0] * 1000).toISOString()} to ${new Date(sortedList[sortedList.length - 1][0] * 1000).toISOString()}`);
        } else {
            log.error('Unexpected response format from GeckoTerminal:', res.data);
        }
    } catch (error: any) {
        log.error(`Failed to fetch historical data: ${error.message}`);
        if (error.response?.status === 429) {
            log.warn('GeckoTerminal Rate Limit Exceeded (429). Try again later.');
        }
    }
}

run();
