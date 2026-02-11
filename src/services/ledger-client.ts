import axios from 'axios';
import * as crypto from 'crypto';

const LEDGER_URL = process.env.LEDGER_URL || 'https://34.93.166.38.sslip.io';
const LEDGER_TIMEOUT = parseInt(process.env.LEDGER_TIMEOUT || '10000', 10);
const LEDGER_RETRY_COUNT = parseInt(process.env.LEDGER_RETRY_COUNT || '3', 10);
const LEDGER_RETRY_DELAY = parseInt(process.env.LEDGER_RETRY_DELAY || '1000', 10);

// Beckn signing credentials (same as ONIX BPP config)
const SUBSCRIBER_ID = process.env.BECKN_SUBSCRIBER_ID || 'p2p.terrarexenergy.com';
const SIGNING_KEY_ID = process.env.BECKN_SIGNING_KEY_ID || '76EU8tEmt7xkez9GFnnhFWDBkv4SYmy3ox2uva6cGio2m1piPrwyju';
const SIGNING_PRIVATE_KEY = process.env.BECKN_SIGNING_PRIVATE_KEY || 'Eew6JTzT0yeztWLZghqe6oeveJcyZ2l807DM8ucS2NU=';

export interface LedgerTradeDetail {
  tradeQty: number;
  tradeType: string;
  tradeUnit: string;
}

export interface LedgerValidationMetric {
  validationMetricType: string;
  validationMetricValue: number;
}

export interface LedgerRecord {
  transactionId: string;
  orderItemId: string;
  platformIdBuyer: string;
  platformIdSeller: string;
  discomIdBuyer: string;
  discomIdSeller: string;
  buyerId: string;
  sellerId: string;
  tradeTime: string;
  deliveryStartTime: string;
  deliveryEndTime: string;
  tradeDetails: LedgerTradeDetail[];
  statusBuyerDiscom?: 'PENDING' | 'COMPLETED';
  statusSellerDiscom?: 'PENDING' | 'COMPLETED';
  buyerFulfillmentValidationMetrics?: LedgerValidationMetric[];
  sellerFulfillmentValidationMetrics?: LedgerValidationMetric[];
  note?: string;
  clientReference?: string;
}

export interface LedgerGetRequest {
  transactionId?: string;
  orderItemId?: string;
  discomIdBuyer?: string;
  discomIdSeller?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface LedgerGetResponse {
  records: LedgerRecord[];
  total: number;
}

// ── Beckn Protocol Signing ──────────────────────────────────────

// PKCS8 DER prefix for Ed25519 private key (wraps 32-byte seed)
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function createBecknAuthHeader(body: string): string {
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300; // 5-minute validity per Beckn spec

  // BLAKE2b-512 digest of the request body
  const digest = crypto.createHash('blake2b512').update(body).digest('base64');

  // Build signing string per Beckn protocol spec
  const signingString = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;

  // Wrap 32-byte Ed25519 seed in PKCS8 DER format for Node.js crypto
  const seed = Buffer.from(SIGNING_PRIVATE_KEY, 'base64');
  const derKey = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });

  // Sign with Ed25519
  const signature = crypto.sign(null, Buffer.from(signingString), privateKey).toString('base64');

  const keyId = `${SUBSCRIBER_ID}|${SIGNING_KEY_ID}|ed25519`;

  return `Signature keyId="${keyId}", algorithm="ed25519", created="${created}", expires="${expires}", headers="(created) (expires) digest", signature="${signature}"`;
}

function signedHeaders(body: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': createBecknAuthHeader(body),
  };
}

// ── Helpers ─────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  retries: number = LEDGER_RETRY_COUNT
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const isRetryable = error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        (error.response?.status >= 500 && error.response?.status < 600);

      if (!isRetryable || attempt === retries) {
        throw error;
      }

      console.log(`[LedgerClient] Retry ${attempt}/${retries} after ${LEDGER_RETRY_DELAY}ms`);
      await sleep(LEDGER_RETRY_DELAY * attempt); // Exponential backoff
    }
  }

  throw lastError;
}

