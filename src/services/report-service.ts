import { startOfDay, endOfDay, parseISO, format } from "date-fns";

import { getDB } from "../db";

import type { SettlementStatus, TradeRole } from "./settlement-store";
import type { Document } from "mongodb";

// ============================================
// Types
// ============================================

export type ReportCategory = "RECEIVED" | "RECEIVABLE" | "PAID" | "PAYABLE";
export type DeliveryStatus = "SCHEDULED" | "DELIVERED" | "UNKNOWN";

export interface ScheduledWindow {
  start: string;
  end: string;
}

export interface SettlementLineItem {
  date: string;
  transactionId: string;
  counterpartyPlatform: string;
  counterpartyDiscom: string;
  role: TradeRole;
  quantityKwh: number;
  pricePerKwh: number;
  totalAmountInr: number;
  settlementStatus: SettlementStatus;
  category: ReportCategory;
  scheduledWindow: ScheduledWindow | null;
  deliveryStatus: DeliveryStatus;
}

export interface ReportSummary {
  totalReceived: number;
  totalReceivables: number;
  totalPaid: number;
  totalPayables: number;
  netPosition: number;
}

export interface SettlementReport {
  platform: string;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  lineItems: SettlementLineItem[];
  summary: ReportSummary;
}

// ============================================
// Pure Functions
// ============================================

const PLATFORM_ID = process.env.BPP_ID || "p2p.terrarexenergy.com";

/**
 * Derive the financial category from role + settlement status.
 *
 * SELLER + SETTLED  → RECEIVED  (buyer platform already paid us)
 * SELLER + other    → RECEIVABLE (owed to us, not yet settled)
 * BUYER  + SETTLED  → PAID      (we already paid seller platform)
 * BUYER  + other    → PAYABLE   (we owe, not yet settled)
 */
export function deriveCategory(
  role: TradeRole,
  status: SettlementStatus,
): ReportCategory {
  if (role === "SELLER") {
    return status === "SETTLED" ? "RECEIVED" : "RECEIVABLE";
  }
  return status === "SETTLED" ? "PAID" : "PAYABLE";
}

/**
 * Compute financial summary from a list of line items.
 */
export function computeSummary(lineItems: SettlementLineItem[]): ReportSummary {
  let totalReceived = 0;
  let totalReceivables = 0;
  let totalPaid = 0;
  let totalPayables = 0;

  for (const item of lineItems) {
    switch (item.category) {
      case "RECEIVED":
        totalReceived += item.totalAmountInr;
        break;
      case "RECEIVABLE":
        totalReceivables += item.totalAmountInr;
        break;
      case "PAID":
        totalPaid += item.totalAmountInr;
        break;
      case "PAYABLE":
        totalPayables += item.totalAmountInr;
        break;
    }
  }

  return {
    totalReceived: round2(totalReceived),
    totalReceivables: round2(totalReceivables),
    totalPaid: round2(totalPaid),
    totalPayables: round2(totalPayables),
    netPosition: round2(
      totalReceived + totalReceivables - totalPaid - totalPayables,
    ),
  };
}

/**
 * Escape a single CSV field value: wrap in quotes if it contains commas,
 * quotes, or newlines. Double any embedded quotes.
 */
