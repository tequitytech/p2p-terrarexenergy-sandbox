/**
 * Jest setup file - runs before each test file
 */
import * as crypto from 'crypto';

// Suppress console.log during tests unless DEBUG is set
if (!process.env.DEBUG) {
  jest.spyOn(console, 'log').mockImplementation(() => {});
}

// Set default environment variables for tests
process.env.NODE_ENV = 'test';
process.env.CALLBACK_TIMEOUT = '1000'; // Faster timeout for tests
process.env.LEDGER_TIMEOUT = '1000';
process.env.LEDGER_RETRY_COUNT = '1';
process.env.LEDGER_RETRY_DELAY = '100';

// Generate RS256 keypair for JWT tests (must be set before auth modules load)
if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY = publicKey;
}

// Use AWS SMS provider in tests — the sms-service.test.ts mocks snsClient.send,
// and this avoids Twilio client validation errors from fake credentials.
process.env.SMS_PROVIDER = process.env.SMS_PROVIDER || 'aws';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key-id';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret-key';

// Clean up after all tests
afterAll(() => {
  jest.restoreAllMocks();
});
