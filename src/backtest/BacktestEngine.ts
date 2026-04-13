import fs from 'fs-extra';
import path from 'path';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('BacktestEngine');

const DATA_FILE = path.join(__dirname, '../../data/historical_weth_cbbtc_1H.json');
const INITIAL_CAPITAL = 10000;
const GAS_FEE_USD = 0.5; // Gas fee per rebalance on Base (exaggerated slightly for safety)
const ASSUMED_APR = 0.40; // Flat 40% APR while in range

// Helper: Calculate 20 SMA
function calculateSMA(prices: number[]): number {
    return prices.reduce((a, b) => a + b, 0) / prices.length;
}

// Helper: Calculate standard deviation
function calculateStdDev(prices: number[], sma: number): number {
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / prices.length;
    return Math.sqrt(variance);
}

// Constant product formula for IL
function calculatePositionValueWithoutFees(initialPrice: number, currentPrice: number, initialCapital: number): number {
    // 50/50 split at start
    const amount0 = (initialCapital / 2) / initialPrice;
    const amount1 = (initialCapital / 2); // Assuming Quote Token (USD/WETH value equivalent proxy)

    // Constant product IL formula: V = 2 * sqrt(P * P_init) * (Initial_Capital / (2 * P_init))
    // Simplified HODL value:
    const hodlValue = (amount0 * currentPrice) + amount1;

    // LP Position Value (assuming full range for simplicity in backtest IL drag)
    const priceRatio = currentPrice / initialPrice;
    const lpValue = initialCapital * Math.sqrt(priceRatio); // Classic IL

    return lpValue;
}

async function runBacktest() {
    log.info('Starting Historical Backtest...');

    if (!fs.existsSync(DATA_FILE)) {
        log.error(`Data file not found at ${DATA_FILE}. Run fetchHistoricalData.ts first.`);
        return;
    }

    // [timestamp, open, high, low, close, volume]
    const history: number[][] = await fs.readJson(DATA_FILE);
    if (history.length < 50) {
        log.error('Not enough data points to run backtest.');
        return;
    }

    log.info(`Loaded ${history.length} hours of historical data.`);

    let capital = INITIAL_CAPITAL;
    let hodlCapitalToken0 = 0;
    let hodlCapitalToken1 = 0;
    let accumulatedFeesUSD = 0;
    let rebalanceCount = 0;

    let currentLowerBound = 0;
    let currentUpperBound = 0;
    let lastRebalancePrice = 0;
    let currentK = 1.8;

    const startIdx = 20;

    // Initialize HODL portfolio
    const startPrice = history[startIdx][4];
    hodlCapitalToken0 = (INITIAL_CAPITAL / 2) / startPrice;
    hodlCapitalToken1 = INITIAL_CAPITAL / 2;
    lastRebalancePrice = startPrice;

    // Initial BB calculation
    const initialPast20 = history.slice(0, 20).map(c => c[4]);
    const initSma = calculateSMA(initialPast20);
    const initStd = calculateStdDev(initialPast20, initSma);
    currentLowerBound = initSma - (currentK * initStd);
    currentUpperBound = initSma + (currentK * initStd);

    log.info(`[T=0] Start Price: $${startPrice.toFixed(4)}. Bot Capital: $${capital}. HODL Capital: $${INITIAL_CAPITAL}`);

    for (let i = startIdx; i < history.length; i++) {
        const candle = history[i];
        const currentPrice = candle[4];

        // 1. Accumulate Fees if inside range
        if (currentPrice >= currentLowerBound && currentPrice <= currentUpperBound) {
            const hourlyFee = capital * (ASSUMED_APR / 365 / 24);
            accumulatedFeesUSD += hourlyFee;
        }

        // 2. Check for Rebalance Trigger (Drift > Bounds)
        if (currentPrice < currentLowerBound || currentPrice > currentUpperBound) {
            // Suffer Impermanent Loss since last rebalance
            const realizedPositionValue = calculatePositionValueWithoutFees(lastRebalancePrice, currentPrice, capital);

            // Rebalance cost + slippage
            capital = realizedPositionValue - GAS_FEE_USD;
            rebalanceCount++;

            // Regenerate Bounds based on new position
            const past20 = history.slice(i - 20, i).map(c => c[4]);
            const sma = calculateSMA(past20);
            const std = calculateStdDev(past20, sma);

            // Adjust K slightly based on volatility state (simplistic)
            const volPct = std / sma;
            currentK = volPct > 0.05 ? 1.8 : 1.2; // High vol -> wider band

            currentLowerBound = sma - (currentK * std);
            currentUpperBound = sma + (currentK * std);
            lastRebalancePrice = currentPrice;

            // log.info(`[Hour ${i}] Rebalanced at $${currentPrice.toFixed(4)}. New Capital: $${capital.toFixed(2)}`);
        }
    }

    const finalPrice = history[history.length - 1][4];
    const finalLPValue = calculatePositionValueWithoutFees(lastRebalancePrice, finalPrice, capital);
    const finalTotalBotValue = finalLPValue + accumulatedFeesUSD;

    const finalHODLValue = (hodlCapitalToken0 * finalPrice) + hodlCapitalToken1;

    log.info('=== BACKTEST SUMMARY ===');
    log.info(`Duration: ${history.length - startIdx} Hours (~${((history.length - startIdx) / 24).toFixed(1)} Days)`);
    log.info(`Initial Investment: $${INITIAL_CAPITAL.toFixed(2)}`);
    log.info(`Flat APR Yield Assumed: ${(ASSUMED_APR * 100).toFixed(1)}%`);
    log.info(`Total Rebalances Executed: ${rebalanceCount}`);
    log.info(`Total Gas/Slippage Paid: $${(rebalanceCount * GAS_FEE_USD).toFixed(2)}`);
    log.info('------------------------');
    log.info(`Pure HODL (50/50) Final Value:  $${finalHODLValue.toFixed(2)}`);
    log.info(`LP Bot Final Net Worth:         $${finalTotalBotValue.toFixed(2)}`);
    log.info(`  ↳ Position Value (with IL):   $${finalLPValue.toFixed(2)}`);
    log.info(`  ↳ Accumulated Fees:           $${accumulatedFeesUSD.toFixed(2)}`);

    const botNetProfit = finalTotalBotValue - INITIAL_CAPITAL;
    const hodlNetProfit = finalHODLValue - INITIAL_CAPITAL;
    const botOutperformance = finalTotalBotValue - finalHODLValue;

    log.info('------------------------');
    log.info(`LP Bot ROI: ${((botNetProfit / INITIAL_CAPITAL) * 100).toFixed(2)}%`);
    log.info(`HODL ROI:   ${((hodlNetProfit / INITIAL_CAPITAL) * 100).toFixed(2)}%`);
    log.info(`Bot vs HODL: ${botOutperformance >= 0 ? '+' : ''}$${botOutperformance.toFixed(2)}`);
}

runBacktest();
