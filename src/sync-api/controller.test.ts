/**
 * Tests for sync-api/controller.ts
 *
 * Tests ACK detection, callback timeout handling, validation,
 * catalog-based select, select-based init, init-based confirm,
 * and validation middleware.
 */

import axios from 'axios';

import * as tradeRoutes from '../trade/routes';
import * as transactionStore from '../services/transaction-store';
import { mockRequest, mockResponse, mockNext, createBecknContext } from '../test-utils';

import {
  syncSelect, syncInit, syncConfirm, syncStatus, syncHealth,
  validateSelect, validateInit, validateConfirm,
} from './controller';

import type { Request, Response, NextFunction } from 'express';

// Mock dependencies
jest.mock('axios');
jest.mock('../services/transaction-store');
jest.mock('../trade/routes', () => ({
  ...jest.requireActual('../trade/routes'),
  extractBuyerDetails: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedTransactionStore = transactionStore as jest.Mocked<typeof transactionStore>;
const mockedExtractBuyerDetails = tradeRoutes.extractBuyerDetails as jest.Mock;

// --- Helper: create a valid catalog-based select body ---
function createCatalogBasedSelectBody(overrides: any = {}) {
  return {
    context: {
      version: '2.0.0',
      action: 'select',
      transaction_id: overrides.transaction_id || 'txn-catalog-001',
      message_id: 'msg-001',
      bap_id: 'p2p.terrarexenergy.com',
      bap_uri: 'https://p2p.terrarexenergy.com/bap/receiver',
      bpp_id: 'p2p.terrarexenergy.com',
      bpp_uri: 'https://p2p.terrarexenergy.com/bpp/receiver',
      ...overrides.context,
    },
    catalogue: {
      'beckn:id': 'catalog-001',
      'beckn:providerId': 'provider-001',
      'beckn:items': [{
        'beckn:id': 'item-001',
        'beckn:provider': {
          'beckn:id': 'provider-001',
          'beckn:providerAttributes': {
            meterId: '100200300',
            utilityCustomerId: 'CUST001',
            utilityId: 'TPDDL',
          },
        },
        'beckn:itemAttributes': { meterId: '100200300' },
      }],
      'beckn:offers': [{
        'beckn:id': 'offer-001',
        'beckn:items': ['item-001'],
        'beckn:provider': 'provider-001',
        'beckn:descriptor': { 'schema:name': 'Solar Offer' },
        'beckn:price': { 'schema:price': 5.5, 'schema:priceCurrency': 'INR', unitText: 'kWh' },
        'beckn:offerAttributes': { pricingModel: 'PER_KWH' },
      }],
      ...overrides.catalogue,
    },
    customAttributes: {
      quantity: { unitQuantity: 10, unitText: 'kWh' },
      ...overrides.customAttributes,
    },
  };
}

// --- Helper: create a valid select-based init body ---
function createSelectBasedInitBody(overrides: any = {}) {
  return {
    context: {
      version: '2.0.0',
      action: 'init',
      transaction_id: overrides.transaction_id || 'txn-init-001',
      message_id: 'msg-002',
      bap_id: 'p2p.terrarexenergy.com',
      bap_uri: 'https://p2p.terrarexenergy.com/bap/receiver',
      bpp_id: 'p2p.terrarexenergy.com',
      bpp_uri: 'https://p2p.terrarexenergy.com/bpp/receiver',
      ...overrides.context,
    },
    select: {
      'beckn:orderStatus': 'CREATED',
      'beckn:seller': 'provider-001',
      'beckn:buyer': {
        'beckn:id': 'buyer-001',
        'beckn:buyerAttributes': {
          meterId: '999888777',
          utilityCustomerId: 'CUST002',
          utilityId: 'BRPL',
        },
      },
      'beckn:orderAttributes': {
        bap_id: 'p2p.terrarexenergy.com',
        bpp_id: 'p2p.terrarexenergy.com',
        total_quantity: { unitQuantity: 10, unitText: 'kWh' },
      },
      'beckn:orderItems': [{
        'beckn:orderedItem': 'item-001',
        'beckn:quantity': { unitQuantity: 10, unitText: 'kWh' },
        'beckn:acceptedOffer': {
          'beckn:id': 'offer-001',
          'beckn:price': { 'schema:price': 5.5, 'schema:priceCurrency': 'INR' },
          'beckn:offerAttributes': { pricingModel: 'PER_KWH' },
        },
        'beckn:orderItemAttributes': {
          providerAttributes: {
            meterId: '100200300',
            utilityCustomerId: 'CUST001',
            utilityId: 'TPDDL',
          },
        },
      }],
      ...overrides.select,
    },
    customAttributes: {
      payment: { id: 'pay-001' },
      ...overrides.customAttributes,
    },
  };
}

// --- Helper: create a valid init-based confirm body ---
function createInitBasedConfirmBody(overrides: any = {}) {
  return {
    context: {
      version: '2.0.0',
      action: 'confirm',
      transaction_id: overrides.transaction_id || 'txn-confirm-001',
      message_id: 'msg-003',
      bap_id: 'p2p.terrarexenergy.com',
      bap_uri: 'https://p2p.terrarexenergy.com/bap/receiver',
      bpp_id: 'p2p.terrarexenergy.com',
      bpp_uri: 'https://p2p.terrarexenergy.com/bpp/receiver',
      ...overrides.context,
    },
    init: {
      'beckn:id': 'order-001',
      'beckn:orderStatus': 'CREATED',
      'beckn:seller': 'provider-001',
      'beckn:buyer': {
        'beckn:id': 'buyer-001',
        'beckn:buyerAttributes': {
          meterId: '999888777',
          utilityCustomerId: 'CUST002',
          utilityId: 'BRPL',
        },
      },
      'beckn:orderAttributes': {
        bap_id: 'p2p.terrarexenergy.com',
        bpp_id: 'p2p.terrarexenergy.com',
        total_quantity: { unitQuantity: 10, unitText: 'kWh' },
      },
      'beckn:orderItems': [{
        'beckn:orderedItem': 'item-001',
        'beckn:quantity': { unitQuantity: 10, unitText: 'kWh' },
        'beckn:acceptedOffer': {
          'beckn:id': 'offer-001',
          'beckn:price': { 'schema:price': 5.5, 'schema:priceCurrency': 'INR' },
          'beckn:offerAttributes': { pricingModel: 'PER_KWH' },
        },
        'beckn:orderItemAttributes': {
          providerAttributes: {
            meterId: '100200300',
            utilityCustomerId: 'CUST001',
            utilityId: 'TPDDL',
          },
        },
      }],
      'beckn:fulfillment': {
        'beckn:id': 'fulfillment-txn-confirm-001',
        'beckn:mode': 'DELIVERY',
      },
      'beckn:payment': {
        'beckn:id': 'pay-001',
        'beckn:amount': { currency: 'INR', value: 70 },
        'beckn:paymentStatus': 'INITIATED',
      },
      ...overrides.init,
    },
    customAttributes: overrides.customAttributes,
  };
}

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

    it('should return false for unknown format (null)', async () => {
      mockedAxios.post.mockResolvedValue({ data: null });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      // null is unknown format → NACK → cancel
      expect(mockedTransactionStore.cancelPendingTransaction).toHaveBeenCalled();
    });

    it('should detect ACK in string with spaces around colon', async () => {
      mockedAxios.post.mockResolvedValue({
        data: '{"message":{"ack":{"status": "ACK"}}}'
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
      }));
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

    it('should return 400 with BUSINESS_ERROR when response contains error', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedTransactionStore.createPendingTransaction.mockResolvedValue({
        error: { code: 'INSUFFICIENT_INVENTORY', message: 'Not enough energy' }
      });

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'BUSINESS_ERROR',
          message: 'Not enough energy',
        })
      }));
    });

    it('should return 502 for UPSTREAM_ERROR from ONIX', async () => {
      const err: any = new Error('Request failed with status code 502');
      err.response = {
        status: 502,
        data: {
          message: {
            ack: { status: 'NACK' },
            error: { code: 'SCHEMA_VALIDATION', message: 'Invalid schema', paths: 'context.bpp_id' }
          }
        }
      };
      mockedAxios.post.mockRejectedValue(err);

      const req = mockRequest({
        context: createBecknContext('select'),
        message: {}
      }) as Request;

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'UPSTREAM_ERROR',
        })
      }));
    });
  });

  describe('syncSelect — catalog-based format', () => {
    it('should transform catalog-based input to beckn format', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedExtractBuyerDetails.mockResolvedValue({
        buyerId: 'buyer-did-001',
        fullName: 'Test Buyer',
        meterId: '999888777',
        utilityCustomerId: 'CUST002',
        utilityId: 'BRPL',
      });

      const body = createCatalogBasedSelectBody();
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncSelect(req, res.res as Response);

      // Should have forwarded a transformed request to ONIX
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/bap/caller/select'),
        expect.objectContaining({
          context: expect.objectContaining({ action: 'select' }),
          message: expect.objectContaining({
            order: expect.objectContaining({
              'beckn:buyer': expect.objectContaining({
                'beckn:id': 'buyer-did-001',
                'beckn:buyerAttributes': expect.objectContaining({
                  meterId: '999888777',
                  utilityId: 'BRPL',
                }),
              }),
              'beckn:orderItems': expect.arrayContaining([
                expect.objectContaining({
                  'beckn:orderedItem': 'item-001',
                  'beckn:quantity': expect.objectContaining({ unitQuantity: 10 }),
                  'beckn:acceptedOffer': expect.objectContaining({
                    'beckn:id': 'offer-001',
                  }),
                }),
              ]),
            }),
          }),
        }),
        expect.any(Object)
      );
    });

    it('should return 401 when catalog-based request has no userId', async () => {
      const body = createCatalogBasedSelectBody();
      const req = mockRequest(body) as Request;
      // No req.user set

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }));
    });

    it('should return 403 when user has no buyer profile (NO_BUYER_PROFILE)', async () => {
      const profileError: any = new Error('No verified buyer profile found.');
      profileError.code = 'NO_BUYER_PROFILE';
      mockedExtractBuyerDetails.mockRejectedValue(profileError);

      const body = createCatalogBasedSelectBody();
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'NO_BUYER_PROFILE' }),
      }));
    });

    it('should return 400 for invalid catalog-based schema (missing items)', async () => {
      const body = createCatalogBasedSelectBody({
        catalogue: {
          'beckn:id': 'catalog-001',
          'beckn:items': [], // empty — violates min(1)
          'beckn:offers': [{ 'beckn:id': 'offer-001' }],
        },
      });
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      }));
    });

    it('should use selectedOfferId when provided in customAttributes', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedExtractBuyerDetails.mockResolvedValue({
        buyerId: 'buyer-did-001',
        fullName: 'Test Buyer',
        meterId: '999888777',
        utilityCustomerId: 'CUST002',
        utilityId: 'BRPL',
      });

      const body = createCatalogBasedSelectBody({
        catalogue: {
          'beckn:id': 'catalog-001',
          'beckn:providerId': 'provider-001',
          'beckn:items': [{
            'beckn:id': 'item-001',
            'beckn:provider': { 'beckn:id': 'provider-001', 'beckn:providerAttributes': { meterId: '100200300', utilityCustomerId: 'CUST001', utilityId: 'TPDDL' } },
            'beckn:itemAttributes': { meterId: '100200300' },
          }],
          'beckn:offers': [
            {
              'beckn:id': 'offer-first',
              'beckn:items': ['item-001'],
              'beckn:price': { 'schema:price': 6.0, 'schema:priceCurrency': 'INR', unitText: 'kWh' },
              'beckn:offerAttributes': { pricingModel: 'PER_KWH' },
            },
            {
              'beckn:id': 'offer-second',
              'beckn:items': ['item-001'],
              'beckn:price': { 'schema:price': 4.0, 'schema:priceCurrency': 'INR', unitText: 'kWh' },
              'beckn:offerAttributes': { pricingModel: 'PER_KWH' },
            },
          ],
        },
        customAttributes: {
          quantity: { unitQuantity: 5, unitText: 'kWh' },
          selectedOfferId: 'offer-second',
        },
      });
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncSelect(req, res.res as Response);

      // Should have used offer-second, not offer-first
      const postedBody = mockedAxios.post.mock.calls[0][1] as any;
      const acceptedOffer = postedBody.message.order['beckn:orderItems'][0]['beckn:acceptedOffer'];
      expect(acceptedOffer['beckn:id']).toBe('offer-second');
    });

    it('should return 500 when extractBuyerDetails throws non-profile error', async () => {
      mockedExtractBuyerDetails.mockRejectedValue(new Error('DB connection lost'));

      const body = createCatalogBasedSelectBody();
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncSelect(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'PROFILE_ERROR' }),
      }));
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

  describe('syncInit — select-based format', () => {
    it('should transform select-based input to beckn init with fulfillment + payment', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const body = createSelectBasedInitBody();
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncInit(req, res.res as Response);

      const postedBody = mockedAxios.post.mock.calls[0][1] as any;
      const order = postedBody.message.order;

      // Should include fulfillment
      expect(order['beckn:fulfillment']).toBeDefined();
      expect(order['beckn:fulfillment']['beckn:mode']).toBe('DELIVERY');

      // Should include payment with the provided payment id
      expect(order['beckn:payment']).toBeDefined();
      expect(order['beckn:payment']['beckn:id']).toBe('pay-001');
      expect(order['beckn:payment']['beckn:paymentStatus']).toBe('INITIATED');

      // Should include settlement accounts
      expect(order['beckn:payment']['beckn:paymentAttributes']).toBeDefined();
      expect(order['beckn:payment']['beckn:paymentAttributes'].settlementAccounts).toBeDefined();
    });

    it('should calculate total amount with wheeling charges', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      // 10 kWh × 5.5 INR/kWh = 55 INR energy (wheeling charges are set elsewhere)
      const body = createSelectBasedInitBody();
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncInit(req, res.res as Response);

      const postedBody = mockedAxios.post.mock.calls[0][1] as any;
      const amount = postedBody.message.order['beckn:payment']['beckn:amount'];
      expect(amount.currency).toBe('INR');
      expect(amount.value).toBe(55);
    });

    it('should return 401 when select-based request has no userId', async () => {
      const body = createSelectBasedInitBody();
      const req = mockRequest(body) as Request;
      // No req.user set

      await syncInit(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }));
    });

    it('should return 400 for invalid select-based schema (missing payment.id)', async () => {
      const body = createSelectBasedInitBody({
        customAttributes: { payment: { id: '' } },  // empty → fails min(1)
      });
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncInit(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      }));
    });

    it('should return 400 when select-based init has no orderItems', async () => {
      const body = createSelectBasedInitBody({
        select: {
          'beckn:orderStatus': 'CREATED',
          'beckn:seller': 'provider-001',
          'beckn:buyer': { 'beckn:id': 'buyer-001' },
          'beckn:orderItems': [], // empty → fails min(1)
        },
      });
      const req = mockRequest(body) as Request;
      (req as any).user = { userId: '507f1f77bcf86cd799439011' };

      await syncInit(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
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

  describe('syncConfirm — init-based format', () => {
    it('should transform init-based input to beckn confirm', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const body = createInitBasedConfirmBody();
      const req = mockRequest(body) as Request;

      await syncConfirm(req, res.res as Response);

      const postedBody = mockedAxios.post.mock.calls[0][1] as any;
      const order = postedBody.message.order;

      // Payment status should be updated to AUTHORIZED
      expect(order['beckn:payment']['beckn:paymentStatus']).toBe('AUTHORIZED');

      // Buyer and seller should be preserved
      expect(order['beckn:seller']).toBe('provider-001');
      expect(order['beckn:buyer']['beckn:id']).toBe('buyer-001');

      // Fulfillment should be preserved
      expect(order['beckn:fulfillment']).toBeDefined();
    });

    it('should return 400 when utilityIdBuyer is missing for inter-discom', async () => {
      const body = createInitBasedConfirmBody({
        init: {
          'beckn:id': 'order-001',
          'beckn:orderStatus': 'CREATED',
          'beckn:seller': 'provider-001',
          'beckn:buyer': {
            'beckn:id': 'buyer-001',
            'beckn:buyerAttributes': {
              meterId: '999888777',
              // utilityId missing
            },
          },
          'beckn:orderItems': [{
            'beckn:orderedItem': 'item-001',
            'beckn:quantity': { unitQuantity: 10, unitText: 'kWh' },
            'beckn:orderItemAttributes': {
              providerAttributes: {
                meterId: '100200300',
                utilityId: 'TPDDL',
              },
            },
            'beckn:acceptedOffer': { 'beckn:id': 'offer-001' },
          }],
          'beckn:payment': { 'beckn:id': 'pay-001', 'beckn:paymentStatus': 'INITIATED' },
        },
      });
      const req = mockRequest(body) as Request;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'MISSING_REQUIRED_FIELD',
          message: expect.stringContaining('buyerAttributes'),
        }),
      }));
    });

    it('should return 400 when utilityIdSeller is missing for inter-discom', async () => {
      const body = createInitBasedConfirmBody({
        init: {
          'beckn:id': 'order-001',
          'beckn:orderStatus': 'CREATED',
          'beckn:seller': 'provider-001',
          'beckn:buyer': {
            'beckn:id': 'buyer-001',
            'beckn:buyerAttributes': {
              meterId: '999888777',
              utilityId: 'BRPL',
            },
          },
          'beckn:orderItems': [{
            'beckn:orderedItem': 'item-001',
            'beckn:quantity': { unitQuantity: 10, unitText: 'kWh' },
            'beckn:orderItemAttributes': {
              providerAttributes: {
                meterId: '100200300',
                // utilityId missing
              },
            },
            'beckn:acceptedOffer': { 'beckn:id': 'offer-001' },
          }],
          'beckn:payment': { 'beckn:id': 'pay-001', 'beckn:paymentStatus': 'INITIATED' },
        },
      });
      const req = mockRequest(body) as Request;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'MISSING_REQUIRED_FIELD',
          message: expect.stringContaining('providerAttributes'),
        }),
      }));
    });

    it('should return 400 when utilityIdBuyer is empty string in init-based', async () => {
      const body = createInitBasedConfirmBody({
        init: {
          'beckn:id': 'order-001',
          'beckn:orderStatus': 'CREATED',
          'beckn:seller': 'provider-001',
          'beckn:buyer': {
            'beckn:id': 'buyer-001',
            'beckn:buyerAttributes': {
              meterId: '999888777',
              utilityId: '   ',  // whitespace only
            },
          },
          'beckn:orderItems': [{
            'beckn:orderedItem': 'item-001',
            'beckn:quantity': { unitQuantity: 10, unitText: 'kWh' },
            'beckn:orderItemAttributes': {
              providerAttributes: {
                meterId: '100200300',
                utilityId: 'TPDDL',
              },
            },
            'beckn:acceptedOffer': { 'beckn:id': 'offer-001' },
          }],
          'beckn:payment': { 'beckn:id': 'pay-001', 'beckn:paymentStatus': 'INITIATED' },
        },
      });
      const req = mockRequest(body) as Request;

      await syncConfirm(req, res.res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'MISSING_REQUIRED_FIELD' }),
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

    it('should return pending transaction count from transaction store', () => {
      mockedTransactionStore.getPendingCount.mockReturnValue(5);

      const req = mockRequest({}) as Request;
      syncHealth(req, res.res as Response);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        pendingTransactions: 5,
      }));
    });
  });

  describe('validateSelect middleware', () => {
    it('should pass through catalog-based format without standard validation', () => {
      const next = mockNext();
      const body = createCatalogBasedSelectBody();
      const req = mockRequest(body) as Request;

      validateSelect(req, res.res as Response, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should validate standard beckn format against selectSchema', () => {
      const next = mockNext();
      // Missing required fields for standard format
      const req = mockRequest({
        context: { action: 'select' },
        message: {},
      }) as Request;

      validateSelect(req, res.res as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateInit middleware', () => {
    it('should pass through select-based format without standard validation', () => {
      const next = mockNext();
      const body = createSelectBasedInitBody();
      const req = mockRequest(body) as Request;

      validateInit(req, res.res as Response, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should reject raw beckn format with missing transaction_id', () => {
      const next = mockNext();
      const req = mockRequest({
        context: { action: 'init' },
        message: {},
      }) as Request;

      validateInit(req, res.res as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      }));
    });

    it('should pass raw beckn format with valid transaction_id', () => {
      const next = mockNext();
      const req = mockRequest({
        context: { transaction_id: 'txn-001', action: 'init' },
        message: {},
      }) as Request;

      validateInit(req, res.res as Response, next as NextFunction);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('validateConfirm middleware', () => {
    it('should pass through init-based format without standard validation', () => {
      const next = mockNext();
      const body = createInitBasedConfirmBody();
      const req = mockRequest(body) as Request;

      validateConfirm(req, res.res as Response, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should reject raw beckn format with missing transaction_id', () => {
      const next = mockNext();
      const req = mockRequest({
        context: { action: 'confirm' },
        message: {},
      }) as Request;

      validateConfirm(req, res.res as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should pass raw beckn format with valid transaction_id', () => {
      const next = mockNext();
      const req = mockRequest({
        context: { transaction_id: 'txn-002', action: 'confirm' },
        message: {},
      }) as Request;

      validateConfirm(req, res.res as Response, next as NextFunction);

      expect(next).toHaveBeenCalled();
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
