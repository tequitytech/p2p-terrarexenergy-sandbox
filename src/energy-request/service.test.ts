/**
 * Tests for energy-request/service.ts
 * 
 * Covers:
 * - executeDirectTransaction: full transaction flow (publish, select, init, confirm)
 * - discoverBestSeller: find best offer from catalogs
 */

import axios from 'axios';
import { executeDirectTransaction, discoverBestSeller } from './service';

// Mock dependencies
jest.mock('axios');
jest.mock('../bidding/services/market-analyzer', () => ({
    buildDiscoverRequest: jest.fn().mockReturnValue({ context: {}, message: {} })
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('energy-request/service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('executeDirectTransaction', () => {
        const mockAuthToken = 'Bearer test-token';
        const mockBuyerId = 'buyer-123';
        const mockSellerId = 'seller-456';
        const mockQuantity = 50;
        const mockPrice = 7.5;

        // Helper to create mock responses
        const createPublishResponse = () => ({
            data: {
                item_id: 'item-001',
                offer_id: 'offer-001',
                catalog_id: 'catalog-001',
                prosumer: { meterId: 'MTR-SELLER-001' }
            }
        });

        const createSelectResponse = () => ({
            data: {
                message: {
                    order: {
                        'beckn:id': 'order-001',
                        'beckn:orderStatus': 'SELECTED'
                    }
                }
            }
        });

        const createInitResponse = () => ({
            data: {
                message: {
                    order: {
                        'beckn:id': 'order-001',
                        'beckn:orderStatus': 'INITIATED'
                    }
                }
            }
        });

        const createConfirmResponse = () => ({
            data: {
                message: {
                    order: {
                        'beckn:id': 'order-001',
                        'beckn:orderStatus': 'CONFIRMED'
                    }
                }
            }
        });

        it('should execute a complete direct transaction flow with confirm', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())  // publish
                .mockResolvedValueOnce(createSelectResponse())   // select
                .mockResolvedValueOnce(createInitResponse())     // init
                .mockResolvedValueOnce(createConfirmResponse()); // confirm

            const result = await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                mockPrice,
                mockAuthToken
            );

            expect(result.success).toBe(true);
            expect(result.status).toBe('CONFIRMED');
            expect(result.transactionId).toBeDefined();
            expect(result.amount).toBe(mockPrice * mockQuantity);
            expect(mockedAxios.post).toHaveBeenCalledTimes(4);
        });

        it('should stop at init when autoConfirm is false', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse());

            const result = await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                mockPrice,
                mockAuthToken,
                undefined,
                false  // autoConfirm = false
            );

            expect(result.success).toBe(true);
            expect(result.status).toBe('INITIATED');
            expect(result.message).toBeDefined();
            expect(mockedAxios.post).toHaveBeenCalledTimes(3);
        });

        it('should handle donation flow (price = 0)', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse())
                .mockResolvedValueOnce(createConfirmResponse());

            const result = await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                0,  // pricePerUnit = 0 for donation
                mockAuthToken
            );

            expect(result.success).toBe(true);
            expect(result.amount).toBe(0);
            // Verify publish was called with effective price of 0.01 for donation
            const publishCall = mockedAxios.post.mock.calls[0];
            expect((publishCall[1] as any).price).toBe(0.01);
        });

        it('should throw error when publish fails', async () => {
            mockedAxios.post.mockRejectedValueOnce({
                response: { data: { error: 'Publish failed' } },
                message: 'Request failed'
            });

            await expect(
                executeDirectTransaction(
                    mockBuyerId,
                    mockSellerId,
                    mockQuantity,
                    mockPrice,
                    mockAuthToken
                )
            ).rejects.toBeDefined();
        });

        it('should throw error when select fails', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockRejectedValueOnce({
                    response: { data: { error: 'Select failed' } },
                    message: 'Request failed'
                });

            await expect(
                executeDirectTransaction(
                    mockBuyerId,
                    mockSellerId,
                    mockQuantity,
                    mockPrice,
                    mockAuthToken
                )
            ).rejects.toBeDefined();
        });

        it('should throw error when init fails', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockRejectedValueOnce({
                    response: { data: { error: 'Init failed' } },
                    message: 'Request failed'
                });

            await expect(
                executeDirectTransaction(
                    mockBuyerId,
                    mockSellerId,
                    mockQuantity,
                    mockPrice,
                    mockAuthToken
                )
            ).rejects.toBeDefined();
        });

        it('should throw error when confirm fails', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse())
                .mockRejectedValueOnce({
                    response: { data: { error: 'Confirm failed' } },
                    message: 'Request failed'
                });

            await expect(
                executeDirectTransaction(
                    mockBuyerId,
                    mockSellerId,
                    mockQuantity,
                    mockPrice,
                    mockAuthToken
                )
            ).rejects.toBeDefined();
        });

        it('should set startHour correctly in publish payload', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse())
                .mockResolvedValueOnce(createConfirmResponse());

            const result = await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                mockPrice,
                mockAuthToken
            );

            expect(result.success).toBe(true);
            // Verify publish was called with a valid startHour (0-23)
            const publishCall = mockedAxios.post.mock.calls[0];
            const startHour = (publishCall[1] as any).startHour;
            expect(startHour).toBeGreaterThanOrEqual(0);
            expect(startHour).toBeLessThanOrEqual(23);
        });

        it('should include prosumer meterId in order items', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse())
                .mockResolvedValueOnce(createConfirmResponse());

            await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                mockPrice,
                mockAuthToken
            );

            // Verify select payload has prosumer meterId
            const selectCall = mockedAxios.post.mock.calls[1];
            const selectPayload = selectCall[1] as any;
            const orderItems = selectPayload.message.order['beckn:orderItems'];
            expect(orderItems[0]['beckn:orderItemAttributes'].providerAttributes.meterId).toBe('MTR-SELLER-001');
        });

        it('should handle missing prosumer meterId gracefully', async () => {
            mockedAxios.post
                .mockResolvedValueOnce({
                    data: {
                        item_id: 'item-001',
                        offer_id: 'offer-001',
                        catalog_id: 'catalog-001',
                        prosumer: null  // No prosumer data
                    }
                })
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse())
                .mockResolvedValueOnce(createConfirmResponse());

            const result = await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                mockPrice,
                mockAuthToken
            );

            expect(result.success).toBe(true);
            // Verify fallback to 'MTR-UNKNOWN'
            const selectCall = mockedAxios.post.mock.calls[1];
            const selectPayload = selectCall[1] as any;
            const orderItems = selectPayload.message.order['beckn:orderItems'];
            expect(orderItems[0]['beckn:orderItemAttributes'].providerAttributes.meterId).toBe('MTR-UNKNOWN');
        });

        it('should return orderId from confirm response', async () => {
            mockedAxios.post
                .mockResolvedValueOnce(createPublishResponse())
                .mockResolvedValueOnce(createSelectResponse())
                .mockResolvedValueOnce(createInitResponse())
                .mockResolvedValueOnce(createConfirmResponse());

            const result = await executeDirectTransaction(
                mockBuyerId,
                mockSellerId,
                mockQuantity,
                mockPrice,
                mockAuthToken
            );

            expect(result.orderId).toBe('order-001');
        });
    });

    describe('discoverBestSeller', () => {
        it('should find the best seller from catalogs sorted by price', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:descriptor': { name: 'Seller A' },
                                'beckn:provider': { id: 'seller-a' },
                                'beckn:bppId': 'bpp-a',
                                'beckn:items': [{ 'beckn:id': 'item-a' }],
                                'beckn:offers': [{
                                    'beckn:id': 'offer-a',
                                    'beckn:price': { 'schema:price': 10 }
                                }]
                            },
                            {
                                'beckn:descriptor': { name: 'Seller B' },
                                'beckn:provider': { id: 'seller-b' },
                                'beckn:bppId': 'bpp-b',
                                'beckn:items': [{ 'beckn:id': 'item-b' }],
                                'beckn:offers': [{
                                    'beckn:id': 'offer-b',
                                    'beckn:price': { 'schema:price': 5 }  // Cheaper
                                }]
                            }
                        ]
                    }
                }
            });

            const result = await discoverBestSeller(50);

            expect(result).not.toBeNull();
            expect(result?.sellerId).toBe('seller-b');  // Should pick cheaper seller
            expect(result?.price).toBe(5);
        });

        it('should return null when no catalogs found', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: []
                    }
                }
            });

            const result = await discoverBestSeller(50);

            expect(result).toBeNull();
        });

        it('should return null when no offers found in catalogs', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [{
                            'beckn:descriptor': { name: 'Seller' },
                            'beckn:provider': { id: 'seller-1' }
                            // No beckn:offers
                        }]
                    }
                }
            });

            const result = await discoverBestSeller(50);

            expect(result).toBeNull();
        });

        it('should return null when discovery API fails', async () => {
            mockedAxios.post.mockRejectedValue(new Error('Network error'));

            const result = await discoverBestSeller(50);

            expect(result).toBeNull();
        });

        it('should include auth token when provided', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [{
                            'beckn:provider': { id: 'seller-1' },
                            'beckn:offers': [{
                                'beckn:price': { 'schema:price': 5 }
                            }]
                        }]
                    }
                }
            });

            await discoverBestSeller(50, 'Bearer auth-token');

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Object),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer auth-token'
                    })
                })
            );
        });

        it('should handle offers with offerAttributes price format', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [{
                            'beckn:provider': { id: 'seller-1' },
                            'beckn:bppId': 'bpp-1',
                            'beckn:items': [],
                            'beckn:offers': [{
                                'beckn:offerAttributes': {
                                    'beckn:price': { value: 8.5 }
                                }
                            }]
                        }]
                    }
                }
            });

            const result = await discoverBestSeller(50);

            expect(result?.price).toBe(8.5);
        });

        it('should use bppId as sellerId fallback when provider is missing', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [{
                            'beckn:bppId': 'bpp-fallback',
                            'beckn:items': [],
                            'beckn:offers': [{
                                'beckn:price': { 'schema:price': 7 }
                            }]
                        }]
                    }
                }
            });

            const result = await discoverBestSeller(50);

            expect(result?.sellerId).toBe('bpp-fallback');
        });

        it('should handle missing price by using MAX_VALUE for sorting', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:provider': { id: 'seller-no-price' },
                                'beckn:offers': [{}]  // No price
                            },
                            {
                                'beckn:provider': { id: 'seller-with-price' },
                                'beckn:offers': [{
                                    'beckn:price': { 'schema:price': 5 }
                                }]
                            }
                        ]
                    }
                }
            });

            const result = await discoverBestSeller(50);

            // Should pick seller with price (not the one with MAX_VALUE)
            expect(result?.sellerId).toBe('seller-with-price');
        });

        it('should attach catalog context to each offer', async () => {
            mockedAxios.post.mockResolvedValue({
                data: {
                    message: {
                        catalogs: [{
                            'beckn:descriptor': { name: 'Test Catalog' },
                            'beckn:provider': { id: 'provider-1' },
                            'beckn:bppId': 'bpp-1',
                            'beckn:items': [{ 'beckn:id': 'item-1' }],
                            'beckn:offers': [{
                                'beckn:id': 'offer-1',
                                'beckn:price': { 'schema:price': 5 }
                            }]
                        }]
                    }
                }
            });

            const result = await discoverBestSeller(50);

            expect(result?.offer._catalog).toBeDefined();
            expect(result?.offer._catalog['beckn:descriptor'].name).toBe('Test Catalog');
        });
    });
});
