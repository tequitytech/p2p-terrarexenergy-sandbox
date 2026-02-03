import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { createPendingTransaction, getPendingCount, cancelPendingTransaction } from '../services/transaction-store';
import { extractBuyerDetails, BuyerDetails } from '../trade/routes';
import { BECKN_CONTEXT_ROOT, ENERGY_TRADE_SCHEMA_CTX, PAYMENT_SETTLEMENT_SCHEMA_CTX } from '../constants/schemas';
import dotenv from "dotenv";
dotenv.config();

const ONIX_BAP_URL = process.env.ONIX_BAP_URL || 'http://onix-bap:8081';
const WHEELING_RATE = parseFloat(process.env.WHEELING_RATE || "1.50"); // INR/kWh

// --- Zod Schemas (Full Spec Compliance) ---
// Per: https://raw.githubusercontent.com/beckn/DEG/refs/heads/p2p-trading/examples/p2p-trading-interdiscom/v2/select-request.json

// beckn:quantity schema
const becknQuantitySchema = z.object({
  unitQuantity: z.union([z.string(), z.number()]),
  unitText: z.string().min(1, 'unitText is required'),
}).passthrough();

// EnergyCustomer schema (used in buyerAttributes and providerAttributes)
const energyCustomerSchema = z.object({
  '@context': z.string().optional(),
  '@type': z.literal('EnergyCustomer').optional(),
  meterId: z.string().min(1, 'meterId is required'),
  utilityCustomerId: z.string().min(1, 'utilityCustomerId is required'),
  utilityId: z.string().min(1, 'utilityId is required'),
}).passthrough();

// beckn:buyer with buyerAttributes
const becknBuyerSchema = z.object({
  '@context': z.string().optional(),
  '@type': z.string().optional(),
  'beckn:id': z.string().min(1, 'beckn:id is required'),
  'beckn:buyerAttributes': energyCustomerSchema,
}).passthrough();

// total_quantity schema (must be object with unitQuantity/unitText, not a number)
const totalQuantitySchema = z.object({
  unitQuantity: z.union([z.string(), z.number()]),
  unitText: z.string().min(1, 'unitText is required'),
}).passthrough();

// beckn:orderAttributes schema
const becknOrderAttributesSchema = z.object({
  '@context': z.string().optional(),
  '@type': z.string().optional(),
  bap_id: z.string().min(1, 'bap_id is required'),
  bpp_id: z.string().min(1, 'bpp_id is required'),
  total_quantity: totalQuantitySchema,
}).passthrough();

// beckn:orderItemAttributes with providerAttributes
const becknOrderItemAttributesSchema = z.object({
  '@context': z.string().optional(),
  '@type': z.string().optional(),
  providerAttributes: energyCustomerSchema,
}).passthrough();

// beckn:price with schema:price format (PriceSpecification)
const becknPriceSpecSchema = z.object({
  '@type': z.string().optional(),
  'schema:price': z.union([z.string(), z.number()]),
  'schema:priceCurrency': z.string().min(1, 'schema:priceCurrency is required'),
  unitText: z.string().optional(),
  applicableQuantity: z.object({
    unitQuantity: z.union([z.string(), z.number()]),
    unitText: z.string(),
  }).optional(),
}).passthrough();

// TimePeriod schema (for deliveryWindow/validityWindow)
const timePeriodSchema = z.object({
  '@type': z.string().optional(),
  'schema:startTime': z.string(),
  'schema:endTime': z.string(),
}).passthrough();

// beckn:offerAttributes schema (full spec)
const becknOfferAttributesSchema = z.object({
  '@context': z.string().optional(),
  '@type': z.string().optional(),
  pricingModel: z.string().min(1, 'pricingModel is required'),
  deliveryWindow: timePeriodSchema.optional(),
  validityWindow: timePeriodSchema.optional(),
}).passthrough();

