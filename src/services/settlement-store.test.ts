/**
 * Tests for settlement-store.ts
 *
 * Tests settlement creation, status derivation, and ledger sync
 */

import { createLedgerRecord } from '../test-utils';
import { setupTestDB, teardownTestDB, clearTestDB, seedSettlement, getTestSettlement } from '../test-utils/db';

import { settlementStore, deriveSettlementStatus } from './settlement-store';

// Mock getDB to use test database
jest.mock('../db', () => {
  const { getTestDB } = require('../test-utils/db');
  return {
    getDB: () => getTestDB()
  };
});

describe('settlement-store', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  describe('deriveSettlementStatus', () => {
    it('should return SETTLED when both discoms completed', () => {
      const ledger = createLedgerRecord('txn-001', {
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'COMPLETED'
      });

      expect(deriveSettlementStatus(ledger)).toBe('SETTLED');
    });

    it('should return BUYER_COMPLETED when only buyer completed', () => {
      const ledger = createLedgerRecord('txn-001', {
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'PENDING'
      });

      expect(deriveSettlementStatus(ledger)).toBe('BUYER_COMPLETED');
    });

    it('should return SELLER_COMPLETED when only seller completed', () => {
      const ledger = createLedgerRecord('txn-001', {
        statusBuyerDiscom: 'PENDING',
        statusSellerDiscom: 'COMPLETED'
      });

      expect(deriveSettlementStatus(ledger)).toBe('SELLER_COMPLETED');
    });

    it('should return PENDING when neither completed', () => {
      const ledger = createLedgerRecord('txn-001', {
        statusBuyerDiscom: 'PENDING',
        statusSellerDiscom: 'PENDING'
      });

      expect(deriveSettlementStatus(ledger)).toBe('PENDING');
    });
  });

  describe('createSettlement', () => {
    it('should create settlement with SELLER role by default', async () => {
      const result = await settlementStore.createSettlement(
        'txn-001',
        'order-item-001',
        10
      );

      expect(result.transactionId).toBe('txn-001');
      expect(result.orderItemId).toBe('order-item-001');
      expect(result.role).toBe('SELLER');
      expect(result.contractedQuantity).toBe(10);
      expect(result.settlementStatus).toBe('PENDING');
    });

    it('should create settlement with BUYER role when specified', async () => {
      const result = await settlementStore.createSettlement(
        'txn-002',
        'order-item-002',
        15,
        'BUYER'
      );

      expect(result.role).toBe('BUYER');
    });

    it('should include counterparty info when provided', async () => {
      const result = await settlementStore.createSettlement(
        'txn-003',
        'order-item-003',
        10,
        'SELLER',
        'p2p.other.com',
        'TPDDL'
      );

      expect(result.counterpartyPlatformId).toBe('p2p.other.com');
      expect(result.counterpartyDiscomId).toBe('TPDDL');
    });

    it('should initialize with null ledger data', async () => {
      const result = await settlementStore.createSettlement(
        'txn-004',
        'order-item-004',
        10
      );

      expect(result.ledgerData).toBeNull();
      expect(result.ledgerSyncedAt).toBeNull();
      expect(result.actualDelivered).toBeNull();
    });

    it('should not overwrite existing settlement on duplicate', async () => {
      await settlementStore.createSettlement('txn-005', 'order-item-005', 10, 'SELLER');
      await settlementStore.createSettlement('txn-005', 'order-item-changed', 20, 'SELLER');

      const settlement = await settlementStore.getSettlement('txn-005', 'SELLER');

      // Should keep original values
      expect(settlement?.orderItemId).toBe('order-item-005');
      expect(settlement?.contractedQuantity).toBe(10);
    });

    it('should allow same transaction with different roles', async () => {
      await settlementStore.createSettlement('txn-006', 'order-item-006', 10, 'SELLER');
      await settlementStore.createSettlement('txn-006', 'order-item-006', 10, 'BUYER');

      const settlements = await settlementStore.getSettlementsByTransaction('txn-006');

      expect(settlements).toHaveLength(2);
    });
  });

  describe('getSettlement', () => {
    it('should return settlement by transactionId', async () => {
      await seedSettlement('txn-get-001', 'SELLER', 'PENDING', 10);

      const result = await settlementStore.getSettlement('txn-get-001');

      expect(result).not.toBeNull();
      expect(result?.transactionId).toBe('txn-get-001');
    });

    it('should return settlement filtered by role', async () => {
      await seedSettlement('txn-get-002', 'SELLER', 'PENDING');
      await seedSettlement('txn-get-002', 'BUYER', 'PENDING');

      const sellerSettlement = await settlementStore.getSettlement('txn-get-002', 'SELLER');
      const buyerSettlement = await settlementStore.getSettlement('txn-get-002', 'BUYER');

      expect(sellerSettlement?.role).toBe('SELLER');
      expect(buyerSettlement?.role).toBe('BUYER');
    });

    it('should return null for non-existent transaction', async () => {
      const result = await settlementStore.getSettlement('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getSettlements', () => {
    beforeEach(async () => {
      await seedSettlement('txn-list-001', 'SELLER', 'PENDING');
      await seedSettlement('txn-list-002', 'SELLER', 'SETTLED');
      await seedSettlement('txn-list-003', 'SELLER', 'PENDING');
    });

    it('should return all settlements without filter', async () => {
      const result = await settlementStore.getSettlements();

      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by status', async () => {
      const pending = await settlementStore.getSettlements('PENDING');
      const settled = await settlementStore.getSettlements('SETTLED');

      expect(pending.every(s => s.settlementStatus === 'PENDING')).toBe(true);
      expect(settled.every(s => s.settlementStatus === 'SETTLED')).toBe(true);
    });

    it('should sort by updatedAt descending', async () => {
      const result = await settlementStore.getSettlements();

      for (let i = 1; i < result.length; i++) {
        const prev = new Date(result[i - 1].updatedAt).getTime();
        const curr = new Date(result[i].updatedAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });
  });

  describe('getPendingSettlements', () => {
    it('should return only non-settled settlements', async () => {
      await seedSettlement('txn-pending-001', 'SELLER', 'PENDING');
      await seedSettlement('txn-pending-002', 'SELLER', 'BUYER_COMPLETED');
      await seedSettlement('txn-pending-003', 'SELLER', 'SETTLED');

      const result = await settlementStore.getPendingSettlements();

      expect(result.every(s => s.settlementStatus !== 'SETTLED')).toBe(true);
    });

    it('should sort by createdAt ascending', async () => {
      const result = await settlementStore.getPendingSettlements();

      for (let i = 1; i < result.length; i++) {
        const prev = new Date(result[i - 1].createdAt).getTime();
        const curr = new Date(result[i].createdAt).getTime();
        expect(prev).toBeLessThanOrEqual(curr);
      }
    });
  });

  describe('updateFromLedger', () => {
    it('should update settlement status from ledger', async () => {
      await settlementStore.createSettlement('txn-ledger-001', 'order-item', 10);

      const ledger = createLedgerRecord('txn-ledger-001', {
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'COMPLETED',
        actualDelivered: 10
      });

      await settlementStore.updateFromLedger('txn-ledger-001', ledger);

      const updated = await settlementStore.getSettlement('txn-ledger-001');

      expect(updated?.settlementStatus).toBe('SETTLED');
      expect(updated?.ledgerData).not.toBeNull();
    });

    it('should extract actual delivered from buyer metrics', async () => {
      await settlementStore.createSettlement('txn-ledger-002', 'order-item', 10);

      const ledger = createLedgerRecord('txn-ledger-002', {
        actualDelivered: 9.5
      });

      await settlementStore.updateFromLedger('txn-ledger-002', ledger);

      const updated = await settlementStore.getSettlement('txn-ledger-002');

      expect(updated?.actualDelivered).toBe(9.5);
    });

    it('should calculate deviation correctly', async () => {
      await settlementStore.createSettlement('txn-ledger-003', 'order-item', 10);

      const ledger = createLedgerRecord('txn-ledger-003', {
        actualDelivered: 9.5,
        contractedQuantity: 10
      });

      await settlementStore.updateFromLedger('txn-ledger-003', ledger);

      const updated = await settlementStore.getSettlement('txn-ledger-003');

      // Deviation = 9.5 - 10 = -0.5
      expect(updated?.deviationKwh).toBe(-0.5);
    });

    it('should set settlementCycleId when becoming SETTLED', async () => {
      await settlementStore.createSettlement('txn-ledger-004', 'order-item', 10);

      const ledger = createLedgerRecord('txn-ledger-004', {
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'COMPLETED'
      });

      await settlementStore.updateFromLedger('txn-ledger-004', ledger);

      const updated = await settlementStore.getSettlement('txn-ledger-004');

      expect(updated?.settlementCycleId).toMatch(/^settle-\d{4}-\d{2}-\d{2}-\d{3}$/);
      expect(updated?.settledAt).not.toBeNull();
    });

    it('should update discom statuses', async () => {
      await settlementStore.createSettlement('txn-ledger-005', 'order-item', 10);

      const ledger = createLedgerRecord('txn-ledger-005', {
        statusBuyerDiscom: 'COMPLETED',
        statusSellerDiscom: 'PENDING'
      });

      await settlementStore.updateFromLedger('txn-ledger-005', ledger);

      const updated = await settlementStore.getSettlement('txn-ledger-005');

      expect(updated?.buyerDiscomStatus).toBe('COMPLETED');
      expect(updated?.sellerDiscomStatus).toBe('PENDING');
    });
  });

  describe('markOnSettleNotified', () => {
    it('should mark settlement as notified', async () => {
      await seedSettlement('txn-notify-001', 'SELLER', 'SETTLED');

      await settlementStore.markOnSettleNotified('txn-notify-001');

      const updated = await getTestSettlement('txn-notify-001');

      expect(updated.onSettleNotified).toBe(true);
    });
  });

  describe('getUnnotifiedSettlements', () => {
    it('should return settled but unnotified settlements', async () => {
      await seedSettlement('txn-unnotified-001', 'SELLER', 'SETTLED');
      await seedSettlement('txn-unnotified-002', 'SELLER', 'PENDING');

      const result = await settlementStore.getUnnotifiedSettlements();

      expect(result.every(s => s.settlementStatus === 'SETTLED')).toBe(true);
      expect(result.every(s => !s.onSettleNotified)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return settlement statistics', async () => {
      await clearTestDB();
      await seedSettlement('txn-stats-001', 'SELLER', 'PENDING');
      await seedSettlement('txn-stats-002', 'SELLER', 'PENDING');
      await seedSettlement('txn-stats-003', 'SELLER', 'SETTLED');

      const stats = await settlementStore.getStats();

      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(2);
      expect(stats.settled).toBe(1);
    });

    it('should return zeros for empty collection', async () => {
      await clearTestDB();

      const stats = await settlementStore.getStats();

      expect(stats.total).toBe(0);
    });
  });
});
