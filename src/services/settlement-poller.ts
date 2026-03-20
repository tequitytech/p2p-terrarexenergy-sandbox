import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

import { catalogStore } from './catalog-store';
import { ledgerClient } from './ledger-client';
import { orderService } from './order-service';
import { settlementStore } from './settlement-store';
import { paymentService } from './payment-service';
import { getDB } from '../db';

import type { SettlementDocument } from './settlement-store';
import { ObjectId } from 'mongodb';


const ENABLE_POLLING = process.env.ENABLE_SETTLEMENT_POLLING !== 'false';
const POLL_INTERVAL_MS = parseInt(process.env.SETTLEMENT_POLL_INTERVAL_MS || '300000', 10); // 5 minutes
const DISCOM_ID = process.env.DISCOM_ID || 'BESCOM-KA';
const ourPlatformId = process.env.BPP_ID || "p2p.terrarexenergy.com"; // Used to identify inter-platform trades

export interface PollResult {
  polledAt: Date;
  settlementsChecked: number;
  settlementsUpdated: number;
  newlySettled: string[];
  errors: string[];
}

let pollInterval: NodeJS.Timeout | null = null;
let isPolling = false;
let lastPollResult: PollResult | null = null;

/**
 * Trigger on_settle callback for a settled transaction
 */
export async function triggerOnSettle(settlement: SettlementDocument): Promise<void> {
  const callbackEndpoint = process.env.ON_SETTLE_CALLBACK_URL;
  if (!callbackEndpoint) {
    console.log(`[SettlementPoller] No ON_SETTLE_CALLBACK_URL configured, skipping callback`);
    return;
  }

  try {
    // Get original order for context
    const savedOrder = await catalogStore.getOrderByTransactionId(settlement.transactionId);

    const payload = {
      context: {
        version: "2.0.0",
        action: "on_settle",
        timestamp: new Date().toISOString(),
        message_id: uuidv4(),
        transaction_id: settlement.transactionId,
        domain: savedOrder?.context?.domain || 'beckn.one:deg:p2p-trading-interdiscom:2.0.0'
      },
      message: {
        settlement: {
          transactionId: settlement.transactionId,
          orderItemId: settlement.orderItemId,
          settlementStatus: settlement.settlementStatus,
          settlementCycleId: settlement.settlementCycleId,
          contractedQuantity: settlement.contractedQuantity,
          actualDelivered: settlement.actualDelivered,
          deviationKwh: settlement.deviationKwh,
          settledAt: settlement.settledAt?.toISOString(),
          buyerDiscomStatus: settlement.buyerDiscomStatus,
          sellerDiscomStatus: settlement.sellerDiscomStatus
        }
      }
    };

    console.log(`[SettlementPoller] Triggering on_settle to: ${callbackEndpoint}`);
    const response = await axios.post(callbackEndpoint, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`[SettlementPoller] on_settle callback response:`, response.data);
  } catch (error: any) {
    console.error(`[SettlementPoller] on_settle callback failed: ${error.message}`);
  }
}

/**
 * Poll ledger for all pending settlements and update their status
 */
