import request from 'supertest';
import { createApp } from '../../app';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../../test-utils/db';
import { Application } from 'express';
import { signRefreshToken } from '../../auth/routes';
import { ObjectId } from 'mongodb';

// Mock DB
jest.mock('../../db', () => ({
    connectDB: jest.fn(async () => getTestDB()),
    getDB: jest.fn(() => getTestDB()),
}));

describe('Refresh Token Flow', () => {
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
    });

    const validPhone = '9876543210';

    describe('POST /api/auth/refresh-token', () => {
        it('should successfully refresh token and return new pair', async () => {
            // 1. Setup User
            const db = getTestDB();
            const userRes = await db.collection('users').insertOne({
                phone: validPhone,
                name: 'Test User',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const userId = userRes.insertedId.toString();

            // 2. Generate initial Refresh Token
            const refreshToken = signRefreshToken(validPhone, userId);

            // 3. Call Refresh Endpoint
            // Wait 1.5s to ensure IAT (in seconds) changes for rotation check
            await new Promise(r => setTimeout(r, 1500));

            const res = await request(app)
                .post('/api/auth/refresh-token')
                .send({ refreshToken });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.accessToken).toBeDefined();
            expect(res.body.refreshToken).toBeDefined();
            expect(res.body.accessToken).not.toBe(refreshToken);
            expect(res.body.refreshToken).not.toBe(refreshToken); // Rotation check
        });

        it('should update fcmToken if provided during refresh', async () => {
            // 1. Setup User
            const db = getTestDB();
            const userRes = await db.collection('users').insertOne({
                phone: validPhone,
                name: 'Test User',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const userId = userRes.insertedId.toString();

            // 2. Generate initial Refresh Token
            const refreshToken = signRefreshToken(validPhone, userId);

            const fcmToken = "mock-refresh-fcm-token";
            const res = await request(app)
                .post('/api/auth/refresh-token')
                .send({ refreshToken, fcmToken });

            expect(res.status).toBe(200);

            const user = await db.collection('users').findOne({ _id: userRes.insertedId });
            expect(user?.fcmToken).toBe(fcmToken);
        });

        it('should fail with invalid refresh token', async () => {
            const res = await request(app)
                .post('/api/auth/refresh-token')
                .send({ refreshToken: 'invalid.token.here' });

            expect(res.status).toBe(401);
            expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
        });

        it('should fail if user no longer exists', async () => {
            // 1. Generate token for non-existent user
            const refreshToken = signRefreshToken(validPhone, new ObjectId().toString());

            const res = await request(app)
                .post('/api/auth/refresh-token')
                .send({ refreshToken });

            expect(res.status).toBe(401);
            expect(res.body.error.code).toBe('USER_NOT_FOUND');
        });
    });

    describe('Legacy Login Response', () => {
        it('should include refreshToken in login response', async () => {
            const db = getTestDB();
            await db.collection('users').insertOne({
                phone: validPhone,
                pin: '123456'
            });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ phone: validPhone, pin: '123456' });

            expect(res.status).toBe(200);
            expect(res.body.refreshToken).toBeDefined();
        });
    });
});
