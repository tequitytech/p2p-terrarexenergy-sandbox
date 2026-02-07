/**
 * Integration tests for Sync API endpoints
 *
 * Tests /api/select, /api/init, /api/confirm, /api/status
 */

import axios from 'axios';

import type { Express } from 'express';

import request from 'supertest';


// Mock axios and transaction store
jest.mock('axios');
jest.mock('../../services/transaction-store');

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

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedTransactionStore = transactionStore as jest.Mocked<typeof transactionStore>;

// Import app after mocking
import { createApp } from '../../app';
import * as transactionStore from '../../services/transaction-store';
import { createBecknContext } from '../../test-utils';
import { setupTestDB, teardownTestDB, clearTestDB, seedItem, seedOffer, seedCatalog } from '../../test-utils/db';

// Helper function to create spec-compliant select order
function createSpecCompliantSelectOrder() {
  return {
    '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
    '@type': 'beckn:Order',
    'beckn:buyer': {
      '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
      '@type': 'beckn:Buyer',
      'beckn:id': 'buyer-001',
      'beckn:buyerAttributes': {
        '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/draft/schema/EnergyTrade/v0.3/context.jsonld',
        '@type': 'EnergyCustomer',
        meterId: '100200300',
        utilityCustomerId: 'CUST001',
        utilityId: 'TPDDL'
      }
    },
    'beckn:orderAttributes': {
      '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/draft/schema/EnergyTrade/v0.3/context.jsonld',
      '@type': 'EnergyTradeOrder',
      bap_id: 'p2p.terrarexenergy.com',
      bpp_id: 'p2p.terrarexenergy.com',
      total_quantity: {
        unitQuantity: 5,
        unitText: 'kWh'
      }
    },
    'beckn:orderItems': [
      {
        'beckn:orderedItem': 'item-001',
        'beckn:orderItemAttributes': {
          '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/draft/schema/EnergyTrade/v0.3/context.jsonld',
          '@type': 'EnergyOrderItem',
          providerAttributes: {
            '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/draft/schema/EnergyTrade/v0.3/context.jsonld',
            '@type': 'EnergyCustomer',
            meterId: '200300400',
            utilityCustomerId: 'SELLER001',
            utilityId: 'BESCOM'
          }
        },
        'beckn:quantity': {
          unitQuantity: 5,
          unitText: 'kWh'
        },
        'beckn:acceptedOffer': {
          '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
          '@type': 'beckn:Offer',
          'beckn:id': 'offer-001',
          'beckn:offerAttributes': {
            '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/draft/schema/EnergyTrade/v0.3/context.jsonld',
            '@type': 'EnergyTradeOffer',
            pricingModel: 'FIXED'
          }
        }
      }
    ]
  };
}

// Helper function to create spec-compliant confirm order
function createSpecCompliantConfirmOrder() {
  return {
    ...createSpecCompliantSelectOrder(),
    'beckn:orderStatus': 'CREATED'
  };
}

describe('Sync API Integration Tests', () => {
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
    jest.clearAllMocks();

    // Default mock implementations
    mockedTransactionStore.createPendingTransaction.mockImplementation(
      async () => Promise.resolve({ context: {}, message: { order: {} } })
    );
    mockedTransactionStore.cancelPendingTransaction.mockReturnValue(true);
    mockedTransactionStore.getPendingCount.mockReturnValue(0);
  });

  describe('POST /api/select', () => {
    it('should forward select request and return response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const response = await request(app)
        .post('/api/select')
        .send({
          context: createBecknContext('select'),
          message: {
            order: createSpecCompliantSelectOrder()
          }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.transaction_id).toBeDefined();
    });

    it('should return 400 for invalid select request (missing required fields)', async () => {
      const response = await request(app)
        .post('/api/select')
        .send({
          context: createBecknContext('select'),
          message: {
            order: {
              'beckn:orderItems': [
                { 'beckn:id': 'item-001', 'beckn:quantity': { unitQuantity: 5 } }
              ]
            }
          }
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return error when callback indicates business error', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedTransactionStore.createPendingTransaction.mockResolvedValue({
        error: { code: 'INSUFFICIENT_INVENTORY', message: 'Not enough inventory' }
      });

      const response = await request(app)
        .post('/api/select')
        .send({
          context: createBecknContext('select'),
          message: {
            order: createSpecCompliantSelectOrder()
          }
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });

    it('should return 504 on timeout', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });
      mockedTransactionStore.createPendingTransaction.mockRejectedValue(
        new Error('Timeout waiting for on_select callback')
      );

      const response = await request(app)
        .post('/api/select')
        .send({
          context: createBecknContext('select'),
          message: {
            order: createSpecCompliantSelectOrder()
          }
        })
        .expect(504);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/init', () => {
    it('should forward init request', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const response = await request(app)
        .post('/api/init')
        .send({
          context: createBecknContext('init'),
          message: {
            order: {
              'beckn:orderItems': [
                { 'beckn:id': 'item-001', 'beckn:quantity': { unitQuantity: 5 } }
              ],
              'beckn:payment': {
                'beckn:type': 'ON-FULFILLMENT'
              }
            }
          }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/confirm', () => {
    it('should validate inter-discom fields', async () => {
      const response = await request(app)
        .post('/api/confirm')
        .send({
          context: createBecknContext('confirm'),
          message: {
            order: {
              'beckn:orderAttributes': {
                // Missing utilityIdBuyer and utilityIdSeller
              }
            }
          }
        })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('should accept valid confirm request', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const response = await request(app)
        .post('/api/confirm')
        .send({
          context: createBecknContext('confirm'),
          message: {
            order: createSpecCompliantConfirmOrder()
          }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should extract utilityId from new v0.3 schema format', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const response = await request(app)
        .post('/api/confirm')
        .send({
          context: createBecknContext('confirm'),
          message: {
            order: createSpecCompliantConfirmOrder()
          }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      // Verify utilityIds were extracted from new schema path
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  describe('POST /api/status', () => {
    it('should forward status request', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'ACK' } } }
      });

      const response = await request(app)
        .post('/api/status')
        .send({
          context: createBecknContext('status'),
          message: {
            order_id: 'order-001'
          }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/sync/health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/sync/health')
        .expect(200);

      expect(response.body.status).toBe('OK');
      expect(response.body.pendingTransactions).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle NACK response from ONIX', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { message: { ack: { status: 'NACK' } }, error: { code: 'INVALID_REQUEST' } }
      });

      const response = await request(app)
        .post('/api/select')
        .send({
          context: createBecknContext('select'),
          message: {
            order: createSpecCompliantSelectOrder()
          }
        })
        .expect(500);

      expect(response.body.success).toBe(false);
    });

    it('should handle ONIX connection failure', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Connection refused'));

      const response = await request(app)
        .post('/api/select')
        .send({
          context: createBecknContext('select'),
          message: {
            order: createSpecCompliantSelectOrder()
          }
        })
        .expect(500);

      expect(response.body.success).toBe(false);
    });
  });
});
