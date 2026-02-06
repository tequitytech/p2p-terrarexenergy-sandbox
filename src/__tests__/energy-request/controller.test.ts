import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import {
    createEnergyRequest,
    getEnergyRequests,
    findBestSeller,
    giftEnergy,
    donateEnergy,
} from '../../energy-request/controller';
import { getDB } from '../../db';
import axios from 'axios';

// Mock dependencies
jest.mock('../../db', () => ({
    getDB: jest.fn(),
}));

jest.mock('axios');

jest.mock('../../energy-request/service', () => ({
    executeDirectTransaction: jest.fn(),
    discoverBestSeller: jest.fn(),
}));

const mockDB = {
    collection: jest.fn(),
};

const mockCollection = {
    findOne: jest.fn(),
    find: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
};

describe('Energy Request Controller', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        mockJson = jest.fn().mockReturnThis();
        mockStatus = jest.fn().mockReturnValue({ json: mockJson });

        mockReq = {
            body: {},
            params: {},
            headers: { authorization: 'Bearer token123' },
            user: undefined,
        };

        mockRes = {
            status: mockStatus,
            json: mockJson,
        };

        (getDB as jest.Mock).mockReturnValue(mockDB);
        mockDB.collection.mockReturnValue(mockCollection);
    });

    describe('createEnergyRequest', () => {
        it('should return 401 if user is not authenticated', async () => {
            mockReq.user = undefined;
            (mockReq as any).user = undefined;

            await createEnergyRequest(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(401);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
        });

        it('should return 400 if required fields are missing', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requiredEnergy: 10 }; // Missing purpose, startTime, endTime

            await createEnergyRequest(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Missing required fields' });
        });

        it('should return 404 if user profile not found', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = {
                requiredEnergy: 10,
                purpose: 'Test purpose',
                startTime: '2026-02-05T10:00:00Z',
                endTime: '2026-02-05T11:00:00Z',
            };
            mockCollection.findOne.mockResolvedValue(null);

            await createEnergyRequest(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'User profile not found' });
        });

        it('should create energy request successfully', async () => {
            const userId = new ObjectId();
            (mockReq as any).user = { phone: '1234567890', _id: userId };
            mockReq.body = {
                requiredEnergy: 10,
                purpose: 'Test purpose',
                startTime: '2026-02-05T10:00:00Z',
                endTime: '2026-02-05T11:00:00Z',
            };

            mockCollection.findOne.mockResolvedValue({
                _id: userId,
                name: 'Test User',
                isVerifiedBeneficiary: true,
                beneficiaryType: 'farmer',
            });
            mockCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() });

            await createEnergyRequest(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(201);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    requiredEnergy: 10,
                    purpose: 'Test purpose',
                }),
            }));
        });

        it('should handle database errors', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = {
                requiredEnergy: 10,
                purpose: 'Test purpose',
                startTime: '2026-02-05T10:00:00Z',
                endTime: '2026-02-05T11:00:00Z',
            };
            mockCollection.findOne.mockRejectedValue(new Error('Database error'));

            await createEnergyRequest(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: 'Database error',
            }));
        });
    });

    describe('getEnergyRequests', () => {
        it('should return all pending energy requests', async () => {
            const mockRequests = [
                { _id: new ObjectId(), requiredEnergy: 10, status: 'PENDING' },
                { _id: new ObjectId(), requiredEnergy: 20, status: 'PENDING' },
            ];

            mockCollection.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    toArray: jest.fn().mockResolvedValue(mockRequests),
                }),
            });

            await getEnergyRequests(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(mockRequests);
        });

        it('should handle database errors', async () => {
            mockCollection.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    toArray: jest.fn().mockRejectedValue(new Error('DB error')),
                }),
            });

            await getEnergyRequests(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: 'DB error',
            }));
        });
    });

    describe('findBestSeller', () => {
        it('should return 400 if requestId is missing', async () => {
            mockReq.params = {};

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Request ID missing' });
        });

        it('should return 400 for invalid requestId format', async () => {
            mockReq.params = { requestId: 'invalid-id' };
            mockCollection.findOne.mockRejectedValue(new Error('Invalid ObjectId'));

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Invalid Request ID format' });
        });

        it('should return 404 if energy request not found', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue(null);

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Energy request not found' });
        });

        it('should return 404 if no catalogs found', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId(),
                requiredEnergy: 10,
            });

            (axios.post as jest.Mock).mockResolvedValue({
                data: { message: { catalogs: [] } },
            });

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, message: 'No suitable seller found' });
        });

        it('should return 404 if no offers found in catalogs', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId(),
                requiredEnergy: 10,
            });

            (axios.post as jest.Mock).mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            { 'beckn:id': 'catalog-1' }, // No offers
                        ],
                    },
                },
            });

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, message: 'No suitable offers found in catalogs' });
        });

        it('should return best seller sorted by price', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId(),
                requiredEnergy: 10,
            });

            (axios.post as jest.Mock).mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:id': 'catalog-1',
                                'beckn:bppId': 'bpp-1',
                                'beckn:items': [{ 'beckn:id': 'item-1' }],
                                'beckn:offers': [
                                    {
                                        'beckn:id': 'offer-1',
                                        'beckn:items': ['item-1'],
                                        'beckn:price': { 'schema:price': 5 },
                                    },
                                ],
                            },
                        ],
                    },
                },
            });

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                bestSeller: expect.objectContaining({
                    'beckn:id': 'offer-1',
                }),
            }));
        });

        it('should handle axios errors', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId(),
                requiredEnergy: 10,
            });

            (axios.post as jest.Mock).mockRejectedValue(new Error('Network error'));

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: 'Network error',
            }));
        });

        it('should match item from offer items array', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId(),
                requiredEnergy: 10,
            });

            (axios.post as jest.Mock).mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:id': 'catalog-1',
                                'beckn:items': [
                                    { 'beckn:id': 'item-1', name: 'Solar Energy' },
                                    { 'beckn:id': 'item-2', name: 'Wind Energy' },
                                ],
                                'beckn:offers': [
                                    {
                                        'beckn:id': 'offer-1',
                                        'beckn:items': ['item-2'],
                                        'beckn:price': { 'schema:price': 3 },
                                    },
                                ],
                            },
                        ],
                    },
                },
            });

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                bestSeller: expect.objectContaining({
                    item: expect.objectContaining({ 'beckn:id': 'item-2' }),
                }),
            }));
        });

        it('should fallback to first item if offer has no items array', async () => {
            mockReq.params = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId(),
                requiredEnergy: 10,
            });

            (axios.post as jest.Mock).mockResolvedValue({
                data: {
                    message: {
                        catalogs: [
                            {
                                'beckn:id': 'catalog-1',
                                'beckn:items': [
                                    { 'beckn:id': 'item-fallback', name: 'Fallback Item' },
                                ],
                                'beckn:offers': [
                                    {
                                        'beckn:id': 'offer-no-items',
                                        // No 'beckn:items' array
                                        'beckn:price': { 'schema:price': 2 },
                                    },
                                ],
                            },
                        ],
                    },
                },
            });

            await findBestSeller(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                bestSeller: expect.objectContaining({
                    item: expect.objectContaining({ 'beckn:id': 'item-fallback' }),
                }),
            }));
        });
    });

    describe('giftEnergy', () => {
        const { discoverBestSeller, executeDirectTransaction } = require('../../energy-request/service');

        it('should return 401 if user is not authenticated', async () => {
            (mockReq as any).user = undefined;

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(401);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
        });

        it('should return 400 if requestId is missing', async () => {
            (mockReq as any).user = { phone: '1234567890', userId: 'user-123' };
            mockReq.body = {};

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Missing requestId' });
        });

        it('should return 404 if request not found', async () => {
            (mockReq as any).user = { phone: '1234567890', userId: 'user-123' };
            mockReq.body = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue(null);

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Request not found' });
        });

        it('should return 400 if request already fulfilled', async () => {
            (mockReq as any).user = { phone: '1234567890', userId: 'user-123' };
            mockReq.body = { requestId: new ObjectId().toString() };

            // First call for gifter profile, second for request
            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { consumptionProfile: { id: 'gifter-id' } } })
                .mockResolvedValueOnce({ status: 'FULFILLED', requiredEnergy: 10 });

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Request already fulfilled' });
        });

        it('should return 404 if no suitable seller found', async () => {
            (mockReq as any).user = { phone: '1234567890', userId: 'user-123' };
            mockReq.body = { requestId: new ObjectId().toString() };

            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { consumptionProfile: { id: 'gifter-id' } } })
                .mockResolvedValueOnce({ status: 'PENDING', requiredEnergy: 10, userId: new ObjectId() });

            discoverBestSeller.mockResolvedValue(null);

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'No suitable energy seller found' });
        });

        it('should complete gift transaction successfully', async () => {
            const requestId = new ObjectId().toString();
            (mockReq as any).user = { phone: '1234567890', userId: 'user-123' };
            mockReq.body = { requestId };

            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { consumptionProfile: { id: 'gifter-id' } } })
                .mockResolvedValueOnce({
                    status: 'PENDING',
                    requiredEnergy: 10,
                    userId: new ObjectId(),
                });

            discoverBestSeller.mockResolvedValue({ sellerId: 'seller-1', price: 50 });
            executeDirectTransaction.mockResolvedValue({
                transactionId: 'txn-123',
                orderId: 'order-123',
                status: 'PAYMENT_PENDING',
                amount: 50,
                message: { 'beckn:payment': { 'beckn:id': 'pay-1' } },
            });
            mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                message: 'Energy gift initiated. Proceed to payment.',
                transactionId: 'txn-123',
            }));
        });

        it('should handle errors during gift transaction', async () => {
            (mockReq as any).user = { phone: '1234567890', userId: 'user-123' };
            mockReq.body = { requestId: new ObjectId().toString() };

            mockCollection.findOne.mockRejectedValue(new Error('Transaction failed'));

            await giftEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: 'Transaction failed',
            }));
        });
    });

    describe('donateEnergy', () => {
        const { executeDirectTransaction } = require('../../energy-request/service');

        it('should return 401 if user is not authenticated', async () => {
            (mockReq as any).user = undefined;

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(401);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
        });

        it('should return 404 if seller profile not found', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue(null);

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Seller profile not found' });
        });

        it('should return 400 if seller has no valid ID', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requestId: new ObjectId().toString() };
            mockCollection.findOne.mockResolvedValue({ profiles: {} }); // No valid ID

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({
                success: false,
                error: 'User does not have a valid seller/provider ID configured'
            });
        });

        it('should return 404 if energy request not found', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requestId: new ObjectId().toString() };

            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { generationProfile: { id: 'seller-id' } } })
                .mockResolvedValueOnce(null);

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({ success: false, error: 'Request not found' });
        });

        it('should complete donation successfully', async () => {
            const requestId = new ObjectId().toString();
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requestId };

            mockCollection.findOne
                .mockResolvedValueOnce({ profiles: { generationProfile: { id: 'seller-id' } } })
                .mockResolvedValueOnce({
                    requiredEnergy: 10,
                    userId: new ObjectId(),
                    status: 'PENDING',
                });

            executeDirectTransaction.mockResolvedValue({
                transactionId: 'txn-donate-123',
                status: 'FULFILLED',
                amount: 0,
            });
            mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                transactionId: 'txn-donate-123',
                amount: 0,
            }));
        });

        it('should use utilityCustomer.did if other IDs not available', async () => {
            const requestId = new ObjectId().toString();
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requestId };

            mockCollection.findOne
                .mockResolvedValueOnce({
                    profiles: {
                        utilityCustomer: { did: 'utility-did' }
                    }
                })
                .mockResolvedValueOnce({
                    requiredEnergy: 5,
                    userId: new ObjectId(),
                    status: 'PENDING',
                });

            executeDirectTransaction.mockResolvedValue({
                transactionId: 'txn-util-123',
                status: 'FULFILLED',
                amount: 0,
            });
            mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(executeDirectTransaction).toHaveBeenCalledWith(
                expect.any(String),
                'utility-did', // sellerId from utilityCustomer.did
                5,
                0,
                expect.any(String),
                expect.any(String)
            );
        });

        it('should handle errors during donation', async () => {
            (mockReq as any).user = { phone: '1234567890' };
            mockReq.body = { requestId: new ObjectId().toString() };

            mockCollection.findOne.mockRejectedValue(new Error('Donation failed'));

            await donateEnergy(mockReq as Request, mockRes as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: 'Donation failed',
            }));
        });
    });
});
