/**
 * Integration tests for Auth API endpoints
 *
 * Tests /api/auth/* endpoints:
 * - POST /api/auth/login
 * - POST /api/auth/verify-vc
 * - GET /api/auth/me
 *
 * All database and third-party service calls are mocked.
 */

import { Express } from 'express';
import request from 'supertest';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { setupTestDB, teardownTestDB, clearTestDB, seedUser, seedUserWithProfiles, getTestUser, getTestDB } from '../../test-utils/db';

// Mock axios for VC verification API
jest.mock('axios');

// Mock DB connection
jest.mock('../../db', () => {
    const { getTestDB } = require('../../test-utils/db');
    return {
        getDB: () => getTestDB(),
        connectDB: jest.fn().mockResolvedValue(undefined)
    };
});

// Mock settlement poller
jest.mock('../../services/settlement-poller', () => ({
    startPolling: jest.fn(),
    stopPolling: jest.fn(),
    getPollingStatus: jest.fn().mockReturnValue({ running: false, lastPoll: null })
}));

// Mock ledger client
jest.mock('../../services/ledger-client', () => ({
    ledgerClient: {
        LEDGER_URL: 'http://test-ledger',
        getLedgerHealth: jest.fn().mockResolvedValue({ status: 'OK' }),
        fetchTradeRecords: jest.fn().mockResolvedValue([])
    }
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

// Import app after mocking
import { createApp } from '../../app';

const JWT_SECRET = 'p2p-trading-pilot-secret';

describe('Auth API Integration Tests', () => {
    let app: Express;

    beforeAll(async () => {
        await setupTestDB();
        app = await createApp();
    });

    afterAll(async () => {
        await teardownTestDB();
    });

    beforeEach(async () => {
        await clearTestDB();
        jest.clearAllMocks();
    });

    // ==========================================
    // POST /api/auth/login Tests
    // ==========================================
    describe('POST /api/auth/login', () => {
        describe('Successful login', () => {
            it('should return token for valid credentials', async () => {
                await seedUser({ phone: '9876543210', pin: '123456', name: 'Test User' });

                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '9876543210', pin: '123456' })
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.token).toBeDefined();
                expect(response.body.user.phone).toBe('9876543210');
                expect(response.body.user.name).toBe('Test User');
                expect(response.body.user.vcVerified).toBe(false);
            });

            it('should include vcVerified status in response', async () => {
                await seedUserWithProfiles({
                    phone: '9876543210',
                    pin: '123456',
                    name: 'Verified User',
                    vcVerified: true
                });

                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '9876543210', pin: '123456' })
                    .expect(200);

                expect(response.body.user.vcVerified).toBe(true);
            });
        });

        describe('Invalid credentials', () => {
            it('should return 401 for wrong PIN', async () => {
                await seedUser({ phone: '9876543210', pin: '123456', name: 'Test User' });

                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '9876543210', pin: '654321' })
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
            });

            it('should return 401 for non-existent user', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '0000000000', pin: '123456' })
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
            });
        });

        describe('Validation errors', () => {
            it('should return 400 for missing phone', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ pin: '123456' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for missing pin', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '9876543210' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for empty request body', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({})
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for phone with letters', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '98765abc10', pin: '123456' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for phone too short', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '12345', pin: '123456' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for phone too long', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '1234567890123456', pin: '123456' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for PIN not 6 digits', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '9876543210', pin: '12345' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for PIN with letters', async () => {
                const response = await request(app)
                    .post('/api/auth/login')
                    .send({ phone: '9876543210', pin: '12345a' })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });
        });
    });

    // ==========================================
    // POST /api/auth/verify-vc Tests
    // ==========================================
    describe('POST /api/auth/verify-vc', () => {
        let token: string;
        let userId: ObjectId;

        beforeEach(async () => {
            // Seed a user and create token
            userId = new ObjectId();
            const db = getTestDB();
            await db.collection('users').insertOne({
                _id: userId,
                phone: '9876543210',
                pin: '123456',
                name: 'Test User',
                vcVerified: false,
                profiles: {},
                meters: [],
                createdAt: new Date(),
                updatedAt: new Date()
            });

            token = jwt.sign(
                { phone: '9876543210', userId: userId.toString() },
                JWT_SECRET,
                { algorithm: 'HS256' }
            );
        });

        const validCredential = {
            id: 'did:rcw:cred-123',
            type: ['VerifiableCredential', 'UtilityCustomerCredential'],
            credentialSubject: {
                consumerNumber: 'CN123456',
                meterNumber: 'MTR-001',
                issuerName: 'DISCOM-XYZ'
            }
        };

        describe('Authentication errors', () => {
            it('should return 401 for missing Authorization header', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .send({ credentials: [validCredential] })
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('UNAUTHORIZED');
            });

            it('should return 401 for invalid Authorization format', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', 'Invalid token')
                    .send({ credentials: [validCredential] })
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('UNAUTHORIZED');
            });

            it('should return 401 for malformed token', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', 'Bearer invalid.token.here')
                    .send({ credentials: [validCredential] })
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('TOKEN_MALFORMED');
            });
        });

        describe('Validation errors', () => {
            it('should return 400 for empty credentials array', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [] })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for missing credentials field', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({})
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for too many credentials', async () => {
                const tooManyCredentials = Array(11).fill(validCredential);

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: tooManyCredentials })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for invalid DID format', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({
                        credentials: [{
                            ...validCredential,
                            id: 'invalid-did-format'
                        }]
                    })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for missing VerifiableCredential type', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({
                        credentials: [{
                            ...validCredential,
                            type: ['UtilityCustomerCredential']
                        }]
                    })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for missing valid VC type', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({
                        credentials: [{
                            ...validCredential,
                            type: ['VerifiableCredential', 'SomeOtherCredential']
                        }]
                    })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });

            it('should return 400 for missing consumerNumber', async () => {
                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({
                        credentials: [{
                            ...validCredential,
                            credentialSubject: { meterNumber: 'MTR-001' }
                        }]
                    })
                    .expect(400);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VALIDATION_ERROR');
            });
        });

        describe('User not found', () => {
            it('should return 404 if user was deleted', async () => {
                // Delete the user after creating token
                const db = getTestDB();
                await db.collection('users').deleteOne({ _id: userId });

                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [{ revoked: 'OK', expired: 'OK', proof: 'OK' }] }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(404);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('USER_NOT_FOUND');
            });
        });

        describe('Successful VC verification', () => {
            it('should verify credential and update user profile', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [{ revoked: 'OK', expired: 'OK', proof: 'OK' }] }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.verified.utilityCustomer).toBe(true);
                expect(response.body.failed).toEqual([]);
                expect(response.body.user.vcVerified).toBe(true);

                // Check database was updated
                const db = getTestDB();
                const updatedUser = await db.collection('users').findOne({ _id: userId });
                expect(updatedUser?.vcVerified).toBe(true);
                expect(updatedUser?.profiles?.utilityCustomer).toBeDefined();
                expect(updatedUser?.profiles?.utilityCustomer?.utilityId).toBe('DISCOM-XYZ');
                expect(updatedUser?.meters).toContain('MTR-001');
            });

            it('should extract meter number from credentialSubject', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                const db = getTestDB();
                const updatedUser = await db.collection('users').findOne({ _id: userId });
                expect(updatedUser?.meters).toContain('MTR-001');
            });

            it('should map issuerName to utilityId', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                const db = getTestDB();
                const updatedUser = await db.collection('users').findOne({ _id: userId });
                expect(updatedUser?.profiles?.utilityCustomer?.utilityId).toBe('DISCOM-XYZ');
                expect(updatedUser?.profiles?.utilityCustomer?.issuerName).toBeUndefined();
            });

            it('should verify GenerationProfileCredential', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                const generationCredential = {
                    id: 'did:rcw:gen-cred-123',
                    type: ['VerifiableCredential', 'GenerationProfileCredential'],
                    credentialSubject: {
                        consumerNumber: 'CN123456',
                        meterNumber: 'MTR-002',
                        capacity: '5kW'
                    }
                };

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [generationCredential] })
                    .expect(200);

                expect(response.body.verified.generationProfile).toBe(true);
            });

            it('should verify ConsumptionProfileCredential', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                const consumptionCredential = {
                    id: 'did:rcw:con-cred-123',
                    type: ['VerifiableCredential', 'ConsumptionProfileCredential'],
                    credentialSubject: {
                        consumerNumber: 'CN123456'
                    }
                };

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [consumptionCredential] })
                    .expect(200);

                expect(response.body.verified.consumptionProfile).toBe(true);
            });

            it('should verify StorageProfileCredential', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                const storageCredential = {
                    id: 'did:rcw:stor-cred-123',
                    type: ['VerifiableCredential', 'StorageProfileCredential'],
                    credentialSubject: {
                        consumerNumber: 'CN123456'
                    }
                };

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [storageCredential] })
                    .expect(200);

                expect(response.body.verified.storageProfile).toBe(true);
            });

            it('should verify UtilityProgramEnrollmentCredential', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                const enrollmentCredential = {
                    id: 'did:rcw:enroll-cred-123',
                    type: ['VerifiableCredential', 'UtilityProgramEnrollmentCredential'],
                    credentialSubject: {
                        consumerNumber: 'CN123456'
                    }
                };

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [enrollmentCredential] })
                    .expect(200);

                expect(response.body.verified.programEnrollment).toBe(true);
            });
        });

        describe('VC verification failures', () => {
            it('should fail when VC status is not ISSUED', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'REVOKED', checks: [] }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.verified).toEqual({});
                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('REVOKED');
            });

            it('should fail when revoked check fails', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: {
                        status: 'ISSUED',
                        checks: [{ revoked: 'FAILED', expired: 'OK', proof: 'OK' }]
                    }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('revoked');
            });

            it('should fail when expired check fails', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: {
                        status: 'ISSUED',
                        checks: [{ revoked: 'OK', expired: 'FAILED', proof: 'OK' }]
                    }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('expired');
            });

            it('should fail when proof check fails', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: {
                        status: 'ISSUED',
                        checks: [{ revoked: 'OK', expired: 'OK', proof: 'FAILED' }]
                    }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('proof');
            });

            it('should report multiple failed checks', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: {
                        status: 'ISSUED',
                        checks: [{ revoked: 'FAILED', expired: 'FAILED', proof: 'OK' }]
                    }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('revoked');
                expect(response.body.failed[0].reason).toContain('expired');
            });
        });

        describe('VC service errors', () => {
            it('should return 503 for timeout', async () => {
                mockedAxios.get.mockRejectedValue({ code: 'ECONNABORTED' });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(503);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VC_SERVICE_UNAVAILABLE');
            });

            it('should return 503 for timeout message', async () => {
                mockedAxios.get.mockRejectedValue({ message: 'timeout of 10000ms exceeded' });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(503);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VC_SERVICE_UNAVAILABLE');
            });

            it('should return 503 for 5xx server error', async () => {
                mockedAxios.get.mockRejectedValue({ response: { status: 500 } });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(503);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VC_SERVICE_UNAVAILABLE');
            });

            it('should return 503 for 502 server error', async () => {
                mockedAxios.get.mockRejectedValue({ response: { status: 502 } });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(503);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('VC_SERVICE_UNAVAILABLE');
            });

            it('should fail for 404 credential not found', async () => {
                mockedAxios.get.mockRejectedValue({ response: { status: 404 } });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('not found');
            });

            it('should fail for other 4xx errors', async () => {
                mockedAxios.get.mockRejectedValue({
                    response: { status: 400, data: 'Bad Request' }
                });

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('Verification failed');
            });

            it('should fail with error message when no response data', async () => {
                mockedAxios.get.mockRejectedValue(new Error('Network error'));

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential] })
                    .expect(200);

                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].reason).toContain('Network error');
            });
        });

        describe('Multiple credentials', () => {
            it('should handle multiple credentials with mixed results', async () => {
                // First credential succeeds, second fails
                mockedAxios.get
                    .mockResolvedValueOnce({
                        data: { status: 'ISSUED', checks: [] }
                    })
                    .mockResolvedValueOnce({
                        data: { status: 'REVOKED', checks: [] }
                    });

                const secondCredential = {
                    id: 'did:rcw:cred-456',
                    type: ['VerifiableCredential', 'GenerationProfileCredential'],
                    credentialSubject: {
                        consumerNumber: 'CN789012'
                    }
                };

                const response = await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential, secondCredential] })
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.verified.utilityCustomer).toBe(true);
                expect(response.body.failed.length).toBe(1);
                expect(response.body.failed[0].type).toBe('GenerationProfileCredential');
            });

            it('should accumulate meters from multiple credentials', async () => {
                mockedAxios.get.mockResolvedValue({
                    data: { status: 'ISSUED', checks: [] }
                });

                const secondCredential = {
                    id: 'did:rcw:cred-456',
                    type: ['VerifiableCredential', 'GenerationProfileCredential'],
                    credentialSubject: {
                        consumerNumber: 'CN789012',
                        meterNumber: 'MTR-002'
                    }
                };

                await request(app)
                    .post('/api/auth/verify-vc')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ credentials: [validCredential, secondCredential] })
                    .expect(200);

                const db = getTestDB();
                const updatedUser = await db.collection('users').findOne({ _id: userId });
                expect(updatedUser?.meters).toContain('MTR-001');
                expect(updatedUser?.meters).toContain('MTR-002');
            });
        });
    });

    // ==========================================
    // GET /api/auth/me Tests
    // ==========================================
    describe('GET /api/auth/me', () => {
        describe('Authentication errors', () => {
            it('should return 401 for missing Authorization header', async () => {
                const response = await request(app)
                    .get('/api/auth/me')
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('UNAUTHORIZED');
            });

            it('should return 401 for invalid Authorization format', async () => {
                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', 'Invalid token')
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('UNAUTHORIZED');
            });

            it('should return 401 for malformed token', async () => {
                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', 'Bearer invalid.token.here')
                    .expect(401);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('TOKEN_MALFORMED');
            });
        });

        describe('User not found', () => {
            it('should return 404 if user was deleted', async () => {
                const userId = new ObjectId();
                const token = jwt.sign(
                    { phone: '9876543210', userId: userId.toString() },
                    JWT_SECRET,
                    { algorithm: 'HS256' }
                );

                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', `Bearer ${token}`)
                    .expect(404);

                expect(response.body.success).toBe(false);
                expect(response.body.error.code).toBe('USER_NOT_FOUND');
            });
        });

        describe('Successful profile retrieval', () => {
            it('should return consumer role when no generationProfile', async () => {
                const userId = new ObjectId();
                const db = getTestDB();
                await db.collection('users').insertOne({
                    _id: userId,
                    phone: '9876543210',
                    pin: '123456',
                    name: 'Consumer User',
                    vcVerified: true,
                    profiles: {
                        utilityCustomer: { consumerNumber: 'CN123' },
                        consumptionProfile: { avgConsumption: 100 },
                        generationProfile: null,
                        storageProfile: null,
                        programEnrollment: null
                    },
                    meters: ['MTR-001'],
                    createdAt: new Date('2024-01-01'),
                    updatedAt: new Date()
                });

                const token = jwt.sign(
                    { phone: '9876543210', userId: userId.toString() },
                    JWT_SECRET,
                    { algorithm: 'HS256' }
                );

                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', `Bearer ${token}`)
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.user.role).toBe('consumer');
                expect(response.body.user.phone).toBe('9876543210');
                expect(response.body.user.name).toBe('Consumer User');
                expect(response.body.user.vcVerified).toBe(true);
                expect(response.body.user.meters).toContain('MTR-001');
                expect(response.body.user.memberSince).toBeDefined();
            });

            it('should return prosumer role when has generationProfile', async () => {
                const userId = new ObjectId();
                const db = getTestDB();
                await db.collection('users').insertOne({
                    _id: userId,
                    phone: '9876543210',
                    pin: '123456',
                    name: 'Prosumer User',
                    vcVerified: true,
                    profiles: {
                        utilityCustomer: null,
                        consumptionProfile: null,
                        generationProfile: { capacity: '5kW', meterNumber: 'GEN-001' },
                        storageProfile: null,
                        programEnrollment: null
                    },
                    meters: ['MTR-001', 'GEN-001'],
                    createdAt: new Date('2024-01-01'),
                    updatedAt: new Date()
                });

                const token = jwt.sign(
                    { phone: '9876543210', userId: userId.toString() },
                    JWT_SECRET,
                    { algorithm: 'HS256' }
                );

                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', `Bearer ${token}`)
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.user.role).toBe('prosumer');
                expect(response.body.user.profiles.generationProfile).toBeDefined();
            });

            it('should return all profile fields', async () => {
                const userId = new ObjectId();
                const db = getTestDB();
                await db.collection('users').insertOne({
                    _id: userId,
                    phone: '9876543210',
                    pin: '123456',
                    name: 'Full Profile User',
                    vcVerified: true,
                    profiles: {
                        utilityCustomer: { consumerNumber: 'CN123' },
                        consumptionProfile: { avgConsumption: 100 },
                        generationProfile: { capacity: '5kW' },
                        storageProfile: { capacity: '10kWh' },
                        programEnrollment: { program: 'NET_METERING' }
                    },
                    meters: ['MTR-001'],
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                const token = jwt.sign(
                    { phone: '9876543210', userId: userId.toString() },
                    JWT_SECRET,
                    { algorithm: 'HS256' }
                );

                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', `Bearer ${token}`)
                    .expect(200);

                expect(response.body.user.profiles.utilityCustomer).toBeDefined();
                expect(response.body.user.profiles.consumptionProfile).toBeDefined();
                expect(response.body.user.profiles.generationProfile).toBeDefined();
                expect(response.body.user.profiles.storageProfile).toBeDefined();
                expect(response.body.user.profiles.programEnrollment).toBeDefined();
            });

            it('should handle missing profiles object gracefully', async () => {
                const userId = new ObjectId();
                const db = getTestDB();
                await db.collection('users').insertOne({
                    _id: userId,
                    phone: '9876543210',
                    pin: '123456',
                    name: 'No Profiles User',
                    vcVerified: false,
                    // No profiles field
                    meters: [],
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                const token = jwt.sign(
                    { phone: '9876543210', userId: userId.toString() },
                    JWT_SECRET,
                    { algorithm: 'HS256' }
                );

                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', `Bearer ${token}`)
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.user.role).toBe('consumer');
                expect(response.body.user.profiles.utilityCustomer).toBeNull();
                expect(response.body.user.profiles.generationProfile).toBeNull();
            });

            it('should handle missing meters array gracefully', async () => {
                const userId = new ObjectId();
                const db = getTestDB();
                await db.collection('users').insertOne({
                    _id: userId,
                    phone: '9876543210',
                    pin: '123456',
                    name: 'No Meters User',
                    vcVerified: false,
                    profiles: {},
                    // No meters field
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                const token = jwt.sign(
                    { phone: '9876543210', userId: userId.toString() },
                    JWT_SECRET,
                    { algorithm: 'HS256' }
                );

                const response = await request(app)
                    .get('/api/auth/me')
                    .set('Authorization', `Bearer ${token}`)
                    .expect(200);

                expect(response.body.success).toBe(true);
                expect(response.body.user.meters).toEqual([]);
            });
        });
    });
});
