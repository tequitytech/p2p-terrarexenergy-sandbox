import { Request, Response } from "express";
import axios from "axios";
import {
  validateContext,
  getCallbackUrl,
  calculateDeliveryProgress,
  onUpdate,
  onRating,
  onSupport,
  onTrack,
  onCancel,
} from "./controller";
import { readDomainResponse } from "../utils";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock utils
jest.mock("../utils", () => ({
  readDomainResponse: jest.fn(),
}));
const mockedReadDomainResponse = readDomainResponse as jest.MockedFunction<
  typeof readDomainResponse
>;

// Mock uuid to return predictable values
jest.mock("uuid", () => ({
  v4: jest.fn(() => "test-uuid-1234"),
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

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    process.env = { ...originalEnv };
    delete process.env.BPP_CALLBACK_ENDPOINT;
    delete process.env.PERSONA;
  });

  afterAll(() => {
    process.env = originalEnv;
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
});
