import { startOfDay, endOfDay, parseISO, format } from "date-fns";
import { getDB } from "../db";
import type { Document } from "mongodb";

// ============================================
// Types
// ============================================

export interface ScheduledWindow {
    start: string | null;
    end: string | null;
}

export interface SettlementLineItem {
    date: string;
    transactionId: string;
    counterpartyPlatform: string;
    counterpartyDiscom: string;
    role: "BUYER" | "SELLER" | "INTERNAL";
    quantityKwh: number;
    actualDeliveredKwh: number | null;
    deviationKwh: number | null;
    orderValueInr: number;
    settlementStatus: string;
    scheduledWindow: ScheduledWindow;
    deliveryStatus: "SCHEDULED" | "DELIVERED" | "UNKNOWN";
    payouts: Array<{
        role: string;
        amount: number;
        status: string;
        razorpayId: string | null;
    }>;
}

export interface PlatformStat {
    id: string;
    totalTrades: number;
    grossReceivable: number;
    grossPayable: number;
    netReceivable: number;
    netPayable: number;
}

export interface ReportStats {
    totalTrades: number;
    interPlatform: {
        count: number;
        volume: number;
    };
    crossPlatform: {
        count: number;
        totalReceivable: number;
        totalPayable: number;
        platforms: PlatformStat[];
    };
}

export interface SettlementReport {
    generatedAt: string;
    period: {
        start: string;
        end: string;
    };
    stats: ReportStats;
    trades: SettlementLineItem[];
}

export interface TransactionHistoryItem {
    date: string;
    amount: number;
    type: "CREDIT" | "DEBIT";
    status: string;
    description: string;
    transactionId: string;
    referenceId: string;
    originalStatus?: string;
}

// ============================================
// Core Logic
// ============================================

const OUR_PLATFORM_ID = process.env.BPP_ID || "p2p.terrarexenergy.com";

/**
 * Aggregation pipeline for SELLER settlements.
 */
function buildSellerPipeline(from: Date, to: Date): Document[] {
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
            $lookup: {
                from: "payouts",
                localField: "transactionId",
                foreignField: "transactionId",
                as: "payoutDocs",
            },
        },
        {
            $project: {
                transactionId: 1,
                role: 1,
                settlementStatus: 1,
                contractedQuantity: 1,
                actualDelivered: 1,
                deviationKwh: 1,
                counterpartyPlatformId: 1,
                counterpartyDiscomId: 1,
                createdAt: 1,
                orderValue: {
                    $ifNull: [
                        "$orderDocs.order.beckn:orderValue.value",
                        "$orderDocs.totalPrice",
                        "$orderDocs.order.beckn:payment.beckn:amount.value",
                        0
                    ]
                },
                orderItems: "$orderDocs.order.beckn:orderItems",
                orderBapId: "$orderDocs.order.context.bap_id",
                payouts: "$payoutDocs",
            },
        },
    ];
}

/**
 * Aggregation pipeline for BUYER settlements.
 */
function buildBuyerPipeline(from: Date, to: Date): Document[] {
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
            $lookup: {
                from: "payouts",
                localField: "transactionId",
                foreignField: "transactionId",
                as: "payoutDocs",
            },
        },
        {
            $project: {
                transactionId: 1,
                role: 1,
                settlementStatus: 1,
                contractedQuantity: 1,
                actualDelivered: 1,
                deviationKwh: 1,
                counterpartyPlatformId: 1,
                counterpartyDiscomId: 1,
                createdAt: 1,
                orderValue: {
                    $ifNull: [
                        "$orderDocs.order.beckn:orderValue.value",
                        "$orderDocs.totalPrice",
                        "$orderDocs.order.beckn:payment.beckn:amount.value",
                        0
                    ]
                },
                orderItems: "$orderDocs.order.beckn:orderItems",
                orderBapId: "$orderDocs.order.beckn:orderAttributes.bap_id",
                orderBppId: "$orderDocs.order.beckn:orderAttributes.bpp_id",
                payouts: "$payoutDocs",
            },
        },
    ];
}

