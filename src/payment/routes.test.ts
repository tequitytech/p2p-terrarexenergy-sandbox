import request from "supertest";
import express from "express";
import { paymentRoutes } from "./routes";
import { paymentService } from "../services/payment-service";
import { getDB } from "../db";
import { authMiddleware } from "../auth/routes";
import { orderService } from "../services/order-service";

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
                    url: mockPaymentLink.short_url,
                    orderId: mockOrder.id,
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

            // Verify payment link uses authenticated user's phone
            expect(mockPaymentService.createPaymentLink).toHaveBeenCalledWith({
                amount: mockOrder.amount,
                currency: validOrderData.currency,
                id: mockOrder.id,
                contact: "1234567890",
                name: "Test User",
            });

            // Verify buyer order saved via orderService
            expect(mockOrderService.saveBuyerOrder).toHaveBeenCalledWith(
                "test-transaction-id-uuid",
                expect.objectContaining({
                    userId: "aaaaaaaaaaaaaaaaaaaaaaaa",
                    userPhone: "1234567890",
                    razorpayOrderId: mockOrder.id,
                    meterId: validOrderData.meterId,
                    sourceMeterId: validOrderData.sourceMeterId,
                    messageId: validOrderData.messageId,
                    status: "INITIATED",
                    type: "buyer",
                })
            );
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

        it("should use userPhone from body if not authenticated", async () => {
            // Override auth middleware to NOT set user (simulate unauthenticated but middleware passed - or different middleware usage)
            // Note: The actual route uses `authMiddleware`, so req.user SHOULD be present if it passes.
            // However, the code allows fall back: `const phone = (req as any).user?.phone || userPhone;`
            // We can test this fallback by mocking auth middleware to NOT attach user but call next()
            mockAuthMiddleware.mockImplementation((req, res, next) => {
                next();
                return undefined as any;
            });

            mockPaymentService.createOrder.mockResolvedValue({ id: "order_123", amount: 10000 });
            mockPaymentService.createPaymentLink.mockResolvedValue({ short_url: "url" });
            mockCollection.insertOne.mockResolvedValue({});

            await request(app).post("/api/payment/order").send(validOrderData);

            expect(mockPaymentService.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
                contact: validOrderData.userPhone // Should fall back to body param
            }));
        });

        it("should handle internal service errors", async () => {
            mockPaymentService.createOrder.mockRejectedValue(new Error("Razorpay Error"));

            const response = await request(app)
                .post("/api/payment/order")
                .send(validOrderData);

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
            expect(response.body.error.details).toBe("Razorpay Error");
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

        it("should return 400 if verification fails", async () => {
            mockPaymentService.verifyPayment.mockResolvedValue(false);

            const response = await request(app)
                .get("/api/payment-callback")
                .query(validQuery);

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error.code).toBe("VERIFICATION_FAILED");
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
