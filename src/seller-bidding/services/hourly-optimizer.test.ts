/**
 * Tests for hourly-optimizer.ts
 *
 * Tests top-5 hourly selection, revenue calculation, and confirm flow
 */

import axios from 'axios';

import * as marketAnalyzer from '../../bidding/services/market-analyzer';
import { createDailyForecast, createMarketAnalysis } from '../../test-utils';
import { FLOOR_PRICE } from '../types';

import * as forecastReader from './hourly-forecast-reader';
import * as hourlyMarketAnalyzer from './hourly-market-analyzer';
import { preview } from './hourly-optimizer';

import type { SellerBidRequest} from '../types';


import { limitValidator } from '../../trade/limit-validator';

// Mock dependencies
jest.mock('axios');
jest.mock('./hourly-forecast-reader');
jest.mock('../../bidding/services/market-analyzer');
jest.mock('./hourly-market-analyzer');
jest.mock('../../trade/limit-validator');

const _mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedForecastReader = forecastReader as jest.Mocked<typeof forecastReader>;
const mockedMarketAnalyzer = marketAnalyzer as jest.Mocked<typeof marketAnalyzer>;
const mockedHourlyMarketAnalyzer = hourlyMarketAnalyzer as jest.Mocked<typeof hourlyMarketAnalyzer>;
const mockedLimitValidator = limitValidator as jest.Mocked<typeof limitValidator>;

