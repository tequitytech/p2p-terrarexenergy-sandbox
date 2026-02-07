import { getDB } from '../db';
import { OrderStatus, OrderType } from '../types/order';

import type { BuyerOrder, SellerOrder} from '../types/order';

export const orderService = {
  // --- Buyer Order Management ---

  async saveBuyerOrder(transactionId: string, orderData: any) {
    try {
      const db = getDB();
      await db.collection('buyer_orders').updateOne(
        { transactionId },
        {
          $set: {
            ...orderData,
            transactionId,
            type: OrderType.BUYER,
            status: orderData.status || OrderStatus.INITIATED,
            createdAt: orderData.createdAt || new Date(),
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
      console.log(`[OrderService] Buyer Order saved: ${transactionId}`);
    } catch (error: any) {
      console.error(`[OrderService] Error saving buyer order: ${error.message}`);
      throw error;
    }
  },

  async updateBuyerOrderStatus(transactionId: string, status: string, updates: any = {}) {
    try {
      const db = getDB();
      const result = await db.collection('buyer_orders').updateOne(
        { transactionId },
        {
          $set: {
            ...updates,
            status,
            updatedAt: new Date()
          }
        }
      );
      if (result.matchedCount === 0) {
        console.warn(`[OrderService] No buyer order found to update status: ${transactionId}`);
      } else {
        console.log(`[OrderService] Buyer Order status updated to ${status}: ${transactionId}`);
      }
    } catch (error: any) {
      console.error(`[OrderService] Error updating buyer order status: ${error.message}`);
      throw error;
    }
  },

  async getBuyerOrder(transactionId: string): Promise<BuyerOrder | null> {
    try {
      const db = getDB();
      return await db.collection<BuyerOrder>('buyer_orders').findOne({ transactionId });
    } catch (error: any) {
      console.error(`[OrderService] Error fetching buyer order: ${error.message}`);
      throw error;
    }
  },

  async getBuyerOrders(filter: any = {}): Promise<BuyerOrder[]> {
    try {
      const db = getDB();
      // Ensure we only return buyer orders if the collection contains mixed data (though we use separate collections now)
      const query = { ...filter, type: OrderType.BUYER };

      // Remove fields from query if they don't exist in the collection or aren't meant for filtering
      if (query.userPhone) delete query.userPhone;

      return await db.collection<BuyerOrder>('buyer_orders')
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
    } catch (error: any) {
      console.error(`[OrderService] Error fetching buyer orders: ${error.message}`);
      throw error;
    }
  },

  async getSellerOrders(filter: any = {}): Promise<SellerOrder[]> {
    try {
      const db = getDB();
      return await db.collection<SellerOrder>("orders")
        .find({ ...filter, type: OrderType.SELLER })
        .sort({ createdAt: -1 })
        .toArray();
    } catch (error: any) {
      console.error(`[OrderService] Error fetching seller orders: ${error.message}`);
      throw error;
    }
  },

  async updateSellerOrderStatus(transactionId: string, orderStatus: string, updates: any = {}) {
    try {
      const db = getDB();
      const result = await db.collection('orders').updateOne(
        { transactionId },
        {
          $set: {
            ...updates,
            orderStatus, // Legacy field
            status: orderStatus as any, // New consistency
            updatedAt: new Date()
          }
        }
      );
      if (result.matchedCount === 0) {
        console.warn(`[OrderService] No seller order found to update status: ${transactionId}`);
      } else {
        console.log(`[OrderService] Seller Order status updated to ${orderStatus}: ${transactionId}`);
      }
    } catch (error: any) {
      console.error(`[OrderService] Error updating seller order status: ${error.message}`);
      throw error;
    }
  },

  async getCombinedOrders(userId: string) {
    try {
      const db = getDB();
      const [buyerOrders, sellerOrders] = await Promise.all([
        db.collection<BuyerOrder>("buyer_orders")
          .find({ userId, type: OrderType.BUYER })
          .toArray(),
        db.collection<SellerOrder>("orders")
          .find({ userId, type: OrderType.SELLER })
          .toArray(),
      ]);

      // Combine and sort by createdAt descending
      const combined = [...buyerOrders, ...sellerOrders].sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      });

      return combined;
    } catch (error: any) {
      console.error(`[OrderService] Error fetching combined orders: ${error.message}`);
      throw error;
    }
  },
};