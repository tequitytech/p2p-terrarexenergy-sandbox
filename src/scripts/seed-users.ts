/**
 * User Seeding Script
 *
 * Usage: npm run seed
 * or: npx ts-node src/scripts/seed-users.ts
 *
 * Seeds users from data/seed-users.json into MongoDB.
 * Skips users that already exist (by phone number).
 */

import fs from 'fs';
import path from 'path';
import { MongoClient, Db } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'p2p_trading';

interface SeedUser {
  phone: string;
  pin: string;
  name: string;
  isVerifiedBeneficiary?: boolean;
  beneficiaryType?: 'social' | 'known';
  did?: string;
}

interface SeedResult {
  inserted: number;
  skipped: number;
}

export function loadSeedFile(filePath: string): SeedUser[] {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  return JSON.parse(content);
}

export async function seedUsers(users: SeedUser[], db?: Db): Promise<SeedResult> {
  let client: MongoClient | null = null;
  let database: Db;

  if (db) {
    database = db;
  } else {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    database = client.db(DB_NAME);
  }

  try {
    let inserted = 0;
    let skipped = 0;

    for (const user of users) {
      const exists = await database.collection('users').findOne({ phone: user.phone });

      if (exists) {
        console.log(`[Seed] Skipping existing user: ${user.phone}`);
        skipped++;
        continue;
      }

      await database.collection('users').insertOne({
        phone: user.phone,
        pin: user.pin,
        name: user.name,
        vcVerified: false,
        isVerifiedBeneficiary: user.isVerifiedBeneficiary || false,
        beneficiaryType: user.beneficiaryType || (user.isVerifiedBeneficiary ? 'social' : undefined),
        profiles: {
          utilityCustomer: user.did ? { did: user.did, verifiedAt: new Date() } : null,
          consumptionProfile: null,
          generationProfile: null,
          storageProfile: null,
          programEnrollment: null,
        },
        meters: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(`[Seed] Inserted user: ${user.phone} (${user.name})`);
      inserted++;
    }

    return { inserted, skipped };
  } finally {
    if (client) {
      await client.close();
    }
  }
}

// CLI entry point
async function main() {
  console.log('[Seed] Starting user seed...');
  console.log(`[Seed] MongoDB URI: ${MONGO_URI}`);
  console.log(`[Seed] Database: ${DB_NAME}`);

  try {
    const seedFile = path.resolve(__dirname, '../../data/seed-users.json');
    console.log(`[Seed] Loading seed file: ${seedFile}`);

    const users = loadSeedFile(seedFile);
    console.log(`[Seed] Found ${users.length} users in seed file`);

    const result = await seedUsers(users);
    console.log(`[Seed] Complete: ${result.inserted} inserted, ${result.skipped} skipped`);

    process.exit(0);
  } catch (err) {
    console.error('[Seed] Error:', err);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
