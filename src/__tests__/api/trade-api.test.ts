/**
 * Integration tests for Trade API endpoints
 *
 * Tests /api/publish, /api/inventory, /api/settlements
 */

import { Express } from 'express';
import request from 'supertest';
import express from 'express';
import { setupTestDB, teardownTestDB, clearTestDB, seedItem, seedOffer, seedCatalog, seedSettlement } from '../../test-utils/db';
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
    fetchTradeRecords: jest.fn().mockResolvedValue([])
  }
}));

// Import app after mocking
import { createApp } from '../../app';

// Import jwt and user seeding utils
import jwt from 'jsonwebtoken';
import { getTestUser, seedUserWithProfiles } from '../../test-utils/db';

describe('Trade API Integration Tests', () => {
  let app: Express;
  let token: string;

  beforeAll(async () => {
    await setupTestDB();
    app = await createApp();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();

    // Seed a prosumer user for publish tests
    await seedUserWithProfiles({
      name: 'Test Prosumer',
      phone: '1234567890',
      pin: '123456',
      profiles: {
        generationProfile: {
          did: 'did:rcw:provider-001',
          meterNumber: '100200300',
          utilityId: 'BESCOM',
          consumerNumber: 'CONS001'
        }
      }
    });

    const user = await getTestUser('1234567890');
    token = jwt.sign(
      { phone: user.phone, userId: user._id.toString() },
      'p2p-trading-pilot-secret',
      { algorithm: 'HS256' }
    );
  });

  describe('POST /api/publish', () => {
    it('should store catalog and return success', async () => {
      const publishInput = {
        quantity: 10,
        price: 5.5,
        deliveryDate: '2026-01-30',
        startHour: 12,
        duration: 2,
        sourceType: 'SOLAR'
      };

      const response = await request(app)
        .post('/api/publish')
        .set('Authorization', `Bearer ${token}`)
        .send(publishInput)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.catalog_id).toBeDefined();
      expect(response.body.item_id).toBeDefined();
      expect(response.body.offer_id).toBeDefined();
    });

    it('should reject invalid input', async () => {
      const response = await request(app)
        .post('/api/publish')
        .set('Authorization', `Bearer ${token}`)
        .send({
          quantity: -10, // Invalid
          price: 5.5
        })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
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
});
