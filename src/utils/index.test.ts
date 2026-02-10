import { AxiosError, AxiosHeaders } from 'axios';

import {
  normalizeDomain,
  parseError,
  calculatePrice,
  calculateTotalAmount,
  PriceCalculationParams,
} from './index';

// ============================================
// normalizeDomain
// ============================================

describe('normalizeDomain', () => {
  it('should return domain unchanged when no port', () => {
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('should strip port number from domain', () => {
    expect(normalizeDomain('example.com:8082')).toBe('example.com');
  });

  it('should strip multi-segment port (e.g., :8082.1.0)', () => {
    expect(normalizeDomain('example.com:8082.1.0')).toBe('example.com');
  });

  it('should return empty string as-is', () => {
    expect(normalizeDomain('')).toBe('');
  });

  it('should return falsy domain as-is', () => {
    // The function checks `if (!domain)` and returns domain
    expect(normalizeDomain(undefined as any)).toBeUndefined();
    expect(normalizeDomain(null as any)).toBeNull();
  });
});

// ============================================
// parseError
// ============================================

describe('parseError', () => {
  it('should return null for non-Error input', () => {
    expect(parseError('some string')).toBeNull();
    expect(parseError(42)).toBeNull();
    expect(parseError(null)).toBeNull();
    expect(parseError(undefined)).toBeNull();
    expect(parseError({ foo: 'bar' })).toBeNull();
  });

  it('should return message string for plain Error', () => {
    expect(parseError(new Error('something broke'))).toBe('something broke');
  });

  it('should extract ONIX error.message from AxiosError response.data.message.error.message', () => {
    const axiosError = new AxiosError(
      'Request failed',
      '500',
      undefined,
      undefined,
      {
        status: 500,
        statusText: 'Internal Server Error',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {
          message: {
            ack: { status: 'NACK' },
            error: {
              code: 'Internal Server Error',
              message: 'Internal server error, MessageID: test-123',
            },
          },
        },
      }
    );

    expect(parseError(axiosError)).toBe(
      'Internal server error, MessageID: test-123'
    );
  });

  it('should fall back to error.message when AxiosError has no ONIX error structure', () => {
    const axiosError = new AxiosError(
      'Network Error',
      'ERR_NETWORK',
      undefined,
      undefined,
      {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { some: 'other structure' },
      }
    );

    expect(parseError(axiosError)).toBe('Network Error');
  });
});

// ============================================
// calculatePrice
// ============================================

describe('calculatePrice', () => {
  describe('PER_KWH', () => {
    it('should multiply basePrice × quantity', () => {
      const result = calculatePrice({
        pricingModel: 'PER_KWH',
        basePrice: 5,
        quantity: 10,
      });
      expect(result).toBe(50);
    });

    it('should add wheelingCharges to energy cost', () => {
      const result = calculatePrice({
        pricingModel: 'PER_KWH',
        basePrice: 5,
        quantity: 10,
        wheelingCharges: 2.5,
      });
      expect(result).toBe(52.5);
    });

    it('should default wheelingCharges to 0', () => {
      const result = calculatePrice({
        pricingModel: 'PER_KWH',
        basePrice: 5,
        quantity: 10,
      });
      // 5 * 10 + 0 = 50
      expect(result).toBe(50);
    });
  });

  describe('FIXED', () => {
    it('should return basePrice regardless of quantity', () => {
      const result = calculatePrice({
        pricingModel: 'FIXED',
        basePrice: 100,
        quantity: 999,
      });
      expect(result).toBe(100);
    });

    it('should add wheelingCharges to fixed price', () => {
      const result = calculatePrice({
        pricingModel: 'FIXED',
        basePrice: 100,
        quantity: 999,
        wheelingCharges: 15,
      });
      expect(result).toBe(115);
    });
  });

  describe('SUBSCRIPTION', () => {
    it('should return basePrice regardless of quantity', () => {
      const result = calculatePrice({
        pricingModel: 'SUBSCRIPTION',
        basePrice: 200,
        quantity: 50,
      });
      expect(result).toBe(200);
    });
  });

  describe('TIME_OF_DAY', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should use applicable rate for current hour', () => {
      // Set time to 10:30 UTC (hour 10)
      jest.setSystemTime(new Date('2026-01-28T10:30:00Z'));

      const result = calculatePrice({
        pricingModel: 'TIME_OF_DAY',
        basePrice: 5,
        quantity: 10,
        timeOfDayRates: [
          { startTime: '06:00', endTime: '10:00', price: 4 },
          { startTime: '10:00', endTime: '14:00', price: 8 },
          { startTime: '14:00', endTime: '18:00', price: 6 },
        ],
      });
      // Hour 10 falls in 10:00-14:00 range → price 8, 8 * 10 = 80
      expect(result).toBe(80);
    });

    it('should fall back to basePrice when no rate matches current hour', () => {
      // Set time to 22:00 UTC (hour 22) — outside all rate windows
      jest.setSystemTime(new Date('2026-01-28T22:00:00Z'));

      const result = calculatePrice({
        pricingModel: 'TIME_OF_DAY',
        basePrice: 5,
        quantity: 10,
        timeOfDayRates: [
          { startTime: '06:00', endTime: '10:00', price: 4 },
          { startTime: '10:00', endTime: '14:00', price: 8 },
        ],
      });
      // No matching rate → falls back to basePrice: 5 * 10 = 50
      expect(result).toBe(50);
    });

    it('should fall back to basePrice when timeOfDayRates is undefined', () => {
      jest.setSystemTime(new Date('2026-01-28T10:00:00Z'));

      const result = calculatePrice({
        pricingModel: 'TIME_OF_DAY',
        basePrice: 5,
        quantity: 10,
        timeOfDayRates: undefined,
      });
      // No rates → basePrice * quantity: 5 * 10 = 50
      expect(result).toBe(50);
    });

    it('should fall back to basePrice when timeOfDayRates is empty array', () => {
      jest.setSystemTime(new Date('2026-01-28T10:00:00Z'));

      const result = calculatePrice({
        pricingModel: 'TIME_OF_DAY',
        basePrice: 5,
        quantity: 10,
        timeOfDayRates: [],
      });
      // Empty array → no applicable rate → basePrice: 5 * 10 = 50
      expect(result).toBe(50);
    });
  });

  describe('default (unknown pricing model)', () => {
    it('should use PER_KWH formula for unknown pricing model', () => {
      const result = calculatePrice({
        pricingModel: 'UNKNOWN' as any,
        basePrice: 5,
        quantity: 10,
        wheelingCharges: 3,
      });
      // default case: basePrice * quantity + wheelingCharges = 53
      expect(result).toBe(53);
    });
  });
});

