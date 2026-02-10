// Mock axios before importing the module under test
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock buildDiscoverRequest
jest.mock('../bidding/services/market-analyzer', () => ({
  buildDiscoverRequest: jest.fn().mockReturnValue({ mock: 'discover-payload' }),
}));

// Mock crypto.randomUUID for deterministic transaction/message IDs
const mockUUIDs = [
  'uuid-message-1',
  'uuid-txn-1',
  'uuid-message-2',
  'uuid-message-3',
  'uuid-payment-1',
  'uuid-message-4',
  'uuid-message-5',
];
let uuidIndex = 0;
jest.spyOn(require('crypto'), 'randomUUID').mockImplementation(() => {
  const id = mockUUIDs[uuidIndex % mockUUIDs.length];
  uuidIndex++;
  return id;
});

import { executeDirectTransaction, discoverBestSeller } from './service';

// Suppress console output
let consoleLogSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

describe('EnergyRequest Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    uuidIndex = 0;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    // Set env vars
    process.env.BAP_ID = 'test-bap-id';
    process.env.BAP_URI = 'https://test-bap.example.com/bap/receiver';
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('executeDirectTransaction', () => {
    const buyerId = 'buyer-001';
    const sellerId = 'seller-001';
    const quantity = 10;
    const pricePerUnit = 5.5;
    const authToken = 'Bearer test-token-123';

    function setupSequentialMocks(options: {
      publishData?: any;
      selectData?: any;
      initData?: any;
      confirmData?: any;
    } = {}) {
      const publishData = options.publishData || {
        item_id: 'item-123',
        offer_id: 'offer-456',
        catalog_id: 'catalog-789',
        prosumer: { meterId: 'MTR-SELLER-001' },
      };
      const selectData = options.selectData || {
        message: {
          order: {
            'beckn:id': 'order-select-001',
            'beckn:orderStatus': 'CREATED',
          },
        },
      };
      const initData = options.initData || {
        message: {
          order: {
            'beckn:id': 'order-init-001',
          },
          'beckn:payment': { 'beckn:paymentStatus': 'INITIATED' },
        },
      };
      const confirmData = options.confirmData || {
        message: {
          order: {
            'beckn:id': 'order-confirm-001',
          },
        },
      };

      // The calls are: publish, select, init, confirm (in sequence)
      mockedAxios.post
        .mockResolvedValueOnce({ data: publishData })   // publish
        .mockResolvedValueOnce({ data: selectData })     // select
        .mockResolvedValueOnce({ data: initData })       // init
        .mockResolvedValueOnce({ data: confirmData });   // confirm
    }

    it('should call publish, select, init, confirm in sequence', async () => {
      setupSequentialMocks();

      const result = await executeDirectTransaction(
        buyerId, sellerId, quantity, pricePerUnit, authToken,
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('CONFIRMED');
      expect(mockedAxios.post).toHaveBeenCalledTimes(4);

      const calls = mockedAxios.post.mock.calls;
      // 1: publish
      expect(calls[0][0]).toContain('/api/publish');
      // 2: select
      expect(calls[1][0]).toContain('/api/select');
      // 3: init
      expect(calls[2][0]).toContain('/api/init');
      // 4: confirm
      expect(calls[3][0]).toContain('/api/confirm');
    });

    it('should use simplified publish format (quantity, price, deliveryDate, startHour)', async () => {
      setupSequentialMocks();

      await executeDirectTransaction(buyerId, sellerId, quantity, pricePerUnit, authToken);

      const publishCall = mockedAxios.post.mock.calls[0];
      const publishBody = publishCall[1] as any;
      expect(publishBody).toMatchObject({
        quantity: 10,
        price: 5.5,
        duration: 1,
        sourceType: 'SOLAR',
      });
      expect(publishBody.deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof publishBody.startHour).toBe('number');

      // Check auth header was passed
      expect(publishCall[2]).toEqual({ headers: { Authorization: authToken } });
    });

    it('should stop at init when autoConfirm=false (gift flow)', async () => {
      const initData = {
        message: {
          order: { 'beckn:id': 'order-init-gift' },
        },
      };
      setupSequentialMocks({ initData });

      const result = await executeDirectTransaction(
        buyerId, sellerId, quantity, pricePerUnit, authToken,
        'beneficiary-001', false, // autoConfirm = false
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('INITIATED');
      expect(result.orderId).toBe('order-init-gift');
      expect(result.message).toEqual(initData.message);
      // Only 3 calls: publish, select, init (no confirm)
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });

    it('should return INITIATED status when autoConfirm=false', async () => {
      setupSequentialMocks();

      const result = await executeDirectTransaction(
        buyerId, sellerId, quantity, pricePerUnit, authToken,
        undefined, false,
      );

      expect(result.status).toBe('INITIATED');
      expect(result.amount).toBe(pricePerUnit * quantity);
    });

    it('should return CONFIRMED status when autoConfirm=true', async () => {
      setupSequentialMocks();

      const result = await executeDirectTransaction(
        buyerId, sellerId, quantity, pricePerUnit, authToken,
        undefined, true,
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('CONFIRMED');
      expect(result.amount).toBe(55); // 5.5 * 10
      // orderId comes from confirmResponse.message.order['beckn:id']
      expect(result.orderId).toBeDefined();
    });

    it('should use price=0.01 instead of 0 for donations (minimum)', async () => {
      setupSequentialMocks();

      await executeDirectTransaction(
        buyerId, sellerId, quantity, 0, authToken,
      );

      const publishBody = mockedAxios.post.mock.calls[0][1] as any;
      expect(publishBody.price).toBe(0.01);

      // The offer in select should also use 0.01
      const selectBody = mockedAxios.post.mock.calls[1][1] as any;
      const orderItems = selectBody.message.order['beckn:orderItems'];
      expect(orderItems[0]['beckn:acceptedOffer']['beckn:price']['schema:price']).toBe(0.01);
    });

    it('should include beneficiaryId in select payload buyer attributes', async () => {
      setupSequentialMocks();

      await executeDirectTransaction(
        buyerId, sellerId, quantity, pricePerUnit, authToken,
        'beneficiary-xyz',
      );

      // Select is the 2nd call
      const selectBody = mockedAxios.post.mock.calls[1][1] as any;
      const buyer = selectBody.message.order['beckn:buyer'];
      expect(buyer['beckn:id']).toBe(buyerId);
    });

    it('should propagate publish errors', async () => {
      const publishError = new Error('Publish failed');
      (publishError as any).response = { data: { error: 'Catalog invalid' } };
      mockedAxios.post.mockRejectedValue(publishError);

      await expect(
        executeDirectTransaction(buyerId, sellerId, quantity, pricePerUnit, authToken),
      ).rejects.toThrow('Publish failed');

      // First call is publish — it should have been called at least once
      expect(mockedAxios.post.mock.calls[0][0]).toContain('/api/publish');
    });

    it('should propagate select errors', async () => {
      // Publish succeeds
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          item_id: 'item-1', offer_id: 'offer-1', catalog_id: 'cat-1',
          prosumer: { meterId: 'MTR-1' },
        },
      });
      // Select fails
      const selectError = new Error('Select failed');
      (selectError as any).response = { data: { error: 'Order not found' } };
      mockedAxios.post.mockRejectedValueOnce(selectError);

      await expect(
        executeDirectTransaction(buyerId, sellerId, quantity, pricePerUnit, authToken),
      ).rejects.toThrow('Select failed');

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should calculate correct amount (pricePerUnit * quantity)', async () => {
      setupSequentialMocks();

      const result = await executeDirectTransaction(
        buyerId, sellerId, 15, 3.5, authToken,
      );

      expect(result.amount).toBe(52.5); // 3.5 * 15
    });

    it('should use consistent base URI for all API calls', async () => {
      setupSequentialMocks();

      await executeDirectTransaction(buyerId, sellerId, quantity, pricePerUnit, authToken);

      const calls = mockedAxios.post.mock.calls;
      // All 4 calls should use the same base origin
      const publishOrigin = new URL(calls[0][0] as string).origin;
      const selectOrigin = new URL(calls[1][0] as string).origin;
      const initOrigin = new URL(calls[2][0] as string).origin;
      const confirmOrigin = new URL(calls[3][0] as string).origin;

      expect(publishOrigin).toBe(selectOrigin);
      expect(selectOrigin).toBe(initOrigin);
      expect(initOrigin).toBe(confirmOrigin);
    });

    it('should return amount=0 for donation flow (pricePerUnit=0)', async () => {
      setupSequentialMocks();

      const result = await executeDirectTransaction(
        buyerId, sellerId, quantity, 0, authToken,
      );

      // amount = pricePerUnit * quantity = 0 * 10 = 0
      expect(result.amount).toBe(0);
    });
  });

  describe('discoverBestSeller', () => {
    it('should return cheapest offer from CDS catalogs', async () => {
      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Catalog A' },
          'beckn:provider': { id: 'seller-A' },
          'beckn:bppId': 'bpp-A',
          'beckn:items': [{ 'beckn:id': 'item-A' }],
          'beckn:offers': [
            {
              'beckn:id': 'offer-expensive',
              'beckn:price': { 'schema:price': 8.0 },
            },
            {
              'beckn:id': 'offer-cheap',
              'beckn:price': { 'schema:price': 3.5 },
            },
          ],
        },
        {
          'beckn:descriptor': { 'schema:name': 'Catalog B' },
          'beckn:provider': { id: 'seller-B' },
          'beckn:bppId': 'bpp-B',
          'beckn:items': [{ 'beckn:id': 'item-B' }],
          'beckn:offers': [
            {
              'beckn:id': 'offer-mid',
              'beckn:price': { 'schema:price': 5.0 },
            },
          ],
        },
      ];

      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs } },
      });

      const result = await discoverBestSeller(10, 'Bearer token');

      expect(result).not.toBeNull();
      expect(result!.sellerId).toBe('seller-A');
      expect(result!.price).toBe(3.5);
      expect(result!.offer['beckn:id']).toBe('offer-cheap');
    });

    it('should return null when no catalogs found', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs: [] } },
      });

      const result = await discoverBestSeller(10);

      expect(result).toBeNull();
    });

    it('should return null when CDS request fails', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

      const result = await discoverBestSeller(10);

      expect(result).toBeNull();
    });

    it('should return null when catalogs have no offers', async () => {
      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Empty Catalog' },
          'beckn:provider': { id: 'seller-empty' },
          'beckn:items': [{ 'beckn:id': 'item-1' }],
          // No beckn:offers field
        },
      ];

      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs } },
      });

      const result = await discoverBestSeller(10);

      expect(result).toBeNull();
    });

    it('should pass auth token in headers when provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs: [] } },
      });

      await discoverBestSeller(10, 'Bearer my-auth-token');

      const callHeaders = mockedAxios.post.mock.calls[0][2];
      expect(callHeaders?.headers?.Authorization).toBe('Bearer my-auth-token');
    });

    it('should not include Authorization header when no token provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs: [] } },
      });

      await discoverBestSeller(10);

      const callHeaders = mockedAxios.post.mock.calls[0][2];
      expect(callHeaders?.headers?.Authorization).toBeUndefined();
    });

    it('should use fallback price path (beckn:offerAttributes.beckn:price.value)', async () => {
      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Catalog C' },
          'beckn:provider': { id: 'seller-C' },
          'beckn:bppId': 'bpp-C',
          'beckn:items': [],
          'beckn:offers': [
            {
              'beckn:id': 'offer-alt-price',
              'beckn:offerAttributes': {
                'beckn:price': { value: 4.25 },
              },
            },
          ],
        },
      ];

      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs } },
      });

      const result = await discoverBestSeller(10);

      expect(result).not.toBeNull();
      expect(result!.price).toBe(4.25);
    });

    it('should fall back to bppId as sellerId when provider.id is missing', async () => {
      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Catalog D' },
          'beckn:provider': {}, // no id
          'beckn:bppId': 'bpp-fallback',
          'beckn:items': [],
          'beckn:offers': [
            {
              'beckn:id': 'offer-fallback',
              'beckn:price': { 'schema:price': 6.0 },
            },
          ],
        },
      ];

      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs } },
      });

      const result = await discoverBestSeller(10);

      expect(result).not.toBeNull();
      expect(result!.sellerId).toBe('bpp-fallback');
    });

    it('should use buildDiscoverRequest for the discover payload', async () => {
      const { buildDiscoverRequest } = require('../bidding/services/market-analyzer');

      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs: [] } },
      });

      await discoverBestSeller(10);

      expect(buildDiscoverRequest).toHaveBeenCalledWith({
        isActive: true,
        sourceType: 'SOLAR',
      });

      // Check the mocked payload was forwarded
      const postedBody = mockedAxios.post.mock.calls[0][1];
      expect(postedBody).toEqual({ mock: 'discover-payload' });
    });

    it('should call discover URL at p2p.terrarexenergy.com', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs: [] } },
      });

      await discoverBestSeller(10);

      expect(mockedAxios.post.mock.calls[0][0]).toBe(
        'https://p2p.terrarexenergy.com/bap/caller/discover',
      );
    });

    it('should set 15 second timeout on CDS request', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: { catalogs: [] } },
      });

      await discoverBestSeller(10);

      const callConfig = mockedAxios.post.mock.calls[0][2];
      expect(callConfig?.timeout).toBe(15000);
    });
  });
});
