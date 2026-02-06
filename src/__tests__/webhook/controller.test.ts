/**
 * Unit tests for Webhook Controller (src/webhook/controller.ts)
 *
 * Tests all webhook handlers with mocked dependencies.
 * All database, axios, and service calls are mocked.
 */

import { Request, Response } from 'express';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock catalogStore
const mockGetItem = jest.fn();
const mockGetOffer = jest.fn();
const mockGetOffersByItemId = jest.fn();
const mockReduceOfferInventory = jest.fn();
const mockBuildCatalogForPublish = jest.fn();
const mockSaveOrder = jest.fn();
const mockGetOrderByTransactionId = jest.fn();
const mockGetSellerUserIdForItem = jest.fn();

jest.mock('../../services/catalog-store', () => ({
    catalogStore: {
        getItem: (...args: any[]) => mockGetItem(...args),
        getOffer: (...args: any[]) => mockGetOffer(...args),
        getOffersByItemId: (...args: any[]) => mockGetOffersByItemId(...args),
        reduceOfferInventory: (...args: any[]) => mockReduceOfferInventory(...args),
        buildCatalogForPublish: (...args: any[]) => mockBuildCatalogForPublish(...args),
        saveOrder: (...args: any[]) => mockSaveOrder(...args),
        getOrderByTransactionId: (...args: any[]) => mockGetOrderByTransactionId(...args),
        getSellerUserIdForItem: (...args: any[]) => mockGetSellerUserIdForItem(...args),
    }
}));

// Mock settlementStore
const mockCreateSettlement = jest.fn();
const mockGetSettlement = jest.fn();

jest.mock('../../services/settlement-store', () => ({
    settlementStore: {
        createSettlement: (...args: any[]) => mockCreateSettlement(...args),
        getSettlement: (...args: any[]) => mockGetSettlement(...args),
    },
    SettlementDocument: {}
}));

// Mock paymentService
const mockCreateOrder = jest.fn();
const mockCreatePaymentLink = jest.fn();

jest.mock('../../services/payment-service', () => ({
    paymentService: {
        createOrder: (...args: any[]) => mockCreateOrder(...args),
        createPaymentLink: (...args: any[]) => mockCreatePaymentLink(...args),
    }
}));

// Mock getDB
const mockFindOne = jest.fn();
const mockCollection = jest.fn().mockReturnValue({
    findOne: mockFindOne
});

jest.mock('../../db', () => ({
    getDB: () => ({
        collection: mockCollection
    })
}));

// Mock utils
jest.mock('../../utils', () => ({
    parseError: (err: any) => err.message || 'Unknown error',
    readDomainResponse: jest.fn().mockResolvedValue({
        message: { order: { status: 'COMPLETED' } }
    })
}));

// Import after mocking
import {
    onSelect,
    onInit,
    onConfirm,
    onStatus,
    onUpdate,
    onRating,
    onSupport,
    onTrack,
    onCancel,
    triggerOnStatus,
    triggerOnUpdate,
    triggerOnCancel,
    calculateDeliveryProgress,
    validateContext,
    getCallbackUrl
} from '../../webhook/controller';
import { readDomainResponse } from '../../utils';

// Helper to create mock Request/Response
const createMockReq = (body: any): Partial<Request> => ({
    body
});

const createMockRes = (): Partial<Response> => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

// Wait for async operations in handlers
const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 100));