// beckn:acceptedOffer schema (full spec)
const becknAcceptedOfferSchema = z.object({
  '@context': z.string().optional(),
  '@type': z.string().optional(),
  'beckn:id': z.string().min(1, 'beckn:id is required'),
  'beckn:descriptor': z.object({
    '@type': z.string().optional(),
    'schema:name': z.string().optional(),
  }).passthrough().optional(),
  'beckn:provider': z.string().optional(),
  'beckn:items': z.array(z.string()).optional(),
  'beckn:price': becknPriceSpecSchema.optional(),
  'beckn:offerAttributes': becknOfferAttributesSchema.optional(),
}).passthrough();

// beckn:orderItems array item schema (full spec)
const becknOrderItemSchema = z.object({
  'beckn:orderedItem': z.string().min(1, 'beckn:orderedItem is required'),
  'beckn:orderItemAttributes': becknOrderItemAttributesSchema,
  'beckn:quantity': becknQuantitySchema,
  'beckn:acceptedOffer': becknAcceptedOfferSchema,
}).passthrough();

// Select request schema (full spec compliance)
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
      '@context': z.string().optional(),
      '@type': z.string().optional(),
      'beckn:orderStatus': z.string().optional(),
      'beckn:seller': z.string().optional(),
      'beckn:buyer': becknBuyerSchema,
      'beckn:orderAttributes': becknOrderAttributesSchema,
      'beckn:orderItems': z.array(becknOrderItemSchema).min(1, 'At least one beckn:orderItems is required'),
    }).passthrough(),
  }),
});

// --- Catalog-Based Select Schema (Simplified Input) ---
// Accepts catalogue object directly from on_discover response
const catalogBasedSelectSchema = z.object({
  context: z.object({
    version: z.string(),
    action: z.literal('select'),
    transaction_id: z.string(),
    message_id: z.string().optional(),
    bap_id: z.string(),
    bap_uri: z.string().url(),
    bpp_id: z.string(),
    bpp_uri: z.string().url(),
  }).passthrough(),
  catalogue: z.object({
    'beckn:id': z.string().optional(),
    'beckn:providerId': z.string().optional(),
    'beckn:items': z.array(z.any()).min(1, 'At least one item is required'),
    'beckn:offers': z.array(z.any()).min(1, 'At least one offer is required'),
  }).passthrough(),
  customAttributes: z.object({
    quantity: z.object({
      unitQuantity: z.union([z.string(), z.number()]),
      unitText: z.string().default('kWh'),
    }),
    selectedOfferId: z.string().optional(),
  }),
});

type CatalogBasedSelectInput = z.infer<typeof catalogBasedSelectSchema>;

// --- Select-Based Init Schema (Simplified Input) ---
// Accepts select response (message.order from on_select) + customAttributes

// customAttributes for init - only payment ID required
const initCustomAttributesSchema = z.object({
  payment: z.object({
    id: z.string().min(1, 'payment.id is required'),
  }),
});

// Select-based init schema
const selectBasedInitSchema = z.object({
  context: z.object({
    version: z.string(),
    action: z.literal('init'),
    transaction_id: z.string(),
    message_id: z.string().optional(),
    bap_id: z.string(),
    bap_uri: z.string().url(),
    bpp_id: z.string(),
    bpp_uri: z.string().url(),
  }).passthrough(),
  select: z.object({
    'beckn:orderStatus': z.string().optional(),
    'beckn:seller': z.string().optional(),
    'beckn:buyer': z.any(),
    'beckn:orderAttributes': z.any().optional(),
    'beckn:orderItems': z.array(z.any()).min(1, 'At least one beckn:orderItems is required'),
  }).passthrough(),
  customAttributes: initCustomAttributesSchema,
});

type SelectBasedInitInput = z.infer<typeof selectBasedInitSchema>;

