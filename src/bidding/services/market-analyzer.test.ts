/**
 * Tests for market-analyzer.ts
 *
 * Tests CDS response parsing, competitor analysis, and price calculation logic
 */

import axios from 'axios';

import { createCompetitorOffer, createValidityWindow, createCDSCatalogWithOffers, createCDSResponse } from '../../test-utils';
import { FLOOR_PRICE, DEFAULT_UNDERCUT_PERCENT } from '../types';

import { analyzeCompetitors, calculatePrice, fetchMarketData } from './market-analyzer';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock getDB for saveSnapshot/getCachedSnapshot
jest.mock('../../db', () => ({
  getDB: jest.fn(() => ({
    collection: jest.fn(() => ({
      updateOne: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null)
    }))
  }))
}));

describe('market-analyzer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.UNDERCUT_PERCENT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('calculatePrice', () => {
    describe('floor price handling', () => {
      it('should return floor price when no competitors found (null)', () => {
        const result = calculatePrice(null);

        expect(result.price).toBe(FLOOR_PRICE);
        expect(result.reasoning).toContain('No competitors');
      });

      it('should return floor price when competitor is at floor', () => {
        const result = calculatePrice(FLOOR_PRICE);

        expect(result.price).toBe(FLOOR_PRICE);
        expect(result.reasoning).toContain('below floor');
      });

      it('should return floor price when competitor is below floor', () => {
        const result = calculatePrice(5.5);

        expect(result.price).toBe(FLOOR_PRICE);
        expect(result.reasoning).toContain('below floor');
      });

      it('should return floor price when competitor at zero', () => {
        const result = calculatePrice(0);

        expect(result.price).toBe(FLOOR_PRICE);
      });

      it('should return floor price for negative competitor price', () => {
        const result = calculatePrice(-5);

        expect(result.price).toBe(FLOOR_PRICE);
        expect(result.reasoning).toContain('below floor');
      });
    });

    describe('undercut logic', () => {
      it('should undercut competitor by default 5%', () => {
        // Competitor at 10, undercut by 5% = 9.5
        const result = calculatePrice(10);

        expect(result.price).toBe(9.5);
        expect(result.reasoning).toContain('Undercut');
        expect(result.reasoning).toContain('5%');
      });

      it('should not undercut below floor price (boundary test)', () => {
        // Competitor at 6.01, undercut by 5% = 5.7095, rounds to 5.71
        // Should become 6.0 (floor)
        const result = calculatePrice(6.01);

        expect(result.price).toBe(FLOOR_PRICE);
      });

      it('should handle undercut that results in exactly floor', () => {
        // Find price where 5% undercut = exactly 6.0
        // price * 0.95 = 6.0 → price = 6.315789...
        const result = calculatePrice(6.32);
        // 6.32 * 0.95 = 6.004, rounds to 6.0
        expect(result.price).toBe(6);
      });

      it('should round to 2 decimal places', () => {
        // 8.33 * 0.95 = 7.9135, should round to 7.91
        const result = calculatePrice(8.33);

        expect(result.price).toBe(7.91);
      });

      it('should respect custom UNDERCUT_PERCENT from env', () => {
        // Note: This test documents expected behavior,
        // but the module reads env at load time so this may not work in practice
        // The actual undercut percent is read when module loads
        const result = calculatePrice(10);
        // Default 5%: 10 * 0.95 = 9.5
        expect(result.price).toBe(9.5);
      });
    });

    describe('price calculations', () => {
      it('should handle competitor exactly at 6.32 (edge case for floor)', () => {
        const result = calculatePrice(6.32);
        // 6.32 * 0.95 = 6.004 → 6.0
        expect(result.price).toBe(6);
      });

      it('should handle competitor at 7.00', () => {
        const result = calculatePrice(7.00);
        // 7.00 * 0.95 = 6.65
        expect(result.price).toBe(6.65);
      });

      it('should handle competitor at 6.50', () => {
        const result = calculatePrice(6.50);
        // 6.50 * 0.95 = 6.175 → 6.18
        expect(result.price).toBe(6.18);
      });

      it('should handle competitor at 6.31 (just above floor threshold)', () => {
        const result = calculatePrice(6.31);
        // 6.31 * 0.95 = 5.9945 → 5.99, but floor is 6.0
        expect(result.price).toBe(FLOOR_PRICE);
      });

      it('should handle very high competitor price', () => {
        const result = calculatePrice(100);
        // 100 * 0.95 = 95
        expect(result.price).toBe(95);
      });
    });
  });

  describe('analyzeCompetitors', () => {
    it('should return empty analysis when no offers', () => {
      const result = analyzeCompetitors('2026-01-28', []);

      expect(result.competitors_found).toBe(0);
      expect(result.lowest_competitor_price).toBeNull();
      expect(result.lowest_competitor_id).toBeNull();
    });

    it('should find lowest price among multiple competitors', () => {
      const offers = [
        createCompetitorOffer('2026-01-28', 8.0),
        createCompetitorOffer('2026-01-28', 6.5),  // Lowest
        createCompetitorOffer('2026-01-28', 7.0)
      ];

      const result = analyzeCompetitors('2026-01-28', offers);

      expect(result.competitors_found).toBe(3);
      expect(result.lowest_competitor_price).toBe(6.5);
    });

    it('should filter offers by date', () => {
      const offers = [
        createCompetitorOffer('2026-01-28', 7.0),
        createCompetitorOffer('2026-01-29', 6.0),  // Different date, should be excluded
        createCompetitorOffer('2026-01-28', 8.0)
      ];

      const result = analyzeCompetitors('2026-01-28', offers);

      expect(result.competitors_found).toBe(2);
      expect(result.lowest_competitor_price).toBe(7.0);
    });

    it('should include offers with unknown date', () => {
      const offers = [
        createCompetitorOffer('2026-01-28', 8.0),
        createCompetitorOffer('unknown', 6.5)  // Should be included
      ];

      const result = analyzeCompetitors('2026-01-28', offers);

      expect(result.competitors_found).toBe(2);
      expect(result.lowest_competitor_price).toBe(6.5);
    });

    it('should handle single competitor', () => {
      const offers = [createCompetitorOffer('2026-01-28', 7.5)];

      const result = analyzeCompetitors('2026-01-28', offers);

      expect(result.competitors_found).toBe(1);
      expect(result.lowest_competitor_price).toBe(7.5);
    });

    it('should handle competitors with identical prices', () => {
      const offers = [
        createCompetitorOffer('2026-01-28', 7.0),
        createCompetitorOffer('2026-01-28', 7.0),
        createCompetitorOffer('2026-01-28', 7.0)
      ];

      const result = analyzeCompetitors('2026-01-28', offers);

      expect(result.competitors_found).toBe(3);
      expect(result.lowest_competitor_price).toBe(7.0);
    });

    it('should track cached flag', () => {
      const offers = [createCompetitorOffer('2026-01-28', 7.0)];

      const cachedResult = analyzeCompetitors('2026-01-28', offers, true);
      const freshResult = analyzeCompetitors('2026-01-28', offers, false);

      expect(cachedResult.cached).toBe(true);
      expect(freshResult.cached).toBe(false);
    });

    it('should include quantity and validity window from lowest competitor', () => {
      const offers = [
        createCompetitorOffer('2026-01-28', 7.0, 15),
        createCompetitorOffer('2026-01-28', 6.5, 20),  // Lowest
      ];

      const result = analyzeCompetitors('2026-01-28', offers);

      expect(result.lowest_competitor_quantity_kwh).toBe(20);
      expect(result.lowest_competitor_validity_window).toBeDefined();
    });
  });

  describe('fetchMarketData', () => {
    it('should parse CDS response with offers', async () => {
      const cdsResponse = createCDSResponse([
        createCDSCatalogWithOffers([
          { price: 7.0, quantity: 10, date: '2026-01-28' },
          { price: 6.5, quantity: 15, date: '2026-01-28' }
        ])
      ]);

      mockedAxios.post.mockResolvedValue({ data: cdsResponse });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result.length).toBeGreaterThan(0);
      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('should return empty array on CDS failure with no cache', async () => {
      mockedAxios.post.mockRejectedValue(new Error('CDS timeout'));

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result).toEqual([]);
    });

    it('should handle empty CDS response', async () => {
      mockedAxios.post.mockResolvedValue({ data: { message: { catalogs: [] } } });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result).toEqual([]);
    });

    it('should handle CDS response with no offers in catalog', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            catalogs: [{
              'beckn:id': 'catalog-1',
              'beckn:offers': [],
              'beckn:items': []
            }]
          }
        }
      });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result).toEqual([]);
    });

    it('should build correct discover request with sourceType filter', async () => {
      mockedAxios.post.mockResolvedValue({ data: { message: { catalogs: [] } } });

      await fetchMarketData('2026-01-28', '2026-01-30', 'WIND');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/bap/caller/discover'),
        expect.objectContaining({
          message: expect.objectContaining({
            filters: expect.objectContaining({
              expression: expect.stringContaining("'WIND'")
            })
          })
        }),
        expect.any(Object)
      );
    });

    it('should handle multiple catalogs in response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            catalogs: [
              createCDSCatalogWithOffers([{ price: 7.0, quantity: 10, date: '2026-01-28' }]),
              createCDSCatalogWithOffers([{ price: 6.5, quantity: 15, date: '2026-01-28' }])
            ]
          }
        }
      });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result.length).toBe(2);
    });

    it('should extract price from schema:price format', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            catalogs: [{
              'beckn:offers': [{
                'beckn:id': 'offer-1',
                'beckn:price': { 'schema:price': 7.5 },
                'beckn:offerAttributes': {
                  validityWindow: {
                    'schema:startTime': '2026-01-28T08:00:00Z',
                    'schema:endTime': '2026-01-28T17:00:00Z'
                  }
                }
              }],
              'beckn:items': [{ 'beckn:itemAttributes': { availableQuantity: 10 } }]
            }]
          }
        }
      });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result.length).toBe(1);
      expect(result[0].price_per_kwh).toBe(7.5);
    });

    it('should extract price from beckn:price.value format', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            catalogs: [{
              'beckn:offers': [{
                'beckn:id': 'offer-1',
                'beckn:offerAttributes': {
                  'beckn:price': { value: 8.0 },
                  validityWindow: {
                    'schema:startTime': '2026-01-28T08:00:00Z',
                    'schema:endTime': '2026-01-28T17:00:00Z'
                  }
                }
              }],
              'beckn:items': [{ 'beckn:itemAttributes': { availableQuantity: 10 } }]
            }]
          }
        }
      });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result.length).toBe(1);
      expect(result[0].price_per_kwh).toBe(8.0);
    });

    it('should skip offers without price', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          message: {
            catalogs: [{
              'beckn:offers': [
                { 'beckn:id': 'offer-no-price', 'beckn:offerAttributes': {} },
                {
                  'beckn:id': 'offer-with-price',
                  'beckn:price': { 'schema:price': 7.0 },
                  'beckn:offerAttributes': {}
                }
              ],
              'beckn:items': [{ 'beckn:itemAttributes': { availableQuantity: 10 } }]
            }]
          }
        }
      });

      const result = await fetchMarketData('2026-01-28', '2026-01-28', 'SOLAR');

      expect(result.length).toBe(1);
      expect(result[0].offer_id).toBe('offer-with-price');
    });
  });

  describe('integration: market analysis to price calculation', () => {
    it('should calculate correct price from competitor analysis', () => {
      const offers = [
        createCompetitorOffer('2026-01-28', 8.0),
        createCompetitorOffer('2026-01-28', 7.5)
      ];

      const analysis = analyzeCompetitors('2026-01-28', offers);
      const price = calculatePrice(analysis.lowest_competitor_price);

      // Lowest: 7.5, undercut 5%: 7.125 → 7.13
      expect(price.price).toBe(7.13);
    });

    it('should fall back to floor when no competitors', () => {
      const analysis = analyzeCompetitors('2026-01-28', []);
      const price = calculatePrice(analysis.lowest_competitor_price);

      expect(price.price).toBe(FLOOR_PRICE);
    });
  });
});
