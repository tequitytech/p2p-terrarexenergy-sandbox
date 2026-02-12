import dotenv from "dotenv";
import { MongoClient } from "mongodb";

import type { Db } from "mongodb";
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "p2p_trading";

let db: Db;

export async function connectDB(): Promise<Db> {
  if (db) return db;

  console.log(`[DB] Connecting to MongoDB...`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`[DB] Connected to ${DB_NAME}`);

  // Create indexes
  await Promise.all([
    db.collection("catalogs").createIndex({ "beckn:id": 1 }, { unique: true }),
    db.collection("items").createIndex({ "beckn:id": 1 }, { unique: true }),
    db.collection("items").createIndex({ catalogId: 1 }),
    db.collection("offers").createIndex({ "beckn:id": 1 }, { unique: true }),
    db.collection("offers").createIndex({ catalogId: 1 }),
    db.collection("offers").createIndex({ lookupHash: 1, giftStatus: 1 }),
    db.collection("offers").createIndex({ isGift: 1, userId: 1 }),

    // Market snapshots for bidding service fallback cache
    db.collection("market_snapshots").createIndex({ "date_range.start": 1, "date_range.end": 1 },{ unique: true },),
    db.collection("market_snapshots").createIndex({ fetched_at: 1 },{ expireAfterSeconds: 86400 },), // TTL: 24 hours

    // Settlements collection for ledger tracking
    // Unique on transactionId + role (same txn can have BUYER and SELLER records)
    db.collection("settlements").createIndex({ transactionId: 1, role: 1 }, { unique: true }),
    db.collection("settlements").createIndex({ transactionId: 1 }),
    db.collection("settlements").createIndex({ settlementStatus: 1 }),
    db.collection("settlements").createIndex({ role: 1 }),
    db.collection("settlements").createIndex({ createdAt: 1 }),
    db.collection("settlements").createIndex({ settlementStatus: 1, onSettleNotified: 1 }),

    // Orders collection index for transaction lookup
    db.collection("orders").createIndex({ transactionId: 1 }, { unique: true }),
    db.collection("orders").createIndex({ userId: 1 }),
    db.collection("orders").createIndex({ type: 1 }),
    db.collection("orders").createIndex({ createdAt: -1 }),

    // Buyer Orders collection indexes
    db.collection("buyer_orders").createIndex({ transactionId: 1 }),
    db.collection("buyer_orders").createIndex({ userId: 1 }),
    db.collection("buyer_orders").createIndex({ type: 1 }),
    db.collection("buyer_orders").createIndex({ createdAt: -1 }),
    db.collection("buyer_orders").createIndex({ status: 1 }),

    // Users collection for authentication
    db.collection("users").createIndex({ phone: 1 }, { unique: true }),
    db.collection("users").createIndex({ meters: 1 }),

    // Payments collection for Razorpay integration
    db.collection("payments").createIndex({ orderId: 1 }),
    db.collection("payments").createIndex({ paymentId: 1 }),
    db.collection("payments").createIndex({ status: 1 }),
    db.collection("payments").createIndex({ "metadata.consumerNumber": 1 }),
    db.collection("payments").createIndex({ createdAt: 1 }),

    // Energy Requests collection
    db.collection("energy_requests").createIndex({ userId: 1 }),
    db.collection("energy_requests").createIndex({ status: 1 }),
    db.collection("energy_requests").createIndex({ createdAt: -1 }),

    // Publish Records collection for audit trail
    db.collection("publish_records").createIndex({ message_id: 1 }),
    db.collection("publish_records").createIndex({ transaction_id: 1 }),
    db.collection("publish_records").createIndex({ userId: 1 }),
    db.collection("publish_records").createIndex({ createdAt: -1 }),

    // OTPs collection for authentication
    db.collection("otps").createIndex({ phone: 1 }, { unique: true }),
    db.collection("otps").createIndex({ userId: 1 }),
    // TTL index: automatically delete expired OTPs
    db.collection("otps").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 120 }),

    // Notifications collection
    db.collection("notifications").createIndex({ userId: 1 }),
    db.collection("notifications").createIndex({ createdAt: -1 }),
    db.collection("notifications").createIndex({ isRead: 1 }),
  ]);
  return db;
}

export function getDB(): Db {
  if (!db) throw new Error("Database not connected");
  return db;
}
