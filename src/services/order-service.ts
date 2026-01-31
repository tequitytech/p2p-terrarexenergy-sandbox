import { getDB } from '../db';

export const orderService = {
  // --- Buyer Order Management ---

  async saveBuyerOrder(transactionId: string, orderData: any) {
    const db = getDB();
    await db.collection('buyer_orders').updateOne(
      { transactionId },
      {
        $set: {
          ...orderData,
          transactionId,
          status: orderData.status || 'CREATED',
          createdAt: orderData.createdAt || new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`[DB] Buyer Order saved: ${transactionId}`);
  },

  async updateBuyerOrderStatus(transactionId: string, status: string, updates: any = {}) {
    const db = getDB();
    await db.collection('buyer_orders').updateOne(
      { transactionId },
      {
        $set: {
          ...updates,
          status,
          updatedAt: new Date()
        }
      }
    );
    console.log(`[DB] Buyer Order status updated to ${status}: ${transactionId}`);
  },

  async getBuyerOrder(transactionId: string) {
    const db = getDB();
    return db.collection('buyer_orders').findOne({ transactionId });
  },

  async getBuyerOrders(filter: any = {}) {
    const db = getDB();
    return db.collection('buyer_orders')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();
  }
};