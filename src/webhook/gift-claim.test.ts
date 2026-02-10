import axios from "axios";

import { computeClaimVerifier, validateGiftClaim } from "../utils";
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from "../test-utils/db";
import { onSelect, onInit, onConfirm } from "./controller";

import type { Request, Response } from "express";

// Mock DB module to use in-memory MongoDB
jest.mock("../db", () => {
  const { getTestDB } = require("../test-utils/db");
  return { getDB: () => getTestDB() };
});

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock utils — keep all real implementations, mock readDomainResponse
jest.mock("../utils", () => {
  const actual = jest.requireActual("../utils");
  return {
    ...actual,
    readDomainResponse: jest.fn(),
  };
});

// Mock uuid
jest.mock("uuid", () => ({
  v4: jest.fn(() => "test-uuid-gift"),
}));

// Mock payment service
jest.mock("../services/payment-service", () => ({
  paymentService: {
    createOrder: jest.fn().mockResolvedValue({ id: "rzp_order_test", amount: 0, currency: "INR" }),
    createPaymentLink: jest.fn().mockResolvedValue({ short_url: "https://rzp.io/gift-test" }),
  },
}));

// Mock settlement store
jest.mock("../services/settlement-store", () => ({
  settlementStore: {
    createSettlement: jest.fn().mockResolvedValue(undefined),
    getSettlement: jest.fn().mockResolvedValue(null),
  },
}));

// Helper to create mock Request
const mockRequest = (body: any): Partial<Request> => ({ body });

// Helper to create mock Response
const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// ── Shared fixtures ──

const KNOWN_SECRET = "Ab3xK9mP";
const KNOWN_VERIFIER = computeClaimVerifier(KNOWN_SECRET);

const seedGiftOffer = async (overrides: Record<string, any> = {}) => {
  const db = getTestDB();
  await db.collection("items").insertOne({
    "beckn:id": "gift-item-001",
    "beckn:itemAttributes": { sourceType: "SOLAR", availableQuantity: 10, meterId: "100200300" },
    "beckn:provider": "did:example:gifter",
    catalogId: "catalog-001",
  });
  await db.collection("offers").insertOne({
    "beckn:id": "gift-offer-001",
    "beckn:items": ["gift-item-001"],
    "beckn:provider": "did:example:gifter",
    "beckn:price": {
      "schema:price": 0,
      "schema:priceCurrency": "INR",
      applicableQuantity: { unitQuantity: 5, unitText: "kWh" },
    },
    "beckn:offerAttributes": {
      gift: { lookupHash: "hash123", claimVerifier: KNOWN_VERIFIER, expiresAt: "2026-12-01T00:00:00Z" },
    },
    isGift: true,
    giftStatus: "UNCLAIMED",
    claimVerifier: KNOWN_VERIFIER,
    claimSecret: KNOWN_SECRET,
    recipientPhone: "+919123456789",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    catalogId: "catalog-001",
    ...overrides,
  });
};

const seedNormalOffer = async () => {
  const db = getTestDB();
  await db.collection("items").insertOne({
    "beckn:id": "normal-item-001",
    "beckn:itemAttributes": { sourceType: "SOLAR", availableQuantity: 20, meterId: "100200301" },
    "beckn:provider": "did:example:seller",
    catalogId: "catalog-002",
  });
  await db.collection("offers").insertOne({
    "beckn:id": "normal-offer-001",
    "beckn:items": ["normal-item-001"],
    "beckn:provider": "did:example:seller",
    "beckn:price": {
      "schema:price": 5.0,
      "schema:priceCurrency": "INR",
      applicableQuantity: { unitQuantity: 20, unitText: "kWh" },
    },
    "beckn:offerAttributes": {
      pricingModel: "PER_KWH",
    },
    catalogId: "catalog-002",
  });
  // Also seed catalog for republish in onConfirm
  await db.collection("catalogs").insertOne({
    "beckn:id": "catalog-002",
    "beckn:descriptor": { "schema:name": "Normal Catalog" },
    "beckn:bppId": "test-bpp",
    "beckn:isActive": true,
  });
};

