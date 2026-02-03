import { Request, Response } from 'express';
import { getDB } from '../db';
import { EnergyRequest, CreateEnergyRequestDTO } from './types';
import { ObjectId } from 'mongodb';
import { buildDiscoverRequest } from '../bidding/services/market-analyzer';
import axios from 'axios';

const ONIX_BAP_URL = process.env.ONIX_BAP_URL || "http://onix-bap:8081";

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

    // 2. Discover Best Seller via BAP
    // Use buildDiscoverRequest to ensure consistent logic with Discover API (active items etc)
    const discoverPayload = buildDiscoverRequest({
        isActive: true, // Only active items
        sourceType: SourceType.SOLAR
        // startDate: request.startTime ? new Date(request.startTime) : undefined,
        // endDate: request.endTime ? new Date(request.endTime) : undefined
    });

    const discoverUrl = `https://p2p.terrarexenergy.com/bap/caller/discover`;
    console.log(`[EnergyRequest] Finding best seller via ${discoverUrl}`);

    const response = await axios.post(discoverUrl, discoverPayload, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
    });

    const data = response.data;
    const catalogs = data?.message?.catalogs || [];

    if (catalogs.length === 0) {
         return res.status(404).json({ success: false, message: 'No suitable seller found' });
    }

    // Flatten offers and sort by price
    const allOffers: any[] = [];
    catalogs.forEach((catalog: any) => {
        if(catalog["beckn:offers"]) {
            catalog["beckn:offers"].forEach((offer: any) => {
                 // Attach catalog info for context
                 offer._catalog = {
                    "beckn:descriptor": catalog["beckn:descriptor"],
                    "beckn:provider": catalog["beckn:provider"],
                    "beckn:bppId": catalog["beckn:bppId"],
                    "items": catalog["beckn:items"]
                 };
                 allOffers.push(offer);
            });
        }
    });

    if (allOffers.length === 0) {
        return res.status(404).json({ success: false, message: 'No suitable offers found in catalogs' });
    }

    // Sort by Price (Ascending)
    allOffers.sort((a: any, b: any) => {
        const priceA = Number(a["beckn:price"]?.["schema:price"] || a["beckn:offerAttributes"]?.["beckn:price"]?.value || Number.MAX_VALUE);
        const priceB = Number(b["beckn:price"]?.["schema:price"] || b["beckn:offerAttributes"]?.["beckn:price"]?.value || Number.MAX_VALUE);
        return priceA - priceB;
    });

    const bestOffer = allOffers[0];

    // Find matching item logic
    let matchedItem = null;
    if (bestOffer["beckn:items"] && bestOffer["beckn:items"].length > 0) {
        const itemId = bestOffer["beckn:items"][0];
        if (bestOffer._catalog.items) {
             matchedItem = bestOffer._catalog.items.find((i: any) => i["beckn:id"] === itemId);
        }
    } else if (bestOffer._catalog.items && bestOffer._catalog.items.length > 0) {
        // Fallback: take the first item if offer doesn't specify
        matchedItem = bestOffer._catalog.items[0];
    }

    // Remove temporary field to keep response clean
    const { _catalog, ...cleanOffer } = bestOffer;


    return res.status(200).json({
        success: true,
        bestSeller: {
            ...cleanOffer,
            providerId: _catalog?.["beckn:provider"]?.id || _catalog?.["beckn:bppId"],
            item: matchedItem
        }
    });

  } catch (error: any) {
    console.error('[EnergyRequest] Find Seller Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
}

import { executeDirectTransaction, discoverBestSeller } from './service';
import z from 'zod';
import { SourceType } from '../types';

/**
 * giftEnergy
 * POST /api/gift
 */
export async function giftEnergy(req: Request, res: Response) {
    try {
        const user = (req as any).user;
        if (!user) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { requestId } = req.body;
        
        if (!requestId) {
             return res.status(400).json({ success: false, error: 'Missing requestId' });
        }

        const db = getDB();
        
        // 1. Get Gifter (Buyer) ID
        const gifterProfile = await db.collection("users").findOne({ phone: user.phone });
        // Use available ID or fallback to user ID string
        const gifterId = gifterProfile?.profiles?.consumptionProfile?.id || user.userId || "unknown-gifter";

        // 2. Get Request Details
        const request = await db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(requestId) });
        if (!request) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }
        
        if (request.status === 'FULFILLED') {
            return res.status(400).json({ success: false, error: 'Request already fulfilled' });
        }

        const beneficiaryId = request.userId.toString();

        // 3. Find Best Seller (Dynamic Discovery)
        const sellerInfo = await discoverBestSeller(request.requiredEnergy, req.headers.authorization);

        if (!sellerInfo || !sellerInfo.sellerId) {
             return res.status(404).json({ success: false, error: 'No suitable energy seller found' });
        }

        const { sellerId, price } = sellerInfo;
        console.log(`[EnergyRequest] Gift matched with seller ${sellerId} at price ${price}`);

        // 4. Perform Transaction
        // Buyer = Gifter, Seller = Provider, Beneficiary = Requester
        const transaction = await executeDirectTransaction(
            gifterId, 
            sellerId, 
            request.requiredEnergy, 
            Number(price),
            req.headers.authorization!,
            beneficiaryId,
            false // autoConfirm = false for Gift (wait for payment)
        );

        // 4. Update Request Status
        const updateResult = await db.collection(COLLECTION_NAME).updateOne(
            { _id: new ObjectId(requestId) },
            { 
                $set: { 
                    status: 'PAYMENT_PENDING', 
                    fulfilledBy: sellerId,
                    giftedBy: gifterId,
                    transactionId: transaction.transactionId,
                    updatedAt: new Date()
                } 
            }
        );

        return res.status(200).json({
            success: true, 
            message: 'Energy gift initiated. Proceed to payment.',
            requestId,
            sellerId,
            gifterId,
            transactionId: transaction.transactionId,
            orderId: transaction.orderId,
            status: transaction.status,
            amount: transaction.amount,
            paymentDetails: transaction.message?.order?.["beckn:payment"] || transaction.message?.["beckn:payment"] // Return payment details for FE
        });

    } catch (error: any) {
        console.error('[EnergyRequest] Gift Energy Error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
    }
}

