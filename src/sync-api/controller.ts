import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { createPendingTransaction, getPendingCount, cancelPendingTransaction } from '../services/transaction-store';
import dotenv from "dotenv";
dotenv.config();

const ONIX_BAP_URL = process.env.ONIX_BAP_URL || 'http://onix-bap:8081';

// --- Zod Schemas ---

// beckn:quantity schema
const becknQuantitySchema = z.object({
  unitQuantity: z.union([z.string(), z.number()]),
  unitText: z.string().min(1, 'unitText is required'),
}).passthrough();

// beckn:price schema
const becknPriceSchema = z.object({
  value: z.union([z.string(), z.number()]),
  currency: z.string().min(1, 'currency is required'),
}).passthrough();

// beckn:offerAttributes schema
const becknOfferAttributesSchema = z.object({
  '@type': z.string().min(1, '@type is required'),
  pricingModel: z.string().min(1, 'pricingModel is required'),
  'beckn:price': becknPriceSchema.optional(),
}).passthrough();

// beckn:acceptedOffer schema
const becknAcceptedOfferSchema = z.object({
  'beckn:id': z.string().min(1, 'beckn:id is required'),
  'beckn:offerAttributes': becknOfferAttributesSchema,
}).passthrough();

// beckn:orderItems array item schema
const becknOrderItemSchema = z.object({
  'beckn:orderedItem': z.string().min(1, 'beckn:orderedItem is required'),
  'beckn:acceptedOffer': becknAcceptedOfferSchema,
  'beckn:quantity': becknQuantitySchema,
}).passthrough();

// Select request schema
const selectSchema = z.object({
  context: z.object({
    version: z.string().min(1, 'version is required'),
    action: z.literal('select'),
    transaction_id: z.string().min(1, 'transaction_id is required'),
    message_id: z.string().optional(),  // We generate if missing
    bap_id: z.string().min(1, 'bap_id is required'),
    bap_uri: z.string().url('bap_uri must be a valid URL'),
    bpp_id: z.string().min(1, 'bpp_id is required'),
    bpp_uri: z.string().url('bpp_uri must be a valid URL'),
  }).passthrough(),
  message: z.object({
    order: z.object({
      'beckn:orderItems': z.array(becknOrderItemSchema).min(1, 'At least one beckn:orderItems is required'),
    }).passthrough(),
  }),
});

// --- Validation Middleware ---

function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.issues.map((e: z.ZodIssue) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      });
    }
    next();
  };
}

export const validateSelect = validateBody(selectSchema);

/**
 * Check if ONIX response indicates ACK.
 * Handles both normal JSON response and malformed string responses.
 */
function isAckResponse(data: any): { isAck: boolean; reason: string } {
  // Log the raw data type and value for debugging
  console.log(`[SyncAPI] ACK check - data type: ${typeof data}`);

  // Case 1: Normal JSON object with message.ack.status
  if (data && typeof data === 'object') {
    const status = data?.message?.ack?.status;
    console.log(`[SyncAPI] ACK check - JSON path status: ${status}`);
    if (status === 'ACK') {
      return { isAck: true, reason: 'JSON path message.ack.status === ACK' };
    }
    if (status === 'NACK') {
      return { isAck: false, reason: 'JSON path message.ack.status === NACK' };
    }
  }

  // Case 2: String response (possibly malformed JSON from proxy)
  if (typeof data === 'string') {
    console.log(`[SyncAPI] ACK check - string response (length: ${data.length}): ${data.substring(0, 200)}...`);

    // Check for NACK first (takes priority)
    // Look for "status":"NACK" pattern (exact JSON format)
    if (data.includes('"status":"NACK"') || data.includes('"status": "NACK"')) {
      return { isAck: false, reason: 'String contains "status":"NACK"' };
    }

    // Check for ACK pattern
    // Look for "status":"ACK" pattern (exact JSON format to avoid substring issues)
    if (data.includes('"status":"ACK"') || data.includes('"status": "ACK"')) {
      return { isAck: true, reason: 'String contains "status":"ACK"' };
    }

    return { isAck: false, reason: 'String does not contain valid ACK pattern' };
  }

  // Case 3: Unknown format
  console.log(`[SyncAPI] ACK check - unknown format: ${JSON.stringify(data)}`);
  return { isAck: false, reason: `Unknown response format: ${typeof data}` };
}

