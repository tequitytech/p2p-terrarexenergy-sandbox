/**
 * Tests for hourly-forecast-reader.ts
 *
 * Tests tomorrow date calculation, PR-based forecast generation, and hourly threshold validation
 */

import { HOURLY_MIN_THRESHOLD } from '../types';

import type { DailyForecast, PrSlotData } from '../types';

import { getTomorrowDate, getTomorrowForecast, filterValidHours } from './hourly-forecast-reader';
import * as marketAnalyzer from './hourly-market-analyzer';

// Mock the market analyzer module
jest.mock('./hourly-market-analyzer');
const mockReadPrData = marketAnalyzer.readPrData as jest.MockedFunction<typeof marketAnalyzer.readPrData>;
const mockCalculateHourlyGeneration = marketAnalyzer.calculateHourlyGeneration as jest.MockedFunction<typeof marketAnalyzer.calculateHourlyGeneration>;

const SAMPLE_PR_DATA: PrSlotData[] = [
  { slot: '07:00-08:00', pr_min: 0.58, pr_max: 0.65, midpoint: 0.62 },
  { slot: '08:00-09:00', pr_min: 0.70, pr_max: 0.77, midpoint: 0.74 },
  { slot: '09:00-10:00', pr_min: 0.76, pr_max: 0.80, midpoint: 0.78 },
  { slot: '10:00-11:00', pr_min: 0.78, pr_max: 0.82, midpoint: 0.80 },
  { slot: '11:00-12:00', pr_min: 0.79, pr_max: 0.81, midpoint: 0.80 },
  { slot: '12:00-13:00', pr_min: 0.78, pr_max: 0.80, midpoint: 0.79 },
  { slot: '13:00-14:00', pr_min: 0.77, pr_max: 0.79, midpoint: 0.78 },
  { slot: '14:00-15:00', pr_min: 0.75, pr_max: 0.78, midpoint: 0.77 },
  { slot: '15:00-16:00', pr_min: 0.73, pr_max: 0.76, midpoint: 0.75 },
  { slot: '16:00-17:00', pr_min: 0.68, pr_max: 0.72, midpoint: 0.70 },
  { slot: '17:00-18:00', pr_min: 0.58, pr_max: 0.63, midpoint: 0.61 },
];


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
      jest.setSystemTime(new Date('2026-01-28T10:00:00Z'));

      const result = getTomorrowDate();

      expect(result).toBe('2026-01-29');
    });

    it('should handle date boundary at midnight UTC', () => {
      jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));

      const result = getTomorrowDate();

      expect(result).toBe('2026-01-29');
    });

    it('should handle late night IST crossing to new day', () => {
      jest.setSystemTime(new Date('2026-01-28T18:30:00Z'));

      const result = getTomorrowDate();

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

    it('should generate forecast from PR data and safeLimit', () => {
      const safeLimit = 20;
      mockReadPrData.mockReturnValue(SAMPLE_PR_DATA);
      mockCalculateHourlyGeneration.mockImplementation((hour, limit, prData) => ({
        generation_kwh: limit * 0.8,
        pr_used: 0.8,
        slot: `${hour}-${String(parseInt(hour) + 1).padStart(2, '0')}:00`
      }));

      const result = getTomorrowForecast(safeLimit);

      expect(result).not.toBeNull();
      expect(result!.date).toBe('2026-01-29');
      expect(result!.hourly).toHaveLength(11); // 11 PR slots
      expect(mockReadPrData).toHaveBeenCalled();
    });

    it('should return null when PR data not available', () => {
      mockReadPrData.mockReturnValue(null);

      const result = getTomorrowForecast(20);

      expect(result).toBeNull();
    });

    it('should set generation_kwh from calculateHourlyGeneration result', () => {
      const safeLimit = 25;
      mockReadPrData.mockReturnValue([SAMPLE_PR_DATA[3]]); // Just 10:00-11:00 slot
      mockCalculateHourlyGeneration.mockReturnValue({
        generation_kwh: 20.5,
        pr_used: 0.82,
        slot: '10:00-11:00'
      });

      const result = getTomorrowForecast(safeLimit);

      expect(result).not.toBeNull();
      expect(result!.hourly).toHaveLength(1);
      expect(result!.hourly[0].hour).toBe('10:00');
      expect(result!.hourly[0].excess_kwh).toBe(20.5);
    });

    it('should skip slots where calculateHourlyGeneration returns null', () => {
      mockReadPrData.mockReturnValue(SAMPLE_PR_DATA);
      mockCalculateHourlyGeneration.mockImplementation((hour) => {
        if (hour === '10:00') {
          return { generation_kwh: 16, pr_used: 0.8, slot: '10:00-11:00' };
        }
        return null;
      });

      const result = getTomorrowForecast(20);

      expect(result).not.toBeNull();
      expect(result!.hourly).toHaveLength(1);
      expect(result!.hourly[0].hour).toBe('10:00');
    });

    it('should return null when all slots return null generation', () => {
      mockReadPrData.mockReturnValue(SAMPLE_PR_DATA);
      mockCalculateHourlyGeneration.mockReturnValue(null);

      const result = getTomorrowForecast(20);

      expect(result).toBeNull();
    });

    it('should pass safeLimit to calculateHourlyGeneration', () => {
      const safeLimit = 15;
      mockReadPrData.mockReturnValue([SAMPLE_PR_DATA[0]]);
      mockCalculateHourlyGeneration.mockReturnValue({
        generation_kwh: 9.3,
        pr_used: 0.62,
        slot: '07:00-08:00'
      });

      getTomorrowForecast(safeLimit);

      expect(mockCalculateHourlyGeneration).toHaveBeenCalledWith(
        '07:00',
        safeLimit,
        expect.any(Array)
      );
    });
  });

  describe('filterValidHours', () => {
    it('should filter hours >= 1 kWh threshold', () => {
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '08:00', excess_kwh: 0.5 },
          { hour: '09:00', excess_kwh: 1.0 },
          { hour: '10:00', excess_kwh: 5.0 },
          { hour: '11:00', excess_kwh: 0.8 }
        ]
      };

      const { valid } = filterValidHours(forecast);

      expect(valid).toHaveLength(2);
      expect(valid.map(h => h.hour)).toEqual(['09:00', '10:00']);
    });

    it('should track skipped hours with reason', () => {
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '08:00', excess_kwh: 0.5 },
          { hour: '09:00', excess_kwh: 5.0 }
        ]
      };

      const { skipped } = filterValidHours(forecast);

      expect(skipped).toHaveLength(1);
      expect(skipped[0].hour).toBe('08:00');
      expect(skipped[0].reason).toContain('Below');
      expect(skipped[0].reason).toContain(String(HOURLY_MIN_THRESHOLD));
    });

    it('should not include zero excess hours in skipped list', () => {
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '06:00', excess_kwh: 0 },
          { hour: '07:00', excess_kwh: 0.5 },
          { hour: '08:00', excess_kwh: 5.0 }
        ]
      };

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(1);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].hour).toBe('07:00');
    });

    it('should handle forecast with all valid hours', () => {
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '10:00', excess_kwh: 5.0 },
          { hour: '11:00', excess_kwh: 10.0 },
          { hour: '12:00', excess_kwh: 15.0 }
        ]
      };

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(3);
      expect(skipped).toHaveLength(0);
    });

    it('should handle forecast with no valid hours', () => {
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '10:00', excess_kwh: 0.3 },
          { hour: '11:00', excess_kwh: 0.5 },
          { hour: '12:00', excess_kwh: 0.8 }
        ]
      };

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
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '10:00', excess_kwh: 5.5 },
          { hour: '11:00', excess_kwh: 10.25 }
        ]
      };

      const { valid } = filterValidHours(forecast);

      expect(valid[0].excess_kwh).toBe(5.5);
      expect(valid[1].excess_kwh).toBe(10.25);
    });

    it('should handle exactly at threshold boundary', () => {
      const forecast: DailyForecast = {
        date: '2026-01-28',
        hourly: [
          { hour: '10:00', excess_kwh: 1.0 },
          { hour: '11:00', excess_kwh: 0.99 }
        ]
      };

      const { valid, skipped } = filterValidHours(forecast);

      expect(valid).toHaveLength(1);
      expect(valid[0].hour).toBe('10:00');
      expect(skipped).toHaveLength(1);
    });
  });
});
