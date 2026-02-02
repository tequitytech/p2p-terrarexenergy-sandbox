import { Request, Response } from 'express';
import { getDB } from '../db';
import { EnergyRequest, CreateEnergyRequestDTO } from './types';
import { ObjectId } from 'mongodb';

const COLLECTION_NAME = 'energy_requests';

/**
 * createEnergyRequest
 * POST /api/request-energy
 */
export async function createEnergyRequest(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { requiredEnergy, purpose, startTime, endTime } = req.body as CreateEnergyRequestDTO;

    // Validate inputs
    if (!requiredEnergy || !purpose || !startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Fetch full user profile to get socialImpactVerified status
    const db = getDB();
    const userProfile = await db.collection('users').findOne({ phone: user.phone });

    if (!userProfile) {
       return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const newRequest: Omit<EnergyRequest, '_id'> = {
      userId: user._id || userProfile._id, // Prefer user object if mapped, else profile
      userName: userProfile.name || 'Unknown User',
      isVerifiedBeneficiary: !!userProfile.isVerifiedBeneficiary,
      beneficiaryType: userProfile.beneficiaryType,
      requiredEnergy: Number(requiredEnergy),
      purpose,
      startTime,
      endTime,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection(COLLECTION_NAME).insertOne(newRequest);

    return res.status(201).json({
      success: true,
      data: { ...newRequest, _id: result.insertedId }
    });

  } catch (error: any) {
    console.error('[EnergyRequest] Create Request Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
}

/**
 * getEnergyRequests
 * GET /api/accounts/donate
 * GET /api/accounts/gift
 */
export async function getEnergyRequests(req: Request, res: Response) {
  try {
    const db = getDB();
    // Return all PENDING requests
    const requests = await db.collection(COLLECTION_NAME)
      .find({ status: 'PENDING' })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(requests);

  } catch (error: any) {
    console.error('[EnergyRequest] Get Requests Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
}

/**
 * findBestSeller
 * GET /api/find-seller/:requestId
 */
export async function findBestSeller(req: Request, res: Response) {
  try {
    const { requestId } = req.params;
    if (!requestId) {
        return res.status(400).json({ success: false, error: 'Request ID missing' });
    }

    const db = getDB();
    // 1. Get the request details
    let request: any;
    try {
        request = await db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(requestId as string) });
    } catch(err) {
        // Invalid object id
        return res.status(400).json({ success: false, error: 'Invalid Request ID format' });
    }

    if (!request) {
      return res.status(404).json({ success: false, error: 'Energy request not found' });
    }

    // 2. Find cheapest seller with >= required quantity
    // Using 'offers' collection which contains Beckn Offer objects.
    // Price path: "beckn:price.schema:price" (or beckn:offerAttributes.beckn:price.value)
    // Quantity path: "beckn:offerAttributes.beckn:maxQuantity.unitQuantity"

    const bestSeller = await db.collection('offers').find({
        "beckn:offerAttributes.beckn:maxQuantity.unitQuantity": { $gte: Number(request.requiredEnergy) }
    })
    .sort({ "beckn:price.schema:price": 1 })
    .limit(1)
    .toArray();

    if (!bestSeller || bestSeller.length === 0) {
        return res.status(404).json({ success: false, message: 'No suitable seller found' });
    }

    return res.status(200).json({
        success: true,
        bestSeller: bestSeller[0]
    });

  } catch (error: any) {
    console.error('[EnergyRequest] Find Seller Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
}

/**
 * giftEnergy
 * POST /api/gift
 */
export async function giftEnergy(req: Request, res: Response) {
    try {
        const { requestId, sellerId } = req.body;
        
        // This is a "Purchase on behalf" logic.
        // real implementation would involve transaction, payment, ledger update etc.
        // For now, we will mark request as FULFILLED and simulate success.
        
        if (!requestId || !sellerId) {
             return res.status(400).json({ success: false, error: 'Missing requestId or sellerId' });
        }

        const db = getDB();
        const updateResult = await db.collection(COLLECTION_NAME).updateOne(
            { _id: new ObjectId(requestId) },
            { 
                $set: { 
                    status: 'FULFILLED', 
                    fulfilledBy: sellerId,
                    updatedAt: new Date()
                } 
            }
        );

        if (updateResult.modifiedCount === 0) {
             return res.status(400).json({ success: false, error: 'Request not found or already fulfilled' });
        }

        return res.status(200).json({
            success: true, 
            message: 'Energy gifted successfully',
            requestId,
            sellerId
        });

    } catch (error: any) {
        console.error('[EnergyRequest] Gift Energy Error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
    }
}