// Platform settlement accounts (hardcoded - not user-provided)
const PLATFORM_SETTLEMENT_ACCOUNTS = [
  {
    beneficiaryId: 'terrarex-energy-platform',
    accountHolderName: 'Terrarex Energy Trading Pvt Ltd',
    accountNumber: '50200087654321',
    ifscCode: 'HDFC0001729',
    bankName: 'HDFC Bank',
    vpa: 'terrarex.energy@hdfcbank',
  },
];

/**
 * Transform catalog-based input to full beckn spec Order structure.
 * Buyer details come from the authenticated user's profile.
 */
function transformCatalogToOrder(
  body: CatalogBasedSelectInput,
  buyerDetails: BuyerDetails
): any {
  const { context, catalogue, customAttributes } = body;

  // Find selected offer (or default to first)
  const selectedOffer = customAttributes.selectedOfferId
    ? catalogue['beckn:offers'].find((o: any) => o['beckn:id'] === customAttributes.selectedOfferId)
    : catalogue['beckn:offers'][0];

  if (!selectedOffer) {
    throw new Error('Selected offer not found in catalogue');
  }

  // Find item referenced by offer
  const itemId = selectedOffer['beckn:items']?.[0];
  const item = catalogue['beckn:items'].find((i: any) => i['beckn:id'] === itemId);

  if (!item) {
    throw new Error(`Item ${itemId} not found in catalogue`);
  }

  // Extract provider attributes from item
  const providerAttrs = item['beckn:provider']?.['beckn:providerAttributes'];

  // Derive providerId from item's provider or catalogue level
  const providerId = item['beckn:provider']?.['beckn:id'] || catalogue['beckn:providerId'];

  // Build the exact spec-compliant structure
  return {
    context,
    message: {
      order: {
        '@context': BECKN_CONTEXT_ROOT,
        '@type': 'beckn:Order',
        'beckn:orderStatus': 'CREATED',
        'beckn:seller': providerId,
        'beckn:buyer': {
          '@context': BECKN_CONTEXT_ROOT,
          '@type': 'beckn:Buyer',
          'beckn:id': buyerDetails.buyerId,
          'beckn:buyerAttributes': {
            '@context': ENERGY_TRADE_SCHEMA_CTX,
            '@type': 'EnergyCustomer',
            meterId: buyerDetails.meterId,
            utilityCustomerId: buyerDetails.utilityCustomerId,
            utilityId: buyerDetails.utilityId,
          }
        },
        'beckn:orderAttributes': {
          '@context': ENERGY_TRADE_SCHEMA_CTX,
          '@type': 'EnergyTradeOrder',
          bap_id: context.bap_id,
          bpp_id: context.bpp_id,
          total_quantity: {
            unitQuantity: Number(customAttributes.quantity.unitQuantity),
            unitText: customAttributes.quantity.unitText,
          }
        },
        'beckn:orderItems': [{
          'beckn:orderedItem': itemId,
          'beckn:orderItemAttributes': {
            '@context': ENERGY_TRADE_SCHEMA_CTX,
            '@type': 'EnergyOrderItem',
            providerAttributes: {
              '@context': ENERGY_TRADE_SCHEMA_CTX,
              '@type': 'EnergyCustomer',
              meterId: providerAttrs?.meterId || item['beckn:itemAttributes']?.meterId,
              utilityCustomerId: providerAttrs?.utilityCustomerId,
              utilityId: providerAttrs?.utilityId,
            }
          },
          'beckn:quantity': {
            unitQuantity: Number(customAttributes.quantity.unitQuantity),
            unitText: customAttributes.quantity.unitText,
          },
          'beckn:acceptedOffer': {
            '@context': BECKN_CONTEXT_ROOT,
            '@type': 'beckn:Offer',
            'beckn:id': selectedOffer['beckn:id'],
            'beckn:descriptor': selectedOffer['beckn:descriptor'],
            'beckn:provider': selectedOffer['beckn:provider'],
            'beckn:items': selectedOffer['beckn:items'],
            'beckn:price': selectedOffer['beckn:price'],
            'beckn:offerAttributes': selectedOffer['beckn:offerAttributes'],
          }
        }]
      }
    }
  };
}

