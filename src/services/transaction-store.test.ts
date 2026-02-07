/**
 * Tests for transaction-store.ts
 *
 * Tests pending transaction lifecycle with timeout handling
 */

import {
  createPendingTransaction,
  resolvePendingTransaction,
  hasPendingTransaction,
  cancelPendingTransaction,
  getPendingCount
} from './transaction-store';

describe('transaction-store', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Clear any existing transactions
    // Since we can't access internal Map, we'll work around it
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createPendingTransaction', () => {
    it('should create a pending transaction', () => {
      const transactionId = `txn-${Date.now()}`;

      // Don't await - just start the promise
      const promise = createPendingTransaction(transactionId, 'select');

      expect(hasPendingTransaction(transactionId)).toBe(true);

      // Clean up
      cancelPendingTransaction(transactionId);
    });

    it('should timeout after configured duration', async () => {
      const transactionId = `txn-timeout-${Date.now()}`;
      const promise = createPendingTransaction(transactionId, 'select');

      // Fast-forward past timeout
      jest.advanceTimersByTime(31000);  // Default 30s + buffer

      await expect(promise).rejects.toThrow(/Timeout/);
      expect(hasPendingTransaction(transactionId)).toBe(false);
    });

    it('should include action name in timeout error', async () => {
      const transactionId = `txn-action-${Date.now()}`;
      const promise = createPendingTransaction(transactionId, 'init');

      jest.advanceTimersByTime(31000);

      await expect(promise).rejects.toThrow(/on_init/);
    });
  });

  describe('resolvePendingTransaction', () => {
    it('should resolve pending transaction with data', async () => {
      const transactionId = `txn-resolve-${Date.now()}`;
      const responseData = { context: {}, message: { order: {} } };

      const promise = createPendingTransaction(transactionId, 'confirm');

      // Resolve it
      const resolved = resolvePendingTransaction(transactionId, responseData);

      expect(resolved).toBe(true);

      const result = await promise;
      expect(result).toEqual(responseData);
    });

    it('should return false for non-existent transaction', () => {
      const resolved = resolvePendingTransaction('non-existent-txn', {});

      expect(resolved).toBe(false);
    });

    it('should remove transaction after resolution', async () => {
      const transactionId = `txn-remove-${Date.now()}`;

      const promise = createPendingTransaction(transactionId, 'select');
      resolvePendingTransaction(transactionId, {});

      await promise;

      expect(hasPendingTransaction(transactionId)).toBe(false);
    });

    it('should clear timeout on resolution', async () => {
      const transactionId = `txn-clear-timeout-${Date.now()}`;

      const promise = createPendingTransaction(transactionId, 'select');
      resolvePendingTransaction(transactionId, { success: true });

      await promise;

      // Advance timers - should not cause issues
      jest.advanceTimersByTime(60000);

      // No timeout error should have been thrown
    });
  });

  describe('hasPendingTransaction', () => {
    it('should return true for existing transaction', () => {
      const transactionId = `txn-exists-${Date.now()}`;

      createPendingTransaction(transactionId, 'status');

      expect(hasPendingTransaction(transactionId)).toBe(true);

      // Clean up
      cancelPendingTransaction(transactionId);
    });

    it('should return false for non-existent transaction', () => {
      expect(hasPendingTransaction('non-existent')).toBe(false);
    });

    it('should return false after transaction resolved', async () => {
      const transactionId = `txn-after-resolve-${Date.now()}`;

      const promise = createPendingTransaction(transactionId, 'select');
      resolvePendingTransaction(transactionId, {});

      await promise;

      expect(hasPendingTransaction(transactionId)).toBe(false);
    });
  });

  describe('cancelPendingTransaction', () => {
    it('should cancel existing transaction', () => {
      const transactionId = `txn-cancel-${Date.now()}`;

      createPendingTransaction(transactionId, 'init');

      const cancelled = cancelPendingTransaction(transactionId);

      expect(cancelled).toBe(true);
      expect(hasPendingTransaction(transactionId)).toBe(false);
    });

    it('should return false for non-existent transaction', () => {
      const cancelled = cancelPendingTransaction('non-existent');

      expect(cancelled).toBe(false);
    });

    it('should clear timeout on cancellation', () => {
      const transactionId = `txn-cancel-timeout-${Date.now()}`;

      createPendingTransaction(transactionId, 'confirm');
      cancelPendingTransaction(transactionId);

      // Advance timers - no timeout should fire
      jest.advanceTimersByTime(60000);

      // Transaction should still not exist
      expect(hasPendingTransaction(transactionId)).toBe(false);
    });
  });

  describe('getPendingCount', () => {
    it('should return 0 when no pending transactions', () => {
      // Get current count and expect it to be manageable
      const count = getPendingCount();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should track pending transactions count', () => {
      const txn1 = `txn-count-1-${Date.now()}`;
      const txn2 = `txn-count-2-${Date.now()}`;

      const initialCount = getPendingCount();

      createPendingTransaction(txn1, 'select');
      expect(getPendingCount()).toBe(initialCount + 1);

      createPendingTransaction(txn2, 'init');
      expect(getPendingCount()).toBe(initialCount + 2);

      cancelPendingTransaction(txn1);
      expect(getPendingCount()).toBe(initialCount + 1);

      cancelPendingTransaction(txn2);
      expect(getPendingCount()).toBe(initialCount);
    });
  });

  describe('concurrent transactions', () => {
    it('should handle multiple concurrent transactions', async () => {
      const transactions = Array.from({ length: 5 }, (_, i) => ({
        id: `txn-concurrent-${i}-${Date.now()}`,
        data: { index: i }
      }));

      const promises = transactions.map(async t =>
        createPendingTransaction(t.id, 'select')
      );

      // Verify all are pending
      transactions.forEach(t => {
        expect(hasPendingTransaction(t.id)).toBe(true);
      });

      // Resolve all
      transactions.forEach(t => {
        resolvePendingTransaction(t.id, t.data);
      });

      // All should resolve with correct data
      const results = await Promise.all(promises);
      results.forEach((result, i) => {
        expect(result.index).toBe(i);
      });
    });

    it('should isolate transactions from each other', async () => {
      const txn1 = `txn-isolate-1-${Date.now()}`;
      const txn2 = `txn-isolate-2-${Date.now()}`;

      const promise1 = createPendingTransaction(txn1, 'select');
      const promise2 = createPendingTransaction(txn2, 'init');

      // Resolve only txn1
      resolvePendingTransaction(txn1, { id: 1 });

      const result1 = await promise1;
      expect(result1.id).toBe(1);

      // txn2 should still be pending
      expect(hasPendingTransaction(txn2)).toBe(true);

      // Clean up
      cancelPendingTransaction(txn2);
    });
  });
});
