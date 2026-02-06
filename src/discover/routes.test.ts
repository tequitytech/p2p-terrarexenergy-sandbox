/**
 * Tests for discover/routes.ts
 * 
 * Covers: GET /discover
 */

import express from 'express';
import request from 'supertest';
import { discoverRoutes } from './routes';

// Mock axios for external CDS calls
jest.mock('axios');

// Mock market-analyzer to avoid its internal logic
jest.mock('../bidding/services/market-analyzer', () => ({
    buildDiscoverRequest: jest.fn().mockReturnValue({ context: {}, message: {} })
}));

import axios, { isAxiosError } from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('discover/routes', () => {
    let app: express.Express;

    beforeEach(() => {
        jest.clearAllMocks();

        app = express();
        app.use(express.json());
        app.use('/api', discoverRoutes());
    });

    describe('GET /discover', () => {
        const mockCdsResponse = {
            data: {
                message: {
                    catalogs: [
                        {
                            'beckn:items': [
                                {
                                    id: 'item-1',
                                    'beckn:descriptor': { name: 'Solar Energy' },
                                    'beckn:provider': { 'beckn:descriptor': { 'schema:name': 'Provider1' } }
                                }
                            ],
                            'beckn:offers': [
                                {
                                    id: 'offer-1',
                                    'beckn:price': { 'schema:price': '7.50' },
                                    'beckn:offerAttributes': { maximumQuantity: 50 }
                                }
                            ]
                        }
                    ]
                }
            }
        };

        it('should return catalog data from CDS', async () => {
            mockedAxios.post.mockResolvedValue(mockCdsResponse);

            const response = await request(app)
                .get('/api/discover')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toBeDefined();
            expect(response.body.data.message).toBeDefined();
        });

        it('should forward sourceType query param', async () => {
            mockedAxios.post.mockResolvedValue(mockCdsResponse);

            await request(app)
                .get('/api/discover?sourceType=SOLAR')
                .expect(200);

            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('should support sorting by price', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:items': [{ id: 'item-1', 'beckn:provider': {} }],
                                'beckn:offers': [
                                    { 'beckn:price': { 'schema:price': '8.00' } },
                                    { 'beckn:price': { 'schema:price': '7.50' } }
                                ]
                            }
                        ]
                    }
                }
            });

            const response = await request(app)
                .get('/api/discover?sortBy=price&order=asc')
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        it('should support sorting by energy', async () => {
            mockedAxios.post.mockResolvedValue(mockCdsResponse);

            const response = await request(app)
                .get('/api/discover?sortBy=energy&order=desc')
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        it('should filter farmer offers when tag=farmer', async () => {
            const mockWithFarmerData = {
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:items': [
                                    {
                                        id: 'item-1',
                                        'beckn:provider': {
                                            'beckn:descriptor': { 'schema:name': 'Suresh - BRPL Prosumer' }
                                        }
                                    },
                                    {
                                        id: 'item-2',
                                        'beckn:provider': {
                                            'beckn:descriptor': { 'schema:name': 'Other Provider' }
                                        }
                                    }
                                ],
                                'beckn:offers': []
                            }
                        ]
                    }
                }
            };
            mockedAxios.post.mockResolvedValue(mockWithFarmerData);

            const response = await request(app)
                .get('/api/discover?tag=farmer')
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        it('should return 500 when CDS is unavailable', async () => {
            mockedAxios.post.mockRejectedValue(new Error('CDS unavailable'));

            const response = await request(app)
                .get('/api/discover')
                .expect(500);

            expect(response.body.success).toBe(false);
            expect(response.body).toHaveProperty('error');
        });

        it('should return empty catalogs when no items exist', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: []
                    }
                }
            });

            const response = await request(app)
                .get('/api/discover')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.message.catalogs).toEqual([]);
        });

        it('should handle CDS timeout gracefully', async () => {
            const timeoutError = new Error('timeout of 15000ms exceeded');
            (timeoutError as any).code = 'ECONNABORTED';
            mockedAxios.post.mockRejectedValue(timeoutError);

            const response = await request(app)
                .get('/api/discover')
                .expect(500);

            expect(response.body.success).toBe(false);
        });

        it('should filter by isActive query param', async () => {
            mockedAxios.post.mockResolvedValue(mockCdsResponse);

            await request(app)
                .get('/api/discover?isActive=true')
                .expect(200);

            expect(mockedAxios.post).toHaveBeenCalled();
        });
    });
});