/**
 * Transform select-based input to full beckn init request.
 * Takes on_select response's message.order and adds fulfillment + payment.
 */
function transformSelectToInit(
  context: any,
  select: any,
  customAttributes: { payment: { id: string } }
): any {
  // Calculate total amount from order items' accepted offers
  let totalEnergyCost = 0;
  let totalQuantity = 0;
  let currency = 'INR';

  for (const item of select['beckn:orderItems']) {
    const offer = item['beckn:acceptedOffer'];
    const price = offer?.['beckn:price']?.['schema:price'] || 0;
    const quantity = item['beckn:quantity']?.unitQuantity || 0;
    totalEnergyCost += Number(price) * Number(quantity);
    totalQuantity += Number(quantity);
    currency = offer?.['beckn:price']?.['schema:priceCurrency'] || currency;
  }

  // Add wheeling charges (same as webhook controller)
  const wheelingCharges = Math.round(totalQuantity * WHEELING_RATE * 100) / 100;
  const totalAmount = Math.round((totalEnergyCost + wheelingCharges) * 100) / 100;

  return {
    context,
    message: {
      order: {
        '@context': BECKN_CONTEXT_ROOT,
        '@type': 'beckn:Order',
        'beckn:orderStatus': select['beckn:orderStatus'] || 'CREATED',
        'beckn:seller': select['beckn:seller'],
        'beckn:buyer': select['beckn:buyer'],
        'beckn:orderAttributes': select['beckn:orderAttributes'],
        'beckn:orderItems': select['beckn:orderItems'],
        'beckn:fulfillment': {
          '@context': BECKN_CONTEXT_ROOT,
          '@type': 'beckn:Fulfillment',
          'beckn:id': `fulfillment-${context.transaction_id}`,
          'beckn:mode': 'DELIVERY',
        },
        'beckn:payment': {
          '@context': BECKN_CONTEXT_ROOT,
          '@type': 'beckn:Payment',
          'beckn:id': customAttributes.payment.id,
          'beckn:amount': {
            currency,
            value: Math.round(totalAmount * 100) / 100,
          },
          'beckn:beneficiary': 'BPP',
          'beckn:paymentStatus': 'INITIATED',
          'beckn:paymentAttributes': {
            '@context': PAYMENT_SETTLEMENT_SCHEMA_CTX,
            '@type': 'PaymentSettlement',
            settlementAccounts: PLATFORM_SETTLEMENT_ACCOUNTS,
          },
        },
      },
    },
  };
}

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

// Combined validation: accepts either catalog-based or full beckn format
export function validateSelect(req: Request, res: Response, next: NextFunction) {
  // If catalog-based format, skip standard validation (handled in handler)
  if (req.body.catalogue && req.body.customAttributes) {
    return next();
  }
  // Otherwise validate against standard beckn schema
  return validateBody(selectSchema)(req, res, next);
}