export async function pollOnce(): Promise<PollResult> {
  const result: PollResult = {
    polledAt: new Date(),
    settlementsChecked: 0,
    settlementsUpdated: 0,
    newlySettled: [],
    errors: []
  };

  if (isPolling) {
    console.log(`[SettlementPoller] Poll already in progress, skipping`);
    return result;
  }

  isPolling = true;
  console.log(`[SettlementPoller] Starting poll cycle...`);

  try {
    const pendingSettlements = await settlementStore.getPendingSettlements();
    result.settlementsChecked = pendingSettlements.length;
    console.log(`[SettlementPoller] Found ${pendingSettlements.length} pending settlements`);

    for (const settlement of pendingSettlements) {
      try {
        const discomIdToQuery = settlement.counterpartyDiscomId || DISCOM_ID;
        const ledgerRecord = await ledgerClient.queryTradeByTransaction(
          settlement.transactionId,
          settlement.role === "SELLER"
            ? { discomIdBuyer: discomIdToQuery }
            : { discomIdSeller: discomIdToQuery }
        );

        if (ledgerRecord) {
          const previousStatus = settlement.settlementStatus;
          const updated = await settlementStore.updateFromLedger(
            settlement.transactionId,
            settlement.role,
            ledgerRecord
          );

          if (updated) {
            result.settlementsUpdated++;

            // --- Sync Buyer/Seller Order Status ---
            try {
              if (updated.settlementStatus === "SETTLED") {
                if (settlement.role === "BUYER") {
                  console.log(
                    `[SettlementPoller] Buyer Order completed via Ledger: ${settlement.transactionId}`,
                  );
                  await orderService.updateBuyerOrderStatus(
                    settlement.transactionId,
                    "DELIVERED",
                    {
                      settlementId: settlement._id?.toString() || "",
                    },
                  );
                } else if (settlement.role === "SELLER") {
                  console.log(
                    `[SettlementPoller] Seller Order completed via Ledger: ${settlement.transactionId}`,
                  );
                  await orderService.updateSellerOrderStatus(
                    settlement.transactionId,
                    "DELIVERED"
                  );
                }

                // --- Execute Financial Payouts & Refunds if Inter-platform ---
                if (
                  updated.counterpartyPlatformId &&
                  ourPlatformId &&
                  updated.counterpartyPlatformId === ourPlatformId
                ) {
                  console.log(`[SettlementPoller] Inter-platform trade detected for ${settlement.transactionId}. Calculating payouts...`);

                  // Retrieve the order to find the price
                  const order = await catalogStore.getOrderByTransactionId(settlement.transactionId);
                  const priceValuePath = order?.order?.['beckn:orderItems']?.[0]?.['beckn:acceptedOffer']?.['beckn:price']?.['schema:price'];
                  const pricePerKwh = parseFloat(priceValuePath || "0");

                  if (pricePerKwh > 0 && updated.actualDelivered !== null) {
                    const db = getDB();

                    if (settlement.role === "SELLER") {
                      // Seller Payload Logic: Payout = delivered Qty * price
                      const payoutAmount = updated.actualDelivered * pricePerKwh;
                      console.log(`[SettlementPoller] Seller Payout Amount Calculated: ₹${payoutAmount} for ${updated.actualDelivered} kWh`);

                      const sellerOrder = await db.collection("orders").findOne({ transactionId: settlement.transactionId, type: "seller" });
                      if (sellerOrder && sellerOrder.userId) {
                        // Idempotency check: Ensure we haven't already processed this payout
                        const existingPayout = await db.collection("payouts").findOne({
                          transactionId: settlement.transactionId,
                          role: "SELLER"
                        });

                        if (existingPayout) {
                          console.log(`[SettlementPoller] Payout already processed for trade: ${settlement.transactionId}`);
                          continue;
                        }

                        const sellerUser = await db.collection("users").findOne({ _id: new ObjectId(sellerOrder.userId) });

                        if (sellerUser?.razorpayFundAccountId) {
                          try {
                            const payoutResp = await paymentService.processSellerPayout(
                              sellerUser.razorpayFundAccountId,
                              payoutAmount,
                              settlement.transactionId
                            );

                            await db.collection("payouts").insertOne({
                              transactionId: settlement.transactionId,
                              role: "SELLER",
                              userId: sellerOrder.userId,
                              amount: payoutAmount,
                              razorpayPayoutId: payoutResp.id,
                              status: "INITIATED",
                              settlementId: sellerOrder?.settlementId ?? null,
                              sellerOrderId: sellerOrder?._id?.toString() ?? null,
                              date: new Date()
                            });
                          } catch (err: any) {
                            console.error(`[SettlementPoller] Payout to seller failed: ${err.message}`);
                          }
                        } else {
                          console.error(`[SettlementPoller] Seller ${sellerOrder.userId} has no Razorpay Fund Account for payout`);
                        }
                      }
                    } else if (settlement.role === "BUYER") {
                      // Buyer Refund Logic: Refund = shortFall * price
                      const contractedQty = updated.contractedQuantity || 0;
                      const shortfall = contractedQty - updated.actualDelivered;

                      if (shortfall > 0) {
                        const refundAmount = shortfall * pricePerKwh;
                        console.log(`[SettlementPoller] Buyer Refund Amount Calculated: ₹${refundAmount} for ${shortfall} kWh shortfall`);

                        const buyerOrder = await db.collection("buyer_orders").findOne({ transactionId: settlement.transactionId, type: "buyer" });
                        if (buyerOrder?.paymentId) {
                          // Idempotency check: Ensure we haven't already processed this refund
                          const existingRefund = await db.collection("payouts").findOne({
                            transactionId: settlement.transactionId,
                            role: "BUYER"
                          });

                          if (existingRefund) {
                            console.log(`[SettlementPoller] Refund already processed for trade: ${settlement.transactionId}`);
                            continue;
                          }

                          try {
                            const refundResp = await paymentService.refundPayment(buyerOrder.paymentId, refundAmount);

                            await db.collection("payouts").insertOne({
                              transactionId: settlement.transactionId,
                              role: "BUYER",
                              userId: buyerOrder.userId,
                              amount: refundAmount,
                              razorpayRefundId: refundResp.id,
                              status: "INITIATED",
                              settlementId: settlement?._id?.toString() ?? null,
                              buyerOrderId: buyerOrder?._id?.toString() ?? null,
                              date: new Date()
                            });
                          } catch (err: any) {
                            console.error(`[SettlementPoller] Refund to buyer failed: ${err.message}`);
                          }
                        } else {
                          console.error(`[SettlementPoller] Buyer order ${settlement.transactionId} missing paymentId for refund`);
                        }
                      }
                    }
                  } else {
                    console.warn(`[SettlementPoller] Skipping payout logic: missing pricePerKwh (${pricePerKwh}) or actualDelivered (${updated.actualDelivered})`);
                  }
                }
              }
            } catch (updateError: any) {
              console.error(`[SettlementPoller] Error updating order status for ${settlement.transactionId}: ${updateError.message}`);
            }

            // Check if newly settled
            if (updated.settlementStatus === 'SETTLED' && previousStatus !== 'SETTLED') {
              result.newlySettled.push(settlement.transactionId);

              // Trigger callback if not already notified
              if (!updated.onSettleNotified) {
                await triggerOnSettle(updated);
                await settlementStore.markOnSettleNotified(settlement.transactionId, settlement.role);
              }
            }
          }
        }
      } catch (error: any) {
        const errMsg = `Failed to poll ${settlement.transactionId}: ${error.message}`;
        console.error(`[SettlementPoller] ${errMsg}`);
        result.errors.push(errMsg);
      }
    }

    lastPollResult = result;
    console.log(`[SettlementPoller] Poll complete: checked=${result.settlementsChecked}, updated=${result.settlementsUpdated}, settled=${result.newlySettled.length}`);
  } catch (error: any) {
    const errMsg = `Poll cycle failed: ${error.message}`;
    console.error(`[SettlementPoller] ${errMsg}`);
    result.errors.push(errMsg);
  } finally {
    isPolling = false;
  }

  return result;
}

