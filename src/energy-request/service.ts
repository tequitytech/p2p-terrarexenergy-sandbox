import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const BAP_ID = process.env.BAP_ID;
const BAP_URI = process.env.BAP_URI;
const BPP_ID = process.env.BPP_ID;
const BPP_URI = process.env.BPP_URI;

export interface TransactionResult {
  success: boolean;
  transactionId: string;
  orderId?: string;
  status: string;
  amount: number;
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

export async function processDonationTransaction(
  buyerId: string,
  sellerId: string,
  quantity: number,
  authToken: string
): Promise<TransactionResult> {
  const BASE_URI = BAP_URI ? new URL(BAP_URI!).origin : "https://p2p.terrarexenergy.com";

  console.log(
    `[TransactionService] Processing donation flow for buyer ${buyerId} -> seller ${sellerId}`,
  );

  // 1. ALWAYS Publish New Catalog Integration
  const catalogId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const offerId = crypto.randomUUID();

  // Create Context for Publish
  const publishContext = createContext("catalog_publish", crypto.randomUUID());

  const itemData = {
    "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
    "@type": "beckn:Item",
    "beckn:id": itemId,
    "beckn:networkId": ["p2p-interdiscom-trading-pilot-network"],
    "beckn:isActive": true,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": "Solar Energy",
      "beckn:shortDesc": "Auto-generated item for donation"
    },
    "beckn:provider": {
      "beckn:id": sellerId,
      "beckn:descriptor": {
        "@type": "beckn:Descriptor",
        "schema:name": "Solar Farm"
      }
    },
    "beckn:itemAttributes": {
      "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyResource/v0.2/context.jsonld",
      "@type": "EnergyResource",
      "sourceType": "SOLAR",
      "meterId": "MTR-AUTO-" + sellerId.split("-").pop(),
      "availableQuantity": quantity,
      "productionWindow": [
        {
          "@type": "beckn:TimePeriod",
          "schema:startTime": new Date().toISOString(),
          "schema:endTime": new Date(
             Date.now() + 60 * 60 * 1000,
          ).toISOString(), // 1 hour
        },
      ],
      "productionAsynchronous": true
    }
  };

  const offerData = {
    "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
    "@type": "beckn:Offer",
    "beckn:id": offerId,
    "beckn:descriptor": {
       "@type": "beckn:Descriptor",
       "schema:name": "Standard Offer"
    },
    "beckn:provider": sellerId,
    "beckn:items": [itemId],
    "beckn:price": {
      "@type": "schema:PriceSpecification",
      "schema:price": 0,
      "schema:priceCurrency": "INR",
      "schema:unitText": "kWh"
    },
    "beckn:offerAttributes": {
      "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyTradeOffer/v0.2/context.jsonld",
      "@type": "EnergyTradeOffer",
      "pricingModel": "PER_KWH",
      "beckn:maxQuantity": {
         "unitQuantity": quantity,
         "unitText": "kWh",
         "unitCode": "KWH"
      },
      "validityWindow": {
          "@type": "beckn:TimePeriod",
          "schema:startTime": new Date().toISOString(),
          "schema:endTime": new Date(
            Date.now() + 60 * 60 * 1000,
          ).toISOString(), // 1 hour
       }
    }
  };

  // Create Publish Payload
  const publishPayload = {
    context: publishContext,
    message: {
      catalogs: [
        {
          "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Catalog",
          "beckn:id": catalogId,
          "beckn:descriptor": {
            "@type": "beckn:Descriptor",
            "schema:name": "Auto-Generated Solar Catalog"
          },
          "beckn:bppId": BPP_ID || "p2p.terrarexenergy.com",
          "beckn:bppUri": BPP_URI || "https://p2p.terrarexenergy.com/bpp/receiver",
          "beckn:items": [itemData],
          "beckn:offers": [offerData]
        }
      ]
    }
  };

  // Call Publish API
  await axios.post(`${BASE_URI}/api/publish`, publishPayload, {headers: {
    Authorization: authToken
  }});
  console.log(`[TransactionService] Catalog published. ID: ${catalogId}`);

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
        },
        "beckn:orderAttributes": {
          "@context":
            "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyTradeOrder/v0.2/context.jsonld",
          "@type": "EnergyTradeOrderInterUtility",
          bap_id: contextSelect.bap_id,
          bpp_id: contextSelect.bpp_id,
          total_quantity: quantity,
          utilityIdBuyer: "DISCOM-1",
          utilityIdSeller: "DISCOM-2",
        },
        "beckn:orderItems": [
          {
            "beckn:orderedItem": itemId,
            "beckn:acceptedOffer": offerData,
            "beckn:orderItemAttributes": {
              "@context":
                "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyOrderItem/v0.1/context.jsonld",
              "@type": "EnergyOrderItem",
              providerAttributes: {
                "@context":
                  "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyCustomer/v0.1/context.jsonld",
                "@type": "EnergyCustomer",
                meterId: itemData["beckn:itemAttributes"]["meterId"],
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
  const selectRes = await axios.post(`${BASE_URI}/api/select`, selectPayload);
  const selectResponse = selectRes.data;

  // Since it's a donation, price is 0, but logic remains consistent
  const price = offerData["beckn:price"]["schema:price"];
  const amountValue = price * quantity;

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
  const initRes = await axios.post(`${BASE_URI}/api/init`, initPayload);
  const initResponse = initRes.data;

  // 4. CONFIRM
  const contextConfirm = createContext("confirm", transactionId);
  const confirmPayload = {
    context: contextConfirm,
    message: initResponse.message,
  };

  console.log(`[TransactionService] Calling Confirm...`);
  const confirmRes = await axios.post(`${BASE_URI}/api/confirm`, confirmPayload);
  const confirmResponse = confirmRes.data;

  return {
    success: true,
    transactionId,
    orderId: confirmResponse.message?.order?.["beckn:id"], 
    status: "CONFIRMED",
    amount: amountValue,
  };
}
