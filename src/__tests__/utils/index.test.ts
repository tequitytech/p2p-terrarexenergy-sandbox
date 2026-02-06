import * as fs from 'fs';
import path from 'path';
import axios, { AxiosError } from 'axios';
import {
    normalizeDomain,
    readDomainResponse,
    parseError,
    calculatePrice,
    calculateTotalAmount,
    PricingModel,
    PriceCalculationParams,
} from '../../utils';

// Mock fs module
jest.mock('fs', () => ({
    readFileSync: jest.fn(),
}));

describe('Utils - normalizeDomain', () => {
    it('should return empty domain as-is', () => {
        expect(normalizeDomain('')).toBe('');
    });

    it('should return null/undefined domain as-is', () => {
        expect(normalizeDomain(null as any)).toBe(null);
        expect(normalizeDomain(undefined as any)).toBe(undefined);
    });

    it('should remove version numbers from domain', () => {
        expect(normalizeDomain('beckn.one:deg:p2p-trading:2.0.0')).toBe('beckn.one:deg:p2p-trading');
        expect(normalizeDomain('example.com:1.0')).toBe('example.com');
        expect(normalizeDomain('test:3.2.1.0')).toBe('test');
    });

    it('should return domain without version as-is', () => {
        expect(normalizeDomain('beckn.one:deg:p2p-trading')).toBe('beckn.one:deg:p2p-trading');
        expect(normalizeDomain('simple-domain')).toBe('simple-domain');
    });
});

describe('Utils - readDomainResponse', () => {
    const mockedReadFileSync = fs.readFileSync as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should read default response path without persona', async () => {
        const mockData = { message: { order: {} } };
        mockedReadFileSync.mockReturnValue(JSON.stringify(mockData));

        const result = await readDomainResponse('energy-domain:1.0', 'on_select');

        expect(result).toEqual(mockData);
        expect(mockedReadFileSync).toHaveBeenCalledWith(
            expect.stringContaining(path.join('energy-domain', 'response', 'on_select.json')),
            'utf-8'
        );
    });

    it('should try persona-specific path first when persona is provided', async () => {
        const mockData = { message: { persona_specific: true } };
        mockedReadFileSync.mockReturnValue(JSON.stringify(mockData));

        const result = await readDomainResponse('energy:2.0', 'on_init', 'buyer');

        expect(result).toEqual(mockData);
        expect(mockedReadFileSync).toHaveBeenCalledWith(
            expect.stringContaining(path.join('energy', 'response', 'buyer', 'on_init.json')),
            'utf-8'
        );
    });

    it('should fallback to default path when persona file not found', async () => {
        const mockData = { message: { default: true } };
        const notFoundError: NodeJS.ErrnoException = new Error('ENOENT');
        notFoundError.code = 'ENOENT';

        mockedReadFileSync
            .mockImplementationOnce(() => { throw notFoundError; })
            .mockReturnValue(JSON.stringify(mockData));

        const result = await readDomainResponse('energy:2.0', 'on_confirm', 'seller');

        expect(result).toEqual(mockData);
        expect(mockedReadFileSync).toHaveBeenCalledTimes(2);
    });

    it('should throw non-ENOENT errors from persona path', async () => {
        const parseError = new Error('Parse error');
        mockedReadFileSync.mockImplementation(() => { throw parseError; });

        await expect(readDomainResponse('domain', 'action', 'persona')).rejects.toThrow('Parse error');
    });

    it('should return empty object when default file not found', async () => {
        const notFoundError: NodeJS.ErrnoException = new Error('ENOENT');
        notFoundError.code = 'ENOENT';
        mockedReadFileSync.mockImplementation(() => { throw notFoundError; });

        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
        const result = await readDomainResponse('missing-domain', 'action');

        expect(result).toEqual({});
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
        consoleSpy.mockRestore();
    });

    it('should throw non-ENOENT errors from default path', async () => {
        const unexpectedError = new Error('Unexpected error');
        (unexpectedError as any).code = 'UNEXPECTED';
        mockedReadFileSync.mockImplementation(() => { throw unexpectedError; });

        await expect(readDomainResponse('domain', 'action')).rejects.toThrow('Unexpected error');
    });
});

describe('Utils - parseError', () => {
    it('should return null for non-Error objects', () => {
        expect(parseError('string error')).toBe(null);
        expect(parseError(null)).toBe(null);
        expect(parseError(undefined)).toBe(null);
        expect(parseError(123)).toBe(null);
        expect(parseError({ message: 'not an error' })).toBe(null);
    });

    it('should return message for regular Error', () => {
        const error = new Error('Regular error message');
        expect(parseError(error)).toBe('Regular error message');
    });

    it('should extract ONIX error message from AxiosError', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        // Create mock AxiosError with ONIX format
        const axiosError = new Error('Request failed') as AxiosError;
        axiosError.isAxiosError = true;
        axiosError.response = {
            status: 500,
            statusText: 'Internal Server Error',
            data: {
                message: {
                    ack: { status: 'NACK' },
                    error: {
                        code: 'Internal Server Error',
                        message: 'ONIX specific error message'
                    }
                }
            },
            headers: {},
            config: {} as any
        };

        // Use axios.isAxiosError to properly identify
        jest.spyOn(require('axios'), 'isAxiosError').mockReturnValue(true);

        const result = parseError(axiosError);
        expect(result).toBe('ONIX specific error message');
        consoleSpy.mockRestore();
    });

    it('should fallback to error.message for AxiosError without ONIX format', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        const axiosError = new Error('Network Error') as AxiosError;
        axiosError.isAxiosError = true;
        axiosError.response = {
            status: 500,
            statusText: 'Internal Server Error',
            data: {},
            headers: {},
            config: {} as any
        };

        jest.spyOn(require('axios'), 'isAxiosError').mockReturnValue(true);

        const result = parseError(axiosError);
        expect(result).toBe('Network Error');
        consoleSpy.mockRestore();
    });
});

