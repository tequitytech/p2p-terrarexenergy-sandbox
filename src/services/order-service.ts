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
  },

  async getSellerOrders(filter: any = {}) {
    const db = getDB();
    return db.collection("orders")
      .find({ ...filter, type: "seller" })
      .sort({ createdAt: -1 })
      .toArray();
  },

  async updateSellerOrderStatus(transactionId: string, orderStatus: string, updates: any = {}) {
    const db = getDB();
    await db.collection('orders').updateOne(
      { transactionId },
      {
        $set: {
          ...updates,
          orderStatus,
          updatedAt: new Date()
        }
      }
    );
    console.log(`[DB] Seller Order status updated to ${orderStatus}: ${transactionId}`);
  },

  async getCombinedOrders(userId: any, userPhone: string) {
    const db = getDB();
    const [buyerOrders, sellerOrders] = await Promise.all([
      db.collection("buyer_orders")
        .find({ userId, type: "buyer" })
        .toArray(),
      db.collection("orders")
        .find({ userId, type: "seller" })
        .toArray(),
    ]);

    // Combine and sort by createdAt descending
    const combined = [...buyerOrders, ...sellerOrders].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    return combined;
  },
};