import {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  getTestDB,
} from "../test-utils/db";

import {
  deriveCategory,
  computeSummary,
  escapeCSV,
  toCSV,
  buildSellerPipeline,
  buildBuyerPipeline,
  generateReport,
} from "./report-service";

import type { SettlementLineItem, SettlementReport } from "./report-service";

// Mock getDB to use test database
jest.mock("../db", () => ({
  getDB: () => require("../test-utils/db").getTestDB(),
}));

describe("report-service pure functions", () => {
  describe("deriveCategory", () => {
    test("SELLER + SETTLED = RECEIVED", () => {
      expect(deriveCategory("SELLER", "SETTLED")).toBe("RECEIVED");
    });

    test("SELLER + PENDING = RECEIVABLE", () => {
      expect(deriveCategory("SELLER", "PENDING")).toBe("RECEIVABLE");
    });

    test("BUYER + SETTLED = PAID", () => {
      expect(deriveCategory("BUYER", "SETTLED")).toBe("PAID");
    });

    test("BUYER + PENDING = PAYABLE", () => {
      expect(deriveCategory("BUYER", "PENDING")).toBe("PAYABLE");
    });
  });

  describe("computeSummary", () => {
    test("sums categories correctly", () => {
      const items: SettlementLineItem[] = [
        createLineItem({ totalAmountInr: 100, category: "RECEIVED" }),
        createLineItem({ totalAmountInr: 50, category: "RECEIVED" }),
        createLineItem({ totalAmountInr: 30, category: "RECEIVABLE" }),
        createLineItem({ totalAmountInr: 40, category: "PAID" }),
        createLineItem({ totalAmountInr: 20, category: "PAYABLE" }),
      ];

      const summary = computeSummary(items);
      expect(summary.totalReceived).toBe(150);
      expect(summary.totalReceivables).toBe(30);
      expect(summary.totalPaid).toBe(40);
      expect(summary.totalPayables).toBe(20);
      expect(summary.netPosition).toBe(120); // (150+30) - (40+20) = 180 - 60 = 120
    });

    test("handles empty list", () => {
      const summary = computeSummary([]);
      expect(summary.totalReceived).toBe(0);
      expect(summary.netPosition).toBe(0);
    });

    test("rounds to 2 decimal places", () => {
      const items: SettlementLineItem[] = [
        createLineItem({ totalAmountInr: 10.123, category: "RECEIVED" }),
        createLineItem({ totalAmountInr: 20.456, category: "RECEIVED" }),
      ];
      const summary = computeSummary(items);
      expect(summary.totalReceived).toBe(30.58);
    });
  });

  describe("escapeCSV", () => {
    test("returns number as string", () => {
      expect(escapeCSV(123.45)).toBe("123.45");
    });

    test("returns simple string as is", () => {
      expect(escapeCSV("hello")).toBe("hello");
    });

    test("wraps in quotes if contains comma", () => {
      expect(escapeCSV("hello,world")).toBe('"hello,world"');
    });

    test("escapes quotes", () => {
      expect(escapeCSV('he said "hello"')).toBe('"he said ""hello"""');
    });

    test("handles newlines", () => {
      expect(escapeCSV("line 1\nline 2")).toBe('"line 1\nline 2"');
    });
  });

  describe("toCSV", () => {
    test("generates valid CSV structure", () => {
      const report: SettlementReport = {
        platform: "test-platform",
        generatedAt: "2025-01-15T12:00:00Z",
        periodFrom: "2025-01-15",
        periodTo: "2025-01-15",
        lineItems: [
          createLineItem({
            date: "2025-01-15",
            transactionId: "tx-1",
            counterpartyPlatform: "other-platform",
            counterpartyDiscom: "discom-1",
            role: "SELLER",
            quantityKwh: 10,
            pricePerKwh: 5.5,
            totalAmountInr: 55,
            settlementStatus: "SETTLED",
            category: "RECEIVED",
            scheduledWindow: { start: "2025-01-15T10:00:00Z", end: "2025-01-15T11:00:00Z" },
            deliveryStatus: "DELIVERED"
          }),
          createLineItem({
            date: "2025-01-15",
            transactionId: "tx-2",
            role: "BUYER",
            settlementStatus: "PENDING",
            category: "PAYABLE",
            scheduledWindow: null,
            deliveryStatus: "UNKNOWN"
          }),
        ],
        summary: {
          totalReceived: 55,
          totalReceivables: 0,
          totalPaid: 0,
          totalPayables: 30,
          netPosition: 25,
        },
      };

      const csv = toCSV(report);
      expect(csv).toContain('"Settlement Report"');
      expect(csv).toContain('"Platform","test-platform"');
      expect(csv).toContain(
        "Date,Transaction ID,Counterparty Platform,Counterparty Discom,Role,Quantity (kWh),Price/kWh (INR),Total Amount (INR),Settlement Status,Category,Scheduled Start,Scheduled End,Delivery Status",
      );
      expect(csv).toContain(
        "2025-01-15,tx-1,other-platform,discom-1,SELLER,10.00,5.50,55.00,SETTLED,RECEIVED,2025-01-15T10:00:00Z,2025-01-15T11:00:00Z,DELIVERED",
      );
      expect(csv).toContain(
        "2025-01-15,tx-2,unknown,unknown,BUYER,0.00,0.00,0.00,PENDING,PAYABLE,N/A,N/A,UNKNOWN",
      );
      expect(csv).toContain('"SUMMARY"');
      expect(csv).toContain('"Net Position (INR)","25.00"');
    });
  });
});

