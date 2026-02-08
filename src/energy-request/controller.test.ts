import { ObjectId } from 'mongodb';

import {
  clearTestDB,
  getTestDB,
  setupTestDB,
  teardownTestDB,
} from '../test-utils/db';
import { mockRequest, mockResponse } from '../test-utils/index';

// Use in-memory MongoDB
jest.mock('../db', () => ({
  getDB: () => require('../test-utils/db').getTestDB(),
  connectDB: jest.fn().mockResolvedValue(undefined),
}));

// Mock axios (for findBestSeller CDS calls)
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock buildDiscoverRequest
jest.mock('../bidding/services/market-analyzer', () => ({
  buildDiscoverRequest: jest.fn().mockReturnValue({ mock: 'discover-payload' }),
}));

// Mock the service module (executeDirectTransaction, discoverBestSeller)
jest.mock('./service');
import { executeDirectTransaction, discoverBestSeller } from './service';
const mockExecuteDirectTransaction = executeDirectTransaction as jest.MockedFunction<typeof executeDirectTransaction>;
const mockDiscoverBestSeller = discoverBestSeller as jest.MockedFunction<typeof discoverBestSeller>;

import {
  createEnergyRequest,
  getEnergyRequests,
  findBestSeller,
  giftEnergy,
  donateEnergy,
} from './controller';

// Suppress console.error and console.log in tests
let consoleErrorSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;

