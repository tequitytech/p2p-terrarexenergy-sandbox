import { getDB } from "../db";
import { emailService } from "./email-service";

export const notificationService = {
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
