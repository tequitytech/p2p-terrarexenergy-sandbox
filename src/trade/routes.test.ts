/**
 * Tests for trade/routes.ts
 * 
 * Covers: 
 * - POST /publish
 * - GET /inventory, /items, /offers
 * - GET /forecast
 * - GET /settlements, /settlements/stats, /settlements/:transactionId
 * - POST /settlements/poll, /settlements/:transactionId/refresh
 * - GET /earnings, /published-items
 */

import express from 'express';
import request from 'supertest';
import { tradeRoutes } from './routes';
import { ObjectId } from 'mongodb';
import * as fs from 'fs';

// Mock dependencies
jest.mock('../db', () => ({
    getDB: jest.fn()
}));

jest.mock('../services/catalog-store', () => ({
    catalogStore: {
        saveCatalog: jest.fn(),
        saveItem: jest.fn(),
        saveOffer: jest.fn(),
        getInventory: jest.fn(),
        getAllItems: jest.fn(),
        getAllOffers: jest.fn(),
        getSellerEarnings: jest.fn(),
        getPublishedItems: jest.fn()
    }
}));

jest.mock('../services/ledger-client', () => ({
    ledgerClient: {
        getLedgerHealth: jest.fn(),
        LEDGER_URL: 'http://test-ledger'
    }
}));

jest.mock('../services/settlement-poller', () => ({
    getPollingStatus: jest.fn(),
    pollOnce: jest.fn(),
    refreshSettlement: jest.fn()
}));

jest.mock('../services/settlement-store', () => ({
    settlementStore: {
        getSettlements: jest.fn(),
        getStats: jest.fn(),
        getSettlement: jest.fn()
    }
}));

jest.mock('axios');
jest.mock('fs');

jest.mock('../auth/routes', () => ({
    authMiddleware: jest.fn((req, res, next) => {
        req.user = { phone: '9876543210', userId: new ObjectId().toString() };
        next();
    })
}));

import { getDB } from '../db';
import { catalogStore } from '../services/catalog-store';
import { ledgerClient } from '../services/ledger-client';
import { pollOnce, refreshSettlement, getPollingStatus } from '../services/settlement-poller';
import { settlementStore } from '../services/settlement-store';
import axios from 'axios';
import { authMiddleware } from '../auth/routes';

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFS = fs as jest.Mocked<typeof fs>;

