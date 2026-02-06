/**
 * Tests for payment-service.ts
 */

import { paymentService, PaymentStatus } from "./payment-service";
import { razorpay } from "./razorpay";
import { getDB } from "../db";
import * as rzpUtils from "razorpay/dist/utils/razorpay-utils";

// Mock dependencies
jest.mock("../db", () => ({
    getDB: jest.fn(),
}));

jest.mock("./razorpay", () => ({
    razorpay: {
        orders: {
            create: jest.fn(),
        },
        paymentLink: {
            create: jest.fn()
        }
    },
    rzp_key_secret: "test_secret",
}));

jest.mock("razorpay/dist/utils/razorpay-utils", () => ({
    validatePaymentVerification: jest.fn(),
}));

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;
const mockedRzpCreateOrder = razorpay.orders.create as jest.Mock;
const mockedRzpCreateLink = razorpay.paymentLink.create as jest.Mock;
const mockedValidateVerification = rzpUtils.validatePaymentVerification as jest.Mock;

describe("PaymentService", () => {
    let mockCollection: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockCollection = {
            findOne: jest.fn(),
            updateOne: jest.fn(),
            insertOne: jest.fn(),
        };

        mockedGetDB.mockReturnValue({
            collection: jest.fn().mockReturnValue(mockCollection),
        } as any);
    });

    describe("createOrder", () => {
        it("should create razorpay order successfully", async () => {
            mockedRzpCreateOrder.mockResolvedValue({ id: "order_123", amount: 50000 });

            const result = await paymentService.createOrder(500, "INR", "rcpt_1");

            expect(mockedRzpCreateOrder).toHaveBeenCalledWith({
                amount: 50000, // 500 * 100
                currency: "INR",
                receipt: "rcpt_1",
                notes: undefined,
            });
            expect(result.id).toBe("order_123");
        });

        it("should throw error if creation fails", async () => {
            mockedRzpCreateOrder.mockRejectedValue(new Error("API Error"));

            await expect(paymentService.createOrder(100)).rejects.toThrow("API Error");
        });
    });

    describe("createPaymentLink", () => {
        it("should create payment link successfully", async () => {
            mockedRzpCreateLink.mockResolvedValue({ short_url: "http://pay.me" });
            const order = { id: "ord_1", amount: 100, currency: "INR", name: "Test", contact: "999" };

            const result = await paymentService.createPaymentLink(order);

            expect(mockedRzpCreateLink).toHaveBeenCalledWith(expect.objectContaining({
                amount: 100,
                reference_id: "ord_1"
            }));
            expect(result.short_url).toBe("http://pay.me");
        });
    });

    describe("verifyPayment", () => {
        it("should return true and update DB on valid signature", async () => {
            mockedValidateVerification.mockReturnValue(true);

            const result = await paymentService.verifyPayment(
                "ord_1",
                "pay_1",
                "sig_1",
                "link_1",
                "paid"
            );

            expect(mockedValidateVerification).toHaveBeenCalledWith(
                {
                    payment_link_id: "link_1",
                    payment_id: "pay_1",
                    payment_link_reference_id: "ord_1",
                    payment_link_status: "paid"
                },
                "sig_1",
                "test_secret"
            );

            expect(mockCollection.updateOne).toHaveBeenCalledWith(
                { orderId: "ord_1" },
                expect.objectContaining({
                    $set: expect.objectContaining({ status: PaymentStatus.PAID })
                })
            );
            expect(result).toBe(true);
        });

        it("should return false on invalid signature", async () => {
            mockedValidateVerification.mockReturnValue(false);

            const result = await paymentService.verifyPayment(
                "ord_1", "pay_1", "sig_1", "link_1", "paid"
            );

            expect(mockCollection.updateOne).not.toHaveBeenCalled();
            expect(result).toBe(false);
        });
    });

    describe("getPayment", () => {
        it("should return payment details", async () => {
            mockCollection.findOne.mockResolvedValue({ orderId: "ord_1", status: "paid" });

            const result = await paymentService.getPayment("ord_1");

            expect(result?.status).toBe("paid");
            expect(mockCollection.findOne).toHaveBeenCalledWith({ orderId: "ord_1" });
        });
    });
});
