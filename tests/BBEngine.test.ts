import { BBEngine } from '../src/services/BBEngine';
import axios from 'axios';
import { nearestUsableTick } from '@uniswap/v3-sdk';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BBEngine', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('createFallbackBB', () => {
        it('generates a valid fallback BB using pure math', async () => {
            // Calling computeDynamicBB with axios throwing should trigger fallback
            mockedAxios.get.mockRejectedValue(new Error('API Down'));

            const currentTick = 200000;
            const tickSpacing = 200;

            const result = await BBEngine.computeDynamicBB('0xPool', 'Uniswap', tickSpacing, currentTick);

            expect(result).toBeDefined();
            expect(result!.isFallback).toBe(true);
            expect(result!.k).toBe(2.0);
            expect(result!.volatility30D).toBe(0.5); // Fallback assumption

            // Fallback forces bounds to be ±1000 raw ticks, then snapped to tickSpacing
            const expectedLower = nearestUsableTick(200000 - 1000, 200);
            const expectedUpper = nearestUsableTick(200000 + 1000, 200);

            expect(result!.tickLower).toBe(expectedLower);
            expect(result!.tickUpper).toBe(expectedUpper);
        });
    });

    describe('computeDynamicBB with mocked API data', () => {
        it('computes dynamic BB ranges correctly', async () => {
            // Mock daily vol (GeckoTerminal) - this gets triggered inside fetchDailyVol
            // Mock hourly prices (GeckoTerminal) - this gets triggered inside backfill
            // Mock DexScreener WETH price

            // We will provide a uniform fake response for both hourly and daily because the mock is simple
            // Or we can mock by URL inclusion
            mockedAxios.get.mockImplementation(async (url: string) => {
                if (url.includes('ohlcv/day')) {
                    // Generate 30 days of flat prices to produce 0 variance => 0% Volatility
                    const data = { data: { attributes: { ohlcv_list: Array(30).fill([167000000, 100, 100, 100, 100, 1000]) } } };
                    return { data };
                }
                if (url.includes('ohlcv/hour')) {
                    // Generate 24 hours of slightly vibrating prices to produce some SMA
                    // Let's just return flat 100
                    const data = { data: { attributes: { ohlcv_list: Array(30).fill([167000000, 100, 100, 100, 100, 1000]) } } };
                    return { data };
                }
                if (url.includes('dexscreener')) {
                    return { data: { pairs: [{ priceUsd: '3000' }] } };
                }
                return { data: {} };
            });

            const currentTick = 200000; // price ~4.85e8
            // Note: Because we are combining API historical data (100) and live tick price (4.85e8),
            // there will be a huge SMA displacement. But the math should still execute.
            const result = await BBEngine.computeDynamicBB('0xTestPool', 'Uniswap', 200, currentTick);

            expect(result).toBeDefined();
            expect(result!.isFallback).toBeUndefined(); // Should not be fallback

            // Since it's flat data (low volatility), K should drop to 1.2
            // Volatility is calculated over flat 100s, so vol = 0
            expect(mockedAxios.get).toHaveBeenCalled();
            expect(result!.k).toBe(1.2);
            expect(result!.regime).toBe('Low Vol (震盪市)');
        });
    });
});
