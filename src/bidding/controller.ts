
import { preview, confirm } from './services/bid-optimizer';

import type { BidRequest } from './types';
import type { Request, Response } from 'express';

/**
 * Validate bid request parameters
 */
function validateRequest(body: any): { valid: boolean; error?: string; request?: BidRequest } {
  const { provider_id, meter_id, source_type } = body;

  if (!provider_id || typeof provider_id !== 'string') {
    return { valid: false, error: 'Missing or invalid required field: provider_id' };
  }

  if (!meter_id || typeof meter_id !== 'string') {
    return { valid: false, error: 'Missing or invalid required field: meter_id' };
  }

  if (!source_type || !['SOLAR', 'WIND', 'BATTERY'].includes(source_type)) {
    return { valid: false, error: 'Missing or invalid required field: source_type (must be SOLAR, WIND, or BATTERY)' };
  }

  return {
    valid: true,
    request: { provider_id, meter_id, source_type }
  };
}

/**
 * POST /api/bid/preview
 * Calculate optimal bids without placing them
 */
export async function previewBid(req: Request, res: Response) {
  try {
    console.log(`[BidController] Preview request received`);

    // Validate request
    const validation = validateRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    // Generate preview
    const result = await preview(validation.request!);

    return res.status(200).json(result);

  } catch (error: any) {
    console.error(`[BidController] Preview error:`, error.message);

    // Determine appropriate status code
    const status = error.message?.includes('not found') || error.message?.includes('malformed')
      ? 400
      : 500;

    return res.status(status).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}

/**
 * POST /api/bid/confirm
 * Place bids via internal /api/publish endpoint
 *
 * Optional params:
 * - max_bids: number - Limit to N bids (default: all 7 days)
 */
export async function confirmBid(req: Request, res: Response) {
  try {
    console.log(`[BidController] Confirm request received`);

    // Validate request
    const validation = validateRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    // Optional: limit number of bids (for testing)
    const maxBids = req.body.max_bids ? parseInt(req.body.max_bids) : undefined;

    // Confirm and publish bids via internal publish API
    const result = await confirm(validation.request!, maxBids);

    return res.status(200).json(result);

  } catch (error: any) {
    console.error(`[BidController] Confirm error:`, error.message);

    // Determine appropriate status code
    const status = error.message?.includes('not found') || error.message?.includes('malformed')
      ? 400
      : 500;

    return res.status(status).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
