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

  // Users collection for authentication
  await db.collection("users").createIndex({ phone: 1 }, { unique: true });
  await db.collection("users").createIndex({ meters: 1 });

  // Payments collection for Razorpay integration
  await db.collection("payments").createIndex({ orderId: 1 });
  await db.collection("payments").createIndex({ paymentId: 1 });
  await db.collection("payments").createIndex({ status: 1 });
  await db.collection("payments").createIndex({ "metadata.consumerNumber": 1 });
  await db.collection("payments").createIndex({ createdAt: 1 });

  return db;
}

export function getDB(): Db {
  if (!db) throw new Error("Database not connected");
  return db;
}
