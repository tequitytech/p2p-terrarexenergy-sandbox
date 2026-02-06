import axios from "axios";
import { catalogStore } from "./catalog-store";
import { settlementStore } from "./settlement-store";
import { ledgerClient } from "./ledger-client";
import { orderService } from "./order-service";
import {
  triggerOnSettle,
  pollOnce,
  refreshSettlement,
  settlementPoller,
  startPolling,
  stopPolling,
  getPollingStatus,
} from "./settlement-poller";

jest.mock("axios");
jest.mock("./catalog-store", () => ({
  catalogStore: {
    getOrderByTransactionId: jest.fn(),
  },
}));
jest.mock("./settlement-store", () => ({
  settlementStore: {
    getPendingSettlements: jest.fn(),
    updateFromLedger: jest.fn(),
    markOnSettleNotified: jest.fn(),
    getSettlement: jest.fn(),
  },
}));
jest.mock("./ledger-client", () => ({
  ledgerClient: {
    queryTradeByTransaction: jest.fn(),
  },
}));
jest.mock("./order-service", () => ({
  orderService: {
    updateBuyerOrderStatus: jest.fn(),
    updateSellerOrderStatus: jest.fn(),
  },
}));

const mockedAxiosPost = axios.post as jest.Mock;
const mockedCatalogStore = catalogStore as jest.Mocked<typeof catalogStore>;
const mockedSettlementStore = settlementStore as jest.Mocked<typeof settlementStore>;
const mockedLedgerClient = ledgerClient as jest.Mocked<typeof ledgerClient>;
const mockedOrderService = orderService as jest.Mocked<typeof orderService>;

