
import { notificationService } from "../services/notification-service";
import { orderService } from "../services/order-service";
import { settlementStore } from "../services/settlement-store";
import { resolvePendingTransaction, hasPendingTransaction } from "../services/transaction-store";

import type { Request, Response } from "express";

export const onSelect = (req: Request, res: Response) => {
  const { context, message, error }: { context: any; message: any; error?: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_select received, txn: ${transactionId}`);
  if (error) {
    console.log(`[BAP Webhook] on_select ERROR:`, JSON.stringify(error, null, 2));
  } else {
    console.log(JSON.stringify({message, context}, null, 2));
  }

  // Resolve pending sync transaction if exists (include error if present)
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message, error });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onInit = (req: Request, res: Response) => {
  const { context, message, error }: { context: any; message: any; error?: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_init received, txn: ${transactionId}`);
  if (error) {
    console.log(`[BAP Webhook] on_init ERROR:`, JSON.stringify(error, null, 2));
  } else {
    console.log(JSON.stringify({message, context}, null, 2));
  }

  // Resolve pending sync transaction if exists (include error if present)
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message, error });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onConfirm = (req: Request, res: Response) => {
  const { context, message, error }: { context: any; message: any; error?: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_confirm received, txn: ${transactionId}`);
  if (error) {
    console.log(`[BAP Webhook] on_confirm ERROR:`, JSON.stringify(error, null, 2));
  } else {
    console.log(JSON.stringify({message, context}, null, 2));
  }

  // Resolve pending sync transaction if exists (include error if present)
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message, error });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  // Create settlement record for buyer-side tracking (async, don't block response)
  if (transactionId && !error && message?.order) {
    (async () => {
      try {
        const order = message.order;
        const orderItems = order?.['beckn:orderItems'] || [];

        // Calculate total quantity
        const totalQuantity = orderItems.reduce((sum: number, item: any) => {
          const qty = item['beckn:quantity']?.unitQuantity || 0;
          return sum + qty;
        }, 0);

        const orderItemId = orderItems[0]?.['beckn:orderedItem'] ||
                           orderItems[0]?.['beckn:id'] ||
                           `item-${transactionId}`;

        // Extract counterparty (seller) info
        const sellerPlatformId = context?.bpp_id || null;
        const sellerDiscomId = order?.['beckn:orderAttributes']?.utilityIdSeller || null;

        // Calculate costs
        let totalUnitCost = 0;
        orderItems.forEach((item: any) => {
          const qty = item['beckn:quantity']?.unitQuantity || 0;
          const acceptedOffer = item['beckn:acceptedOffer'];
          const price = acceptedOffer?.['beckn:offerAttributes']?.['beckn:price']?.value ||
            acceptedOffer?.['beckn:price']?.['schema:price'] ||
            acceptedOffer?.['beckn:price']?.value ||
            0;
          totalUnitCost += qty * price;
        });

        const wheelingCharges = totalQuantity * 0.40;
        const totalPrice = totalUnitCost + wheelingCharges;

        /**
         * Store the full Beckn order details in the buyer_orders collection for reference
         */
        if (order) {
          await orderService.saveBuyerOrder(transactionId, {
            order: order,
            totalUnitCost: Number(totalUnitCost.toFixed(2)),
            wheelingCharges: Number(wheelingCharges.toFixed(2)),
            totalPrice: Number(totalPrice.toFixed(2)),
            status: 'SCHEDULED',
            updatedAt: new Date()
          });
          console.log(`[BAP-Webhook] Buyer Order ${transactionId} updated with cost details and Beckn order`);
        }

        await settlementStore.createSettlement(
          transactionId,
          orderItemId,
          totalQuantity,
          'BUYER',
          sellerPlatformId,
          sellerDiscomId
        );
        console.log(`[BAP Webhook] Settlement record created: txn=${transactionId}, role=BUYER, qty=${totalQuantity}`);


        // --- Send Email Notification ---
        await notificationService.sendOrderConfirmation(transactionId, order);
        // -------------------------------


      } catch (err: any) {
        console.error(`[BAP Webhook] Failed to create settlement record: ${err.message}`);
      }
    })();
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onStatus = (req: Request, res: Response) => {
  const { context, message }: { context: any; message: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_status received, txn: ${transactionId}`);
  console.log(JSON.stringify({message, context}, null, 2));

  // Resolve pending sync transaction if exists
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onUpdate = (req: Request, res: Response) => {
  const { context, message }: { context: any; message: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_update received, txn: ${transactionId}`);
  console.log(JSON.stringify({message, context}, null, 2));

  // Resolve pending sync transaction if exists
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onRating = (req: Request, res: Response) => {
  const { context, message }: { context: any; message: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_rating received, txn: ${transactionId}`);
  console.log(JSON.stringify({message, context}, null, 2));

  // Resolve pending sync transaction if exists
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onSupport = (req: Request, res: Response) => {
  const { context, message }: { context: any; message: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_support received, txn: ${transactionId}`);
  console.log(JSON.stringify({message, context}, null, 2));

  // Resolve pending sync transaction if exists
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onTrack = (req: Request, res: Response) => {
  const { context, message }: { context: any; message: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_track received, txn: ${transactionId}`);
  console.log(JSON.stringify({message, context}, null, 2));

  // Resolve pending sync transaction if exists
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};

export const onCancel = (req: Request, res: Response) => {
  const { context, message }: { context: any; message: any } = req.body;
  const transactionId = context?.transaction_id;

  console.log(`[BAP Webhook] on_cancel received, txn: ${transactionId}`);
  console.log(JSON.stringify({message, context}, null, 2));

  // Resolve pending sync transaction if exists
  if (transactionId && hasPendingTransaction(transactionId)) {
    resolvePendingTransaction(transactionId, { context, message });
    console.log(`[BAP Webhook] Resolved pending transaction: ${transactionId}`);
  }

  return res.status(200).json({message: {ack: {status: "ACK"}}});
};
