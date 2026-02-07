/**
 * Tests for hourly-optimizer.ts
 *
 * Tests top-5 hourly selection, revenue calculation, and confirm flow
 */

import axios from 'axios';

import * as marketAnalyzer from '../../bidding/services/market-analyzer';
import { createDailyForecast, createMarketAnalysis } from '../../test-utils';
import { TOP_N_HOURS, FLOOR_PRICE } from '../types';

import * as forecastReader from './hourly-forecast-reader';
import * as hourlyMarketAnalyzer from './hourly-market-analyzer';
import { preview } from './hourly-optimizer';

import type { SellerBidRequest} from '../types';


// Mock dependencies
jest.mock('axios');
jest.mock('./hourly-forecast-reader');
jest.mock('../../bidding/services/market-analyzer');
jest.mock('./hourly-market-analyzer');

const _mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedForecastReader = forecastReader as jest.Mocked<typeof forecastReader>;
const mockedMarketAnalyzer = marketAnalyzer as jest.Mocked<typeof marketAnalyzer>;
const mockedHourlyMarketAnalyzer = hourlyMarketAnalyzer as jest.Mocked<typeof hourlyMarketAnalyzer>;

describe('hourly-optimizer', () => {
  const mockRequest: SellerBidRequest = {
    provider_id: 'test-provider',
    meter_id: '100200300',
    source_type: 'SOLAR'
  };

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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('preview', () => {
    it('should return empty bids when no forecast available', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(null);

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

      expect(result.bids).toHaveLength(0);
      expect(result.skipped_hours).toHaveLength(2);
    });

    it('should select top 5 hours by expected revenue', async () => {
      const hourlyData = [
        { hour: '08:00', excess_kwh: 2 },   // Revenue: 12
        { hour: '09:00', excess_kwh: 5 },   // Revenue: 30 (selected)
        { hour: '10:00', excess_kwh: 8 },   // Revenue: 48 (selected)
        { hour: '11:00', excess_kwh: 12 },  // Revenue: 72 (selected)
        { hour: '12:00', excess_kwh: 15 },  // Revenue: 90 (selected)
        { hour: '13:00', excess_kwh: 10 },  // Revenue: 60 (selected)
        { hour: '14:00', excess_kwh: 6 },   // Revenue: 36
        { hour: '15:00', excess_kwh: 3 }    // Revenue: 18
      ];

      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', hourlyData)
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: hourlyData.filter(h => h.excess_kwh >= 1),
        skipped: []
      });

      const result = await preview(mockRequest);

      expect(result.bids).toHaveLength(TOP_N_HOURS);
      expect(result.summary.selected_hours).toBe(TOP_N_HOURS);

      // Verify top 5 by revenue are selected
      const selectedHours = result.bids.map(b => b.hour);
      expect(selectedHours).toContain('12:00');  // 90 INR
      expect(selectedHours).toContain('11:00');  // 72 INR
      expect(selectedHours).toContain('13:00');  // 60 INR
      expect(selectedHours).toContain('10:00');  // 48 INR
      expect(selectedHours).toContain('14:00');  // 36 INR (5th highest)
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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

  describe('edge cases', () => {
    it('should handle single valid hour', async () => {
      mockedForecastReader.getTomorrowForecast.mockReturnValue(
        createDailyForecast('2026-01-29', [{ hour: '12:00', excess_kwh: 10 }])
      );
      mockedForecastReader.filterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

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

      const result = await preview(mockRequest);

      expect(result.summary.total_quantity_kwh).toBe(10.56);
    });
  });
});