const buildBecknContext = (action: string) => ({
  bpp_uri: "http://bpp:8082/path",
  action,
  domain: "beckn.one:deg:p2p-trading",
  bap_id: "test-bap",
  bpp_id: "test-bpp",
  transaction_id: "txn-gift-001",
  message_id: "msg-gift-001",
});

const buildSelectRequest = (claimSecret?: string) => ({
  context: buildBecknContext("select"),
  message: {
    order: {
      "beckn:buyer": { "beckn:id": "did:example:recipient", "@context": "ctx", "@type": "beckn:Buyer" },
      "beckn:seller": "did:example:gifter",
      "beckn:orderItems": [{
        "beckn:id": "gift-item-001",
        "beckn:orderedItem": "gift-item-001",
        "beckn:quantity": { unitQuantity: 5, unitText: "kWh" },
        "beckn:acceptedOffer": {
          "beckn:id": "gift-offer-001",
          ...(claimSecret !== undefined && {
            "beckn:offerAttributes": { gift: { claimSecret } },
          }),
        },
      }],
    },
  },
});

const buildInitRequest = (claimSecret?: string) => ({
  context: buildBecknContext("init"),
  message: {
    order: {
      "beckn:id": "order-gift-001",
      "beckn:buyer": { "beckn:id": "did:example:recipient" },
      "beckn:seller": "did:example:gifter",
      "beckn:orderItems": [{
        "beckn:orderedItem": "gift-item-001",
        "beckn:quantity": { unitQuantity: 5, unitText: "kWh" },
        "beckn:acceptedOffer": {
          "beckn:id": "gift-offer-001",
          "beckn:price": { "schema:price": 0, "schema:priceCurrency": "INR" },
          ...(claimSecret !== undefined && {
            "beckn:offerAttributes": { gift: { claimSecret } },
          }),
        },
      }],
      "beckn:payment": { "beckn:id": "pay-001" },
      "beckn:fulfillment": { "beckn:id": "ful-001" },
    },
  },
});

const buildConfirmRequest = (claimSecret?: string) => ({
  context: buildBecknContext("confirm"),
  message: {
    order: {
      "beckn:id": "order-gift-001",
      "beckn:buyer": { "beckn:id": "did:example:recipient" },
      "beckn:seller": "did:example:gifter",
      "beckn:orderItems": [{
        "beckn:orderedItem": "gift-item-001",
        "beckn:quantity": { unitQuantity: 5, unitText: "kWh" },
        "beckn:acceptedOffer": {
          "beckn:id": "gift-offer-001",
          ...(claimSecret !== undefined && {
            "beckn:offerAttributes": { gift: { claimSecret } },
          }),
        },
      }],
      "beckn:orderAttributes": { total_quantity: { unitQuantity: 5, unitText: "kWh" } },
    },
  },
});

// ── Tests ──

