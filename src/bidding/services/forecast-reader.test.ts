/**
 * Tests for forecast-reader.ts
 *
 * Tests forecast file parsing, validation, buffer calculation, and threshold filtering
 */

import * as fs from 'fs';

import { createDailyForecast, createWeekForecast } from '../../test-utils';
import { MIN_THRESHOLD } from '../types';

import { readForecast, processDailyForecast, getProcessedForecasts } from './forecast-reader';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('forecast-reader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.EXCESS_DATA_PATH = '/test/data/forecast.json';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('readForecast', () => {
    it('should parse valid forecast file', () => {
      const validData = createWeekForecast();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(validData));

      const result = readForecast();

      expect(result).toHaveLength(7);
      expect(result[0]).toHaveProperty('date');
      expect(result[0]).toHaveProperty('hourly');
    });

    it('should throw error when file not found', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => readForecast()).toThrow(/not found/);
    });

    it('should throw error for invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ invalid json }');

      expect(() => readForecast()).toThrow(/malformed/i);
    });

    it('should throw error when file contains non-array', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ date: '2026-01-28' }));

      expect(() => readForecast()).toThrow(/must contain an array/);
    });

    it('should throw error for entry missing date', () => {
      const badData = [{ hourly: [] }];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(badData));

      expect(() => readForecast()).toThrow(/must have date/);
    });

    it('should throw error for entry missing hourly array', () => {
      const badData = [{ date: '2026-01-28' }];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(badData));

      expect(() => readForecast()).toThrow(/must have date and hourly array/);
    });

    it('should handle empty array gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      const result = readForecast();

      expect(result).toEqual([]);
    });
  });

  describe('processDailyForecast', () => {
    it('should sum hourly values correctly', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 5.0 },
        { hour: '11:00', excess_kwh: 10.0 },
        { hour: '12:00', excess_kwh: 15.0 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.rawTotal).toBe(30.0);
    });

    it('should apply 10% buffer correctly (multiply by 0.9)', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 100 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.rawTotal).toBe(100);
      expect(result.bufferedQuantity).toBe(90); // 100 * 0.9
    });

    it('should mark day as biddable when >= 5 kWh after buffer', () => {
      // Need 5.56 kWh raw to get >= 5 kWh after 10% buffer
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 5.56 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.bufferedQuantity).toBeGreaterThanOrEqual(MIN_THRESHOLD);
      expect(result.isBiddable).toBe(true);
    });

    it('should mark day as not biddable when < 5 kWh after buffer', () => {
      // 5.5 raw * 0.9 = 4.95, below threshold
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 5.5 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.bufferedQuantity).toBeLessThan(MIN_THRESHOLD);
      expect(result.isBiddable).toBe(false);
    });

    it('should handle day with all zero excess', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 0 },
        { hour: '11:00', excess_kwh: 0 },
        { hour: '12:00', excess_kwh: 0 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.rawTotal).toBe(0);
      expect(result.bufferedQuantity).toBe(0);
      expect(result.isBiddable).toBe(false);
    });

    it('should handle empty hourly array', () => {
      const forecast = createDailyForecast('2026-01-28', []);

      const result = processDailyForecast(forecast);

      expect(result.rawTotal).toBe(0);
      expect(result.bufferedQuantity).toBe(0);
      expect(result.isBiddable).toBe(false);
    });

    it('should derive validity window from first to last non-zero hour', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '08:00', excess_kwh: 0 },
        { hour: '09:00', excess_kwh: 5.0 },  // First non-zero
        { hour: '10:00', excess_kwh: 10.0 },
        { hour: '11:00', excess_kwh: 0 },
        { hour: '12:00', excess_kwh: 8.0 },
        { hour: '13:00', excess_kwh: 3.0 },  // Last non-zero
        { hour: '14:00', excess_kwh: 0 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.validityWindow.start).toContain('09:00');
      // End should be 14:00 (13:00 + 1 hour)
      expect(result.validityWindow.end).toContain('14:00');
    });

    it('should use default window when no production hours', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 0 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.validityWindow.start).toContain('08:00');
      expect(result.validityWindow.end).toContain('17:00');
    });

    it('should round values to 2 decimal places', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 3.333 },
        { hour: '11:00', excess_kwh: 3.333 },
        { hour: '12:00', excess_kwh: 3.334 }
      ]);

      const result = processDailyForecast(forecast);

      // 10.0 total, should be clean
      expect(result.rawTotal).toBe(10);
      // 10.0 * 0.9 = 9.0
      expect(result.bufferedQuantity).toBe(9);
    });

    it('should handle very small quantities', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 0.001 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.rawTotal).toBe(0);  // Rounds to 0
      expect(result.isBiddable).toBe(false);
    });

    it('should handle large quantities', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 1000 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.rawTotal).toBe(1000);
      expect(result.bufferedQuantity).toBe(900);
      expect(result.isBiddable).toBe(true);
    });
  });

  describe('getProcessedForecasts', () => {
    it('should return all days and filter biddable days', () => {
      const forecasts = [
        createDailyForecast('2026-01-28', [{ hour: '12:00', excess_kwh: 10 }]),  // Biddable (9 kWh after buffer)
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 3 }]),   // Not biddable (2.7 kWh)
        createDailyForecast('2026-01-30', [{ hour: '12:00', excess_kwh: 20 }])   // Biddable (18 kWh)
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(forecasts));

      const result = getProcessedForecasts();

      expect(result.all).toHaveLength(3);
      expect(result.biddable).toHaveLength(2);
      expect(result.biddable[0].date).toBe('2026-01-28');
      expect(result.biddable[1].date).toBe('2026-01-30');
    });

    it('should return empty arrays when no forecast data', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      const result = getProcessedForecasts();

      expect(result.all).toHaveLength(0);
      expect(result.biddable).toHaveLength(0);
    });

    it('should handle all days being non-biddable', () => {
      const forecasts = [
        createDailyForecast('2026-01-28', [{ hour: '12:00', excess_kwh: 1 }]),
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 2 }])
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(forecasts));

      const result = getProcessedForecasts();

      expect(result.all).toHaveLength(2);
      expect(result.biddable).toHaveLength(0);
    });

    it('should handle all days being biddable', () => {
      const forecasts = [
        createDailyForecast('2026-01-28', [{ hour: '12:00', excess_kwh: 100 }]),
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 100 }])
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(forecasts));

      const result = getProcessedForecasts();

      expect(result.all).toHaveLength(2);
      expect(result.biddable).toHaveLength(2);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('should handle exactly at threshold boundary (5.0 kWh after buffer)', () => {
      // 5.56 * 0.9 = 5.004 → rounds to 5.0
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 5.556 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.bufferedQuantity).toBeGreaterThanOrEqual(5.0);
      expect(result.isBiddable).toBe(true);
    });

    it('should handle just below threshold boundary', () => {
      // 5.55 * 0.9 = 4.995 → rounds to 5.0, but let's check 5.5
      // 5.5 * 0.9 = 4.95, not biddable
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '12:00', excess_kwh: 5.5 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.bufferedQuantity).toBe(4.95);
      expect(result.isBiddable).toBe(false);
    });

    it('should preserve date through processing', () => {
      const forecast = createDailyForecast('2026-12-31', [
        { hour: '12:00', excess_kwh: 10 }
      ]);

      const result = processDailyForecast(forecast);

      expect(result.date).toBe('2026-12-31');
    });

    it('should process multiple hours across day correctly', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '06:00', excess_kwh: 0 },
        { hour: '07:00', excess_kwh: 1 },
        { hour: '08:00', excess_kwh: 3 },
        { hour: '09:00', excess_kwh: 6 },
        { hour: '10:00', excess_kwh: 9 },
        { hour: '11:00', excess_kwh: 12 },
        { hour: '12:00', excess_kwh: 15 },
        { hour: '13:00', excess_kwh: 14 },
        { hour: '14:00', excess_kwh: 11 },
        { hour: '15:00', excess_kwh: 7 },
        { hour: '16:00', excess_kwh: 3 },
        { hour: '17:00', excess_kwh: 0 }
      ]);

      const result = processDailyForecast(forecast);

      // Sum: 1+3+6+9+12+15+14+11+7+3 = 81
      expect(result.rawTotal).toBe(81);
      expect(result.bufferedQuantity).toBe(72.9); // 81 * 0.9
      expect(result.isBiddable).toBe(true);

      // First non-zero: 07:00, Last non-zero: 16:00 → end at 17:00
      expect(result.validityWindow.start).toContain('07:00');
      expect(result.validityWindow.end).toContain('17:00');
    });
  });
});