/**
 * donateEnergy
 * POST /api/donate
 */
export async function donateEnergy(req: Request, res: Response) {
    try {
        const user = (req as any).user;
        if (!user) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

         const { requestId } = z
              .object({
                requestId: z.string(),
              })
              .parse(req.body);

        const db = getDB();
        
        // 1. Get Seller (Authenticated User) ID
        // Assuming seller ID is in profiles.consumptionProfile.id or similar.
        // We need to fetch the full user profile since authMiddleware might only attach basic info.
        const sellerProfile = await db.collection("users").findOne({ phone: user.phone });
        if (!sellerProfile) {
             return res.status(404).json({ success: false, error: 'Seller profile not found' });
        }

        // Ideally, we'd use a dedicated 'sellerProfile.id' or 'generationProfile.id' if they are a prosumer.
        // For now, let's look for a valid Beckn ID in their profiles.
        const sellerId = sellerProfile.profiles?.generationProfile?.id || 
                         sellerProfile.profiles?.consumptionProfile?.id || 
                         sellerProfile.profiles?.utilityCustomer?.did;

        if (!sellerId) {
             return res.status(400).json({ success: false, error: 'User does not have a valid seller/provider ID configured' });
        }

        // 2. Get Request Details & Verify Buyer (Beneficiary)
        const request = await db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(requestId) });
        if (!request) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }
        
        // Check if request is already fulfilled?
        // if (request.status === 'FULFILLED') {
        //    return res.status(400).json({ success: false, error: 'Request already fulfilled' });
        // }

        const buyerId = request.userId.toString();
        // Use verified logic if needed
        const quantity = request.requiredEnergy;

        // Seller donates to Buyer (Beneficiary). Price = 0.
        const transaction = await executeDirectTransaction(
            buyerId, 
            sellerId, 
            quantity, 
            0, // Price is 0 for donation
            req.headers.authorization!,
            buyerId // Beneficiary is the buyer
        );

        // 3. Update Request Status
        await db.collection(COLLECTION_NAME).updateOne(
            { _id: new ObjectId(requestId) },
            { 
                $set: { 
                    status: 'FULFILLED', 
                    fulfilledBy: sellerId,
                    transactionId: transaction.transactionId,
                    updatedAt: new Date()
                } 
            }
        );

        return res.status(200).json({
            success: true,
            transactionId: transaction.transactionId,
            orderId: transaction.transactionId,
            status: transaction.status,
            amount: transaction.amount,
            requestId
        });

    } catch (error: any) {
        console.error('[EnergyRequest] Donate Energy Error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
    }
}