export async function generateSettlementReport(fromDate: string, toDate: string): Promise<SettlementReport> {
    const from = startOfDay(parseISO(fromDate));
    const to = endOfDay(parseISO(toDate));
    const db = getDB();
    const [sellerDocs, buyerDocs] = await Promise.all([
        db.collection("settlements").aggregate(buildSellerPipeline(from, to)).toArray(),
        db.collection("settlements").aggregate(buildBuyerPipeline(from, to)).toArray(),
    ]);

    // Group by transactionId to handle internal trades (both Buyer & Seller records present)
    const groupedTrades = new Map<string, any[]>();
    [...sellerDocs, ...buyerDocs].forEach(doc => {
        const list = groupedTrades.get(doc.transactionId) || [];
        list.push(doc);
        groupedTrades.set(doc.transactionId, list);
    });

    const lineItems: SettlementLineItem[] = [];

    for (const [txnId, docs] of groupedTrades.entries()) {
        // If we have 2 docs for same txn, it means internal Buy/Sell occurred.
        // We consolidate into one "INTERNAL" view to avoid double counting.
        if (docs.length === 2) {
            const sellerSide = docs.find(d => d.role === "SELLER");
            const buyerSide = docs.find(d => d.role === "BUYER");
            lineItems.push(mapToInternalLineItem(sellerSide, buyerSide));
        } else {
            lineItems.push(mapToLineItem(docs[0]));
        }
    }

    // Sort by date then transactionId
    lineItems.sort((a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId));

    const stats = calculateStats(lineItems);

    return {
        generatedAt: new Date().toISOString(),
        period: {
            start: fromDate,
            end: toDate,
        },
        stats,
        trades: lineItems,
    };
}

function mapToLineItem(doc: any): SettlementLineItem {
    const orderValue = doc.orderValue || 0;
    const role = doc.role;

    // Resolve counterparty platform
    let counterpartyPlatform = doc.counterpartyPlatformId;
    if (!counterpartyPlatform) {
        if (role === "SELLER") {
            counterpartyPlatform = doc.orderBapId || "UNKNOWN";
        } else {
            counterpartyPlatform = doc.orderBppId || "UNKNOWN";
        }
    }

    // Extract scheduled window
    let scheduledWindow: ScheduledWindow = { start: null, end: null };
    let deliveryStatus: "SCHEDULED" | "DELIVERED" | "UNKNOWN" = "UNKNOWN";

    if (doc.orderItems && doc.orderItems.length > 0) {
        const offerAttr = doc.orderItems[0]?.["beckn:acceptedOffer"]?.["beckn:offerAttributes"];
        // Handle both timeWindow and validityWindow based on protocol variants seen in DB
        const window = offerAttr?.["beckn:timeWindow"] || offerAttr?.validityWindow || offerAttr?.deliveryWindow;

        if (window?.["schema:startTime"] && window?.["schema:endTime"]) {
            scheduledWindow = {
                start: window["schema:startTime"],
                end: window["schema:endTime"],
            };

            const endTime = new Date(window["schema:endTime"]);
            const now = new Date();

            // Mark as DELIVERED if:
            // 1. We have actual delivery data
            // 2. The trade is already settled
            // 3. The scheduled window has already passed
            if ((doc.actualDelivered && doc.actualDelivered > 0) || doc.settlementStatus === "SETTLED" || endTime < now) {
                deliveryStatus = "DELIVERED";
            } else {
                deliveryStatus = "SCHEDULED";
            }
        }
    }

    return {
        date: format(new Date(doc.createdAt), "yyyy-MM-dd"),
        transactionId: doc.transactionId,
        counterpartyPlatform,
        counterpartyDiscom: doc.counterpartyDiscomId || "UNKNOWN",
        role,
        quantityKwh: doc.contractedQuantity || 0,
        actualDeliveredKwh: doc.actualDelivered || null,
        deviationKwh: doc.deviationKwh || null,
        orderValueInr: orderValue,
        settlementStatus: doc.settlementStatus,
        scheduledWindow,
        deliveryStatus,
        payouts: (doc.payouts || []).map((p: any) => ({
            role: p.role,
            amount: p.amount,
            status: p.status,
            razorpayId: p.razorpayPayoutId || p.razorpayRefundId || null,
        })),
    };
}