// Combined validation for init: accepts either select-based or full beckn format
export function validateInit(req: Request, res: Response, next: NextFunction) {
  // If select-based format, skip standard validation (handled in handler)
  if (req.body.select && req.body.customAttributes) {
    return next();
  }
  // For raw beckn format, basic context validation only (full validation in BPP)
  if (!req.body.context?.transaction_id) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'context.transaction_id is required',
      },
    });
  }
  return next();
}

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
    let becknRequest = req.body;

    // Detect catalog-based format and transform
    if (req.body.catalogue && req.body.customAttributes) {
      // Validate catalog-based format
      const parseResult = catalogBasedSelectSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Catalog-based request validation failed',
            details: parseResult.error.issues.map((e: z.ZodIssue) => ({
              field: e.path.join('.'),
              message: e.message,
            })),
          },
        });
      }

      // Extract buyer details from authenticated user's profile
      const userId = (req as any).user?.userId;
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required for catalog-based select. Provide a valid JWT token.',
          },
        });
      }

      let buyerDetails: BuyerDetails;
      try {
        buyerDetails = await extractBuyerDetails(new ObjectId(userId));
      } catch (error: any) {
        const isProfileError = error.code === 'NO_BUYER_PROFILE';
        return res.status(isProfileError ? 403 : 500).json({
          success: false,
          error: {
            code: isProfileError ? 'NO_BUYER_PROFILE' : 'PROFILE_ERROR',
            message: error.message,
          },
        });
      }

      becknRequest = transformCatalogToOrder(parseResult.data, buyerDetails);
      console.log(`[SyncAPI] Transformed catalog-based request to beckn format for buyer: ${buyerDetails.buyerId}`);
    }

    const transactionId = becknRequest.context.transaction_id;
    const messageId = becknRequest.context?.message_id || uuidv4();

    becknRequest = {
      ...becknRequest,
      context: { ...becknRequest.context, message_id: messageId }
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
    let becknRequest = req.body;

    // Detect select-based format and transform
    if (req.body.select && req.body.customAttributes) {
      // Validate select-based format
      const parseResult = selectBasedInitSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Select-based init request validation failed',
            details: parseResult.error.issues.map((e: z.ZodIssue) => ({
              field: e.path.join('.'),
              message: e.message,
            })),
          },
        });
      }

      // Auth required for select-based format
      const userId = (req as any).user?.userId;
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required for select-based init. Provide a valid JWT token.',
          },
        });
      }

      becknRequest = transformSelectToInit(
        parseResult.data.context,
        parseResult.data.select,
        parseResult.data.customAttributes
      );
      console.log(`[SyncAPI] Transformed select-based init request for txn: ${parseResult.data.context.transaction_id}`);
    }

    const transactionId = becknRequest.context?.transaction_id;
    const messageId = becknRequest.context?.message_id || uuidv4();

    becknRequest = {
      ...becknRequest,
      context: { ...becknRequest.context, message_id: messageId }
    };

    const response = await executeAndWait('init', becknRequest, transactionId);

    // Check for business error in response
    if (response.error) {
      console.log(`[SyncAPI] syncInit business error:`, response.error);
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

    return res.status(200).json({
      success: true,
      transaction_id: transactionId,
      ...response
    });
  } catch (error: any) {
    console.error(`[SyncAPI] syncInit error:`, error.message);

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

export async function syncConfirm(req: Request, res: Response) {
  try {
    const transactionId = req.body.context?.transaction_id;
    const messageId = req.body.context?.message_id || uuidv4();

    // Extract utility IDs from new schema (v0.3) - EnergyTrade schema
    const order = req.body.message?.order;
    const orderAttributes = order?.['beckn:orderAttributes'] || {};
    const buyerAttributes = order?.['beckn:buyer']?.['beckn:buyerAttributes'];
    const orderItems = order?.['beckn:orderItems'] || [];
    const providerAttributes = orderItems[0]?.['beckn:orderItemAttributes']?.providerAttributes;

    // New schema: beckn:buyer.beckn:buyerAttributes.utilityId
    const utilityIdBuyer = buyerAttributes?.utilityId;
    // New schema: beckn:orderItems[].beckn:orderItemAttributes.providerAttributes.utilityId
    const utilityIdSeller = providerAttributes?.utilityId;

    if (!utilityIdBuyer || utilityIdBuyer.trim() === '') {
      console.log(`[SyncAPI] syncConfirm validation error: missing utilityIdBuyer`);
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'utilityId is required in beckn:buyer.beckn:buyerAttributes for inter-discom trading'
        }
      });
    }

    if (!utilityIdSeller || utilityIdSeller.trim() === '') {
      console.log(`[SyncAPI] syncConfirm validation error: missing utilityIdSeller`);
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'utilityId is required in beckn:orderItemAttributes.providerAttributes for inter-discom trading'
        }
      });
    }

    const becknRequest = {
      ...req.body,
      context: { ...req.body.context, message_id: messageId }
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
