import express from "express";
import request from "supertest";

import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from "../test-utils/db";
import { userRoutes } from "./routes";

// Mock the DB module to use test DB
jest.mock("../db", () => ({
  getDB: () => require("../test-utils/db").getTestDB(),
}));

jest.mock("../auth/routes", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.user = {
      phone: "1234567890",
      userId: "123456789012345678901234",
    };
    next();
  },
}));

describe("User Routes — GET /api/beneficiary-accounts", () => {
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
  });

  it("should return verified beneficiary accounts", async () => {
    const db = getTestDB();
    await db.collection("users").insertOne({
      phone: "9876543210",
      name: "Test Beneficiary",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 50,
      profiles: {
        consumptionProfile: { id: "did:rcw:consumer-001" },
        utilityCustomer: { did: "did:rcw:utility-001" },
      },
    });

    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0]).toEqual({
      id: "did:rcw:consumer-001",
      name: "Test Beneficiary",
      verified: true,
      type: "Verified Beneficiary",
      requiredEnergy: 50,
    });
  });

  it("should return empty array when no beneficiaries exist", async () => {
    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accounts).toEqual([]);
  });

  it("should only return users with vcVerified=true AND isVerifiedBeneficiary=true", async () => {
    const db = getTestDB();

    // vcVerified=true but isVerifiedBeneficiary=false — should NOT be returned
    await db.collection("users").insertOne({
      phone: "1111111111",
      name: "VC Verified Only",
      vcVerified: true,
      isVerifiedBeneficiary: false,
      requiredEnergy: 10,
      profiles: { consumptionProfile: { id: "did:rcw:vc-only" } },
    });

    // vcVerified=false but isVerifiedBeneficiary=true — should NOT be returned
    await db.collection("users").insertOne({
      phone: "2222222222",
      name: "Beneficiary Only",
      vcVerified: false,
      isVerifiedBeneficiary: true,
      requiredEnergy: 20,
      profiles: { consumptionProfile: { id: "did:rcw:beneficiary-only" } },
    });

    // Both true — should be returned
    await db.collection("users").insertOne({
      phone: "3333333333",
      name: "Fully Verified",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 30,
      profiles: { consumptionProfile: { id: "did:rcw:fully-verified" } },
    });

    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].name).toBe("Fully Verified");
  });

  it("should return id from consumptionProfile.id, fallback to utilityCustomer.did, fallback to phone", async () => {
    const db = getTestDB();

    // Has consumptionProfile.id — should use it
    await db.collection("users").insertOne({
      phone: "4444444444",
      name: "Has ConsumptionProfile",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 10,
      profiles: {
        consumptionProfile: { id: "did:rcw:consumption-id" },
        utilityCustomer: { did: "did:rcw:utility-id" },
      },
    });

    // No consumptionProfile.id, has utilityCustomer.did — should fallback
    await db.collection("users").insertOne({
      phone: "5555555555",
      name: "Has UtilityCustomer",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 20,
      profiles: {
        consumptionProfile: null,
        utilityCustomer: { did: "did:rcw:utility-fallback" },
      },
    });

    // No consumptionProfile.id, no utilityCustomer.did — should fallback to phone
    await db.collection("users").insertOne({
      phone: "6666666666",
      name: "Phone Fallback",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 30,
      profiles: {
        consumptionProfile: null,
        utilityCustomer: null,
      },
    });

    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(3);

    const byName = (name: string) => res.body.accounts.find((a: any) => a.name === name);

    expect(byName("Has ConsumptionProfile").id).toBe("did:rcw:consumption-id");
    expect(byName("Has UtilityCustomer").id).toBe("did:rcw:utility-fallback");
    expect(byName("Phone Fallback").id).toBe("6666666666");
  });

  it("should include name, verified, type, and requiredEnergy fields", async () => {
    const db = getTestDB();
    await db.collection("users").insertOne({
      phone: "7777777777",
      name: "Energy Beneficiary",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 75.5,
      profiles: {
        consumptionProfile: { id: "did:rcw:energy-ben" },
      },
    });

    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(200);
    const account = res.body.accounts[0];
    expect(account).toHaveProperty("id", "did:rcw:energy-ben");
    expect(account).toHaveProperty("name", "Energy Beneficiary");
    expect(account).toHaveProperty("verified", true);
    expect(account).toHaveProperty("type", "Verified Beneficiary");
    expect(account).toHaveProperty("requiredEnergy", 75.5);
  });

  it("should return 500 when DB query fails", async () => {
    // Override the DB mock to throw on find
    const { getDB } = require("../db");
    const realDb = getDB();
    const origCollection = realDb.collection.bind(realDb);
    jest.spyOn(realDb, "collection").mockImplementation((...args: unknown[]) => {
      const name = args[0] as string;
      if (name === "users") {
        return {
          find: () => {
            throw new Error("DB connection lost");
          },
        };
      }
      return origCollection(name);
    });

    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to fetch accounts");

    consoleSpy.mockRestore();
    (realDb.collection as jest.Mock).mockRestore();
  });

  it("should not expose sensitive fields like pin or email", async () => {
    const db = getTestDB();
    await db.collection("users").insertOne({
      phone: "8888888888",
      pin: "123456",
      email: "secret@example.com",
      name: "Sensitive User",
      vcVerified: true,
      isVerifiedBeneficiary: true,
      requiredEnergy: 25,
      profiles: {
        consumptionProfile: { id: "did:rcw:sensitive" },
      },
    });

    const res = await request(app).get("/api/beneficiary-accounts");

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);

    const account = res.body.accounts[0];
    expect(account).not.toHaveProperty("pin");
    expect(account).not.toHaveProperty("email");
    expect(account).not.toHaveProperty("phone");
    expect(account).not.toHaveProperty("profiles");

    // Only these 5 fields should be present
    expect(Object.keys(account).sort()).toEqual(
      ["id", "name", "requiredEnergy", "type", "verified"].sort()
    );
  });

});

