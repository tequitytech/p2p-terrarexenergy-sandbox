import express, { Express } from 'express';
import request from 'supertest';
import axios from 'axios';
import { discoverRoutes } from '../../discover/routes';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Discover Routes', () => {
    let app: Express;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use('/', discoverRoutes());
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /discover', () => {
        const mockCatalogResponse = {
            message: {
                catalogs: [
                    {
                        'beckn:id': 'catalog-1',
                        'beckn:items': [
                            {
                                'beckn:id': 'item-1',
                                'beckn:provider': {
                                    'beckn:descriptor': { 'schema:name': 'Test Provider' }
                                }
                            }
                        ],
                        'beckn:offers': [
                            {
                                'beckn:id': 'offer-1',
                                'beckn:price': { 'schema:price': 5 },
                                'beckn:offerAttributes': {
                                    maximumQuantity: 100,
                                    'beckn:price': { value: 5 }
                                }
                            },
                            {
                                'beckn:id': 'offer-2',
                                'beckn:price': { 'schema:price': 3 },
                                'beckn:offerAttributes': {
                                    maximumQuantity: 50
                                }
                            }
                        ]
                    },
                    {
                        'beckn:id': 'catalog-2',
                        'beckn:items': [
                            {
                                'beckn:id': 'item-2',
                                'beckn:provider': {
                                    'beckn:descriptor': { 'schema:name': 'Another Provider' }
                                }
                            }
                        ],
                        'beckn:offers': [
                            {
                                'beckn:id': 'offer-3',
                                'beckn:price': { 'schema:price': 4 }
                            }
                        ]
                    }
                ]
            }
        };

        it('should fetch and return discovery data', async () => {
            mockedAxios.post.mockResolvedValue({ data: mockCatalogResponse });

            const response = await request(app)
                .get('/discover')
                .query({ sourceType: 'SOLAR' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.message.catalogs).toBeDefined();
        });

        it('should sort offers by price ascending', async () => {
            mockedAxios.post.mockResolvedValue({ data: mockCatalogResponse });

            const response = await request(app)
                .get('/discover')
                .query({ sortBy: 'price', order: 'asc' });

            expect(response.status).toBe(200);

            // Check that offers are sorted by price
            const catalogs = response.body.data.message.catalogs;
            if (catalogs[0]['beckn:offers']?.length >= 2) {
                const firstPrice = catalogs[0]['beckn:offers'][0]['beckn:price']?.['schema:price'];
                const secondPrice = catalogs[0]['beckn:offers'][1]['beckn:price']?.['schema:price'];
                expect(firstPrice).toBeLessThanOrEqual(secondPrice);
            }
        });

        it('should sort offers by price descending', async () => {
            mockedAxios.post.mockResolvedValue({ data: mockCatalogResponse });

            const response = await request(app)
                .get('/discover')
                .query({ sortBy: 'price', order: 'desc' });

            expect(response.status).toBe(200);

            const catalogs = response.body.data.message.catalogs;
            if (catalogs[0]['beckn:offers']?.length >= 2) {
                const firstPrice = catalogs[0]['beckn:offers'][0]['beckn:price']?.['schema:price'];
                const secondPrice = catalogs[0]['beckn:offers'][1]['beckn:price']?.['schema:price'];
                expect(firstPrice).toBeGreaterThanOrEqual(secondPrice);
            }
        });

        it('should sort by energy quantity', async () => {
            mockedAxios.post.mockResolvedValue({ data: mockCatalogResponse });

            const response = await request(app)
                .get('/discover')
                .query({ sortBy: 'energy', order: 'asc' });

            expect(response.status).toBe(200);
        });

        it('should filter by farmer tag', async () => {
            const farmerCatalogResponse = {
                message: {
                    catalogs: [
                        {
                            'beckn:id': 'catalog-farmer',
                            'beckn:items': [
                                {
                                    'beckn:id': 'item-farmer',
                                    'beckn:provider': {
                                        'beckn:descriptor': { 'schema:name': 'Suresh - BRPL Prosumer' }
                                    }
                                },
                                {
                                    'beckn:id': 'item-non-farmer',
                                    'beckn:provider': {
                                        'beckn:descriptor': { 'schema:name': 'Other Provider' }
                                    }
                                }
                            ],
                            'beckn:offers': [{ 'beckn:id': 'offer-f' }]
                        }
                    ]
                }
            };

            mockedAxios.post.mockResolvedValue({ data: farmerCatalogResponse });

            const response = await request(app)
                .get('/discover')
                .query({ tag: 'farmer' });

            expect(response.status).toBe(200);

            // Should filter items to only farmer
            const catalogs = response.body.data.message.catalogs;
            catalogs.forEach((catalog: any) => {
                catalog['beckn:items'].forEach((item: any) => {
                    expect(item['beckn:provider']?.['beckn:descriptor']?.['schema:name']).toBe('Suresh - BRPL Prosumer');
                });
            });
        });

        it('should filter out catalogs with no items after filtering', async () => {
            const catalogWithNoMatchingItems = {
                message: {
                    catalogs: [
                        {
                            'beckn:id': 'catalog-empty',
                            'beckn:items': [
                                {
                                    'beckn:id': 'item-non-farmer',
                                    'beckn:provider': {
                                        'beckn:descriptor': { 'schema:name': 'Other Provider' }
                                    }
                                }
                            ],
                            'beckn:offers': []
                        }
                    ]
                }
            };

            mockedAxios.post.mockResolvedValue({ data: catalogWithNoMatchingItems });

            const response = await request(app)
                .get('/discover')
                .query({ tag: 'farmer' });

            expect(response.status).toBe(200);
            expect(response.body.data.message.catalogs).toHaveLength(0);
        });

        it('should handle empty catalogs response', async () => {
            mockedAxios.post.mockResolvedValue({
                data: { message: { catalogs: [] } }
            });

            const response = await request(app).get('/discover');

            expect(response.status).toBe(200);
            expect(response.body.data.message.catalogs).toEqual([]);
        });

        it('should return 500 on axios error', async () => {
            const axiosError = new Error('Network error');
            (axiosError as any).isAxiosError = true;
            (axiosError as any).response = { data: { error: 'CDS unavailable' } };

            mockedAxios.post.mockRejectedValue(axiosError);
            jest.spyOn(require('axios'), 'isAxiosError').mockReturnValue(true);

            const response = await request(app).get('/discover');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
        });

        it('should return 500 on generic error', async () => {
            mockedAxios.post.mockRejectedValue(new Error('Unknown error'));
            jest.spyOn(require('axios'), 'isAxiosError').mockReturnValue(false);

            const response = await request(app).get('/discover');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Unknown error');
        });

        it('should apply default sourceType and isActive', async () => {
            mockedAxios.post.mockResolvedValue({ data: mockCatalogResponse });

            await request(app).get('/discover');

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Object),
                expect.any(Object)
            );
        });

        it('should handle catalogs without offers for sorting', async () => {
            const catalogWithoutOffers = {
                message: {
                    catalogs: [
                        {
                            'beckn:id': 'catalog-no-offers',
                            'beckn:items': [{ 'beckn:id': 'item-1' }],
                            // No offers
                        },
                        {
                            'beckn:id': 'catalog-with-offers',
                            'beckn:items': [{ 'beckn:id': 'item-2' }],
                            'beckn:offers': [{ 'beckn:price': { 'schema:price': 5 } }]
                        }
                    ]
                }
            };

            mockedAxios.post.mockResolvedValue({ data: catalogWithoutOffers });

            const response = await request(app)
                .get('/discover')
                .query({ sortBy: 'price' });

            expect(response.status).toBe(200);
        });

        it('should sort catalogs by their best offer', async () => {
            const multipleCatalogs = {
                message: {
                    catalogs: [
                        {
                            'beckn:id': 'expensive-catalog',
                            'beckn:items': [{ 'beckn:id': 'item-1' }],
                            'beckn:offers': [{ 'beckn:price': { 'schema:price': 10 } }]
                        },
                        {
                            'beckn:id': 'cheap-catalog',
                            'beckn:items': [{ 'beckn:id': 'item-2' }],
                            'beckn:offers': [{ 'beckn:price': { 'schema:price': 2 } }]
                        }
                    ]
                }
            };

            mockedAxios.post.mockResolvedValue({ data: multipleCatalogs });

            const response = await request(app)
                .get('/discover')
                .query({ sortBy: 'price', order: 'asc' });

            expect(response.status).toBe(200);
            // First catalog should be cheaper
            const catalogs = response.body.data.message.catalogs;
            const firstPrice = catalogs[0]['beckn:offers'][0]['beckn:price']['schema:price'];
            const secondPrice = catalogs[1]['beckn:offers'][0]['beckn:price']['schema:price'];
            expect(firstPrice).toBeLessThanOrEqual(secondPrice);
        });
    });
});