describe("Gift Claim Validation", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearTestDB();
    mockedAxios.post.mockResolvedValue({ data: { message: { ack: { status: "ACK" } } } });
  });

  // ── Group 1: validateGiftClaim unit tests ──

  describe("validateGiftClaim (unit)", () => {
    it("returns null for non-gift offer", () => {
      const offer = { isGift: false };
      expect(validateGiftClaim(offer, "anything")).toBeNull();
    });

    it("returns null for valid secret + UNCLAIMED + not expired", () => {
      const offer = {
        isGift: true,
        giftStatus: "UNCLAIMED",
        claimVerifier: KNOWN_VERIFIER,
        expiresAt: new Date("2099-01-01"),
      };
      expect(validateGiftClaim(offer, KNOWN_SECRET)).toBeNull();
    });

    it("returns GIFT_CLAIM_FAILED for wrong secret", () => {
      const offer = {
        isGift: true,
        giftStatus: "UNCLAIMED",
        claimVerifier: KNOWN_VERIFIER,
        expiresAt: new Date("2099-01-01"),
      };
      const result = validateGiftClaim(offer, "WrongSecret");
      expect(result).toEqual({ code: "GIFT_CLAIM_FAILED", message: expect.any(String) });
    });

    it("returns GIFT_CLAIM_FAILED for missing (undefined) secret", () => {
      const offer = {
        isGift: true,
        giftStatus: "UNCLAIMED",
        claimVerifier: KNOWN_VERIFIER,
      };
      const result = validateGiftClaim(offer, undefined);
      expect(result).toEqual({ code: "GIFT_CLAIM_FAILED", message: expect.any(String) });
    });

    it("returns GIFT_ALREADY_CLAIMED when giftStatus is CLAIMED", () => {
      const offer = {
        isGift: true,
        giftStatus: "CLAIMED",
        claimVerifier: KNOWN_VERIFIER,
      };
      const result = validateGiftClaim(offer, KNOWN_SECRET);
      expect(result).toEqual({ code: "GIFT_ALREADY_CLAIMED", message: "This gift has already been claimed" });
    });

    it("returns GIFT_REVOKED when giftStatus is REVOKED", () => {
      const offer = {
        isGift: true,
        giftStatus: "REVOKED",
        claimVerifier: KNOWN_VERIFIER,
      };
      const result = validateGiftClaim(offer, KNOWN_SECRET);
      expect(result).toEqual({ code: "GIFT_REVOKED", message: "This gift has been revoked by the sender" });
    });

    it("returns GIFT_EXPIRED when offer is expired", () => {
      const offer = {
        isGift: true,
        giftStatus: "UNCLAIMED",
        claimVerifier: KNOWN_VERIFIER,
        expiresAt: new Date("2020-01-01"),
      };
      const result = validateGiftClaim(offer, KNOWN_SECRET);
      expect(result).toEqual({ code: "GIFT_EXPIRED", message: "This gift has expired" });
    });

    it("returns GIFT_EXPIRED (not CLAIM_FAILED) when expired + wrong secret", () => {
      const offer = {
        isGift: true,
        giftStatus: "UNCLAIMED",
        claimVerifier: KNOWN_VERIFIER,
        expiresAt: new Date("2020-01-01"),
      };
      // Expiry takes priority over bad secret
      const result = validateGiftClaim(offer, "WrongSecret");
      expect(result?.code).toBe("GIFT_EXPIRED");
    });
  });

  // ── Group 2: onSelect integration ──

  describe("onSelect — gift validation", () => {
    it("non-gift offer proceeds normally (regression)", async () => {
      await seedNormalOffer();

      const req = mockRequest({
        context: buildBecknContext("select"),
        message: {
          order: {
            "beckn:buyer": { "beckn:id": "did:example:buyer" },
            "beckn:seller": "did:example:seller",
            "beckn:orderItems": [{
              "beckn:id": "normal-item-001",
              "beckn:quantity": { unitQuantity: 5, unitText: "kWh" },
              "beckn:acceptedOffer": { "beckn:id": "normal-offer-001" },
            }],
          },
        },
      });
      const res = mockResponse();
      onSelect(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);

      // Wait for async callback
      await new Promise((r) => setTimeout(r, 200));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("CREATED");
    });

    it("gift + valid secret returns quote", async () => {
      await seedGiftOffer();

      const req = mockRequest(buildSelectRequest(KNOWN_SECRET));
      const res = mockResponse();
      onSelect(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);

      await new Promise((r) => setTimeout(r, 200));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("CREATED");
    });

    it("gift + wrong secret sends GIFT_CLAIM_FAILED callback", async () => {
      await seedGiftOffer();

      const req = mockRequest(buildSelectRequest("WrongSecret"));
      const res = mockResponse();
      onSelect(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 200));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("REJECTED");
      expect(callPayload.error.code).toBe("GIFT_CLAIM_FAILED");
    });

    it("gift + expired sends GIFT_EXPIRED callback", async () => {
      await seedGiftOffer({ expiresAt: new Date("2020-01-01") });

      const req = mockRequest(buildSelectRequest(KNOWN_SECRET));
      const res = mockResponse();
      onSelect(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 200));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_EXPIRED");
    });

    it("gift + already claimed sends GIFT_ALREADY_CLAIMED callback", async () => {
      await seedGiftOffer({ giftStatus: "CLAIMED" });

      const req = mockRequest(buildSelectRequest(KNOWN_SECRET));
      const res = mockResponse();
      onSelect(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 200));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_ALREADY_CLAIMED");
    });

    it("gift + missing secret sends GIFT_CLAIM_FAILED callback", async () => {
      await seedGiftOffer();

      // Build request without claimSecret (undefined omits the field)
      const req = mockRequest(buildSelectRequest(undefined));
      const res = mockResponse();
      onSelect(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 200));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_CLAIM_FAILED");
    });
  });

  // ── Group 3: onInit integration ──

  describe("onInit — gift validation", () => {
    it("gift + valid secret proceeds with normal init flow", async () => {
      await seedGiftOffer();

      const req = mockRequest(buildInitRequest(KNOWN_SECRET));
      const res = mockResponse();
      onInit(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 300));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("CREATED");
    });

    it("gift + wrong secret sends GIFT_CLAIM_FAILED callback", async () => {
      await seedGiftOffer();

      const req = mockRequest(buildInitRequest("WrongSecret"));
      const res = mockResponse();
      onInit(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 300));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("REJECTED");
      expect(callPayload.error.code).toBe("GIFT_CLAIM_FAILED");
    });

    it("gift + expired sends GIFT_EXPIRED callback", async () => {
      await seedGiftOffer({ expiresAt: new Date("2020-01-01") });

      const req = mockRequest(buildInitRequest(KNOWN_SECRET));
      const res = mockResponse();
      onInit(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 300));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_EXPIRED");
    });

    it("non-gift offer proceeds normally (regression)", async () => {
      await seedNormalOffer();

      const req = mockRequest({
        context: buildBecknContext("init"),
        message: {
          order: {
            "beckn:id": "order-normal-001",
            "beckn:buyer": { "beckn:id": "did:example:buyer" },
            "beckn:seller": "did:example:seller",
            "beckn:orderItems": [{
              "beckn:orderedItem": "normal-item-001",
              "beckn:quantity": { unitQuantity: 5, unitText: "kWh" },
              "beckn:acceptedOffer": {
                "beckn:id": "normal-offer-001",
                "beckn:price": { "schema:price": 5.0, "schema:priceCurrency": "INR" },
              },
            }],
            "beckn:payment": { "beckn:id": "pay-001" },
            "beckn:fulfillment": { "beckn:id": "ful-001" },
          },
        },
      });
      const res = mockResponse();
      onInit(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 300));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("CREATED");
    });
  });

  // ── Group 4: onConfirm + finalization ──

  describe("onConfirm — gift validation + finalization", () => {
    it("gift + valid secret sets giftStatus=CLAIMED, claimedAt, claimedBy", async () => {
      await seedGiftOffer();
      // Also seed catalog for republish
      const db = getTestDB();
      await db.collection("catalogs").insertOne({
        "beckn:id": "catalog-001",
        "beckn:descriptor": { "schema:name": "Gift Catalog" },
        "beckn:bppId": "test-bpp",
        "beckn:isActive": true,
      });

      const req = mockRequest(buildConfirmRequest(KNOWN_SECRET));
      const res = mockResponse();
      onConfirm(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 500));

      // Verify DB state
      const offer = await db.collection("offers").findOne({ "beckn:id": "gift-offer-001" });
      expect(offer?.giftStatus).toBe("CLAIMED");
      expect(offer?.claimedAt).toBeInstanceOf(Date);
      expect(offer?.claimedBy).toBe("did:example:recipient");
    });

    it("gift + wrong secret sends error callback, giftStatus remains UNCLAIMED", async () => {
      await seedGiftOffer();

      const req = mockRequest(buildConfirmRequest("WrongSecret"));
      const res = mockResponse();
      onConfirm(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 300));

      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_CLAIM_FAILED");
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("REJECTED");

      // Verify DB — still UNCLAIMED
      const db = getTestDB();
      const offer = await db.collection("offers").findOne({ "beckn:id": "gift-offer-001" });
      expect(offer?.giftStatus).toBe("UNCLAIMED");
    });

    it("gift + expired sends error callback", async () => {
      await seedGiftOffer({ expiresAt: new Date("2020-01-01") });

      const req = mockRequest(buildConfirmRequest(KNOWN_SECRET));
      const res = mockResponse();
      onConfirm(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 300));
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_EXPIRED");
    });

    it("logs [GIFT] on successful claim", async () => {
      await seedGiftOffer();
      const db = getTestDB();
      await db.collection("catalogs").insertOne({
        "beckn:id": "catalog-001",
        "beckn:descriptor": { "schema:name": "Gift Catalog" },
        "beckn:bppId": "test-bpp",
        "beckn:isActive": true,
      });

      const consoleSpy = jest.spyOn(console, "log");

      const req = mockRequest(buildConfirmRequest(KNOWN_SECRET));
      const res = mockResponse();
      onConfirm(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 500));

      const giftLogCall = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("[GIFT]"),
      );
      expect(giftLogCall).toBeDefined();
      expect(giftLogCall![0]).toContain("gift-offer-001");
      expect(giftLogCall![0]).toContain("did:example:recipient");

      consoleSpy.mockRestore();
    });

    it("normal offer proceeds without gift claim (regression)", async () => {
      await seedNormalOffer();

      const req = mockRequest({
        context: buildBecknContext("confirm"),
        message: {
          order: {
            "beckn:id": "order-normal-001",
            "beckn:buyer": { "beckn:id": "did:example:buyer" },
            "beckn:seller": "did:example:seller",
            "beckn:orderItems": [{
              "beckn:orderedItem": "normal-item-001",
              "beckn:quantity": { unitQuantity: 5, unitText: "kWh" },
              "beckn:acceptedOffer": {
                "beckn:id": "normal-offer-001",
              },
            }],
            "beckn:orderAttributes": { total_quantity: { unitQuantity: 5, unitText: "kWh" } },
          },
        },
      });
      const res = mockResponse();
      onConfirm(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 500));

      // Should have sent on_confirm callback (not rejection)
      // The last axios call should be the callback (there may be a republish call before it)
      const confirmCalls = mockedAxios.post.mock.calls.filter(
        (c) => (c[1] as any)?.context?.action === "on_confirm",
      );
      expect(confirmCalls.length).toBeGreaterThan(0);
      const confirmPayload = confirmCalls[0][1] as any;
      expect(confirmPayload.message.order["beckn:orderStatus"]).toBe("CONFIRMED");
    });

    it("concurrent claims: first succeeds, second gets GIFT_ALREADY_CLAIMED", async () => {
      await seedGiftOffer();
      const db = getTestDB();
      await db.collection("catalogs").insertOne({
        "beckn:id": "catalog-001",
        "beckn:descriptor": { "schema:name": "Gift Catalog" },
        "beckn:bppId": "test-bpp",
        "beckn:isActive": true,
      });

      // First claim
      const req1 = mockRequest(buildConfirmRequest(KNOWN_SECRET));
      const res1 = mockResponse();
      onConfirm(req1 as Request, res1 as Response);
      await new Promise((r) => setTimeout(r, 500));

      // Verify first claim succeeded
      const offer = await db.collection("offers").findOne({ "beckn:id": "gift-offer-001" });
      expect(offer?.giftStatus).toBe("CLAIMED");

      // Second claim attempt (same offer, now CLAIMED)
      jest.clearAllMocks();
      mockedAxios.post.mockResolvedValue({ data: { message: { ack: { status: "ACK" } } } });

      const req2 = mockRequest(buildConfirmRequest(KNOWN_SECRET));
      const res2 = mockResponse();
      onConfirm(req2 as Request, res2 as Response);
      await new Promise((r) => setTimeout(r, 300));

      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.error.code).toBe("GIFT_ALREADY_CLAIMED");
    });

    it("order is saved correctly after gift claim", async () => {
      await seedGiftOffer();
      const db = getTestDB();
      await db.collection("catalogs").insertOne({
        "beckn:id": "catalog-001",
        "beckn:descriptor": { "schema:name": "Gift Catalog" },
        "beckn:bppId": "test-bpp",
        "beckn:isActive": true,
      });

      const req = mockRequest(buildConfirmRequest(KNOWN_SECRET));
      const res = mockResponse();
      onConfirm(req as Request, res as Response);

      await new Promise((r) => setTimeout(r, 500));

      const savedOrder = await db.collection("orders").findOne({ transactionId: "txn-gift-001" });
      expect(savedOrder).toBeTruthy();
      expect(savedOrder?.order["beckn:orderStatus"]).toBe("CONFIRMED");
    });
  });
});
