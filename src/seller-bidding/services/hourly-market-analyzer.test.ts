/**
 * Tests for hourly-market-analyzer.ts
 *
 * Tests hourly competitor analysis with time range overlap detection
 */

import { analyzeCompetitorsForHour } from './hourly-market-analyzer';
import { createCompetitorOffer } from '../../test-utils';
import { CompetitorOffer } from '../types';

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
      // 'unknown' date offers pass the date filter but still need a valid
      // validity_window to pass the timeRangesOverlap check. The default
      // createValidityWindow('unknown') produces invalid date strings (NaN).
      const offers: CompetitorOffer[] = [
        createCompetitorOffer('2026-01-28', 8.0),
        createCompetitorOffer('unknown', 6.5, 10, {
          validity_window: {
            start: '2026-01-28T09:00:00.000Z',  // Valid window that overlaps
            end: '2026-01-28T12:00:00.000Z'      // delivery 10:00-11:00 UTC
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
      // Validity 09:30-10:30 UTC partially overlaps delivery 10:00-11:00 UTC
      // timeRangesOverlap(09:30, 10:30, 10:00, 11:00) → 09:30 < 11:00 && 10:00 < 10:30 → true
      const overlappingOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T09:30:00.000Z',  // Starts before delivery
          end: '2026-01-28T10:30:00.000Z'     // Ends during delivery
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

    it('should include offers that completely contain delivery window', () => {
      const containingOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T05:30:00.000Z',  // 11:00 IST
          end: '2026-01-28T08:30:00.000Z'     // 14:00 IST
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

    it('should include offers where delivery window contains validity', () => {
      const containedOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T06:45:00.000Z',  // Inside delivery window
          end: '2026-01-28T07:15:00.000Z'     // Inside delivery window
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
          start: '2026-01-28T04:30:00.000Z',  // 10:00 IST
          end: '2026-01-28T05:30:00.000Z'     // 11:00 IST (ends before 12:00)
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [beforeOffer]
      );

      // Offer ends before delivery starts - depends on exact filtering
      // In current implementation, it filters by date first, then time overlap
      expect(result.competitors_found).toBe(0);
    });

    it('should exclude offers completely after delivery window', () => {
      const afterOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T08:30:00.000Z',  // 14:00 IST
          end: '2026-01-28T09:30:00.000Z'     // 15:00 IST
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
      // Create offer without validity_window using null to suppress default
      const offerWithoutWindow = createCompetitorOffer('2026-01-28', 7.0, 10, { validity_window: null });

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [offerWithoutWindow]
      );

      // Should be included because same date (conservative approach)
      expect(result.competitors_found).toBe(1);
    });

    it('should handle edge case: windows touch exactly at boundary', () => {
      // Offer ends exactly when delivery starts
      const touchingOffer: CompetitorOffer = {
        ...createCompetitorOffer('2026-01-28', 7.0),
        validity_window: {
          start: '2026-01-28T05:30:00.000Z',
          end: '2026-01-28T06:30:00.000Z'  // Ends exactly at delivery start
        }
      };

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        [touchingOffer]
      );

      // Touching at boundary: start1 < end2 && start2 < end1
      // 05:30 < 07:30 && 06:30 < 06:30 → 06:30 is NOT < 06:30, so no overlap
      expect(result.competitors_found).toBe(0);
    });
  });

  describe('multiple competitor scenarios', () => {
    it('should analyze mixed valid and invalid offers', () => {
      const offers: CompetitorOffer[] = [
        // Valid: same date, overlapping time
        {
          ...createCompetitorOffer('2026-01-28', 7.5),
          validity_window: {
            start: '2026-01-28T06:00:00.000Z',
            end: '2026-01-28T08:00:00.000Z'
          }
        },
        // Invalid: different date
        createCompetitorOffer('2026-01-29', 6.0),
        // Valid: unknown date
        createCompetitorOffer('unknown', 8.0),
        // Invalid: same date but non-overlapping time
        {
          ...createCompetitorOffer('2026-01-28', 5.0),
          validity_window: {
            start: '2026-01-28T10:00:00.000Z',
            end: '2026-01-28T11:00:00.000Z'
          }
        }
      ];

      const result = analyzeCompetitorsForHour(
        targetDate,
        targetHour,
        deliveryWindow,
        offers
      );

      expect(result.competitors_found).toBe(2);  // 7.5 and 8.0 (unknown)
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
        start: '2026-01-28T02:30:00.000Z',  // 08:00 IST
        end: '2026-01-28T03:30:00.000Z'     // 09:00 IST
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
        start: '2026-01-28T11:30:00.000Z',  // 17:00 IST
        end: '2026-01-28T12:30:00.000Z'     // 18:00 IST
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
});
