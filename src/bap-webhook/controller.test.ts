import {
  onSelect,
  onInit,
  onConfirm,
  onStatus,
  onUpdate,
  onCancel,
  onRating,
  onSupport,
  onTrack,
} from "./controller";

import {
  hasPendingTransaction,
  resolvePendingTransaction,
  createPendingTransaction,
} from "../services/transaction-store";

import { settlementStore } from "../services/settlement-store";
import { orderService } from "../services/order-service";
import { notificationService } from "../services/notification-service";

import { mockRequest, mockResponse, flushPromises } from "../test-utils";

import type { Request, Response } from "express";

// Mock the services that hit the DB
jest.mock("../services/settlement-store", () => ({
  settlementStore: {
    createSettlement: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../services/order-service", () => ({
  orderService: {
    saveBuyerOrder: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/notification-service", () => ({
  notificationService: {
    sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  },
}));

// Transaction store is in-memory, no mock needed — use real functions

const mockedSettlementStore = settlementStore as jest.Mocked<typeof settlementStore>;
const mockedOrderService = orderService as jest.Mocked<typeof orderService>;
const mockedNotificationService = notificationService as jest.Mocked<typeof notificationService>;

describe("BAP Webhook Controller", () => {
  describe("onSelect", () => {
    it("should return ACK response with status 200", () => {
      const req = mockRequest({
        context: { transaction_id: "txn-001" },
        message: { catalog: {} },
      });
      const { res, status, json } = mockResponse();

      onSelect(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should resolve pending transaction when transactionId exists", async () => {
      const txnId = "txn-select-resolve";
      const pendingPromise = createPendingTransaction(txnId, "select");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { catalog: { id: "cat-1" } },
      });
      const { res } = mockResponse();

      onSelect(req as Request, res as Response);

      const resolved = await pendingPromise;
      expect(resolved).toEqual({
        context: { transaction_id: txnId },
        message: { catalog: { id: "cat-1" } },
        error: undefined,
      });
    });

    it("should not resolve when no pending transaction exists", () => {
      const req = mockRequest({
        context: { transaction_id: "txn-no-pending" },
        message: {},
      });
      const { res, status } = mockResponse();

      // Should not throw
      onSelect(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
    });

    it("should handle error in body gracefully (still ACK)", () => {
      const req = mockRequest({
        context: { transaction_id: "txn-err" },
        message: null,
        error: { code: "SOME_ERROR", message: "Something failed" },
      });
      const { res, status, json } = mockResponse();

      onSelect(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should include error in resolved transaction data", async () => {
      const txnId = "txn-select-error-resolve";
      const pendingPromise = createPendingTransaction(txnId, "select");

      const errorObj = { code: "ERR", message: "Bad request" };
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: null,
        error: errorObj,
      });
      const { res } = mockResponse();

      onSelect(req as Request, res as Response);

      const resolved = await pendingPromise;
      expect(resolved.error).toEqual(errorObj);
    });

    it("should handle missing context gracefully", () => {
      const req = mockRequest({});
      const { res, status, json } = mockResponse();

      onSelect(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });
  });

  describe("onInit", () => {
    it("should return ACK response with status 200", () => {
      const req = mockRequest({
        context: { transaction_id: "txn-init-001" },
        message: { order: {} },
      });
      const { res, status, json } = mockResponse();

      onInit(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should resolve pending transaction when transactionId exists", async () => {
      const txnId = "txn-init-resolve";
      const pendingPromise = createPendingTransaction(txnId, "init");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: { id: "order-1" } },
      });
      const { res } = mockResponse();

      onInit(req as Request, res as Response);

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ order: { id: "order-1" } });
    });

    it("should pass error field through to resolved transaction data", async () => {
      const txnId = "txn-init-error";
      const pendingPromise = createPendingTransaction(txnId, "init");

      const errorObj = { code: "INIT_FAIL", message: "Init failed" };
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: null,
        error: errorObj,
      });
      const { res } = mockResponse();

      onInit(req as Request, res as Response);

      const resolved = await pendingPromise;
      expect(resolved.error).toEqual(errorObj);
    });
  });

  describe("onConfirm", () => {
    it("should return ACK response with status 200", () => {
      const req = mockRequest({
        context: { transaction_id: "txn-confirm-ack" },
        message: { order: {} },
      });
      const { res, status, json } = mockResponse();

      onConfirm(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should resolve pending transaction when transactionId exists", async () => {
      const txnId = "txn-confirm-resolve";
      const pendingPromise = createPendingTransaction(txnId, "confirm");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: { id: "order-confirmed" } },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ order: { id: "order-confirmed" } });
    });

    it("should create BUYER settlement record with correct quantity", async () => {
      const txnId = "txn-confirm-settlement";
      const req = mockRequest({
        context: { transaction_id: txnId, bpp_id: "seller-platform.com" },
        message: {
          order: {
            "beckn:orderItems": [
              { "beckn:quantity": { unitQuantity: 10 }, "beckn:orderedItem": "item-001" },
            ],
            "beckn:orderAttributes": { utilityIdSeller: "BESCOM" },
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      // Wait for async settlement creation
      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        "item-001",
        10,
        "BUYER",
        "seller-platform.com",
        "BESCOM"
      );
    });

    it("should calculate totalQuantity from multiple orderItems", async () => {
      const txnId = "txn-confirm-multi-qty";
      const req = mockRequest({
        context: { transaction_id: txnId, bpp_id: "platform" },
        message: {
          order: {
            "beckn:orderItems": [
              { "beckn:quantity": { unitQuantity: 5 }, "beckn:orderedItem": "item-a" },
              { "beckn:quantity": { unitQuantity: 3 } },
              { "beckn:quantity": { unitQuantity: 7 } },
            ],
            "beckn:orderAttributes": {},
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        "item-a", // First item's beckn:orderedItem
        15, // 5 + 3 + 7
        "BUYER",
        "platform",
        null // no utilityIdSeller
      );
    });

    it("should extract sellerPlatformId from context.bpp_id", async () => {
      const txnId = "txn-confirm-bppid";
      const req = mockRequest({
        context: { transaction_id: txnId, bpp_id: "my-seller-platform.com" },
        message: {
          order: {
            "beckn:orderItems": [{ "beckn:quantity": { unitQuantity: 1 } }],
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        expect.anything(),
        expect.anything(),
        "BUYER",
        "my-seller-platform.com",
        null
      );
    });

    it("should extract sellerDiscomId from orderAttributes.utilityIdSeller", async () => {
      const txnId = "txn-confirm-discom";
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: {
          order: {
            "beckn:orderItems": [{ "beckn:quantity": { unitQuantity: 2 } }],
            "beckn:orderAttributes": { utilityIdSeller: "TPDDL" },
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        expect.anything(),
        expect.anything(),
        "BUYER",
        null, // no bpp_id in context
        "TPDDL"
      );
    });

    it("should call orderService.saveBuyerOrder with transactionId and order data", async () => {
      const txnId = "txn-confirm-save-order";
      const orderData = {
        "beckn:orderItems": [{ "beckn:quantity": { unitQuantity: 5 } }],
        "beckn:seller": { "beckn:id": "seller-1" },
      };
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: orderData },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedOrderService.saveBuyerOrder).toHaveBeenCalledWith(
        txnId,
        expect.objectContaining({
          order: orderData,
          updatedAt: expect.any(Date),
        })
      );
    });

    it("should call notificationService.sendOrderConfirmation", async () => {
      const txnId = "txn-confirm-notify";
      const orderData = {
        "beckn:orderItems": [{ "beckn:quantity": { unitQuantity: 8 } }],
      };
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: orderData },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedNotificationService.sendOrderConfirmation).toHaveBeenCalledWith(
        txnId,
        orderData
      );
    });

    it("should not create settlement when error is present in body", async () => {
      const txnId = "txn-confirm-with-error";
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: { "beckn:orderItems": [] } },
        error: { code: "ERR", message: "Something went wrong" },
      });
      const { res } = mockResponse();

      mockedSettlementStore.createSettlement.mockClear();
      mockedOrderService.saveBuyerOrder.mockClear();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).not.toHaveBeenCalled();
      expect(mockedOrderService.saveBuyerOrder).not.toHaveBeenCalled();
    });

    it("should not create settlement when message.order is missing", async () => {
      const txnId = "txn-confirm-no-order";
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: {},
      });
      const { res } = mockResponse();

      mockedSettlementStore.createSettlement.mockClear();
      mockedOrderService.saveBuyerOrder.mockClear();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).not.toHaveBeenCalled();
      expect(mockedOrderService.saveBuyerOrder).not.toHaveBeenCalled();
    });

    it("should handle settlement creation failure gracefully (still ACK)", async () => {
      const txnId = "txn-confirm-settle-fail";
      mockedSettlementStore.createSettlement.mockRejectedValueOnce(
        new Error("DB connection failed")
      );

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: {
          order: {
            "beckn:orderItems": [{ "beckn:quantity": { unitQuantity: 5 } }],
          },
        },
      });
      const { res, status, json } = mockResponse();

      onConfirm(req as Request, res as Response);

      // ACK is returned synchronously, before settlement async block
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });

      // Wait for async to complete without throwing
      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("should use fallback orderItemId from beckn:id when beckn:orderedItem is absent", async () => {
      const txnId = "txn-confirm-fallback-id";
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: {
          order: {
            "beckn:orderItems": [
              { "beckn:id": "fallback-item-id", "beckn:quantity": { unitQuantity: 3 } },
            ],
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        "fallback-item-id",
        3,
        "BUYER",
        null,
        null
      );
    });

    it("should use generated orderItemId when both beckn:orderedItem and beckn:id are absent", async () => {
      const txnId = "txn-confirm-gen-id";
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: {
          order: {
            "beckn:orderItems": [{ "beckn:quantity": { unitQuantity: 2 } }],
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        `item-${txnId}`,
        2,
        "BUYER",
        null,
        null
      );
    });

    it("should handle empty orderItems array (totalQuantity = 0)", async () => {
      const txnId = "txn-confirm-empty-items";
      const req = mockRequest({
        context: { transaction_id: txnId },
        message: {
          order: {
            "beckn:orderItems": [],
          },
        },
      });
      const { res } = mockResponse();

      onConfirm(req as Request, res as Response);

      await flushPromises();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockedSettlementStore.createSettlement).toHaveBeenCalledWith(
        txnId,
        `item-${txnId}`, // fallback when no items
        0,
        "BUYER",
        null,
        null
      );
    });
  });

  describe("onStatus", () => {
    it("should return ACK response with status 200", () => {
      const req = mockRequest({
        context: { transaction_id: "txn-status-001" },
        message: { order: { status: "IN_PROGRESS" } },
      });
      const { res, status, json } = mockResponse();

      onStatus(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });
    });

    it("should resolve pending transaction when transactionId exists", async () => {
      const txnId = "txn-status-resolve";
      const pendingPromise = createPendingTransaction(txnId, "status");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: { status: "COMPLETED" } },
      });
      const { res } = mockResponse();

      onStatus(req as Request, res as Response);

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ order: { status: "COMPLETED" } });
    });
  });

  describe("onCancel", () => {
    it("should return ACK and resolve pending transaction", async () => {
      const txnId = "txn-cancel-resolve";
      const pendingPromise = createPendingTransaction(txnId, "cancel");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { cancellation: { reason: "user_request" } },
      });
      const { res, status, json } = mockResponse();

      onCancel(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ cancellation: { reason: "user_request" } });
    });
  });

  describe("onUpdate", () => {
    it("should return ACK and resolve pending transaction", async () => {
      const txnId = "txn-update-resolve";
      const pendingPromise = createPendingTransaction(txnId, "update");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { order: { updated: true } },
      });
      const { res, status, json } = mockResponse();

      onUpdate(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ order: { updated: true } });
    });
  });

  describe("onRating", () => {
    it("should return ACK and resolve pending transaction", async () => {
      const txnId = "txn-rating-resolve";
      const pendingPromise = createPendingTransaction(txnId, "rating");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { rating: { value: 5 } },
      });
      const { res, status, json } = mockResponse();

      onRating(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ rating: { value: 5 } });
    });
  });

  describe("onSupport", () => {
    it("should return ACK and resolve pending transaction", async () => {
      const txnId = "txn-support-resolve";
      const pendingPromise = createPendingTransaction(txnId, "support");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { support: { contact: "help@example.com" } },
      });
      const { res, status, json } = mockResponse();

      onSupport(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ support: { contact: "help@example.com" } });
    });
  });

  describe("onTrack", () => {
    it("should return ACK and resolve pending transaction", async () => {
      const txnId = "txn-track-resolve";
      const pendingPromise = createPendingTransaction(txnId, "track");

      const req = mockRequest({
        context: { transaction_id: txnId },
        message: { tracking: { url: "https://track.example.com" } },
      });
      const { res, status, json } = mockResponse();

      onTrack(req as Request, res as Response);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({
        message: { ack: { status: "ACK" } },
      });

      const resolved = await pendingPromise;
      expect(resolved.message).toEqual({ tracking: { url: "https://track.example.com" } });
    });
  });
});
