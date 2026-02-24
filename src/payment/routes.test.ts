import express from "express";
import request from "supertest";


import { authMiddleware } from "../auth/routes";
import { getDB } from "../db";
import { orderService } from "../services/order-service";
import { paymentService } from "../services/payment-service";

import { paymentRoutes } from "./routes";

// --- Mocks ---
jest.mock("../services/payment-service");
jest.mock("../db");
jest.mock("../auth/routes");
jest.mock("../services/order-service");
jest.mock("uuid", () => ({
    v4: jest.fn(() => "test-transaction-id-uuid"),
}));

const mockPaymentService = paymentService as jest.Mocked<typeof paymentService>;
const mockGetDB = getDB as jest.MockedFunction<typeof getDB>;
const mockAuthMiddleware = authMiddleware as jest.MockedFunction<typeof authMiddleware>;
const mockOrderService = orderService as jest.Mocked<typeof orderService>;

describe("Payment Routes", () => {
    let app: express.Express;
    let mockDb: any;
    let mockCollection: any;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use("/api", paymentRoutes());

        // Reset mocks
        jest.clearAllMocks();

        // Setup DB Mock
        mockCollection = {
            insertOne: jest.fn(),
            updateOne: jest.fn(),
            findOne: jest.fn(),
        };
        mockDb = {
            collection: jest.fn().mockReturnValue(mockCollection),
        };
        mockGetDB.mockReturnValue(mockDb);

        // Default Auth Middleware Mock (Pass through with userId)
        mockAuthMiddleware.mockImplementation((req, res, next) => {
            (req as any).user = { phone: "1234567890", userId: "aaaaaaaaaaaaaaaaaaaaaaaa" };
            next();
            return undefined as any;
        });
    });

    describe("POST /api/payment/order", () => {
        const validOrderData = {
            amount: 100,
            currency: "INR",
            notes: { name: "Test User" },
            userPhone: "9876543210",
            meterId: "meter-123",
            sourceMeterId: "source-meter-456",
            messageId: "msg-789",
        };

        it("should create Razorpay order, save to DB, generate payment link, and save buyer order", async () => {
            const mockOrder = { id: "order_123", amount: 10000 };
            const mockPaymentLink = { short_url: "https://razorpay.com/pl_123" };

            mockPaymentService.createOrder.mockResolvedValue(mockOrder);
            mockPaymentService.createPaymentLink.mockResolvedValue(mockPaymentLink);
            mockCollection.insertOne.mockResolvedValue({ insertedId: "db_id" });
            mockOrderService.saveBuyerOrder.mockResolvedValue(undefined as any);

            const response = await request(app)
                .post("/api/payment/order")
                .send(validOrderData);

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                success: true,
                data: {
                    orderId: mockOrder.id,
                    transactionId: "test-transaction-id-uuid",
                },
            });

            // Verify Razorpay order creation
            expect(mockPaymentService.createOrder).toHaveBeenCalledWith(
                validOrderData.amount,
                validOrderData.currency,
                "test-transaction-id-uuid",
                validOrderData.notes
            );

            // Verify payment record saved to DB
            expect(mockCollection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
                amount: validOrderData.amount,
                currency: validOrderData.currency,
                orderId: mockOrder.id,
                transaction_id: "test-transaction-id-uuid",
                status: "pending",
                userPhone: "1234567890",
                userId: "aaaaaaaaaaaaaaaaaaaaaaaa",
            }));
        });

        it("should return 400 validation error for missing required fields", async () => {
            const invalidData = { ...validOrderData, amount: -1 }; // Invalid amount
            delete (invalidData as any).currency; // Missing currency

            const response = await request(app)
                .post("/api/payment/order")
                .send(invalidData);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VALIDATION_ERROR");
        });

        it("should return 400 when amount is zero", async () => {
            const response = await request(app)
                .post("/api/payment/order")
                .send({ ...validOrderData, amount: 0 });

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VALIDATION_ERROR");
            expect(response.body.error.details).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        field: "amount",
                        message: expect.stringContaining("greater than 0"),
                    }),
                ]),
            );
        });

        it("should return 400 when sourceMeterId is missing", async () => {
            const { sourceMeterId, ...noSourceMeter } = validOrderData;

            const response = await request(app)
                .post("/api/payment/order")
                .send(noSourceMeter);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VALIDATION_ERROR");
            expect(response.body.error.details).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        field: "sourceMeterId",
                    }),
                ]),
            );
        });

        it("should fall back to userPhone from request body when req.user is not set", async () => {
            // Override auth middleware to NOT set req.user (simulating pass-through without auth context)
            mockAuthMiddleware.mockImplementation((req, res, next) => {
                next();
                return undefined as any;
            });

            // When userId is absent, route looks up user by phone in the users collection
            const { ObjectId } = require("mongodb");
            mockCollection.findOne.mockResolvedValue({
                _id: new ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb"),
                phone: "9876543210",
            });

            mockPaymentService.createOrder.mockResolvedValue({ id: "order_123", amount: 10000 });
            mockPaymentService.createPaymentLink.mockResolvedValue({ short_url: "url" });
            mockCollection.insertOne.mockResolvedValue({ insertedId: "db_id" });
            mockOrderService.saveBuyerOrder.mockResolvedValue(undefined as any);

            const response = await request(app).post("/api/payment/order").send(validOrderData);

            expect(response.status).toBe(200);

            // userId should come from the DB lookup
            expect(mockOrderService.saveBuyerOrder).toHaveBeenCalledWith(
                "test-transaction-id-uuid",
                expect.objectContaining({
                    userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
                    userPhone: validOrderData.userPhone,
                })
            );
        });
    });

    describe("POST /api/payment/verify", () => {
        const validVerifyData = {
            razorpay_order_id: "order_sdk_123",
            razorpay_payment_id: "pay_sdk_456",
            razorpay_signature: "sig_sdk_789"
        };

        it("should verify payment successfully and update buyer order to PAID", async () => {
            mockPaymentService.verifyPaymentSdk.mockResolvedValue(true);
            mockCollection.findOne.mockResolvedValue({
                transactionId: "txn-sdk-123",
                razorpayOrderId: "order_sdk_123",
            });
            mockOrderService.updateBuyerOrderStatus.mockResolvedValue(undefined as any);

            const response = await request(app)
                .post("/api/payment/verify")
                .send(validVerifyData);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(mockPaymentService.verifyPaymentSdk).toHaveBeenCalledWith(
                validVerifyData.razorpay_order_id,
                validVerifyData.razorpay_payment_id,
                validVerifyData.razorpay_signature
            );

            // Verify buyer_orders collection queried
            expect(mockDb.collection).toHaveBeenCalledWith("buyer_orders");
            expect(mockCollection.findOne).toHaveBeenCalledWith({
                razorpayOrderId: "order_sdk_123",
            });

            // Verify order status updated to PAID
            expect(mockOrderService.updateBuyerOrderStatus).toHaveBeenCalledWith(
                "txn-sdk-123",
                "PAID",
                {
                    paymentId: validVerifyData.razorpay_payment_id,
                    razorpaySignature: validVerifyData.razorpay_signature,
                },
            );
        });

        it("should return 400 for missing body parameters", async () => {
            const invalidData = { ...validVerifyData };
            delete (invalidData as any).razorpay_signature;

            const response = await request(app)
                .post("/api/payment/verify")
                .send(invalidData);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VALIDATION_ERROR");
        });

        it("should return 400 if SDK signature verification fails", async () => {
            mockPaymentService.verifyPaymentSdk.mockResolvedValue(false);

            const response = await request(app)
                .post("/api/payment/verify")
                .send(validVerifyData);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VERIFICATION_FAILED");

            expect(mockOrderService.updateBuyerOrderStatus).not.toHaveBeenCalled();
        });
    });

    describe("POST /api/payment/refund", () => {
        it("should successfully refund a payment and update DB statuses", async () => {
            mockCollection.findOne.mockResolvedValue({
                transaction_id: "txn-refund-123",
                paymentId: "pay_refund_456",
                status: "paid"
            });
            mockPaymentService.refundPayment.mockResolvedValue({ id: "rfnd_123" });
            mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });
            mockOrderService.updateBuyerOrderStatus.mockResolvedValue(undefined as any);

            const response = await request(app)
                .post("/api/payment/refund")
                .send({ transactionId: "txn-refund-123" });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.message).toBe("Refund processed successfully");

            expect(mockCollection.findOne).toHaveBeenCalledWith({ transaction_id: "txn-refund-123" });
            expect(mockPaymentService.refundPayment).toHaveBeenCalledWith("pay_refund_456");

            // Verify payment record updated
            expect(mockCollection.updateOne).toHaveBeenCalledWith(
                { transaction_id: "txn-refund-123" },
                expect.objectContaining({
                    $set: expect.objectContaining({ status: "refunded" })
                })
            );

            // Verify buyer order status updated
            expect(mockOrderService.updateBuyerOrderStatus).toHaveBeenCalledWith(
                "txn-refund-123",
                "REFUNDED",
                {}
            );
        });

        it("should return 400 if transactionId is missing", async () => {
            const response = await request(app).post("/api/payment/refund").send({});

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VALIDATION_ERROR");
        });

        it("should return 404 if payment document not found", async () => {
            mockCollection.findOne.mockResolvedValue(null);

            const response = await request(app)
                .post("/api/payment/refund")
                .send({ transactionId: "unknown-txn" });

            expect(response.status).toBe(404);
            expect(response.body.error.code).toBe("NOT_FOUND");
        });

        it("should return 400 if payment does not have a paymentId", async () => {
            mockCollection.findOne.mockResolvedValue({
                transaction_id: "txn-nopay",
                status: "created"
                // No paymentId
            });

            const response = await request(app)
                .post("/api/payment/refund")
                .send({ transactionId: "txn-nopay" });

            expect(response.status).toBe(400);
            expect(response.body.error.code).toBe("BAD_REQUEST");
        });

        it("should return 400 if payment is already refunded", async () => {
            mockCollection.findOne.mockResolvedValue({
                transaction_id: "txn-already-refunded",
                paymentId: "pay_123",
                status: "refunded"
            });

            const response = await request(app)
                .post("/api/payment/refund")
                .send({ transactionId: "txn-already-refunded" });

            expect(response.status).toBe(400);
            expect(response.body.error.code).toBe("ALREADY_REFUNDED");
        });
    });

    describe("GET /api/payment-callback", () => {
        const validQuery = {
            razorpay_payment_id: "pay_123",
            razorpay_payment_link_id: "plink_123",
            razorpay_payment_link_reference_id: "order_123",
            razorpay_payment_link_status: "paid",
            razorpay_signature: "signature_123",
        };

        it("should verify payment successfully", async () => {
            mockPaymentService.verifyPayment.mockResolvedValue(true);

            const response = await request(app)
                .get("/api/payment-callback")
                .query(validQuery);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(mockPaymentService.verifyPayment).toHaveBeenCalledWith(
                validQuery.razorpay_payment_link_reference_id,
                validQuery.razorpay_payment_id,
                validQuery.razorpay_signature,
                validQuery.razorpay_payment_link_id,
                validQuery.razorpay_payment_link_status
            );
        });

        it("should update buyer order status to SCHEDULED after successful verification", async () => {
            mockPaymentService.verifyPayment.mockResolvedValue(true);
            mockCollection.findOne.mockResolvedValue({
                transactionId: "txn-abc-123",
                razorpayOrderId: validQuery.razorpay_payment_link_reference_id,
            });
            mockOrderService.updateBuyerOrderStatus.mockResolvedValue(undefined as any);

            const response = await request(app)
                .get("/api/payment-callback")
                .query(validQuery);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);

            // Verify buyer_orders collection was queried
            expect(mockDb.collection).toHaveBeenCalledWith("buyer_orders");
            expect(mockCollection.findOne).toHaveBeenCalledWith({
                razorpayOrderId: validQuery.razorpay_payment_link_reference_id,
            });

            // Verify order status updated to SCHEDULED with payment details
            expect(mockOrderService.updateBuyerOrderStatus).toHaveBeenCalledWith(
                "txn-abc-123",
                "SCHEDULED",
                {
                    paymentId: validQuery.razorpay_payment_id,
                    razorpaySignature: validQuery.razorpay_signature,
                },
            );
        });

        it("should warn when buyer order not found for razorpayOrderId after verification", async () => {
            mockPaymentService.verifyPayment.mockResolvedValue(true);
            mockCollection.findOne.mockResolvedValue(null);

            const warnSpy = jest.spyOn(console, "warn").mockImplementation();

            const response = await request(app)
                .get("/api/payment-callback")
                .query(validQuery);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);

            // Should NOT call updateBuyerOrderStatus
            expect(mockOrderService.updateBuyerOrderStatus).not.toHaveBeenCalled();

            // Should log a warning
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Buyer Order not found"),
            );

            warnSpy.mockRestore();
        });

        it("should return 400 if verification fails", async () => {
            mockPaymentService.verifyPayment.mockResolvedValue(false);

            const response = await request(app)
                .get("/api/payment-callback")
                .query(validQuery);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VERIFICATION_FAILED");
        });

        it("should not update order status when verification fails", async () => {
            mockPaymentService.verifyPayment.mockResolvedValue(false);

            await request(app)
                .get("/api/payment-callback")
                .query(validQuery);

            // Should NOT attempt to look up buyer order or update status
            expect(mockCollection.findOne).not.toHaveBeenCalled();
            expect(mockOrderService.updateBuyerOrderStatus).not.toHaveBeenCalled();
        });

        it("should return 400 for missing query parameters", async () => {
            const invalidQuery = { ...validQuery };
            delete (invalidQuery as any).razorpay_signature;

            const response = await request(app)
                .get("/api/payment-callback")
                .query(invalidQuery);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("INVALID_CALLBACK");
        });
    });

    describe("GET /api/payment/:orderId", () => {
        it("should successfully fetch payment details", async () => {
            const mockPayment = { orderId: "order_123", status: "paid" };
            mockPaymentService.getPayment.mockResolvedValue(mockPayment as any);

            const response = await request(app).get("/api/payment/order_123");

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual(mockPayment);
            expect(mockPaymentService.getPayment).toHaveBeenCalledWith("order_123");
        });

        it("should return 404 if payment not found", async () => {
            mockPaymentService.getPayment.mockResolvedValue(null);

            const response = await request(app).get("/api/payment/unknown_order");

            expect(response.status).toBe(404);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("NOT_FOUND");
        });

        it("should handle service errors", async () => {
            mockPaymentService.getPayment.mockRejectedValue(new Error("DB Error"));

            const response = await request(app).get("/api/payment/order_123");

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.error.details).toBe("DB Error");
        });
    });
});
