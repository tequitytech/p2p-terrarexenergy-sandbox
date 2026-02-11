import axios from "axios";


import { readDomainResponse } from "../utils";
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from "../test-utils/db";

import {
  validateContext,
  getCallbackUrl,
  calculateDeliveryProgress,
  onSelect,
  onConfirm,
  onUpdate,
  onRating,
  onSupport,
  onTrack,
  onCancel,
} from "./controller";

import type { Request, Response } from "express";

// Mock DB module to use in-memory MongoDB
jest.mock("../db", () => {
  const { getTestDB } = require("../test-utils/db");
  return { getDB: () => getTestDB() };
});

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock utils — keep parseError working, mock readDomainResponse
jest.mock("../utils", () => {
  const actual = jest.requireActual("../utils");
  return {
    ...actual,
    readDomainResponse: jest.fn(),
  };
});
const mockedReadDomainResponse = readDomainResponse as jest.MockedFunction<
  typeof readDomainResponse
>;

// Mock uuid to return predictable values
jest.mock("uuid", () => ({
  v4: jest.fn(() => "test-uuid-1234"),
}));

// Mock payment service (used by onInit, referenced in onConfirm flow isn't needed for these tests)
jest.mock("../services/payment-service", () => ({
  paymentService: {
    createOrder: jest.fn().mockResolvedValue({ id: "rzp_order_test", amount: 10000, currency: "INR" }),
    createPaymentLink: jest.fn().mockResolvedValue({ short_url: "https://rzp.io/test" }),
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

describe("Webhook Controller", () => {
  const originalEnv = process.env;

  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
    process.env = originalEnv;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearTestDB();
    // Reset environment variables
    process.env = { ...originalEnv };
    delete process.env.BPP_CALLBACK_ENDPOINT;
    delete process.env.PERSONA;
  });

  describe("validateContext", () => {
    it("should return invalid for null context", () => {
      const result = validateContext(null);
      expect(result).toEqual({ valid: false, error: "Missing context" });
    });

    it("should return invalid for undefined context", () => {
      const result = validateContext(undefined);
      expect(result).toEqual({ valid: false, error: "Missing context" });
    });

    it("should return invalid for empty context without env var", () => {
      const result = validateContext({});
      expect(result).toEqual({
        valid: false,
        error: "Missing bpp_uri and no BPP_CALLBACK_ENDPOINT configured",
      });
    });

    it("should return valid when context has bpp_uri", () => {
      const result = validateContext({ bpp_uri: "http://bpp:8082/receiver" });
      expect(result).toEqual({ valid: true });
    });

    it("should return valid when BPP_CALLBACK_ENDPOINT is set (no bpp_uri)", () => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://callback:8082";
      const result = validateContext({});
      expect(result).toEqual({ valid: true });
    });

    it("should return valid with both bpp_uri and env var", () => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://callback:8082";
      const result = validateContext({ bpp_uri: "http://bpp:8082/receiver" });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("getCallbackUrl", () => {
    it("should use env var when BPP_CALLBACK_ENDPOINT is set", () => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://callback:8082";
      const result = getCallbackUrl({ bpp_uri: "http://bpp:8082/path" }, "select");
      expect(result).toBe("http://callback:8082/on_select");
    });

    it("should strip trailing slash from env var", () => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://callback:8082/";
      const result = getCallbackUrl({}, "init");
      expect(result).toBe("http://callback:8082/on_init");
    });

    it("should use bpp_uri origin when no env var", () => {
      const result = getCallbackUrl(
        { bpp_uri: "http://bpp:8082/some/path" },
        "confirm"
      );
      expect(result).toBe("http://bpp:8082/bpp/caller/on_confirm");
    });

    it("should handle different actions correctly", () => {
      const context = { bpp_uri: "http://bpp:8082/path" };
      expect(getCallbackUrl(context, "update")).toBe(
        "http://bpp:8082/bpp/caller/on_update"
      );
      expect(getCallbackUrl(context, "rating")).toBe(
        "http://bpp:8082/bpp/caller/on_rating"
      );
      expect(getCallbackUrl(context, "cancel")).toBe(
        "http://bpp:8082/bpp/caller/on_cancel"
      );
    });
  });

  describe("calculateDeliveryProgress", () => {
    const createOrder = (quantity: number) => ({
      "beckn:orderAttributes": { total_quantity: quantity },
    });

    it("should return 0 progress for 0 hours elapsed", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2024-01-01T00:00:00Z");
      const order = createOrder(10);

      const result = calculateDeliveryProgress(order, confirmedAt, now);

      expect(result.isComplete).toBe(false);
      expect(result.deliveredQuantity).toBe(0);
      expect(result.deliveryAttributes.deliveryStatus).toBe("IN_PROGRESS");
    });

    it("should return ~50% progress for 12 hours elapsed", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2024-01-01T12:00:00Z");
      const order = createOrder(10);

      const result = calculateDeliveryProgress(order, confirmedAt, now);

      expect(result.isComplete).toBe(false);
      expect(result.deliveredQuantity).toBe(5); // 10 * 0.5
      expect(result.deliveryAttributes.deliveryStatus).toBe("IN_PROGRESS");
    });

    it("should return complete for 24+ hours elapsed", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2024-01-02T00:00:00Z");
      const order = createOrder(10);

      const result = calculateDeliveryProgress(order, confirmedAt, now);

      expect(result.isComplete).toBe(true);
      expect(result.deliveredQuantity).toBe(10);
      expect(result.deliveryAttributes.deliveryStatus).toBe("COMPLETED");
    });

    it("should cap progress at 100% for >24 hours", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2024-01-03T00:00:00Z"); // 48 hours
      const order = createOrder(10);

      const result = calculateDeliveryProgress(order, confirmedAt, now);

      expect(result.isComplete).toBe(true);
      expect(result.deliveredQuantity).toBe(10); // Not 20
    });

    it("should generate correct number of meter readings", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");

      // 3 hours elapsed -> 4 readings (floor(3) + 1)
      const now3h = new Date("2024-01-01T03:00:00Z");
      const result3h = calculateDeliveryProgress(createOrder(10), confirmedAt, now3h);
      expect(result3h.deliveryAttributes.meterReadings).toHaveLength(4);

      // 10 hours elapsed -> 6 readings (capped at max 6)
      const now10h = new Date("2024-01-01T10:00:00Z");
      const result10h = calculateDeliveryProgress(createOrder(10), confirmedAt, now10h);
      expect(result10h.deliveryAttributes.meterReadings).toHaveLength(6);
    });

    it("should include correct meter reading structure", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2024-01-01T02:00:00Z");
      const order = createOrder(24); // 1 kWh per hour

      const result = calculateDeliveryProgress(order, confirmedAt, now);
      const reading = result.deliveryAttributes.meterReadings[0];

      expect(reading).toHaveProperty("beckn:timeWindow");
      expect(reading["beckn:timeWindow"]).toHaveProperty("@type", "beckn:TimePeriod");
      expect(reading).toHaveProperty("allocatedEnergy", 1);
      expect(reading).toHaveProperty("producedEnergy", 1);
      expect(reading).toHaveProperty("consumedEnergy"); // 2% grid loss
      expect(reading).toHaveProperty("unit", "kWh");
    });

    it("should use orderItems sum when orderAttributes not present", () => {
      const confirmedAt = new Date("2024-01-01T00:00:00Z");
      const now = new Date("2024-01-01T12:00:00Z");
      const order = {
        "beckn:orderItems": [
          { "beckn:quantity": { unitQuantity: 5 } },
          { "beckn:quantity": { unitQuantity: 3 } },
        ],
      };

      const result = calculateDeliveryProgress(order, confirmedAt, now);
      expect(result.deliveredQuantity).toBe(4); // (5+3) * 0.5
    });
  });

  describe("Template Handlers - Context Validation", () => {
    const handlers = [
      { name: "onUpdate", handler: onUpdate },
      { name: "onRating", handler: onRating },
      { name: "onSupport", handler: onSupport },
      { name: "onTrack", handler: onTrack },
      { name: "onCancel", handler: onCancel },
    ];

    handlers.forEach(({ name, handler }) => {
      describe(name, () => {
        it("should return NACK when context is missing", () => {
          const req = mockRequest({ message: {} });
          const res = mockResponse();

          handler(req as Request, res as Response);

          expect(res.status).toHaveBeenCalledWith(200);
          expect(res.json).toHaveBeenCalledWith({
            message: { ack: { status: "NACK" } },
            error: { code: "INVALID_CONTEXT", message: "Missing context" },
          });
        });

        it("should return NACK when context is empty and no env var", () => {
          const req = mockRequest({ context: {}, message: {} });
          const res = mockResponse();

          handler(req as Request, res as Response);

          expect(res.status).toHaveBeenCalledWith(200);
          expect(res.json).toHaveBeenCalledWith({
            message: { ack: { status: "NACK" } },
            error: {
              code: "INVALID_CONTEXT",
              message: "Missing bpp_uri and no BPP_CALLBACK_ENDPOINT configured",
            },
          });
        });

        it("should return ACK when context is valid", async () => {
          const req = mockRequest({
            context: { bpp_uri: "http://bpp:8082/path", domain: "test-domain" },
            message: {},
          });
          const res = mockResponse();

          mockedReadDomainResponse.mockResolvedValue({
            message: { test: "data" },
          });
          mockedAxios.post.mockResolvedValue({ data: { success: true } });

          handler(req as Request, res as Response);

          expect(res.status).toHaveBeenCalledWith(200);
          expect(res.json).toHaveBeenCalledWith({
            message: { ack: { status: "ACK" } },
          });
        });
      });
    });
  });

  describe("Template Handlers - Callback Behavior", () => {
    const validContext = {
      bpp_uri: "http://bpp:8082/path",
      domain: "beckn.one:deg:p2p-trading",
      bap_id: "test-bap",
      bpp_id: "test-bpp",
      message_id: "original-message-id",
      timestamp: "2024-01-01T00:00:00Z",
    };

    beforeEach(() => {
      mockedAxios.post.mockResolvedValue({ data: { ack: "success" } });
    });

    it("onUpdate should preserve message_id and regenerate timestamp in callback", async () => {
      const req = mockRequest({ context: validContext, message: {} });
      const res = mockResponse();

      mockedReadDomainResponse.mockResolvedValue({
        message: { order: { id: "123" } },
      });

      onUpdate(req as Request, res as Response);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockedAxios.post).toHaveBeenCalled();
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;

      // Verify message_id is preserved (per Beckn spec)
      expect(callPayload.context.message_id).toBe("original-message-id");

      // Verify timestamp is regenerated (not original)
      expect(callPayload.context.timestamp).not.toBe("2024-01-01T00:00:00Z");

      // Verify action is set correctly
      expect(callPayload.context.action).toBe("on_update");
    });

    it("should not make callback when template is empty", async () => {
      const req = mockRequest({ context: validContext, message: {} });
      const res = mockResponse();

      // Return empty template
      mockedReadDomainResponse.mockResolvedValue({});

      onUpdate(req as Request, res as Response);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // axios.post should NOT be called
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("should not make callback when template is null", async () => {
      const req = mockRequest({ context: validContext, message: {} });
      const res = mockResponse();

      mockedReadDomainResponse.mockResolvedValue(null as any);

      onRating(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("onSupport should call correct callback URL", async () => {
      const req = mockRequest({ context: validContext, message: {} });
      const res = mockResponse();

      mockedReadDomainResponse.mockResolvedValue({ message: { support: {} } });

      onSupport(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://bpp:8082/bpp/caller/on_support",
        expect.any(Object)
      );
    });

    it("onTrack should preserve domain context fields", async () => {
      const req = mockRequest({ context: validContext, message: {} });
      const res = mockResponse();

      mockedReadDomainResponse.mockResolvedValue({ message: { tracking: {} } });

      onTrack(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.context.domain).toBe("beckn.one:deg:p2p-trading");
      expect(callPayload.context.bap_id).toBe("test-bap");
      expect(callPayload.context.bpp_id).toBe("test-bpp");
    });

    it("onCancel should merge template message with regenerated context", async () => {
      const req = mockRequest({ context: validContext, message: {} });
      const res = mockResponse();

      const templateData = {
        message: { cancellation: { reason: "test" } },
        someOtherField: "value",
      };
      mockedReadDomainResponse.mockResolvedValue(templateData);

      onCancel(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const callPayload = mockedAxios.post.mock.calls[0][1] as any;
      expect(callPayload.message).toEqual({ cancellation: { reason: "test" } });
      expect(callPayload.someOtherField).toBe("value");
    });
  });

  describe("Template Handlers - Error Handling", () => {
    it("should handle axios errors gracefully", async () => {
      const req = mockRequest({
        context: { bpp_uri: "http://bpp:8082/path", domain: "test" },
        message: {},
      });
      const res = mockResponse();

      mockedReadDomainResponse.mockResolvedValue({ message: {} });
      mockedAxios.post.mockRejectedValue(new Error("Network error"));

      // Should not throw
      expect(() => onUpdate(req as Request, res as Response)).not.toThrow();

      // Should still return ACK
      expect(res.json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should handle readDomainResponse errors gracefully", async () => {
      const req = mockRequest({
        context: { bpp_uri: "http://bpp:8082/path", domain: "test" },
        message: {},
      });
      const res = mockResponse();

      mockedReadDomainResponse.mockRejectedValue(new Error("File not found"));

      expect(() => onRating(req as Request, res as Response)).not.toThrow();
      expect(res.json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });
  });

  describe("BPP_CALLBACK_ENDPOINT usage", () => {
    it("should use env var over bpp_uri for callback", async () => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://custom-callback:9000";

      const req = mockRequest({
        context: {
          bpp_uri: "http://bpp:8082/path",
          domain: "test",
        },
        message: {},
      });
      const res = mockResponse();

      mockedReadDomainResponse.mockResolvedValue({ message: { data: "test" } });
      mockedAxios.post.mockResolvedValue({ data: {} });

      onSupport(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://custom-callback:9000/on_support",
        expect.any(Object)
      );
    });
  });

  describe("onSelect — inventory check", () => {
    const validContext = {
      bpp_uri: "http://bpp:8082/path",
      domain: "beckn.one:deg:p2p-trading",
      bap_id: "test-bap",
      bpp_id: "test-bpp",
      message_id: "msg-select-001",
      transaction_id: "txn-select-001",
    };

    // Helper to seed an item and offer with applicableQuantity in offers collection
    async function seedItemAndOffer(
      itemId: string,
      offerId: string,
      availableQty: number,
      price: number = 7.5,
      catalogId: string = "test-catalog"
    ) {
      const db = getTestDB();
      await db.collection("items").insertOne({
        "beckn:id": itemId,
        "beckn:provider": { "beckn:id": "seller-001" },
        "beckn:itemAttributes": {
          sourceType: "SOLAR",
          meterId: "100200300",
          availableQuantity: availableQty,
        },
        catalogId,
        updatedAt: new Date(),
      });
      await db.collection("offers").insertOne({
        "beckn:id": offerId,
        "beckn:items": [itemId],
        "beckn:provider": "seller-001",
        "beckn:price": {
          "@type": "schema:PriceSpecification",
          "schema:price": price,
          "schema:priceCurrency": "INR",
          applicableQuantity: { unitQuantity: availableQty },
        },
        "beckn:offerAttributes": {
          pricingModel: "PER_KWH",
          "beckn:price": { value: price, currency: "INR" },
        },
        catalogId,
        updatedAt: new Date(),
      });
    }

    beforeEach(() => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://callback:8082";
      mockedAxios.post.mockResolvedValue({ data: { ack: "success" } });
    });

    it("should return ACK immediately and process async", () => {
      const req = mockRequest({
        context: validContext,
        message: { items: [] },
      });
      const res = mockResponse();

      onSelect(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should send INSUFFICIENT_INVENTORY error when requested > available quantity", async () => {
      // Seed item with only 5 kWh available
      await seedItemAndOffer("item-001", "offer-001", 5);

      const req = mockRequest({
        context: validContext,
        message: {
          items: [
            {
              "beckn:id": "item-001",
              "beckn:quantity": { unitQuantity: 10 },
              "beckn:acceptedOffer": { "beckn:id": "offer-001" },
            },
          ],
        },
      });
      const res = mockResponse();

      onSelect(req as Request, res as Response);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have POSTed an error callback
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const callUrl = mockedAxios.post.mock.calls[0][0];
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;

      expect(callUrl).toBe("http://callback:8082/on_select");
      expect(callPayload.error.code).toBe("INSUFFICIENT_INVENTORY");
      expect(callPayload.error.message).toContain("requested 10");
      expect(callPayload.error.message).toContain("available 5");
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("REJECTED");
      // Each order item should have beckn:error with INSUFFICIENT_INVENTORY
      expect(callPayload.message.order["beckn:orderItems"][0]["beckn:error"].code).toBe(
        "INSUFFICIENT_INVENTORY"
      );
    });

    it("should send successful on_select when quantity is sufficient", async () => {
      // Seed item with 20 kWh available
      await seedItemAndOffer("item-002", "offer-002", 20, 7.5);

      const req = mockRequest({
        context: validContext,
        message: {
          items: [
            {
              "beckn:id": "item-002",
              "beckn:quantity": { unitQuantity: 10 },
              "beckn:acceptedOffer": { "beckn:id": "offer-002" },
            },
          ],
        },
      });
      const res = mockResponse();

      onSelect(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;

      expect(callPayload.context.action).toBe("on_select");
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("CREATED");
      expect(callPayload.message.order["beckn:orderItems"]).toHaveLength(1);
      expect(callPayload.message.order["beckn:orderItems"][0]["beckn:quantity"].unitQuantity).toBe(10);
    });
  });

  describe("onConfirm — settlement creation and inventory", () => {
    const validContext = {
      bpp_uri: "http://bpp:8082/path",
      domain: "beckn.one:deg:p2p-trading",
      bap_id: "test-bap",
      bpp_id: "test-bpp",
      message_id: "msg-confirm-001",
      transaction_id: "txn-confirm-001",
    };

    // Helper to seed an offer with applicableQuantity for confirm flow
    async function seedOfferForConfirm(
      offerId: string,
      itemId: string,
      availableQty: number,
      catalogId: string = "test-catalog"
    ) {
      const db = getTestDB();
      // Seed item
      await db.collection("items").insertOne({
        "beckn:id": itemId,
        "beckn:provider": { "beckn:id": "seller-001" },
        "beckn:itemAttributes": {
          sourceType: "SOLAR",
          meterId: "100200300",
          availableQuantity: availableQty,
        },
        userId: "seller-user-id",
        catalogId,
        updatedAt: new Date(),
      });
      // Seed catalog
      await db.collection("catalogs").insertOne({
        "beckn:id": catalogId,
        "beckn:descriptor": { "@type": "beckn:Descriptor", "schema:name": "Test Catalog" },
        "beckn:bppId": "p2p.terrarexenergy.com",
        "beckn:isActive": true,
        updatedAt: new Date(),
      });
      // Seed offer
      await db.collection("offers").insertOne({
        "beckn:id": offerId,
        "beckn:items": [itemId],
        "beckn:provider": "seller-001",
        "beckn:price": {
          "@type": "schema:PriceSpecification",
          "schema:price": 7.5,
          "schema:priceCurrency": "INR",
          applicableQuantity: { unitQuantity: availableQty },
        },
        "beckn:offerAttributes": {
          pricingModel: "PER_KWH",
          "beckn:price": { value: 7.5, currency: "INR" },
        },
        catalogId,
        updatedAt: new Date(),
      });
    }

    beforeEach(() => {
      process.env.BPP_CALLBACK_ENDPOINT = "http://callback:8082";
      process.env.ONIX_BPP_URL = "http://onix-bpp:8082";
      mockedAxios.post.mockResolvedValue({ data: { ack: "success" } });
    });

    it("should return ACK immediately", () => {
      const req = mockRequest({
        context: validContext,
        message: { order: { "beckn:orderItems": [] } },
      });
      const res = mockResponse();

      onConfirm(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should create settlement record with totalQuantity from orderItems", async () => {
      await seedOfferForConfirm("offer-c1", "item-c1", 30);

      const req = mockRequest({
        context: { ...validContext, transaction_id: "txn-settle-001" },
        message: {
          order: {
            "beckn:id": "order-001",
            "beckn:seller": "seller-001",
            "beckn:buyer": { "beckn:id": "buyer-001" },
            "beckn:orderItems": [
              {
                "beckn:orderedItem": "item-c1",
                "beckn:quantity": { unitQuantity: 8 },
                "beckn:acceptedOffer": { "beckn:id": "offer-c1" },
              },
              {
                "beckn:orderedItem": "item-c1",
                "beckn:quantity": { unitQuantity: 5 },
                "beckn:acceptedOffer": { "beckn:id": "offer-c1" },
              },
            ],
          },
        },
      });
      const res = mockResponse();

      onConfirm(req as Request, res as Response);

      // Wait for async processing (settlement, inventory reduction, republish, callback)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check settlement record in DB
      const db = getTestDB();
      const settlement = await db.collection("settlements").findOne({
        transactionId: "txn-settle-001",
      });

      expect(settlement).not.toBeNull();
      expect(settlement!.role).toBe("SELLER");
      expect(settlement!.contractedQuantity).toBe(13); // 8 + 5
      expect(settlement!.settlementStatus).toBe("PENDING");
    });

    it("should send INSUFFICIENT_INVENTORY error when pre-check fails", async () => {
      // Seed offer with only 3 kWh available, but order requests 10
      await seedOfferForConfirm("offer-insuf", "item-insuf", 3);

      const req = mockRequest({
        context: { ...validContext, transaction_id: "txn-insuf-001" },
        message: {
          order: {
            "beckn:id": "order-insuf",
            "beckn:seller": "seller-001",
            "beckn:buyer": { "beckn:id": "buyer-001" },
            "beckn:orderItems": [
              {
                "beckn:orderedItem": "item-insuf",
                "beckn:quantity": { unitQuantity: 10 },
                "beckn:acceptedOffer": { "beckn:id": "offer-insuf" },
              },
            ],
          },
        },
      });
      const res = mockResponse();

      onConfirm(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should have sent error callback (only 1 call — the error, not the confirm callback)
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const callUrl = mockedAxios.post.mock.calls[0][0];
      const callPayload = mockedAxios.post.mock.calls[0][1] as any;

      expect(callUrl).toBe("http://callback:8082/on_confirm");
      expect(callPayload.error.code).toBe("INSUFFICIENT_INVENTORY");
      expect(callPayload.error.message).toContain("offer-insuf");
      expect(callPayload.error.message).toContain("Requested 10");
      expect(callPayload.error.message).toContain("available 3");
      expect(callPayload.message.order["beckn:orderStatus"]).toBe("REJECTED");

      // No settlement should have been created
      const db = getTestDB();
      const settlement = await db.collection("settlements").findOne({
        transactionId: "txn-insuf-001",
      });
      expect(settlement).toBeNull();
    });

    it("should reduce offer inventory and republish catalog after confirm", async () => {
      await seedOfferForConfirm("offer-reduce", "item-reduce", 20, "catalog-reduce");

      const req = mockRequest({
        context: { ...validContext, transaction_id: "txn-reduce-001" },
        message: {
          order: {
            "beckn:id": "order-reduce",
            "beckn:seller": "seller-001",
            "beckn:buyer": { "beckn:id": "buyer-001" },
            "beckn:orderItems": [
              {
                "beckn:orderedItem": "item-reduce",
                "beckn:quantity": { unitQuantity: 7 },
                "beckn:acceptedOffer": { "beckn:id": "offer-reduce" },
              },
            ],
          },
        },
      });
      const res = mockResponse();

      onConfirm(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify offer inventory was reduced: 20 - 7 = 13
      const db = getTestDB();
      const offer = await db.collection("offers").findOne({ "beckn:id": "offer-reduce" });
      expect(offer!["beckn:price"].applicableQuantity.unitQuantity).toBe(13);

      // Verify catalog was republished (POST to ONIX /bpp/caller/publish)
      const publishCall = mockedAxios.post.mock.calls.find(
        (call: any[]) => (call[0] as string).includes("/bpp/caller/publish")
      );
      expect(publishCall).toBeDefined();
      expect(publishCall![0]).toBe("http://onix-bpp:8082/bpp/caller/publish");

      // Verify on_confirm callback was also sent
      const confirmCall = mockedAxios.post.mock.calls.find(
        (call: any[]) => (call[0] as string).includes("on_confirm")
      );
      expect(confirmCall).toBeDefined();
      const confirmPayload = confirmCall![1] as any;
      expect(confirmPayload.message.order["beckn:orderStatus"]).toBe("CREATED");
      expect(confirmPayload.message.order["beckn:orderValue"]).toEqual({
        currency: "INR",
        value: 52.5, // 7 kWh * 7.5 INR/kWh
        description: expect.stringContaining("7 kWh"),
      });
    });

    it("should save seller order in DB after confirm", async () => {
      await seedOfferForConfirm("offer-save", "item-save", 15, "catalog-save");

      const req = mockRequest({
        context: { ...validContext, transaction_id: "txn-save-001" },
        message: {
          order: {
            "beckn:id": "order-save",
            "beckn:seller": "seller-001",
            "beckn:buyer": { "beckn:id": "buyer-001" },
            "beckn:orderItems": [
              {
                "beckn:orderedItem": "item-save",
                "beckn:quantity": { unitQuantity: 5 },
                "beckn:acceptedOffer": { "beckn:id": "offer-save" },
              },
            ],
          },
        },
      });
      const res = mockResponse();

      onConfirm(req as Request, res as Response);

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify order was saved
      const db = getTestDB();
      const savedOrder = await db.collection("orders").findOne({
        transactionId: "txn-save-001",
      });
      expect(savedOrder).not.toBeNull();
      expect(savedOrder!.type).toBe("seller");
      expect(savedOrder!.orderStatus).toBe("SCHEDULED");
      expect(savedOrder!.userId).toBe("seller-user-id");
      expect(savedOrder!.order["beckn:orderStatus"]).toBe("CREATED");
      expect(savedOrder!.order["beckn:orderValue"]).toEqual({
        currency: "INR",
        value: 37.5, // 5 kWh * 7.5 INR/kWh
        description: expect.stringContaining("5 kWh"),
      });
    });
  });
});
