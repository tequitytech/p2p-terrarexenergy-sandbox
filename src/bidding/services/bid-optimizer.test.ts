/**
 * Tests for bid-optimizer.ts
 *
 * Tests bid calculation, preview generation, and confirm flow
 */

import axios from 'axios';

import { createCompetitorOffer, createValidityWindow } from '../../test-utils';
import { CompetitorOffer, FLOOR_PRICE } from '../types';


import { preview, confirm } from './bid-optimizer';
import * as forecastReader from './forecast-reader';
import * as marketAnalyzer from './market-analyzer';

import type { BidRequest, ProcessedDay} from '../types';


// Mock dependencies
jest.mock('axios');
jest.mock('./forecast-reader');
jest.mock('./market-analyzer');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedForecastReader = forecastReader as jest.Mocked<typeof forecastReader>;
const mockedMarketAnalyzer = marketAnalyzer as jest.Mocked<typeof marketAnalyzer>;

describe('bid-optimizer', () => {
  const mockRequest: BidRequest = {
    provider_id: 'test-provider',
    meter_id: '100200300',
    source_type: 'SOLAR'
  };

  const createProcessedDay = (date: string, bufferedQuantity: number, isBiddable: boolean): ProcessedDay => ({
    date,
    rawTotal: bufferedQuantity / 0.9,
    bufferedQuantity,
    isBiddable,
    validityWindow: createValidityWindow(date)
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    mockedMarketAnalyzer.fetchMarketData.mockResolvedValue([]);
    mockedMarketAnalyzer.analyzeCompetitors.mockReturnValue({
      competitors_found: 0,
      lowest_competitor_price: null,
      lowest_competitor_quantity_kwh: null,
      lowest_competitor_validity_window: null,
      lowest_competitor_id: null,
      cached: false
    });
    mockedMarketAnalyzer.calculatePrice.mockReturnValue({
      price: FLOOR_PRICE,
      reasoning: 'No competitors found. Bidding at floor: 6.00'
    });
  });

  describe('preview', () => {
    it('should return empty bids when no biddable days', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 2, false)],
        biddable: []
      });

      const result = await preview(mockRequest);

      expect(result.success).toBe(true);
      expect(result.bids).toHaveLength(0);
      expect(result.summary.biddable_days).toBe(0);
      expect(result.summary.skipped_days).toBe(1);
    });

    it('should calculate bids for biddable days', async () => {
      const biddableDays = [
        createProcessedDay('2026-01-28', 10, true),
        createProcessedDay('2026-01-29', 15, true)
      ];

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: biddableDays,
        biddable: biddableDays
      });

      const result = await preview(mockRequest);

      expect(result.success).toBe(true);
      expect(result.bids).toHaveLength(2);
      expect(result.summary.biddable_days).toBe(2);
    });

    it('should include seller info in response', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await preview(mockRequest);

      expect(result.seller.provider_id).toBe('test-provider');
      expect(result.seller.meter_id).toBe('100200300');
      expect(result.seller.source_type).toBe('SOLAR');
    });

    it('should calculate summary statistics correctly', async () => {
      const days = [
        createProcessedDay('2026-01-28', 10, true),
        createProcessedDay('2026-01-29', 20, true),
        createProcessedDay('2026-01-30', 3, false)  // Not biddable
      ];

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: days,
        biddable: days.filter(d => d.isBiddable)
      });

      const result = await preview(mockRequest);

      expect(result.summary.total_days).toBe(3);
      expect(result.summary.biddable_days).toBe(2);
      expect(result.summary.skipped_days).toBe(1);
      expect(result.summary.total_quantity_kwh).toBe(30);
    });

    it('should use floor price when no competitors found', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await preview(mockRequest);

      expect(result.bids[0].calculated_price_inr).toBe(FLOOR_PRICE);
      expect(result.bids[0].reasoning).toContain('No competitors');
    });

    it('should apply competitive pricing when competitors found', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const competitorOffers = [createCompetitorOffer('2026-01-28', 8.0)];
      mockedMarketAnalyzer.fetchMarketData.mockResolvedValue(competitorOffers);
      mockedMarketAnalyzer.analyzeCompetitors.mockReturnValue({
        competitors_found: 1,
        lowest_competitor_price: 8.0,
        lowest_competitor_quantity_kwh: 10,
        lowest_competitor_validity_window: createValidityWindow('2026-01-28'),
        lowest_competitor_id: 'competitor-001',
        cached: false
      });
      mockedMarketAnalyzer.calculatePrice.mockReturnValue({
        price: 7.6,  // 8.0 * 0.95
        reasoning: 'Undercut competitor'
      });

      const result = await preview(mockRequest);

      expect(result.bids[0].calculated_price_inr).toBe(7.6);
      expect(result.bids[0].market_analysis.competitors_found).toBe(1);
    });

    it('should handle market data fetch failure gracefully', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      mockedMarketAnalyzer.fetchMarketData.mockRejectedValue(new Error('CDS timeout'));

      const result = await preview(mockRequest);

      // Should still succeed but use floor price
      expect(result.success).toBe(true);
      expect(result.bids).toHaveLength(1);
    });

    it('should calculate revenue correctly', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await preview(mockRequest);

      // 10 kWh * 6.0 INR = 60 INR
      expect(result.summary.total_potential_revenue_inr).toBe(60);
      expect(result.summary.baseline_revenue_at_floor_inr).toBe(60);
      expect(result.summary.strategy_advantage_inr).toBe(0);
    });

    it('should calculate strategy advantage with competitive pricing', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      mockedMarketAnalyzer.calculatePrice.mockReturnValue({
        price: 7.0,  // Above floor
        reasoning: 'Competitive price'
      });

      const result = await preview(mockRequest);

      // 10 kWh * 7.0 = 70, baseline = 10 * 6.0 = 60, advantage = 10
      expect(result.summary.total_potential_revenue_inr).toBe(70);
      expect(result.summary.baseline_revenue_at_floor_inr).toBe(60);
      expect(result.summary.strategy_advantage_inr).toBe(10);
    });

    it('should include validity window in each bid', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await preview(mockRequest);

      expect(result.bids[0].validity_window).toBeDefined();
      expect(result.bids[0].validity_window.start).toContain('2026-01-28');
    });

    it('should include raw and buffered quantities in bids', async () => {
      const day = createProcessedDay('2026-01-28', 9, true);  // 9 is buffered
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [day],
        biddable: [day]
      });

      const result = await preview(mockRequest);

      expect(result.bids[0].buffered_quantity_kwh).toBe(9);
      expect(result.bids[0].raw_excess_kwh).toBe(10);  // 9 / 0.9
    });

    it('should set offering period from biddable days range', async () => {
      const days = [
        createProcessedDay('2026-01-28', 10, true),
        createProcessedDay('2026-01-29', 10, true),
        createProcessedDay('2026-01-30', 10, true)
      ];

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: days,
        biddable: days
      });

      const result = await preview(mockRequest);

      expect(result.seller.offering_period.start_date).toBe('2026-01-28');
      expect(result.seller.offering_period.end_date).toBe('2026-01-30');
    });
  });

  describe('confirm', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
    });

    it('should publish bids sequentially', async () => {
      const days = [
        createProcessedDay('2026-01-28', 10, true),
        createProcessedDay('2026-01-29', 15, true)
      ];

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: days,
        biddable: days
      });

      const result = await confirm(mockRequest);

      expect(result.success).toBe(true);
      expect(result.placed_bids).toHaveLength(2);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should halt on first publish failure', async () => {
      const days = [
        createProcessedDay('2026-01-28', 10, true),
        createProcessedDay('2026-01-29', 15, true),
        createProcessedDay('2026-01-30', 20, true)
      ];

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: days,
        biddable: days
      });

      // First succeeds, second fails
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200 })
        .mockRejectedValueOnce(new Error('Publish failed'));

      const result = await confirm(mockRequest);

      expect(result.success).toBe(false);
      expect(result.placed_bids).toHaveLength(1);
      expect(result.failed_at).toBeDefined();
      expect(result.failed_at?.date).toBe('2026-01-29');
      expect(result.failed_at?.error).toContain('Publish failed');
    });

    it('should return empty placed_bids when no biddable days', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 2, false)],
        biddable: []
      });

      const result = await confirm(mockRequest);

      expect(result.success).toBe(true);
      expect(result.placed_bids).toHaveLength(0);
      expect(result.failed_at).toBeNull();
    });

    it('should include catalog/offer/item IDs in placed bids', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await confirm(mockRequest);

      expect(result.placed_bids[0].catalog_id).toContain('catalog-');
      expect(result.placed_bids[0].offer_id).toContain('offer-');
      expect(result.placed_bids[0].item_id).toContain('item-');
    });

    it('should mark placed bids with PUBLISHED status', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await confirm(mockRequest);

      expect(result.placed_bids[0].status).toBe('PUBLISHED');
    });

    it('should respect maxBids limit', async () => {
      const days = [
        createProcessedDay('2026-01-28', 10, true),
        createProcessedDay('2026-01-29', 10, true),
        createProcessedDay('2026-01-30', 10, true)
      ];

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: days,
        biddable: days
      });

      const result = await confirm(mockRequest, 2);

      expect(result.placed_bids).toHaveLength(2);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should include quantity and price in placed bids', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await confirm(mockRequest);

      expect(result.placed_bids[0].quantity_kwh).toBe(10);
      expect(result.placed_bids[0].price_inr).toBe(FLOOR_PRICE);
    });

    it('should call correct publish API endpoint', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      await confirm(mockRequest);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/publish'),
        expect.any(Object),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        })
      );
    });
  });

  describe('edge cases', () => {
    it('should handle empty forecast file', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [],
        biddable: []
      });

      const result = await preview(mockRequest);

      expect(result.success).toBe(true);
      expect(result.bids).toHaveLength(0);
      expect(result.seller.offering_period.start_date).toBe('');
      expect(result.seller.offering_period.end_date).toBe('');
    });

    it('should handle single biddable day', async () => {
      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: [createProcessedDay('2026-01-28', 10, true)],
        biddable: [createProcessedDay('2026-01-28', 10, true)]
      });

      const result = await preview(mockRequest);

      expect(result.bids).toHaveLength(1);
      expect(result.seller.offering_period.start_date).toBe('2026-01-28');
      expect(result.seller.offering_period.end_date).toBe('2026-01-28');
    });

    it('should handle 7-day forecast', async () => {
      const days = Array.from({ length: 7 }, (_, i) => {
        const date = new Date('2026-01-28');
        date.setDate(date.getDate() + i);
        return createProcessedDay(date.toISOString().split('T')[0], 10 + i, true);
      });

      mockedForecastReader.getProcessedForecasts.mockReturnValue({
        all: days,
        biddable: days
      });

      const result = await preview(mockRequest);

      expect(result.bids).toHaveLength(7);
      expect(result.summary.total_days).toBe(7);
    });
  });
});
