/**
 * Integration tests for Trade API endpoints
 *
 * Tests /api/publish, /api/inventory, /api/settlements
 */

import { Express } from 'express';
import request from 'supertest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB, seedItem, seedOffer, seedCatalog, seedSettlement } from '../../test-utils/db';
import { createBecknCatalog, createBecknItem, createBecknOffer, createBecknContext } from '../../test-utils';

// Mock external dependencies
jest.mock('axios');

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
  getPollingStatus: jest.fn().mockReturnValue({ running: false, lastPoll: null }),
  pollOnce: jest.fn(),
  refreshSettlement: jest.fn()
}));

// Mock ledger client
jest.mock('../../services/ledger-client', () => ({
  ledgerClient: {
    LEDGER_URL: 'http://test-ledger',
    getLedgerHealth: jest.fn().mockResolvedValue({ status: 'OK' }),
    fetchTradeRecords: jest.fn().mockResolvedValue([]),
    queryTrades: jest.fn().mockResolvedValue([])
  }
}));

// Mock authMiddleware to bypass auth for tests
// userId must be a valid 24-char hex string (MongoDB ObjectId format)
// because the publish route does new ObjectId(userId)
jest.mock('../../auth/routes', () => {
  const { Router } = require('express');
  return {
    authMiddleware: (req: any, res: any, next: any) => {
      req.user = { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '1234567890' };
      next();
    },
    authRoutes: () => Router()
  };
});

// Import app after mocking
import { createApp } from '../../app';
import { ledgerClient } from '../../services/ledger-client';
import axios from 'axios';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedLedgerClient = ledgerClient as jest.Mocked<typeof ledgerClient>;

