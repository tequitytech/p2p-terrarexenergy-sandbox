/**
 * Integration tests for Bidding API endpoints
 *
 * Tests /api/bid/* and /api/seller/* endpoints
 */

import { Express } from 'express';
import request from 'supertest';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { setupTestDB, teardownTestDB, clearTestDB, seedUserWithProfiles } from '../../test-utils/db';
import { createWeekForecast, createDailyForecast } from '../../test-utils';

// Mock axios
jest.mock('axios');

// Mock the forecast reader to avoid fs issues
jest.mock('../../bidding/services/forecast-reader', () => ({
  readForecast: jest.fn(),
  processDailyForecast: jest.fn(),
  getProcessedForecasts: jest.fn()
}));

jest.mock('../../seller-bidding/services/hourly-forecast-reader', () => ({
  getTomorrowDate: jest.fn().mockReturnValue('2026-01-29'),
  getTomorrowForecast: jest.fn(),
  filterValidHours: jest.fn()
}));

// Mock DB connection
jest.mock('../../db', () => {
  const { getTestDB } = require('../../test-utils/db');
  return {
    getDB: () => getTestDB(),
    connectDB: jest.fn().mockResolvedValue(undefined)
  };
});

// Mock settlement poller
jest.mock('../../services/settlement-poller', () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
  getPollingStatus: jest.fn().mockReturnValue({ running: false, lastPoll: null })
}));

