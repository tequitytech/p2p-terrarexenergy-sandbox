import {
  clearTestDB,
  getTestDB,
  setupTestDB,
  teardownTestDB,
} from '../test-utils/db';

// Use in-memory MongoDB
jest.mock('../db', () => ({
  getDB: () => require('../test-utils/db').getTestDB(),
  connectDB: jest.fn().mockResolvedValue(undefined),
}));

// Mock email service
jest.mock('./email-service');
import { emailService } from './email-service';
const mockSendEmail = emailService.sendEmail as jest.MockedFunction<typeof emailService.sendEmail>;

import { notificationService } from './notification-service';

describe('NotificationService', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    mockSendEmail.mockResolvedValue(true);
  });

  // Helper to seed a user with email and profiles
  async function seedUserWithEmail(data: {
    phone: string;
    name: string;
    email?: string;
    consumptionProfileId?: string;
    utilityCustomerDid?: string;
  }) {
    const db = getTestDB();
    await db.collection('users').insertOne({
      phone: data.phone,
      name: data.name,
      email: data.email || null,
      vcVerified: true,
      profiles: {
        consumptionProfile: data.consumptionProfileId
          ? { id: data.consumptionProfileId }
          : null,
        utilityCustomer: data.utilityCustomerDid
          ? { did: data.utilityCustomerDid }
          : null,
        generationProfile: null,
        storageProfile: null,
        programEnrollment: null,
      },
      meters: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function makeOrder(overrides: any = {}) {
    return {
      'beckn:buyer': { 'beckn:id': 'buyer-profile-123' },
      'beckn:seller': { 'beckn:id': 'seller-001' },
      'beckn:orderItems': [
        { 'beckn:quantity': { unitQuantity: 10 } },
      ],
      'beckn:payment': { 'beckn:amount': { value: 50 } },
      ...overrides,
    };
  }

  // ============================================
  // sendOrderConfirmation
  // ============================================

  describe('sendOrderConfirmation', () => {
    it('should send email to buyer when user has verified email', async () => {
      await seedUserWithEmail({
        phone: '9876543210',
        name: 'Test Buyer',
        email: 'buyer@example.com',
        consumptionProfileId: 'buyer-profile-123',
      });

      await notificationService.sendOrderConfirmation('txn-001', makeOrder());

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        'buyer@example.com',
        expect.stringContaining('txn-001'),
        expect.any(String),
      );
    });

    it('should include transactionId, totalQuantity, seller, and amount in email body', async () => {
      await seedUserWithEmail({
        phone: '9876543210',
        name: 'Test Buyer',
        email: 'buyer@example.com',
        consumptionProfileId: 'buyer-profile-123',
      });

      await notificationService.sendOrderConfirmation('txn-002', makeOrder());

      const body = mockSendEmail.mock.calls[0][2];
      expect(body).toContain('txn-002');
      expect(body).toContain('10 kWh');
      expect(body).toContain('seller-001');
      expect(body).toContain('50');
    });

    it('should find user by consumptionProfile.id', async () => {
      await seedUserWithEmail({
        phone: '1111111111',
        name: 'Consumption User',
        email: 'consumption@example.com',
        consumptionProfileId: 'cp-id-456',
      });

      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': 'cp-id-456' },
      });

      await notificationService.sendOrderConfirmation('txn-003', order);

      expect(mockSendEmail).toHaveBeenCalledWith(
        'consumption@example.com',
        expect.any(String),
        expect.any(String),
      );
    });

    it('should find user by utilityCustomer.did as fallback', async () => {
      await seedUserWithEmail({
        phone: '2222222222',
        name: 'Utility User',
        email: 'utility@example.com',
        utilityCustomerDid: 'did:util:789',
      });

      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': 'did:util:789' },
      });

      await notificationService.sendOrderConfirmation('txn-004', order);

      expect(mockSendEmail).toHaveBeenCalledWith(
        'utility@example.com',
        expect.any(String),
        expect.any(String),
      );
    });

    it('should find user by phone as last fallback', async () => {
      await seedUserWithEmail({
        phone: '3333333333',
        name: 'Phone User',
        email: 'phone@example.com',
      });

      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': '3333333333' },
      });

      await notificationService.sendOrderConfirmation('txn-005', order);

      expect(mockSendEmail).toHaveBeenCalledWith(
        'phone@example.com',
        expect.any(String),
        expect.any(String),
      );
    });

    it('should skip when no buyer ID in order (beckn:buyer.beckn:id missing)', async () => {
      const order = makeOrder({
        'beckn:buyer': {},
      });

      await notificationService.sendOrderConfirmation('txn-006', order);

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('should skip when user not found in DB', async () => {
      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': 'nonexistent-user' },
      });

      await notificationService.sendOrderConfirmation('txn-007', order);

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('should skip when user has no email', async () => {
      await seedUserWithEmail({
        phone: '4444444444',
        name: 'No Email User',
        // no email
        consumptionProfileId: 'no-email-profile',
      });

      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': 'no-email-profile' },
      });

      await notificationService.sendOrderConfirmation('txn-008', order);

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('should calculate totalQuantity from multiple orderItems', async () => {
      await seedUserWithEmail({
        phone: '5555555555',
        name: 'Multi Item Buyer',
        email: 'multi@example.com',
        consumptionProfileId: 'multi-buyer-id',
      });

      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': 'multi-buyer-id' },
        'beckn:orderItems': [
          { 'beckn:quantity': { unitQuantity: 5 } },
          { 'beckn:quantity': { unitQuantity: 8 } },
          { 'beckn:quantity': { unitQuantity: 3 } },
        ],
      });

      await notificationService.sendOrderConfirmation('txn-009', order);

      const body = mockSendEmail.mock.calls[0][2];
      expect(body).toContain('16 kWh');
    });

    it('should not throw on emailService error (catch and log)', async () => {
      await seedUserWithEmail({
        phone: '6666666666',
        name: 'Error User',
        email: 'error@example.com',
        consumptionProfileId: 'error-buyer-id',
      });

      mockSendEmail.mockRejectedValue(new Error('SMTP connection failed'));

      const order = makeOrder({
        'beckn:buyer': { 'beckn:id': 'error-buyer-id' },
      });

      // Should not throw
      await expect(
        notificationService.sendOrderConfirmation('txn-010', order),
      ).resolves.toBeUndefined();
    });
  });
});
