import { Request, Response } from 'express';
import { SellerBidRequest } from './types';
import { preview, confirm } from './services/hourly-optimizer';

/**
 * Validate seller bid request parameters
 */
function validateRequest(body: any): { valid: boolean; error?: string; request?: SellerBidRequest } {
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
 * POST /api/seller/preview
 * Calculate optimal hourly bids for tomorrow (top 5 by revenue) without placing them
 */
export async function previewSellerBid(req: Request, res: Response) {
  try {
    console.log(`[SellerBidding] Preview request received`);

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
    console.error(`[SellerBidding] Preview error:`, error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}

/**
 * POST /api/seller/confirm
 * Place hourly bids via internal /api/publish endpoint
 */
export async function confirmSellerBid(req: Request, res: Response) {
  try {
    console.log(`[SellerBidding] Confirm request received`);
    const authorizationToken = req.headers.authorization!

    // Validate request
    const validation = validateRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    // Confirm and publish bids
    const result = await confirm(validation.request!, authorizationToken);

    return res.status(200).json(result);

  } catch (error: any) {
    console.error(`[SellerBidding] Confirm error:`, error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
