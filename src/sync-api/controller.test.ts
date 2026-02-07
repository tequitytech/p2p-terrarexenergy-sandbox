/**
 * Tests for sync-api/controller.ts
 *
 * Tests ACK detection, callback timeout handling, and validation
 */

import axios from 'axios';


import * as transactionStore from '../services/transaction-store';
import { mockRequest, mockResponse, createBecknContext } from '../test-utils';

import { syncSelect, syncInit, syncConfirm, syncStatus, syncHealth } from './controller';

import type { Request, Response } from 'express';

// Mock dependencies
jest.mock('axios');
jest.mock('../services/transaction-store');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedTransactionStore = transactionStore as jest.Mocked<typeof transactionStore>;

describe('sync-api/controller', () => {
  let res: ReturnType<typeof mockResponse>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = mockResponse();

    // Default mock implementations
    mockedTransactionStore.createPendingTransaction.mockImplementation(
      async () => Promise.resolve({ context: {}, message: {} })
    );
    mockedTransactionStore.cancelPendingTransaction.mockReturnValue(true);
    mockedTransactionStore.getPendingCount.mockReturnValue(0);
  });

  describe('isAckResponse (internal behavior tested via syncSelect)', () => {
    it('should detect ACK in JSON object response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      // Should not cancel transaction on ACK
      expect(mockedTransactionStore.cancelPendingTransaction).not.toHaveBeenCalled();
    });

    it('should detect NACK in JSON object response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'NACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(mockedTransactionStore.cancelPendingTransaction).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should detect ACK in string response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: '{"message":{"ack":{"status":"ACK"}}}'
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      // ACK detected, should not cancel
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });

    it('should detect NACK in string response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: '{"message":{"ack":{"status":"NACK"}}}'
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(mockedTransactionStore.cancelPendingTransaction).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should prioritize NACK over ACK in malformed response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: '"status":"NACK" some garbage "status":"ACK"'
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      // NACK takes priority
      expect(mockedTransactionStore.cancelPendingTransaction).toHaveBeenCalled();
    });
  });

  describe('syncSelect', () => {
    it('should forward request to ONIX BAP', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: { item: { id: 'item-001' } }
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/bap/caller/select'),
        expect.objectContaining({ message: expect.any(Object) }),
        expect.any(Object)
      );
    });

    it('should use provided transaction ID or generate one', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const customTxnId = 'custom-txn-123';
      const req = mockRequest({
        context: { ...createBecknContext('select'), transaction_id: customTxnId },
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(mockedTransactionStore.createPendingTransaction).toHaveBeenCalledWith(
        customTxnId,
        'select'
      );
    });

    it('should return business error from callback', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedTransactionStore.createPendingTransaction.mockResolvedValue({
        error: { code: 'INSUFFICIENT_INVENTORY', message: 'Not enough' }
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.any(Object)
      }));
    });

    it('should return 504 on timeout', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedTransactionStore.createPendingTransaction.mockRejectedValue(
        new Error('Timeout waiting for on_select callback')
      );

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should return 500 on other errors', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('syncInit', () => {
    it('should forward init request', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('init'),
        message: { order: {} }
      }) as Request;

      await syncInit(req, res.res as Response);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/bap/caller/init'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should return successful response with transaction ID', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('init'),
        message: {}
      }) as Request;

      await syncInit(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        transaction_id: expect.any(String)
      }));
    });
  });

  describe('syncConfirm', () => {
    // Helper to create valid confirm order with new schema
    const createValidConfirmOrder = (overrides: any = {}) => ({
      'beckn:buyer': {
        'beckn:buyerAttributes': {
          utilityId: 'BRPL',
          ...overrides.buyerAttributes
        }
      },
      'beckn:orderItems': [{
        'beckn:orderItemAttributes': {
          providerAttributes: {
            utilityId: 'TPDDL',
            ...overrides.providerAttributes
          }
        }
      }],
      'beckn:orderAttributes': {
        '@type': 'EnergyTradeOrder',
        ...overrides.orderAttributes
      },
      ...overrides.order
    });

    it('should reject missing buyer utilityId', async () => {
      const req = mockRequest({
        context: createBecknContext('confirm'),
        message: {
          order: createValidConfirmOrder({
            buyerAttributes: { utilityId: undefined }
          })
        }
      }) as Request;
      // Remove utilityId from buyer
      delete req.body.message.order['beckn:buyer']['beckn:buyerAttributes'].utilityId;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'MISSING_REQUIRED_FIELD',
          message: expect.stringContaining('buyerAttributes')
        })
      }));
    });

    it('should reject missing seller utilityId', async () => {
      const req = mockRequest({
        context: createBecknContext('confirm'),
        message: {
          order: createValidConfirmOrder({
            providerAttributes: { utilityId: undefined }
          })
        }
      }) as Request;
      // Remove utilityId from provider
      delete req.body.message.order['beckn:orderItems'][0]['beckn:orderItemAttributes'].providerAttributes.utilityId;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'MISSING_REQUIRED_FIELD',
          message: expect.stringContaining('providerAttributes')
        })
      }));
    });

    it('should reject empty string buyer utilityId', async () => {
      const req = mockRequest({
        context: createBecknContext('confirm'),
        message: {
          order: createValidConfirmOrder({
            buyerAttributes: { utilityId: '  ' }
          })
        }
      }) as Request;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should forward valid confirm request', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('confirm'),
        message: {
          order: createValidConfirmOrder()
        }
      }) as Request;

      await syncConfirm(req, res.res as Response);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/bap/caller/confirm'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should return business error from confirm callback', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedTransactionStore.createPendingTransaction.mockResolvedValue({
        error: { code: 'INSUFFICIENT_INVENTORY', message: 'Item sold out' }
      });

      const req = mockRequest({
        context: createBecknContext('confirm'),
        message: {
          order: createValidConfirmOrder()
        }
      }) as Request;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.any(Object)
      }));
    });
  });

  describe('syncStatus', () => {
    it('should forward status request', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('status'),
        message: {}
      }) as Request;

      await syncStatus(req, res.res as Response);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/bap/caller/status'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should return status response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const req = mockRequest({
        context: createBecknContext('status'),
        message: {}
      }) as Request;

      await syncStatus(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });
  });

  describe('syncHealth', () => {
    it('should return health status', () => {
      const req = mockRequest({}) as Request;

      syncHealth(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'OK',
        pendingTransactions: expect.any(Number),
        onixBapUrl: expect.any(String)
      }));
    });
  });

  describe('error handling', () => {
    it('should cancel pending transaction on axios error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Connection refused'));

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(mockedTransactionStore.cancelPendingTransaction).toHaveBeenCalled();
    });

    it('should cancel pending transaction on NACK', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'NACK' } }, error: { code: 'INVALID_REQUEST' } }
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(mockedTransactionStore.cancelPendingTransaction).toHaveBeenCalled();
    });
  });
});