// ============================================
// calculateTotalAmount
// ============================================

describe('calculateTotalAmount', () => {
  it('should extract schema:price from offer and calculate total', () => {
    const offer = {
      'beckn:price': { 'schema:price': 7 },
      'beckn:offerAttributes': {
        pricingModel: 'PER_KWH',
      },
    };
    // 7 * 10 = 70
    expect(calculateTotalAmount(offer, 10)).toBe(70);
  });

  it('should use PER_KWH as default pricing model', () => {
    const offer = {
      'beckn:price': { 'schema:price': 5 },
      'beckn:offerAttributes': {},
    };
    // Default PER_KWH: 5 * 10 = 50
    expect(calculateTotalAmount(offer, 10)).toBe(50);
  });

  it('should include wheelingCharges from offerAttributes', () => {
    const offer = {
      'beckn:price': { 'schema:price': 5 },
      'beckn:offerAttributes': {
        pricingModel: 'PER_KWH',
        wheelingCharges: { amount: 2.5 },
      },
    };
    // 5 * 10 + 2.5 = 52.5
    expect(calculateTotalAmount(offer, 10)).toBe(52.5);
  });

  it('should handle offer with timeOfDayRates pricing model', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-28T10:30:00Z'));

    const offer = {
      'beckn:price': { 'schema:price': 5 },
      'beckn:offerAttributes': {
        pricingModel: 'TIME_OF_DAY',
        timeOfDayRates: [
          { startTime: '10:00', endTime: '14:00', price: 8 },
        ],
      },
    };
    // Hour 10 matches rate → 8 * 10 = 80
    expect(calculateTotalAmount(offer, 10)).toBe(80);

    jest.useRealTimers();
  });

  it('should handle offer with FIXED pricing model', () => {
    const offer = {
      'beckn:price': { 'schema:price': 100 },
      'beckn:offerAttributes': {
        pricingModel: 'FIXED',
      },
    };
    // FIXED ignores quantity: 100
    expect(calculateTotalAmount(offer, 999)).toBe(100);
  });

  it('should handle missing offerAttributes gracefully', () => {
    const offer = {
      'beckn:price': { 'schema:price': 5 },
      'beckn:offerAttributes': undefined,
    };
    // No attributes → defaults: PER_KWH, no wheeling, no rates
    // 5 * 10 = 50
    expect(calculateTotalAmount(offer, 10)).toBe(50);
  });
});
