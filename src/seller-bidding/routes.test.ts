/**
 * Tests for seller-bidding/routes.ts
 * 
 * Covers:
 * - POST /api/seller/preview
 * - POST /api/seller/confirm
 */

import express from 'express';
import request from 'supertest';
import { sellerBiddingRoutes } from './routes';

// Mock the services
jest.mock('./services/hourly-optimizer', () => ({
    preview: jest.fn(),
    confirm: jest.fn()
}));

jest.mock('../db', () => ({
    getDB: jest.fn()
}));

jest.mock('../auth/routes', () => ({
    authMiddleware: jest.fn((req, res, next) => {
        req.user = { phone: '9876543210', userId: 'user-1' };
        req.headers.authorization = 'Bearer test-token';
        next();
    })
}));

import { preview, confirm } from './services/hourly-optimizer';
import { getDB } from '../db';
import { authMiddleware } from '../auth/routes';

const mockedPreview = preview as jest.MockedFunction<typeof preview>;
const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;

describe('seller-bidding/routes', () => {
    let app: express.Express;
    let mockCollection: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockCollection = {
            findOne: jest.fn()
        };

        mockedGetDB.mockReturnValue({
            collection: jest.fn().mockReturnValue(mockCollection)
        } as any);

        app = express();
        app.use(express.json());
        app.use('/api', sellerBiddingRoutes());
    });

    describe('POST /api/seller/preview', () => {
        const validPayload = { source_type: 'SOLAR' };

        it('should return 200 with preview results for prosumer', async () => {
            const mockUser = {
                phone: '9876543210',
                profiles: {
                    generationProfile: { did: 'did:seller', meterNumber: 'M-789' }
                }
            };
            mockCollection.findOne.mockResolvedValue(mockUser);

            const mockResult = {
                bids: [{ hour: 10, price: 8.5 }]
            };
            mockedPreview.mockResolvedValue(mockResult as any);

            const response = await request(app)
                .post('/api/seller/preview')
                .send(validPayload)
                .expect(200);

            expect(response.body).toEqual(mockResult);
            expect(mockedPreview).toHaveBeenCalledWith({
                provider_id: 'did:seller',
                meter_id: 'M-789',
                source_type: 'SOLAR'
            });
        });

        it('should return 400 for invalid source_type', async () => {
            const response = await request(app)
                .post('/api/seller/preview')
                .send({ source_type: 'COAL' })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('must be SOLAR, WIND, or BATTERY');
        });

        it('should return 500 if user profile not found', async () => {
            mockCollection.findOne.mockResolvedValue(null);

            const response = await request(app)
                .post('/api/seller/preview')
                .send(validPayload)
                .expect(500);

            expect(response.body.error).toBe('User profile not found');
        });

        it('should return 500 if not a prosumer', async () => {
            mockCollection.findOne.mockResolvedValue({ profiles: {} });

            const response = await request(app)
                .post('/api/seller/preview')
                .send(validPayload)
                .expect(500);

            expect(response.body.error).toContain('generationProfile');
        });
    });

    describe('POST /api/seller/confirm', () => {
        const validPayload = { source_type: 'SOLAR' };

        it('should confirm bids successfully', async () => {
            mockCollection.findOne.mockResolvedValue({
                profiles: { generationProfile: { did: 'did:seller', meterNumber: 'M1' } }
            });

            mockedConfirm.mockResolvedValue({ success: true, count: 2 } as any);

            const response = await request(app)
                .post('/api/seller/confirm')
                .set('Authorization', 'Bearer test-token')
                .send(validPayload)
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(mockedConfirm).toHaveBeenCalledWith({
                provider_id: 'did:seller',
                meter_id: 'M1',
                source_type: 'SOLAR'
            }, 'Bearer test-token');
        });

        it('should return 500 on optimizer error', async () => {
            mockCollection.findOne.mockResolvedValue({
                profiles: { generationProfile: { did: 'd', meterNumber: 'm' } }
            });
            mockedConfirm.mockRejectedValue(new Error('Publish failed'));

            const response = await request(app)
                .post('/api/seller/confirm')
                .send(validPayload)
                .expect(500);

            expect(response.body.error).toBe('Publish failed');
        });
    });
});
