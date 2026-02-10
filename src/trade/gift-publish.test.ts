/**
 * Tests for P2P energy gifting — Phase 1 (gift creation via /api/publish)
 *
 * Group 1: Gift utility unit tests
 * Group 2: Gift publish integration tests
 */

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import request from 'supertest';

import { createApp } from '../app';
import {
  validateRecipientPhone,
  phoneToE164,
  computeLookupHash,
  computeClaimVerifier,
  generateClaimSecret,
} from '../utils';
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../test-utils/db';

import type { Express } from 'express';

// ── Mocks (same pattern as trade-api.test.ts) ──

jest.mock('axios');

jest.mock('../db', () => {
  const { getTestDB } = require('../test-utils/db');
  return {
    getDB: () => getTestDB(),
    connectDB: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../services/settlement-poller', () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
  getPollingStatus: jest.fn().mockReturnValue({ running: false, lastPoll: null }),
  pollOnce: jest.fn(),
  refreshSettlement: jest.fn(),
}));

jest.mock('../services/ledger-client', () => ({
  ledgerClient: {
    LEDGER_URL: 'http://test-ledger',
    getLedgerHealth: jest.fn().mockResolvedValue({ status: 'OK' }),
    fetchTradeRecords: jest.fn().mockResolvedValue([]),
    queryTrades: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../auth/routes', () => {
  const { Router } = require('express');
  return {
    authMiddleware: (req: any, _res: any, next: any) => {
      req.user = { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '9876543210' };
      next();
    },
    authRoutes: () => Router(),
  };
});

import axios from 'axios';

const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Helpers ──

const sha256 = (input: string): string =>
  crypto.createHash('sha256').update(input).digest('hex');

const seedProsumer = async () => {
  const db = getTestDB();
  await db.collection('users').insertOne({
    _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
    phone: '9876543210',
    name: 'Gift Prosumer',
    vcVerified: true,
    profiles: {
      generationProfile: {
        meterNumber: '100200300',
        utilityId: 'TPDDL',
        consumerNumber: 'CONS-001',
        did: 'did:example:gift-provider',
      },
    },
    meters: ['100200300'],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const validGiftInput = {
  quantity: 5,
  price: 0,
  deliveryDate: '2026-03-01',
  startHour: 10,
  duration: 2,
  sourceType: 'SOLAR',
  isGift: true,
  recipientPhone: '9123456789',
};

const validNormalInput = {
  quantity: 10,
  price: 7.5,
  deliveryDate: '2026-03-01',
  startHour: 10,
  duration: 1,
  sourceType: 'SOLAR',
};

// ============================================================
// Group 1: Gift Utility Unit Tests
// ============================================================

describe('Gift Utilities', () => {
  describe('validateRecipientPhone', () => {
    it.each(['6000000000', '7111111111', '8222222222', '9333333333'])(
      'should accept valid phone starting with %s',
      (phone) => {
        expect(() => validateRecipientPhone(phone)).not.toThrow();
      },
    );

    it.each(['0123456789', '1234567890', '5555555555'])(
      'should reject phone starting with 0-5: %s',
      (phone) => {
        expect(() => validateRecipientPhone(phone)).toThrow('10-digit Indian mobile number');
      },
    );

    it('should reject phone with +91 prefix', () => {
      expect(() => validateRecipientPhone('+919876543210')).toThrow();
    });

    it('should reject short numbers', () => {
      expect(() => validateRecipientPhone('987654321')).toThrow();
    });

    it('should reject long numbers', () => {
      expect(() => validateRecipientPhone('98765432100')).toThrow();
    });

    it('should reject numbers with spaces or dashes', () => {
      expect(() => validateRecipientPhone('987 654 3210')).toThrow();
      expect(() => validateRecipientPhone('987-654-3210')).toThrow();
    });
  });

  describe('phoneToE164', () => {
    it('should prepend +91', () => {
      expect(phoneToE164('9876543210')).toBe('+919876543210');
    });
  });

  describe('computeLookupHash', () => {
    it('should be deterministic', () => {
      const h1 = computeLookupHash('9876543210');
      const h2 = computeLookupHash('9876543210');
      expect(h1).toBe(h2);
    });

    it('should match SHA256 of E.164 phone', () => {
      const expected = sha256('+919876543210');
      expect(computeLookupHash('9876543210')).toBe(expected);
    });

    it('should produce different hashes for different phones', () => {
      const h1 = computeLookupHash('9876543210');
      const h2 = computeLookupHash('9123456789');
      expect(h1).not.toBe(h2);
    });

    it('should reject invalid phone', () => {
      expect(() => computeLookupHash('123')).toThrow();
    });
  });

  describe('computeClaimVerifier', () => {
    it('should match SHA256 of secret', () => {
      const secret = 'Ab3xK9mP';
      expect(computeClaimVerifier(secret)).toBe(sha256(secret));
    });
  });

  describe('generateClaimSecret', () => {
    it('should produce 8-character string', () => {
      expect(generateClaimSecret()).toHaveLength(8);
    });

    it('should be alphanumeric only', () => {
      const secret = generateClaimSecret();
      expect(secret).toMatch(/^[A-Za-z0-9]{8}$/);
    });

    it('should produce unique values across calls', () => {
      const secrets = new Set(Array.from({ length: 20 }, () => generateClaimSecret()));
      // With 62^8 combinations, collisions in 20 samples are essentially impossible
      expect(secrets.size).toBe(20);
    });
  });
});

// ============================================================
// Group 2: Gift Publish Integration Tests
// ============================================================

describe('Gift Publish Integration Tests', () => {
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
    await seedProsumer();
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { success: true, message: 'Catalog published' },
    });
  });

  describe('Regression: normal publish', () => {
    it('should still work without gift fields', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validNormalInput)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.catalog_id).toBeDefined();
    });

    it('should not have gift fields in DB for normal publish', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validNormalInput)
        .expect(200);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      expect(offer).toBeDefined();
      expect(offer!.isGift).toBeUndefined();
      expect(offer!.giftStatus).toBeUndefined();
      expect(offer!.lookupHash).toBeUndefined();
    });
  });

  describe('Success: gift publish', () => {
    it('should create offer with correct gift DB fields', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      expect(res.body.success).toBe(true);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });

      expect(offer).toBeDefined();
      expect(offer!.isGift).toBe(true);
      expect(offer!.giftStatus).toBe('UNCLAIMED');
      expect(offer!.lookupHash).toBeDefined();
      expect(offer!.claimVerifier).toBeDefined();
      expect(offer!.claimSecret).toBeDefined();
      expect(offer!.recipientPhone).toBe('+919123456789');
      expect(offer!.expiresAt).toBeInstanceOf(Date);
    });

    it('should include gift in offerAttributes', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      const gift = offer!['beckn:offerAttributes']?.gift;

      expect(gift).toBeDefined();
      expect(gift['@type']).toBe('EnergyGift');
      expect(gift.lookupHash).toBeDefined();
      expect(gift.claimVerifier).toBeDefined();
      expect(gift.expiresAt).toBeDefined();
    });

    it('should set price to 0 for gift offers', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      expect(offer!['beckn:price']['schema:price']).toBe(0);
    });

    it('should produce correct lookupHash = SHA256(+91 + phone)', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      const expectedHash = sha256('+919123456789');
      expect(offer!.lookupHash).toBe(expectedHash);
    });

    it('should produce correct claimVerifier = SHA256(claimSecret)', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      const expectedVerifier = sha256(offer!.claimSecret);
      expect(offer!.claimVerifier).toBe(expectedVerifier);
    });

    it('should set expiresAt approximately 7 days from now', async () => {
      const before = Date.now();

      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const after = Date.now();

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      const expiresMs = offer!.expiresAt.getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
      expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs);
    });

    it('should emit [GIFT] console log with phone, secret, hash', async () => {
      const logSpy = jest.spyOn(console, 'log');

      await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const giftLog = logSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].startsWith('[GIFT]'),
      );

      expect(giftLog).toBeDefined();
      expect(giftLog![0]).toContain('9123456789');
      expect(giftLog![0]).toContain('claimSecret:');
      expect(giftLog![0]).toContain('lookupHash:');

      logSpy.mockRestore();
    });

    it('should allow multiple gifts to the same phone (separate offers)', async () => {
      const res1 = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      const res2 = await request(app)
        .post('/api/publish')
        .send({ ...validGiftInput, quantity: 3 })
        .expect(200);

      expect(res1.body.offer_id).not.toBe(res2.body.offer_id);

      const db = getTestDB();
      const giftOffers = await db.collection('offers').find({ isGift: true }).toArray();
      expect(giftOffers).toHaveLength(2);
    });

    it('should forward gift catalog to ONIX; ONIX failure does not block gift creation', async () => {
      mockedAxios.post.mockRejectedValue(new Error('ONIX down'));

      const res = await request(app)
        .post('/api/publish')
        .send(validGiftInput)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.onix_forwarded).toBe(false);

      const db = getTestDB();
      const offer = await db.collection('offers').findOne({ 'beckn:id': res.body.offer_id });
      expect(offer!.isGift).toBe(true);
    });
  });

  describe('Validation errors', () => {
    it('should reject gift without recipientPhone', async () => {
      const { recipientPhone, ...noPhone } = validGiftInput;

      const res = await request(app)
        .post('/api/publish')
        .send(noPhone)
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject gift with price > 0', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send({ ...validGiftInput, price: 5 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject normal publish with price = 0', async () => {
      const res = await request(app)
        .post('/api/publish')
        .send({ ...validNormalInput, price: 0 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it.each(['0123456789', '12345', '+919876543210', '987 654 3210'])(
      'should reject invalid recipientPhone: %s',
      async (phone) => {
        const res = await request(app)
          .post('/api/publish')
          .send({ ...validGiftInput, recipientPhone: phone })
          .expect(400);

        expect(res.body.error).toBe('VALIDATION_ERROR');
      },
    );
  });
});
