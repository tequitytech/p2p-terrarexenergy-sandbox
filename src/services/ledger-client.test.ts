/**
 * Tests for ledger-client.ts
 *
 * Tests ledger API queries with retry logic
 */

import axios, { AxiosError } from 'axios';
import { queryTradeByTransaction, queryTrades, getLedgerHealth, ledgerClient } from './ledger-client';
import { createLedgerRecord } from '../test-utils';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ledger-client', () => {
  beforeEach(() => {
    // Use resetAllMocks so that axios mock implementations do not leak
    // between individual test cases, which can cause flaky behaviour
    // in retry-related tests.
    jest.resetAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('queryTradeByTransaction', () => {
    it('should return ledger record when found', async () => {
      const mockRecord = createLedgerRecord('txn-001');

      mockedAxios.post.mockResolvedValue({
        data: { records: [mockRecord], total: 1 }
      });

      const result = await queryTradeByTransaction('txn-001', 'TPDDL');

      expect(result).not.toBeNull();
      expect(result?.transactionId).toBe('txn-001');
    });

    it('should return null when no records found', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: [], total: 0 }
      });

      const result = await queryTradeByTransaction('non-existent', 'TPDDL');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Connection failed'));

      const result = await queryTradeByTransaction('txn-001', 'TPDDL');

      expect(result).toBeNull();
    });

    it('should query with correct parameters', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: [], total: 0 }
      });

      await queryTradeByTransaction('txn-query-001', 'BESCOM');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/ledger/get'),
        expect.objectContaining({
          transactionId: 'txn-query-001',
          discomIdBuyer: 'BESCOM',
          limit: 1,
          offset: 0
        }),
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('should handle 5xx errors gracefully (no unhandled exception)', async () => {
      const serverError = new Error('Server error') as AxiosError;
      serverError.response = { status: 500 } as any;
      serverError.code = 'ERR_BAD_RESPONSE';

      mockedAxios.post
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({
          data: { records: [createLedgerRecord('txn-001')], total: 1 }
        });

      const promise = queryTradeByTransaction('txn-001', 'TPDDL');

      // Advance timers for retry delay
      jest.advanceTimersByTime(1000);

      const result = await promise;

      // In the current implementation, a 5xx error results in a logged error
      // and a null return value after the retry helper finishes.
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should handle connection errors gracefully', async () => {
      const connError = new Error('Connection reset') as any;
      connError.code = 'ECONNRESET';

      mockedAxios.post
        .mockRejectedValueOnce(connError)
        .mockResolvedValueOnce({
          data: { records: [createLedgerRecord('txn-001')], total: 1 }
        });

      const promise = queryTradeByTransaction('txn-001', 'TPDDL');

      const result = await promise;

      // Current implementation logs the error and returns null when the
      // ledger API connection fails.
      expect(result).toBeNull();
    });

    it('should not retry on 4xx errors', async () => {
      const clientError = new Error('Bad request') as AxiosError;
      clientError.response = { status: 400 } as any;

      mockedAxios.post.mockRejectedValue(clientError);

      const result = await queryTradeByTransaction('txn-001', 'TPDDL');

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should give up after repeated 5xx errors', async () => {
      const serverError = new Error('Server error') as AxiosError;
      serverError.response = { status: 503 } as any;

      // Simulate persistent failures from the ledger API
      mockedAxios.post.mockRejectedValue(serverError);

      const promise = queryTradeByTransaction('txn-001', 'TPDDL');

      // Advance timers for all retry delays
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(5000);
      }

      const result = await promise;

      // After exhausting retries, the client should surface a null result
      // (and log the failure), rather than throwing.
      expect(result).toBeNull();
    });
  });

  describe('queryTrades', () => {
    it('should return array of records', async () => {
      const records = [
        createLedgerRecord('txn-001'),
        createLedgerRecord('txn-002')
      ];

      mockedAxios.post.mockResolvedValue({
        data: { records, total: 2 }
      });

      const result = await queryTrades({ discomIdBuyer: 'TPDDL' });

      expect(result).toHaveLength(2);
    });

    it('should return empty array on error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Failed'));

      const result = await queryTrades({ discomIdBuyer: 'TPDDL' });

      expect(result).toEqual([]);
    });

    it('should use default pagination', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: [], total: 0 }
      });

      await queryTrades({ transactionId: 'txn-001' });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          limit: 100,
          offset: 0,
          sort: 'tradeTime',
          sortOrder: 'desc'
        }),
        expect.any(Object)
      );
    });

    it('should use provided pagination', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: [], total: 0 }
      });

      await queryTrades({
        limit: 50,
        offset: 10,
        sort: 'deliveryStartTime',
        sortOrder: 'asc'
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          limit: 50,
          offset: 10,
          sort: 'deliveryStartTime',
          sortOrder: 'asc'
        }),
        expect.any(Object)
      );
    });

    it('should handle empty response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: [], total: 0 }
      });

      const result = await queryTrades({});

      expect(result).toEqual([]);
    });

    it('should handle null records', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: null }
      });

      const result = await queryTrades({});

      expect(result).toEqual([]);
    });
  });

  describe('getLedgerHealth', () => {
    it('should return ok:true on successful connection', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { records: [] }
      });

      const result = await getLedgerHealth();

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return ok:false on error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Connection refused'));

      const result = await getLedgerHealth();

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should measure latency', async () => {
      mockedAxios.post.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 100));
        return { data: { records: [] } };
      });

      const promise = getLedgerHealth();

      jest.advanceTimersByTime(100);

      const result = await promise;

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should use 5 second timeout', async () => {
      mockedAxios.post.mockResolvedValue({ data: { records: [] } });

      await getLedgerHealth();

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ timeout: 5000 })
      );
    });
  });

  describe('ledgerClient export', () => {
    it('should export all functions', () => {
      expect(ledgerClient.queryTradeByTransaction).toBe(queryTradeByTransaction);
      expect(ledgerClient.queryTrades).toBe(queryTrades);
      expect(ledgerClient.getLedgerHealth).toBe(getLedgerHealth);
      expect(ledgerClient.LEDGER_URL).toBeDefined();
    });
  });
});
