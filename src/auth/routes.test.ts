import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  clearTestDB,
  getTestUser,
  seedUser,
  seedUserWithProfiles,
  setupTestDB,
  teardownTestDB,
} from '../test-utils/db';
import { mockNext, mockRequest, mockResponse } from '../test-utils';

import {
  authMiddleware,
  authRoutes,
  loginSchema,
  signToken,
  validateBody,
  verifyToken,
} from './routes';

// Use in-memory MongoDB (same pattern as order-service.test.ts)
jest.mock('../db', () => ({
  getDB: () => require('../test-utils/db').getTestDB(),
  connectDB: jest.fn().mockResolvedValue(undefined),
}));

// Mock axios for VC verification external API calls
jest.mock('axios');
import axios from 'axios';
const mockAxios = axios as jest.Mocked<typeof axios>;

const JWT_SECRET = 'p2p-trading-pilot-secret';

describe('Auth Routes', () => {
  let app: express.Express;

  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    app = express();
    app.use(express.json());
    app.use('/api', authRoutes());
  });

  // ============================================
  // signToken / verifyToken
  // ============================================

  describe('signToken', () => {
    it('should produce a valid JWT decodable by verifyToken', () => {
      const token = signToken('1234567890', 'user-id-123');
      const decoded = verifyToken(token);
      expect(decoded.phone).toBe('1234567890');
      expect(decoded.userId).toBe('user-id-123');
      expect(decoded.iat).toBeDefined();
    });
  });

  describe('verifyToken', () => {
    it('should throw for expired or tampered token', () => {
      // Expired token
      const expired = jwt.sign({ phone: '1234567890' }, JWT_SECRET, { expiresIn: '0s' });
      expect(() => verifyToken(expired)).toThrow();

      // Tampered token
      const valid = signToken('1234567890');
      const tampered = valid.slice(0, -5) + 'xxxxx';
      expect(() => verifyToken(tampered)).toThrow();
    });
  });

  // ============================================
  // authMiddleware
  // ============================================

  describe('authMiddleware', () => {
    it('should return 401 when Authorization header is missing', () => {
      const req = mockRequest();
      const { res, status, json } = mockResponse();
      const next = mockNext();

      authMiddleware(req as any, res as any, next);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when Authorization header does not start with Bearer', () => {
      const req = mockRequest();
      (req as any).headers = { authorization: 'Basic some-token' };
      const { res, status, json } = mockResponse();
      const next = mockNext();

      authMiddleware(req as any, res as any, next);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 with TOKEN_MALFORMED for invalid JWT', () => {
      const req = mockRequest();
      (req as any).headers = { authorization: 'Bearer invalid-jwt-token' };
      const { res, status, json } = mockResponse();
      const next = mockNext();

      authMiddleware(req as any, res as any, next);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'TOKEN_MALFORMED' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should set req.user and call next() for valid token', () => {
      const token = signToken('1234567890', 'user-123');
      const req = mockRequest();
      (req as any).headers = { authorization: `Bearer ${token}` };
      const { res } = mockResponse();
      const next = mockNext();

      authMiddleware(req as any, res as any, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).user.phone).toBe('1234567890');
      expect((req as any).user.userId).toBe('user-123');
    });
  });

  // ============================================
  // validateBody
  // ============================================

  describe('validateBody', () => {
    it('should call next() when body matches Zod schema', () => {
      const middleware = validateBody(loginSchema);
      const req = mockRequest({ phone: '1234567890', pin: '123456' });
      const { res } = mockResponse();
      const next = mockNext();

      middleware(req as any, res as any, next);

      expect(next).toHaveBeenCalled();
    });

    it('should return 400 with VALIDATION_ERROR when body fails schema', () => {
      const middleware = validateBody(loginSchema);
      const req = mockRequest({ phone: 'abc', pin: '12' });
      const { res, status, json } = mockResponse();
      const next = mockNext();

      middleware(req as any, res as any, next);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR',
            details: expect.any(Array),
          }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // POST /api/auth/login
  // ============================================

  describe('POST /api/auth/login', () => {
    it('should return token and user info for valid phone + PIN', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '1234567890', pin: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.phone).toBe('1234567890');
      expect(res.body.user.name).toBe('Test User');
      expect(res.body.user.vcVerified).toBe(false);

      // Verify the token is actually valid
      const decoded = verifyToken(res.body.token);
      expect(decoded.phone).toBe('1234567890');
    });

    it('should return 401 for wrong PIN', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '1234567890', pin: '999999' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should return 401 for non-existent phone', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '9999999999', pin: '123456' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should return 400 for missing phone field', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ pin: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for invalid phone format (non-digits)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: 'abc-def-ghij', pin: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for PIN shorter than 6 digits', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '1234567890', pin: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for PIN with non-numeric characters', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '1234567890', pin: '12ab56' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should include userId in token when user has _id', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const user = await getTestUser('1234567890');

      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '1234567890', pin: '123456' });

      const decoded = verifyToken(res.body.token);
      expect(decoded.userId).toBe(user!._id.toString());
    });
  });

  // ============================================
  // POST /api/auth/verify-vc
  // ============================================

  describe('POST /api/auth/verify-vc', () => {
    const validCredential = {
      id: 'did:rcw:credential-001',
      type: ['VerifiableCredential', 'ConsumptionProfileCredential'],
      credentialSubject: {
        consumerNumber: 'CONS-001',
        meterNumber: '100200300',
        issuerName: 'TPDDL',
      },
    };

    async function getTokenForUser(phone: string): Promise<string> {
      const user = await getTestUser(phone);
      return signToken(phone, user!._id.toString());
    }

    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .post('/api/auth/verify-vc')
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(401);
    });

    it('should return 400 with empty credentials array', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when credential id does not start with did:rcw:', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({
          credentials: [{ ...validCredential, id: 'invalid-id-format' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when credential type array missing VerifiableCredential', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({
          credentials: [{
            ...validCredential,
            type: ['ConsumptionProfileCredential'],
          }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 when user not found', async () => {
      // Token for a phone that does not exist in DB
      const token = signToken('9999999999');

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('should verify credential via external API, store profile, and set vcVerified', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      mockAxios.get.mockResolvedValue({
        data: {
          status: 'ISSUED',
          checks: [{ revoked: 'OK', expired: 'OK', proof: 'OK' }],
        },
      });

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.verified.consumptionProfile).toBe(true);
      expect(res.body.failed).toHaveLength(0);
      expect(res.body.user.vcVerified).toBe(true);

      // Verify profile stored in DB
      const updatedUser = await getTestUser('1234567890');
      expect(updatedUser!.profiles.consumptionProfile).toBeDefined();
      expect(updatedUser!.profiles.consumptionProfile.did).toBe('did:rcw:credential-001');
      expect(updatedUser!.profiles.consumptionProfile.consumerNumber).toBe('CONS-001');
      expect(updatedUser!.vcVerified).toBe(true);
    });

    it('should map issuerName to utilityId in stored profile', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      mockAxios.get.mockResolvedValue({
        data: { status: 'ISSUED', checks: [{ revoked: 'OK', expired: 'OK', proof: 'OK' }] },
      });

      await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      const updatedUser = await getTestUser('1234567890');
      expect(updatedUser!.profiles.consumptionProfile.utilityId).toBe('TPDDL');
      expect(updatedUser!.profiles.consumptionProfile.issuerName).toBeUndefined();
    });

    it('should extract meterNumber into user.meters array', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      mockAxios.get.mockResolvedValue({
        data: { status: 'ISSUED', checks: [{ revoked: 'OK', expired: 'OK', proof: 'OK' }] },
      });

      await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      const updatedUser = await getTestUser('1234567890');
      expect(updatedUser!.meters).toContain('100200300');
    });

    it('should add failed entry when external API returns status !== ISSUED', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      mockAxios.get.mockResolvedValue({
        data: { status: 'REVOKED', checks: [] },
      });

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(200);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].did).toBe('did:rcw:credential-001');
      expect(res.body.failed[0].reason).toContain('REVOKED');
    });

    it('should add failed entry when revoked/expired/proof checks fail', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      mockAxios.get.mockResolvedValue({
        data: {
          status: 'ISSUED',
          checks: [{ revoked: 'FAIL', expired: 'OK', proof: 'OK' }],
        },
      });

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(200);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].reason).toContain('revoked');
    });

    it('should return 503 when VC service times out', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      const timeoutError: any = new Error('timeout of 10000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      mockAxios.get.mockRejectedValue(timeoutError);

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('VC_SERVICE_UNAVAILABLE');
    });

    it('should return 503 when VC service returns 5xx', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      const serverError: any = new Error('Internal Server Error');
      serverError.response = { status: 500 };
      mockAxios.get.mockRejectedValue(serverError);

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('VC_SERVICE_UNAVAILABLE');
    });

    it('should add failed entry when VC service returns 404', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      const notFoundError: any = new Error('Not Found');
      notFoundError.response = { status: 404 };
      mockAxios.get.mockRejectedValue(notFoundError);

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential] });

      expect(res.status).toBe(200);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].reason).toContain('not found');
    });

    it('should verify multiple credentials in single request', async () => {
      await seedUser({ phone: '1234567890', pin: '123456', name: 'Test User' });
      const token = await getTokenForUser('1234567890');

      mockAxios.get.mockResolvedValue({
        data: { status: 'ISSUED', checks: [{ revoked: 'OK', expired: 'OK', proof: 'OK' }] },
      });

      const generationCredential = {
        id: 'did:rcw:credential-002',
        type: ['VerifiableCredential', 'GenerationProfileCredential'],
        credentialSubject: {
          consumerNumber: 'GEN-001',
          meterNumber: '200300400',
          issuerName: 'BESCOM',
        },
      };

      const res = await request(app)
        .post('/api/auth/verify-vc')
        .set('Authorization', `Bearer ${token}`)
        .send({ credentials: [validCredential, generationCredential] });

      expect(res.status).toBe(200);
      expect(res.body.verified.consumptionProfile).toBe(true);
      expect(res.body.verified.generationProfile).toBe(true);
      expect(res.body.failed).toHaveLength(0);

      const updatedUser = await getTestUser('1234567890');
      expect(updatedUser!.profiles.consumptionProfile).toBeDefined();
      expect(updatedUser!.profiles.generationProfile).toBeDefined();
      expect(updatedUser!.meters).toContain('100200300');
      expect(updatedUser!.meters).toContain('200300400');
    });
  });

  // ============================================
  // GET /api/auth/me
  // ============================================

  describe('GET /api/auth/me', () => {
    it('should return 401 without auth token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('should return 404 when user not found by userId', async () => {
      // Valid ObjectId format that doesn't exist in DB
      const token = signToken('1234567890', 'aaaaaaaaaaaaaaaaaaaaaaaa');

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('should return user profile with role=prosumer when generationProfile exists', async () => {
      await seedUserWithProfiles({
        phone: '1234567890',
        pin: '123456',
        name: 'Prosumer User',
        vcVerified: true,
        profiles: {
          generationProfile: {
            did: 'did:rcw:gen-001',
            meterNumber: '100200300',
            utilityId: 'BESCOM',
          },
          consumptionProfile: {
            did: 'did:rcw:cons-001',
            consumerNumber: 'CONS-001',
          },
        },
        meters: ['100200300'],
      });

      const user = await getTestUser('1234567890');
      const token = signToken('1234567890', user!._id.toString());

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('prosumer');
    });

    it('should return user profile with role=consumer when no generationProfile', async () => {
      await seedUserWithProfiles({
        phone: '1234567890',
        pin: '123456',
        name: 'Consumer User',
        vcVerified: true,
        profiles: {
          consumptionProfile: {
            did: 'did:rcw:cons-001',
            consumerNumber: 'CONS-001',
          },
        },
      });

      const user = await getTestUser('1234567890');
      const token = signToken('1234567890', user!._id.toString());

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('consumer');
    });

    it('should return all profile fields including meters and memberSince', async () => {
      await seedUserWithProfiles({
        phone: '1234567890',
        pin: '123456',
        name: 'Full Profile User',
        vcVerified: true,
        profiles: {
          utilityCustomer: { did: 'did:rcw:uc-001', consumerNumber: 'UC-001' },
          consumptionProfile: { did: 'did:rcw:cp-001', consumerNumber: 'CP-001' },
          generationProfile: { did: 'did:rcw:gp-001', meterNumber: '100200300' },
          storageProfile: { did: 'did:rcw:sp-001', capacity: 5 },
          programEnrollment: { did: 'did:rcw:pe-001', program: 'PM-KUSUM' },
        },
        meters: ['100200300', '200300400'],
      });

      const user = await getTestUser('1234567890');
      const token = signToken('1234567890', user!._id.toString());

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.phone).toBe('1234567890');
      expect(res.body.user.name).toBe('Full Profile User');
      expect(res.body.user.vcVerified).toBe(true);
      expect(res.body.user.role).toBe('prosumer');
      expect(res.body.user.profiles.utilityCustomer).toBeDefined();
      expect(res.body.user.profiles.consumptionProfile).toBeDefined();
      expect(res.body.user.profiles.generationProfile).toBeDefined();
      expect(res.body.user.profiles.storageProfile).toBeDefined();
      expect(res.body.user.profiles.programEnrollment).toBeDefined();
      expect(res.body.user.meters).toEqual(['100200300', '200300400']);
      expect(res.body.user.memberSince).toBeDefined();
    });
  });
});
