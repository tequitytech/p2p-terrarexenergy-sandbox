import axios, { AxiosError } from "axios";
import { validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils";

import { getDB } from "../db";

import { razorpay, rzp_key_secret } from "./razorpay";

import type { ObjectId } from "mongodb";

export enum PaymentStatus {
  CREATED = "created",
  ATTEMPTED = "attempted",
  PAID = "paid", // successful
  FAILED = "failed",
  REFUNDED = "refunded",
}

export interface PaymentData {
  _id?: ObjectId;
  orderId: string; // Razorpay order_id
  paymentId?: string; // Razorpay payment_id
  amount: number;
  currency: string;
  receipt?: string;
  status: PaymentStatus;
  userPhone?: string; // Link to user
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  razorpaySignature?: string;
  webhookEvents?: any[];
}

export const paymentService = {
  /**
   * Create a Razorpay Order
   */
  async createOrder(
    amount: number,
    currency: string = "INR",
    receipt?: string,
    notes?: any
  ): Promise<any> {
    try {
      const options = {
        amount: Math.floor(amount * 100), // amount in smallest currency unit (paise)
        currency,
        receipt,
        notes,
      };

      const order = await razorpay.orders.create(options);

      return order;
    } catch (error: any) {
      console.error("[PaymentService] Error creating order:", error);
      throw error;
    }
  },

  async createPaymentLink(order: any) {
    console.log("Creating payment link for order>>>:", order);
    try {
      const linkResp = await razorpay.paymentLink.create({
        amount: order.amount,
        currency: order.currency,
        accept_partial: false,
        reference_id: order.id, // Store Order ID as reference
        description: "Payment for Order " + order.id,
        customer: {
          name: order.name,
          contact: order.contact,
        },
        notify: { sms: true },
        callback_url: "https://p2p.terrarexenergy.com/api/payment-callback", // Important for WebView
        callback_method: "get",
      });
      console.log("Payment link response:", linkResp);
      return linkResp;
    } catch (error) {
      console.log("Error creating payment link:", error);
      if (error instanceof AxiosError) {
        return error.response?.data;
      }
      throw error;
    }
  },

  /**
   * Verify Payment Signature from Client
   */
  async verifyPayment(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    razorpaySignature: string,
    razorpayPaymentLinkId: string,
    razorpayPaymentLinkStatus: string,
  ): Promise<boolean> {
    const secret = rzp_key_secret;
    if (!secret) throw new Error("RAZORPAY_KEY_SECRET not configured");

    const isValid = validatePaymentVerification(
      {
        payment_link_id: razorpayPaymentLinkId,
        payment_id: razorpayPaymentId,
        payment_link_reference_id: razorpayOrderId,
        payment_link_status: razorpayPaymentLinkStatus,
      },
      razorpaySignature,
      secret,
    );

    console.log("isValidating payment signature:", isValid);

    if (isValid) {
      const status = Object.values(PaymentStatus).includes(
        razorpayPaymentLinkStatus as PaymentStatus,
      )
        ? (razorpayPaymentLinkStatus as PaymentStatus)
        : PaymentStatus.FAILED;

      const db = getDB();
      await db.collection<PaymentData>("payments").updateOne(
        { orderId: razorpayOrderId },
        {
          $set: {
            status: status,
            paymentId: razorpayPaymentId,
            razorpaySignature,
            updatedAt: new Date(),
          },
        },
      );
      return true;
    } else {
      console.warn(
        `[PaymentService] Signature verification failed for order ${razorpayOrderId}`,
      );
      return false;
    }
  },

  /**
   * Get Payment Details
   */
  async getPayment(orderId: string): Promise<PaymentData | null> {
    const db = getDB();
    return await db.collection<PaymentData>("payments").findOne({ orderId });
  },
};
