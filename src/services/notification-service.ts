import { ObjectId } from "mongodb";
import { getDB } from "../db";
import { sendNotification } from "../utils/notifications";

import { emailService } from "./email-service";
export interface Notification {
  _id?: ObjectId;
  userId: ObjectId;
  type: string; // e.g., 'GIFT_CLAIM_SELLER', 'GIFT_CLAIM_BUYER', 'ORDER_STATUS'
  title: string;
  body: string;
  data?: Record<string, any>; // Flexible payload (e.g., transactionId)
  isRead: boolean;
  createdAt: Date;
}

export const notificationService = {
  /**
   * Create a new notification and optionally send a push notification
   */

  async createNotification(
    userId: ObjectId,
    type: string,
    title: string,
    body: string,
    data: Record<string, any> = {}
  ) {
    try {
      const db = getDB();

      // 1. Save to Database
      const notification: Notification = {
        userId,
        type,
        title,
        body,
        data,
        isRead: false,
        createdAt: new Date(),
      };

      const result = await db.collection("notifications").insertOne(notification);

      // 2. Send Push Notification (Fail-safe)
      // Check if user has an FCM token (assuming it's stored in users collection)
      const user = await db.collection("users").findOne({ _id: userId });
      if (user?.fcmToken) {
        // Run async without awaiting to not block the main flow
        sendNotification(user.fcmToken, title, body).catch(err =>
          console.error(`[NotificationService] Failed to send push to ${userId}:`, err)
        );
      }

      return result.insertedId;
    } catch (error) {
      // For now, logging error.
      console.error(`[NotificationService] Error creating notification for ${userId}:`, error);
      return null;
    }
  },

  /**
   * Get notifications for a user with pagination
   */
  async getUserNotifications(userId: ObjectId, limit = 20, offset = 0) {
    const db = getDB();
    const query = { userId };

    const [result] = await db.collection("notifications").aggregate([
      { $match: query },
      {
        $facet: {
          notifications: [
            { $sort: { createdAt: -1 } },
            { $skip: offset },
            { $limit: limit }
          ],
          total: [
            { $count: "count" }
          ],
          unreadCount: [
            { $match: { isRead: false } }, // distinct from global query if needed, but here it refines
            { $count: "count" }
          ]
        }
      }
    ]).toArray();

    const notifications = result.notifications || [];
    const total = result.total[0]?.count || 0;
    const unreadCount = result.unreadCount[0]?.count || 0;

    // Enrichment: Attach Gifting Option details
    const giftingOptionIds = new Set(
      notifications
        .map((n: any) => n.data?.giftingOptionId)
        .filter(Boolean)
    );

    const objectIds = Array.from(giftingOptionIds)
      .map((id) => {
        if (id instanceof ObjectId) return id;
        if (typeof id === "string" && ObjectId.isValid(id)) {
          return new ObjectId(id);
        }
        return null;
      })
      .filter(Boolean) as ObjectId[];

    if (objectIds.length > 0) {
      const giftingOptions = await db
        .collection("gifting_options")
        .find({ _id: { $in: objectIds } })
        .toArray();

      const optionsMap = new Map(
        giftingOptions.map((opt: any) => [opt._id.toString(), opt])
      );

      notifications.forEach((n: any) => {
        const id = n.data?.giftingOptionId;
        if (id) {
          n.giftingOption = optionsMap.get(id.toString()) ?? null;
        }
      });

    }

    return { notifications, total, unreadCount };
  },

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string, userId: ObjectId) {
    const db = getDB();
    return db.collection("notifications").updateOne(
      { _id: new ObjectId(notificationId), userId },
      { $set: { isRead: true } }
    );
  },

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: ObjectId) {
    const db = getDB();
    return db.collection("notifications").updateMany(
      { userId, isRead: false },
      { $set: { isRead: true } }
    );
  },
  /**
   * Sends an order confirmation email to the buyer
   */
  async sendOrderConfirmation(transactionId: string, order: any) {
    try {
      const buyerId = order['beckn:buyer']?.['beckn:id'];
      if (!buyerId) {
        console.log(`[NotificationService] No buyer ID found in order for txn ${transactionId}`);
        return;
      }

      const db = getDB();
      // Find user by profile ID (consumption, utility, or even phone if mapped)
      const user = await db.collection("users").findOne({
        $or: [
          { "profiles.consumptionProfile.id": buyerId },
          { "profiles.utilityCustomer.did": buyerId },
          { "phone": buyerId } // Fallback
        ]
      });

      if (!user || !user.email) {
        console.log(`[NotificationService] No verified email found for buyer ${buyerId}, skipping notification.`);
        return;
      }

      const orderItems = order['beckn:orderItems'] || [];
      // Calculate total quantity
      const totalQuantity = orderItems.reduce((sum: number, item: any) => {
        const qty = item['beckn:quantity']?.unitQuantity || 0;
        return sum + qty;
      }, 0);

      const subject = `Order Confirmed: ${transactionId}`;
      const body = `
        <h1>Order Confirmation</h1>
        <p>Your order has been successfully confirmed.</p>
        <ul>
            <li><strong>Transaction ID:</strong> ${transactionId}</li>
            <li><strong>Total Quantity:</strong> ${totalQuantity} kWh</li>
            <li><strong>Seller:</strong> ${order['beckn:seller']?.['beckn:id'] || 'Unknown'}</li>
            <li><strong>Amount:</strong> ${order['beckn:payment']?.['beckn:amount']?.value || 0} INR</li>
        </ul>
        <p>Thank you for using Tequity P2P Trading!</p>
      `;

      await emailService.sendEmail(user.email, subject, body);
      console.log(`[NotificationService] Confirmation email sent to ${user.email} for txn ${transactionId}`);

    } catch (error) {
      console.error(`[NotificationService] Error processing order confirmation:`, error);
    }
  },

  /**
   * Helper to find user by any Beckn Profile ID or mongo id
   */
  async findUserByBecknId(becknId: string) {
    if (!becknId || becknId === 'unknown') return null;
    const db = getDB();
    // Optimization: If it's a valid Mongo ObjectId, try to find by _id first
    if (ObjectId.isValid(becknId)) {
      const user = await db.collection("users").findOne({ _id: new ObjectId(becknId) });
      if (user) return user;
    }

    const query: any[] = [
      { "profiles.consumptionProfile.id": becknId },
      { "profiles.consumptionProfile.did": becknId },
      { "profiles.generationProfile.id": becknId },
      { "profiles.generationProfile.did": becknId },
      { "profiles.utilityCustomer.did": becknId }
    ];

    return db.collection("users").findOne({ $or: query });
  },

  /**
   * Unified handler for transaction-related notifications
   */
  async handleTransactionNotification(
    type: 'ORDER_PURCHASE_SUCCESS' | 'ORDER_SOLD' | 'PUBLISH_SUCCESS' | 'AUTO_BID_PLACED',
    details: {
      transactionId: string;
      orderId?: string;
      buyerId?: string; // Beckn ID
      sellerId?: string; // Beckn ID
      quantity?: number;
      amount?: number;
      itemName?: string;
      giftingOptionId?: string;
      giftOfferId?: string;
      date?: string; // For auto-bid
    }
  ) {
    try {
      const { transactionId, buyerId, sellerId, quantity, amount } = details;

      // Resolve Users
      const buyerUser = await this.findUserByBecknId(buyerId || '');
      const sellerUser = await this.findUserByBecknId(sellerId || '');

      console.log(`[NotificationService] Resolved Users: Buyer=${buyerUser?._id}, Seller=${sellerUser?._id} for txn ${transactionId}`);

      const buyerName = buyerUser?.name || buyerId || "Buyer";
      const sellerName = sellerUser?.name || sellerId || "Seller";

      // Dispatch based on Type
      switch (type) {
        case 'ORDER_PURCHASE_SUCCESS':
          if (buyerUser) {
            await this.createNotification(
              buyerUser._id,
              type,
              "Purchase Successful",
              `Your purchase of ${quantity} units from ${sellerName} was successful.`,
              { ...details, buyerName, sellerName }
            );
          }
          break;

        case 'ORDER_SOLD':
          if (sellerUser) {
            await this.createNotification(
              sellerUser._id,
              type,
              "Energy Sold",
              `You have sold ${quantity} units to ${buyerName}.`,
              { ...details, buyerName, sellerName }
            );
          }
          break;

        case 'PUBLISH_SUCCESS':
          if (sellerUser) {
            await this.createNotification(
              sellerUser._id,
              type,
              "Catalog Published",
              `Your catalog with ${quantity} units has been successfully published.`,
              { ...details, sellerName }
            );
          }
          break;

        case 'AUTO_BID_PLACED':
          if (sellerUser) {
            await this.createNotification(
              sellerUser._id,
              type,
              "Auto-Bid Placed",
              `Auto-bid successfully placed for ${details.date}. Total quantity: ${quantity} units.`,
              { ...details, sellerName }
            );
          }
          break;
      }

      console.log(`[NotificationService] Handled ${type} for txn ${transactionId}`);

    } catch (error) {
      console.error(`[NotificationService] Error handling ${type}:`, error);
    }
  }
};