// Mock ledger client
jest.mock('../../services/ledger-client', () => ({
  ledgerClient: {
    LEDGER_URL: 'http://test-ledger',
    getLedgerHealth: jest.fn().mockResolvedValue({ status: 'OK' }),
    fetchTradeRecords: jest.fn().mockResolvedValue([])
  }
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

// Import mocked modules
import { readForecast, processDailyForecast, getProcessedForecasts } from '../../bidding/services/forecast-reader';
import { getTomorrowDate, getTomorrowForecast, filterValidHours } from '../../seller-bidding/services/hourly-forecast-reader';

const mockedReadForecast = readForecast as jest.MockedFunction<typeof readForecast>;
const mockedProcessDailyForecast = processDailyForecast as jest.MockedFunction<typeof processDailyForecast>;
const mockedGetProcessedForecasts = getProcessedForecasts as jest.MockedFunction<typeof getProcessedForecasts>;
const mockedGetTomorrowDate = getTomorrowDate as jest.MockedFunction<typeof getTomorrowDate>;
const mockedGetTomorrowForecast = getTomorrowForecast as jest.MockedFunction<typeof getTomorrowForecast>;
const mockedFilterValidHours = filterValidHours as jest.MockedFunction<typeof filterValidHours>;

// Import app after mocking
import { createApp } from '../../app';

describe('Bidding API Integration Tests', () => {
  let app: Express;
  let token: string;

  beforeAll(async () => {
    await setupTestDB();
    app = await createApp();

    // Generate valid token for seller tests
    token = jwt.sign(
      { phone: '9999999999', userId: '507f1f77bcf86cd799439011' },
      'p2p-trading-pilot-secret',
      { algorithm: 'HS256' }
    );
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    jest.clearAllMocks();  // Only clear call history, not implementations

    // Explicitly reset and re-apply axios.post mock to handle all API calls
    mockedAxios.post.mockReset();
    mockedAxios.post.mockImplementation((url: string) => {
      // Publish API
      if (url.includes('/publish')) {
        return Promise.resolve({
          status: 200,
          data: {
            success: true,
            catalog_id: 'test-catalog-id',
            item_id: 'test-item-id',
            offer_id: 'test-offer-id'
          }
        });
      }
      // Discover API (market data)
      if (url.includes('/discover') || url.includes('bap/caller')) {
        return Promise.resolve({
          status: 200,
          data: {
            message: {
              catalogs: []  // Empty catalogs - no competitor data
            }
          }
        });
      }
      // Default: return success
      return Promise.resolve({ status: 200, data: { success: true } });
    });

    // Seed user for seller tests
    await seedUserWithProfiles({
      phone: '9999999999',
      name: 'Test Seller',
      pin: '123456',
      profiles: {
        generationProfile: {
          did: 'did:rcw:provider-001',
          meterNumber: '100200300'
        }
      }
    });
  });

  describe('POST /api/bid/preview', () => {
    it('should return 7-day bid preview', async () => {
      const forecasts = createWeekForecast();
      mockedReadForecast.mockReturnValue(forecasts);
      mockedProcessDailyForecast.mockImplementation((day) => ({
        date: day.date,
        rawTotal: 50,
        bufferedQuantity: 45,
        isBiddable: true,
        validityWindow: { start: `${day.date}T08:00:00Z`, end: `${day.date}T17:00:00Z` }
      }));

      // Mock getProcessedForecasts for controller
      mockedGetProcessedForecasts.mockReturnValue({
        all: forecasts.map(f => ({
          date: f.date,
          rawTotal: 50,
          bufferedQuantity: 45,
          isBiddable: true,
          validityWindow: { start: `${f.date}T08:00:00Z`, end: `${f.date}T17:00:00Z` }
        })),
        biddable: forecasts.map(f => ({
          date: f.date,
          rawTotal: 50,
          bufferedQuantity: 45,
          isBiddable: true,
          validityWindow: { start: `${f.date}T08:00:00Z`, end: `${f.date}T17:00:00Z` }
        }))
      });

      const response = await request(app)
        .post('/api/bid/preview')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.bids).toBeDefined();
      expect(response.body.summary).toBeDefined();
    });

    it('should return empty bids when no forecast data', async () => {
      mockedReadForecast.mockReturnValue([]);
      mockedGetProcessedForecasts.mockReturnValue({ all: [], biddable: [] }); // Update mock here too

      const response = await request(app)
        .post('/api/bid/preview')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.bids).toEqual([]);
    });

    it('should reject invalid request body', async () => {
      const response = await request(app)
        .post('/api/bid/preview')
        .send({})  // Missing required fields
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/bid/confirm', () => {
    it('should publish bids and return placed_bids', async () => {
      const forecasts = createWeekForecast();
      mockedGetProcessedForecasts.mockReturnValue({
        all: forecasts.map(f => ({
          date: f.date,
          rawTotal: 50,
          bufferedQuantity: 45,
          isBiddable: true,
          validityWindow: { start: `${f.date}T08:00:00Z`, end: `${f.date}T17:00:00Z` }
        })),
        biddable: forecasts.map(f => ({
          date: f.date,
          rawTotal: 50,
          bufferedQuantity: 45,
          isBiddable: true,
          validityWindow: { start: `${f.date}T08:00:00Z`, end: `${f.date}T17:00:00Z` }
        }))
      });
      mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });

      const response = await request(app)
        .post('/api/bid/confirm')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.placed_bids).toBeDefined();
    });

    it('should handle publish failures gracefully', async () => {
      const forecasts = createWeekForecast();
      mockedGetProcessedForecasts.mockReturnValue({
        all: forecasts.map(f => ({
          date: f.date,
          rawTotal: 50,
          bufferedQuantity: 45,
          isBiddable: true,
          validityWindow: { start: `${f.date}T08:00:00Z`, end: `${f.date}T17:00:00Z` }
        })),
        biddable: forecasts.map(f => ({
          date: f.date,
          rawTotal: 50,
          bufferedQuantity: 45,
          isBiddable: true,
          validityWindow: { start: `${f.date}T08:00:00Z`, end: `${f.date}T17:00:00Z` }
        }))
      });
      // For this scenario, allow market data calls to succeed but force the
      // internal /publish call to fail so that confirm halts and reports failure.
      mockedAxios.post.mockImplementation((url: string) => {
        if (url.includes('/publish')) {
          return Promise.reject(new Error('Publish failed'));
        }
        if (url.includes('/discover') || url.includes('bap/caller')) {
          return Promise.resolve({
            status: 200,
            data: {
              message: {
                catalogs: []
              }
            }
          });
        }
        return Promise.resolve({ status: 200, data: { success: true } });
      });

      const response = await request(app)
        .post('/api/bid/confirm')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.success).toBe(false);
      expect(response.body.failed_at).toBeDefined();
    });
  });

  describe('POST /api/seller/preview', () => {
    beforeEach(() => {
      // Re-apply axios mock for seller endpoints with all external calls mocked.
      mockedAxios.post.mockReset();
      mockedAxios.post.mockImplementation((url: string) => {
        if (url.includes('/publish')) {
          return Promise.resolve({
            status: 200,
            data: { success: true, catalog_id: 'test', item_id: 'test', offer_id: 'test' }
          });
        }
        if (url.includes('/discover') || url.includes('bap/caller')) {
          return Promise.resolve({
            status: 200,
            data: { message: { catalogs: [] } }
          });
        }
        return Promise.resolve({ status: 200, data: { success: true } });
      });
    });

    it('should return top 5 hourly bids', async () => {
      mockedGetTomorrowForecast.mockReturnValue({
        date: '2026-01-29',
        hourly: [
          { hour: '08:00', excess_kwh: 2 },
          { hour: '09:00', excess_kwh: 5 },
          { hour: '10:00', excess_kwh: 8 },
          { hour: '11:00', excess_kwh: 12 },
          { hour: '12:00', excess_kwh: 15 }
        ]
      });
      mockedFilterValidHours.mockReturnValue({
        valid: [
          { hour: '10:00', excess_kwh: 8 },
          { hour: '11:00', excess_kwh: 12 },
          { hour: '12:00', excess_kwh: 15 }
        ],
        skipped: [
          { hour: '08:00', reason: 'Below 1 kWh minimum' }
        ]
      });

      const response = await request(app)
        .post('/api/seller/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.bids.length).toBeLessThanOrEqual(5);
      expect(response.body.target_date).toBe('2026-01-29');
    });

    it('should track skipped hours', async () => {
      mockedGetTomorrowForecast.mockReturnValue({
        date: '2026-01-29',
        hourly: [
          { hour: '10:00', excess_kwh: 0.5 },  // Below threshold
          { hour: '11:00', excess_kwh: 5 }     // Valid
        ]
      });
      mockedFilterValidHours.mockReturnValue({
        valid: [{ hour: '11:00', excess_kwh: 5 }],
        skipped: [{ hour: '10:00', reason: 'Below 1 kWh minimum' }]
      });

      const response = await request(app)
        .post('/api/seller/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.skipped_hours.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/seller/confirm', () => {
    beforeEach(() => {
      mockedGetTomorrowDate.mockReturnValue('2026-01-29');
    });

    it('should publish hourly bids', async () => {
      mockedGetTomorrowForecast.mockReturnValue({
        date: '2026-01-29',
        hourly: [{ hour: '12:00', excess_kwh: 10 }]
      });
      mockedFilterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });
      mockedAxios.post.mockResolvedValue({ status: 200, data: {} });

      const response = await request(app)
        .post('/api/seller/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.placed_bids).toBeDefined();
    });
  });
});

