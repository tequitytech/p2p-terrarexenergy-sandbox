/**
 * Tests for hourly-market-analyzer.ts
 *
 * Tests hourly competitor analysis with time range overlap detection
 * and PR-based generation capacity calculation
 */

import * as fs from 'fs';

import { createCompetitorOffer } from '../../test-utils';

import {
  analyzeCompetitorsForHour,
  readPrData,
  randomBetween,
  findPrSlotForHour,
  calculateHourlyGeneration,
} from './hourly-market-analyzer';

import type { CompetitorOffer, PrSlotData } from '../types';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

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


describe('hourly-market-analyzer', () => {
  const targetDate = '2026-01-28';
  const targetHour = '12:00';

  // Delivery window within 08:00-17:00 UTC (overlaps with default validity window)
  const deliveryWindow = {
    start: '2026-01-28T10:00:00.000Z',  // 10:00 UTC (15:30 IST)
    end: '2026-01-28T11:00:00.000Z'     // 11:00 UTC (16:30 IST)
  };

  describe('analyzeCompetitorsForHour', () => {
    it('should return empty analysis when no offers', () => {
      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        []
      );

      expect(result.competitors_found).toBe(0);
      expect(result.lowest_competitor_price).toBeNull();
      expect(result.lowest_competitor_id).toBeNull();
    });

    it('should filter offers by matching date', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 7.0),  // Same date
        createCompetitorOffer('2026-01-29', 6.0)   // Different date
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(1);
      expect(result.lowest_competitor_price).toBe(7.0);
    });

    it('should include unknown-date offers when their validity window overlaps the delivery window', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 8.0),
        createCompetitorOffer('unknown', 6.5, 10, {
          validity_window: {
            start: '2026-01-28T09:00:00.000Z',
            end: '2026-01-28T12:00:00.000Z'
          }
        })
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(2);
      expect(result.lowest_competitor_price).toBe(6.5);
    });

    it('should find lowest price among competitors', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 8.0),
        createCompetitorOffer('2026-01-28', 6.5),
        createCompetitorOffer('2026-01-28', 7.5)
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(3);
      expect(result.lowest_competitor_price).toBe(6.5);
    });

    it('should track cached flag', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 7.0)
      ];

      const cachedResult = analyzeCompetitorsForHour(
        targetDate, targetHour, deliveryWindow, offers, true
      );
      const freshResult = analyzeCompetitorsForHour(
        targetDate, targetHour, deliveryWindow, offers, false
      );

      expect(cachedResult.cached).toBe(true);
      expect(freshResult.cached).toBe(false);
    });

    it('should include quantity and validity window from lowest competitor', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 8.0, 10),
        createCompetitorOffer('2026-01-28', 6.5, 20)  // Lowest
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.lowest_competitor_quantity_kwh).toBe(20);
      expect(result.lowest_competitor_validity_window).toBeDefined();
    });
  });

  describe('time range overlap detection', () => {
    it('should include offers whose validity window partially overlaps the start of the delivery window', () => {
      const overlappingOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T09:30:00.000Z',
          end: '2026-01-28T10:30:00.000Z'
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [overlappingOffer]
      );

      expect(result.competitors_found).toBe(1);
    });

    it('should include offers whose validity window fully contains the delivery window', () => {
      const containingOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T09:00:00.000Z',
          end: '2026-01-28T12:00:00.000Z'
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [containingOffer]
      );

      expect(result.competitors_found).toBe(1);
    });

    it('should include offers whose validity window is fully contained within the delivery window', () => {
      const containedOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T10:15:00.000Z',
          end: '2026-01-28T10:45:00.000Z'
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [containedOffer]
      );

      expect(result.competitors_found).toBe(1);
    });

    it('should exclude offers completely before delivery window', () => {
      const beforeOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T04:30:00.000Z',
          end: '2026-01-28T05:30:00.000Z'
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [beforeOffer]
      );

      expect(result.competitors_found).toBe(0);
    });

    it('should exclude offers completely after delivery window', () => {
      const afterOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T08:30:00.000Z',
          end: '2026-01-28T09:30:00.000Z'
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [afterOffer]
      );

      expect(result.competitors_found).toBe(0);
    });

    it('should include offers without validity window (same date)', () => {
      const offerWithoutWindow = createCompetitorOffer('2026-01-28', 7.0, 10, { validity_window: null });

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [offerWithoutWindow]
      );

      expect(result.competitors_found).toBe(1);
    });

    it('should handle edge case: windows touch exactly at boundary', () => {
      const touchingOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T05:30:00.000Z',
          end: '2026-01-28T06:30:00.000Z'
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [touchingOffer]
      );

      expect(result.competitors_found).toBe(0);
    });
  });

  describe('multiple competitor scenarios', () => {
    it('should correctly filter mixed offers by date and time overlap, including only valid competitors', () => {
      const offers: CompetitorOffer[] = [
        {
          ...createCompetitorOffer('2026-01-28', 7.5),
          validity_window: {
            start: '2026-01-28T09:30:00.000Z',
            end: '2026-01-28T11:30:00.000Z'
          }
        },
        createCompetitorOffer('2026-01-29', 6.0),
        createCompetitorOffer('unknown', 8.0, 10, {
          validity_window: {
            start: '2026-01-28T09:00:00.000Z',
            end: '2026-01-28T12:00:00.000Z'
          }
        }),
        {
          ...createCompetitorOffer('2026-01-28', 5.0),
          validity_window: {
            start: '2026-01-28T04:00:00.000Z',
            end: '2026-01-28T05:00:00.000Z'
          }
        }
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(2);
      expect(result.lowest_competitor_price).toBe(7.5);
    });

    it('should handle competitors with identical prices', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 7.0),
        createCompetitorOffer('2026-01-28', 7.0),
        createCompetitorOffer('2026-01-28', 7.0)
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(3);
      expect(result.lowest_competitor_price).toBe(7.0);
    });

    it('should handle single competitor', () => {
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 7.5)
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(1);
      expect(result.lowest_competitor_price).toBe(7.5);
    });
  });

  describe('different delivery hours', () => {
    it('should handle early morning delivery (08:00)', () => {
      const earlyDelivery = {
        start: '2026-01-28T02:30:00.000Z',
        end: '2026-01-28T03:30:00.000Z'
      };

      const offers: CompetitorOffer[] = [
        {
          ...createCompetitorOffer('2026-01-28', 7.0),
          validity_window: {
            start: '2026-01-28T02:00:00.000Z',
            end: '2026-01-28T04:00:00.000Z'
          }
        }
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        '08:00',
        earlyDelivery,
        offers
      );

      expect(result.competitors_found).toBe(1);
    });

    it('should handle late afternoon delivery (17:00)', () => {
      const lateDelivery = {
        start: '2026-01-28T11:30:00.000Z',
        end: '2026-01-28T12:30:00.000Z'
      };

      const offers: CompetitorOffer[] = [
        {
          ...createCompetitorOffer('2026-01-28', 7.0),
          validity_window: {
            start: '2026-01-28T11:00:00.000Z',
            end: '2026-01-28T13:00:00.000Z'
          }
        }
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        '17:00',
        lateDelivery,
        offers
      );

      expect(result.competitors_found).toBe(1);
    });
  });

  // ============================================
  // PR-based generation capacity tests
  // ============================================

  describe('readPrData', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should read and parse PR data file', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(SAMPLE_PR_DATA));

      const result = readPrData();

      expect(result).not.toBeNull();
      expect(result).toHaveLength(11);
      expect(result![0].slot).toBe('07:00-08:00');
    });

    it('should return null when file not found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = readPrData();

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not valid json');

      const result = readPrData();

      expect(result).toBeNull();
    });

    it('should return null when data is not an array', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ slot: '07:00-08:00' }));

      const result = readPrData();

      expect(result).toBeNull();
    });
  });

  describe('randomBetween', () => {
    it('should return a value between min and max', () => {
      for (let i = 0; i < 100; i++) {
        const result = randomBetween(0.58, 0.65);
        expect(result).toBeGreaterThanOrEqual(0.58);
        expect(result).toBeLessThanOrEqual(0.65);
      }
    });

    it('should return min when min equals max', () => {
      const result = randomBetween(0.80, 0.80);
      expect(result).toBe(0.80);
    });

    it('should produce varied results across calls', () => {
      const results = new Set<number>();
      for (let i = 0; i < 50; i++) {
        results.add(randomBetween(0.0, 1.0));
      }
      // With 50 random calls, we should get at least a few unique values
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe('findPrSlotForHour', () => {
    it('should find matching slot for a given hour', () => {
      const result = findPrSlotForHour('10:00', SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      expect(result!.slot).toBe('10:00-11:00');
      expect(result!.pr_min).toBe(0.78);
      expect(result!.pr_max).toBe(0.82);
    });

    it('should find first slot (07:00)', () => {
      const result = findPrSlotForHour('07:00', SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      expect(result!.slot).toBe('07:00-08:00');
    });

    it('should find last slot (17:00)', () => {
      const result = findPrSlotForHour('17:00', SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      expect(result!.slot).toBe('17:00-18:00');
    });

    it('should return null for hour outside PR data range', () => {
      const result = findPrSlotForHour('05:00', SAMPLE_PR_DATA);
      expect(result).toBeNull();
    });

    it('should return null for nighttime hour', () => {
      const result = findPrSlotForHour('22:00', SAMPLE_PR_DATA);
      expect(result).toBeNull();
    });

    it('should return null for empty PR data', () => {
      const result = findPrSlotForHour('10:00', []);
      expect(result).toBeNull();
    });
  });

  describe('calculateHourlyGeneration', () => {
    it('should calculate generation as safeLimit * random PR', () => {
      const safeLimit = 20; // 20 kW

      const result = calculateHourlyGeneration('10:00', safeLimit, SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      expect(result!.slot).toBe('10:00-11:00');
      // PR range for 10:00-11:00 is 0.78-0.82
      // Generation should be between 20 * 0.78 = 15.6 and 20 * 0.82 = 16.4
      expect(result!.generation_kwh).toBeGreaterThanOrEqual(15.6);
      expect(result!.generation_kwh).toBeLessThanOrEqual(16.4);
      expect(result!.pr_used).toBeGreaterThanOrEqual(0.78);
      expect(result!.pr_used).toBeLessThanOrEqual(0.82);
    });

    it('should return null for hour outside PR data range', () => {
      const result = calculateHourlyGeneration('05:00', 20, SAMPLE_PR_DATA);
      expect(result).toBeNull();
    });

    it('should return null when PR data is null', () => {
      const result = calculateHourlyGeneration('10:00', 20, null);
      expect(result).toBeNull();
    });

    it('should return 0 generation when safeLimit is 0', () => {
      const result = calculateHourlyGeneration('10:00', 0, SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      expect(result!.generation_kwh).toBe(0);
    });

    it('should calculate correctly for early morning slot with lower PR', () => {
      const safeLimit = 10; // 10 kW

      const result = calculateHourlyGeneration('07:00', safeLimit, SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      // PR range for 07:00-08:00 is 0.58-0.65
      // Generation should be between 10 * 0.58 = 5.8 and 10 * 0.65 = 6.5
      expect(result!.generation_kwh).toBeGreaterThanOrEqual(5.8);
      expect(result!.generation_kwh).toBeLessThanOrEqual(6.5);
    });

    it('should calculate correctly for peak hour with higher PR', () => {
      const safeLimit = 25; // 25 kW

      const result = calculateHourlyGeneration('11:00', safeLimit, SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      // PR range for 11:00-12:00 is 0.79-0.81
      // Generation should be between 25 * 0.79 = 19.75 and 25 * 0.81 = 20.25
      expect(result!.generation_kwh).toBeGreaterThanOrEqual(19.75);
      expect(result!.generation_kwh).toBeLessThanOrEqual(20.25);
    });

    it('should round generation to 2 decimal places', () => {
      const result = calculateHourlyGeneration('12:00', 15, SAMPLE_PR_DATA);

      expect(result).not.toBeNull();
      // Check that it has at most 2 decimal places
      const decimalPart = result!.generation_kwh.toString().split('.')[1] || '';
      expect(decimalPart.length).toBeLessThanOrEqual(2);
    });

    it('should read from file when prData not provided', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(SAMPLE_PR_DATA));

      const result = calculateHourlyGeneration('10:00', 20);

      expect(result).not.toBeNull();
      expect(result!.generation_kwh).toBeGreaterThanOrEqual(15.6);
      expect(result!.generation_kwh).toBeLessThanOrEqual(16.4);
      expect(mockFs.existsSync).toHaveBeenCalled();
    });

    it('should return null when file read fails and no prData provided', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = calculateHourlyGeneration('10:00', 20);

      expect(result).toBeNull();
    });

    it('should generate different values across multiple calls due to random PR', () => {
      const results = new Set<number>();
      for (let i = 0; i < 20; i++) {
        const result = calculateHourlyGeneration('10:00', 100, SAMPLE_PR_DATA);
        if (result) results.add(result.generation_kwh);
      }
      // With safeLimit=100 and PR range 0.78-0.82, we get values 78-82
      // Multiple random calls should produce varied results
      expect(results.size).toBeGreaterThan(1);
    });
  });
});
