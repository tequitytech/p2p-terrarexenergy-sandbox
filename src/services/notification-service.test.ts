/**
 * Tests for notification-service.ts
 */

import { notificationService } from "./notification-service";
import { emailService } from "./email-service";
import { getDB } from "../db";
import { ObjectId } from "mongodb";

// Mock dependencies
jest.mock("../db", () => ({
    getDB: jest.fn(),
}));

jest.mock("./email-service", () => ({
    emailService: {
        sendEmail: jest.fn(),
    },
}));

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;
const mockedSendEmail = emailService.sendEmail as jest.Mock;

describe("NotificationService", () => {
    let mockCollection: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockCollection = {
            findOne: jest.fn(),
        };

        mockedGetDB.mockReturnValue({
            collection: jest.fn().mockReturnValue(mockCollection),
        } as any);
    });

    describe("sendOrderConfirmation", () => {
        const transactionId = "txn-123";
        const order = {
            "beckn:buyer": { "beckn:id": "did:buyer:123" },
            "beckn:seller": { "beckn:id": "did:seller:456" },
            "beckn:orderItems": [
                { "beckn:quantity": { unitQuantity: 10 } },
                { "beckn:quantity": { unitQuantity: 20 } },
            ],
            "beckn:payment": { "beckn:amount": { value: 100 } },
        };

        it("should send confirmation email if buyer found with email", async () => {
            mockCollection.findOne.mockResolvedValue({
                email: "buyer@example.com",
                name: "Test Buyer",
            });

            await notificationService.sendOrderConfirmation(transactionId, order);

            expect(mockCollection.findOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    $or: expect.arrayContaining([
                        { "profiles.consumptionProfile.id": "did:buyer:123" }
                    ])
                })
            );

            expect(mockedSendEmail).toHaveBeenCalledWith(
                "buyer@example.com",
                expect.stringContaining(transactionId),
                expect.stringContaining("30 kWh") // Total quantity
            );
        });

        it("should log and return if no user found", async () => {
            mockCollection.findOne.mockResolvedValue(null);
            const consoleSpy = jest.spyOn(console, "log").mockImplementation();

            await notificationService.sendOrderConfirmation(transactionId, order);

            expect(mockedSendEmail).not.toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("skipping notification"));

            consoleSpy.mockRestore();
        });

        it("should log and return if user has no email", async () => {
            mockCollection.findOne.mockResolvedValue({ name: "No Email" });
            const consoleSpy = jest.spyOn(console, "log").mockImplementation();

            await notificationService.sendOrderConfirmation(transactionId, order);

            expect(mockedSendEmail).not.toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("skipping notification"));

            consoleSpy.mockRestore();
        });

        it("should handle missing buyer ID", async () => {
            const consoleSpy = jest.spyOn(console, "log").mockImplementation();
            await notificationService.sendOrderConfirmation(transactionId, {}); // No buyer

            expect(mockedGetDB).not.toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No buyer ID found"));

            consoleSpy.mockRestore();
        });

        it("should handle error gracefully", async () => {
            mockCollection.findOne.mockRejectedValue(new Error("DB Error"));
            const consoleSpy = jest.spyOn(console, "error").mockImplementation();

            await notificationService.sendOrderConfirmation(transactionId, order);

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error processing order confirmation"), expect.any(Error));

            consoleSpy.mockRestore();
        });
    });
});