describe('Webhook Controller Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedAxios.post.mockResolvedValue({ data: { success: true } });
    });

    // ==========================================
    // Helper Function Tests
    // ==========================================
    describe('calculateDeliveryProgress', () => {
        it('should calculate 0% progress at start', () => {
            const order = { 'beckn:orderAttributes': { total_quantity: 100 } };
            const confirmedAt = new Date();
            const now = new Date(confirmedAt);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveredQuantity).toBe(0);
            expect(result.isComplete).toBe(false);
            expect(result.deliveryAttributes.deliveryStatus).toBe('IN_PROGRESS');
        });

        it('should calculate 50% progress at 12 hours', () => {
            const order = { 'beckn:orderAttributes': { total_quantity: 100 } };
            const confirmedAt = new Date();
            const now = new Date(confirmedAt.getTime() + 12 * 60 * 60 * 1000);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveredQuantity).toBe(50);
            expect(result.isComplete).toBe(false);
        });

        it('should calculate 100% progress at 24 hours', () => {
            const order = { 'beckn:orderAttributes': { total_quantity: 100 } };
            const confirmedAt = new Date();
            const now = new Date(confirmedAt.getTime() + 24 * 60 * 60 * 1000);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveredQuantity).toBe(100);
            expect(result.isComplete).toBe(true);
            expect(result.deliveryAttributes.deliveryStatus).toBe('COMPLETED');
        });

        it('should cap progress at 100% after 24 hours', () => {
            const order = { 'beckn:orderAttributes': { total_quantity: 100 } };
            const confirmedAt = new Date();
            const now = new Date(confirmedAt.getTime() + 48 * 60 * 60 * 1000);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveredQuantity).toBe(100);
            expect(result.isComplete).toBe(true);
        });

        it('should use orderItems quantity when orderAttributes missing', () => {
            const order = {
                'beckn:orderItems': [
                    { 'beckn:quantity': { unitQuantity: 25 } },
                    { 'beckn:quantity': { unitQuantity: 25 } }
                ]
            };
            const confirmedAt = new Date();
            const now = new Date(confirmedAt.getTime() + 24 * 60 * 60 * 1000);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveredQuantity).toBe(50);
        });

        it('should default to 10 when no quantity info available', () => {
            const order = {};
            const confirmedAt = new Date();
            const now = new Date(confirmedAt.getTime() + 24 * 60 * 60 * 1000);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveredQuantity).toBe(10);
        });

        it('should generate meter readings', () => {
            const order = { 'beckn:orderAttributes': { total_quantity: 24 } };
            const confirmedAt = new Date();
            const now = new Date(confirmedAt.getTime() + 3 * 60 * 60 * 1000);

            const result = calculateDeliveryProgress(order, confirmedAt, now);

            expect(result.deliveryAttributes.meterReadings.length).toBe(4);
            expect(result.deliveryAttributes.meterReadings[0]).toHaveProperty('beckn:timeWindow');
            expect(result.deliveryAttributes.meterReadings[0]).toHaveProperty('allocatedEnergy');
        });
    });

    describe('validateContext', () => {
        it('should return invalid for missing context', () => {
            const result = validateContext(null);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('Missing context');
        });

        it('should return invalid for missing bpp_uri without env fallback', () => {
            const originalEnv = process.env.BPP_CALLBACK_ENDPOINT;
            delete process.env.BPP_CALLBACK_ENDPOINT;

            const result = validateContext({});

            expect(result.valid).toBe(false);
            expect(result.error).toContain('Missing bpp_uri');

            process.env.BPP_CALLBACK_ENDPOINT = originalEnv;
        });

        it('should return valid when bpp_uri present', () => {
            const result = validateContext({ bpp_uri: 'http://example.com' });
            expect(result.valid).toBe(true);
        });

        it('should return valid when BPP_CALLBACK_ENDPOINT env is set', () => {
            const originalEnv = process.env.BPP_CALLBACK_ENDPOINT;
            process.env.BPP_CALLBACK_ENDPOINT = 'http://callback.example.com';

            const result = validateContext({});

            expect(result.valid).toBe(true);

            process.env.BPP_CALLBACK_ENDPOINT = originalEnv;
        });
    });

    describe('getCallbackUrl', () => {
        it('should use BPP_CALLBACK_ENDPOINT when set', () => {
            const originalEnv = process.env.BPP_CALLBACK_ENDPOINT;
            process.env.BPP_CALLBACK_ENDPOINT = 'http://callback.example.com/';

            const result = getCallbackUrl({}, 'select');

            expect(result).toBe('http://callback.example.com/on_select');

            process.env.BPP_CALLBACK_ENDPOINT = originalEnv;
        });

        it('should use bpp_uri when BPP_CALLBACK_ENDPOINT not set', () => {
            const originalEnv = process.env.BPP_CALLBACK_ENDPOINT;
            delete process.env.BPP_CALLBACK_ENDPOINT;

            const result = getCallbackUrl({ bpp_uri: 'http://example.com/some/path' }, 'init');

            expect(result).toBe('http://example.com/bpp/caller/on_init');

            process.env.BPP_CALLBACK_ENDPOINT = originalEnv;
        });
    });

    // ==========================================
    // onSelect Tests
    // ==========================================
    describe('onSelect', () => {
        const baseContext = {
            bpp_uri: 'http://bpp.example.com',
            transaction_id: 'txn-123',
            bap_id: 'bap-1',
            bpp_id: 'bpp-1'
        };

        it('should return ACK immediately', async () => {
            const req = createMockReq({
                context: baseContext,
                message: { items: [] }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should process items and send callback', async () => {
            mockGetItem.mockResolvedValue({
                'beckn:id': 'item-1',
                'beckn:provider': 'provider-1'
            });
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:price': {
                    applicableQuantity: { unitQuantity: 100 }
                }
            });

            const req = createMockReq({
                context: baseContext,
                message: {
                    items: [{
                        'beckn:id': 'item-1',
                        'beckn:quantity': { unitQuantity: 10 },
                        'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                    }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetItem).toHaveBeenCalledWith('item-1');
            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('should reject when insufficient inventory', async () => {
            mockGetItem.mockResolvedValue({
                'beckn:id': 'item-1'
            });
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:price': {
                    applicableQuantity: { unitQuantity: 5 }
                }
            });

            const req = createMockReq({
                context: baseContext,
                message: {
                    items: [{
                        'beckn:id': 'item-1',
                        'beckn:quantity': { unitQuantity: 10 },
                        'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                    }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    error: expect.objectContaining({
                        code: 'INSUFFICIENT_INVENTORY'
                    })
                })
            );
        });

        it('should skip item not found in catalog', async () => {
            mockGetItem.mockResolvedValue(null);

            const req = createMockReq({
                context: baseContext,
                message: {
                    items: [{
                        'beckn:id': 'nonexistent-item',
                        'beckn:quantity': { unitQuantity: 10 }
                    }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetItem).toHaveBeenCalledWith('nonexistent-item');
        });

        it('should handle order format with beckn:orderItems', async () => {
            mockGetItem.mockResolvedValue({
                'beckn:id': 'item-1'
            });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 5 }
                        }],
                        'beckn:buyer': { 'beckn:id': 'buyer-1' }
                    }
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetItem).toHaveBeenCalledWith('item-1');
        });
    });

    // ==========================================
    // onInit Tests
    // ==========================================
    describe('onInit', () => {
        const baseContext = {
            bpp_uri: 'http://bpp.example.com',
            transaction_id: 'txn-123',
            bap_id: 'bap-1',
            bpp_id: 'bpp-1'
        };

        it('should return ACK immediately', async () => {
            const req = createMockReq({
                context: baseContext,
                message: { order: { 'beckn:orderItems': [] } }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should calculate totals and send on_init callback', async () => {
            mockCreateOrder.mockResolvedValue({
                id: 'rzp-order-1',
                amount: 10000,
                currency: 'INR'
            });
            mockCreatePaymentLink.mockResolvedValue({
                short_url: 'https://rzp.io/pay123'
            });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': {
                                'beckn:price': { 'schema:price': 5, 'schema:priceCurrency': 'INR' }
                            }
                        }],
                        'beckn:buyer': { 'beckn:id': 'buyer-1' },
                        'beckn:seller': { 'beckn:id': 'seller-1' }
                    }
                }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);
            await waitForAsync();

            expect(mockCreateOrder).toHaveBeenCalled();
            expect(mockCreatePaymentLink).toHaveBeenCalled();
            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('should look up offer from DB when not in request', async () => {
            mockGetItem.mockResolvedValue({ 'beckn:id': 'item-1' });
            mockGetOffersByItemId.mockResolvedValue([{
                'beckn:id': 'offer-1',
                'beckn:price': { 'schema:price': 5 }
            }]);
            mockCreateOrder.mockResolvedValue({ id: 'order-1', amount: 1000, currency: 'INR' });
            mockCreatePaymentLink.mockResolvedValue({ short_url: 'https://pay.link' });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 }
                            // No acceptedOffer
                        }]
                    }
                }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetItem).toHaveBeenCalledWith('item-1');
            expect(mockGetOffersByItemId).toHaveBeenCalledWith('item-1');
        });

        it('should handle payment link creation failure gracefully', async () => {
            mockCreateOrder.mockRejectedValue(new Error('Payment gateway error'));

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': {
                                'beckn:price': { 'schema:price': 5 }
                            }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);
            await waitForAsync();

            // Should still send callback even if payment fails
            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('should include inter-utility fields when present', async () => {
            mockCreateOrder.mockResolvedValue({ id: 'order-1', amount: 1000, currency: 'INR' });
            mockCreatePaymentLink.mockResolvedValue({ short_url: 'https://pay.link' });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': {
                                'beckn:price': { 'schema:price': 5 }
                            }
                        }],
                        'beckn:orderAttributes': {
                            utilityIdBuyer: 'DISCOM-A',
                            utilityIdSeller: 'DISCOM-B'
                        }
                    }
                }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    message: expect.objectContaining({
                        order: expect.objectContaining({
                            'beckn:orderAttributes': expect.objectContaining({
                                '@type': 'EnergyTradeOrderInterUtility'
                            })
                        })
                    })
                })
            );
        });
    });

    // ==========================================
    // onConfirm Tests
    // ==========================================
    describe('onConfirm', () => {
        const baseContext = {
            bpp_uri: 'http://bpp.example.com',
            transaction_id: 'txn-123',
            bap_id: 'bap-1',
            bpp_id: 'bpp-1',
            domain: 'energy'
        };

        it('should return ACK immediately', async () => {
            const req = createMockReq({
                context: baseContext,
                message: { order: { 'beckn:orderItems': [] } }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should reduce inventory and confirm order', async () => {
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:price': { applicableQuantity: { unitQuantity: 100 } },
                catalogId: 'catalog-1'
            });
            mockReduceOfferInventory.mockResolvedValue(true);
            mockBuildCatalogForPublish.mockResolvedValue({ 'beckn:id': 'catalog-1' });
            mockCreateSettlement.mockResolvedValue(true);
            mockSaveOrder.mockResolvedValue(true);
            mockGetSellerUserIdForItem.mockResolvedValue('seller-user-1');
            mockFindOne.mockResolvedValue({ _id: 'settlement-1' });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetOffer).toHaveBeenCalledWith('offer-1');
            expect(mockReduceOfferInventory).toHaveBeenCalledWith('offer-1', 10);
            expect(mockCreateSettlement).toHaveBeenCalled();
            expect(mockSaveOrder).toHaveBeenCalled();
            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('should reject when insufficient inventory', async () => {
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:price': { applicableQuantity: { unitQuantity: 5 } }
            });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    error: expect.objectContaining({
                        code: 'INSUFFICIENT_INVENTORY'
                    })
                })
            );
        });

        it('should fallback to item lookup when no offerId', async () => {
            mockGetOffersByItemId.mockResolvedValue([{
                'beckn:id': 'fallback-offer-1',
                catalogId: 'catalog-1'
            }]);
            mockReduceOfferInventory.mockResolvedValue(true);
            mockBuildCatalogForPublish.mockResolvedValue({ 'beckn:id': 'catalog-1' });
            mockCreateSettlement.mockResolvedValue(true);
            mockSaveOrder.mockResolvedValue(true);
            mockFindOne.mockResolvedValue({ _id: 'settlement-1' });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 }
                            // No acceptedOffer
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetOffersByItemId).toHaveBeenCalledWith('item-1');
            expect(mockReduceOfferInventory).toHaveBeenCalledWith('fallback-offer-1', 10);
        });

        it('should republish catalog after inventory change', async () => {
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:price': { applicableQuantity: { unitQuantity: 100 } },
                catalogId: 'catalog-1'
            });
            mockReduceOfferInventory.mockResolvedValue(true);
            mockBuildCatalogForPublish.mockResolvedValue({
                'beckn:id': 'catalog-1',
                items: []
            });
            mockCreateSettlement.mockResolvedValue(true);
            mockSaveOrder.mockResolvedValue(true);
            mockFindOne.mockResolvedValue({ _id: 'settlement-1' });

            const req = createMockReq({
                context: baseContext,
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(mockBuildCatalogForPublish).toHaveBeenCalledWith('catalog-1');
            // Verify republish axios call
            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.stringContaining('/publish'),
                expect.any(Object),
                expect.any(Object)
            );
        });
    });

    // ==========================================
    // onStatus Tests
    // ==========================================
    describe('onStatus', () => {
        const baseContext = {
            bpp_uri: 'http://bpp.example.com',
            transaction_id: 'txn-123'
        };

        it('should return ACK immediately', async () => {
            mockGetOrderByTransactionId.mockResolvedValue(null);

            const req = createMockReq({
                context: baseContext,
                message: {}
            });
            const res = createMockRes();

            onStatus(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should return error when order not found', async () => {
            mockGetOrderByTransactionId.mockResolvedValue(null);

            const req = createMockReq({
                context: baseContext,
                message: {}
            });
            const res = createMockRes();

            onStatus(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    error: expect.objectContaining({
                        code: 'ORDER_NOT_FOUND'
                    })
                })
            );
        });

        it('should return settled order status from ledger', async () => {
            mockGetOrderByTransactionId.mockResolvedValue({
                order: { 'beckn:id': 'order-1' },
                confirmedAt: new Date()
            });
            mockGetSettlement.mockResolvedValue({
                settlementStatus: 'SETTLED',
                actualDelivered: 100,
                contractedQuantity: 100,
                settlementCycleId: 'cycle-1',
                settledAt: new Date()
            });

            const req = createMockReq({
                context: baseContext,
                message: {}
            });
            const res = createMockRes();

            onStatus(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    message: expect.objectContaining({
                        order: expect.objectContaining({
                            'beckn:orderStatus': 'COMPLETED'
                        })
                    })
                })
            );
        });

        it('should return in-progress status with ledger data', async () => {
            mockGetOrderByTransactionId.mockResolvedValue({
                order: { 'beckn:id': 'order-1' },
                confirmedAt: new Date()
            });
            mockGetSettlement.mockResolvedValue({
                settlementStatus: 'PENDING',
                ledgerData: { some: 'data' },
                contractedQuantity: 100,
                buyerDiscomStatus: 'CONFIRMED',
                sellerDiscomStatus: 'PENDING',
                ledgerSyncedAt: new Date()
            });

            const req = createMockReq({
                context: baseContext,
                message: {}
            });
            const res = createMockRes();

            onStatus(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    message: expect.objectContaining({
                        order: expect.objectContaining({
                            'beckn:orderStatus': 'INPROGRESS'
                        })
                    })
                })
            );
        });

        it('should fallback to time-based simulation when no ledger data', async () => {
            mockGetOrderByTransactionId.mockResolvedValue({
                order: {
                    'beckn:id': 'order-1',
                    'beckn:orderAttributes': { total_quantity: 100 }
                },
                confirmedAt: new Date()
            });
            mockGetSettlement.mockResolvedValue(null);

            const req = createMockReq({
                context: baseContext,
                message: {}
            });
            const res = createMockRes();

            onStatus(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalled();
        });
    });

    // ==========================================
    // Template-based Handlers Tests
    // ==========================================
    describe('onUpdate', () => {
        it('should return NACK for invalid context', async () => {
            const req = createMockReq({
                context: null,
                message: {}
            });
            const res = createMockRes();

            onUpdate(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: { ack: { status: 'NACK' } }
            }));
        });

        it('should return ACK for valid context', async () => {
            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onUpdate(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle empty template gracefully', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({});

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onUpdate(req as Request, res as Response);
            await waitForAsync();

            // Should not call axios when template is empty
            expect(mockedAxios.post).not.toHaveBeenCalled();
        });
    });

    describe('onRating', () => {
        it('should return NACK for invalid context', async () => {
            const req = createMockReq({
                context: null,
                message: {}
            });
            const res = createMockRes();

            onRating(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: { ack: { status: 'NACK' } }
            }));
        });

        it('should return ACK for valid context', async () => {
            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onRating(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });
    });

    describe('onSupport', () => {
        it('should return NACK for invalid context', async () => {
            const req = createMockReq({
                context: null,
                message: {}
            });
            const res = createMockRes();

            onSupport(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: { ack: { status: 'NACK' } }
            }));
        });

        it('should send callback with template', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { support: { phone: '1800-123-456' } }
            });

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onSupport(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalled();
        });
    });

    describe('onTrack', () => {
        it('should return NACK for invalid context', async () => {
            const req = createMockReq({
                context: null,
                message: {}
            });
            const res = createMockRes();

            onTrack(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: { ack: { status: 'NACK' } }
            }));
        });

        it('should handle template not found', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce(null);

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onTrack(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).not.toHaveBeenCalled();
        });
    });

    describe('onCancel', () => {
        it('should return NACK for invalid context', async () => {
            const req = createMockReq({
                context: null,
                message: {}
            });
            const res = createMockRes();

            onCancel(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: { ack: { status: 'NACK' } }
            }));
        });

        it('should return ACK and send callback', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { order: { status: 'CANCELLED' } }
            });

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onCancel(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
            expect(mockedAxios.post).toHaveBeenCalled();
        });
    });

    // ==========================================
    // Trigger Handlers Tests
    // ==========================================
    describe('triggerOnStatus', () => {
        it('should send status callback and return ACK', async () => {
            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: { order: { id: 'order-1' } }
            });
            const res = createMockRes();

            await triggerOnStatus(req as Request, res as Response);

            expect(mockedAxios.post).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error gracefully', async () => {
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {}
            });
            const res = createMockRes();

            await triggerOnStatus(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });
    });

    describe('triggerOnUpdate', () => {
        it('should send update callback and return ACK', async () => {
            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: { order: { id: 'order-1' } }
            });
            const res = createMockRes();

            await triggerOnUpdate(req as Request, res as Response);

            expect(mockedAxios.post).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error gracefully', async () => {
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {}
            });
            const res = createMockRes();

            await triggerOnUpdate(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });
    });

    describe('triggerOnCancel', () => {
        it('should send cancel callback and return ACK', async () => {
            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: { order: { id: 'order-1' } }
            });
            const res = createMockRes();

            await triggerOnCancel(req as Request, res as Response);

            expect(mockedAxios.post).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error gracefully', async () => {
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {}
            });
            const res = createMockRes();

            await triggerOnCancel(req as Request, res as Response);

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });
    });

    // ==========================================
    // Error Handler Tests
    // ==========================================
    describe('Error handling in async handlers', () => {
        it('should handle error in onSelect async block', async () => {
            mockGetItem.mockRejectedValue(new Error('DB Error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {
                    items: [{ 'beckn:id': 'item-1', 'beckn:quantity': { unitQuantity: 10 } }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            // Should still return ACK even if async fails
            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle error in onInit async block', async () => {
            mockCreateOrder.mockRejectedValue(new Error('Payment error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:price': { 'schema:price': 5 } }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle error in onConfirm async block', async () => {
            mockGetOffer.mockRejectedValue(new Error('DB Error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', transaction_id: 'txn-1' },
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle error in onStatus async block', async () => {
            mockGetOrderByTransactionId.mockRejectedValue(new Error('DB Error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', transaction_id: 'txn-1' },
                message: {}
            });
            const res = createMockRes();

            onStatus(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error in onUpdate async block', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { order: { status: 'UPDATED' } }
            });
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onUpdate(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error in onRating async block', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { rating: { value: 5 } }
            });
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onRating(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error in onSupport async block', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { support: { phone: '123' } }
            });
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onSupport(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error in onTrack async block', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { tracking: { url: 'http://track.me' } }
            });
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onTrack(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('should handle axios error in onCancel async block', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({
                message: { order: { status: 'CANCELLED' } }
            });
            mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onCancel(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });
    });

    // ==========================================
    // Template Not Found Tests
    // ==========================================
    describe('Template not found handling', () => {
        it('should handle empty template in onSupport', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({});

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onSupport(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).not.toHaveBeenCalled();
        });

        it('should handle null template in onCancel', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce(null);

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onCancel(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).not.toHaveBeenCalled();
        });

        it('should handle empty template in onRating', async () => {
            (readDomainResponse as jest.Mock).mockResolvedValueOnce({});

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', domain: 'energy' },
                message: {}
            });
            const res = createMockRes();

            onRating(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).not.toHaveBeenCalled();
        });
    });

    // ==========================================
    // Additional Edge Cases for Full Coverage
    // ==========================================
    describe('Additional edge cases', () => {
        it('onSelect should use offer from request when not found in DB', async () => {
            mockGetItem.mockResolvedValue({ 'beckn:id': 'item-1' });
            // Offer not found in DB
            mockGetOffer.mockResolvedValue(null);

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {
                    items: [{
                        'beckn:id': 'item-1',
                        'beckn:quantity': { unitQuantity: 5 },
                        'beckn:acceptedOffer': {
                            'beckn:id': 'offer-from-request',
                            'beckn:price': { applicableQuantity: { unitQuantity: 10 } }
                        }
                    }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetOffer).toHaveBeenCalledWith('offer-from-request');
            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('onInit should handle axios callback error', async () => {
            mockCreateOrder.mockResolvedValue({ id: 'order-1', amount: 1000, currency: 'INR' });
            mockCreatePaymentLink.mockResolvedValue({ short_url: 'https://pay.link' });
            mockedAxios.post.mockRejectedValueOnce(new Error('Callback failed'));

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:price': { 'schema:price': 5 } }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onInit(req as Request, res as Response);
            await waitForAsync();

            expect(res.json).toHaveBeenCalledWith({ message: { ack: { status: 'ACK' } } });
        });

        it('onConfirm should warn when offer not found for inventory reduction', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            // First call returns offer for inventory check, second returns null for reduction
            mockGetOffer
                .mockResolvedValueOnce({
                    'beckn:id': 'offer-1',
                    'beckn:price': { applicableQuantity: { unitQuantity: 100 } }
                })
                .mockResolvedValueOnce(null);
            mockGetSellerUserIdForItem.mockResolvedValue('seller-1');

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', transaction_id: 'txn-1' },
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 },
                            'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Offer not found for inventory reduction'));
            consoleSpy.mockRestore();
        });

        it('onConfirm should warn when no offer found for item in fallback lookup', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            mockGetOffersByItemId.mockResolvedValue([]);
            mockCreateSettlement.mockResolvedValue(true);
            mockSaveOrder.mockResolvedValue(true);
            mockFindOne.mockResolvedValue({ _id: 'settlement-1' });

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', transaction_id: 'txn-1' },
                message: {
                    order: {
                        'beckn:orderItems': [{
                            'beckn:orderedItem': 'item-1',
                            'beckn:quantity': { unitQuantity: 10 }
                            // No acceptedOffer, will trigger fallback
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetOffersByItemId).toHaveBeenCalledWith('item-1');
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No offer found for item'));
            consoleSpy.mockRestore();
        });

        it('onSelect should handle items format with beckn:orderedItem', async () => {
            mockGetItem.mockResolvedValue({ 'beckn:id': 'item-1' });

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {
                    items: [{
                        'beckn:orderedItem': 'item-1',
                        'beckn:quantity': { unitQuantity: 5 }
                    }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockGetItem).toHaveBeenCalledWith('item-1');
        });

        it('onConfirm should handle items format available in different structures', async () => {
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:price': { applicableQuantity: { unitQuantity: 100 } },
                catalogId: 'catalog-1'
            });
            mockReduceOfferInventory.mockResolvedValue(true);
            mockBuildCatalogForPublish.mockResolvedValue({ 'beckn:id': 'catalog-1' });
            mockCreateSettlement.mockResolvedValue(true);
            mockSaveOrder.mockResolvedValue(true);
            mockFindOne.mockResolvedValue({ _id: 'settlement-1' });

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com', transaction_id: 'txn-1' },
                message: {
                    order: {
                        items: [{  // Using items instead of beckn:orderItems
                            id: 'item-1',
                            quantity: { selected: { count: 10 } },
                            'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                        }]
                    }
                }
            });
            const res = createMockRes();

            onConfirm(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalled();
        });

        it('onSelect should use price from offer attributes format', async () => {
            mockGetItem.mockResolvedValue({ 'beckn:id': 'item-1' });
            mockGetOffer.mockResolvedValue({
                'beckn:id': 'offer-1',
                'beckn:offerAttributes': {
                    'beckn:price': { value: 5, currency: 'INR' }
                },
                'beckn:price': { applicableQuantity: { unitQuantity: 100 } }
            });

            const req = createMockReq({
                context: { bpp_uri: 'http://example.com' },
                message: {
                    items: [{
                        'beckn:id': 'item-1',
                        'beckn:quantity': { unitQuantity: 5 },
                        'beckn:acceptedOffer': { 'beckn:id': 'offer-1' }
                    }]
                }
            });
            const res = createMockRes();

            onSelect(req as Request, res as Response);
            await waitForAsync();

            expect(mockedAxios.post).toHaveBeenCalled();
        });
    });
});
