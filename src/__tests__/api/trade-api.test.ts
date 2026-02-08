/**
 * Integration tests for Trade API endpoints
 *
 * Tests /api/publish, /api/inventory, /api/settlements
 */

import { ObjectId } from 'mongodb';
import request from 'supertest';

import { createApp } from '../../app';
import { ledgerClient } from '../../services/ledger-client';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB, seedItem, seedOffer, seedSettlement } from '../../test-utils/db';

import type { Express } from 'express';


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
    const validPublishInput = {
      quantity: 10,
      price: 7.5,
      deliveryDate: '2026-01-28',
      startHour: 10,
      duration: 1,
      sourceType: 'SOLAR',
    };

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
      const response = await request(app)
        .post('/api/publish')
        .send(validPublishInput)
        .expect('Content-Type', /json/)
        .expect(200);

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

    it('should store auto-generated items and offers separately in their collections after publish', async () => {
      const publishInput = {
        quantity: 15,
        price: 8.0,
        deliveryDate: '2026-01-28',
        startHour: 10,
        duration: 1,
        sourceType: 'SOLAR',
      };

      const publishResponse = await request(app)
        .post('/api/publish')
        .send(publishInput)
        .expect(200);

      const { item_id, offer_id } = publishResponse.body;

      const itemsResponse = await request(app)
        .get('/api/items')
        .expect(200);

      const storedItem = itemsResponse.body.items.find((i: any) => i['beckn:id'] === item_id);
      expect(storedItem).toBeDefined();

      const offersResponse = await request(app)
        .get('/api/offers')
        .expect(200);

      const storedOffer = offersResponse.body.offers.find((o: any) => o['beckn:id'] === offer_id);
      expect(storedOffer).toBeDefined();
    });

    it('should return 403 when user has no generationProfile', async () => {
      // Replace the seeded prosumer with a consumer (no generationProfile)
      const db = getTestDB();
      await db.collection('users').deleteMany({});
      await db.collection('users').insertOne({
        _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
        phone: '1234567890',
        name: 'Test Consumer',
        vcVerified: true,
        profiles: {
          consumptionProfile: { did: 'did:example:consumer', meterNumber: '999' },
        },
        meters: ['999'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(app)
        .post('/api/publish')
        .send(validPublishInput)
        .expect(403);

      expect(response.body.error).toBe('NOT_PROSUMER');
      expect(response.body.message).toContain('generationProfile');
    });

    it('should return 400 when quantity is missing', async () => {
      const { quantity, ...noQuantity } = validPublishInput;

      const response = await request(app)
        .post('/api/publish')
        .send(noQuantity)
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when price is missing', async () => {
      const { price, ...noPrice } = validPublishInput;

      const response = await request(app)
        .post('/api/publish')
        .send(noPrice)
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when deliveryDate format is invalid', async () => {
      const response = await request(app)
        .post('/api/publish')
        .send({ ...validPublishInput, deliveryDate: '28-01-2026' })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should store catalog, item, and offer in DB with correct beckn structure', async () => {
      const response = await request(app)
        .post('/api/publish')
        .send(validPublishInput)
        .expect(200);

      const db = getTestDB();

      // Verify catalog in DB
      const catalog = await db.collection('catalogs').findOne({ 'beckn:id': response.body.catalog_id });
      expect(catalog).toBeDefined();
      expect(catalog!['@type']).toBe('beckn:Catalog');
      expect(catalog!['beckn:bppId']).toBeDefined();

      // Verify item has correct EnergyResource attributes
      const item = await db.collection('items').findOne({ 'beckn:id': response.body.item_id });
      expect(item).toBeDefined();
      expect(item!['beckn:itemAttributes']).toEqual(
        expect.objectContaining({
          '@type': 'EnergyResource',
          sourceType: 'SOLAR',
          meterId: '100200300',
        })
      );
      expect(item!['beckn:provider']['beckn:id']).toBe('did:example:test-provider');

      // Verify offer has correct price structure
      const offer = await db.collection('offers').findOne({ 'beckn:id': response.body.offer_id });
      expect(offer).toBeDefined();
      expect(offer!['beckn:price']['schema:price']).toBe(7.5);
      expect(offer!['beckn:price'].applicableQuantity.unitQuantity).toBe(10);
      expect(offer!['beckn:offerAttributes'].pricingModel).toBe('PER_KWH');
    });

    it('should return prosumer details from generationProfile', async () => {
      const response = await request(app)
        .post('/api/publish')
        .send(validPublishInput)
        .expect(200);

      expect(response.body.prosumer).toEqual({
        name: 'Test Prosumer',
        meterId: '100200300',
        utilityId: 'TPDDL',
      });
      expect(response.body.onix_forwarded).toBe(true);
    });

    it('should forward catalog to ONIX /bpp/caller/publish', async () => {
      await request(app)
        .post('/api/publish')
        .send(validPublishInput)
        .expect(200);

      // Verify ONIX publish was called
      expect(mockedAxios.post).toHaveBeenCalled();
      const publishCall = mockedAxios.post.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('/bpp/caller/publish')
      );
      expect(publishCall).toBeDefined();

      // Verify the request body has correct structure
      const publishBody = publishCall![1] as any;
      expect(publishBody.context.action).toBe('catalog_publish');
      expect(publishBody.context.bpp_id).toBeDefined();
      expect(publishBody.message.catalogs).toHaveLength(1);
      expect(publishBody.message.catalogs[0]['beckn:id']).toBeDefined();
    });

    it('should handle ONIX publish failure gracefully', async () => {
      // Make ONIX forwarding fail
      mockedAxios.post.mockRejectedValue(new Error('ONIX connection refused'));

      const response = await request(app)
        .post('/api/publish')
        .send(validPublishInput)
        .expect(200);

      // Publish should still succeed (catalog saved locally)
      expect(response.body.success).toBe(true);
      expect(response.body.onix_forwarded).toBe(false);

      // Verify catalog was still saved in DB despite ONIX failure
      const db = getTestDB();
      const catalog = await db.collection('catalogs').findOne({ 'beckn:id': response.body.catalog_id });
      expect(catalog).toBeDefined();
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

  describe('GET /api/published-items', () => {
    it('should return active items with matching offers for authenticated user', async () => {
      const db = getTestDB();
      const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

      // Seed an active item owned by the authenticated user
      await db.collection('items').insertOne({
        'beckn:id': 'item-pub-001',
        'beckn:isActive': true,
        'beckn:itemAttributes': {
          '@type': 'EnergyResource',
          sourceType: 'SOLAR',
          meterId: '100200300',
        },
        userId,
        catalogId: 'catalog-pub',
        updatedAt: new Date(),
      });

      // Seed a matching offer with quantity > 0
      await db.collection('offers').insertOne({
        'beckn:id': 'offer-pub-001',
        'beckn:items': ['item-pub-001'],
        'beckn:price': {
          '@type': 'schema:PriceSpecification',
          'schema:price': 7.5,
          applicableQuantity: { unitQuantity: 10, unitText: 'kWh' },
        },
        catalogId: 'catalog-pub',
        updatedAt: new Date(),
      });

      const response = await request(app)
        .get('/api/published-items')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]['beckn:id']).toBe('item-pub-001');
      expect(response.body.data[0]['beckn:offers']).toHaveLength(1);
      expect(response.body.data[0]['beckn:offers'][0]['beckn:id']).toBe('offer-pub-001');
    });

    it('should return empty array when user has no published items', async () => {
      const response = await request(app)
        .get('/api/published-items')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual([]);
    });

    it('should exclude inactive items and items with zero-quantity offers', async () => {
      const db = getTestDB();
      const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

      // Inactive item (should be excluded)
      await db.collection('items').insertOne({
        'beckn:id': 'item-inactive',
        'beckn:isActive': false,
        userId,
        catalogId: 'catalog-pub',
        updatedAt: new Date(),
      });

      // Active item but offer has zero quantity (should be excluded)
      await db.collection('items').insertOne({
        'beckn:id': 'item-zero-qty',
        'beckn:isActive': true,
        userId,
        catalogId: 'catalog-pub',
        updatedAt: new Date(),
      });
      await db.collection('offers').insertOne({
        'beckn:id': 'offer-zero-qty',
        'beckn:items': ['item-zero-qty'],
        'beckn:price': {
          applicableQuantity: { unitQuantity: 0 },
        },
        catalogId: 'catalog-pub',
        updatedAt: new Date(),
      });

      const response = await request(app)
        .get('/api/published-items')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual([]);
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