describe('hourly-optimizer', () => {
  const mockRequest: SellerBidRequest = {
    provider_id: 'test-provider',
    meter_id: '100200300',
    source_type: 'SOLAR'
  };
  const mockSafeLimit = 20; // 20 kW
  const mockUserId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));

    // Default mocks
    mockedForecastReader.getTomorrowDate.mockReturnValue('2026-01-29');
    mockedMarketAnalyzer.fetchMarketData.mockResolvedValue([]);
    mockedMarketAnalyzer.calculatePrice.mockReturnValue({
      price: FLOOR_PRICE,
      reasoning: 'No competitors'
    });
    mockedHourlyMarketAnalyzer.analyzeCompetitorsForHour.mockReturnValue(
      createMarketAnalysis(null, 0)
    );
    // Default: no existing usage
    mockedLimitValidator.getSellerUsage.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('preview', () => {
    it('should return empty bids when no forecast available', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(null);

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.success).toBe(true);
      expect(result.bids).toHaveLength(0);
      expect(result.target_date).toBe('2026-01-29');
    });

    it('should return empty bids when no valid hours', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [
          { hour: '10:00', excess_kwh: 0.5 },  // Below threshold
          { hour: '11:00', excess_kwh: 0.3 }
        ])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [],
        skipped: [
          { hour: '10:00', reason: 'Below 1 kWh' },
          { hour: '11:00', reason: 'Below 1 kWh' }
        ]
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.bids).toHaveLength(0);
      expect(result.skipped_hours).toHaveLength(2);
    });

    it('should select all valid hours', async () => {
      const hourlyData = [
        { hour: '08:00', excess_kwh: 2 },
        { hour: '09:00', excess_kwh: 5 },
        { hour: '10:00', excess_kwh: 8 },
        { hour: '11:00', excess_kwh: 12 },
        { hour: '12:00', excess_kwh: 15 },
        { hour: '13:00', excess_kwh: 10 },
        { hour: '14:00', excess_kwh: 6 },
        { hour: '15:00', excess_kwh: 3 }
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData.filter(h => h.excess_kwh >= 1),
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.bids).toHaveLength(8);
      expect(result.summary.selected_hours).toBe(8);

      // All valid hours should be included
      const selectedHours = result.bids.map(b => b.hour);
      expect(selectedHours).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00']);
    });

    it('should return all valid hours if less than 5', async () => {
      const hourlyData = [
        { hour: '10:00', excess_kwh: 5 },
        { hour: '11:00', excess_kwh: 8 },
        { hour: '12:00', excess_kwh: 10 }
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.bids).toHaveLength(3);
      expect(result.summary.selected_hours).toBe(3);
    });

    it('should calculate expected revenue correctly', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 10 }];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      // 10 kWh * 6.0 INR = 60 INR
      expect(result.bids[0].expected_revenue_inr).toBe(60);
    });

    it('should include seller info in response', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.seller.provider_id).toBe('test-provider');
      expect(result.seller.meter_id).toBe('100200300');
      expect(result.seller.source_type).toBe('SOLAR');
    });

    it('should calculate summary correctly', async () => {
      const hourlyData = [
        { hour: '10:00', excess_kwh: 0.5 },  // Skipped
        { hour: '11:00', excess_kwh: 5 },    // Valid
        { hour: '12:00', excess_kwh: 10 }    // Valid
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue({
        date: '2026-01-29',
        hourly: hourlyData
      });
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData.filter(h => h.excess_kwh >= 1),
        skipped: [{ hour: '10:00', reason: 'Below threshold' }]
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.summary.total_hours_in_forecast).toBe(3);
      expect(result.summary.valid_hours).toBe(2);
      expect(result.summary.selected_hours).toBe(2);
      expect(result.summary.skipped_hours).toBe(1);
      expect(result.summary.total_quantity_kwh).toBe(15);
      expect(result.summary.total_expected_revenue_inr).toBe(90);
    });

    it('should include delivery and validity windows in bids', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.bids[0].delivery_window).toBeDefined();
      expect(result.bids[0].delivery_window.start).toBeDefined();
      expect(result.bids[0].validity_window).toBeDefined();
      expect(result.bids[0].validity_window.start).toBeDefined();
    });

    it('should sort selected bids by hour for display', async () => {
      const hourlyData = [
        { hour: '14:00', excess_kwh: 10 },
        { hour: '10:00', excess_kwh: 8 },
        { hour: '12:00', excess_kwh: 12 }
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      // Should be sorted by hour
      const hours = result.bids.map(b => b.hour);
      expect(hours).toEqual(['10:00', '12:00', '14:00']);
    });

    it('should handle CDS failure gracefully', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });
      mockedMarketAnalyzer.fetchMarketData.mockRejectedValue(new Error('CDS timeout'));

      const result = await preview(mockRequest, mockSafeLimit);

      // Should still succeed with floor price
      expect(result.success).toBe(true);
      expect(result.bids).toHaveLength(1);
      expect(result.bids[0].price_inr).toBe(FLOOR_PRICE);
    });
  });

  // describe('confirm', () => {
  //   beforeEach(() => {
  //     mockedAxios.post.mockResolvedValue({ status: 200, data: {} });
  //   });

  //   it('should publish bids sequentially', async () => {
  //     const hourlyData = [
  //       { hour: '10:00', excess_kwh: 5 },
  //       { hour: '11:00', excess_kwh: 8 }
  //     ];

  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(
  //       createDailyForecast('2026-01-29', hourlyData)
  //     );
  //     mockedForecastReader.filterValidHours.mockReturnValue({
  //       valid: hourlyData,
  //       skipped: []
  //     });

  //     const result = await confirm(mockRequest);

  //     expect(result.success).toBe(true);
  //     expect(result.placed_bids).toHaveLength(2);
  //     expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  //   });

  //   it('should halt on first publish failure', async () => {
  //     const hourlyData = [
  //       { hour: '10:00', excess_kwh: 5 },
  //       { hour: '11:00', excess_kwh: 8 },
  //       { hour: '12:00', excess_kwh: 10 }
  //     ];

  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(
  //       createDailyForecast('2026-01-29', hourlyData)
  //     );
  //     mockedForecastReader.filterValidHours.mockReturnValue({
  //       valid: hourlyData,
  //       skipped: []
  //     });

  //     mockedAxios.post
  //       .mockResolvedValueOnce({ status: 200 })
  //       .mockRejectedValueOnce(new Error('Publish failed'));

  //     const result = await confirm(mockRequest);

  //     expect(result.success).toBe(false);
  //     expect(result.placed_bids.filter(b => b.status === 'PUBLISHED')).toHaveLength(1);
  //     expect(result.failed_at).toBeDefined();
  //     expect(result.failed_at?.hour).toBe('11:00');
  //   });

  //   it('should return empty placed_bids when no bids to publish', async () => {
  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(null);

  //     const result = await confirm(mockRequest);

  //     expect(result.success).toBe(true);
  //     expect(result.placed_bids).toHaveLength(0);
  //     expect(result.failed_at).toBeNull();
  //   });

  //   it('should include catalog IDs in placed bids', async () => {
  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(
  //       createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
  //     );
  //     mockedForecastReader.filterValidHours.mockReturnValue({
  //       valid: [{ hour: '12:00', excess_kwh: 10 }],
  //       skipped: []
  //     });

  //     const result = await confirm(mockRequest);

  //     expect(result.placed_bids[0].catalog_id).toContain('catalog-');
  //     expect(result.placed_bids[0].offer_id).toContain('offer-');
  //     expect(result.placed_bids[0].item_id).toContain('item-');
  //   });

  //   it('should mark successful publishes as PUBLISHED', async () => {
  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(
  //       createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
  //     );
  //     mockedForecastReader.filterValidHours.mockReturnValue({
  //       valid: [{ hour: '12:00', excess_kwh: 10 }],
  //       skipped: []
  //     });

  //     const result = await confirm(mockRequest);

  //     expect(result.placed_bids[0].status).toBe('PUBLISHED');
  //   });

  //   it('should mark failed publish as FAILED with error', async () => {
  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(
  //       createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
  //     );
  //     mockedForecastReader.filterValidHours.mockReturnValue({
  //       valid: [{ hour: '12:00', excess_kwh: 10 }],
  //       skipped: []
  //     });

  //     mockedAxios.post.mockRejectedValue(new Error('Network error'));

  //     const result = await confirm(mockRequest);

  //     expect(result.placed_bids[0].status).toBe('FAILED');
  //     expect(result.placed_bids[0].error).toContain('Network error');
  //   });

  //   it('should include target_date in response', async () => {
  //     mockedForecastReader.getTomorrowForecast.mockReturnValue(null);

  //     const result = await confirm(mockRequest);

  //     expect(result.target_date).toBe('2026-01-29');
  //   });
  // });

  describe('seller usage subtraction', () => {
    it('should subtract existing usage from available quantity', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 16 }]; // PR-based generation: 16 kWh

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });
      // Seller already has 6 kWh listed for hour 12
      mockedLimitValidator.getSellerUsage.mockResolvedValue(6);

      const result = await preview(mockRequest, mockSafeLimit, mockUserId);

      // safeLimit=20, usage=6 → remaining=14. But generation=16 so min(14,16)=14
      expect(result.bids).toHaveLength(1);
      expect(result.bids[0].quantity_kwh).toBe(14);
    });

    it('should skip hour when capacity is fully allocated', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 16 }];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });
      // Seller already has 20 kWh listed (matches safeLimit)
      mockedLimitValidator.getSellerUsage.mockResolvedValue(20);

      const result = await preview(mockRequest, mockSafeLimit, mockUserId);

      expect(result.bids).toHaveLength(0);
      expect(result.skipped_hours).toHaveLength(1);
      expect(result.skipped_hours[0].reason).toContain('Capacity already allocated');
    });

    it('should skip hour when remaining capacity is below threshold', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 16 }];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });
      // 19.5 used out of 20 → only 0.5 remaining (below 1.0 kWh threshold)
      mockedLimitValidator.getSellerUsage.mockResolvedValue(19.5);

      const result = await preview(mockRequest, mockSafeLimit, mockUserId);

      expect(result.bids).toHaveLength(0);
      expect(result.skipped_hours).toHaveLength(1);
    });

    it('should handle different usage per hour', async () => {
      const hourlyData = [
        { hour: '10:00', excess_kwh: 16 },
        { hour: '11:00', excess_kwh: 16 },
        { hour: '12:00', excess_kwh: 16 },
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });
      // Different usage per hour
      mockedLimitValidator.getSellerUsage
        .mockResolvedValueOnce(5)   // 10:00 → 15 remaining
        .mockResolvedValueOnce(19.5) // 11:00 → 0.5 remaining (skipped)
        .mockResolvedValueOnce(0);   // 12:00 → 20 remaining, capped to 16

      const result = await preview(mockRequest, mockSafeLimit, mockUserId);

      expect(result.bids).toHaveLength(2); // 10:00 and 12:00
      expect(result.bids[0].hour).toBe('10:00');
      expect(result.bids[0].quantity_kwh).toBe(15);
      expect(result.bids[1].hour).toBe('12:00');
      expect(result.bids[1].quantity_kwh).toBe(16); // min(20, 16) = 16
      expect(result.skipped_hours).toHaveLength(1); // 11:00 skipped
    });

    it('should use full generation when userId is not provided', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 16 }];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });

      // No userId passed → no usage check
      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.bids[0].quantity_kwh).toBe(16);
      expect(mockedLimitValidator.getSellerUsage).not.toHaveBeenCalled();
    });

    it('should fall back to full generation when getSellerUsage fails', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 16 }];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });
      mockedLimitValidator.getSellerUsage.mockRejectedValue(new Error('DB error'));

      const result = await preview(mockRequest, mockSafeLimit, mockUserId);

      // Should still produce a bid with full quantity as fallback
      expect(result.bids).toHaveLength(1);
      expect(result.bids[0].quantity_kwh).toBe(16);
    });

    it('should calculate revenue based on available quantity, not generation', async () => {
      const hourlyData = [{ hour: '12:00', excess_kwh: 16 }];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });
      mockedLimitValidator.getSellerUsage.mockResolvedValue(10);

      const result = await preview(mockRequest, mockSafeLimit, mockUserId);

      // available = min(20-10, 16) = 10, revenue = 10 * 6.0 = 60
      expect(result.bids[0].quantity_kwh).toBe(10);
      expect(result.bids[0].expected_revenue_inr).toBe(60);
    });
  });

  describe('edge cases', () => {
    it('should handle single valid hour', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.bids).toHaveLength(1);
      expect(result.summary.selected_hours).toBe(1);
    });

    it('should handle hours with identical revenue', async () => {
      const hourlyData = [
        { hour: '10:00', excess_kwh: 10 },  // 60 INR
        { hour: '11:00', excess_kwh: 10 },  // 60 INR
        { hour: '12:00', excess_kwh: 10 }   // 60 INR
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData,
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      // All should be selected (< 5)
      expect(result.bids).toHaveLength(3);
    });

    it('should round quantities to 2 decimal places', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10.555 }])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10.555 }],
        skipped: []
      });

      const result = await preview(mockRequest, mockSafeLimit);

      expect(result.summary.total_quantity_kwh).toBe(10.56);
    });
  });
});
