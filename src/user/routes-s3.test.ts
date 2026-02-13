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
        expect(S3Service.uploadFile).toHaveBeenCalledWith(
            expect.any(Buffer),
            expect.stringMatching(/^image\//)
        );

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
        expect(res.body.accounts[0].imageKey).toBe("contacts/images/existing-key-456");
    });

    it("should allow adding a contact without an image", async () => {
        const db = getTestDB();
        await db.collection("users").insertOne({
            phone: "5555555555",
            name: "No Image User",
            vcVerified: true,
            isVerifiedGiftingBeneficiary: true
        });

        const res = await request(app)
            .post("/api/contacts")
            .field("phone", "5555555555")
            .field("contactType", "Friend");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);


        const contact = await db.collection("contacts").findOne({
            userId: new ObjectId("123456789012345678901234")
        });
        expect(contact).toBeDefined();
        expect(contact?.imageKey).toBeUndefined();
        expect(contact?.contactType).toBe("Friend");
    });

    it("should handle S3 upload failure", async () => {
        const db = getTestDB();
        await db.collection("users").insertOne({
            phone: "1112223333",
            name: "Upload Fail User",
            vcVerified: true,
            isVerifiedGiftingBeneficiary: true
        });

        // Mock upload failure
        (S3Service.uploadFile as jest.Mock).mockRejectedValueOnce(new Error("S3 Error"));

        const res = await request(app)
            .post("/api/contacts")
            .field("phone", "1112223333")
            .attach("image", Buffer.from("fail"), "fail.jpg");

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe("Failed to upload image");
    });

    it("should allow adding contact without contactType", async () => {
        const db = getTestDB();
        await db.collection("users").insertOne({
            phone: "9988776655",
            name: "No Type User",
            vcVerified: true,
            isVerifiedGiftingBeneficiary: true
        });

        const res = await request(app)
            .post("/api/contacts")
            .field("phone", "9988776655");

        expect(res.status).toBe(200);

        const contact = await db.collection("contacts").findOne({
            userId: new ObjectId("123456789012345678901234")
        });
        expect(contact?.contactType).toBeUndefined();
    });

    it("should update existing contact with new image and type", async () => {
        const db = getTestDB();
        const myId = new ObjectId("123456789012345678901234");

        const contactUser = await db.collection("users").insertOne({
            phone: "1231231234",
            name: "Update User",
            vcVerified: true,
            isVerifiedGiftingBeneficiary: true
        });

        // Pre-existing contact
        await db.collection("contacts").insertOne({
            userId: myId,
            contactUserId: contactUser.insertedId,
            contactType: "OldType",
            imageKey: "old-key"
        });

        // Mock new upload
        (S3Service.uploadFile as jest.Mock).mockResolvedValueOnce("new-key-789");

        const res = await request(app)
            .post("/api/contacts")
            .field("phone", "1231231234")
            .field("contactType", "NewType")
            .attach("image", Buffer.from("new"), "new.jpg");

        expect(res.status).toBe(200);

        const updatedContact = await db.collection("contacts").findOne({
            userId: myId,
            contactUserId: contactUser.insertedId
        });

        expect(updatedContact?.contactType).toBe("NewType");
        expect(updatedContact?.imageKey).toBe("new-key-789");
    });
});
