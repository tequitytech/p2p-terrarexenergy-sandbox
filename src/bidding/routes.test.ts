/**
 * Tests for bidding/routes.ts
 * 
 * Covers: 
 * - POST /api/bid/preview
 * - POST /api/bid/confirm
 */

import express from 'express';
import request from 'supertest';
import { biddingRoutes } from './routes';

// Mock the services
jest.mock('./services/bid-optimizer', () => ({
    preview: jest.fn(),
    confirm: jest.fn()
}));

import { preview, confirm } from './services/bid-optimizer';

const mockedPreview = preview as jest.MockedFunction<typeof preview>;
const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;

describe('bidding/routes', () => {
    let app: express.Express;

    beforeEach(() => {
        jest.clearAllMocks();

        app = express();
        app.use(express.json());
        app.use('/api', biddingRoutes());
    });

    describe('POST /api/bid/preview', () => {
        const validPayload = {
            provider_id: 'did:p1',
            meter_id: 'M1',
            source_type: 'SOLAR'
        };

        it('should return preview successfully', async () => {
            const mockResult = {
                strategy: 'OPTIMIZED',
                bids: [{ date: '2026-02-10', price: 7.5 }]
            };
            mockedPreview.mockResolvedValue(mockResult as any);

            const response = await request(app)
                .post('/api/bid/preview')
                .send(validPayload)
                .expect(200);

            expect(response.body).toEqual(mockResult);
            expect(mockedPreview).toHaveBeenCalledWith(validPayload);
        });

        it('should return 400 for missing fields', async () => {
            const response = await request(app)
                .post('/api/bid/preview')
                .send({ provider_id: 'did:p1' })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('meter_id');
        });

        it('should return 400 for invalid source_type', async () => {
            const response = await request(app)
                .post('/api/bid/preview')
                .send({ ...validPayload, source_type: 'GEOTHERMAL' })
                .expect(400);

            expect(response.body.error).toContain('must be SOLAR, WIND, or BATTERY');
        });

        it('should return 500 for service error', async () => {
            mockedPreview.mockRejectedValue(new Error('Optimizer engine down'));

            const response = await request(app)
                .post('/api/bid/preview')
                .send(validPayload)
                .expect(500);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Optimizer engine down');
        });
    });

    describe('POST /api/bid/confirm', () => {
        const validPayload = {
            provider_id: 'did:p1',
            meter_id: 'M1',
            source_type: 'SOLAR',
            max_bids: 5
        };

        it('should confirm bids successfully', async () => {
            const mockResult = {
                success: true,
                count: 5,
                bids: ['bid-1', 'bid-2']
            };
            mockedConfirm.mockResolvedValue(mockResult as any);

            const response = await request(app)
                .post('/api/bid/confirm')
                .send(validPayload)
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(mockedConfirm).toHaveBeenCalledWith({
                provider_id: 'did:p1',
                meter_id: 'M1',
                source_type: 'SOLAR'
            }, 5);
        });

        it('should handle confirm without max_bids', async () => {
            mockedConfirm.mockResolvedValue({ success: true } as any);

            await request(app)
                .post('/api/bid/confirm')
                .send({ provider_id: 'd', meter_id: 'm', source_type: 'SOLAR' })
                .expect(200);

            expect(mockedConfirm).toHaveBeenCalledWith(expect.anything(), undefined);
        });

        it('should return 400 for validation errors', async () => {
            const response = await request(app)
                .post('/api/bid/confirm')
                .send({})
                .expect(400);

            expect(response.body.success).toBe(false);
        });
    });
});
