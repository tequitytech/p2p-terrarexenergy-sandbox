import { MongoClient, Db } from "mongodb";
import dotenv from "dotenv";
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
  await db
    .collection("catalogs")
    .createIndex({ "beckn:id": 1 }, { unique: true });
  await db.collection("items").createIndex({ "beckn:id": 1 }, { unique: true });
  await db.collection("items").createIndex({ catalogId: 1 });
  await db
    .collection("offers")
    .createIndex({ "beckn:id": 1 }, { unique: true });
  await db.collection("offers").createIndex({ catalogId: 1 });

  // Market snapshots for bidding service fallback cache
  await db
    .collection("market_snapshots")
    .createIndex(
      { "date_range.start": 1, "date_range.end": 1 },
      { unique: true },
    );
  await db.collection("market_snapshots").createIndex(
    { fetched_at: 1 },
    { expireAfterSeconds: 86400 }, // TTL: 24 hours
  );

  // Settlements collection for ledger tracking
  // Unique on transactionId + role (same txn can have BUYER and SELLER records)
  await db
    .collection("settlements")
    .createIndex({ transactionId: 1, role: 1 }, { unique: true });
  await db.collection("settlements").createIndex({ transactionId: 1 });
  await db.collection("settlements").createIndex({ settlementStatus: 1 });
  await db.collection("settlements").createIndex({ role: 1 });
  await db.collection("settlements").createIndex({ createdAt: 1 });
  await db
    .collection("settlements")
    .createIndex({ settlementStatus: 1, onSettleNotified: 1 });

  // Orders collection index for transaction lookup
  await db
    .collection("orders")
    .createIndex({ transactionId: 1 }, { unique: true });
  await db.collection("orders").createIndex({ userId: 1 });
  await db.collection("orders").createIndex({ type: 1 });
  await db.collection("orders").createIndex({ createdAt: -1 });

  // Buyer Orders collection indexes
  await db.collection("buyer_orders").createIndex({ transactionId: 1 });
  await db.collection("buyer_orders").createIndex({ userId: 1 });
  await db.collection("buyer_orders").createIndex({ type: 1 });
  await db.collection("buyer_orders").createIndex({ createdAt: -1 });
  await db.collection("buyer_orders").createIndex({ status: 1 });

  // Users collection for authentication
  await db.collection("users").createIndex({ phone: 1 }, { unique: true });
  await db.collection("users").createIndex({ meters: 1 });

  // Payments collection for Razorpay integration
  await db.collection("payments").createIndex({ orderId: 1 });
  await db.collection("payments").createIndex({ paymentId: 1 });
  await db.collection("payments").createIndex({ status: 1 });
  await db.collection("payments").createIndex({ "metadata.consumerNumber": 1 });
  await db.collection("payments").createIndex({ createdAt: 1 });

  // Energy Requests collection
  await db.collection("energy_requests").createIndex({ userId: 1 });
  await db.collection("energy_requests").createIndex({ status: 1 });
  await db.collection("energy_requests").createIndex({ createdAt: -1 });

  // Publish Records collection for audit trail
  await db.collection("publish_records").createIndex({ message_id: 1 });
  await db.collection("publish_records").createIndex({ transaction_id: 1 });
  await db.collection("publish_records").createIndex({ userId: 1 });
  await db.collection("publish_records").createIndex({ createdAt: -1 });

  // OTPs collection for authentication
  await db.collection("otps").createIndex({ phone: 1 }, { unique: true });
  await db.collection("otps").createIndex({ userId: 1 });
  // Automatic expiry is handled by logic for rate limiting preservation, 
  // but we can add a TTL for clean up of very old records if we want (e.g., 24h).
  // For now, relying on logic-based validation as per plan.

  return db;
}

export function getDB(): Db {
  if (!db) throw new Error("Database not connected");
  return db;
}
