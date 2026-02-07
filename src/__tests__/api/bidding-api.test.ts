/**
 * Integration tests for Bidding API endpoints
 *
 * Tests /api/bid/* and /api/seller/* endpoints
 */

import axios from 'axios';

import type { Express } from 'express';

import { ObjectId } from 'mongodb';
import request from 'supertest';


// Mock axios
jest.mock('axios');

// Mock the forecast reader — must include getProcessedForecasts (used by bid-optimizer)
jest.mock('../../bidding/services/forecast-reader', () => ({
  readForecast: jest.fn(),
  processDailyForecast: jest.fn(),
  getProcessedForecasts: jest.fn()
}));

// Mock hourly forecast reader — must include getTomorrowDate (used by hourly-optimizer)
jest.mock('../../seller-bidding/services/hourly-forecast-reader', () => ({
  getTomorrowDate: jest.fn(),
  getTomorrowForecast: jest.fn(),
  filterValidHours: jest.fn()
}));

// Mock auth routes — pass-through middleware that sets req.user
jest.mock('../../auth/routes', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '9876543210' };
    next();
  },
  authRoutes: () => {
    const { Router } = require('express');
    return Router();
  },
  signToken: jest.fn(),
  verifyToken: jest.fn(),
  validateBody: jest.fn(),
  loginSchema: {},
  verifyVcSchema: {}
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

// Import app and mocked modules after mocking
import { createApp } from '../../app';
import { getProcessedForecasts } from '../../bidding/services/forecast-reader';
import { getTomorrowDate, getTomorrowForecast, filterValidHours } from '../../seller-bidding/services/hourly-forecast-reader';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../../test-utils/db';

import type { ProcessedDay } from '../../bidding/types';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedGetProcessedForecasts = getProcessedForecasts as jest.MockedFunction<typeof getProcessedForecasts>;
const mockedGetTomorrowDate = getTomorrowDate as jest.MockedFunction<typeof getTomorrowDate>;
const mockedGetTomorrowForecast = getTomorrowForecast as jest.MockedFunction<typeof getTomorrowForecast>;
const mockedFilterValidHours = filterValidHours as jest.MockedFunction<typeof filterValidHours>;

/**
 * Helper: build 7 ProcessedDay objects from createWeekForecast dates
 */
function buildProcessedDays(startDate: string = '2026-01-28'): ProcessedDay[] {
  const days: ProcessedDay[] = [];
  const base = new Date(startDate);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    days.push({
      date: dateStr,
      rawTotal: 50,
      bufferedQuantity: 45,
      isBiddable: true,
      validityWindow: { start: `${dateStr}T08:00:00Z`, end: `${dateStr}T17:00:00Z` }
    });
  }
  return days;
}

