/**
 * Tests for orders/routes.ts
 * 
 * Covers: GET /orders/buyer, GET /orders/seller, GET /orders/combined
 * All DB calls mocked via orderService
 */

import { Request, Response } from 'express';
import { mockRequest, mockResponse } from '../test-utils';

// Mock dependencies BEFORE importing routes
jest.mock('../services/order-service', () => ({
    orderService: {
        getBuyerOrders: jest.fn(),
        getSellerOrders: jest.fn(),
        getCombinedOrders: jest.fn()
    }
}));

jest.mock('../auth/routes', () => ({
    authMiddleware: jest.fn((req: any, res: any, next: any) => {
        // Simulate authenticated user for most tests
        req.user = { phone: '9876543210', userId: 'user-123' };
        next();
    })
}));

import { ordersRoutes } from './routes';
import { orderService } from '../services/order-service';
import { authMiddleware } from '../auth/routes';
import express from 'express';
import request from 'supertest';

describe('orders/routes', () => {
    let app: express.Express;

    const createMockBuyerOrder = (overrides: any = {}) => ({
        _id: 'order-123',
        type: 'BUYER' as const,
        transactionId: 'txn-1',
        userId: 'user-123',
        userPhone: '9876543210',
        status: 'CONFIRMED',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    });

    const createMockSellerOrder = (overrides: any = {}) => ({
        _id: 'order-456',
        type: 'SELLER' as const,
        transactionId: 'txn-2',
        userId: 'user-123',
        userPhone: '9876543210',
        status: 'FULFILLED',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    });

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api', ordersRoutes());
    });

    describe('GET /orders/buyer', () => {
        it('should return buyer orders for authenticated user', async () => {
            const mockOrders = [
                createMockBuyerOrder({ transactionId: 'txn-1', totalQuantity: 10 }),
                createMockBuyerOrder({ transactionId: 'txn-2', status: 'PENDING', totalQuantity: 5 })
            ];
            (orderService.getBuyerOrders as jest.Mock).mockResolvedValue(mockOrders);

            const response = await request(app)
                .get('/api/orders/buyer')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveLength(2);
            expect(orderService.getBuyerOrders).toHaveBeenCalledWith({ userId: 'user-123' });
        });

        it('should return empty array when no orders exist', async () => {
            (orderService.getBuyerOrders as jest.Mock).mockResolvedValue([]);

            const response = await request(app)
                .get('/api/orders/buyer')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveLength(0);
        });

        it('should return 401 when user is not authenticated', async () => {
            // Override authMiddleware for this test
            (authMiddleware as jest.Mock).mockImplementationOnce((req: any, res: any, next: any) => {
                req.user = null;
                next();
            });

            const response = await request(app)
                .get('/api/orders/buyer')
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        it('should return 500 on service error', async () => {
            (orderService.getBuyerOrders as jest.Mock).mockRejectedValue(new Error('Database error'));

            const response = await request(app)
                .get('/api/orders/buyer')
                .expect(500);

            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe('INTERNAL_SERVER_ERROR');
        });
    });

    describe('GET /orders/seller', () => {
        it('should return seller orders for authenticated user', async () => {
            const mockOrders = [
                createMockSellerOrder({ transactionId: 'txn-1', totalQuantity: 15 })
            ];
            (orderService.getSellerOrders as jest.Mock).mockResolvedValue(mockOrders);

            const response = await request(app)
                .get('/api/orders/seller')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveLength(1);
            expect(orderService.getSellerOrders).toHaveBeenCalledWith({ userId: 'user-123' });
        });

        it('should return empty array when no seller orders exist', async () => {
            (orderService.getSellerOrders as jest.Mock).mockResolvedValue([]);

            const response = await request(app)
                .get('/api/orders/seller')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual([]);
        });

        it('should return 401 when user not authenticated', async () => {
            (authMiddleware as jest.Mock).mockImplementationOnce((req: any, res: any, next: any) => {
                req.user = undefined;
                next();
            });

            const response = await request(app)
                .get('/api/orders/seller')
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        it('should return 500 on service error', async () => {
            (orderService.getSellerOrders as jest.Mock).mockRejectedValue(new Error('DB connection lost'));

            const response = await request(app)
                .get('/api/orders/seller')
                .expect(500);

            expect(response.body.success).toBe(false);
        });
    });

    describe('GET /orders/combined', () => {
        it('should return both buyer and seller orders', async () => {
            const mockCombinedOrders = [
                createMockBuyerOrder({ transactionId: 'txn-1' }),
                createMockSellerOrder({ transactionId: 'txn-2' })
            ];
            (orderService.getCombinedOrders as jest.Mock).mockResolvedValue(mockCombinedOrders);

            const response = await request(app)
                .get('/api/orders/combined')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveLength(2);
            expect(orderService.getCombinedOrders).toHaveBeenCalledWith('user-123');
        });

        it('should return empty array when no orders exist', async () => {
            (orderService.getCombinedOrders as jest.Mock).mockResolvedValue([]);

            const response = await request(app)
                .get('/api/orders/combined')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual([]);
        });

        it('should return 401 when user not authenticated', async () => {
            (authMiddleware as jest.Mock).mockImplementationOnce((req: any, res: any, next: any) => {
                req.user = null;
                next();
            });

            const response = await request(app)
                .get('/api/orders/combined')
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        it('should return 500 on service error', async () => {
            (orderService.getCombinedOrders as jest.Mock).mockRejectedValue(new Error('Query failed'));

            const response = await request(app)
                .get('/api/orders/combined')
                .expect(500);

            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe('INTERNAL_SERVER_ERROR');
        });
    });
});