async function executeAndWait(action: string, becknRequest: any, transactionId: string): Promise<any> {
  const callbackPromise = createPendingTransaction(transactionId, action);

  const onixUrl = `${ONIX_BAP_URL}/bap/caller/${action}`;
  console.log(`[SyncAPI] Forwarding ${action} to ${onixUrl}, txn: ${transactionId}`);

  try {
    const ackResponse = await axios.post(onixUrl, becknRequest, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const ackCheck = isAckResponse(ackResponse.data);
    console.log(`[SyncAPI] ACK check result: isAck=${ackCheck.isAck}, reason=${ackCheck.reason}`);

    if (!ackCheck.isAck) {
      cancelPendingTransaction(transactionId);
      throw new Error(`ONIX returned NACK (${ackCheck.reason}): ${JSON.stringify(ackResponse.data)}`);
    }

    console.log(`[SyncAPI] Received ACK, waiting for on_${action} callback...`);
    return await callbackPromise;
  } catch (error: any) {
    // Cancel pending transaction to prevent orphaned timeout from crashing the process
    cancelPendingTransaction(transactionId);

    // Extract ONIX error details from axios error response
    if (error.response?.data) {
      const onixError = error.response.data;
      console.error(`[SyncAPI] ONIX error response:`, JSON.stringify(onixError, null, 2));
      // ONIX error format: {message: {ack: {status: "NACK"}, error: {code, paths, message}}}
      const becknError = onixError.message?.error || onixError.error;
      const errorMessage = becknError?.message
        || (typeof onixError.error === 'string' ? onixError.error : null)
        || `ONIX returned ${error.response.status}`;

      // Normalize to validation error format: [{field, message}]
      const errorDetails = becknError?.paths
        ? [{ field: becknError.paths, message: becknError.message || errorMessage }]
        : [{ field: '', message: errorMessage }];

      const err = new Error(errorMessage);
      (err as any).code = 'UPSTREAM_ERROR';
      (err as any).errorDetails = errorDetails;
      (err as any).statusCode = 502;  // Bad Gateway for upstream errors
      throw err;
    }

    throw error;
  }
}

export async function syncSelect(req: Request, res: Response) {
  try {
    const transactionId = req.body.context.transaction_id;
    const messageId = req.body.context?.message_id || uuidv4();

    const becknRequest = {
      ...req.body,
      context: { ...req.body.context, message_id: messageId }
    };

    const response = await executeAndWait('select', becknRequest, transactionId);

    // Check for business error in response (e.g., insufficient inventory)
    if (response.error) {
      console.log(`[SyncAPI] syncSelect business error:`, response.error);
      return res.status(400).json({
        success: false,
        transaction_id: transactionId,
        error: {
          code: 'BUSINESS_ERROR',
          message: response.error.message || 'Business rule validation failed',
          details: response.error
        }
      });
    }

    // Success response
    return res.status(200).json({
      success: true,
      transaction_id: transactionId,
      ...response
    });
  } catch (error: any) {
    console.error(`[SyncAPI] syncSelect error:`, error.message);

    // Determine HTTP status and error code
    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';

    if (error.code === 'UPSTREAM_ERROR') {
      statusCode = 502;
      errorCode = 'UPSTREAM_ERROR';
    } else if (error.message?.includes('Timeout')) {
      statusCode = 504;
      errorCode = 'TIMEOUT';
    } else if (error.statusCode) {
      statusCode = error.statusCode;
    }

    return res.status(statusCode).json({
      success: false,
      error: {
        code: errorCode,
        message: error.message,
        details: error.errorDetails || null
      }
    });
  }
}

export async function syncInit(req: Request, res: Response) {
  try {
    const transactionId = req.body.context?.transaction_id;
    const messageId = req.body.context?.message_id || uuidv4();

    const becknRequest = {
      ...req.body,
      context: { ...req.body.context, message_id: messageId }
    };

    const response = await executeAndWait('init', becknRequest, transactionId);

    return res.status(200).json({
      success: true,
      transaction_id: transactionId,
      ...response
    });
  } catch (error: any) {
    console.error(`[SyncAPI] syncInit error:`, error.message);
    const statusCode = error.statusCode || (error.message?.includes('Timeout') ? 504 : 500);
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      details: error.onixError || null
    });
  }
}

