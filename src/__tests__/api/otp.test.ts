import request from 'supertest';
import { createApp } from '../../app';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../../test-utils/db';
import { Application } from 'express';
import { ObjectId } from 'mongodb';
import { otpSendLimiter } from '../../auth/rate-limiter';
import crypto from 'crypto';

// Helper to hash OTP like the auth code does
const hashOtp = (otp: string) => crypto.createHash('sha256').update(otp).digest('hex');

// Mock the real DB connection to usage the test DB
jest.mock('../../db', () => ({
    connectDB: jest.fn(async () => {
        // Ensure test DB is ready
        return getTestDB();
    }),
    getDB: jest.fn(() => getTestDB()),
}));

// Mock SMS Service
jest.mock('../../services/sms-service', () => ({
    smsService: {
        sendSms: jest.fn().mockResolvedValue('mock-message-id'),
    },
}));

describe('OTP Auth Flow', () => {
    let app: Application;

    beforeAll(async () => {
        await setupTestDB();
        app = await createApp();
    });

    afterAll(async () => {
        await teardownTestDB();
    });

    afterEach(async () => {
        await clearTestDB();
        // Reset in-memory rate limiter between tests
        await otpSendLimiter.delete(validPhone);
        await otpSendLimiter.delete(otherPhone);
    });

    const validPhone = '9876543210';
    const otherPhone = '9876543211';

    describe('POST /api/auth/send-otp', () => {
        it('should send OTP and create new user if not exists', async () => {
            const res = await request(app)
                .post('/api/auth/send-otp')
                .send({ phone: validPhone });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe('OTP sent successfully');

            const db = getTestDB();
            const user = await db.collection('users').findOne({ phone: validPhone });
            const otp = await db.collection('otps').findOne({ phone: validPhone });

            expect(user).toBeTruthy();
            expect(user?.phone).toBe(validPhone);
            expect(otp).toBeTruthy();
            expect(otp?.otp).toHaveLength(64); // SHA256 hash length
            expect(otp?.userId.toString()).toBe(user?._id.toString());
            // Rate limiting is now in-memory, no sendAttempts in DB
        });

        it('should allow subsequent OTP requests within limit', async () => {
            // First request
            const res1 = await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
            expect(res1.status).toBe(200);
            // Second request
            const res2 = await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
            expect(res2.status).toBe(200);
            // Rate limiting is now in-memory, no sendAttempts to check in DB
        });

        it('should block request if rate limit (5) exceeded', async () => {
            // Send 5 times
            for (let i = 0; i < 5; i++) {
                const res = await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
                expect(res.status).toBe(200);
            }

            // 6th time
            const res = await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
        });

        it('should allow request after rate limiter reset', async () => {
            // With in-memory rate limiter, we can't easily simulate 10 min passage
            // This test verifies that after limiter.delete(), requests work again
            // Exhaust the limit
            for (let i = 0; i < 5; i++) {
                await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
            }
            const blockedRes = await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
            expect(blockedRes.status).toBe(429);

            // Reset the limiter (simulating time passage)
            await otpSendLimiter.delete(validPhone);

            // Should work again
            const res = await request(app).post('/api/auth/send-otp').send({ phone: validPhone });
            expect(res.status).toBe(200);
        });
    });

    describe('POST /api/auth/verify-otp', () => {
        it('should verify OTP and return token for correct code', async () => {
            const db = getTestDB();
            // Setup User and OTP
            const userRes = await db.collection('users').insertOne({
                phone: validPhone,
                createdAt: new Date(),
                updatedAt: new Date(),
                vcVerified: false,
                meters: []
            });
            const userId = userRes.insertedId;

            await db.collection('otps').insertOne({
                phone: validPhone,
                userId: userId,
                otp: hashOtp('123456'), // Store hashed OTP
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
                attempts: 0,
                sendAttempts: 1,
                lastRequestAt: new Date(),
                verified: false
            });

            const res = await request(app)
                .post('/api/auth/verify-otp')
                .send({ phone: validPhone, otp: '123456' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.accessToken).toBeDefined();
            expect(res.body.user.phone).toBe(validPhone);

            // Verify OTP is marked verified or consumed
            const otpRec = await db.collection('otps').findOne({ phone: validPhone });
            expect(otpRec?.verified).toBe(true);
            expect(otpRec?.otp).toBeUndefined(); // We unset it
        });

        it('should fail if OTP is incorrect and increment attempts', async () => {
            const db = getTestDB();
            await db.collection('otps').insertOne({
                phone: validPhone,
                otp: hashOtp('123456'), // Store hashed OTP
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
                attempts: 0,
                sendAttempts: 1,
                verified: false,
                userId: new ObjectId()
            });

            const res = await request(app)
                .post('/api/auth/verify-otp')
                .send({ phone: validPhone, otp: '654321' });

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('INVALID_OTP');

            const otpRec = await db.collection('otps').findOne({ phone: validPhone });
            expect(otpRec?.attempts).toBe(1);
        });

        it('should block verification after 5 failed attempts', async () => {
            const db = getTestDB();
            await db.collection('otps').insertOne({
                phone: validPhone,
                otp: hashOtp('123456'), // Store hashed OTP
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
                attempts: 5, // Already reached max
                sendAttempts: 1,
                verified: false,
                userId: new ObjectId()
            });

            // Even with correct OTP
            const res = await request(app)
                .post('/api/auth/verify-otp')
                .send({ phone: validPhone, otp: '123456' });

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('MAX_ATTEMPTS_REACHED');
            expect(res.body.error.message).toMatch(/Too many failed attempts/);
        });

        it('should fail if OTP has expired', async () => {
            const db = getTestDB();
            await db.collection('otps').insertOne({
                phone: validPhone,
                otp: hashOtp('123456'), // Store hashed OTP
                expiresAt: new Date(Date.now() - 1000), // Expired
                attempts: 0,
                sendAttempts: 1,
                verified: false,
                userId: new ObjectId()
            });

            const res = await request(app)
                .post('/api/auth/verify-otp')
                .send({ phone: validPhone, otp: '123456' });

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('OTP_EXPIRED');
        });

        it('should fail if no OTP request found', async () => {
            const res = await request(app)
                .post('/api/auth/verify-otp')
                .send({ phone: otherPhone, otp: '123456' });

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('INVALID_REQUEST');
        });
    });

    describe('Legacy Phone+PIN Login (Regression)', () => {
        it('should still support legacy login', async () => {
            const db = getTestDB();
            await db.collection('users').insertOne({
                phone: validPhone,
                pin: '123456',
                name: 'Test User'
            });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ phone: validPhone, pin: '123456' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.accessToken).toBeDefined();
        });
    });
});
