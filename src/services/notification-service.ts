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
      console.error(`[NotificationService] Error creating notification for ${userId}:`, error);
      // We might want to throw here if DB write fails, depending on criticality
      // For now, logging error.
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
  }
};
