import axios, { isAxiosError } from "axios";
import dotenv from "dotenv";
import { Request, Response, Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { catalogStore } from "../services/catalog-store";
import { ledgerClient } from "../services/ledger-client";
import {
  getPollingStatus,
  pollOnce,
  refreshSettlement,
} from "../services/settlement-poller";
import {
  SettlementStatus,
  settlementStore,
} from "../services/settlement-store";
import { parseError } from "../utils";
import { startOfToday } from "date-fns";
import z from "zod";
import { getDB } from "../db";
import { authMiddleware } from "../auth/routes";
dotenv.config();

const ONIX_BPP_URL = process.env.ONIX_BPP_URL || "http://onix-bpp:8082";
const EXCESS_DATA_PATH =
  process.env.EXCESS_DATA_PATH || "data/excess_predicted_hourly.json";
const BAP_ID = process.env.BAP_ID;
const BAP_URI = process.env.BAP_URI;
const BPP_ID = process.env.BPP_ID;
const BPP_URI = process.env.BPP_URI;

export const tradeRoutes = () => {
  const router = Router();

  // POST /api/publish - Store catalog and forward to ONIX
  router.post("/publish", authMiddleware, async (req: Request, res: Response) => {
    try {
      const catalog = req.body.message?.catalogs?.[0];
      if (!catalog) {
        return res.status(400).json({ error: "No catalog in request" });
      }
        const userDetails = (req as any).user; // From authMiddleware


      console.log(`[API] POST /publish - Catalog: ${catalog["beckn:id"]}`);

        // Store in MongoDB (primary action)
        const catalogId = await catalogStore.saveCatalog(catalog, userDetails.userId);

      for (const item of catalog["beckn:items"] || []) {
        await catalogStore.saveItem(catalogId, item, userDetails.userId);
      }

      for (const offer of catalog["beckn:offers"] || []) {
        await catalogStore.saveOffer(catalogId, offer);
      }

      // Forward to ONIX BPP (secondary action - don't fail if this fails)
      const forwardUrl = `${ONIX_BPP_URL}/bpp/caller/publish`;
      console.log(`[API] Forwarding to ${forwardUrl}`);

      let onixResponse = null;
      let onixError = null;

      try {
        const onixRes = await axios.post(forwardUrl, req.body, {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        });
        onixResponse = onixRes.data;
        console.log(`[API] ONIX forwarding successful`);
      } catch (error: any) {
        onixError = parseError(error);
        console.warn(
          `[API] ONIX forwarding failed (catalog saved locally): ${error.message}`,
        );
      }

      return res.status(200).json({
        success: true,
        catalog_id: catalogId,
        onix_forwarded: onixError === null,
        onix_error: onixError,
        onix_response: onixResponse,
      });
    } catch (error: any) {
      console.error(`[API] Error:`, error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /api/inventory
  router.get("/inventory", async (req: Request, res: Response) => {
    const items = await catalogStore.getInventory();
    res.json({ items });
  });

  // GET /api/items
  router.get("/items", async (req: Request, res: Response) => {
    const items = await catalogStore.getAllItems();
    res.json({ items });
  });

  // GET /api/offers
  router.get("/offers", async (req: Request, res: Response) => {
    const offers = await catalogStore.getAllOffers();
    res.json({ offers });
  });

  // GET /api/forecast - Return excess predicted hourly data
  router.get("/forecast", async (req: Request, res: Response) => {
    try {
      const filePath = path.resolve(EXCESS_DATA_PATH);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: "Forecast data not found",
          path: filePath,
        });
      }

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      res.json(data);
    } catch (error: any) {
      console.error(`[API] Error reading forecast:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // Settlement Tracking API
  // ============================================

  // GET /api/settlements - List all settlements
  router.get("/settlements", async (req: Request, res: Response) => {
    try {
      const status = req.query.status as SettlementStatus | undefined;
      const settlements = await settlementStore.getSettlements(status);
      const stats = await settlementStore.getStats();

      res.json({
        settlements,
        stats,
        polling: getPollingStatus(),
      });
    } catch (error: any) {
      console.error(`[API] Error listing settlements:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/settlements/stats - Get settlement statistics
  router.get("/settlements/stats", async (req: Request, res: Response) => {
    try {
      const stats = await settlementStore.getStats();
      const polling = getPollingStatus();
      const ledgerHealth = await ledgerClient.getLedgerHealth();

      res.json({
        stats,
        polling,
        ledger: {
          url: ledgerClient.LEDGER_URL,
          ...ledgerHealth,
        },
      });
    } catch (error: any) {
      console.error(`[API] Error getting settlement stats:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/settlements/:transactionId - Get specific settlement
  router.get(
    "/settlements/:transactionId",
    async (req: Request, res: Response) => {
      try {
        const transactionId = req.params.transactionId as string;
        const settlement = await settlementStore.getSettlement(transactionId);

        if (!settlement) {
          return res.status(404).json({
            error: "Settlement not found",
            transactionId,
          });
        }

        res.json({ settlement });
      } catch (error: any) {
        console.error(`[API] Error getting settlement:`, error.message);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // POST /api/settlements/poll - Manually trigger a polling cycle
  router.post("/settlements/poll", async (req: Request, res: Response) => {
    try {
      console.log(`[API] Manual poll triggered`);
      const result = await pollOnce();
      res.json({
        success: true,
        result,
      });
    } catch (error: any) {
      console.error(`[API] Error during manual poll:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/settlements/:transactionId/refresh - Force refresh from ledger
  router.post(
    "/settlements/:transactionId/refresh",
    async (req: Request, res: Response) => {
      try {
        const transactionId = req.params.transactionId as string;
        console.log(`[API] Force refresh: ${transactionId}`);

        const settlement = await refreshSettlement(transactionId);

        if (!settlement) {
          return res.status(404).json({
            error: "Settlement not found or no ledger data available",
            transactionId,
          });
        }

        res.json({
          success: true,
          settlement,
        });
      } catch (error: any) {
        console.error(`[API] Error refreshing settlement:`, error.message);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // GET /api/earnings - Get total earnings for a seller today
  router.get("/earnings", async (req: Request, res: Response) => {
    try {
      const sellerId = req.query.sellerId as string;
      if (!sellerId) {
        return res
          .status(400)
          .json({ error: "Missing sellerId query parameter" });
      }

      console.log(`[API] GET /earnings for seller: ${sellerId}`);

      const earnings = await catalogStore.getSellerEarnings(
        sellerId,
        startOfToday(),
      );

      res.json({
        sellerId,
        earnings,
        currency: "INR",
        period: "today",
      });
    } catch (error: any) {
      console.error(`[API] Error getting earnings:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/donate", async (req: Request, res: Response) => {
    const { buyerId, sellerId, quantity } = z
      .object({
        buyerId: z.string(),
        sellerId: z.string(),
        quantity: z.number(),
      })
      .parse(req.body);

      const BASE_URI = new URL(BAP_URI!).origin;

      const db = getDB();
      const user = await db.collection("users").findOne({
        'profiles.consumptionProfile.id': buyerId
      })
      
      try {
        if(!user?.socialImpactVerified) {
          return res.status(400).json({
            success: false,
            message: "Invalid donation account"
          })
        }

      console.log(
        `[API] Automating donation flow for buyer ${buyerId} -> seller ${sellerId}`,
      );

      // 1. ALWAYS Publish New Catalog Integration
      const catalogId = crypto.randomUUID();
      const itemId = crypto.randomUUID();
      const offerId = crypto.randomUUID();

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
             "unitText": "kWh"
          }
        }
      };

      // Create Publish Payload
      const publishPayload = {
        context: {
          domain: process.env.DOMAIN,
          action: "catalog_publish",
          version: process.env.VERSION,
          bap_id: BAP_ID,
          bap_uri: BAP_URI,
          bpp_id: BPP_ID,
          bpp_uri: BPP_URI,
          transaction_id: crypto.randomUUID(),
          message_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ttl: "PT30S",
        },
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
              "beckn:bppId": BPP_ID,
              "beckn:bppUri": BPP_URI,
              "beckn:items": [itemData],
              "beckn:offers": [offerData]
            }
          ]
        }
      };

      // Call Publish API
      await axios.post(`${BASE_URI}/api/publish`, publishPayload);
      console.log(`[Donate] Catalog published. ID: ${catalogId}`);

      const transactionId = crypto.randomUUID();

      // 2. SELECT
      const contextSelect = {
        domain: process.env.DOMAIN,
        action: "select",
        version: process.env.VERSION,
        bap_id: BAP_ID,
        bap_uri: BAP_URI,
        bpp_id: BPP_ID,
        bpp_uri: BPP_URI,
        transaction_id: transactionId,
        message_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ttl: "PT30S",
      };

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

      console.log(`[Donate] Calling Select...`);
      const selectRes = await axios.post(`${BASE_URI}/api/select`, selectPayload);
      const selectResponse = selectRes.data;

      const price = offerData["beckn:price"]["schema:price"];
      const amountValue = price * quantity;

      console.log(`[Donate] Calling Init with amount ${amountValue}`);

      // 3. INIT
      const contextInit = {
        ...contextSelect,
        action: "init",
        message_id: crypto.randomUUID(),
      };
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

      console.log(`[Donate] Calling Init...`);
      const initRes = await axios.post(`${BASE_URI}/api/init`, initPayload);
      const initResponse = initRes.data;

      // 4. CONFIRM
      const contextConfirm = {
        ...contextInit,
        action: "confirm",
        message_id: crypto.randomUUID(),
      };
      const confirmPayload = {
        context: contextConfirm,
        message: initResponse.message,
      };

      console.log(`[Donate] Calling Confirm...`);
      const confirmRes = await axios.post(`${BASE_URI}/api/confirm`, confirmPayload);
      const confirmResponse = confirmRes.data;

      res.json({
        success: true,
        transactionId,
        orderId: confirmResponse.message?.order?.["beckn:id"], // Assuming BPP generates one or we passed it? Created orders usually get ID assigned.
        status: "CONFIRMED",
        amount: amountValue,
      });
    } catch (e: any) {
      console.error("[API] Error donating:", e.message);
      if (isAxiosError(e)) {
        console.error("Axios error details:", JSON.stringify(e.response?.data, null , 2));
      }
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