function mapToInternalLineItem(sellerDoc: any, buyerDoc: any): SettlementLineItem {
    // Use seller side as base for most values, but calculate internal context
    const item = mapToLineItem(sellerDoc);
    item.role = "INTERNAL";
    item.counterpartyPlatform = OUR_PLATFORM_ID;
    // For internal trades, counterparty is also us, but we can list the internal discoms involved
    item.counterpartyDiscom = `${sellerDoc.counterpartyDiscomId || "UNKNOWN"} (Buyer) / ${buyerDoc.counterpartyDiscomId || "UNKNOWN"} (Seller)`;
    return item;
}

function calculateStats(lineItems: SettlementLineItem[]): ReportStats {
    const platformStatsMap = new Map<string, { count: number; receivable: number; payable: number }>();
    let interCount = 0;
    let interVolume = 0;
    let crossCount = 0;

    for (const item of lineItems) {
        const isInter = item.role === "INTERNAL" || item.counterpartyPlatform === OUR_PLATFORM_ID;

        if (isInter) {
            interCount++;
            interVolume += item.orderValueInr;
        } else {
            crossCount++;
            const platId = item.counterpartyPlatform;
            if (!platformStatsMap.has(platId)) {
                platformStatsMap.set(platId, { count: 0, receivable: 0, payable: 0 });
            }
            const pStat = platformStatsMap.get(platId)!;
            pStat.count++;
            if (item.role === "SELLER") {
                pStat.receivable += item.orderValueInr;
            } else {
                pStat.payable += item.orderValueInr;
            }
        }
    }

    // Netting per platform
    const crossPlatforms: PlatformStat[] = Array.from(platformStatsMap.entries()).map(([id, s]) => {
        const net = s.receivable - s.payable;
        return {
            id,
            totalTrades: s.count,
            grossReceivable: round2(s.receivable),
            grossPayable: round2(s.payable),
            netReceivable: net > 0 ? round2(net) : 0,
            netPayable: net < 0 ? round2(Math.abs(net)) : 0,
        };
    });

    const totalReceivable = crossPlatforms.reduce((sum, p) => sum + p.netReceivable, 0);
    const totalPayable = crossPlatforms.reduce((sum, p) => sum + p.netPayable, 0);

    return {
        totalTrades: lineItems.length,
        interPlatform: {
            count: interCount,
            volume: interVolume,
        },
        crossPlatform: {
            count: crossCount,
            totalReceivable,
            totalPayable,
            platforms: crossPlatforms,
        },
    };
}

/**
 * Escapes CSV values.
 */
