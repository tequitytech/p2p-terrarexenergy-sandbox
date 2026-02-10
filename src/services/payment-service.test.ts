import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from '../test-utils/db';

import { paymentService, PaymentStatus } from './payment-service';

// Mock razorpay instance
const mockOrdersCreate = jest.fn();
const mockPaymentLinkCreate = jest.fn();

jest.mock('./razorpay', () => ({
  razorpay: {
    orders: { create: (...args: any[]) => mockOrdersCreate(...args) },
    paymentLink: { create: (...args: any[]) => mockPaymentLinkCreate(...args) },
  },
  rzp_key_secret: 'test-secret-key',
}));

// Mock validatePaymentVerification
const mockValidatePaymentVerification = jest.fn();
jest.mock('razorpay/dist/utils/razorpay-utils', () => ({
  validatePaymentVerification: (...args: any[]) => mockValidatePaymentVerification(...args),
}));

// Mock DB connection
jest.mock('../db', () => ({
  getDB: () => getTestDB(),
  connectDB: jest.fn().mockResolvedValue(undefined),
}));

describe('PaymentService', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  // ============================================
  // createOrder
  // ============================================

  describe('createOrder', () => {
    it('should convert amount to paise (amount × 100) and call razorpay.orders.create', async () => {
      const mockOrder = { id: 'order_123', amount: 15000 };
      mockOrdersCreate.mockResolvedValue(mockOrder);

      const result = await paymentService.createOrder(150);

      expect(mockOrdersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 15000 }),
      );
      expect(result).toEqual(mockOrder);
    });

    it('should floor paise amount (no fractional paise)', async () => {
      mockOrdersCreate.mockResolvedValue({ id: 'order_124' });

      await paymentService.createOrder(10.567);

      expect(mockOrdersCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1056 }), // Math.floor(10.567 * 100) = 1056
      );
    });

    it('should pass currency, receipt, and notes to razorpay.orders.create', async () => {
      mockOrdersCreate.mockResolvedValue({ id: 'order_125' });

      await paymentService.createOrder(100, 'USD', 'receipt_001', { key: 'value' });

      expect(mockOrdersCreate).toHaveBeenCalledWith({
        amount: 10000,
        currency: 'USD',
        receipt: 'receipt_001',
        notes: { key: 'value' },
      });
    });

    it('should propagate error when razorpay.orders.create fails', async () => {
      mockOrdersCreate.mockRejectedValue(new Error('Razorpay API down'));

      await expect(paymentService.createOrder(100)).rejects.toThrow('Razorpay API down');
    });
  });

  // ============================================
  // createPaymentLink
  // ============================================

  describe('createPaymentLink', () => {
    it('should call razorpay.paymentLink.create with correct params', async () => {
      const linkResp = { id: 'plink_123', short_url: 'https://rzp.io/abc' };
      mockPaymentLinkCreate.mockResolvedValue(linkResp);

      const order = {
        id: 'order_123',
        amount: 15000,
        currency: 'INR',
        name: 'Test User',
        contact: '+919876543210',
      };

      const result = await paymentService.createPaymentLink(order);

      expect(mockPaymentLinkCreate).toHaveBeenCalledWith({
        amount: 15000,
        currency: 'INR',
        accept_partial: false,
        reference_id: 'order_123',
        description: 'Payment for Order order_123',
        customer: {
          name: 'Test User',
          contact: '+919876543210',
        },
        notify: { sms: true },
        callback_url: 'https://p2p.terrarexenergy.com/api/payment-callback',
        callback_method: 'get',
      });
      expect(result).toEqual(linkResp);
    });

    it('should set accept_partial=false and callback_url', async () => {
      mockPaymentLinkCreate.mockResolvedValue({ id: 'plink_124' });

      await paymentService.createPaymentLink({
        id: 'order_124',
        amount: 5000,
        currency: 'INR',
      });

      expect(mockPaymentLinkCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          accept_partial: false,
          callback_url: 'https://p2p.terrarexenergy.com/api/payment-callback',
        }),
      );
    });

    it('should return AxiosError response data instead of throwing for Axios errors', async () => {
      const axiosError = new Error('Request failed') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { data: { error: 'Bad request from Razorpay' } };
      // Mark it as AxiosError instance
      Object.defineProperty(axiosError, 'constructor', { value: Error });

      // The code checks `error instanceof AxiosError`. We need a real-ish AxiosError.
      const { AxiosError } = jest.requireActual('axios');
      const realAxiosError = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        data: { error: 'Bad request from Razorpay' },
        statusText: 'Bad Request',
        headers: {},
        config: {} as any,
      } as any);

      mockPaymentLinkCreate.mockRejectedValue(realAxiosError);

      const result = await paymentService.createPaymentLink({
        id: 'order_125',
        amount: 5000,
        currency: 'INR',
      });

      expect(result).toEqual({ error: 'Bad request from Razorpay' });
    });

    it('should propagate non-Axios errors', async () => {
      mockPaymentLinkCreate.mockRejectedValue(new Error('Network error'));

      await expect(
        paymentService.createPaymentLink({
          id: 'order_126',
          amount: 5000,
          currency: 'INR',
        }),
      ).rejects.toThrow('Network error');
    });
  });

  // ============================================
  // verifyPayment
  // ============================================

  describe('verifyPayment', () => {
    it('should return true and update DB when signature is valid', async () => {
      mockValidatePaymentVerification.mockReturnValue(true);

      // Seed a payment in DB
      const db = getTestDB();
      await db.collection('payments').insertOne({
        orderId: 'order_200',
        status: PaymentStatus.CREATED,
        amount: 15000,
        currency: 'INR',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await paymentService.verifyPayment(
        'order_200',
        'pay_abc',
        'sig_xyz',
        'plink_123',
        'paid',
      );

      expect(result).toBe(true);

      // Verify DB was updated
      const payment = await db.collection('payments').findOne({ orderId: 'order_200' });
      expect(payment?.status).toBe(PaymentStatus.PAID);
      expect(payment?.paymentId).toBe('pay_abc');
      expect(payment?.razorpaySignature).toBe('sig_xyz');
    });

    it('should map razorpayPaymentLinkStatus to PaymentStatus enum', async () => {
      mockValidatePaymentVerification.mockReturnValue(true);

      const db = getTestDB();
      await db.collection('payments').insertOne({
        orderId: 'order_201',
        status: PaymentStatus.CREATED,
        amount: 5000,
        currency: 'INR',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await paymentService.verifyPayment(
        'order_201',
        'pay_def',
        'sig_abc',
        'plink_124',
        'attempted',
      );

      const payment = await db.collection('payments').findOne({ orderId: 'order_201' });
      expect(payment?.status).toBe(PaymentStatus.ATTEMPTED);
    });

    it('should use PaymentStatus.FAILED for unknown status strings', async () => {
      mockValidatePaymentVerification.mockReturnValue(true);

      const db = getTestDB();
      await db.collection('payments').insertOne({
        orderId: 'order_202',
        status: PaymentStatus.CREATED,
        amount: 5000,
        currency: 'INR',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await paymentService.verifyPayment(
        'order_202',
        'pay_ghi',
        'sig_def',
        'plink_125',
        'some_unknown_status',
      );

      const payment = await db.collection('payments').findOne({ orderId: 'order_202' });
      expect(payment?.status).toBe(PaymentStatus.FAILED);
    });

    it('should return false when signature verification fails', async () => {
      mockValidatePaymentVerification.mockReturnValue(false);

      const result = await paymentService.verifyPayment(
        'order_203',
        'pay_jkl',
        'bad_sig',
        'plink_126',
        'paid',
      );

      expect(result).toBe(false);
    });

    it('should throw when RAZORPAY_KEY_SECRET is not configured', async () => {
      // Override the rzp_key_secret mock to return empty string
      const razorpayModule = require('./razorpay');
      const originalSecret = razorpayModule.rzp_key_secret;
      razorpayModule.rzp_key_secret = '';

      await expect(
        paymentService.verifyPayment('order_204', 'pay_mno', 'sig_ghi', 'plink_127', 'paid'),
      ).rejects.toThrow('RAZORPAY_KEY_SECRET not configured');

      // Restore
      razorpayModule.rzp_key_secret = originalSecret;
    });
  });

  // ============================================
  // getPayment
  // ============================================

  describe('getPayment', () => {
    it('should return payment document by orderId', async () => {
      const db = getTestDB();
      await db.collection('payments').insertOne({
        orderId: 'order_300',
        status: PaymentStatus.PAID,
        amount: 15000,
        currency: 'INR',
        paymentId: 'pay_pqr',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const payment = await paymentService.getPayment('order_300');

      expect(payment).not.toBeNull();
      expect(payment?.orderId).toBe('order_300');
      expect(payment?.status).toBe(PaymentStatus.PAID);
      expect(payment?.paymentId).toBe('pay_pqr');
    });

    it('should return null when orderId not found', async () => {
      const payment = await paymentService.getPayment('nonexistent_order');

      expect(payment).toBeNull();
    });
  });
});