describe("User Routes — GET /api/gifting-beneficiaries", () => {
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
  });

  it("should return verified gifting beneficiaries with full details", async () => {
    const db = getTestDB();
    const createdAt = new Date();
    await db.collection("users").insertOne({
      phone: "9876543210",
      name: "Gifting Beneficiary",
      vcVerified: true,
      isVerifiedGiftingBeneficiary: true,
      createdAt,
      meters: ["METER123"],
      profiles: {
        consumptionProfile: { id: "did:rcw:consumer-001" },
      },

    });

    const res = await request(app).get("/api/gifting-beneficiaries");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accounts).toHaveLength(1);

    const account = res.body.accounts[0];
    expect(account.phone).toBe("9876543210");
    expect(account.name).toBe("Gifting Beneficiary");
    expect(account.vcVerified).toBe(true);
    expect(account.verifiedGiftingBeneficiary).toBe(true);
    expect(account.role).toBe("consumer"); // No generation profile
    expect(account.meters).toEqual(["METER123"]);
    // Matches new structure: id from consumptionProfile
    expect(account.id).toBe("did:rcw:consumer-001");
    // Does not contain profiles or memberSince
    expect(account.profiles).toBeUndefined();
    expect(account.memberSince).toBeUndefined();
  });

  it("should correctly derive prosumer role", async () => {
    const db = getTestDB();
    await db.collection("users").insertOne({
      phone: "1234567890",
      name: "Prosumer User",
      vcVerified: true, // Required by new query
      isVerifiedGiftingBeneficiary: true,
      profiles: {
        generationProfile: { id: "did:rcw:gen-001" },
      },
    });

    const res = await request(app).get("/api/gifting-beneficiaries");

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].role).toBe("prosumer");
  });

  it("should return empty array when no gifting beneficiaries exist", async () => {
    const res = await request(app).get("/api/gifting-beneficiaries");
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([]);
  });

  it("should strictly filter by isVerifiedGiftingBeneficiary=true AND vcVerified=true", async () => {
    const db = getTestDB();

    // Not a gifting beneficiary
    await db.collection("users").insertOne({
      phone: "1111111111",
      name: "Regular User",
      vcVerified: true,
      isVerifiedGiftingBeneficiary: false,
    });

    // Gifting beneficiary but not vcVerified
    await db.collection("users").insertOne({
      phone: "3333333333",
      name: "Unverified User",
      vcVerified: false,
      isVerifiedGiftingBeneficiary: true,
    });

    // Gifting beneficiary and vcVerified
    await db.collection("users").insertOne({
      phone: "2222222222",
      name: "Target User",
      vcVerified: true,
      isVerifiedGiftingBeneficiary: true,
    });

    const res = await request(app).get("/api/gifting-beneficiaries");

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].name).toBe("Target User");
  });

  it("should return 500 when DB query fails", async () => {
    // Override the DB mock to throw on find
    const { getDB } = require("../db");
    const realDb = getDB();
    const origCollection = realDb.collection.bind(realDb);
    jest.spyOn(realDb, "collection").mockImplementation((...args: unknown[]) => {
      const name = args[0] as string;
      if (name === "users") {
        return {
          find: () => {
            throw new Error("DB connection lost");
          },
        };
      }
      return origCollection(name);
    });

    const consoleSpy = jest.spyOn(console, "error").mockImplementation();

    const res = await request(app).get("/api/gifting-beneficiaries");

    expect(res.status).toBe(500);
    // Step 106 shows explicit returns for failure
    // return res.status(500).json({ success:false, error: "Failed to fetch gifting beneficiaries" });
    expect(res.body.error).toBe("Failed to fetch gifting beneficiaries");

    consoleSpy.mockRestore();
    (realDb.collection as jest.Mock).mockRestore();
  });
});