function escapeCSV(val: any): string {
    const str = String(val);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export function toCSV(report: SettlementReport): string {
    const lines: string[] = [];

    // --- Section 1: Summary Statistics ---
    lines.push("SETTLEMENT REPORT SUMMARY");
    lines.push(`Generated At,${report.generatedAt}`);
    lines.push(`Period Start,${report.period.start}`);
    lines.push(`Period End,${report.period.end}`);
    lines.push("");

    lines.push("Overall Statistics");
    lines.push(`Total Trades,${report.stats.totalTrades}`);
    lines.push(`Inter-Platform Trades,${report.stats.interPlatform.count}`);
    lines.push(`Inter-Platform Volume (INR),${report.stats.interPlatform.volume}`);
    lines.push(`Cross-Platform Trades,${report.stats.crossPlatform.count}`);
    lines.push(`Total Receivable (Net),${report.stats.crossPlatform.totalReceivable}`);
    lines.push(`Total Payable (Net),${report.stats.crossPlatform.totalPayable}`);
    lines.push("");

    if (report.stats.crossPlatform.platforms.length > 0) {
        lines.push("Per-Platform Breakdown");
        lines.push("Platform ID,Total Trades,Gross Receivable,Gross Payable,Net Receivable,Net Payable");
        report.stats.crossPlatform.platforms.forEach(p => {
            lines.push([
                escapeCSV(p.id),
                p.totalTrades,
                p.grossReceivable,
                p.grossPayable,
                p.netReceivable,
                p.netPayable
            ].join(","));
        });
        lines.push("");
    }

    lines.push(""); // Padding

    // --- Section 2: Detailed Trade Log ---
    lines.push("DETAILED TRADE LOG");
    const header = [
        "Date", "Transaction ID", "Counterparty Platform", "Counterparty Discom", "Role",
        "Quantity (kWh)", "Actual Delivered (kWh)", "Deviation (kWh)", "Value (INR)",
        "Settlement Status", "Delivery Status", "Scheduled Start", "Scheduled End",
        "Payout Status", "Razorpay IDs"
    ].join(",");
    lines.push(header);

    const tradeRows = report.trades.map(t => [
        escapeCSV(t.date),
        escapeCSV(t.transactionId),
        escapeCSV(t.counterpartyPlatform),
        escapeCSV(t.counterpartyDiscom),
        escapeCSV(t.role),
        escapeCSV(t.quantityKwh),
        escapeCSV(t.actualDeliveredKwh || "N/A"),
        escapeCSV(t.deviationKwh || "0"),
        escapeCSV(t.orderValueInr),
        escapeCSV(t.settlementStatus),
        escapeCSV(t.deliveryStatus),
        escapeCSV(t.scheduledWindow.start || "N/A"),
        escapeCSV(t.scheduledWindow.end || "N/A"),
        escapeCSV(t.payouts.map(p => `${p.role}: ${p.status}`).join("; ")),
        escapeCSV(t.payouts.map(p => p.razorpayId).filter(Boolean).join("; "))
    ].join(","));

    return [...lines, ...tradeRows].join("\n");
}

export async function getUserTransactionHistory(userId: string, phone: string): Promise<TransactionHistoryItem[]> {
    const db = getDB();
    const [payouts, payments] = await Promise.all([
        db.collection("payouts").find({ userId }).toArray(),
        db.collection("payments").find({
            $or: [
                { userId: userId },
                { userPhone: phone }
            ],
            status: { $ne: "pending" }
        }).toArray()
    ]);

    const history: TransactionHistoryItem[] = [];
    // Map Payouts (Sellers earnings or Buyer refunds)
    payouts.forEach(p => {
        const isSeller = p.role === "SELLER";
        history.push({
            date: p.date instanceof Date ? p.date.toISOString() : new Date(p.date || Date.now()).toISOString(),
            amount: p.amount,
            type: "CREDIT",
            status: p.status,
            description: isSeller ? "Payout for energy sale" : "Refund for trade shortfall",
            transactionId: p.transactionId,
            referenceId: p.razorpayPayoutId || p.razorpayRefundId || "",
            originalStatus: p.status
        });
    });

    // Map Payments (Buyer purchases)
    payments.forEach(p => {
        const amount = typeof p.amount === 'string' ? parseFloat(p.amount) : p.amount;

        // Original Debit
        history.push({
            date: p.createdAt instanceof Date ? p.createdAt.toISOString() : new Date(p.createdAt || Date.now()).toISOString(),
            amount: amount,
            type: "DEBIT",
            status: p.status === 'refunded' ? 'paid' : p.status,
            description: "Payment for energy purchase",
            transactionId: p.transaction_id || p.transactionId || "",
            referenceId: p.orderId || p.paymentId || "",
            originalStatus: p.status
        });

        // If refunded, add a Credit entry
        if (p.status === "refunded") {
            history.push({
                date: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : new Date(p.updatedAt || Date.now()).toISOString(),
                amount: amount,
                type: "CREDIT",
                status: "processed",
                description: "Refund for unconfirmed order",
                transactionId: p.transaction_id || p.transactionId || "",
                referenceId: p.orderId || p.paymentId || "",
                originalStatus: p.status
            });
        }
    });

    // Sort by date descending
    return history.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Rounds a number to 2 decimal places.
 */
function round2(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
}
