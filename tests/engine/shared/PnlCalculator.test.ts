import { PnlCalculator } from '../../../src/engine/shared/PnlCalculator';
import { appState } from '../../../src/infra/AppState';
import { UserConfig } from '../../../src/types';

const mockConfig = (tokenId: string, initial: number): UserConfig => ({
    wallets: [{
        address: '0x1234567890123456789012345678901234567890',
        positions: [{ tokenId, dexType: 'UniswapV3', initial, externalStake: false }],
    }],
});

beforeEach(() => {
    appState.userConfig = mockConfig('123', 1000);
});

describe('PnlCalculator.getInitialCapital', () => {
    it('returns configured capital', () => {
        expect(PnlCalculator.getInitialCapital('123')).toBe(1000);
    });

    it('returns null when not configured', () => {
        expect(PnlCalculator.getInitialCapital('999')).toBeNull();
    });
});

describe('PnlCalculator.calculateAbsolutePNL', () => {
    it('returns null when initial capital is 0', () => {
        appState.userConfig = mockConfig('123', 0);
        expect(PnlCalculator.calculateAbsolutePNL('123', 900, 50)).toBeNull();
    });

    it('calculates correct negative PnL', () => {
        // (900 + 50) - 1000 = -50
        expect(PnlCalculator.calculateAbsolutePNL('123', 900, 50)).toBe(-50);
    });

    it('returns positive PnL when profitable', () => {
        // (1100 + 50) - 1000 = +150
        expect(PnlCalculator.calculateAbsolutePNL('123', 1100, 50)).toBe(150);
    });
});

describe('PnlCalculator.calculateOpenInfo', () => {
    it('returns null when openTimestampMs is undefined', () => {
        expect(PnlCalculator.calculateOpenInfo('123', undefined, -50)).toBeNull();
    });

    it('returns null when openTimestampMs is -1', () => {
        expect(PnlCalculator.calculateOpenInfo('123', -1, -50)).toBeNull();
    });

    it('returns correct days and hours', () => {
        const twoDaysAgo = Date.now() - 2 * 86400000 - 3 * 3600000;
        const info = PnlCalculator.calculateOpenInfo('123', twoDaysAgo, -50);
        expect(info).not.toBeNull();
        expect(info!.days).toBe(2);
        expect(info!.hours).toBe(3);
    });

    it('calculates profitRate when capital is set', () => {
        const oneHourAgo = Date.now() - 3600000;
        // ilUSD = -50, capital = 1000 → profitRate = -5%
        const info = PnlCalculator.calculateOpenInfo('123', oneHourAgo, -50);
        expect(info!.profitRate).toBeCloseTo(-5, 1);
    });

    it('returns null profitRate when ilUSD is null', () => {
        const oneHourAgo = Date.now() - 3600000;
        const info = PnlCalculator.calculateOpenInfo('123', oneHourAgo, null);
        expect(info!.profitRate).toBeNull();
    });
});

describe('PnlCalculator.calculatePortfolioSummary', () => {
    it('returns zeros for empty positions', () => {
        const s = PnlCalculator.calculatePortfolioSummary([]);
        expect(s.positionCount).toBe(0);
        expect(s.totalPnL).toBeNull();
        expect(s.totalPositionUSD).toBe(0);
    });

    it('counts unique wallets', () => {
        const positions = [
            { tokenId: '1', ownerWallet: '0x1234567890123456789012345678901234567890', positionValueUSD: 500, unclaimedFeesUSD: 10, ilUSD: null },
            { tokenId: '2', ownerWallet: '0x1234567890123456789012345678901234567890', positionValueUSD: 500, unclaimedFeesUSD: 10, ilUSD: null },
        ];
        const s = PnlCalculator.calculatePortfolioSummary(positions);
        expect(s.walletCount).toBe(1);
        expect(s.positionCount).toBe(2);
    });

    it('aggregates totalPnL from positions with ilUSD', () => {
        appState.userConfig = {
            wallets: [{
                address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                positions: [
                    { tokenId: 'a', dexType: 'UniswapV3', initial: 1000, externalStake: false },
                    { tokenId: 'b', dexType: 'UniswapV3', initial: 2000, externalStake: false },
                ],
            }],
        };
        const positions = [
            { tokenId: 'a', ownerWallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', positionValueUSD: 900, unclaimedFeesUSD: 10, ilUSD: -50 },
            { tokenId: 'b', ownerWallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', positionValueUSD: 1900, unclaimedFeesUSD: 20, ilUSD: 100 },
        ];
        const s = PnlCalculator.calculatePortfolioSummary(positions);
        expect(s.totalPnL).toBe(50);
        expect(s.totalPnLPct).toBeCloseTo(50 / 3000 * 100, 4);
    });

    it('totalPnL is null when no position has ilUSD', () => {
        const positions = [
            { tokenId: '1', ownerWallet: '0x1234567890123456789012345678901234567890', positionValueUSD: 500, unclaimedFeesUSD: 10, ilUSD: null },
        ];
        expect(PnlCalculator.calculatePortfolioSummary(positions).totalPnL).toBeNull();
    });
});