describe("report-service integration", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  describe("aggregation pipelines", () => {
    test("buildSellerPipeline correctly filters and joins", async () => {
      const from = new Date("2025-01-15T00:00:00Z");
      const to = new Date("2025-01-15T23:59:59Z");
      const pipeline = buildSellerPipeline(from, to);

      expect(pipeline[0].$match.role).toBe("SELLER");
      expect(pipeline[1].$lookup.from).toBe("orders");
    });

    test("buildBuyerPipeline correctly filters and joins", async () => {
      const from = new Date("2025-01-15T00:00:00Z");
      const to = new Date("2025-01-15T23:59:59Z");
      const pipeline = buildBuyerPipeline(from, to);

      expect(pipeline[0].$match.role).toBe("BUYER");
      expect(pipeline[1].$lookup.from).toBe("buyer_orders");
    });
  });

  describe("generateReport", () => {
    test("handles empty results", async () => {
      const report = await generateReport("2025-01-15", "2025-01-15");
      expect(report.lineItems).toHaveLength(0);
      expect(report.summary.totalReceived).toBe(0);
    });

    test("joins seller settlement with order doc", async () => {
      const db = getTestDB();

      const txId = "tx-seller-1";
      const createdAt = new Date("2025-01-15T10:00:00Z");

      await db.collection("settlements").insertOne({
        transactionId: txId,
        role: "SELLER",
        settlementStatus: "PENDING",
        counterpartyPlatformId: "buyer-platform.com",
        counterpartyDiscomId: "BESCOM",
        contractedQuantity: 10,
        createdAt,
      });

      await db.collection("orders").insertOne({
        transactionId: txId,
        order: {
          "beckn:orderValue": { value: 55 },
          "beckn:orderItems": [
            {
              "beckn:acceptedOffer": {
                "beckn:offerAttributes": {
                  validityWindow: {
                    "schema:startTime": "2025-01-15T10:00:00Z",
                    "schema:endTime": "2025-01-15T11:00:00Z"
                  }
                }
              }
            }
          ]
        },
      });

      const report = await generateReport("2025-01-15", "2025-01-15");
      expect(report.lineItems).toHaveLength(1);
      const item = report.lineItems[0];
      expect(item.transactionId).toBe(txId);
      expect(item.totalAmountInr).toBe(55);
      expect(item.pricePerKwh).toBe(5.5);
      expect(item.counterpartyPlatform).toBe("buyer-platform.com");
      expect(item.category).toBe("RECEIVABLE");
      expect(item.scheduledWindow).toEqual({
        start: "2025-01-15T10:00:00Z",
        end: "2025-01-15T11:00:00Z"
      });
      // Delivery status depends on current time, but it should be set
      expect(["SCHEDULED", "DELIVERED"]).toContain(item.deliveryStatus);
    });

    test("joins buyer settlement with buyer_order doc", async () => {
      const db = getTestDB();

      const txId = "tx-buyer-1";
      const createdAt = new Date("2025-01-15T12:00:00Z");

      await db.collection("settlements").insertOne({
        transactionId: txId,
        role: "BUYER",
        settlementStatus: "SETTLED",
        counterpartyPlatformId: null, // Test fallback to context
        counterpartyDiscomId: "MESCOM",
        contractedQuantity: 5,
        createdAt,
      });

      await db.collection("buyer_orders").insertOne({
        transactionId: txId,
        order: {
          context: { bpp_id: "seller-platform.com" },
          "beckn:orderValue": { value: 30 },
        },
      });

      const report = await generateReport("2025-01-15", "2025-01-15");
      expect(report.lineItems).toHaveLength(1);
      const item = report.lineItems[0];
      expect(item.counterpartyPlatform).toBe("seller-platform.com");
      expect(item.category).toBe("PAID");
      expect(item.totalAmountInr).toBe(30);
      expect(item.scheduledWindow).toBeNull();
      expect(item.deliveryStatus).toBe("UNKNOWN");
    });

    test("handles zero amount trades as SETTLED", async () => {
      const db = getTestDB();

      const txId = "tx-gift-1";
      await db.collection("settlements").insertOne({
        transactionId: txId,
        role: "SELLER",
        settlementStatus: "PENDING", // PENDING but amount is 0
        contractedQuantity: 10,
        createdAt: new Date("2025-01-15T10:00:00Z"),
      });

      await db.collection("orders").insertOne({
        transactionId: txId,
        order: {
          "beckn:orderValue": { value: 0 },
        },
      });

      const report = await generateReport("2025-01-15", "2025-01-15");
      const item = report.lineItems[0];
      expect(item.settlementStatus).toBe("SETTLED");
      expect(item.category).toBe("RECEIVED");
    });

    test("handles same-platform trades as SETTLED", async () => {
      const db = getTestDB();

      const PLATFORM_ID = process.env.BPP_ID || "p2p.terrarexenergy.com";
      const txId = "tx-intra-1";

      await db.collection("settlements").insertOne({
        transactionId: txId,
        role: "SELLER",
        settlementStatus: "PENDING",
        counterpartyPlatformId: PLATFORM_ID, // Same platform
        contractedQuantity: 10,
        createdAt: new Date("2025-01-15T10:00:00Z"),
      });

      await db.collection("orders").insertOne({
        transactionId: txId,
        order: {
          "beckn:orderValue": { value: 50 },
        },
      });

      const report = await generateReport("2025-01-15", "2025-01-15");
      const item = report.lineItems[0];
      expect(item.settlementStatus).toBe("SETTLED");
      expect(item.category).toBe("RECEIVED");
    });

    test("correctly determines delivery status based on window end time", async () => {
      const db = getTestDB();

      const now = new Date();
      const pastDate = new Date(now.getTime() - 3600000); // 1 hour ago
      const futureDate = new Date(now.getTime() + 3600000); // 1 hour from now

      const txIdPast = "tx-past";
      const txIdFuture = "tx-future";

      await db.collection("settlements").insertMany([
        {
          transactionId: txIdPast,
          role: "SELLER",
          settlementStatus: "SETTLED",
          createdAt: now,
          contractedQuantity: 1,
        },
        {
          transactionId: txIdFuture,
          role: "SELLER",
          settlementStatus: "SETTLED",
          createdAt: now,
          contractedQuantity: 1,
        }
      ]);

      await db.collection("orders").insertMany([
        {
          transactionId: txIdPast,
          order: {
            "beckn:orderItems": [{
              "beckn:acceptedOffer": {
                "beckn:offerAttributes": {
                  validityWindow: {
                    "schema:startTime": now.toISOString(),
                    "schema:endTime": pastDate.toISOString()
                  }
                }
              }
            }]
          }
        },
        {
          transactionId: txIdFuture,
          order: {
            "beckn:orderItems": [{
              "beckn:acceptedOffer": {
                "beckn:offerAttributes": {
                  validityWindow: {
                    "schema:startTime": now.toISOString(),
                    "schema:endTime": futureDate.toISOString()
                  }
                }
              }
            }]
          }
        }
      ]);

      const report = await generateReport(
        now.toISOString().split("T")[0],
        now.toISOString().split("T")[0]
      );

      const pastItem = report.lineItems.find(i => i.transactionId === txIdPast);
      const futureItem = report.lineItems.find(i => i.transactionId === txIdFuture);

      expect(pastItem?.deliveryStatus).toBe("DELIVERED");
      expect(futureItem?.deliveryStatus).toBe("SCHEDULED");
    });
  });
});

// Helper to create a line item with defaults
function createLineItem(overrides: Partial<SettlementLineItem>): SettlementLineItem {
  return {
    date: "2025-01-15",
    transactionId: "unknown",
    counterpartyPlatform: "unknown",
    counterpartyDiscom: "unknown",
    role: "SELLER",
    quantityKwh: 0,
    pricePerKwh: 0,
    totalAmountInr: 0,
    settlementStatus: "SETTLED",
    category: "RECEIVED",
    scheduledWindow: null,
    deliveryStatus: "UNKNOWN",
    ...overrides,
  };
}
