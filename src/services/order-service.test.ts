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

    it('should update buyer order status', async () => {
        const transactionId = 'txn-buyer-002';
        await orderService.saveBuyerOrder(transactionId, { userId: 'user-001' });

        await orderService.updateBuyerOrderStatus(transactionId, OrderStatus.PAID, { razorpayPaymentId: 'pay_123' });

        const orders = await orderService.getBuyerOrders({ transactionId });
        expect(orders[0].status).toBe(OrderStatus.PAID);
        expect(orders[0].razorpayPaymentId).toBe('pay_123');
    });

    it('should retrieve combined orders for a user', async () => {
        const userId = 'user-002';

        // Save buyer order
        await orderService.saveBuyerOrder('txn-b-1', { userId });

        // Save seller order (manually since there's no saveSellerOrder yet, or it's implicitly done in webhook)
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
});
