
import { getDB } from '../db';

import type { LedgerRecord } from './ledger-client';
import type { ObjectId } from "mongodb";

export type SettlementStatus = 'PENDING' | 'BUYER_COMPLETED' | 'SELLER_COMPLETED' | 'SETTLED';
export type DiscomStatus = 'PENDING' | 'COMPLETED';
export type TradeRole = 'BUYER' | 'SELLER';

export interface SettlementDocument {
  _id?: ObjectId;
  transactionId: string;
  orderItemId: string;

  // Role: BUYER (BAP side) or SELLER (BPP side)
  role: TradeRole;

  // Counterparty info
  counterpartyPlatformId: string | null;
  counterpartyDiscomId: string | null;

  // Ledger sync state
  ledgerSyncedAt: Date | null;
  ledgerData: LedgerRecord | null;

  // Settlement state (derived from ledger)
  settlementStatus: SettlementStatus;
  buyerDiscomStatus: DiscomStatus;
  sellerDiscomStatus: DiscomStatus;

  // Validation metrics
  actualDelivered: number | null;
  contractedQuantity: number;
  deviationKwh: number | null;

  // Settlement cycle
  settlementCycleId: string | null;
  settledAt: Date | null;

  // Callback tracking
  onSettleNotified: boolean;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Derive settlement status from ledger data
 */
export function deriveSettlementStatus(ledgerData: LedgerRecord): SettlementStatus {
  const buyerDone = ledgerData.statusBuyerDiscom === 'COMPLETED';
  const sellerDone = ledgerData.statusSellerDiscom === 'COMPLETED';

  if (buyerDone && sellerDone) return 'SETTLED';
  if (buyerDone) return 'BUYER_COMPLETED';
  if (sellerDone) return 'SELLER_COMPLETED';
  return 'PENDING';
}

/**
 * Extract actual delivered quantity from ledger validation metrics
 * Uses the Min-of-Two rule: min(ACTUAL_PUSHED, ACTUAL_PULLED)
 */
function extractActualDelivered(ledgerData: LedgerRecord): number | null {
  const buyerMetrics = ledgerData.buyerFulfillmentValidationMetrics || [];
  const sellerMetrics = ledgerData.sellerFulfillmentValidationMetrics || [];

  const actualPushedObj = sellerMetrics.find(m => m.validationMetricType === 'ACTUAL_PUSHED');
  const actualPulledObj = buyerMetrics.find(m => m.validationMetricType === 'ACTUAL_PULLED');

  const actualPushed = actualPushedObj ? actualPushedObj.validationMetricValue : null;
  const actualPulled = actualPulledObj ? actualPulledObj.validationMetricValue : null;

  // If we have both, apply Min-of-Two
  if (actualPushed !== null && actualPulled !== null) {
    return Math.min(actualPushed, actualPulled);
  }

  // If we only have one (e.g. still in Round 1 or 2), return it as a provisional value
  if (actualPushed !== null) return actualPushed;
  if (actualPulled !== null) return actualPulled;

  return null;
}

/**
 * Generate settlement cycle ID based on date
 */
function generateSettlementCycleId(): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const cycle = Math.floor(now.getHours() / 6) + 1; // 4 cycles per day
  return `settle-${dateStr}-${String(cycle).padStart(3, '0')}`;
}