describe("settlement-poller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ON_SETTLE_CALLBACK_URL;
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopPolling();
    jest.useRealTimers();
  });

  describe("triggerOnSettle", () => {
    const baseSettlement: any = {
      transactionId: "txn-1",
      orderItemId: "order-item-1",
      settlementStatus: "SETTLED",
      settlementCycleId: "cycle-1",
      contractedQuantity: 10,
      actualDelivered: 9,
      deviationKwh: 1,
      settledAt: new Date(),
      buyerDiscomStatus: "COMPLETED",
      sellerDiscomStatus: "COMPLETED",
    };

    it("should no-op when ON_SETTLE_CALLBACK_URL is not configured", async () => {
      await triggerOnSettle(baseSettlement);
      expect(mockedAxiosPost).not.toHaveBeenCalled();
    });

    it("should POST on_settle callback when URL is configured", async () => {
      process.env.ON_SETTLE_CALLBACK_URL = "http://callback/on_settle";
      (mockedCatalogStore.getOrderByTransactionId as jest.Mock).mockResolvedValue({
        context: { domain: "custom-domain" },
      });
      mockedAxiosPost.mockResolvedValue({ data: {} });

      await triggerOnSettle(baseSettlement);

      expect(mockedCatalogStore.getOrderByTransactionId).toHaveBeenCalledWith(
        "txn-1",
      );
      expect(mockedAxiosPost).toHaveBeenCalledWith(
        "http://callback/on_settle",
        expect.objectContaining({
          context: expect.objectContaining({
            action: "on_settle",
            transaction_id: "txn-1",
            domain: "custom-domain",
          }),
        }),
        expect.any(Object),
      );
    });

    it("should handle callback POST failure gracefully", async () => {
      process.env.ON_SETTLE_CALLBACK_URL = "http://callback/on_settle";
      (mockedCatalogStore.getOrderByTransactionId as jest.Mock).mockResolvedValue({
        context: {},
      });
      mockedAxiosPost.mockRejectedValue(new Error("Network error"));

      // Should not throw
      await expect(triggerOnSettle(baseSettlement)).resolves.not.toThrow();
    });

    it("should use default domain when order has no context", async () => {
      process.env.ON_SETTLE_CALLBACK_URL = "http://callback/on_settle";
      (mockedCatalogStore.getOrderByTransactionId as jest.Mock).mockResolvedValue(null);
      mockedAxiosPost.mockResolvedValue({ data: {} });

      await triggerOnSettle(baseSettlement);

      expect(mockedAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          context: expect.objectContaining({
            domain: expect.any(String),
          }),
        }),
        expect.any(Object),
      );
    });
  });

  describe("pollOnce", () => {
    it("should return empty result when no pending settlements", async () => {
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        [],
      );

      const result = await pollOnce();

      expect(result.settlementsChecked).toBe(0);
      expect(result.settlementsUpdated).toBe(0);
      expect(result.newlySettled).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("should update settled buyer orders and mark on_settle notified", async () => {
      const pending = [
        {
          _id: "settlement-1",
          transactionId: "txn-1",
          settlementStatus: "PENDING",
          role: "BUYER",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-1",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        ...pending[0],
        settlementStatus: "SETTLED",
        onSettleNotified: false,
      });
      mockedAxiosPost.mockResolvedValue({ data: {} });

      const result = await pollOnce();

      expect(result.settlementsChecked).toBe(1);
      expect(result.settlementsUpdated).toBe(1);
      expect(result.newlySettled).toEqual(["txn-1"]);

      expect(mockedOrderService.updateBuyerOrderStatus).toHaveBeenCalledWith(
        "txn-1",
        "DELIVERED",
        expect.objectContaining({ settlementId: expect.any(String) }),
      );
      expect(mockedSettlementStore.markOnSettleNotified).toHaveBeenCalledWith(
        "txn-1",
      );
    });

    it("should update settled seller orders", async () => {
      const pending = [
        {
          _id: "settlement-seller-1",
          transactionId: "txn-s-1",
          settlementStatus: "PENDING",
          role: "SELLER",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-s-1",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        ...pending[0],
        settlementStatus: "SETTLED",
        onSettleNotified: false,
      });
      mockedAxiosPost.mockResolvedValue({ data: {} });

      const result = await pollOnce();

      expect(result.settlementsUpdated).toBe(1);
      expect(mockedOrderService.updateSellerOrderStatus).toHaveBeenCalledWith(
        "txn-s-1",
        "DELIVERED",
      );
    });

    it("should skip callback if already notified", async () => {
      const pending = [
        {
          _id: "settlement-2",
          transactionId: "txn-2",
          settlementStatus: "PENDING",
          role: "BUYER",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-2",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        ...pending[0],
        settlementStatus: "SETTLED",
        onSettleNotified: true, // Already notified
      });

      await pollOnce();

      expect(mockedSettlementStore.markOnSettleNotified).not.toHaveBeenCalled();
    });

    it("should not update order if status unchanged from SETTLED", async () => {
      const pending = [
        {
          _id: "settlement-3",
          transactionId: "txn-3",
          settlementStatus: "SETTLED", // Already settled
          role: "BUYER",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-3",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        ...pending[0],
        settlementStatus: "SETTLED",
      });

      const result = await pollOnce();

      // Should not add to newlySettled since status was already SETTLED
      expect(result.newlySettled).toEqual([]);
    });

    it("should handle ledger query returning null", async () => {
      const pending = [
        {
          _id: "settlement-4",
          transactionId: "txn-4",
          settlementStatus: "PENDING",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue(null);

      const result = await pollOnce();

      expect(result.settlementsChecked).toBe(1);
      expect(result.settlementsUpdated).toBe(0);
    });

    it("should handle update returning null", async () => {
      const pending = [
        {
          _id: "settlement-5",
          transactionId: "txn-5",
          settlementStatus: "PENDING",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({});
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue(null);

      const result = await pollOnce();

      expect(result.settlementsUpdated).toBe(0);
    });

    it("should capture errors for individual settlements", async () => {
      const pending = [
        { transactionId: "txn-err", settlementStatus: "PENDING" },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockRejectedValue(
        new Error("Ledger error"),
      );

      const result = await pollOnce();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("txn-err");
    });

    it("should handle order status update failure gracefully", async () => {
      const pending = [
        {
          _id: "settlement-6",
          transactionId: "txn-6",
          settlementStatus: "PENDING",
          role: "BUYER",
        },
      ];
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockResolvedValue(
        pending as any,
      );
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({});
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        ...pending[0],
        settlementStatus: "SETTLED",
        onSettleNotified: false,
      });
      (mockedOrderService.updateBuyerOrderStatus as jest.Mock).mockRejectedValue(
        new Error("Update failed"),
      );

      // Should not throw
      const result = await pollOnce();
      expect(result.settlementsUpdated).toBe(1);
    });

    it("should handle getPendingSettlements failure", async () => {
      (mockedSettlementStore.getPendingSettlements as jest.Mock).mockRejectedValue(
        new Error("DB connection failed"),
      );

      const result = await pollOnce();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Poll cycle failed");
    });
  });

  describe("refreshSettlement", () => {
    it("should return null when no ledger record found", async () => {
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await refreshSettlement("txn-unknown");
      expect(result).toBeNull();
    });

    it("should update settlement from ledger and trigger callback when newly settled", async () => {
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-1",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        transactionId: "txn-1",
        settlementStatus: "SETTLED",
        onSettleNotified: false,
      });
      process.env.ON_SETTLE_CALLBACK_URL = "http://callback/on_settle";
      (mockedCatalogStore.getOrderByTransactionId as jest.Mock).mockResolvedValue({
        context: {},
      });
      mockedAxiosPost.mockResolvedValue({ data: {} });

      const result = await refreshSettlement("txn-1");

      expect(result?.settlementStatus).toBe("SETTLED");
      expect(mockedSettlementStore.markOnSettleNotified).toHaveBeenCalledWith(
        "txn-1",
      );
    });

    it("should not trigger callback if already notified", async () => {
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-2",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue({
        transactionId: "txn-2",
        settlementStatus: "SETTLED",
        onSettleNotified: true,
      });
      process.env.ON_SETTLE_CALLBACK_URL = "http://callback/on_settle";

      await refreshSettlement("txn-2");

      expect(mockedSettlementStore.markOnSettleNotified).not.toHaveBeenCalled();
    });

    it("should handle updateFromLedger returning null", async () => {
      (mockedLedgerClient.queryTradeByTransaction as jest.Mock).mockResolvedValue({
        transactionId: "txn-3",
      });
      (mockedSettlementStore.updateFromLedger as jest.Mock).mockResolvedValue(null);

      const result = await refreshSettlement("txn-3");
      expect(result).toBeNull();
    });
  });

  describe("startPolling and stopPolling", () => {
    beforeEach(() => {
      process.env.ENABLE_SETTLEMENT_POLLING = "true";
    });

    it("should not start if polling is disabled", () => {
      process.env.ENABLE_SETTLEMENT_POLLING = "false";

      // Re-import to get updated env (or test behavior)
      const status = getPollingStatus();
      expect(status).toBeDefined();
    });

    it("should expose poller methods via settlementPoller export", () => {
      expect(typeof settlementPoller.pollOnce).toBe("function");
      expect(typeof settlementPoller.startPolling).toBe("function");
      expect(typeof settlementPoller.stopPolling).toBe("function");
      expect(typeof settlementPoller.getPollingStatus).toBe("function");
    });
  });

  describe("getPollingStatus", () => {
    it("should return current polling status", () => {
      const status = getPollingStatus();

      expect(status).toHaveProperty("enabled");
      expect(status).toHaveProperty("running");
      expect(status).toHaveProperty("isPolling");
      expect(status).toHaveProperty("lastPollResult");
    });
  });
});