/**
 * Query trade records from DEG ledger by transaction ID
 */
export async function queryTradeByTransaction(
  transactionId: string,
  discomId: string
): Promise<LedgerRecord | null> {
  console.log(`[LedgerClient] Querying trade: txn=${transactionId}, discom=${discomId}`);

  try {
    const body = JSON.stringify({
      transactionId,
      discomIdBuyer: discomId,
      limit: 1,
      offset: 0
    });

    const response = await withRetry(async () => {
      return axios.post<LedgerGetResponse>(
        `${LEDGER_URL}/ledger/get`,
        body,
        { timeout: LEDGER_TIMEOUT, headers: signedHeaders(body) }
      );
    });

    const records = response.data?.records || [];
    if (records.length === 0) {
      console.log(`[LedgerClient] No records found for txn=${transactionId}`);
      return null;
    }

    console.log(`[LedgerClient] Found record: buyerStatus=${records[0].statusBuyerDiscom}, sellerStatus=${records[0].statusSellerDiscom}`);
    return records[0];
  } catch (error: any) {
    console.error(`[LedgerClient] Query failed: ${error.message}`);
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error(`Ledger auth failed (${error.response.status}): Beckn signing rejected`);
    }
    return null;
  }
}

/**
 * Query multiple trade records from ledger
 */
export async function queryTrades(request: LedgerGetRequest): Promise<LedgerRecord[]> {
  console.log(`[LedgerClient] Querying trades:`, JSON.stringify(request));

  try {
    const body = JSON.stringify({
      ...request,
      limit: request.limit || 100,
      offset: request.offset || 0,
      sort: request.sort || 'tradeTime',
      sortOrder: request.sortOrder || 'desc'
    });

    const response = await withRetry(async () => {
      return axios.post<LedgerGetResponse>(
        `${LEDGER_URL}/ledger/get`,
        body,
        { timeout: LEDGER_TIMEOUT, headers: signedHeaders(body) }
      );
    });

    const records = response.data?.records || [];
    console.log(`[LedgerClient] Found ${records.length} records`);
    return records;
  } catch (error: any) {
    console.error(`[LedgerClient] Query failed: ${error.message}`);
    // Surface auth errors instead of silently returning empty
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error(`Ledger auth failed (${error.response.status}): Beckn signing rejected`);
    }
    return [];
  }
}

/**
 * Get ledger health status
 */
export async function getLedgerHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const body = JSON.stringify({ limit: 1, offset: 0 });
    await axios.post(
      `${LEDGER_URL}/ledger/get`,
      body,
      { timeout: 5000, headers: signedHeaders(body) }
    );
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error: any) {
    return { ok: false, latencyMs: Date.now() - start, error: error.message };
  }
}

/**
 * Add trade to ledger
 */
export async function addTrade(trade: LedgerRecord) {
  try {
    const body = JSON.stringify(trade);
    const response = await withRetry(async () => {
      return axios.post(
        `${LEDGER_URL}/ledger/put`,
        body,
        { timeout: LEDGER_TIMEOUT, headers: signedHeaders(body) }
      );
    });
    return response.data;
  } catch (error: any) {
    console.error(`[LedgerClient] Add trade failed: ${error.message}`);
    return null;
  }
}

/**
 * Update trade record
 */
export async function updateTrade(trade: LedgerRecord) {
  try {
    const body = JSON.stringify(trade);
    const response = await withRetry(async () => {
      return axios.post(
        `${LEDGER_URL}/ledger/record`,
        body,
        { timeout: LEDGER_TIMEOUT, headers: signedHeaders(body) }
      );
    });
    return response.data;
  } catch (error: any) {
    console.error(`[LedgerClient] Update trade failed: ${error.message}`);
    return null;
  }
}


export const ledgerClient = {
  queryTradeByTransaction,
  queryTrades,
  addTrade,
  updateTrade,
  getLedgerHealth,
  LEDGER_URL
};
