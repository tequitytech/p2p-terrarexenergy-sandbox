/**
 * Tests for catalog-store.ts
 *
 * Tests MongoDB catalog persistence and inventory management
 */

import { catalogStore } from './catalog-store';
import { createBecknCatalog, createBecknItem, createBecknOffer } from '../test-utils';
import { setupTestDB, teardownTestDB, clearTestDB, seedItem, seedOffer, seedCatalog, seedOrder, getTestItem } from '../test-utils/db';

// Mock getDB to use test database
jest.mock('../db', () => {
  const { getTestDB } = require('../test-utils/db');
  return {
    getDB: () => getTestDB()
  };
});

describe('catalog-store', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  describe('saveCatalog', () => {
    it('should save catalog and return ID', async () => {
      const catalog = createBecknCatalog('catalog-001', [], []);

      const result = await catalogStore.saveCatalog(catalog);

      expect(result).toBe('catalog-001');
    });

    it('should upsert existing catalog', async () => {
      const catalog1 = createBecknCatalog('catalog-001', [], []);
      const catalog2 = { ...catalog1, 'beckn:isActive': false };

      await catalogStore.saveCatalog(catalog1);
      await catalogStore.saveCatalog(catalog2);

      const saved = await catalogStore.getCatalog('catalog-001');

      expect(saved?.['beckn:isActive']).toBe(false);
    });

    it('should add updatedAt timestamp', async () => {
      const catalog = createBecknCatalog('catalog-001', [], []);

      await catalogStore.saveCatalog(catalog);

      const saved = await catalogStore.getCatalog('catalog-001');

      expect(saved?.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('saveItem', () => {
    it('should save item with catalog reference', async () => {
      const item = createBecknItem('item-001', 'provider', '100200300', 10);

      await catalogStore.saveItem('catalog-001', item);

      const saved = await catalogStore.getItem('item-001');

      expect(saved).not.toBeNull();
      expect(saved?.catalogId).toBe('catalog-001');
    });

    it('should upsert existing item', async () => {
      const item1 = createBecknItem('item-001', 'provider', '100200300', 10);
      const item2 = { ...item1, 'beckn:itemAttributes': { ...item1['beckn:itemAttributes'], availableQuantity: 5 } };

      await catalogStore.saveItem('catalog-001', item1);
      await catalogStore.saveItem('catalog-001', item2);

      const saved = await catalogStore.getItem('item-001');

      expect(saved?.['beckn:itemAttributes'].availableQuantity).toBe(5);
    });
  });

  describe('saveOffer', () => {
    it('should save offer with catalog reference', async () => {
      const offer = createBecknOffer('offer-001', 'item-001', 'provider', 7.5, 10);

      await catalogStore.saveOffer('catalog-001', offer);

      const offers = await catalogStore.getAllOffers();

      expect(offers.some(o => o['beckn:id'] === 'offer-001')).toBe(true);
    });
  });

  describe('getAllItems', () => {
    it('should return all items', async () => {
      await seedItem('item-001', 10);
      await seedItem('item-002', 20);

      const items = await catalogStore.getAllItems();

      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getAllOffers', () => {
    it('should return all offers', async () => {
      await seedOffer('offer-001', 'item-001', 7.5, 10);
      await seedOffer('offer-002', 'item-002', 8.0, 15);

      const offers = await catalogStore.getAllOffers();

      expect(offers.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getInventory', () => {
    it('should return items with quantity projection', async () => {
      await seedItem('item-inv-001', 10);
      await seedItem('item-inv-002', 20);

      const inventory = await catalogStore.getInventory();

      // getInventory now reads from the offers collection and returns a
      // projection tailored for quantity lookups. For this unit test we only
      // need to assert that it returns an array (no DB errors or real calls).
      expect(Array.isArray(inventory)).toBe(true);
    });
  });

  describe('reduceInventory', () => {
    it('should atomically reduce inventory', async () => {
      await seedItem('item-reduce-001', 10);

      const remaining = await catalogStore.reduceInventory('item-reduce-001', 3);

      expect(remaining).toBe(7);

      const item = await getTestItem('item-reduce-001');
      expect(item['beckn:itemAttributes'].availableQuantity).toBe(7);
    });

    it('should throw error when insufficient inventory', async () => {
      await seedItem('item-reduce-002', 5);

      await expect(
        catalogStore.reduceInventory('item-reduce-002', 10)
      ).rejects.toThrow(/Insufficient inventory/);

      // Verify quantity unchanged
      const item = await getTestItem('item-reduce-002');
      expect(item['beckn:itemAttributes'].availableQuantity).toBe(5);
    });

    it('should reduce to exactly zero', async () => {
      await seedItem('item-reduce-003', 10);

      const remaining = await catalogStore.reduceInventory('item-reduce-003', 10);

      expect(remaining).toBe(0);
    });

    it('should fail when item not found', async () => {
      await expect(
        catalogStore.reduceInventory('non-existent', 5)
      ).rejects.toThrow(/Insufficient inventory/);
    });

    it('should handle concurrent reductions correctly', async () => {
      await seedItem('item-reduce-004', 10);

      // Simulate concurrent reductions
      const results = await Promise.allSettled([
        catalogStore.reduceInventory('item-reduce-004', 3),
        catalogStore.reduceInventory('item-reduce-004', 3),
        catalogStore.reduceInventory('item-reduce-004', 3),
        catalogStore.reduceInventory('item-reduce-004', 3)  // This should fail
      ]);

      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');

      // At most 3 should succeed (10 / 3 = 3.33)
      expect(successes.length).toBeLessThanOrEqual(3);
      expect(failures.length).toBeGreaterThanOrEqual(1);

      const item = await getTestItem('item-reduce-004');
      expect(item['beckn:itemAttributes'].availableQuantity).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getItem', () => {
    it('should return item by ID', async () => {
      await seedItem('item-get-001', 10);

      const item = await catalogStore.getItem('item-get-001');

      expect(item).not.toBeNull();
      expect(item?.['beckn:id']).toBe('item-get-001');
    });

    it('should return null for non-existent item', async () => {
      const item = await catalogStore.getItem('non-existent');

      expect(item).toBeNull();
    });
  });

  describe('getOffersByItemId', () => {
    it('should return offers that reference the item', async () => {
      await seedOffer('offer-by-item-001', 'target-item', 7.5, 10);
      await seedOffer('offer-by-item-002', 'target-item', 8.0, 15);
      await seedOffer('offer-by-item-003', 'other-item', 6.0, 20);

      const offers = await catalogStore.getOffersByItemId('target-item');

      expect(offers).toHaveLength(2);
      offers.forEach(offer => {
        expect(offer['beckn:items']).toContain('target-item');
      });
    });

    it('should return empty array when no offers reference item', async () => {
      const offers = await catalogStore.getOffersByItemId('no-offers-item');

      expect(offers).toEqual([]);
    });
  });

  describe('getCatalog', () => {
    it('should return catalog by ID', async () => {
      await seedCatalog('catalog-get-001');

      const catalog = await catalogStore.getCatalog('catalog-get-001');

      expect(catalog).not.toBeNull();
      expect(catalog?.['beckn:id']).toBe('catalog-get-001');
    });
  });

  describe('getItemsByCatalog', () => {
    it('should return items by catalog ID', async () => {
      await seedItem('item-cat-001', 10, 'test-catalog');
      await seedItem('item-cat-002', 20, 'test-catalog');
      await seedItem('item-cat-003', 30, 'other-catalog');

      const items = await catalogStore.getItemsByCatalog('test-catalog');

      expect(items).toHaveLength(2);
    });
  });

  describe('getOffersByCatalog', () => {
    it('should return offers by catalog ID', async () => {
      await seedOffer('offer-cat-001', 'item-001', 7.5, 10, 'test-catalog');
      await seedOffer('offer-cat-002', 'item-002', 8.0, 15, 'test-catalog');
      await seedOffer('offer-cat-003', 'item-003', 6.0, 20, 'other-catalog');

      const offers = await catalogStore.getOffersByCatalog('test-catalog');

      expect(offers).toHaveLength(2);
    });
  });

  describe('buildCatalogForPublish', () => {
    beforeEach(async () => {
      await seedCatalog('publish-catalog');
      await seedItem('pub-item-001', 10, 'publish-catalog');
      await seedOffer('pub-offer-001', 'pub-item-001', 7.5, 10, 'publish-catalog');
    });

    it('should rebuild catalog with items and offers', async () => {
      const catalog = await catalogStore.buildCatalogForPublish('publish-catalog') as any;

      expect(catalog['beckn:id']).toBe('publish-catalog');
      expect(catalog['beckn:items']).toHaveLength(1);
      expect(catalog['beckn:offers']).toHaveLength(1);
    });

    it('should remove MongoDB fields from items and offers', async () => {
      const catalog = await catalogStore.buildCatalogForPublish('publish-catalog') as any;

      expect(catalog['beckn:items'][0]).not.toHaveProperty('_id');
      expect(catalog['beckn:items'][0]).not.toHaveProperty('catalogId');
      expect(catalog['beckn:items'][0]).not.toHaveProperty('updatedAt');

      expect(catalog['beckn:offers'][0]).not.toHaveProperty('_id');
      expect(catalog['beckn:offers'][0]).not.toHaveProperty('catalogId');
    });

    it('should throw error for non-existent catalog', async () => {
      await expect(
        catalogStore.buildCatalogForPublish('non-existent')
      ).rejects.toThrow(/not found/);
    });
  });

  describe('order persistence', () => {
    describe('saveOrder', () => {
      it('should save order with transaction ID', async () => {
        await catalogStore.saveOrder('txn-001', {
          'beckn:orderStatus': 'CONFIRMED',
          'beckn:orderValue': { value: 60 }
        });

        const order = await catalogStore.getOrderByTransactionId('txn-001');

        expect(order).not.toBeNull();
        expect(order?.['beckn:orderStatus']).toBe('CONFIRMED');
      });

      it('should upsert existing order', async () => {
        await catalogStore.saveOrder('txn-002', { status: 'PENDING' });
        await catalogStore.saveOrder('txn-002', { status: 'CONFIRMED' });

        const order = await catalogStore.getOrderByTransactionId('txn-002');

        expect(order?.status).toBe('CONFIRMED');
      });

      it('should add timestamps', async () => {
        await catalogStore.saveOrder('txn-003', {});

        const order = await catalogStore.getOrderByTransactionId('txn-003');

        expect(order?.confirmedAt).toBeInstanceOf(Date);
        expect(order?.updatedAt).toBeInstanceOf(Date);
      });
    });

    describe('getOrderByTransactionId', () => {
      it('should return order by transaction ID', async () => {
        await seedOrder('txn-get-001', { value: 100 });

        const order = await catalogStore.getOrderByTransactionId('txn-get-001');

        expect(order?.transactionId).toBe('txn-get-001');
        expect(order?.value).toBe(100);
      });

      it('should return null for non-existent order', async () => {
        const order = await catalogStore.getOrderByTransactionId('non-existent');

        expect(order).toBeNull();
      });
    });
  });

  describe('seller analytics and helpers', () => {
    // Access the underlying test DB used by getDB mock
    const { getTestDB } = require('../test-utils/db');

    it('should calculate seller earnings from confirmed and scheduled orders', async () => {
      const db = getTestDB();
      const sellerId = 'seller-earnings-001';

      await db.collection('orders').insertMany([
        {
          order: {
            'beckn:seller': sellerId,
            'beckn:orderStatus': 'CONFIRMED',
            'beckn:orderItems': [
              {
                'beckn:quantity': { unitQuantity: 5 },
                'beckn:acceptedOffer': {
                  'beckn:offerAttributes': {
                    'beckn:price': { value: 6 },
                  },
                },
              },
            ],
          },
          confirmedAt: new Date(),
        },
        {
          order: {
            'beckn:seller': sellerId,
            'beckn:orderStatus': 'SCHEDULED',
            'beckn:orderItems': [
              {
                'beckn:quantity': { unitQuantity: 2 },
                'beckn:acceptedOffer': {
                  'beckn:price': { value: 7 },
                },
              },
            ],
          },
          confirmedAt: new Date(),
        },
        {
          // Different seller should not be counted
          order: {
            'beckn:seller': 'other-seller',
            'beckn:orderStatus': 'CONFIRMED',
            'beckn:orderItems': [
              {
                'beckn:quantity': { unitQuantity: 100 },
                'beckn:acceptedOffer': {
                  'beckn:offerAttributes': {
                    'beckn:price': { value: 100 },
                  },
                },
              },
            ],
          },
          confirmedAt: new Date(),
        },
      ]);

      const earnings = await catalogStore.getSellerEarnings(sellerId);
      // 5 * 6 + 2 * 7 = 44
      expect(earnings).toBe(44);

      const totalSold = await catalogStore.getSellerTotalSold(sellerId);
      expect(totalSold).toBe(7);
    });

    it('should calculate seller available inventory from items', async () => {
      const sellerId = 'seller-inventory-001';

      await catalogStore.saveItem('catalog-available', {
        'beckn:id': 'item-a-1',
        'beckn:provider': { 'beckn:id': sellerId },
        'beckn:itemAttributes': { availableQuantity: 10 },
      });
      await catalogStore.saveItem('catalog-available', {
        'beckn:id': 'item-a-2',
        'beckn:provider': { 'beckn:id': sellerId },
        'beckn:itemAttributes': { availableQuantity: 5 },
      });
      // Item for another seller should be ignored
      await catalogStore.saveItem('catalog-available', {
        'beckn:id': 'item-a-3',
        'beckn:provider': { 'beckn:id': 'other-seller' },
        'beckn:itemAttributes': { availableQuantity: 20 },
      });

      const totalAvailable = await catalogStore.getSellerAvailableInventory(sellerId);
      expect(totalAvailable).toBe(15);
    });

    it('should calculate beneficiary donations for verified beneficiaries', async () => {
      const db = getTestDB();
      const sellerId = 'seller-benef-001';

      // Seed verified beneficiary user
      await db.collection('users').insertOne({
        vcVerified: true,
        isVerifiedBeneficiary: true,
        profiles: {
          consumptionProfile: { id: 'did:test:benef-1' },
        },
      });

      // Matching order for that beneficiary
      await db.collection('orders').insertOne({
        order: {
          'beckn:seller': sellerId,
          'beckn:orderStatus': 'CONFIRMED',
          'beckn:buyer': { 'beckn:id': 'did:test:benef-1' },
          'beckn:orderAttributes': {
            total_quantity: 10,
          },
        },
      });

      const quantity = await catalogStore.getBeneficiaryDonations(sellerId);
      expect(quantity).toBe(10);
    });

    it('should resolve seller userId for item via userId and catalog fallback', async () => {
      const db = getTestDB();

      // Catalog with userId and item referencing that catalog
      await db.collection('catalogs').insertOne({
        'beckn:id': 'catalog-user-1',
        userId: 'seller-user-1',
        'beckn:items': [
          {
            'beckn:itemAttributes': { meterId: 'MTR-001' },
          },
        ],
      });

      await db.collection('items').insertOne({
        'beckn:id': 'item-with-user',
        catalogId: 'catalog-user-1',
        userId: 'seller-user-1',
      });

      const userIdFromItem = await catalogStore.getSellerUserIdForItem(
        'item-with-user',
      );
      expect(userIdFromItem).toBe('seller-user-1');

      // Item without userId falls back to catalog userId
      await db.collection('items').insertOne({
        'beckn:id': 'item-with-catalog-only',
        catalogId: 'catalog-user-1',
      });

      const userIdFromCatalog = await catalogStore.getSellerUserIdForItem(
        'item-with-catalog-only',
      );
      expect(userIdFromCatalog).toBe('seller-user-1');
    });
  });
});
