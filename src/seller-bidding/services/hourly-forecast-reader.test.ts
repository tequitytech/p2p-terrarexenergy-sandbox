/**
 * Tests for hourly-forecast-reader.ts
 *
 * Tests tomorrow date calculation, forecast filtering, and hourly threshold validation
 */

import * as fs from 'fs';

import { createDailyForecast } from '../../test-utils';
import { HOURLY_MIN_THRESHOLD } from '../types';

import { getTomorrowDate, getTomorrowForecast, filterValidHours } from './hourly-forecast-reader';

import type { DailyForecast } from '../types';



// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('hourly-forecast-reader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getTomorrowDate', () => {
    it('should return tomorrow date in IST timezone', () => {
      // Set time to 2026-01-28 10:00:00 UTC
      jest.setSystemTime(new Date('2026-01-28T10:00:00Z'));

      const result = getTomorrowDate();

      // In IST (UTC+5:30), this is 2026-01-28 15:30:00 IST
      // Tomorrow in IST is 2026-01-29
      expect(result).toBe('2026-01-29');
    });

    it('should handle date boundary at midnight UTC', () => {
      // At 00:00 UTC, IST is 05:30
      jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));

      const result = getTomorrowDate();

      // 00:00 UTC = 05:30 IST on Jan 28, tomorrow = Jan 29
      expect(result).toBe('2026-01-29');
    });

    it('should handle late night IST crossing to new day', () => {
      // 18:30 UTC = 00:00 IST next day
      jest.setSystemTime(new Date('2026-01-28T18:30:00Z'));

      const result = getTomorrowDate();

      // 18:30 UTC = 00:00 IST Jan 29, tomorrow = Jan 30
      expect(result).toBe('2026-01-30');
    });

    it('should handle month boundary', () => {
      jest.setSystemTime(new Date('2026-01-31T10:00:00Z'));

      const result = getTomorrowDate();

      expect(result).toBe('2026-02-01');
    });

    it('should handle year boundary', () => {
      jest.setSystemTime(new Date('2025-12-31T10:00:00Z'));

      const result = getTomorrowDate();

      expect(result).toBe('2026-01-01');
    });

    it('should format date as YYYY-MM-DD', () => {
      jest.setSystemTime(new Date('2026-06-15T10:00:00Z'));

      const result = getTomorrowDate();

      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result).toBe('2026-06-16');
    });
  });

  describe('getTomorrowForecast', () => {
    beforeEach(() => {
      jest.setSystemTime(new Date('2026-01-28T10:00:00Z'));
    });

    it('should return forecast for tomorrow date', () => {
      const forecasts = [
        createDailyForecast('2026-01-28', [{ hour: '12:00', excess_kwh: 10 }]),
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 15 }]),
        createDailyForecast('2026-01-30', [{ hour: '12:00', excess_kwh: 20 }])
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(forecasts));

      const result = getTomorrowForecast();

      expect(result).not.toBeNull();
      expect(result?.date).toBe('2026-01-29');
    });

    it('should return null when file not found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = getTomorrowForecast();

      expect(result).toBeNull();
    });

    it('should return null when tomorrow not in forecast', () => {
      const forecasts = [
        createDailyForecast('2026-01-28', [{ hour: '12:00', excess_kwh: 10 }])
        // No 2026-01-29
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(forecasts));

      const result = getTomorrowForecast();

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const result = getTomorrowForecast();

      expect(result).toBeNull();
    });

    it('should return null when file is not an array', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ date: '2026-01-29' }));

      const result = getTomorrowForecast();

      expect(result).toBeNull();
    });
  });

  describe('filterValidHours', () => {
    it('should filter hours >= 1 kWh threshold', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '08:00', excess_kwh: 0.5 },  // Below threshold
        { hour: '09:00', excess_kwh: 1.0 },  // At threshold
        { hour: '10:00', excess_kwh: 5.0 },  // Above threshold
        { hour: '11:00', excess_kwh: 0.8 }   // Below threshold
      ]);

      const { valid } = filterValidHours(forecast);

      expect(valid).toHaveLength(2);
      expect(valid.map(h => h.hour)).toEqual(['09:00', '10:00']);
    });

    it('should track skipped hours with reason', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '08:00', excess_kwh: 0.5 },  // Should be skipped
        { hour: '09:00', excess_kwh: 5.0 }   // Valid
      ]);

      const { skipped } = filterValidHours(forecast);

      expect(skipped).toHaveLength(1);
      expect(skipped[0].hour).toBe('08:00');
      expect(skipped[0].reason).toContain('Below');
      expect(skipped[0].reason).toContain(String(HOURLY_MIN_THRESHOLD));
    });

    it('should not include zero excess hours in skipped list', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '06:00', excess_kwh: 0 },    // Zero, not skipped
        { hour: '07:00', excess_kwh: 0.5 },  // Small, skipped
        { hour: '08:00', excess_kwh: 5.0 }   // Valid
      ]);

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(1);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].hour).toBe('07:00');
    });

    it('should handle forecast with all valid hours', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 5.0 },
        { hour: '11:00', excess_kwh: 10.0 },
        { hour: '12:00', excess_kwh: 15.0 }
      ]);

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(3);
      expect(skipped).toHaveLength(0);
    });

    it('should handle forecast with no valid hours', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 0.3 },
        { hour: '11:00', excess_kwh: 0.5 },
        { hour: '12:00', excess_kwh: 0.8 }
      ]);

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(0);
      expect(skipped).toHaveLength(3);
    });

    it('should handle empty hourly array', () => {
      const forecast: DailyForecast = { date: '2026-01-28', hourly: [] };

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(0);
      expect(skipped).toHaveLength(0);
    });

    it('should preserve excess_kwh values in valid hours', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 5.5 },
        { hour: '11:00', excess_kwh: 10.25 }
      ]);

      const { valid } = filterValidHours(forecast);

      expect(valid[0].excess_kwh).toBe(5.5);
      expect(valid[1].excess_kwh).toBe(10.25);
    });

    it('should handle exactly at threshold boundary', () => {
      const forecast = createDailyForecast('2026-01-28', [
        { hour: '10:00', excess_kwh: 1.0 },   // Exactly at threshold
        { hour: '11:00', excess_kwh: 0.99 }   // Just below
      ]);

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(1);
      expect(valid[0].hour).toBe('10:00');
      expect(skipped).toHaveLength(1);
    });
  });

  describe('integration: date calculation with forecast lookup', () => {
    it('should find correct forecast based on current time', () => {
      // Set to evening time - still Jan 28 in IST, tomorrow is Jan 29
      jest.setSystemTime(new Date('2026-01-28T14:00:00Z'));  // 19:30 IST

      const forecasts = [
        createDailyForecast('2026-01-28', [{ hour: '12:00', excess_kwh: 10 }]),
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 15 }])
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(forecasts));

      const result = getTomorrowForecast();

      expect(result?.date).toBe('2026-01-29');
    });
  });
});
