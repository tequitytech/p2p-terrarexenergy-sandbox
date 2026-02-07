import crypto from "crypto";

import axios from "axios";
import dotenv from "dotenv";

import { buildDiscoverRequest } from '../bidding/services/market-analyzer';

import type { SourceType } from '../types';

dotenv.config();

const BAP_ID = process.env.BAP_ID;
const BAP_URI = process.env.BAP_URI;

export interface TransactionResult {
  success: boolean;
  transactionId: string;
  orderId?: string;
  status: string;
  amount: number;
  message?: any; // For returning init response details if needed
}


const createContext = (
  action: string,
  transactionId: string,
  {
    bppId,
    bppUri,
    location,
    schema_context,
  }: {
    bppId?: string;
    bppUri?: string;
    location?: {
      city: {
        code: string;
        name: string;
      };
      country: {
        code: string;
        name: string;
      };
    };
    schema_context?: string[];
  } = {},
) => {
  return {
    version: "2.0.0",
    action: action,
    message_id: crypto.randomUUID(),
    bap_id: BAP_ID || "p2p.terrarexenergy.com",
    bap_uri: BAP_URI || "https://p2p.terrarexenergy.com/bap/receiver",
    bpp_id: bppId || "p2p.terrarexenergy.com",
    bpp_uri: bppUri || "https://p2p.terrarexenergy.com/bpp/receiver",
    ttl: "PT30S",
    domain: process.env.DOMAIN || "beckn.one:deg:p2p-trading-interdiscom:2.0.0",
    timestamp: new Date().toISOString(),
    transaction_id: transactionId,
    location,
    schema_context,
  };
};

export async function executeDirectTransaction(
  buyerId: string,
  sellerId: string,
  quantity: number,
  pricePerUnit: number,
  authToken: string,
  beneficiaryId?: string,
  autoConfirm: boolean = true
): Promise<TransactionResult> {
  const BASE_URI = BAP_URI ? new URL(BAP_URI).origin : "https://p2p.terrarexenergy.com";
  // const PORT = process.env.PORT || 3000;
  // const BASE_URI = `http://localhost:${PORT}`;

  const isDonation = pricePerUnit === 0;
  const typeLabel = isDonation ? "Donation" : "Direct Trade";

  console.log(
    `[TransactionService] Processing ${typeLabel} flow. Buyer: ${buyerId}, Seller: ${sellerId}, Qty: ${quantity}, Price: ${pricePerUnit}`,
  );

  // 1. ALWAYS Publish New Catalog Integration
  // 1. Publish using the simplified /api/publish endpoint
  const deliveryDate = new Date().toISOString().split('T')[0];
  const startHour = new Date().getHours() + 1 > 23 ? 0 : new Date().getHours() + 1;

  const effectivePrice = pricePerUnit === 0 ? 0.01 : pricePerUnit;

  const publishBody = {
      quantity: quantity,
      price: effectivePrice,
      deliveryDate: deliveryDate,
      startHour: startHour,
      duration: 1,
      sourceType: "SOLAR"
  };

  console.log(`[TransactionService] calling simplified publish:`, JSON.stringify(publishBody));

  let pubData;
  try {
    const pubRes = await axios.post(`${BASE_URI}/api/publish`, publishBody, { headers: { Authorization: authToken } });
    pubData = pubRes.data;
  } catch (err: any) {
    console.error("[TransactionService] Publish Failed:", JSON.stringify(err.response?.data || err.message, null, 2));
    throw err;
  }

  const { item_id: itemId, offer_id: offerId, catalog_id: _catalogId, prosumer } = pubData;
  console.log(`[TransactionService] Published. Item: ${itemId}, Offer: ${offerId}`);

  const offerData = {
      "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
      "@type": "beckn:Offer",
      "beckn:id": offerId,
      "beckn:descriptor": {
          "@type": "beckn:Descriptor",
          "schema:name": "Solar Energy Offer"
      },
      "beckn:provider": sellerId,
      "beckn:items": [itemId],
      "beckn:price": {
          "schema:price": effectivePrice,
          "schema:priceCurrency": "INR"
      }
  };

  const transactionId = crypto.randomUUID();

  // 2. SELECT
  const contextSelect = createContext("select", transactionId);

  const selectPayload = {
    context: contextSelect,
    message: {
      order: {
        "@context":
          "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
        "@type": "beckn:Order",
        "beckn:orderStatus": "CREATED",
        "beckn:seller": sellerId,
        "beckn:buyer": {
          "beckn:id": buyerId,
          "@context":
            "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Buyer",
          "beckn:buyerAttributes": {
             "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld",
             "@type": "EnergyCustomer",
             "meterId": `MTR-${buyerId}`,
             "utilityCustomerId": `CUST-${buyerId}`,
             "utilityId": "DISCOM-1" 
          }
        },
        "beckn:orderAttributes": {
          "@context":
            "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld",
          "@type": "EnergyTradeOrder",
          bap_id: contextSelect.bap_id,
          bpp_id: contextSelect.bpp_id,
          total_quantity: {
             unitQuantity: quantity,
             unitText: "kWh"
          }
        },
        "beckn:orderItems": [
          {
            "beckn:orderedItem": itemId,
            "beckn:acceptedOffer": offerData,
            "beckn:orderItemAttributes": {
              "@context":
                "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld",
              "@type": "EnergyOrderItem",
              providerAttributes: {
                "@context":
                  "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld",
                "@type": "EnergyCustomer",
                meterId: prosumer?.meterId || "MTR-UNKNOWN",
                utilityCustomerId: "UTIL-CUST-77777",
                utilityId: "DISCOM-2",
              },
            },
            "beckn:quantity": {
              unitQuantity: quantity,
              unitText: "kWh",
            },
          },
        ],
      },
    },
  };

  console.log(`[TransactionService] Calling Select...`);
  let selectResponse;
  try {
      const selectRes = await axios.post(`${BASE_URI}/api/select`, selectPayload);
      selectResponse = selectRes.data;
  } catch (err: any) {
      console.error("[TransactionService] Select Failed:", JSON.stringify(err.response?.data || err.message, null, 2));
      throw err;
  }

  // Calculate amount
  const amountValue = pricePerUnit * quantity;

  console.log(`[TransactionService] Calling Init with amount ${amountValue}`);

  // 3. INIT
  const contextInit = createContext("init", transactionId);
  const initPayload = {
    context: contextInit,
    message: {
      ...selectResponse.message, // carry over order object
      "beckn:payment": {
        "@context":
          "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
        "@type": "beckn:Payment",
        "beckn:id": crypto.randomUUID(),
        "beckn:amount": {
          currency: "INR",
          value: amountValue,
        },
        "beckn:beneficiary": "Tequity",
        "beckn:paymentStatus": "INITIATED",
        "beckn:paymentAttributes": {
          "@context":
            "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/PaymentSettlement/v1/context.jsonld",
          "@type": "PaymentSettlement",
          settlementAccounts: [
            {
              beneficiaryId: contextInit.bap_id,
              accountHolderName: "Energy Consumer BAP Pvt Ltd",
              accountNumber: "1234567890",
              ifscCode: "HDFC0001234",
              bankName: "HDFC Bank",
              vpa: "energy-consumer@upi",
            },
          ],
        },
      },
    },
  };

  console.log(`[TransactionService] Calling Init...`);
  let initResponse;
  try {
    const initRes = await axios.post(`${BASE_URI}/api/init`, initPayload);
    initResponse = initRes.data;
  } catch (err: any) {
    console.error("[TransactionService] Init Failed:", JSON.stringify(err.response?.data || err.message, null, 2));
    throw err;
    throw err;
  }

  // 3b. Stop here if autoConfirm is false (e.g., Gift flow needing payment)
  if (!autoConfirm) {
    console.log(`[TransactionService] Auto-confirm disabled, returning after Init.`);
    return {
        success: true,
        transactionId,
        orderId: initResponse.message?.order?.["beckn:id"],
        status: "INITIATED",
        amount: amountValue,
        message: initResponse.message // Return full message for payment processing
    };
  }

  // 4. CONFIRM
  const contextConfirm = createContext("confirm", transactionId);
  const confirmPayload = {
    context: contextConfirm,
    message: initResponse.message,
  };

  console.log(`[TransactionService] Calling Confirm...`);
  let confirmResponse;
  try {
      const confirmRes = await axios.post(`${BASE_URI}/api/confirm`, confirmPayload);
      confirmResponse = confirmRes.data;
  } catch (err: any) {
      console.error("[TransactionService] Confirm Failed:", JSON.stringify(err.response?.data || err.message, null, 2));
      throw err;
  }

  return {
    success: true,
    transactionId,
    orderId: confirmResponse.message?.order?.["beckn:id"], 
    status: "CONFIRMED",
    amount: amountValue,
  };
}