export function escapeCSV(value: string | number): string {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Render a full CSV document from the report data.
 */
export function toCSV(report: SettlementReport): string {
  const lines: string[] = [];

  // Metadata header
  lines.push(`"Settlement Report"`);
  lines.push(`"Platform","${report.platform}"`);
  lines.push(`"Generated","${report.generatedAt}"`);
  lines.push(`"Period","${report.periodFrom} to ${report.periodTo}"`);
  lines.push("");

  // Column headers
  lines.push(
    [
      "Date",
      "Transaction ID",
      "Counterparty Platform",
      "Counterparty Discom",
      "Role",
      "Quantity (kWh)",
      "Price/kWh (INR)",
      "Total Amount (INR)",
      "Settlement Status",
      "Category",
      "Scheduled Start",
      "Scheduled End",
      "Delivery Status",
    ].join(","),
  );

  // Line items
  for (const item of report.lineItems) {
    const scheduledStart = item.scheduledWindow?.start ?? "N/A";
    const scheduledEnd = item.scheduledWindow?.end ?? "N/A";

    lines.push(
      [
        escapeCSV(item.date),
        escapeCSV(item.transactionId),
        escapeCSV(item.counterpartyPlatform),
        escapeCSV(item.counterpartyDiscom),
        escapeCSV(item.role),
        escapeCSV(item.quantityKwh.toFixed(2)),
        escapeCSV(item.pricePerKwh.toFixed(2)),
        escapeCSV(item.totalAmountInr.toFixed(2)),
        escapeCSV(item.settlementStatus),
        escapeCSV(item.category),
        escapeCSV(scheduledStart),
        escapeCSV(scheduledEnd),
        escapeCSV(item.deliveryStatus),
      ].join(","),
    );
  }

  // Summary
  lines.push("");
  lines.push(`"SUMMARY"`);
  lines.push(
    `"Total Received (INR)","${report.summary.totalReceived.toFixed(2)}"`,
  );
  lines.push(
    `"Total Receivables (INR)","${report.summary.totalReceivables.toFixed(2)}"`,
  );
  lines.push(`"Total Paid (INR)","${report.summary.totalPaid.toFixed(2)}"`);
  lines.push(
    `"Total Payables (INR)","${report.summary.totalPayables.toFixed(2)}"`,
  );
  lines.push(`"Net Position (INR)","${report.summary.netPosition.toFixed(2)}"`);

  return lines.join("\n");
}

// ============================================
// Aggregation Pipelines
// ============================================

/**
 * Pipeline for SELLER settlements → join with `orders` collection.
 * Orders saved by the seller BPP (webhook/controller.ts) live in `orders`.
 */
export function buildSellerPipeline(from: Date, to: Date): Document[] {
  return [
    {
      $match: {
        role: "SELLER",
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $lookup: {
        from: "orders",
        localField: "transactionId",
        foreignField: "transactionId",
        as: "orderDocs",
      },
    },
    { $unwind: { path: "$orderDocs", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        transactionId: 1,
        role: 1,
        settlementStatus: 1,
        counterpartyPlatformId: 1,
        counterpartyDiscomId: 1,
        contractedQuantity: 1,
        createdAt: 1,
        // Fallback counterparty from order context (bap_id = buyer platform)
        orderBapId: "$orderDocs.context.bap_id",
        orderValue: "$orderDocs.order.beckn:orderValue.value",
        orderItems: "$orderDocs.order.beckn:orderItems",
      },
    },
  ];
}

/**
 * Pipeline for BUYER settlements → join with `buyer_orders` collection.
 * Orders saved by the buyer BAP (bap-webhook/controller.ts) live in `buyer_orders`.
 */
export function buildBuyerPipeline(from: Date, to: Date): Document[] {
  return [
    {
      $match: {
        role: "BUYER",
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $lookup: {
        from: "buyer_orders",
        localField: "transactionId",
        foreignField: "transactionId",
        as: "orderDocs",
      },
    },
    { $unwind: { path: "$orderDocs", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        transactionId: 1,
        role: 1,
        settlementStatus: 1,
        counterpartyPlatformId: 1,
        counterpartyDiscomId: 1,
        contractedQuantity: 1,
        createdAt: 1,
        // Fallback counterparty from order context (bpp_id = seller platform)
        orderBppId: "$orderDocs.order.context.bpp_id",
        orderValue: "$orderDocs.order.beckn:orderValue.value",
        orderItems: "$orderDocs.order.beckn:orderItems",
      },
    },
  ];
}

// ============================================
// Report Generation
// ============================================

const MAX_QUERY_TIME_MS = 30_000;

/**
 * Generate a settlement report for the given date range.
 * Runs two parallel aggregation pipelines (seller + buyer) and merges results.
 */
export async function generateReport(
  fromDate: string,
  toDate: string,
): Promise<SettlementReport> {
  const from = startOfDay(parseISO(fromDate));
  const to = endOfDay(parseISO(toDate));
  const db = getDB();

  const [sellerDocs, buyerDocs] = await Promise.all([
    db
      .collection("settlements")
      .aggregate<AggregatedSettlement>(buildSellerPipeline(from, to), {
        maxTimeMS: MAX_QUERY_TIME_MS,
      })
      .toArray(),
    db
      .collection("settlements")
      .aggregate<AggregatedSettlement>(buildBuyerPipeline(from, to), {
        maxTimeMS: MAX_QUERY_TIME_MS,
      })
      .toArray(),
  ]);

  const lineItems: SettlementLineItem[] = [];

  for (const doc of sellerDocs) {
    lineItems.push(mapToLineItem(doc, "SELLER"));
  }

  for (const doc of buyerDocs) {
    lineItems.push(mapToLineItem(doc, "BUYER"));
  }

  // Sort by date ascending, then transactionId
  lineItems.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.transactionId.localeCompare(b.transactionId),
  );

  const summary = computeSummary(lineItems);

  return {
    platform: PLATFORM_ID,
    generatedAt: new Date().toISOString(),
    periodFrom: format(from, "yyyy-MM-dd"),
    periodTo: format(to, "yyyy-MM-dd"),
    lineItems,
    summary,
  };
}

// ============================================
// Internal Helpers
// ============================================

/** Shape returned by the $project stage of our aggregation pipelines */
interface AggregatedSettlement {
  transactionId: string;
  role: TradeRole;
  settlementStatus: SettlementStatus;
  counterpartyPlatformId: string | null;
  counterpartyDiscomId: string | null;
  contractedQuantity: number;
  createdAt: Date;
  orderBapId?: string;
  orderBppId?: string;
  orderValue?: number;
  orderItems?: any[];
}

function mapToLineItem(
  doc: AggregatedSettlement,
  role: TradeRole,
): SettlementLineItem {
  const orderValue: number = doc.orderValue ?? 0;
  const quantity: number = doc.contractedQuantity;
  const pricePerKwh = quantity > 0 ? orderValue / quantity : 0;

  // Resolve counterparty platform
  let counterpartyPlatform: string;
  if (doc.counterpartyPlatformId) {
    counterpartyPlatform = doc.counterpartyPlatformId;
  } else if (role === "SELLER") {
    // Seller settlements: counterparty is the buyer (bap_id)
    counterpartyPlatform = doc.orderBapId ?? "unknown";
  } else {
    // Buyer settlements: counterparty is the seller (bpp_id)
    counterpartyPlatform = doc.orderBppId ?? "unknown";
  }

  // Business Rules for Settlement Status:
  // 1. If total amount is 0, consider it as settled
  // 2. If counterparty platform matches our platform, consider it as settled
  let effectiveSettlementStatus = doc.settlementStatus;
  const isSameOrg = counterpartyPlatform === PLATFORM_ID;
  const isZeroAmount = orderValue === 0;

  if (isSameOrg || isZeroAmount) {
    effectiveSettlementStatus = "SETTLED";
  }

  // Extract Scheduled Window and Delivery Status
  let scheduledWindow: ScheduledWindow | null = null;
  let deliveryStatus: DeliveryStatus = "UNKNOWN";

  if (doc.orderItems && doc.orderItems.length > 0) {
    const firstItem = doc.orderItems[0];
    const window =
      firstItem?.["beckn:acceptedOffer"]?.["beckn:offerAttributes"]?.[
        "validityWindow"
      ];

    if (window?.["schema:startTime"] && window?.["schema:endTime"]) {
      scheduledWindow = {
        start: window["schema:startTime"],
        end: window["schema:endTime"],
      };

      // If scheduled window end time is in the past -> DELIVERED, otherwise -> SCHEDULED
      const endTime = new Date(window["schema:endTime"]);
      deliveryStatus = endTime < new Date() ? "DELIVERED" : "SCHEDULED";
    }
  }

  return {
    date: format(new Date(doc.createdAt), "yyyy-MM-dd"),
    transactionId: doc.transactionId,
    counterpartyPlatform,
    counterpartyDiscom: doc.counterpartyDiscomId ?? "unknown",
    role,
    quantityKwh: round2(quantity),
    pricePerKwh: round2(pricePerKwh),
    totalAmountInr: round2(orderValue),
    settlementStatus: effectiveSettlementStatus,
    category: deriveCategory(role, effectiveSettlementStatus),
    scheduledWindow,
    deliveryStatus,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
