import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../test-utils/db';
import { OrderStatus, OrderType } from '../types/order';

import { orderService } from './order-service';

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

    // --- saveBuyerOrder ---

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

    it('should upsert buyer order when same transactionId exists', async () => {
        const transactionId = 'txn-upsert-001';
        await orderService.saveBuyerOrder(transactionId, { userId: 'user-001', status: OrderStatus.INITIATED });
        await orderService.saveBuyerOrder(transactionId, { userId: 'user-001', status: OrderStatus.PAID });

        const orders = await orderService.getBuyerOrders({ userId: 'user-001' });
        expect(orders.length).toBe(1);
        expect(orders[0].status).toBe(OrderStatus.PAID);
    });

    it('should set default status to INITIATED when not provided', async () => {
        const transactionId = 'txn-default-status';
        await orderService.saveBuyerOrder(transactionId, { userId: 'user-001' });

        const order = await orderService.getBuyerOrder(transactionId);
        expect(order).not.toBeNull();
        expect(order!.status).toBe(OrderStatus.INITIATED);
    });

    // --- getBuyerOrder (single) ---

    it('should return single buyer order by transactionId', async () => {
        const transactionId = 'txn-single-001';
        await orderService.saveBuyerOrder(transactionId, {
            userId: 'user-001',
            meterId: 'meter-100'
        });

        const order = await orderService.getBuyerOrder(transactionId);
        expect(order).not.toBeNull();
        expect(order!.transactionId).toBe(transactionId);
        expect(order!.meterId).toBe('meter-100');
    });

    it('should return null when transactionId not found', async () => {
        const order = await orderService.getBuyerOrder('non-existent-txn');
        expect(order).toBeNull();
    });

    // --- updateBuyerOrderStatus ---

    it('should update buyer order status', async () => {
        const transactionId = 'txn-buyer-002';
        await orderService.saveBuyerOrder(transactionId, { userId: 'user-001' });

        await orderService.updateBuyerOrderStatus(transactionId, OrderStatus.PAID, { razorpayPaymentId: 'pay_123' });

        const orders = await orderService.getBuyerOrders({ transactionId });
        expect(orders[0].status).toBe(OrderStatus.PAID);
        expect(orders[0].razorpayPaymentId).toBe('pay_123');
    });

    it('should warn when no matching buyer order exists (matchedCount=0)', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        await orderService.updateBuyerOrderStatus('non-existent-txn', OrderStatus.PAID);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('No buyer order found to update status: non-existent-txn')
        );
        warnSpy.mockRestore();
    });

    it('should merge additional update fields with status in buyer order', async () => {
        const transactionId = 'txn-merge-001';
        await orderService.saveBuyerOrder(transactionId, { userId: 'user-001' });

        await orderService.updateBuyerOrderStatus(transactionId, OrderStatus.PAID, {
            razorpayPaymentId: 'pay_456',
            razorpaySignature: 'sig_789',
            paymentId: 'link_abc'
        });

        const order = await orderService.getBuyerOrder(transactionId);
        expect(order!.status).toBe(OrderStatus.PAID);
        expect(order!.razorpayPaymentId).toBe('pay_456');
        expect(order!.razorpaySignature).toBe('sig_789');
        expect(order!.paymentId).toBe('link_abc');
    });

    // --- getSellerOrders ---

    it('should return orders from orders collection with type=SELLER', async () => {
        const db = getTestDB();
        await db.collection('orders').insertOne({
            transactionId: 'txn-seller-001',
            userId: 'user-seller-1',
            type: OrderType.SELLER,
            status: OrderStatus.SCHEDULED,
            createdAt: new Date()
        });

        const orders = await orderService.getSellerOrders({ userId: 'user-seller-1' });
        expect(orders.length).toBe(1);
        expect(orders[0].transactionId).toBe('txn-seller-001');
        expect(orders[0].type).toBe(OrderType.SELLER);
    });

    it('should return empty array when no seller orders exist', async () => {
        const orders = await orderService.getSellerOrders({ userId: 'no-such-user' });
        expect(orders).toEqual([]);
    });

    it('should sort seller orders by createdAt descending', async () => {
        const db = getTestDB();
        const older = new Date('2026-01-01');
        const newer = new Date('2026-02-01');

        await db.collection('orders').insertMany([
            {
                transactionId: 'txn-seller-old',
                userId: 'user-sort',
                type: OrderType.SELLER,
                status: OrderStatus.SCHEDULED,
                createdAt: older
            },
            {
                transactionId: 'txn-seller-new',
                userId: 'user-sort',
                type: OrderType.SELLER,
                status: OrderStatus.DELIVERED,
                createdAt: newer
            }
        ]);

        const orders = await orderService.getSellerOrders({ userId: 'user-sort' });
        expect(orders.length).toBe(2);
        expect(orders[0].transactionId).toBe('txn-seller-new');
        expect(orders[1].transactionId).toBe('txn-seller-old');
    });

    // --- updateSellerOrderStatus ---

    it('should update both orderStatus and status fields for seller order', async () => {
        const db = getTestDB();
        await db.collection('orders').insertOne({
            transactionId: 'txn-seller-update',
            userId: 'user-seller-2',
            type: OrderType.SELLER,
            status: OrderStatus.SCHEDULED,
            createdAt: new Date()
        });

        await orderService.updateSellerOrderStatus('txn-seller-update', OrderStatus.DELIVERED);

        const doc = await db.collection('orders').findOne({ transactionId: 'txn-seller-update' });
        expect(doc!.status).toBe(OrderStatus.DELIVERED);
        expect(doc!.orderStatus).toBe(OrderStatus.DELIVERED);
    });

    it('should warn when no matching seller order exists', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        await orderService.updateSellerOrderStatus('non-existent-seller-txn', OrderStatus.DELIVERED);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('No seller order found to update status: non-existent-seller-txn')
        );
        warnSpy.mockRestore();
    });

    it('should merge additional update fields in seller order', async () => {
        const db = getTestDB();
        await db.collection('orders').insertOne({
            transactionId: 'txn-seller-merge',
            userId: 'user-seller-3',
            type: OrderType.SELLER,
            status: OrderStatus.SCHEDULED,
            createdAt: new Date()
        });

        await orderService.updateSellerOrderStatus('txn-seller-merge', OrderStatus.DELIVERED, {
            settlementId: 'settle-001',
            actualDelivered: 8.5
        });

        const doc = await db.collection('orders').findOne({ transactionId: 'txn-seller-merge' });
        expect(doc!.status).toBe(OrderStatus.DELIVERED);
        expect(doc!.settlementId).toBe('settle-001');
        expect(doc!.actualDelivered).toBe(8.5);
    });

    // --- getCombinedOrders ---

    it('should retrieve combined orders for a user', async () => {
        const userId = 'user-002';

        // Save buyer order
        await orderService.saveBuyerOrder('txn-b-1', { userId });

        // Save seller order
        const db = getTestDB();
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
        const userId = 'user-combined-sort';
        const oldest = new Date('2026-01-01');
        const middle = new Date('2026-01-15');
        const newest = new Date('2026-02-01');

        // Buyer order (middle date)
        await orderService.saveBuyerOrder('txn-b-mid', { userId, createdAt: middle });

        // Seller orders (oldest and newest)
        const db = getTestDB();
        await db.collection('orders').insertMany([
            {
                transactionId: 'txn-s-old',
                userId,
                type: OrderType.SELLER,
                status: OrderStatus.SCHEDULED,
                createdAt: oldest
            },
            {
                transactionId: 'txn-s-new',
                userId,
                type: OrderType.SELLER,
                status: OrderStatus.DELIVERED,
                createdAt: newest
            }
        ]);

        const combined = await orderService.getCombinedOrders(userId);
        expect(combined.length).toBe(3);
        expect(combined[0].transactionId).toBe('txn-s-new');
        expect(combined[1].transactionId).toBe('txn-b-mid');
        expect(combined[2].transactionId).toBe('txn-s-old');
    });

    it('should return empty array when user has no orders', async () => {
        const combined = await orderService.getCombinedOrders('user-with-no-orders');
        expect(combined).toEqual([]);
    });
});
