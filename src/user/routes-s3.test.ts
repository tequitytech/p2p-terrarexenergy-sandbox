import express from "express";
import request from "supertest";
import { ObjectId } from "mongodb";
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from "../test-utils/db";
import { userRoutes } from "./routes";
import { S3Service } from "../services/s3-service";

// Mock S3Service
jest.mock("../services/s3-service", () => ({
    S3Service: {
        uploadFile: jest.fn().mockResolvedValue("contacts/images/test-key-123")
    }
}));

// Mock DB
jest.mock("../db", () => ({
    getDB: () => require("../test-utils/db").getTestDB(),
}));

// Mock Auth
jest.mock("../auth/routes", () => ({
    authMiddleware: (req: any, res: any, next: any) => {
        req.user = {
            phone: "1234567890",
            userId: "123456789012345678901234",
        };
        next();
    },
}));

describe("Contact Routes with S3 and Types", () => {
    let app: express.Express;

    beforeAll(async () => {
        await setupTestDB();
    });

    afterAll(async () => {
        await teardownTestDB();
    });

    beforeEach(async () => {
        await clearTestDB();
        app = express();
        app.use(express.json());
        app.use("/api", userRoutes());
        jest.clearAllMocks();
    });

    it("should upload image and save contact with type", async () => {
        const db = getTestDB();

        // Create verify-able user
        const contactUser = await db.collection("users").insertOne({
            phone: "9876543210",
            name: "Contact User",
            vcVerified: true,
            isVerifiedGiftingBeneficiary: true
        });

        const res = await request(app)
            .post("/api/contacts")
            .field("phone", "9876543210")
            .field("contactType", "School")
            .attach("image", Buffer.from("fake-image"), "test-image.jpg");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(S3Service.uploadFile).toHaveBeenCalled();

        const contact = await db.collection("contacts").findOne({
            userId: new ObjectId("123456789012345678901234"),
            contactUserId: contactUser.insertedId
        });

        expect(contact).toBeDefined();
        expect(contact?.contactType).toBe("School");
        // Expect 'imageKey' to be saved, matching the mock return value
        expect(contact?.imageKey).toBe("contacts/images/test-key-123");
    });

    it("should return imageKey and type in gifting-beneficiaries", async () => {
        const db = getTestDB();
        const myId = new ObjectId("123456789012345678901234");

        // Create contact user
        const contactUser = await db.collection("users").insertOne({
            phone: "9876543210",
            name: "Contact User",
            vcVerified: true,
            isVerifiedGiftingBeneficiary: true,
            profiles: { consumptionProfile: { id: "did:rcw:123" } }
        });

        // Add to contacts with imageKey and type
        await db.collection("contacts").insertOne({
            userId: myId,
            contactUserId: contactUser.insertedId,
            contactType: "Clinic",
            imageKey: "contacts/images/existing-key-456",
            updatedAt: new Date()
        });

        const res = await request(app).get("/api/gifting-beneficiaries");

        expect(res.status).toBe(200);
        expect(res.body.accounts).toHaveLength(1);
        expect(res.body.accounts[0].contactType).toBe("Clinic");
        // Expect 'imageKey' in the response
        expect(res.body.accounts[0].imageKey).toBe("contacts/images/existing-key-456");
    });
});