export const settlementStore = {
  /**
   * Create a new settlement record when order is confirmed
   * @param role - BUYER (BAP side) or SELLER (BPP side), defaults to SELLER for backward compatibility
   */
  async createSettlement(
    transactionId: string,
    orderItemId: string,
    contractedQuantity: number,
    role: TradeRole = 'SELLER',
    counterpartyPlatformId: string | null = null,
    counterpartyDiscomId: string | null = null
  ): Promise<SettlementDocument> {
    const db = getDB();
    const now = new Date();

    const settlement: SettlementDocument = {
      transactionId,
      orderItemId,
      role,
      counterpartyPlatformId,
      counterpartyDiscomId,
      ledgerSyncedAt: null,
      ledgerData: null,
      settlementStatus: 'PENDING',
      buyerDiscomStatus: 'PENDING',
      sellerDiscomStatus: 'PENDING',
      actualDelivered: null,
      contractedQuantity,
      deviationKwh: null,
      settlementCycleId: null,
      settledAt: null,
      onSettleNotified: false,
      createdAt: now,
      updatedAt: now
    };

    await db.collection('settlements').updateOne(
      { transactionId, role },
      { $setOnInsert: settlement },
      { upsert: true }
    );

    console.log(`[SettlementStore] Created settlement: txn=${transactionId}, role=${role}, qty=${contractedQuantity}`);
    return settlement;
  },

  /**
   * Get settlement by transaction ID and optional role
   */
  async getSettlement(transactionId: string, role?: TradeRole): Promise<SettlementDocument | null> {
    const db = getDB();
    const query: any = { transactionId };
    if (role) query.role = role;
    return db.collection<SettlementDocument>('settlements').findOne(query);
  },

  /**
   * Get all settlements for a transaction (both buyer and seller if they exist)
   */
  async getSettlementsByTransaction(transactionId: string): Promise<SettlementDocument[]> {
    const db = getDB();
    return db.collection<SettlementDocument>('settlements')
      .find({ transactionId })
      .toArray();
  },

  /**
   * Get all settlements with optional status filter
   */
  async getSettlements(status?: SettlementStatus): Promise<SettlementDocument[]> {
    const db = getDB();
    const query = status ? { settlementStatus: status } : {};
    return db.collection<SettlementDocument>('settlements')
      .find(query)
      .sort({ updatedAt: -1 })
      .toArray();
  },

  /**
   * Get pending settlements that need polling
   */
  async getPendingSettlements(): Promise<SettlementDocument[]> {
    const db = getDB();
    return db.collection<SettlementDocument>('settlements')
      .find({
        settlementStatus: { $ne: 'SETTLED' }
      })
      .sort({ createdAt: 1 })
      .toArray();
  },

  /**
   * Update settlement from ledger data
   */
  async updateFromLedger(
    transactionId: string,
    role: TradeRole,
    ledgerData: LedgerRecord
  ): Promise<SettlementDocument | null> {
    const db = getDB();
    const now = new Date();

    const settlementStatus = deriveSettlementStatus(ledgerData);
    const actualDelivered = extractActualDelivered(ledgerData);

    // Get existing settlement for deviation calculation
    const existing = await this.getSettlement(transactionId, role);
    const contractedQuantity = existing?.contractedQuantity || 0;
    const deviationKwh = actualDelivered !== null
      ? actualDelivered - contractedQuantity
      : null;

    const updateData: Partial<SettlementDocument> = {
      ledgerSyncedAt: now,
      ledgerData,
      settlementStatus,
      buyerDiscomStatus: ledgerData.statusBuyerDiscom || 'PENDING',
      sellerDiscomStatus: ledgerData.statusSellerDiscom || 'PENDING',
      actualDelivered,
      deviationKwh,
      updatedAt: now
    };

    // Set settlement cycle and time if now settled
    if (settlementStatus === 'SETTLED' && !existing?.settledAt) {
      updateData.settlementCycleId = generateSettlementCycleId();
      updateData.settledAt = now;
    }

    const result = await db.collection<SettlementDocument>('settlements').findOneAndUpdate(
      { transactionId, role },
      { $set: updateData },
      { returnDocument: 'after' }
    );

    if (result) {
      console.log(`[SettlementStore] Updated from ledger: txn=${transactionId}, status=${settlementStatus}`);
    }

    return result;
  },

  /**
   * Mark settlement as notified (on_settle callback sent)
   */
  async markOnSettleNotified(transactionId: string, role: TradeRole): Promise<void> {
    const db = getDB();
    await db.collection('settlements').updateOne(
      { transactionId, role },
      { $set: { onSettleNotified: true, updatedAt: new Date() } }
    );
    console.log(`[SettlementStore] Marked on_settle notified: txn=${transactionId}`);
  },

  /**
   * Get settlements that are settled but not yet notified
   */
  async getUnnotifiedSettlements(): Promise<SettlementDocument[]> {
    const db = getDB();
    return db.collection<SettlementDocument>('settlements')
      .find({
        settlementStatus: 'SETTLED',
        onSettleNotified: false
      })
      .toArray();
  },

  /**
   * Get settlement statistics
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    buyerCompleted: number;
    sellerCompleted: number;
    settled: number;
  }> {
    const db = getDB();
    const pipeline = [
      {
        $group: {
          _id: '$settlementStatus',
          count: { $sum: 1 }
        }
      }
    ];

    const results = await db.collection('settlements').aggregate(pipeline).toArray();
    const stats = {
      total: 0,
      pending: 0,
      buyerCompleted: 0,
      sellerCompleted: 0,
      settled: 0
    };

    for (const r of results) {
      stats.total += r.count;
      switch (r._id) {
        case 'PENDING': stats.pending = r.count; break;
        case 'BUYER_COMPLETED': stats.buyerCompleted = r.count; break;
        case 'SELLER_COMPLETED': stats.sellerCompleted = r.count; break;
        case 'SETTLED': stats.settled = r.count; break;
      }
    }

    return stats;
  }
};
