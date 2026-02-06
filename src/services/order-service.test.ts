import { orderService } from './order-service';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../test-utils/db';
import { OrderStatus, OrderType } from '../types/order';

// Mock DB connection
jest.mock('../db', () => ({
    getDB: () => getTestDB(),
    connectDB: jest.fn().mockResolvedValue(undefined)
}));

describe('OrderService', () => {
    beforeAll(async () => {
        await setupTestDB();
    });

    afterAll(async () => {
        await teardownTestDB();
    });

    beforeEach(async () => {
        await clearTestDB();
    });

    describe('saveBuyerOrder', () => {
        it('should save and retrieve a buyer order', async () => {
            const transactionId = 'txn-buyer-001';
            const orderData = {
                userId: 'user-001',
                status: OrderStatus.INITIATED,
                items: [{ 'beckn:orderedItem': 'item-001', 'beckn:quantity': { unitQuantity: 5 } }]
            };

            await orderService.saveBuyerOrder(transactionId, orderData);

            const orders = await orderService.getBuyerOrders({ userId: 'user-001' });
            expect(orders.length).toBe(1);
            expect(orders[0].transactionId).toBe(transactionId);
            expect(orders[0].type).toBe(OrderType.BUYER);
        });

        it('should upsert buyer order on duplicate transactionId', async () => {
            const transactionId = 'txn-buyer-upsert';

            await orderService.saveBuyerOrder(transactionId, { userId: 'user-1', meterId: 'meter-1' });
            await orderService.saveBuyerOrder(transactionId, { userId: 'user-1', meterId: 'meter-2' });

            const orders = await orderService.getBuyerOrders({ userId: 'user-1' });
            expect(orders.length).toBe(1);
            expect((orders[0] as any).meterId).toBe('meter-2');
        });

        it('should throw error on database failure', async () => {
            // Force error by disconnecting DB reference
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('DB connection failed');
            };

            await expect(orderService.saveBuyerOrder('txn-err', {})).rejects.toThrow('DB connection failed');

            // Restore
            getDB().collection = originalCollection;
        });
    });

    describe('updateBuyerOrderStatus', () => {
        it('should update buyer order status', async () => {
            const transactionId = 'txn-buyer-002';
            await orderService.saveBuyerOrder(transactionId, { userId: 'user-001' });

            await orderService.updateBuyerOrderStatus(transactionId, OrderStatus.PAID, { razorpayPaymentId: 'pay_123' });

            const orders = await orderService.getBuyerOrders({ transactionId });
            expect(orders[0].status).toBe(OrderStatus.PAID);
            expect(orders[0].razorpayPaymentId).toBe('pay_123');
        });

        it('should warn when no order found to update', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            await orderService.updateBuyerOrderStatus('non-existent-txn', OrderStatus.PAID);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No buyer order found'));
            consoleSpy.mockRestore();
        });

        it('should throw error on database failure', async () => {
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('Update failed');
            };

            await expect(orderService.updateBuyerOrderStatus('txn', 'PAID')).rejects.toThrow('Update failed');

            getDB().collection = originalCollection;
        });
    });

    describe('getBuyerOrder', () => {
        it('should get a single buyer order by transactionId', async () => {
            const transactionId = 'txn-buyer-single';
            await orderService.saveBuyerOrder(transactionId, {
                userId: 'user-abc',
                status: OrderStatus.INITIATED,
            });

            const order = await orderService.getBuyerOrder(transactionId);
            expect(order).not.toBeNull();
            expect(order?.transactionId).toBe(transactionId);
            expect(order?.type).toBe(OrderType.BUYER);
        });

        it('should return null for non-existent order', async () => {
            const order = await orderService.getBuyerOrder('non-existent');
            expect(order).toBeNull();
        });

        it('should throw error on database failure', async () => {
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('Fetch failed');
            };

            await expect(orderService.getBuyerOrder('txn')).rejects.toThrow('Fetch failed');

            getDB().collection = originalCollection;
        });
    });

    describe('getBuyerOrders', () => {
        it('should strip userPhone from query', async () => {
            await orderService.saveBuyerOrder('txn-phone-test', { userId: 'user-phone' });

            // This should not filter by userPhone since it's stripped
            const orders = await orderService.getBuyerOrders({ userId: 'user-phone', userPhone: '1234567890' } as any);
            expect(orders.length).toBe(1);
        });

        it('should throw error on database failure', async () => {
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('Fetch orders failed');
            };

            await expect(orderService.getBuyerOrders({})).rejects.toThrow('Fetch orders failed');

            getDB().collection = originalCollection;
        });
    });

    describe('getSellerOrders', () => {
        it('should fetch seller orders filtered by userId', async () => {
            const { getDB } = require('../db');
            const db = getDB();

            await db.collection('orders').insertMany([
                {
                    transactionId: 'txn-s-1',
                    userId: 'seller-1',
                    type: OrderType.SELLER,
                    status: OrderStatus.SCHEDULED,
                    createdAt: new Date('2026-01-01T00:00:00Z'),
                },
                {
                    transactionId: 'txn-s-2',
                    userId: 'seller-2',
                    type: OrderType.SELLER,
                    status: OrderStatus.SCHEDULED,
                    createdAt: new Date('2026-01-02T00:00:00Z'),
                },
            ]);

            const sellerOrders = await orderService.getSellerOrders({ userId: 'seller-1' });
            expect(sellerOrders).toHaveLength(1);
            expect(sellerOrders[0].transactionId).toBe('txn-s-1');
        });

        it('should throw error on database failure', async () => {
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('Fetch seller orders failed');
            };

            await expect(orderService.getSellerOrders({})).rejects.toThrow('Fetch seller orders failed');

            getDB().collection = originalCollection;
        });
    });

    describe('updateSellerOrderStatus', () => {
        it('should update seller order status', async () => {
            const { getDB } = require('../db');
            const db = getDB();

            await db.collection('orders').insertOne({
                transactionId: 'txn-seller-update',
                userId: 'seller-1',
                type: OrderType.SELLER,
                orderStatus: 'SCHEDULED',
                createdAt: new Date(),
            });

            await orderService.updateSellerOrderStatus('txn-seller-update', 'DELIVERED');

            const orders = await db.collection('orders').find({ transactionId: 'txn-seller-update' }).toArray();
            expect(orders[0].orderStatus).toBe('DELIVERED');
            expect(orders[0].status).toBe('DELIVERED');
        });

        it('should warn when no seller order found to update', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            await orderService.updateSellerOrderStatus('non-existent-seller-txn', 'DELIVERED');

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No seller order found'));
            consoleSpy.mockRestore();
        });

        it('should apply additional updates', async () => {
            const { getDB } = require('../db');
            const db = getDB();

            await db.collection('orders').insertOne({
                transactionId: 'txn-seller-extra',
                userId: 'seller-1',
                type: OrderType.SELLER,
                createdAt: new Date(),
            });

            await orderService.updateSellerOrderStatus('txn-seller-extra', 'COMPLETED', { settlementId: 'settle-1' });

            const orders = await db.collection('orders').find({ transactionId: 'txn-seller-extra' }).toArray();
            expect(orders[0].settlementId).toBe('settle-1');
        });

        it('should throw error on database failure', async () => {
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('Update seller order failed');
            };

            await expect(orderService.updateSellerOrderStatus('txn', 'DELIVERED')).rejects.toThrow('Update seller order failed');

            getDB().collection = originalCollection;
        });
    });

    describe('getCombinedOrders', () => {
        it('should retrieve combined orders for a user', async () => {
            const userId = 'user-002';

            // Save buyer order
            await orderService.saveBuyerOrder('txn-b-1', { userId });

            // Save seller order
            const { getDB } = require('../db');
            const db = getDB();
            await db.collection('orders').insertOne({
                transactionId: 'txn-s-1',
                userId,
                type: OrderType.SELLER,
                status: OrderStatus.SCHEDULED,
                createdAt: new Date()
            });

            const combined = await orderService.getCombinedOrders(userId);
            expect(combined.length).toBe(2);
            expect(combined.some(o => o.type === OrderType.BUYER)).toBe(true);
            expect(combined.some(o => o.type === OrderType.SELLER)).toBe(true);
        });

        it('should sort combined orders by createdAt descending', async () => {
            const userId = 'user-sort-test';

            await orderService.saveBuyerOrder('txn-older', { userId, createdAt: new Date('2026-01-01') });
            await orderService.saveBuyerOrder('txn-newer', { userId, createdAt: new Date('2026-02-01') });

            const combined = await orderService.getCombinedOrders(userId);
            expect(combined.length).toBe(2);
            // Newer should come first
            expect(combined[0].transactionId).toBe('txn-newer');
        });

        it('should handle orders without createdAt', async () => {
            const userId = 'user-no-date';
            const { getDB } = require('../db');
            const db = getDB();

            await db.collection('buyer_orders').insertOne({
                transactionId: 'txn-no-date',
                userId,
                type: OrderType.BUYER,
            });

            const combined = await orderService.getCombinedOrders(userId);
            expect(combined.length).toBe(1);
        });

        it('should throw error on database failure', async () => {
            const { getDB } = require('../db');
            const originalCollection = getDB().collection;
            getDB().collection = () => {
                throw new Error('Combined orders failed');
            };

            await expect(orderService.getCombinedOrders('user')).rejects.toThrow('Combined orders failed');

            getDB().collection = originalCollection;
        });
    });
});

