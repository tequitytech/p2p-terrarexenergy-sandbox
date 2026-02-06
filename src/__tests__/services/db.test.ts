/**
 * Unit tests for Database module (src/db/index.ts)
 *
 * Tests connectDB and getDB functions with mocked MongoDB client.
 * All MongoDB operations are mocked - no real database connections.
 */

// Mock mongodb module BEFORE importing the db module
const mockCreateIndex = jest.fn().mockResolvedValue('indexName');
const mockCollection = jest.fn().mockReturnValue({
    createIndex: mockCreateIndex
});
const mockDb = jest.fn().mockReturnValue({
    collection: mockCollection
});
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClient = jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    db: mockDb
}));

jest.mock('mongodb', () => ({
    MongoClient: mockClient,
    Db: jest.fn()
}));

// We need to reset the module state between tests since db is cached
let connectDB: typeof import('../../db').connectDB;
let getDB: typeof import('../../db').getDB;

describe('Database Module Tests', () => {
    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Reset the module cache to get fresh state
        jest.resetModules();

        // Re-setup mocks after module reset
        mockCreateIndex.mockResolvedValue('indexName');
        mockCollection.mockReturnValue({
            createIndex: mockCreateIndex
        });
        mockDb.mockReturnValue({
            collection: mockCollection
        });
        mockConnect.mockResolvedValue(undefined);

        // Re-import after reset
        const dbModule = require('../../db');
        connectDB = dbModule.connectDB;
        getDB = dbModule.getDB;
    });

    describe('getDB()', () => {
        it('should throw error when database is not connected', () => {
            expect(() => getDB()).toThrow('Database not connected');
        });

        it('should return db instance after connection', async () => {
            await connectDB();

            const db = getDB();
            expect(db).toBeDefined();
            expect(db.collection).toBeDefined();
        });
    });

    describe('connectDB()', () => {
        it('should connect to MongoDB successfully', async () => {
            const db = await connectDB();

            expect(mockClient).toHaveBeenCalledWith(expect.any(String));
            expect(mockConnect).toHaveBeenCalled();
            expect(mockDb).toHaveBeenCalled();
            expect(db).toBeDefined();
        });

        it('should return cached connection on subsequent calls', async () => {
            const db1 = await connectDB();
            const db2 = await connectDB();

            // MongoClient should only be instantiated once
            expect(mockClient).toHaveBeenCalledTimes(1);
            expect(mockConnect).toHaveBeenCalledTimes(1);
            expect(db1).toBe(db2);
        });

        it('should create indexes on catalogs collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('catalogs');
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { 'beckn:id': 1 },
                { unique: true }
            );
        });

        it('should create indexes on items collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('items');
            // items has two indexes
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { 'beckn:id': 1 },
                { unique: true }
            );
            expect(mockCreateIndex).toHaveBeenCalledWith({ catalogId: 1 });
        });

        it('should create indexes on offers collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('offers');
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { 'beckn:id': 1 },
                { unique: true }
            );
            expect(mockCreateIndex).toHaveBeenCalledWith({ catalogId: 1 });
        });

        it('should create indexes on market_snapshots collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('market_snapshots');
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { 'date_range.start': 1, 'date_range.end': 1 },
                { unique: true }
            );
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { fetched_at: 1 },
                { expireAfterSeconds: 86400 }
            );
        });

        it('should create indexes on settlements collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('settlements');
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { transactionId: 1, role: 1 },
                { unique: true }
            );
            expect(mockCreateIndex).toHaveBeenCalledWith({ transactionId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ settlementStatus: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ role: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({
                settlementStatus: 1,
                onSettleNotified: 1
            });
        });

        it('should create indexes on orders collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('orders');
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { transactionId: 1 },
                { unique: true }
            );
            expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ type: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: -1 });
        });

        it('should create indexes on buyer_orders collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('buyer_orders');
            expect(mockCreateIndex).toHaveBeenCalledWith({ transactionId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ type: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: -1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ status: 1 });
        });

        it('should create indexes on users collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('users');
            expect(mockCreateIndex).toHaveBeenCalledWith(
                { phone: 1 },
                { unique: true }
            );
            expect(mockCreateIndex).toHaveBeenCalledWith({ meters: 1 });
        });

        it('should create indexes on payments collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('payments');
            expect(mockCreateIndex).toHaveBeenCalledWith({ orderId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ paymentId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ status: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ 'metadata.consumerNumber': 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: 1 });
        });

        it('should create indexes on energy_requests collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('energy_requests');
            expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ status: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: -1 });
        });

        it('should create indexes on publish_records collection', async () => {
            await connectDB();

            expect(mockCollection).toHaveBeenCalledWith('publish_records');
            expect(mockCreateIndex).toHaveBeenCalledWith({ message_id: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ transaction_id: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1 });
            expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: -1 });
        });

        it('should log connection messages', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

            await connectDB();

            expect(consoleSpy).toHaveBeenCalledWith('[DB] Connecting to MongoDB...');
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[DB] Connected to'));

            consoleSpy.mockRestore();
        });

        it('should throw error if MongoDB connection fails', async () => {
            const connectionError = new Error('Connection refused');
            mockConnect.mockRejectedValueOnce(connectionError);

            // Reset module to get fresh state
            jest.resetModules();
            const dbModule = require('../../db');

            await expect(dbModule.connectDB()).rejects.toThrow('Connection refused');
        });

        it('should throw error if index creation fails', async () => {
            const indexError = new Error('Index creation failed');
            mockCreateIndex.mockRejectedValueOnce(indexError);

            // Reset module to get fresh state
            jest.resetModules();
            const dbModule = require('../../db');

            await expect(dbModule.connectDB()).rejects.toThrow('Index creation failed');
        });
    });

    describe('Environment configuration', () => {
        it('should use environment variables when set', async () => {
            // This test verifies the module reads env vars
            // The actual connection uses MONGO_URI and DB_NAME from .env or defaults
            await connectDB();

            // Verify MongoClient was called with some URI string
            expect(mockClient).toHaveBeenCalledWith(expect.any(String));
        });
    });
});