// Helper to find best seller
export async function discoverBestSeller(quantity: number, authToken?: string) {
    // 1. Discover Best Seller via BAP
    // Use buildDiscoverRequest to ensure consistent logic
    const discoverPayload = buildDiscoverRequest({
        isActive: true, // Only active items
        sourceType: "SOLAR" as SourceType
    });

    const discoverUrl = `https://p2p.terrarexenergy.com/bap/caller/discover`;
    console.log(`[TransactionService] Finding best seller via ${discoverUrl}`);

    try {
        const response = await axios.post(discoverUrl, discoverPayload, {
            headers: { 
                "Content-Type": "application/json",
                ...(authToken ? { "Authorization": authToken } : {})
            },
            timeout: 15000
        });

        const data = response.data;
        const catalogs = data?.message?.catalogs || [];

        if (catalogs.length === 0) {
             console.log("[TransactionService] No catalogs found");
             return null;
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
            console.log("[TransactionService] No offers found");
            return null;
        }

        // Sort by Price (Ascending)
        allOffers.sort((a: any, b: any) => {
            const priceA = Number(a["beckn:price"]?.["schema:price"] || a["beckn:offerAttributes"]?.["beckn:price"]?.value || Number.MAX_VALUE);
            const priceB = Number(b["beckn:price"]?.["schema:price"] || b["beckn:offerAttributes"]?.["beckn:price"]?.value || Number.MAX_VALUE);
            return priceA - priceB;
        });

        const bestOffer = allOffers[0];
        
        const sellerId = bestOffer._catalog?.["beckn:provider"]?.id || bestOffer._catalog?.["beckn:bppId"];
        const price = Number(bestOffer["beckn:price"]?.["schema:price"] || bestOffer["beckn:offerAttributes"]?.["beckn:price"]?.value || 0);

        return {
            sellerId,
            price,
            offer: bestOffer
        };

    } catch (error) {
        console.error("[TransactionService] Discovery Failed:", error);
        return null;
    }
}
