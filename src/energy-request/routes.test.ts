/**
 * Tests for energy-request/routes.ts
 * 
 * Covers: 
 * - POST /request-energy
 * - GET /accounts/donate
 * - GET /accounts/gift
 * - GET /find-seller/:requestId
 * - POST /gift
 * - POST /donate
 */

import express from 'express';
import request from 'supertest';
import { energyRequestRoutes } from './routes';
import { ObjectId } from 'mongodb';

// Mock dependencies
jest.mock('../db', () => ({
    getDB: jest.fn()
}));

jest.mock('axios');

jest.mock('./service', () => ({
    executeDirectTransaction: jest.fn(),
    discoverBestSeller: jest.fn()
}));

jest.mock('../bidding/services/market-analyzer', () => ({
    buildDiscoverRequest: jest.fn().mockReturnValue({ context: {}, message: {} })
}));

jest.mock('../auth/routes', () => ({
    authMiddleware: jest.fn((req, res, next) => {
        req.user = { phone: '9876543210', userId: 'user-123', _id: new ObjectId().toString() };
        next();
    })
}));

import { getDB } from '../db';
import axios from 'axios';
import { executeDirectTransaction, discoverBestSeller } from './service';
import { authMiddleware } from '../auth/routes';

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedExecuteTransaction = executeDirectTransaction as jest.MockedFunction<typeof executeDirectTransaction>;
const mockedDiscoverBestSeller = discoverBestSeller as jest.MockedFunction<typeof discoverBestSeller>;