describe('Bidding API Integration Tests', () => {
  let app: Express;

  beforeAll(async () => {
    await setupTestDB();
    app = await createApp();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    jest.clearAllMocks();
  });

  describe('POST /api/bid/preview', () => {
    it('should return 7-day bid preview with market-competitive pricing', async () => {
      // Arrange
      const processed = buildProcessedDays();
      mockedGetProcessedForecasts.mockReturnValue({ all: processed, biddable: processed });
      // Mock CDS discover call — return empty catalogs so bid uses floor price
      mockedAxios.post.mockResolvedValue({ status: 200, data: { message: { catalogs: [] } } });

      // Act
      const response = await request(app)
        .post('/api/bid/preview')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      // Assert
      expect(response.body.success).toBe(true);
      expect(response.body.bids).toBeDefined();
      expect(response.body.bids.length).toBe(7);
      expect(response.body.summary).toBeDefined();
      expect(response.body.summary.biddable_days).toBe(7);
    });

    it('should return empty bids array when forecast has no biddable days', async () => {
      // Arrange — no biddable days
      mockedGetProcessedForecasts.mockReturnValue({ all: [], biddable: [] });

      // Act
      const response = await request(app)
        .post('/api/bid/preview')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      // Assert
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
    it('should publish all calculated bids sequentially and return placed_bids with catalog IDs', async () => {
      // Arrange
      const processed = buildProcessedDays();
      mockedGetProcessedForecasts.mockReturnValue({ all: processed, biddable: processed });
      // Mock axios.post for both CDS discover and internal publish calls
      mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });

      // Act
      const response = await request(app)
        .post('/api/bid/confirm')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      // Assert
      expect(response.body.success).toBe(true);
      expect(response.body.placed_bids).toBeDefined();
      expect(response.body.placed_bids.length).toBeGreaterThan(0);
    });

    it('should halt on first publish failure and return failed_at with error details', async () => {
      // Arrange
      const processed = buildProcessedDays();
      mockedGetProcessedForecasts.mockReturnValue({ all: processed, biddable: processed });
      // First call = CDS discover (succeeds with empty catalogs), subsequent calls = publish (all fail)
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { message: { catalogs: [] } } })
        .mockRejectedValue(new Error('Publish failed'));

      // Act
      const response = await request(app)
        .post('/api/bid/confirm')
        .send({
          provider_id: 'test-provider',
          meter_id: '100200300',
          source_type: 'SOLAR'
        })
        .expect(200);

      // Assert
      expect(response.body.success).toBe(false);
      expect(response.body.failed_at).toBeDefined();
      expect(response.body.failed_at.error).toContain('Publish failed');
    });
  });

  describe('POST /api/seller/preview', () => {
    const SELLER_USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    beforeEach(async () => {
      // Seed user with generationProfile for getSellerDetailsFromAuth()
      const db = getTestDB();
      await db.collection('users').insertOne({
        _id: new ObjectId(SELLER_USER_ID),
        phone: '9876543210',
        name: 'Test Seller',
        profiles: {
          generationProfile: {
            meterNumber: '100200300',
            utilityId: 'BESCOM',
            consumerNumber: 'CN-001',
            did: 'did:example:seller-provider'
          }
        }
      });
    });

    it('should return at most 5 highest-revenue hourly bids for tomorrow', async () => {
      // Arrange
      mockedGetTomorrowDate.mockReturnValue('2026-01-29');
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
      // Mock CDS discover call
      mockedAxios.post.mockResolvedValue({ status: 200, data: { message: { catalogs: [] } } });

      // Act
      const response = await request(app)
        .post('/api/seller/preview')
        .send({ source_type: 'SOLAR' })
        .expect(200);

      // Assert
      expect(response.body.success).toBe(true);
      expect(response.body.bids.length).toBeLessThanOrEqual(5);
      expect(response.body.target_date).toBe('2026-01-29');
    });

    it('should report skipped hours that fall below minimum kWh threshold', async () => {
      // Arrange
      mockedGetTomorrowDate.mockReturnValue('2026-01-29');
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
      // Mock CDS discover call
      mockedAxios.post.mockResolvedValue({ status: 200, data: { message: { catalogs: [] } } });

      // Act
      const response = await request(app)
        .post('/api/seller/preview')
        .send({ source_type: 'SOLAR' })
        .expect(200);

      // Assert
      expect(response.body.skipped_hours.length).toBeGreaterThan(0);
      expect(response.body.skipped_hours[0].hour).toBe('10:00');
    });
  });

  describe('POST /api/seller/confirm', () => {
    const SELLER_USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    beforeEach(async () => {
      // Seed user with generationProfile for getSellerDetailsFromAuth()
      const db = getTestDB();
      await db.collection('users').insertOne({
        _id: new ObjectId(SELLER_USER_ID),
        phone: '9876543210',
        name: 'Test Seller',
        profiles: {
          generationProfile: {
            meterNumber: '100200300',
            utilityId: 'BESCOM',
            consumerNumber: 'CN-001',
            did: 'did:example:seller-provider'
          }
        }
      });
    });

    it('should publish hourly bids to ONIX and return placed_bids with status', async () => {
      // Arrange
      mockedGetTomorrowDate.mockReturnValue('2026-01-29');
      mockedGetTomorrowForecast.mockReturnValue({
        date: '2026-01-29',
        hourly: [{ hour: '12:00', excess_kwh: 10 }]
      });
      mockedFilterValidHours.mockReturnValue({
        valid: [{ hour: '12:00', excess_kwh: 10 }],
        skipped: []
      });
      // First call = CDS discover, second call = internal publish
      mockedAxios.post
        .mockResolvedValueOnce({ status: 200, data: { message: { catalogs: [] } } })
        .mockResolvedValue({ status: 200, data: { catalog_id: 'cat-1', offer_id: 'offer-1', item_id: 'item-1' } });

      // Act
      const response = await request(app)
        .post('/api/seller/confirm')
        .send({ source_type: 'SOLAR' })
        .expect(200);

      // Assert
      expect(response.body.success).toBe(true);
      expect(response.body.placed_bids).toBeDefined();
      expect(response.body.placed_bids.length).toBeGreaterThan(0);
      expect(response.body.placed_bids[0].status).toBe('PUBLISHED');
    });
  });
});