describe('EnergyRequest Controller', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  // Helper to seed a user
  async function seedUser(data: {
    phone: string;
    name: string;
    isVerifiedBeneficiary?: boolean;
    beneficiaryType?: string;
    consumptionProfileId?: string;
    generationProfileId?: string;
    utilityCustomerDid?: string;
  }) {
    const db = getTestDB();
    return db.collection('users').insertOne({
      phone: data.phone,
      name: data.name,
      isVerifiedBeneficiary: data.isVerifiedBeneficiary ?? false,
      beneficiaryType: data.beneficiaryType || undefined,
      vcVerified: true,
      profiles: {
        consumptionProfile: data.consumptionProfileId
          ? { id: data.consumptionProfileId }
          : null,
        generationProfile: data.generationProfileId
          ? { id: data.generationProfileId }
          : null,
        utilityCustomer: data.utilityCustomerDid
          ? { did: data.utilityCustomerDid }
          : null,
        storageProfile: null,
        programEnrollment: null,
      },
      meters: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Helper to seed an energy request
  async function seedEnergyRequest(data: {
    userId: string | ObjectId;
    requiredEnergy: number;
    status?: string;
    purpose?: string;
  }) {
    const db = getTestDB();
    const result = await db.collection('energy_requests').insertOne({
      userId: data.userId,
      userName: 'Test User',
      isVerifiedBeneficiary: true,
      requiredEnergy: data.requiredEnergy,
      purpose: data.purpose || 'Testing',
      startTime: '2026-02-10T08:00:00Z',
      endTime: '2026-02-10T17:00:00Z',
      status: data.status || 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return result.insertedId;
  }

  // ============================================
  // createEnergyRequest
  // ============================================
  describe('createEnergyRequest', () => {
    it('should return 401 when not authenticated', async () => {
      const req = mockRequest({
        requiredEnergy: 10,
        purpose: 'Testing',
        startTime: '2026-02-10T08:00:00Z',
        endTime: '2026-02-10T17:00:00Z',
      });
      const { res, status, json } = mockResponse();

      await createEnergyRequest(req as any, res as any);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    });

    it('should return 400 when requiredEnergy is missing', async () => {
      const req = mockRequest({
        purpose: 'Testing',
        startTime: '2026-02-10T08:00:00Z',
        endTime: '2026-02-10T17:00:00Z',
      });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      const { res, status, json } = mockResponse();

      await createEnergyRequest(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Missing required fields' });
    });

    it('should return 400 when purpose is missing', async () => {
      const req = mockRequest({
        requiredEnergy: 10,
        startTime: '2026-02-10T08:00:00Z',
        endTime: '2026-02-10T17:00:00Z',
      });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      const { res, status, json } = mockResponse();

      await createEnergyRequest(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Missing required fields' });
    });

    it('should return 404 when user profile not found', async () => {
      const req = mockRequest({
        requiredEnergy: 10,
        purpose: 'Testing',
        startTime: '2026-02-10T08:00:00Z',
        endTime: '2026-02-10T17:00:00Z',
      });
      (req as any).user = { phone: 'nonexistent-phone', userId: 'user-1' };
      const { res, status, json } = mockResponse();

      await createEnergyRequest(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'User profile not found' });
    });

    it('should insert request with PENDING status and return 201', async () => {
      await seedUser({ phone: '1234567890', name: 'Test User', isVerifiedBeneficiary: true, beneficiaryType: 'social' });

      const req = mockRequest({
        requiredEnergy: 15,
        purpose: 'Need energy for community center',
        startTime: '2026-02-10T08:00:00Z',
        endTime: '2026-02-10T17:00:00Z',
      });
      (req as any).user = { phone: '1234567890', _id: 'user-obj-id' };
      const { res, status, json } = mockResponse();

      await createEnergyRequest(req as any, res as any);

      expect(status).toHaveBeenCalledWith(201);
      const responseData = json.mock.calls[0][0];
      expect(responseData.success).toBe(true);
      expect(responseData.data.status).toBe('PENDING');
      expect(responseData.data.requiredEnergy).toBe(15);
      expect(responseData.data.purpose).toBe('Need energy for community center');
      expect(responseData.data._id).toBeDefined();
    });

    it('should include isVerifiedBeneficiary from user profile', async () => {
      await seedUser({ phone: '1234567890', name: 'Beneficiary User', isVerifiedBeneficiary: true, beneficiaryType: 'social' });

      const req = mockRequest({
        requiredEnergy: 5,
        purpose: 'Testing',
        startTime: '2026-02-10T08:00:00Z',
        endTime: '2026-02-10T17:00:00Z',
      });
      (req as any).user = { phone: '1234567890' };
      const { res, status, json } = mockResponse();

      await createEnergyRequest(req as any, res as any);

      expect(status).toHaveBeenCalledWith(201);
      const responseData = json.mock.calls[0][0];
      expect(responseData.data.isVerifiedBeneficiary).toBe(true);
      expect(responseData.data.beneficiaryType).toBe('social');
    });
  });

  // ============================================
  // getEnergyRequests
  // ============================================
  describe('getEnergyRequests', () => {
    it('should return all PENDING requests sorted by createdAt desc', async () => {
      const db = getTestDB();
      const now = new Date();

      await db.collection('energy_requests').insertMany([
        {
          userId: 'user-1',
          userName: 'Oldest',
          requiredEnergy: 5,
          purpose: 'P1',
          status: 'PENDING',
          createdAt: new Date(now.getTime() - 2000),
        },
        {
          userId: 'user-2',
          userName: 'Newest',
          requiredEnergy: 10,
          purpose: 'P2',
          status: 'PENDING',
          createdAt: new Date(now.getTime()),
        },
        {
          userId: 'user-3',
          userName: 'Fulfilled',
          requiredEnergy: 8,
          purpose: 'P3',
          status: 'FULFILLED',
          createdAt: new Date(now.getTime() - 1000),
        },
      ]);

      const req = mockRequest();
      const { res, status, json } = mockResponse();

      await getEnergyRequests(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      const data = json.mock.calls[0][0];
      expect(data).toHaveLength(2); // Only PENDING
      expect(data[0].userName).toBe('Newest');
      expect(data[1].userName).toBe('Oldest');
    });

    it('should return empty array when no pending requests', async () => {
      const req = mockRequest();
      const { res, status, json } = mockResponse();

      await getEnergyRequests(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      expect(json.mock.calls[0][0]).toEqual([]);
    });
  });

  // ============================================
  // findBestSeller
  // ============================================
  describe('findBestSeller', () => {
    it('should return 400 when requestId is missing', async () => {
      const req = mockRequest({}, {}); // no params
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Request ID missing' });
    });

    it('should return 400 for invalid ObjectId format', async () => {
      const req = mockRequest({}, { requestId: 'not-valid-objectid' });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Invalid Request ID format' });
    });

    it('should return 404 when energy request not found', async () => {
      const fakeId = new ObjectId().toString();
      const req = mockRequest({}, { requestId: fakeId });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Energy request not found' });
    });

    it('should return 404 when no catalogs from CDS', async () => {
      const requestId = await seedEnergyRequest({ userId: 'user-1', requiredEnergy: 10 });

      mockedAxios.post.mockResolvedValue({
        data: { message: { catalogs: [] } },
      });

      const req = mockRequest({}, { requestId: requestId.toString() });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, message: 'No suitable seller found' });
    });

    it('should return cheapest offer sorted by price ascending', async () => {
      const requestId = await seedEnergyRequest({ userId: 'user-1', requiredEnergy: 10 });

      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Seller A' },
          'beckn:provider': { id: 'provider-a' },
          'beckn:bppId': 'bpp-a',
          'beckn:items': [{ 'beckn:id': 'item-1' }],
          'beckn:offers': [
            {
              'beckn:id': 'offer-expensive',
              'beckn:price': { 'schema:price': 8.0 },
              'beckn:items': ['item-1'],
            },
            {
              'beckn:id': 'offer-cheap',
              'beckn:price': { 'schema:price': 4.5 },
              'beckn:items': ['item-1'],
            },
          ],
        },
      ];

      mockedAxios.post.mockResolvedValue({
        data: { message: { catalogs } },
      });

      const req = mockRequest({}, { requestId: requestId.toString() });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      const data = json.mock.calls[0][0];
      expect(data.success).toBe(true);
      expect(data.bestSeller['beckn:id']).toBe('offer-cheap');
      expect(data.bestSeller.providerId).toBe('provider-a');
    });

    it('should match item to offer via beckn:items reference', async () => {
      const requestId = await seedEnergyRequest({ userId: 'user-1', requiredEnergy: 10 });

      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Seller B' },
          'beckn:provider': { id: 'provider-b' },
          'beckn:bppId': 'bpp-b',
          'beckn:items': [
            { 'beckn:id': 'item-A', 'schema:name': 'Solar Panel A' },
            { 'beckn:id': 'item-B', 'schema:name': 'Solar Panel B' },
          ],
          'beckn:offers': [
            {
              'beckn:id': 'offer-1',
              'beckn:price': { 'schema:price': 5.0 },
              'beckn:items': ['item-B'],
            },
          ],
        },
      ];

      mockedAxios.post.mockResolvedValue({
        data: { message: { catalogs } },
      });

      const req = mockRequest({}, { requestId: requestId.toString() });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      const data = json.mock.calls[0][0];
      expect(data.bestSeller.item).toBeDefined();
      expect(data.bestSeller.item['beckn:id']).toBe('item-B');
    });

    it('should return 500 when CDS request fails', async () => {
      const requestId = await seedEnergyRequest({ userId: 'user-1', requiredEnergy: 10 });

      mockedAxios.post.mockRejectedValue(new Error('CDS timeout'));

      const req = mockRequest({}, { requestId: requestId.toString() });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(500);
      expect(json.mock.calls[0][0].error).toBe('CDS timeout');
    });

    it('should return 404 when catalogs have no offers', async () => {
      const requestId = await seedEnergyRequest({ userId: 'user-1', requiredEnergy: 10 });

      const catalogs = [
        {
          'beckn:descriptor': { 'schema:name': 'Empty Seller' },
          'beckn:provider': { id: 'provider-c' },
          'beckn:bppId': 'bpp-c',
          'beckn:items': [{ 'beckn:id': 'item-1' }],
          // no beckn:offers
        },
      ];

      mockedAxios.post.mockResolvedValue({
        data: { message: { catalogs } },
      });

      const req = mockRequest({}, { requestId: requestId.toString() });
      const { res, status, json } = mockResponse();

      await findBestSeller(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json.mock.calls[0][0].message).toBe('No suitable offers found in catalogs');
    });
  });

  // ============================================
  // giftEnergy
  // ============================================
  describe('giftEnergy', () => {
    it('should return 401 when not authenticated', async () => {
      const req = mockRequest({ requestId: 'some-id' });
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    });

    it('should return 400 when requestId is missing', async () => {
      const req = mockRequest({});
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Missing requestId' });
    });

    it('should return 404 when request not found', async () => {
      await seedUser({ phone: '1234567890', name: 'Gifter' });
      const fakeId = new ObjectId().toString();

      const req = mockRequest({ requestId: fakeId });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Request not found' });
    });

    it('should return 400 when request already FULFILLED', async () => {
      await seedUser({ phone: '1234567890', name: 'Gifter' });
      const requestId = await seedEnergyRequest({ userId: 'beneficiary-1', requiredEnergy: 10, status: 'FULFILLED' });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Request already fulfilled' });
    });

    it('should return 404 when no suitable seller found', async () => {
      await seedUser({ phone: '1234567890', name: 'Gifter', consumptionProfileId: 'gifter-cp' });
      const requestId = await seedEnergyRequest({ userId: 'beneficiary-1', requiredEnergy: 10 });

      mockDiscoverBestSeller.mockResolvedValue(null);

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'No suitable energy seller found' });
    });

    it('should call executeDirectTransaction with autoConfirm=false', async () => {
      await seedUser({ phone: '1234567890', name: 'Gifter', consumptionProfileId: 'gifter-cp' });
      const beneficiaryUserId = new ObjectId();
      const requestId = await seedEnergyRequest({ userId: beneficiaryUserId, requiredEnergy: 10 });

      mockDiscoverBestSeller.mockResolvedValue({
        sellerId: 'seller-123',
        price: 5.5,
        offer: {},
      });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-gift-001',
        orderId: 'order-gift-001',
        status: 'INITIATED',
        amount: 55,
        message: { order: { 'beckn:payment': { 'beckn:amount': { value: 55 } } } },
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      expect(mockExecuteDirectTransaction).toHaveBeenCalledWith(
        'gifter-cp',         // gifterId (from consumptionProfile.id)
        'seller-123',        // sellerId
        10,                  // quantity
        5.5,                 // price
        'Bearer test-token', // authToken
        beneficiaryUserId.toString(), // beneficiaryId
        false,               // autoConfirm = false for gift
      );
    });

    it('should update request status to PAYMENT_PENDING', async () => {
      await seedUser({ phone: '1234567890', name: 'Gifter', consumptionProfileId: 'gifter-cp' });
      const requestId = await seedEnergyRequest({ userId: new ObjectId(), requiredEnergy: 10 });

      mockDiscoverBestSeller.mockResolvedValue({
        sellerId: 'seller-123',
        price: 5.5,
        offer: {},
      });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-gift-002',
        orderId: 'order-gift-002',
        status: 'INITIATED',
        amount: 55,
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res } = mockResponse();

      await giftEnergy(req as any, res as any);

      // Verify DB was updated
      const db = getTestDB();
      const updatedRequest = await db.collection('energy_requests').findOne({ _id: requestId });
      expect(updatedRequest?.status).toBe('PAYMENT_PENDING');
      expect(updatedRequest?.fulfilledBy).toBe('seller-123');
      expect(updatedRequest?.giftedBy).toBe('gifter-cp');
      expect(updatedRequest?.transactionId).toBe('txn-gift-002');
    });

    it('should return 200 with transaction details on success', async () => {
      await seedUser({ phone: '1234567890', name: 'Gifter', consumptionProfileId: 'gifter-cp' });
      const requestId = await seedEnergyRequest({ userId: new ObjectId(), requiredEnergy: 10 });

      mockDiscoverBestSeller.mockResolvedValue({
        sellerId: 'seller-123',
        price: 5.5,
        offer: {},
      });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-gift-003',
        orderId: 'order-gift-003',
        status: 'INITIATED',
        amount: 55,
        message: { order: { 'beckn:payment': { link: 'https://pay.example.com' } } },
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890', userId: 'user-1' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await giftEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      const data = json.mock.calls[0][0];
      expect(data.success).toBe(true);
      expect(data.transactionId).toBe('txn-gift-003');
      expect(data.orderId).toBe('order-gift-003');
      expect(data.sellerId).toBe('seller-123');
      expect(data.gifterId).toBe('gifter-cp');
      expect(data.status).toBe('INITIATED');
      expect(data.amount).toBe(55);
    });
  });

  // ============================================
  // donateEnergy
  // ============================================
  describe('donateEnergy', () => {
    it('should return 401 when not authenticated', async () => {
      const req = mockRequest({ requestId: 'some-id' });
      const { res, status, json } = mockResponse();

      await donateEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    });

    it('should return 404 when seller profile not found', async () => {
      const req = mockRequest({ requestId: new ObjectId().toString() });
      (req as any).user = { phone: 'nonexistent-phone' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await donateEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Seller profile not found' });
    });

    it('should return 400 when user has no valid seller ID', async () => {
      // Seed user without any profile IDs
      const db = getTestDB();
      await db.collection('users').insertOne({
        phone: '1234567890',
        name: 'No ID User',
        profiles: {
          consumptionProfile: null,
          generationProfile: null,
          utilityCustomer: null,
        },
      });

      const req = mockRequest({ requestId: new ObjectId().toString() });
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await donateEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'User does not have a valid seller/provider ID configured' });
    });

    it('should return 404 when request not found', async () => {
      await seedUser({ phone: '1234567890', name: 'Seller', generationProfileId: 'gen-seller-id' });
      const fakeId = new ObjectId().toString();

      const req = mockRequest({ requestId: fakeId });
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await donateEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ success: false, error: 'Request not found' });
    });

    it('should call executeDirectTransaction with price=0', async () => {
      await seedUser({ phone: '1234567890', name: 'Donor', generationProfileId: 'gen-donor-id' });
      const beneficiaryUserId = new ObjectId();
      const requestId = await seedEnergyRequest({ userId: beneficiaryUserId, requiredEnergy: 8 });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-donate-001',
        orderId: 'order-donate-001',
        status: 'CONFIRMED',
        amount: 0,
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res } = mockResponse();

      await donateEnergy(req as any, res as any);

      expect(mockExecuteDirectTransaction).toHaveBeenCalledWith(
        beneficiaryUserId.toString(), // buyerId = the beneficiary/requester
        'gen-donor-id',               // sellerId from generationProfile.id
        8,                             // quantity
        0,                             // price = 0 for donation
        'Bearer test-token',           // authToken
        beneficiaryUserId.toString(),  // beneficiaryId = same as buyerId
      );
    });

    it('should update request status to FULFILLED', async () => {
      await seedUser({ phone: '1234567890', name: 'Donor', generationProfileId: 'gen-donor-id' });
      const requestId = await seedEnergyRequest({ userId: new ObjectId(), requiredEnergy: 8 });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-donate-002',
        orderId: 'order-donate-002',
        status: 'CONFIRMED',
        amount: 0,
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res } = mockResponse();

      await donateEnergy(req as any, res as any);

      const db = getTestDB();
      const updatedRequest = await db.collection('energy_requests').findOne({ _id: requestId });
      expect(updatedRequest?.status).toBe('FULFILLED');
      expect(updatedRequest?.fulfilledBy).toBe('gen-donor-id');
      expect(updatedRequest?.transactionId).toBe('txn-donate-002');
    });

    it('should return 200 with transaction details on success', async () => {
      await seedUser({ phone: '1234567890', name: 'Donor', generationProfileId: 'gen-donor-id' });
      const requestId = await seedEnergyRequest({ userId: new ObjectId(), requiredEnergy: 8 });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-donate-003',
        status: 'CONFIRMED',
        amount: 0,
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await donateEnergy(req as any, res as any);

      expect(status).toHaveBeenCalledWith(200);
      const data = json.mock.calls[0][0];
      expect(data.success).toBe(true);
      expect(data.transactionId).toBe('txn-donate-003');
      expect(data.status).toBe('CONFIRMED');
      expect(data.amount).toBe(0);
      expect(data.requestId).toBe(requestId.toString());
    });

    it('should use sellerId fallback chain: generationProfile.id → consumptionProfile.id → utilityCustomer.did', async () => {
      // User with only utilityCustomer.did (no generationProfile or consumptionProfile)
      await seedUser({ phone: '1234567890', name: 'Utility Donor', utilityCustomerDid: 'did:utility:abc' });
      const requestId = await seedEnergyRequest({ userId: new ObjectId(), requiredEnergy: 5 });

      mockExecuteDirectTransaction.mockResolvedValue({
        success: true,
        transactionId: 'txn-donate-004',
        status: 'CONFIRMED',
        amount: 0,
      });

      const req = mockRequest({ requestId: requestId.toString() });
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res } = mockResponse();

      await donateEnergy(req as any, res as any);

      // Should have used utilityCustomer.did as sellerId
      expect(mockExecuteDirectTransaction).toHaveBeenCalledWith(
        expect.any(String),
        'did:utility:abc', // from utilityCustomer.did
        5,
        0,
        'Bearer test-token',
        expect.any(String),
      );
    });

    it('should return 500 when Zod validation fails (missing requestId)', async () => {
      const req = mockRequest({}); // no requestId
      (req as any).user = { phone: '1234567890' };
      req.headers = { authorization: 'Bearer test-token' };
      const { res, status, json } = mockResponse();

      await donateEnergy(req as any, res as any);

      // Zod parse throws, caught by try/catch
      expect(status).toHaveBeenCalledWith(500);
    });
  });
});