describe('energy-request/routes', () => {
    let app: express.Express;
    let mockDb: any;
    let mockCollection: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockCollection = {
            findOne: jest.fn(),
            insertOne: jest.fn(),
            find: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            toArray: jest.fn(),
            updateOne: jest.fn()
        };

        mockDb = {
            collection: jest.fn().mockReturnValue(mockCollection)
        };

        mockedGetDB.mockReturnValue(mockDb);

        app = express();
        app.use(express.json());
        app.use('/api', energyRequestRoutes());
    });

    describe('POST /request-energy', () => {
        it('should create an energy request successfully', async () => {
            const userProfile = {
                _id: new ObjectId(),
                name: 'Test User',
                phone: '9876543210',
                isVerifiedBeneficiary: true,
                beneficiaryType: 'Farmer'
            };
            mockCollection.findOne.mockResolvedValue(userProfile);
            mockCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });

            const payload = {
                requiredEnergy: 50,
                purpose: 'Irrigation',
                startTime: '2026-02-05T10:00:00Z',
                endTime: '2026-02-05T12:00:00Z'
            };

            const response = await request(app)
                .post('/api/request-energy')
                .send(payload)
                .expect(201);

            expect(response.body.success).toBe(true);
            expect(response.body.data.requiredEnergy).toBe(50);
            expect(mockCollection.insertOne).toHaveBeenCalled();
        });

        it('should return 400 if required fields are missing', async () => {
            const response = await request(app)
                .post('/api/request-energy')
                .send({ requiredEnergy: 50 })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Missing required fields');
        });

        it('should return 404 if user profile not found', async () => {
            mockCollection.findOne.mockResolvedValue(null);

            const payload = {
                requiredEnergy: 50,
                purpose: 'Irrigation',
                startTime: '2026-02-05T10:00:00Z',
                endTime: '2026-02-05T12:00:00Z'
            };

            const response = await request(app)
                .post('/api/request-energy')
                .send(payload)
                .expect(404);

            expect(response.body.error).toBe('User profile not found');
        });
    });

    describe('GET /accounts/donate and /accounts/gift', () => {
        it('should return all pending energy requests', async () => {
            const mockRequests = [
                { _id: new ObjectId(), status: 'PENDING', requiredEnergy: 10 },
                { _id: new ObjectId(), status: 'PENDING', requiredEnergy: 20 }
            ];
            mockCollection.toArray.mockResolvedValue(mockRequests);

            const response = await request(app)
                .get('/api/accounts/donate')
                .expect(200);

            expect(response.body).toHaveLength(2);
            expect(mockCollection.find).toHaveBeenCalledWith({ status: 'PENDING' });
        });
    });

    describe('GET /find-seller/:requestId', () => {
        it('should find the best seller for a request', async () => {
            const requestId = new ObjectId();
            const mockRequestData = {
                _id: requestId,
                requiredEnergy: 50,
                startTime: '2026-02-05T10:00:00Z',
                endTime: '2026-02-05T12:00:00Z'
            };
            mockCollection.findOne.mockResolvedValue(mockRequestData);

            const mockCdsResponse = {
                data: {
                    message: {
                        catalogs: [
                            {
                                "beckn:descriptor": { name: "Seller 1" },
                                "beckn:provider": { id: "p1" },
                                "beckn:bppId": "bpp1",
                                "beckn:items": [{ "beckn:id": "item-1", "beckn:descriptor": { name: "Solar" } }],
                                "beckn:offers": [{
                                    "beckn:price": { "schema:price": "7.5" },
                                    "beckn:items": ["item-1"]
                                }]
                            }
                        ]
                    }
                }
            };
            mockedAxios.post.mockResolvedValue(mockCdsResponse);

            const response = await request(app)
                .get(`/api/find-seller/${requestId.toString()}`)
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.bestSeller.providerId).toBe('p1');
        });

        it('should return 404 if request not found', async () => {
            mockCollection.findOne.mockResolvedValue(null);

            const response = await request(app)
                .get(`/api/find-seller/${new ObjectId().toString()}`)
                .expect(404);

            expect(response.body.error).toBe('Energy request not found');
        });

        it('should return 400 if requestId is invalid', async () => {
            const response = await request(app)
                .get('/api/find-seller/invalid-id')
                .expect(400);

            expect(response.body.error).toBe('Invalid Request ID format');
        });
    });

    describe('POST /gift', () => {
        it('should initiate an energy gift successfully', async () => {
            const requestId = new ObjectId();
            const mockRequestData = {
                _id: requestId,
                userId: new ObjectId(),
                requiredEnergy: 50,
                status: 'PENDING'
            };
            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { consumptionProfile: { id: 'gifter-did' } } }) // user profile
                .mockResolvedValueOnce(mockRequestData); // energy request

            mockedDiscoverBestSeller.mockResolvedValue({ sellerId: 'seller-did', price: 7.5, offer: {} });
            mockedExecuteTransaction.mockResolvedValue({ success: true, transactionId: 'txn-123', status: 'INITIATED', amount: 375 });

            const response = await request(app)
                .post('/api/gift')
                .send({ requestId: requestId.toString() })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.transactionId).toBe('txn-123');
            expect(mockCollection.updateOne).toHaveBeenCalledWith(
                expect.any(Object),
                expect.objectContaining({ $set: expect.objectContaining({ status: 'PAYMENT_PENDING' }) })
            );
        });

        it('should return 404 if no seller found', async () => {
            const requestId = new ObjectId();
            mockCollection.findOne
                .mockResolvedValueOnce({})
                .mockResolvedValueOnce({ _id: requestId, status: 'PENDING', userId: new ObjectId(), requiredEnergy: 10 });

            mockedDiscoverBestSeller.mockResolvedValue(null);

            const response = await request(app)
                .post('/api/gift')
                .send({ requestId: requestId.toString() })
                .expect(404);

            expect(response.body.error).toBe('No suitable energy seller found');
        });
    });

    describe('POST /donate', () => {
        it('should fulfill an energy donation successfully', async () => {
            const requestId = new ObjectId();
            const mockRequestData = {
                _id: requestId,
                userId: new ObjectId(),
                requiredEnergy: 50,
                status: 'PENDING'
            };
            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { generationProfile: { id: 'seller-did' } } }) // seller profile
                .mockResolvedValueOnce(mockRequestData); // energy request

            mockedExecuteTransaction.mockResolvedValue({ success: true, transactionId: 'txn-456', status: 'CONFIRMED', amount: 0 });

            const response = await request(app)
                .post('/api/donate')
                .send({ requestId: requestId.toString() })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.transactionId).toBe('txn-456');
            expect(mockCollection.updateOne).toHaveBeenCalledWith(
                expect.any(Object),
                expect.objectContaining({ $set: expect.objectContaining({ status: 'FULFILLED' }) })
            );
        });

        it('should return 400 if user has no valid seller ID', async () => {
            mockCollection.findOne.mockResolvedValueOnce({ profiles: {} }); // No seller ID

            const response = await request(app)
                .post('/api/donate')
                .send({ requestId: new ObjectId().toString() })
                .expect(400);

            expect(response.body.error).toContain('valid seller/provider ID');
        });
    });
});