/**
 * Start background polling service
 */
export function startPolling(): void {
  if (!ENABLE_POLLING) {
    console.log(`[SettlementPoller] Polling disabled (ENABLE_SETTLEMENT_POLLING=false)`);
    return;
  }

  if (pollInterval) {
    console.log(`[SettlementPoller] Polling already started`);
    return;
  }

  console.log(`[SettlementPoller] Starting polling service (interval: ${POLL_INTERVAL_MS}ms)`);

  // Run first poll after a short delay (let app initialize)
  setTimeout(() => {
    pollOnce().catch(err => { console.error(`[SettlementPoller] Initial poll failed:`, err); });
  }, 5000);

  // Start interval polling
  pollInterval = setInterval(() => {
    pollOnce().catch(err => { console.error(`[SettlementPoller] Poll failed:`, err); });
  }, POLL_INTERVAL_MS);
}

/**
 * Stop background polling service
 */
export function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log(`[SettlementPoller] Polling service stopped`);
  }
}

/**
 * Get current polling status
 */
export function getPollingStatus(): {
  enabled: boolean;
  running: boolean;
  isPolling: boolean;
  intervalMs: number;
  lastPollResult: PollResult | null;
} {
  return {
    enabled: ENABLE_POLLING,
    running: pollInterval !== null,
    isPolling,
    intervalMs: POLL_INTERVAL_MS,
    lastPollResult
  };
}

/**
 * Force refresh a specific settlement from ledger
 */
export async function refreshSettlement(transactionId: string): Promise<SettlementDocument | null> {
  console.log(`[SettlementPoller] Force refreshing settlement: ${transactionId}`);

  const existing = await settlementStore.getSettlementsByTransaction(transactionId);
  const discomIdToQuery = existing?.[0]?.counterpartyDiscomId || DISCOM_ID;

  const ledgerRecord = await ledgerClient.queryTradeByTransaction(
    transactionId,
    existing?.[0]?.role === "SELLER"
      ? { discomIdBuyer: discomIdToQuery }
      : { discomIdSeller: discomIdToQuery }
  );
  if (!ledgerRecord) {
    console.log(`[SettlementPoller] No ledger record found for: ${transactionId}`);
    return null;
  }

  let lastUpdated: SettlementDocument | null = null;
  for (const record of existing) {
    const updated = await settlementStore.updateFromLedger(transactionId, record.role, ledgerRecord);

    // Trigger callback if newly settled
    if (updated?.settlementStatus === 'SETTLED' && !updated.onSettleNotified) {
      await triggerOnSettle(updated);
      await settlementStore.markOnSettleNotified(transactionId, record.role);
    }
    lastUpdated = updated;
  }

  return lastUpdated;
}

export const settlementPoller = {
  pollOnce,
  startPolling,
  stopPolling,
  getPollingStatus,
  refreshSettlement,
  triggerOnSettle
};
