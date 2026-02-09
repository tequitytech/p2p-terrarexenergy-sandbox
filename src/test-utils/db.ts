/**
 * MongoDB Memory Server Test Utilities
 *
 * Provides isolated in-memory MongoDB for tests
 */

import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

import type { Db } from 'mongodb';

let mongoServer: MongoMemoryServer | null = null;
let mongoClient: MongoClient | null = null;
let testDb: Db | null = null;

/**
 * Start in-memory MongoDB server and connect
 */
export async function setupTestDB(): Promise<Db> {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  mongoClient = new MongoClient(uri);
  await mongoClient.connect();

  testDb = mongoClient.db('test_p2p_trading');
  return testDb;
}

/**
 * Close connection and stop server
 */
export async function teardownTestDB(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
  }
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
  testDb = null;
}

/**
 * Get the test database instance
 */
export function getTestDB(): Db {
  if (!testDb) {
    throw new Error('Test DB not initialized. Call setupTestDB() first.');
  }
  return testDb;
}

/**
 * Clear all collections in the test database
 */
export async function clearTestDB(): Promise<void> {
  if (!testDb) return;

  const collections = await testDb.listCollections().toArray();
  for (const collection of collections) {
    await testDb.collection(collection.name).deleteMany({});
  }
}

/**
 * Seed test data helpers
 */
export async function seedItem(itemId: string, quantity: number, catalogId: string = 'test-catalog'): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('items').insertOne({
    'beckn:id': itemId,
    'beckn:itemAttributes': {
      '@type': 'EnergyResource',
      sourceType: 'SOLAR',
      deliveryMode: 'GRID_INJECTION',
      meterId: '100200300',
      availableQuantity: quantity,
    },
    catalogId,
    updatedAt: new Date()
  });
}

export async function seedOffer(
  offerId: string,
  itemId: string,
  price: number,
  quantity: number,
  catalogId: string = 'test-catalog'
): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('offers').insertOne({
    'beckn:id': offerId,
    'beckn:items': [itemId],
    'beckn:price': {
      '@type': 'schema:PriceSpecification',
      'schema:price': price,
      'schema:priceCurrency': 'INR'
    },
    'beckn:offerAttributes': {
      '@type': 'EnergyTradeOffer',
      pricingModel: 'PER_KWH',
      maximumQuantity: quantity
    },
    catalogId,
    updatedAt: new Date()
  });
}

export async function seedCatalog(catalogId: string): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('catalogs').insertOne({
    'beckn:id': catalogId,
    'beckn:descriptor': {
      '@type': 'beckn:Descriptor',
      'schema:name': 'Test Catalog'
    },
    'beckn:bppId': 'p2p.terrarexenergy.com',
    'beckn:isActive': true,
    updatedAt: new Date()
  });
}

export async function seedOrder(transactionId: string, orderData: any): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('orders').insertOne({
    transactionId,
    ...orderData,
    confirmedAt: new Date(),
    updatedAt: new Date()
  });
}

export async function seedSettlement(
  transactionId: string,
  role: 'BUYER' | 'SELLER',
  status: string = 'PENDING',
  contractedQuantity: number = 10
): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('settlements').insertOne({
    transactionId,
    orderItemId: `order-item-${transactionId}`,
    role,
    counterpartyPlatformId: null,
    counterpartyDiscomId: null,
    ledgerSyncedAt: null,
    ledgerData: null,
    settlementStatus: status,
    buyerDiscomStatus: 'PENDING',
    sellerDiscomStatus: 'PENDING',
    actualDelivered: null,
    contractedQuantity,
    deviationKwh: null,
    settlementCycleId: null,
    settledAt: null,
    onSettleNotified: false,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

/**
 * Get item by ID from test DB
 */
export async function getTestItem(itemId: string): Promise<any> {
  if (!testDb) throw new Error('Test DB not initialized');
  return testDb.collection('items').findOne({ 'beckn:id': itemId });
}

/**
 * Get settlement from test DB
 */
export async function getTestSettlement(transactionId: string, role?: string): Promise<any> {
  if (!testDb) throw new Error('Test DB not initialized');
  const query: any = { transactionId };
  if (role) query.role = role;
  return testDb.collection('settlements').findOne(query);
}

/**
 * Seed a user for auth tests
 */
export async function seedUser(user: {
  phone: string;
  pin: string;
  name: string;
}): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('users').insertOne({
    phone: user.phone,
    pin: user.pin,
    name: user.name,
    vcVerified: false,
    profiles: {
      utilityCustomer: null,
      consumptionProfile: null,
      generationProfile: null,
      storageProfile: null,
      programEnrollment: null,
    },
    meters: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed a user with VC profiles for auth tests
 */
export async function seedUserWithProfiles(user: {
  phone: string;
  pin: string;
  name: string;
  vcVerified?: boolean;
  profiles?: {
    utilityCustomer?: any;
    consumptionProfile?: any;
    generationProfile?: any;
    storageProfile?: any;
    programEnrollment?: any;
  };
  meters?: string[];
}): Promise<void> {
  if (!testDb) throw new Error('Test DB not initialized');

  await testDb.collection('users').insertOne({
    phone: user.phone,
    pin: user.pin,
    name: user.name,
    vcVerified: user.vcVerified ?? false,
    profiles: {
      utilityCustomer: user.profiles?.utilityCustomer ?? null,
      consumptionProfile: user.profiles?.consumptionProfile ?? null,
      generationProfile: user.profiles?.generationProfile ?? null,
      storageProfile: user.profiles?.storageProfile ?? null,
      programEnrollment: user.profiles?.programEnrollment ?? null,
    },
    meters: user.meters ?? [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Get a user from test DB
 */
export async function getTestUser(phone: string): Promise<any> {
  if (!testDb) throw new Error('Test DB not initialized');
  return testDb.collection('users').findOne({ phone });
}