export async function syncConfirm(req: Request, res: Response) {
  try {
    const transactionId = req.body.context?.transaction_id;
    const messageId = req.body.context?.message_id || uuidv4();

    // Validate required inter-utility fields for confirm
    const orderAttributes = req.body.message?.order?.['beckn:orderAttributes'];
    const utilityIdBuyer = orderAttributes?.utilityIdBuyer;
    const utilityIdSeller = orderAttributes?.utilityIdSeller;

    if (!utilityIdBuyer || utilityIdBuyer.trim() === '') {
      console.log(`[SyncAPI] syncConfirm validation error: missing utilityIdBuyer`);
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'utilityIdBuyer is required in beckn:orderAttributes for inter-discom trading'
        }
      });
    }

    if (!utilityIdSeller || utilityIdSeller.trim() === '') {
      console.log(`[SyncAPI] syncConfirm validation error: missing utilityIdSeller`);
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'utilityIdSeller is required in beckn:orderAttributes for inter-discom trading'
        }
      });
    }

    // Ensure @type is EnergyTradeOrderInterUtility for inter-discom
    const becknRequest = {
      ...req.body,
      context: { ...req.body.context, message_id: messageId },
      message: {
        ...req.body.message,
        order: {
          ...req.body.message?.order,
          'beckn:orderAttributes': {
            ...orderAttributes,
            '@type': 'EnergyTradeOrderInterUtility'
          }
        }
      }
    };

    const response = await executeAndWait('confirm', becknRequest, transactionId);

    // Check for error in response (e.g., insufficient inventory)
    if (response.error) {
      console.log(`[SyncAPI] syncConfirm business error:`, response.error);
      return res.status(400).json({
        success: false,
        transaction_id: transactionId,
        error: response.error
      });
    }

    return res.status(200).json({
      success: true,
      transaction_id: transactionId,
      ...response
    });
  } catch (error: any) {
    console.error(`[SyncAPI] syncConfirm error:`, error.message);
    const statusCode = error.statusCode || (error.message?.includes('Timeout') ? 504 : 500);
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      details: error.onixError || null
    });
  }
}

export async function syncStatus(req: Request, res: Response) {
  try {
    const transactionId = req.body.context?.transaction_id;
    const messageId = req.body.context?.message_id || uuidv4();

    const becknRequest = {
      ...req.body,
      context: { ...req.body.context, message_id: messageId }
    };

    const response = await executeAndWait('status', becknRequest, transactionId);

    return res.status(200).json({
      success: true,
      transaction_id: transactionId,
      ...response
    });
  } catch (error: any) {
    console.error(`[SyncAPI] syncStatus error:`, error.message);
    const statusCode = error.statusCode || (error.message?.includes('Timeout') ? 504 : 500);
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      details: error.onixError || null
    });
  }
}

export function syncHealth(req: Request, res: Response) {
  return res.status(200).json({
    status: 'OK',
    pendingTransactions: getPendingCount(),
    onixBapUrl: ONIX_BAP_URL
  });
}