describe('trade/routes', () => {
    let app: express.Express;
    let mockDb: any;
    let mockUsersCollection: any;
    let mockPublishRecordsCollection: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockUsersCollection = {
            findOne: jest.fn()
        };
        mockPublishRecordsCollection = {
            insertOne: jest.fn()
        };

        mockDb = {
            collection: jest.fn((name) => {
                if (name === 'users') return mockUsersCollection;
                if (name === 'publish_records') return mockPublishRecordsCollection;
                return {};
            })
        };

        mockedGetDB.mockReturnValue(mockDb);

        app = express();
        app.use(express.json());
        app.use('/api', tradeRoutes());
    });

    describe('POST /publish', () => {
        const validPayload = {
            quantity: 100,
            price: 7.5,
            deliveryDate: '2026-02-10',
            startHour: 14,
            duration: 2,
            sourceType: 'SOLAR'
        };

        it('should publish catalog successfully', async () => {
            const mockUser = {
                _id: new ObjectId(),
                name: 'Prosumer 1',
                phone: '9876543210',
                profiles: {
                    generationProfile: {
                        did: 'did:beckn:123',
                        meterNumber: 'METER-001',
                        utilityId: 'BESCOM',
                        consumerNumber: 'C123'
                    }
                }
            };
            mockUsersCollection.findOne.mockResolvedValue(mockUser);
            mockedAxios.post.mockResolvedValue({ data: { success: true } });

            const response = await request(app)
                .post('/api/publish')
                .send(validPayload)
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(catalogStore.saveCatalog).toHaveBeenCalled();
            expect(mockPublishRecordsCollection.insertOne).toHaveBeenCalled();
        });

        it('should return 400 for invalid payload', async () => {
            const response = await request(app)
                .post('/api/publish')
                .send({ price: -10 }) // Invalid price
                .expect(400);

            expect(response.body.error).toBe('VALIDATION_ERROR');
        });

        it('should return 403 if user is not a prosumer', async () => {
            mockUsersCollection.findOne.mockResolvedValue({ _id: new ObjectId(), name: 'Consumer' });

            const response = await request(app)
                .post('/api/publish')
                .send(validPayload)
                .expect(403);

            expect(response.body.error).toBe('NOT_PROSUMER');
        });

        it('should swallow ONIX forwarding error and return success', async () => {
            mockUsersCollection.findOne.mockResolvedValue({
                name: 'Prosumer',
                profiles: { generationProfile: { did: 'd', meterNumber: 'm', utilityId: 'u', consumerNumber: 'c' } }
            });
            mockedAxios.post.mockRejectedValue(new Error('Connection failed'));

            const response = await request(app)
                .post('/api/publish')
                .send(validPayload)
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.onix_forwarded).toBe(false);
        });
    });

    describe('GET /inventory, /items, /offers', () => {
        it('should return inventory', async () => {
            (catalogStore.getInventory as jest.Mock).mockResolvedValue([{ id: '1' }]);
            const response = await request(app).get('/api/inventory').expect(200);
            expect(response.body.items).toHaveLength(1);
        });

        it('should return all items', async () => {
            (catalogStore.getAllItems as jest.Mock).mockResolvedValue([{ id: '2' }]);
            const response = await request(app).get('/api/items').expect(200);
            expect(response.body.items).toHaveLength(1);
        });

        it('should return all offers', async () => {
            (catalogStore.getAllOffers as jest.Mock).mockResolvedValue([{ id: '3' }]);
            const response = await request(app).get('/api/offers').expect(200);
            expect(response.body.offers).toHaveLength(1);
        });
    });

    describe('GET /forecast', () => {
        it('should return forecast data from file', async () => {
            mockedFS.existsSync.mockReturnValue(true);
            mockedFS.readFileSync.mockReturnValue(JSON.stringify({ data: [1, 2, 3] }));

            const response = await request(app).get('/api/forecast').expect(200);
            expect(response.body.data).toHaveLength(3);
        });

        it('should return 404 if file missing', async () => {
            mockedFS.existsSync.mockReturnValue(false);
            const response = await request(app).get('/api/forecast').expect(404);
            expect(response.body.error).toBeDefined();
        });
    });

    describe('Settlement Endpoints', () => {
        it('GET /settlements should return list and stats', async () => {
            (settlementStore.getSettlements as jest.Mock).mockResolvedValue([]);
            (settlementStore.getStats as jest.Mock).mockResolvedValue({ total: 0 });
            (getPollingStatus as jest.Mock).mockReturnValue({});

            const response = await request(app).get('/api/settlements').expect(200);
            expect(response.body.settlements).toBeDefined();
            expect(response.body.stats).toBeDefined();
        });

        it('GET /settlements/stats should return ledger health', async () => {
            (ledgerClient.getLedgerHealth as jest.Mock).mockResolvedValue({ status: 'UP' });
            const response = await request(app).get('/api/settlements/stats').expect(200);
            expect(response.body.ledger.status).toBe('UP');
        });

        it('POST /settlements/poll should trigger manual poll', async () => {
            (pollOnce as jest.Mock).mockResolvedValue({ processed: 5 });
            const response = await request(app).post('/api/settlements/poll').expect(200);
            expect(response.body.success).toBe(true);
            expect(response.body.result.processed).toBe(5);
        });

        it('POST /settlements/:id/refresh should refresh settlement', async () => {
            (refreshSettlement as jest.Mock).mockResolvedValue({ transactionId: 'txn-1' });
            const response = await request(app).post('/api/settlements/txn-1/refresh').expect(200);
            expect(response.body.success).toBe(true);
            expect(response.body.settlement.transactionId).toBe('txn-1');
        });
    });

    describe('GET /earnings and /published-items', () => {
        it('GET /earnings should return seller earnings', async () => {
            (catalogStore.getSellerEarnings as jest.Mock).mockResolvedValue(550.5);
            const response = await request(app).get('/api/earnings?sellerId=s1').expect(200);
            expect(response.body.earnings).toBe(550.5);
            expect(response.body.sellerId).toBe('s1');
        });

        it('GET /published-items should return user items', async () => {
            (catalogStore.getPublishedItems as jest.Mock).mockResolvedValue([{ id: 'p1' }]);
            const response = await request(app).get('/api/published-items').expect(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveLength(1);
        });
    });
});
