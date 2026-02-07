import { getDB } from '../db';

import { preview, confirm } from './services/hourly-optimizer';

import type { SellerBidRequest } from './types';
import type { Request, Response } from 'express';


/**
 * Validate seller bid request parameters
 */

/**
 * Validate seller bid request body (only source_type needed from FE)
 */
function validateBody(body: any): { valid: boolean; error?: string; source_type?: string } {
  const { source_type } = body;

  if (!source_type || !['SOLAR', 'WIND', 'BATTERY'].includes(source_type)) {
    return { valid: false, error: 'Missing or invalid required field: source_type (must be SOLAR, WIND, or BATTERY)' };
  }

  return {
    valid: true,
    source_type
  };
}

async function getSellerDetailsFromAuth(user: any) {
  const db = getDB();
  const userProfile = await db.collection('users').findOne({ phone: user.phone });

  if (!userProfile) {
    throw new Error('User profile not found');
  }

  const generationProfile = userProfile.profiles?.generationProfile;
  if (!generationProfile) {
    throw new Error('User does not have a verified generationProfile. Please register as a prosumer.');
  }

  const provider_id = generationProfile.did;
  const meter_id = generationProfile.meterNumber || userProfile.meters?.[0];

  if (!provider_id || !meter_id) {
    throw new Error('Missing provider_id (DID) or meter_id in generation profile.');
  }

  return { provider_id, meter_id };
}

/**
 * POST /api/seller/preview
 * Calculate optimal hourly bids for tomorrow (top 5 by revenue)
 */
export async function previewSellerBid(req: Request, res: Response) {
  try {
    console.log(`[SellerBidding] Preview request received`);
    const user = (req as any).user;

    // 1. Validate Body
    const validation = validateBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // 2. Get details from Auth
    const { provider_id, meter_id } = await getSellerDetailsFromAuth(user);

    // 3. Generate preview
    const result = await preview({
      provider_id,
      meter_id,
      source_type: validation.source_type as SellerBidRequest['source_type']
    });

    return res.status(200).json(result);

  } catch (error: any) {
    console.error(`[SellerBidding] Preview error:`, error.message);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
}

/**
 * POST /api/seller/confirm
 * Place hourly bids via internal /api/publish endpoint
 */
export async function confirmSellerBid(req: Request, res: Response) {
  try {
    console.log(`[SellerBidding] Confirm request received`);
    const user = (req as any).user;
    const authorizationToken = req.headers.authorization!;

    // 1. Validate Body
    const validation = validateBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // 2. Get details from Auth
    const { provider_id, meter_id } = await getSellerDetailsFromAuth(user);

    // 3. Confirm and publish bids
    const result = await confirm({
      provider_id,
      meter_id,
      source_type: validation.source_type as SellerBidRequest['source_type']
    }, authorizationToken);

    return res.status(200).json(result);

  } catch (error: any) {
    console.error(`[SellerBidding] Confirm error:`, error.message);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
}
