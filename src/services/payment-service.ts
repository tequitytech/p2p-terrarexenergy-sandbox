import axios, { AxiosError } from "axios";
import { validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils";

import { getDB } from "../db";

import { razorpay, rzp_key_id, rzp_key_secret } from "./razorpay";

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
   * Verify SDK Payment Signature from Client
   */
  async verifyPaymentSdk(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    razorpaySignature: string,
  ): Promise<boolean> {
    const secret = rzp_key_secret;
    if (!secret) throw new Error("RAZORPAY_KEY_SECRET not configured");

    const isValid = validatePaymentVerification(
      {
        order_id: razorpayOrderId,
        payment_id: razorpayPaymentId,
      },
      razorpaySignature,
      secret,
    );

    console.log("isValidating SDK payment signature:", isValid);

    if (isValid) {
      const db = getDB();
      await db.collection<PaymentData>("payments").updateOne(
        { orderId: razorpayOrderId },
        {
          $set: {
            status: PaymentStatus.PAID,
            paymentId: razorpayPaymentId,
            razorpaySignature,
            updatedAt: new Date(),
          },
        },
      );
      return true;
    } else {
      console.warn(
        `[PaymentService] SDK Signature verification failed for order ${razorpayOrderId}`,
      );
      return false;
    }
  },

  /**
   * Refund a Payment
   */
  async refundPayment(paymentId: string, amount?: number): Promise<any> {
    try {
      const refundData: any = {};
      if (amount) {
        refundData.amount = Math.floor(amount * 100);
      }
      const refund = await razorpay.payments.refund(paymentId, refundData);
      console.log("[PaymentService] Refund processed:", refund);
      return refund;
    } catch (error: any) {
      console.error("[PaymentService] Error refunding payment:", error);
      throw error;
    }
  },

  /**
   * Get Payment Details
   */
  async getPayment(orderId: string): Promise<PaymentData | null> {
    const db = getDB();
    return await db.collection<PaymentData>("payments").findOne({ orderId });
  },

  /**
   * Helper to generate RazorpayX Auth Header
   */
  _getRazorpayXAuthHeader(): string {
    if (!rzp_key_id || !rzp_key_secret) {
      throw new Error("Razorpay keys not configured for Payouts");
    }
    return `Basic ${Buffer.from(`${rzp_key_id}:${rzp_key_secret}`).toString("base64")}`;
  },

  /**
   * Create a Razorpay Contact
   */
  async createContact(
    name: string,
    email?: string,
    contact?: string,
    referenceId?: string
  ): Promise<any> {
    try {
      const payload: any = {
        name,
        type: "vendor",
        reference_id: referenceId,
      };
      if (email) payload.email = email;
      if (contact) payload.contact = contact;

      const response = await axios.post(
        "https://api.razorpay.com/v1/contacts",
        payload,
        {
          headers: {
            Authorization: this._getRazorpayXAuthHeader(),
            "Content-Type": "application/json",
          },
        }
      );
      console.log("[PaymentService] Created Razorpay Contact:", response.data);
      return response.data;
    } catch (error: any) {
      console.error(
        "[PaymentService] Error creating Razorpay Contact:",
        error.response?.data || error.message
      );
      throw error;
    }
  },

  /**
   * Create a Razorpay Fund Account
   */
  async createFundAccount(
    contactId: string,
    accountType: "bank_account" | "vpa",
    details: {
      name: string;
      ifsc?: string;
      account_number?: string;
      address?: string; // For vpa
    }
  ): Promise<any> {
    try {
      const payload: any = {
        contact_id: contactId,
        account_type: accountType,
      };

      if (accountType === "bank_account") {
        payload.bank_account = {
          name: details.name,
          ifsc: details.ifsc,
          account_number: details.account_number,
        };
      } else if (accountType === "vpa") {
        payload.vpa = {
          address: details.address,
        };
      }

      const response = await axios.post(
        "https://api.razorpay.com/v1/fund_accounts",
        payload,
        {
          headers: {
            Authorization: this._getRazorpayXAuthHeader(),
            "Content-Type": "application/json",
          },
        }
      );
      console.log(
        "[PaymentService] Created Razorpay Fund Account:",
        response.data
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "[PaymentService] Error creating Razorpay Fund Account:",
        error.response?.data || error.message
      );
      throw error;
    }
  },

  /**
   * Get Fund Account details from RazorpayX
   */
  async getFundAccount(fundAccountId: string): Promise<any> {
    try {
      const response = await axios.get(
        `https://api.razorpay.com/v1/fund_accounts/${fundAccountId}`,
        {
          headers: {
            Authorization: this._getRazorpayXAuthHeader(),
          },
        }
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "[PaymentService] Error fetching Razorpay Fund Account:",
        error.response?.data || error.message
      );
      throw error;
    }
  },

  /**
   * Process a Payout to a Seller
   */
  async processSellerPayout(
    fundAccountId: string,
    amount: number,
    transactionId: string,
    currency: string = "INR"
  ): Promise<any> {
    try {
      // Fetch fund account details to determine correct mode
      const fundAccount = await this.getFundAccount(fundAccountId);
      const isVpa = fundAccount.account_type === "vpa";

      const payload = {
        account_number: process.env.RZP_X_ACCOUNT_NUMBER || "2323230045468789", // Using configured account or test default
        fund_account_id: fundAccountId,
        amount: Math.floor(amount * 100), // amount in paise
        currency,
        mode: isVpa ? "UPI" : "IMPS",
        purpose: "payout",
        queue_if_low_balance: true,
        reference_id: transactionId,
        narration: "P2P Energy Trade Settlement",
      };

      const response = await axios.post(
        "https://api.razorpay.com/v1/payouts",
        payload,
        {
          headers: {
            Authorization: this._getRazorpayXAuthHeader(),
            "Content-Type": "application/json",
          },
        }
      );
      console.log(
        "[PaymentService] Payout Initiated successfully:",
        response.data
      );
      return response.data;
    } catch (error: any) {
      console.error(
        "[PaymentService] Error processing Seller Payout:",
        error.response?.data || error.message
      );
      throw error;
    }
  },

  /**
   * Validate a fund account (bank or VPA) via RazorpayX /fund_accounts/validations.
   * Polls until `status === "completed"` and returns the full result synchronously.
   * In test mode, skips polling and returns a mocked result immediately.
   */
  async validateBankAccount(
    accountNumberOrVpa: string, // bank account number or UPI address
    ifsc: string,               // IFSC for bank accounts; ignored for VPA
    holderName: string = "Customer",
    options: { pollIntervalMs?: number; maxWaitMs?: number } = {}
  ): Promise<any> {
    const { pollIntervalMs = 3000, maxWaitMs = 45000 } = options;
    const isTestMode = (rzp_key_id || "").startsWith("rzp_test_");
    const isVpa = !ifsc || ifsc === "";

    // Build fund_account payload based on type
    const fundAccount: any = { account_type: isVpa ? "vpa" : "bank_account" };
    if (isVpa) {
      fundAccount.vpa = { address: accountNumberOrVpa };
    } else {
      fundAccount.bank_account = {
        name: holderName,
        ifsc,
        account_number: accountNumberOrVpa,
      };
    }
    console.log("Fund Account>>", fundAccount);
    const payload: any = {
      account_number: process.env.RZP_X_ACCOUNT_NUMBER || "2323230045468789",
      fund_account: fundAccount,
      notes: { purpose: "payout_verification" },
    };

    if (!isVpa) {
      payload.amount = 100; // 1 INR (in paise)
      payload.currency = "INR";
    }

    console.log("Payload:", payload);
    const authHeader = this._getRazorpayXAuthHeader();

    let validationId: string;
    try {
      const createResp = await axios.post(
        "https://api.razorpay.com/v1/fund_accounts/validations",
        payload,
        { headers: { Authorization: authHeader, "Content-Type": "application/json" } }
      );
      console.log("Create Response>>>", createResp.data);
      validationId = createResp.data.id;
      console.log(`[PaymentService] Bank validation created: ${validationId}${isTestMode ? " (TEST MODE — skipping poll)" : " — polling for result..."}`);

      // Early exit if already completed or failed
      if (createResp.data.status === "completed") {
        console.log(`[PaymentService] Validation completed immediately for ${validationId}`);
        return createResp.data;
      } else if (createResp.data.status === "failed") {
        console.log(`[PaymentService] Validation failed immediately for ${validationId}`);
        throw new Error("Bank account validation failed. Please check your details.");
      }

      // In test mode, Razorpay never completes the validation — return mock response
      if (isTestMode) {
        return {
          ...createResp.data,
          status: "completed",
          results: {
            account_status: "valid",
            registered_name: "Test Customer",
          },
          _testMode: true,
        };
      }
    } catch (error: any) {
      console.error(
        "[PaymentService] Error initiating bank account validation:",
        error.response?.data || error.message
      );
      throw error;
    }

    // Step 2: Poll until completed or timeout (Live mode only)
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      try {
        const statusResp = await axios.get(
          `https://api.razorpay.com/v1/fund_accounts/validations/${validationId}`,
          { headers: { Authorization: authHeader } }
        );

        const data = statusResp.data;
        console.log(`[PaymentService] Bank validation status: ${data.status}`);

        if (data.status === "completed") {
          return data; // results.registered_name will now be populated
        } else if (data.status === "failed") {
          throw new Error("Bank account validation failed. Please check your details.");
        }
        // else "created" or "pending" — keep polling
      } catch (pollError: any) {
        // If it's a non-axios error (our own thrown error), re-throw immediately
        if (!pollError.response) throw pollError;
        console.warn(`[PaymentService] Polling error:`, pollError.response?.data || pollError.message);
      }
    }

    throw new Error("Bank account validation timed out. Please try again.");
  },
};
