/**
 * E2E Order Flow Integration Test
 *
 * Tests the complete order lifecycle: publish → select → init → confirm → status
 */

import { Express } from 'express';
import request from 'supertest';
import axios from 'axios';
import { ObjectId } from 'mongodb';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB, seedItem, seedOffer, seedCatalog } from '../../test-utils/db';

// Mock authMiddleware to bypass JWT auth for tests
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

// Mock axios for ONIX calls
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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

// Import app after mocking
import { createApp } from '../../app';
import { catalogStore } from '../../services/catalog-store';
import { settlementStore } from '../../services/settlement-store';

describe('E2E Order Flow', () => {
  let app: Express;
  const transactionId = 'e2e-txn-001';
  const itemId = 'e2e-item-001';
  const offerId = 'e2e-offer-001';
  const catalogId = 'e2e-catalog-001';
  const providerId = 'test-provider';
  const meterId = '100200300';

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

  describe('Complete Order Lifecycle', () => {
    beforeEach(async () => {
      // Seed a user with generationProfile so the publish route recognizes a prosumer
      const db = getTestDB();
      await db.collection('users').insertOne({
        _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
        phone: '1234567890',
        name: 'Test Prosumer',
        vcVerified: true,
        profiles: {
          generationProfile: {
            meterNumber: meterId,
            utilityId: 'TPDDL',
            consumerNumber: 'CONS-001',
            did: 'did:example:test-provider',
          },
        },
        meters: [meterId],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Mock ONIX forwarding (best-effort, non-blocking in the publish route)
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true, message: 'Catalog published' },
      });
    });

    it('should publish minimal input, auto-build catalog, store items/offers, and appear in inventory', async () => {
      // ============ Step 1: Publish via minimal input ============
      const publishResponse = await request(app)
        .post('/api/publish')
        .send({
          quantity: 10,
          price: 7.5,
          deliveryDate: '2026-01-28',
          startHour: 10,
          duration: 1,
          sourceType: 'SOLAR',
        })
        .expect(200);

      expect(publishResponse.body.success).toBe(true);
      expect(publishResponse.body.catalog_id).toBeDefined();
      expect(publishResponse.body.item_id).toBeDefined();
      expect(publishResponse.body.offer_id).toBeDefined();
      expect(publishResponse.body.prosumer).toMatchObject({
        name: 'Test Prosumer',
        meterId,
        utilityId: 'TPDDL',
      });

      const serverItemId = publishResponse.body.item_id;
      const serverOfferId = publishResponse.body.offer_id;

      // ============ Step 2: Verify item is stored ============
      const storedItem = await catalogStore.getItem(serverItemId);
      expect(storedItem).not.toBeNull();
      expect(storedItem?.['beckn:itemAttributes'].sourceType).toBe('SOLAR');
      expect(storedItem?.['beckn:itemAttributes'].meterId).toBe(meterId);

      // ============ Step 3: Verify offer appears in inventory ============
      const inventoryResponse = await request(app)
        .get('/api/inventory')
        .expect(200);

      expect(inventoryResponse.body.items.length).toBeGreaterThan(0);
      const inventoryOffer = inventoryResponse.body.items.find(
        (i: any) => i['beckn:id'] === serverOfferId
      );
      expect(inventoryOffer).toBeDefined();
    });

    it('should reduce inventory on confirm', async () => {
      // Setup: Create item with 10 kWh
      await seedCatalog(catalogId);
      await seedItem(itemId, 10, catalogId);
      await seedOffer(offerId, itemId, 7.5, 10, catalogId);

      // Verify initial inventory
      const initialItem = await catalogStore.getItem(itemId);
      expect(initialItem?.['beckn:itemAttributes'].availableQuantity).toBe(10);

      // Simulate order confirmation by reducing inventory
      await catalogStore.reduceInventory(itemId, 5);

      // Verify inventory reduced
      const updatedItem = await catalogStore.getItem(itemId);
      expect(updatedItem?.['beckn:itemAttributes'].availableQuantity).toBe(5);
    });

    it('should reject order when inventory insufficient', async () => {
      // Setup: Create item with 5 kWh
      await seedCatalog(catalogId);
      await seedItem(itemId, 5, catalogId);

      // Try to reduce by 10 - should fail
      await expect(
        catalogStore.reduceInventory(itemId, 10)
      ).rejects.toThrow(/Insufficient inventory/);

      // Verify inventory unchanged
      const item = await catalogStore.getItem(itemId);
      expect(item?.['beckn:itemAttributes'].availableQuantity).toBe(5);
    });

    it('should create settlement on order confirmation', async () => {
      // Simulate order confirmation creating a settlement
      const settlement = await settlementStore.createSettlement(
        transactionId,
        `order-item-${transactionId}`,
        10,  // contracted quantity
        'SELLER',
        'counterparty-platform',
        'TPDDL'
      );

      expect(settlement.transactionId).toBe(transactionId);
      expect(settlement.settlementStatus).toBe('PENDING');
      expect(settlement.contractedQuantity).toBe(10);

      // Verify settlement is persisted
      const stored = await settlementStore.getSettlement(transactionId);
      expect(stored).not.toBeNull();
    });

    it('should track delivery progress via status', async () => {
      // Setup: Create settlement for tracking
      await settlementStore.createSettlement(
        transactionId,
        `order-item-${transactionId}`,
        10
      );

      // Verify we can query settlement
      const settlement = await settlementStore.getSettlement(transactionId);
      expect(settlement?.settlementStatus).toBe('PENDING');
    });
  });

  describe('Concurrent Order Handling', () => {
    it('should handle concurrent orders for same item', async () => {
      // Setup: Create item with 15 kWh
      await seedCatalog(catalogId);
      await seedItem(itemId, 15, catalogId);

      // Simulate 3 concurrent orders of 5 kWh each
      const orderPromises = [
        catalogStore.reduceInventory(itemId, 5),
        catalogStore.reduceInventory(itemId, 5),
        catalogStore.reduceInventory(itemId, 5)
      ];

      const results = await Promise.allSettled(orderPromises);

      // All 3 should succeed (15 kWh available)
      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBe(3);

      // Final inventory should be 0
      const item = await catalogStore.getItem(itemId);
      expect(item?.['beckn:itemAttributes'].availableQuantity).toBe(0);
    });

    it('should prevent overselling with concurrent orders', async () => {
      // Setup: Create item with 10 kWh
      await seedCatalog(catalogId);
      await seedItem(itemId, 10, catalogId);

      // Simulate 3 concurrent orders of 5 kWh each (only 2 can succeed)
      const orderPromises = [
        catalogStore.reduceInventory(itemId, 5),
        catalogStore.reduceInventory(itemId, 5),
        catalogStore.reduceInventory(itemId, 5)
      ];

      const results = await Promise.allSettled(orderPromises);

      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');

      // Only 2 should succeed
      expect(successes.length).toBe(2);
      expect(failures.length).toBe(1);

      // Final inventory should be 0
      const item = await catalogStore.getItem(itemId);
      expect(item?.['beckn:itemAttributes'].availableQuantity).toBe(0);
    });
  });

  describe('Settlement Lifecycle', () => {
    it('should transition settlement status through lifecycle', async () => {
      // Create settlement
      await settlementStore.createSettlement(transactionId, 'order-item', 10);

      // Initial status
      let settlement = await settlementStore.getSettlement(transactionId);
      expect(settlement?.settlementStatus).toBe('PENDING');

      // Simulate ledger update - buyer completed
      await settlementStore.updateFromLedger(transactionId, {
        transactionId,
        orderItemId: 'order-item',
        platformIdBuyer: 'buyer-platform',
        platformIdSeller: 'seller-platform',
        discomIdBuyer: 'TPDDL',
        discomIdSeller: 'BESCOM',
        buyerId: 'buyer-001',
        sellerId: 'seller-001',
        tradeTime: new Date().toISOString(),
        deliveryStartTime: '2026-01-28T08:00:00Z',
        deliveryEndTime: '2026-01-28T17:00:00Z',
        tradeDetails: [{ tradeQty: 10, tradeType: 'PURCHASE', tradeUnit: 'kWh' }],
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'PENDING',
        buyerFulfillmentValidationMetrics: [
          { validationMetricType: 'ACTUAL_PUSHED', validationMetricValue: 10 }
        ]
      });

      settlement = await settlementStore.getSettlement(transactionId);
      expect(settlement?.settlementStatus).toBe('BUYER_COMPLETED');

      // Simulate ledger update - both completed
      await settlementStore.updateFromLedger(transactionId, {
        transactionId,
        orderItemId: 'order-item',
        platformIdBuyer: 'buyer-platform',
        platformIdSeller: 'seller-platform',
        discomIdBuyer: 'TPDDL',
        discomIdSeller: 'BESCOM',
        buyerId: 'buyer-001',
        sellerId: 'seller-001',
        tradeTime: new Date().toISOString(),
        deliveryStartTime: '2026-01-28T08:00:00Z',
        deliveryEndTime: '2026-01-28T17:00:00Z',
        tradeDetails: [{ tradeQty: 10, tradeType: 'PURCHASE', tradeUnit: 'kWh' }],
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'COMPLETED',
        buyerFulfillmentValidationMetrics: [
          { validationMetricType: 'ACTUAL_PUSHED', validationMetricValue: 10 }
        ]
      });

      settlement = await settlementStore.getSettlement(transactionId);
      expect(settlement?.settlementStatus).toBe('SETTLED');
      expect(settlement?.settledAt).not.toBeNull();
    });

    it('should calculate deviation correctly', async () => {
      await settlementStore.createSettlement(transactionId, 'order-item', 10);

      // Actual delivered is 9.5 (0.5 under-delivery)
      await settlementStore.updateFromLedger(transactionId, {
        transactionId,
        orderItemId: 'order-item',
        platformIdBuyer: 'buyer-platform',
        platformIdSeller: 'seller-platform',
        discomIdBuyer: 'TPDDL',
        discomIdSeller: 'BESCOM',
        buyerId: 'buyer-001',
        sellerId: 'seller-001',
        tradeTime: new Date().toISOString(),
        deliveryStartTime: '2026-01-28T08:00:00Z',
        deliveryEndTime: '2026-01-28T17:00:00Z',
        tradeDetails: [{ tradeQty: 10, tradeType: 'PURCHASE', tradeUnit: 'kWh' }],
        statusBuyerDiscom: 'PENDING',
        statusSellerDiscom: 'PENDING',
        buyerFulfillmentValidationMetrics: [
          { validationMetricType: 'ACTUAL_PUSHED', validationMetricValue: 9.5 }
        ]
      });

      const settlement = await settlementStore.getSettlement(transactionId);
      expect(settlement?.actualDelivered).toBe(9.5);
      expect(settlement?.deviationKwh).toBe(-0.5);  // 9.5 - 10 = -0.5
    });
  });

  describe('API Health Checks', () => {
    it('should return healthy status', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body.message).toBe('OK!');
    });
  });
});
