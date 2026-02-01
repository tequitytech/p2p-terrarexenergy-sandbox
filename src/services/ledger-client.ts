import axios, { AxiosError } from 'axios';

const LEDGER_URL = process.env.LEDGER_URL || 'https://34.93.166.38.sslip.io';
const LEDGER_TIMEOUT = parseInt(process.env.LEDGER_TIMEOUT || '10000', 10);
const LEDGER_RETRY_COUNT = parseInt(process.env.LEDGER_RETRY_COUNT || '3', 10);
const LEDGER_RETRY_DELAY = parseInt(process.env.LEDGER_RETRY_DELAY || '1000', 10);

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
    const response = await withRetry(async () => {
      return axios.post<LedgerGetResponse>(
        `${LEDGER_URL}/ledger/get`,
        {
          transactionId,
          discomIdBuyer: discomId,
          limit: 1,
          offset: 0
        },
        { timeout: LEDGER_TIMEOUT }
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
    return null;
  }
}

/**
 * Query multiple trade records from ledger
 */
export async function queryTrades(request: LedgerGetRequest): Promise<LedgerRecord[]> {
  console.log(`[LedgerClient] Querying trades:`, JSON.stringify(request));

  try {
    const response = await withRetry(async () => {
      return axios.post<LedgerGetResponse>(
        `${LEDGER_URL}/ledger/get`,
        {
          ...request,
          limit: request.limit || 100,
          offset: request.offset || 0,
          sort: request.sort || 'tradeTime',
          sortOrder: request.sortOrder || 'desc'
        },
        { timeout: LEDGER_TIMEOUT }
      );
    });

    const records = response.data?.records || [];
    console.log(`[LedgerClient] Found ${records.length} records`);
    return records;
  } catch (error: any) {
    console.error(`[LedgerClient] Query failed: ${error.message}`);
    return [];
  }
}

/**
 * Get ledger health status
 */
export async function getLedgerHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await axios.post(
      `${LEDGER_URL}/ledger/get`,
      { limit: 1, offset: 0 },
      { timeout: 5000 }
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
    const response = await withRetry(async () => {
      return axios.post(
        `${LEDGER_URL}/ledger/put`,
        trade,
        { timeout: LEDGER_TIMEOUT }
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
    const response = await withRetry(async () => {
      return axios.post(
        `${LEDGER_URL}/ledger/record`,
        trade,
        { timeout: LEDGER_TIMEOUT }
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