describe('Utils - calculatePrice', () => {
    it('should calculate PER_KWH pricing', () => {
        const params: PriceCalculationParams = {
            pricingModel: 'PER_KWH',
            basePrice: 5,
            quantity: 10,
        };
        expect(calculatePrice(params)).toBe(50);
    });

    it('should calculate PER_KWH pricing with wheeling charges', () => {
        const params: PriceCalculationParams = {
            pricingModel: 'PER_KWH',
            basePrice: 5,
            quantity: 10,
            wheelingCharges: 4,
        };
        expect(calculatePrice(params)).toBe(54); // 50 + 4
    });

    it('should calculate FIXED pricing', () => {
        const params: PriceCalculationParams = {
            pricingModel: 'FIXED',
            basePrice: 100,
            quantity: 50, // quantity ignored for FIXED
        };
        expect(calculatePrice(params)).toBe(100);
    });

    it('should calculate SUBSCRIPTION pricing (same as FIXED)', () => {
        const params: PriceCalculationParams = {
            pricingModel: 'SUBSCRIPTION',
            basePrice: 200,
            quantity: 100,
            wheelingCharges: 10,
        };
        expect(calculatePrice(params)).toBe(210); // 200 + 10 wheeling
    });

    it('should calculate TIME_OF_DAY pricing with applicable rate', () => {
        // Mock current hour
        const originalDate = Date;
        const mockDate = new Date('2026-02-05T14:00:00Z'); // 14:00 UTC
        jest.spyOn(global, 'Date').mockImplementation(() => mockDate as any);
        (global.Date as any).now = originalDate.now;

        const params: PriceCalculationParams = {
            pricingModel: 'TIME_OF_DAY',
            basePrice: 5,
            quantity: 10,
            timeOfDayRates: [
                { startTime: '00:00', endTime: '08:00', price: 3 },
                { startTime: '08:00', endTime: '18:00', price: 7 },  // 14:00 falls here
                { startTime: '18:00', endTime: '24:00', price: 5 },
            ],
        };

        const result = calculatePrice(params);
        expect(result).toBe(70); // 7 * 10

        jest.restoreAllMocks();
    });

    it('should fallback to basePrice for TIME_OF_DAY when no applicable rate', () => {
        const mockDate = new Date('2026-02-05T02:00:00Z');
        jest.spyOn(global, 'Date').mockImplementation(() => mockDate as any);

        const params: PriceCalculationParams = {
            pricingModel: 'TIME_OF_DAY',
            basePrice: 5,
            quantity: 10,
            timeOfDayRates: [
                { startTime: '08:00', endTime: '18:00', price: 7 },
            ],
        };

        const result = calculatePrice(params);
        expect(result).toBe(50); // basePrice 5 * 10

        jest.restoreAllMocks();
    });

    it('should fallback to basePrice for TIME_OF_DAY without rates array', () => {
        const params: PriceCalculationParams = {
            pricingModel: 'TIME_OF_DAY',
            basePrice: 5,
            quantity: 10,
        };

        expect(calculatePrice(params)).toBe(50);
    });

    it('should use default calculation for unknown pricing model', () => {
        const params: PriceCalculationParams = {
            pricingModel: 'UNKNOWN' as PricingModel,
            basePrice: 5,
            quantity: 10,
        };

        expect(calculatePrice(params)).toBe(50); // Default: basePrice * quantity
    });
});

describe('Utils - calculateTotalAmount', () => {
    it('should calculate total amount from offer', () => {
        const offer = {
            'beckn:price': { 'schema:price': 5 },
            'beckn:offerAttributes': {
                pricingModel: 'PER_KWH',
            },
        };

        const result = calculateTotalAmount(offer, 10);
        expect(result).toBe(50);
    });

    it('should include wheeling charges from offer attributes', () => {
        const offer = {
            'beckn:price': { 'schema:price': 5 },
            'beckn:offerAttributes': {
                pricingModel: 'PER_KWH',
                wheelingCharges: { amount: 10 },
            },
        };

        const result = calculateTotalAmount(offer, 10);
        expect(result).toBe(60); // 50 + 10
    });

    it('should default to PER_KWH when pricingModel not specified', () => {
        const offer = {
            'beckn:price': { 'schema:price': 3 },
            'beckn:offerAttributes': {},
        };

        const result = calculateTotalAmount(offer, 5);
        expect(result).toBe(15);
    });
});