describe('Trade API Integration Tests', () => {
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
  });

  describe('POST /api/publish', () => {
    // Seed a user with generationProfile before each publish test.
    // Direct insertOne is required because seedUser/seedUserWithProfiles
    // helpers don't accept a custom _id.
    beforeEach(async () => {
      const db = getTestDB();
      await db.collection('users').insertOne({
        _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
        phone: '1234567890',
        name: 'Test Prosumer',
        vcVerified: true,
        profiles: {
          generationProfile: {
            meterNumber: '100200300',
            utilityId: 'TPDDL',
            consumerNumber: 'CONS-001',
            did: 'did:example:test-provider',
          },
        },
        meters: ['100200300'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Mock ONIX forwarding (best-effort, non-blocking in the route)
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true, message: 'Catalog published' },
      });
    });

    it('should accept minimal publish input, build catalog server-side, and return catalog IDs', async () => {
      // Arrange: minimal input matching publishInputSchema
      const publishInput = {
        quantity: 10,
        price: 7.5,
        deliveryDate: '2026-01-28',
        startHour: 10,
        duration: 1,
        sourceType: 'SOLAR',
      };

      // Act
      const response = await request(app)
        .post('/api/publish')
        .send(publishInput)
        .expect('Content-Type', /json/)
        .expect(200);

      // Assert: response contains server-generated catalog IDs and prosumer info
      expect(response.body.success).toBe(true);
      expect(response.body.catalog_id).toBeDefined();
      expect(response.body.item_id).toBeDefined();
      expect(response.body.offer_id).toBeDefined();
      expect(response.body.prosumer).toEqual({
        name: 'Test Prosumer',
        meterId: '100200300',
        utilityId: 'TPDDL',
      });
    });

    it('should return error for invalid catalog structure', async () => {
      const response = await request(app)
        .post('/api/publish')
        .send({ context: {}, message: {} })
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it('should store items and offers separately', async () => {
      const item = createBecknItem('item-sep-001', 'test-provider', '100200300', 15);
      const offer = createBecknOffer('offer-sep-001', 'item-sep-001', 'test-provider', 8.0, 15);
      const catalog = createBecknCatalog('catalog-sep-001', [item], [offer]);

      await request(app)
        .post('/api/publish')
        .send({
          context: createBecknContext('catalog_publish'),
          message: { catalogs: [catalog] }
        })
        .expect(200);

      // Verify via inventory endpoint
      const inventoryResponse = await request(app)
        .get('/api/inventory')
        .expect(200);

      expect(inventoryResponse.body.items.some((i: any) => i['beckn:id'] === 'item-sep-001')).toBe(true);
    });
  });

  describe('GET /api/items', () => {
    beforeEach(async () => {
      await seedItem('item-list-001', 10);
      await seedItem('item-list-002', 20);
    });

    it('should return all items', async () => {
      const response = await request(app)
        .get('/api/items')
        .expect(200);

      expect(response.body.items.length).toBeGreaterThanOrEqual(2);
    });

    it('should return items with beckn structure', async () => {
      const response = await request(app)
        .get('/api/items')
        .expect(200);

      const item = response.body.items.find((i: any) => i['beckn:id'] === 'item-list-001');
      expect(item).toBeDefined();
      expect(item['beckn:itemAttributes']).toBeDefined();
    });
  });

  describe('GET /api/offers', () => {
    beforeEach(async () => {
      await seedOffer('offer-list-001', 'item-001', 7.5, 10);
      await seedOffer('offer-list-002', 'item-002', 8.0, 15);
    });

    it('should return all offers', async () => {
      const response = await request(app)
        .get('/api/offers')
        .expect(200);

      expect(response.body.offers.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/inventory', () => {
    beforeEach(async () => {
      await seedItem('item-inv-001', 10);
      await seedItem('item-inv-002', 25);
    });

    it('should return items with quantity', async () => {
      const response = await request(app)
        .get('/api/inventory')
        .expect(200);

      expect(response.body.items).toBeDefined();
      response.body.items.forEach((item: any) => {
        expect(item['beckn:itemAttributes'].availableQuantity).toBeDefined();
      });
    });
  });

  describe('GET /api/settlements', () => {
    beforeEach(async () => {
      await seedSettlement('txn-settle-001', 'SELLER', 'PENDING', 10);
      await seedSettlement('txn-settle-002', 'SELLER', 'SETTLED', 15);
    });

    it('should return all settlements', async () => {
      const response = await request(app)
        .get('/api/settlements')
        .expect(200);

      expect(response.body.settlements.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by status', async () => {
      const response = await request(app)
        .get('/api/settlements?status=PENDING')
        .expect(200);

      response.body.settlements.forEach((s: any) => {
        expect(s.settlementStatus).toBe('PENDING');
      });
    });
  });

  describe('GET /api/settlements/stats', () => {
    beforeEach(async () => {
      await seedSettlement('txn-stats-001', 'SELLER', 'PENDING');
      await seedSettlement('txn-stats-002', 'SELLER', 'SETTLED');
    });

    it('should return settlement statistics', async () => {
      const response = await request(app)
        .get('/api/settlements/stats')
        .expect(200);

      expect(response.body).toHaveProperty('stats');
      expect(response.body.stats).toHaveProperty('total');
      expect(response.body.stats).toHaveProperty('pending');
      expect(response.body.stats).toHaveProperty('settled');
    });
  });

  describe('POST /api/ledger/get', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return ledger records for valid request', async () => {
      const mockRecords = [
        {
          transactionId: 'txn-001',
          orderItemId: 'order-001',
          platformIdBuyer: 'p2p.terrarexenergy.com',
          platformIdSeller: 'p2p.terrarexenergy.com',
          discomIdBuyer: 'TPDDL',
          discomIdSeller: 'BESCOM',
          buyerId: 'buyer-001',
          sellerId: 'seller-001',
          tradeTime: '2026-01-15T10:00:00Z',
          deliveryStartTime: '2026-01-16T10:00:00Z',
          deliveryEndTime: '2026-01-16T11:00:00Z',
          tradeDetails: [{ tradeQty: 10, tradeType: 'ENERGY', tradeUnit: 'kWh' }]
        }
      ];
      mockedLedgerClient.queryTrades.mockResolvedValue(mockRecords);

      const response = await request(app)
        .post('/api/ledger/get')
        .send({ transactionId: 'txn-001' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.records).toEqual(mockRecords);
      expect(response.body.count).toBe(1);
    });

    it('should accept empty body with defaults', async () => {
      mockedLedgerClient.queryTrades.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/ledger/get')
        .send({})
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.records).toEqual([]);
      expect(response.body.count).toBe(0);
    });

    it('should validate limit parameter', async () => {
      const response = await request(app)
        .post('/api/ledger/get')
        .send({ limit: 200 }) // exceeds max of 100
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should validate offset parameter', async () => {
      const response = await request(app)
        .post('/api/ledger/get')
        .send({ offset: -1 }) // negative not allowed
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should validate sortOrder enum', async () => {
      const response = await request(app)
        .post('/api/ledger/get')
        .send({ sortOrder: 'invalid' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should pass all filter parameters to ledgerClient', async () => {
      mockedLedgerClient.queryTrades.mockResolvedValue([]);

      await request(app)
        .post('/api/ledger/get')
        .send({
          transactionId: 'txn-123',
          orderItemId: 'order-456',
          discomIdBuyer: 'TPDDL',
          discomIdSeller: 'BESCOM',
          limit: 50,
          offset: 10,
          sort: 'createdAt',
          sortOrder: 'desc'
        })
        .expect(200);

      expect(mockedLedgerClient.queryTrades).toHaveBeenCalledWith({
        transactionId: 'txn-123',
        orderItemId: 'order-456',
        discomIdBuyer: 'TPDDL',
        discomIdSeller: 'BESCOM',
        limit: 50,
        offset: 10,
        sort: 'createdAt',
        sortOrder: 'desc'
      });
    });

    it('should return 500 on ledger client error', async () => {
      mockedLedgerClient.queryTrades.mockRejectedValue(new Error('Ledger unavailable'));

      const response = await request(app)
        .post('/api/ledger/get')
        .send({})
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('LEDGER_ERROR');
      expect(response.body.error.details).toBe('Ledger unavailable');
    });
  });
});
