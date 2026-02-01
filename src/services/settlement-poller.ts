import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { ledgerClient } from './ledger-client';
import { settlementStore, SettlementDocument } from './settlement-store';
import { catalogStore } from './catalog-store';
import { orderService } from './order-service';

const ENABLE_POLLING = process.env.ENABLE_SETTLEMENT_POLLING !== 'false';
const POLL_INTERVAL_MS = parseInt(process.env.SETTLEMENT_POLL_INTERVAL_MS || '300000', 10); // 5 minutes
const DISCOM_ID = process.env.DISCOM_ID || 'BESCOM-KA';

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
        domain: savedOrder?.context?.domain || 'beckn.one:deg:p2p-trading:2.0.0'
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
        const ledgerRecord = await ledgerClient.queryTradeByTransaction(
          settlement.transactionId,
          DISCOM_ID
        );

        if (ledgerRecord) {
          const previousStatus = settlement.settlementStatus;
          const updated = await settlementStore.updateFromLedger(
            settlement.transactionId,
            ledgerRecord
          );

          if (updated) {
            result.settlementsUpdated++;

            // --- Sync Buyer Order Status ---
            if (settlement.role === "BUYER") {
              if (
                updated.settlementStatus === "SETTLED"
              ) {
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
              }
            }

            // Check if newly settled
            if (updated.settlementStatus === 'SETTLED' && previousStatus !== 'SETTLED') {
              result.newlySettled.push(settlement.transactionId);

              // Trigger callback if not already notified
              if (!updated.onSettleNotified) {
                await triggerOnSettle(updated);
                await settlementStore.markOnSettleNotified(settlement.transactionId);
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
    pollOnce().catch(err => console.error(`[SettlementPoller] Initial poll failed:`, err));
  }, 5000);

  // Start interval polling
  pollInterval = setInterval(() => {
    pollOnce().catch(err => console.error(`[SettlementPoller] Poll failed:`, err));
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

  const ledgerRecord = await ledgerClient.queryTradeByTransaction(transactionId, DISCOM_ID);
  if (!ledgerRecord) {
    console.log(`[SettlementPoller] No ledger record found for: ${transactionId}`);
    return null;
  }

  const updated = await settlementStore.updateFromLedger(transactionId, ledgerRecord);

  // Trigger callback if newly settled
  if (updated?.settlementStatus === 'SETTLED' && !updated.onSettleNotified) {
    await triggerOnSettle(updated);
    await settlementStore.markOnSettleNotified(transactionId);
  }

  return updated;
}

export const settlementPoller = {
  pollOnce,
  startPolling,
  stopPolling,
  getPollingStatus,
  refreshSettlement,
  triggerOnSettle
};
