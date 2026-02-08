/**
 * Tests for settlement-poller.ts
 *
 * The settlement poller is a background service that queries the ledger for
 * settlement updates, syncs order statuses, and triggers on_settle callbacks.
 */

import axios from 'axios';

import { setupTestDB, teardownTestDB, clearTestDB, seedSettlement, getTestSettlement } from '../test-utils/db';
import { createLedgerRecord } from '../test-utils';

// ============================================
// Mocks — must be declared before imports
// ============================================

jest.mock('../db', () => {
  const { getTestDB } = require('../test-utils/db');
  return {
    getDB: () => getTestDB(),
    connectDB: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('./ledger-client', () => ({
  ledgerClient: {
    queryTradeByTransaction: jest.fn(),
  },
}));

jest.mock('./order-service', () => ({
  orderService: {
    updateBuyerOrderStatus: jest.fn().mockResolvedValue(undefined),
    updateSellerOrderStatus: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('./catalog-store', () => ({
  catalogStore: {
    getOrderByTransactionId: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('axios');

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-1234'),
}));

// ============================================
// Imports (after mocks)
// ============================================

import { ledgerClient } from './ledger-client';
import { orderService } from './order-service';
import { catalogStore } from './catalog-store';
import { settlementStore } from './settlement-store';

const mockedLedger = ledgerClient as jest.Mocked<typeof ledgerClient>;
const mockedOrderService = orderService as jest.Mocked<typeof orderService>;
const mockedCatalogStore = catalogStore as jest.Mocked<typeof catalogStore>;
const mockedAxios = axios as jest.Mocked<typeof axios>;

// We need to import the module under test after mocks are configured.
// Because settlement-poller reads env vars at module level, we use dynamic import.
let pollOnce: typeof import('./settlement-poller').pollOnce;
let triggerOnSettle: typeof import('./settlement-poller').triggerOnSettle;
let refreshSettlement: typeof import('./settlement-poller').refreshSettlement;
let startPolling: typeof import('./settlement-poller').startPolling;
let stopPolling: typeof import('./settlement-poller').stopPolling;
let getPollingStatus: typeof import('./settlement-poller').getPollingStatus;

// ============================================
// Setup / Teardown
// ============================================

beforeAll(async () => {
  await setupTestDB();

  // Set env vars before loading module
  process.env.ENABLE_SETTLEMENT_POLLING = 'false'; // Prevent auto-start
  process.env.DISCOM_ID = 'TEST-DISCOM';
  process.env.ON_SETTLE_CALLBACK_URL = '';

  const mod = await import('./settlement-poller');
  pollOnce = mod.pollOnce;
  triggerOnSettle = mod.triggerOnSettle;
  refreshSettlement = mod.refreshSettlement;
  startPolling = mod.startPolling;
  stopPolling = mod.stopPolling;
  getPollingStatus = mod.getPollingStatus;
});

afterAll(async () => {
  stopPolling();
  await teardownTestDB();
  delete process.env.ON_SETTLE_CALLBACK_URL;
  delete process.env.DISCOM_ID;
  delete process.env.ENABLE_SETTLEMENT_POLLING;
});

beforeEach(async () => {
  await clearTestDB();
  jest.clearAllMocks();
});

// ============================================
// pollOnce
// ============================================

describe('pollOnce', () => {
  it('should return empty result when no pending settlements', async () => {
    const result = await pollOnce();

    expect(result.settlementsChecked).toBe(0);
    expect(result.settlementsUpdated).toBe(0);
    expect(result.newlySettled).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.polledAt).toBeInstanceOf(Date);
  });

  it('should query ledger for each pending settlement', async () => {
    await seedSettlement('txn-001', 'BUYER', 'PENDING', 10);
    await seedSettlement('txn-002', 'SELLER', 'PENDING', 20);

    mockedLedger.queryTradeByTransaction.mockResolvedValue(null);

    const result = await pollOnce();

    expect(result.settlementsChecked).toBe(2);
    expect(mockedLedger.queryTradeByTransaction).toHaveBeenCalledTimes(2);
    expect(mockedLedger.queryTradeByTransaction).toHaveBeenCalledWith('txn-001', 'TEST-DISCOM');
    expect(mockedLedger.queryTradeByTransaction).toHaveBeenCalledWith('txn-002', 'TEST-DISCOM');
  });

  it('should update settlement when ledger record found', async () => {
    await seedSettlement('txn-100', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-100', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'PENDING',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    const result = await pollOnce();

    expect(result.settlementsUpdated).toBe(1);
    const updated = await getTestSettlement('txn-100');
    expect(updated.settlementStatus).toBe('BUYER_COMPLETED');
    expect(updated.buyerDiscomStatus).toBe('COMPLETED');
    expect(updated.sellerDiscomStatus).toBe('PENDING');
  });

  it('should increment settlementsUpdated counter for each update', async () => {
    await seedSettlement('txn-200', 'BUYER', 'PENDING', 10);
    await seedSettlement('txn-201', 'SELLER', 'PENDING', 15);

    const record1 = createLedgerRecord('txn-200', { statusBuyerDiscom: 'COMPLETED', statusSellerDiscom: 'PENDING' });
    const record2 = createLedgerRecord('txn-201', { statusSellerDiscom: 'COMPLETED', statusBuyerDiscom: 'PENDING' });

    mockedLedger.queryTradeByTransaction
      .mockResolvedValueOnce(record1)
      .mockResolvedValueOnce(record2);

    const result = await pollOnce();

    expect(result.settlementsUpdated).toBe(2);
  });

  it('should add transactionId to newlySettled when status transitions to SETTLED', async () => {
    await seedSettlement('txn-300', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-300', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    // Prevent callback from being triggered (no URL)
    process.env.ON_SETTLE_CALLBACK_URL = '';

    const result = await pollOnce();

    expect(result.newlySettled).toContain('txn-300');
  });

  it('should call markOnSettleNotified after successful callback', async () => {
    await seedSettlement('txn-310', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-310', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);
    mockedCatalogStore.getOrderByTransactionId.mockResolvedValue(null);
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACK' } });

    process.env.ON_SETTLE_CALLBACK_URL = 'http://test-callback.example.com/on_settle';

    const result = await pollOnce();

    expect(result.newlySettled).toContain('txn-310');

    // Verify the settlement was marked as notified
    const settlement = await getTestSettlement('txn-310');
    expect(settlement.onSettleNotified).toBe(true);

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });

  it('should not trigger callback when onSettleNotified is already true', async () => {
    // Seed a settlement that is already notified but not yet SETTLED
    const db = (await import('../test-utils/db')).getTestDB();
    await db.collection('settlements').insertOne({
      transactionId: 'txn-320',
      orderItemId: 'order-item-txn-320',
      role: 'BUYER',
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      settlementStatus: 'BUYER_COMPLETED',
      buyerDiscomStatus: 'COMPLETED',
      sellerDiscomStatus: 'PENDING',
      actualDelivered: null,
      contractedQuantity: 10,
      deviationKwh: null,
      settlementCycleId: null,
      settledAt: null,
      onSettleNotified: true, // Already notified
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const ledgerRecord = createLedgerRecord('txn-320', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    process.env.ON_SETTLE_CALLBACK_URL = 'http://test-callback.example.com/on_settle';

    await pollOnce();

    // axios.post should NOT have been called for callback since onSettleNotified was already true
    expect(mockedAxios.post).not.toHaveBeenCalled();

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });

  it('should update buyer order status to DELIVERED when settlement is SETTLED and role=BUYER', async () => {
    await seedSettlement('txn-400', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-400', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    await pollOnce();

    expect(mockedOrderService.updateBuyerOrderStatus).toHaveBeenCalledWith(
      'txn-400',
      'DELIVERED',
      expect.objectContaining({ settlementId: expect.any(String) })
    );
  });

  it('should update seller order status to DELIVERED when settlement is SETTLED and role=SELLER', async () => {
    await seedSettlement('txn-410', 'SELLER', 'PENDING', 15);

    const ledgerRecord = createLedgerRecord('txn-410', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    await pollOnce();

    expect(mockedOrderService.updateSellerOrderStatus).toHaveBeenCalledWith(
      'txn-410',
      'DELIVERED'
    );
  });

  it('should catch and record errors per settlement without stopping the loop', async () => {
    await seedSettlement('txn-500', 'BUYER', 'PENDING', 10);
    await seedSettlement('txn-501', 'SELLER', 'PENDING', 20);

    // First settlement throws, second succeeds
    mockedLedger.queryTradeByTransaction
      .mockRejectedValueOnce(new Error('Ledger timeout'))
      .mockResolvedValueOnce(null);

    const result = await pollOnce();

    expect(result.settlementsChecked).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('txn-500');
    expect(result.errors[0]).toContain('Ledger timeout');
  });

  it('should reset isPolling flag even on error (finally block)', async () => {
    // Verify polling status is not stuck after error
    await seedSettlement('txn-600', 'BUYER', 'PENDING', 10);
    mockedLedger.queryTradeByTransaction.mockRejectedValue(new Error('fail'));

    await pollOnce();

    // Should be able to poll again (isPolling was reset)
    mockedLedger.queryTradeByTransaction.mockResolvedValue(null);
    const result = await pollOnce();
    expect(result.settlementsChecked).toBe(1); // Still has the pending settlement
  });

  it('should not update order status when settlement status is not SETTLED', async () => {
    await seedSettlement('txn-700', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-700', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'PENDING', // Not fully settled
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    await pollOnce();

    expect(mockedOrderService.updateBuyerOrderStatus).not.toHaveBeenCalled();
    expect(mockedOrderService.updateSellerOrderStatus).not.toHaveBeenCalled();
  });

  it('should handle order status update failure gracefully', async () => {
    await seedSettlement('txn-710', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-710', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);
    mockedOrderService.updateBuyerOrderStatus.mockRejectedValue(new Error('DB error'));

    // Should not throw
    const result = await pollOnce();

    expect(result.settlementsUpdated).toBe(1);
    // Error from order update is caught internally, not added to result.errors
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================
// triggerOnSettle
// ============================================

describe('triggerOnSettle', () => {
  it('should POST settlement data to ON_SETTLE_CALLBACK_URL', async () => {
    process.env.ON_SETTLE_CALLBACK_URL = 'http://callback.example.com/on_settle';
    mockedCatalogStore.getOrderByTransactionId.mockResolvedValue({
      context: { domain: 'beckn.one:deg:p2p-trading-interdiscom:2.0.0' },
    });
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACK' } });

    const settlement = {
      transactionId: 'txn-800',
      orderItemId: 'item-800',
      settlementStatus: 'SETTLED' as const,
      settlementCycleId: 'settle-2026-01-28-001',
      contractedQuantity: 10,
      actualDelivered: 9.5,
      deviationKwh: -0.5,
      settledAt: new Date('2026-01-28T12:00:00Z'),
      buyerDiscomStatus: 'COMPLETED' as const,
      sellerDiscomStatus: 'COMPLETED' as const,
      role: 'BUYER' as const,
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      onSettleNotified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await triggerOnSettle(settlement);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, payload, config] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('http://callback.example.com/on_settle');
    expect(config).toEqual(expect.objectContaining({
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }));

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });

  it('should include context with action=on_settle and settlement details', async () => {
    process.env.ON_SETTLE_CALLBACK_URL = 'http://callback.example.com/on_settle';
    mockedCatalogStore.getOrderByTransactionId.mockResolvedValue(null);
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACK' } });

    const settlement = {
      transactionId: 'txn-810',
      orderItemId: 'item-810',
      settlementStatus: 'SETTLED' as const,
      settlementCycleId: 'cycle-001',
      contractedQuantity: 20,
      actualDelivered: 18,
      deviationKwh: -2,
      settledAt: new Date('2026-01-28T12:00:00Z'),
      buyerDiscomStatus: 'COMPLETED' as const,
      sellerDiscomStatus: 'COMPLETED' as const,
      role: 'BUYER' as const,
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      onSettleNotified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await triggerOnSettle(settlement);

    const payload = mockedAxios.post.mock.calls[0][1] as any;
    expect(payload.context.action).toBe('on_settle');
    expect(payload.context.version).toBe('2.0.0');
    expect(payload.context.transaction_id).toBe('txn-810');
    expect(payload.context.message_id).toBe('test-uuid-1234');
    expect(payload.message.settlement.transactionId).toBe('txn-810');
    expect(payload.message.settlement.orderItemId).toBe('item-810');
    expect(payload.message.settlement.contractedQuantity).toBe(20);
    expect(payload.message.settlement.actualDelivered).toBe(18);
    expect(payload.message.settlement.deviationKwh).toBe(-2);
    expect(payload.message.settlement.settlementStatus).toBe('SETTLED');

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });

  it('should skip when ON_SETTLE_CALLBACK_URL is not configured', async () => {
    process.env.ON_SETTLE_CALLBACK_URL = '';

    const settlement = {
      transactionId: 'txn-820',
      orderItemId: 'item-820',
      settlementStatus: 'SETTLED' as const,
      settlementCycleId: null,
      contractedQuantity: 10,
      actualDelivered: null,
      deviationKwh: null,
      settledAt: null,
      buyerDiscomStatus: 'COMPLETED' as const,
      sellerDiscomStatus: 'COMPLETED' as const,
      role: 'BUYER' as const,
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      onSettleNotified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await triggerOnSettle(settlement);

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('should catch and log callback errors without throwing', async () => {
    process.env.ON_SETTLE_CALLBACK_URL = 'http://callback.example.com/on_settle';
    mockedCatalogStore.getOrderByTransactionId.mockResolvedValue(null);
    mockedAxios.post.mockRejectedValue(new Error('Connection refused'));

    const settlement = {
      transactionId: 'txn-830',
      orderItemId: 'item-830',
      settlementStatus: 'SETTLED' as const,
      settlementCycleId: null,
      contractedQuantity: 10,
      actualDelivered: null,
      deviationKwh: null,
      settledAt: null,
      buyerDiscomStatus: 'COMPLETED' as const,
      sellerDiscomStatus: 'COMPLETED' as const,
      role: 'BUYER' as const,
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      onSettleNotified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Should not throw
    await expect(triggerOnSettle(settlement)).resolves.toBeUndefined();

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });

  it('should use saved order domain when available', async () => {
    process.env.ON_SETTLE_CALLBACK_URL = 'http://callback.example.com/on_settle';
    mockedCatalogStore.getOrderByTransactionId.mockResolvedValue({
      context: { domain: 'custom-domain:energy:v3' },
    });
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACK' } });

    const settlement = {
      transactionId: 'txn-840',
      orderItemId: 'item-840',
      settlementStatus: 'SETTLED' as const,
      settlementCycleId: null,
      contractedQuantity: 10,
      actualDelivered: null,
      deviationKwh: null,
      settledAt: null,
      buyerDiscomStatus: 'COMPLETED' as const,
      sellerDiscomStatus: 'COMPLETED' as const,
      role: 'BUYER' as const,
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      onSettleNotified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await triggerOnSettle(settlement);

    const payload = mockedAxios.post.mock.calls[0][1] as any;
    expect(payload.context.domain).toBe('custom-domain:energy:v3');

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });
});

// ============================================
// refreshSettlement
// ============================================

describe('refreshSettlement', () => {
  it('should query ledger and update settlement store', async () => {
    await seedSettlement('txn-900', 'BUYER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-900', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
      actualDelivered: 9,
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    const updated = await refreshSettlement('txn-900');

    expect(mockedLedger.queryTradeByTransaction).toHaveBeenCalledWith('txn-900', 'TEST-DISCOM');
    expect(updated).not.toBeNull();
    expect(updated!.settlementStatus).toBe('SETTLED');
  });

  it('should trigger on_settle callback for newly settled', async () => {
    await seedSettlement('txn-910', 'SELLER', 'PENDING', 10);

    const ledgerRecord = createLedgerRecord('txn-910', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);
    mockedCatalogStore.getOrderByTransactionId.mockResolvedValue(null);
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACK' } });

    process.env.ON_SETTLE_CALLBACK_URL = 'http://callback.example.com/on_settle';

    await refreshSettlement('txn-910');

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    // Verify marked as notified
    const settlement = await getTestSettlement('txn-910');
    expect(settlement.onSettleNotified).toBe(true);

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });

  it('should return null when no ledger record found', async () => {
    mockedLedger.queryTradeByTransaction.mockResolvedValue(null);

    const result = await refreshSettlement('txn-nonexistent');

    expect(result).toBeNull();
  });

  it('should not trigger callback when already notified', async () => {
    const db = (await import('../test-utils/db')).getTestDB();
    await db.collection('settlements').insertOne({
      transactionId: 'txn-920',
      orderItemId: 'order-item-txn-920',
      role: 'BUYER',
      counterpartyPlatformId: null,
      counterpartyDiscomId: null,
      ledgerSyncedAt: null,
      ledgerData: null,
      settlementStatus: 'BUYER_COMPLETED',
      buyerDiscomStatus: 'COMPLETED',
      sellerDiscomStatus: 'PENDING',
      actualDelivered: null,
      contractedQuantity: 10,
      deviationKwh: null,
      settlementCycleId: null,
      settledAt: null,
      onSettleNotified: true, // Already notified
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const ledgerRecord = createLedgerRecord('txn-920', {
      statusBuyerDiscom: 'COMPLETED',
      statusSellerDiscom: 'COMPLETED',
    });
    mockedLedger.queryTradeByTransaction.mockResolvedValue(ledgerRecord);

    process.env.ON_SETTLE_CALLBACK_URL = 'http://callback.example.com/on_settle';

    await refreshSettlement('txn-920');

    expect(mockedAxios.post).not.toHaveBeenCalled();

    process.env.ON_SETTLE_CALLBACK_URL = '';
  });
});

// ============================================
// startPolling / stopPolling / getPollingStatus
// ============================================

describe('startPolling', () => {
  it('should not start when ENABLE_SETTLEMENT_POLLING=false', () => {
    // Module was loaded with ENABLE_SETTLEMENT_POLLING=false
    startPolling();

    const status = getPollingStatus();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
  });
});

describe('stopPolling', () => {
  it('should be safe to call when not running', () => {
    // Should not throw when called without startPolling
    expect(() => stopPolling()).not.toThrow();
  });
});

describe('getPollingStatus', () => {
  it('should return current polling state', () => {
    const status = getPollingStatus();

    expect(status).toEqual(expect.objectContaining({
      enabled: expect.any(Boolean),
      running: expect.any(Boolean),
      isPolling: expect.any(Boolean),
      intervalMs: expect.any(Number),
    }));
    expect(status).toHaveProperty('lastPollResult');
  });
});
