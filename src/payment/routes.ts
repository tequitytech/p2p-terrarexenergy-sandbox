import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { paymentService } from "../services/payment-service";
import { getDB } from "../db";
import { ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../auth/routes";
import { orderService } from "../services/order-service";

// Extend Request type to include rawBody if we capture it in app.ts
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export interface PaymentData {
  _id?: ObjectId;
  orderId: string; // Razorpay order_id
  paymentId?: string; // Razorpay payment_id
  amount: number;
  currency: string;
  receipt?: string;
  contact?: string; // Link to user,
  email?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  razorpaySignature?: string;
  webhookEvents?: any[];
  preferred_auth?: string[];
  callback_url?: string;
  transaction_id?: string;
}

export enum PaymentStatus {
  CREATED = "created",
  ATTEMPTED = "attempted",
  PAID = "paid", // successful
  FAILED = "failed",
  REFUNDED = "refunded",
}

export const paymentRoutes = () => {
  const router = Router();

  // --- Zod Schemas ---
  const paymentOrderSchema = z.object({
    amount: z.number().min(1, "Amount must be greater than 0"),
    currency: z.string().min(1, "Currency is required"),
    receipt: z.string().optional(),
    notes: z.record(z.string(), z.any()).optional(),
    userPhone: z.string().optional(),
    transactionId: z.string().optional(),
    meterId: z.string().min(1, "meterId is required"),
    sourceMeterId: z.string().min(1, "sourceMeterId is required"),
    messageId: z.string().min(1, "messageId is required"),
    items: z.record(z.string(), z.any()).optional(), // Add items to schema
  });

  // --- Middleware ---
  function validateBody(schema: z.ZodSchema) {
    return (req: Request, res: Response, next: NextFunction) => {
      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: result.error.issues.map((e: z.ZodIssue) => ({
              field: e.path.join("."),
              message: e.message,
            })),
          },
        });
      }
      next();
    };
  }

  // POST /api/payment/order - Create a new payment order
  router.post(
    "/payment/order",
    authMiddleware,
    validateBody(paymentOrderSchema),
    async (req: Request, res: Response) => {
      try {
        const {
          amount,
          currency,
          notes,
          userPhone,
          meterId,
          sourceMeterId,
          messageId,
          items,
        } = req.body;
        let { transactionId } = req.body;

        console.log("req.body", req.body);

        const phone = (req as any).user?.phone || userPhone;
        const db = getDB();
        const user = await db.collection("users").findOne({ phone });

        if (!user) {
          return res.status(404).json({
            success: false,
            error: {
              code: "INVALID_USER",
              message: "User Not Found",
            },
          });
        }
        const userId = (req as any)?.user?.userId || user._id.toString();

        transactionId = transactionId || uuidv4();
        // If user is authenticated via middleware (available in req.user), use that phone

        const order = await paymentService.createOrder(
          amount,
          currency,
          transactionId,
          notes,
        );
        console.log("Created Razorpay order:", order);

        const txnBody = {
          userPhone: phone,
          userId: userId,
          status: "pending",
          amount,
          currency,
          orderId: order.id,
          transaction_id: transactionId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        let trnsResp = await db
          .collection<PaymentData>("payments")
          .insertOne(txnBody);
        console.log("Created payment db transaction:", trnsResp);

        const paymentLink = await paymentService.createPaymentLink({
          amount: order.amount,
          currency,
          id: order.id,
          contact: phone,
          name: notes?.name || "Customer",
        });
        console.log("Created Razorpay payment link:", paymentLink);

        // --- Save Buyer Order ---
        await orderService.saveBuyerOrder(transactionId, {
          userId: userId,
          userPhone: phone,
          razorpayOrderId: order.id,
          txnPayId: trnsResp.insertedId,
          meterId,
          sourceMeterId,
          messageId,
          items: items || {}, // Store items
          status: "INITIATED",
          transaction_id: transactionId,
          type: "buyer",
        });
        console.log(
          `[Payment] Saved buyer order ${transactionId} with RZP order ${order.id}`,
        );

        res.json({
          success: true,
          data: {
            url: paymentLink.short_url,
            orderId: order.id,
          },
        });
      } catch (error: any) {
        console.error("[API] Error creating payment order:", error);
        return res.status(500).json({
          success: false,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create payment order",
            details: error.message,
          },
        });
      }
    },
  );

  router.get("/payment-callback", async (req, res) => {
    const {
      razorpay_payment_id,
      razorpay_payment_link_id,
      razorpay_payment_link_reference_id,
      razorpay_payment_link_status,
      razorpay_signature,
    } = req.query;
    console.log("Payment callback received:", req.query);

    if (
      !razorpay_payment_id ||
      !razorpay_payment_link_id ||
      !razorpay_payment_link_reference_id ||
      !razorpay_signature ||
      !razorpay_payment_link_status
    ) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_CALLBACK",
          message: "Invalid Payment Callback parameters",
        },
      });
    }

    const isValid = await paymentService.verifyPayment(
      razorpay_payment_link_reference_id as string,
      razorpay_payment_id as string,
      razorpay_signature as string,
      razorpay_payment_link_id as string,
      razorpay_payment_link_status as string,
    );

    if (isValid) {
      // --- Update Buyer Order Status ---
      const razorpayOrderId = razorpay_payment_link_reference_id as string;

      // Find the transactionId associated with this Razorpay Order ID
      const db = getDB();
      const buyerOrder = await db
        .collection("buyer_orders")
        .findOne({ razorpayOrderId });

      if (buyerOrder) {
        const transactionId = buyerOrder.transactionId;

        await orderService.updateBuyerOrderStatus(transactionId, "SCHEDULED", {
          paymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
        });
        console.log(`[Callback] Buyer Order ${transactionId} marked as SCHEDULED`);
      } else {
        console.warn(
          `[Callback] Buyer Order not found for RZP Order ${razorpayOrderId}`,
        );
      }

      res.status(200).json({
        success: true,
        data: {
          message: "Payment Successful",
          details: {
            rzpPaymentId: razorpay_payment_id,
            rzpPaymentLinkId: razorpay_payment_link_id,
            rzpOrderId: razorpay_payment_link_reference_id,
          },
        },
      });
    } else {
      res.status(400).json({
        success: false,
        error: {
          code: "VERIFICATION_FAILED",
          message: "Payment verification failed",
        },
      });
    }
  });

  // GET /api/payment/:orderId - Get status
  router.get("/payment/:orderId", async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const id = Array.isArray(orderId) ? orderId[0] : orderId;
      const payment = await paymentService.getPayment(id);

      if (!payment) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Payment not found",
          },
        });
      }

      res.json({ success: true, data: payment });
    } catch (error: any) {
      console.error("[API] Error fetching payment:", error);
      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch payment details",
          details: error.message,
        },
      });
    }
  });

  return router;
};
