import { ILCalculatorService } from '../src/services/ILCalculator';
import { config } from '../src/config';

// Mock config
jest.mock('../src/config', () => ({
    config: {
        INITIAL_INVESTMENT_USD: {
            '1': 10000,
            '2': 5000,
            // '3' is intentionally missing to test undefined behavior
            '4': 0 // Intentionally 0
        }
    }
}));

describe('ILCalculatorService', () => {
    it('should return null if tokenId is not found in config', () => {
        const result = ILCalculatorService.calculateAbsolutePNL('3', 1000, 100);
        expect(result).toBeNull();
    });

    it('should return null if initial investment is 0', () => {
        const result = ILCalculatorService.calculateAbsolutePNL('4', 1000, 100);
        expect(result).toBeNull();
    });

    it('should correctly calculate positive absolute PNL (profit)', () => {
        // Initial investment: $10,000
        // Live Position Value: $11,000
        // Unclaimed Fees: $500
        // Net Worth = $11,500
        // PNL = $11,500 - $10,000 = +$1,500
        const result = ILCalculatorService.calculateAbsolutePNL('1', 11000, 500);
        expect(result).toBe(1500);
    });

    it('should correctly calculate negative absolute PNL (loss)', () => {
        // Initial investment: $5,000
        // Live Position Value: $3,000
        // Unclaimed Fees: $200
        // Net Worth = $3,200
        // PNL = $3,200 - $5,000 = -$1,800
        const result = ILCalculatorService.calculateAbsolutePNL('2', 3000, 200);
        expect(result).toBe(-1800);
    });

    it('should correctly calculate zero absolute PNL (breakeven)', () => {
        // Initial investment: $5,000
        // Live Position Value: $4,800
        // Unclaimed Fees: $200
        // Net Worth = $5,000
        // PNL = $5,000 - $5,000 = $0
        const result = ILCalculatorService.calculateAbsolutePNL('2', 4800, 200);
        expect(result).toBe(0);
    });
});
