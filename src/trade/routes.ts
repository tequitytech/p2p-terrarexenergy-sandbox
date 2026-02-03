import axios, { isAxiosError } from "axios";
import dotenv from "dotenv";
import { Request, Response, Router } from "express";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { ObjectId } from "mongodb";
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
import {
  BECKN_CONTEXT_ROOT,
  ENERGY_TRADE_SCHEMA_CTX,
} from "../constants/schemas";
dotenv.config();

const ONIX_BPP_URL = process.env.ONIX_BPP_URL || "http://onix-bpp:8082";
const EXCESS_DATA_PATH =
  process.env.EXCESS_DATA_PATH || "data/excess_predicted_hourly.json";
const BAP_ID = process.env.BAP_ID || "p2p.terrarexenergy.com";
const BAP_URI =
  process.env.BAP_URI || "https://p2p.terrarexenergy.com/bap/receiver";
const BPP_ID = process.env.BPP_ID || "p2p.terrarexenergy.com";
const BPP_URI =
  process.env.BPP_URI || "https://p2p.terrarexenergy.com/bpp/receiver";
const BECKN_DOMAIN =
  process.env.BECKN_DOMAIN || "beckn.one:deg:p2p-trading-interdiscom:2.0.0";

// ============================================
// Publish Input Schema & Helpers
// ============================================

const publishInputSchema = z.object({
  quantity: z.number().positive().max(1000), // kWh
  price: z.number().positive().max(100), // INR/kWh
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startHour: z.number().int().min(0).max(23).default(10),
  duration: z.number().int().min(1).max(12).default(1),
  sourceType: z.enum(["SOLAR", "WIND", "HYDRO"]).default("SOLAR"),
});

type PublishInput = z.infer<typeof publishInputSchema>;

interface ProsumerDetails {
  fullName: string;
  meterId: string;
  utilityId: string;
  consumerNumber: string;
  providerId: string;
}

export interface BuyerDetails {
  buyerId: string;        // did from profile
  fullName: string;       // user.name
  meterId: string;        // from utilityCustomer or consumptionProfile
  utilityCustomerId: string;
  utilityId: string;
}

function extractProsumerDetails(user: any): ProsumerDetails {
  const generationProfile = user.profiles?.generationProfile;

  if (!generationProfile) {
    throw new Error("User does not have a verified generationProfile");
  }

  const fullName = user.name;
  if (!fullName) {
    throw new Error("User name is required for publishing");
  }

  const meterId = generationProfile.meterNumber || user.meters?.[0];
  if (!meterId) {
    throw new Error(
      "Meter ID is required for publishing. Verify your generationProfile credential.",
    );
  }

  const utilityId = generationProfile.utilityId;
  if (!utilityId) {
    throw new Error(
      "Utility ID is required for publishing. Verify your generationProfile credential.",
    );
  }

  const consumerNumber = generationProfile.consumerNumber;
  if (!consumerNumber) {
    throw new Error(
      "Consumer number is required for publishing. Verify your generationProfile credential.",
    );
  }

  const providerId = generationProfile.did;
  if (!providerId) {
    throw new Error(
      "Provider DID is required for publishing. Verify your generationProfile credential.",
    );
  }

  return {
    fullName,
    meterId,
    utilityId,
    consumerNumber,
    providerId,
  };
}

/**
 * Extract buyer details from user profile (for select requests).
 * Tries utilityCustomer profile first, then consumptionProfile.
 */
export async function extractBuyerDetails(userId: ObjectId): Promise<BuyerDetails> {
  const db = getDB();
  const user = await db.collection('users').findOne({ _id: userId });

  if (!user) {
    throw new Error('User not found');
  }

  // Try utilityCustomer profile first, then consumptionProfile
  const profile = user.profiles?.utilityCustomer || user.profiles?.consumptionProfile;

  if (!profile) {
    const error = new Error('No verified buyer profile found. Please verify your utility customer credential.');
    (error as any).code = 'NO_BUYER_PROFILE';
    throw error;
  }

  return {
    buyerId: profile.did || `buyer-${userId}`,
    fullName: user.name || 'Unknown',
    meterId: profile.meterNumber || user.meters?.[0] || '',
    utilityCustomerId: profile.consumerNumber || '',
    utilityId: profile.utilityId || '',
  };
}

function buildCatalog(input: PublishInput, prosumer: ProsumerDetails) {
  const now = new Date();
  const timestamp = now.getTime();
  const catalogId = `catalog-${prosumer.meterId}-${timestamp}`;
  const itemId = `item-${prosumer.meterId}-${timestamp}`;
  const offerId = `offer-${prosumer.meterId}-${timestamp}`;

  // Build time windows
  const deliveryStart = `${input.deliveryDate}T${String(input.startHour).padStart(2, "0")}:00:00.000Z`;
  const deliveryEnd = `${input.deliveryDate}T${String(input.startHour + input.duration).padStart(2, "0")}:00:00.000Z`;
  const validityStart = now.toISOString();
  const validityEnd = `${input.deliveryDate}T${String(input.startHour - 1).padStart(2, "0")}:00:00.000Z`;

  return {
    catalogId,
    itemId,
    offerId,
    catalog: {
      "@context": BECKN_CONTEXT_ROOT,
      "@type": "beckn:Catalog",
      "beckn:id": catalogId,
      "beckn:descriptor": {
        "@type": "beckn:Descriptor",
        "schema:name": `Solar Energy Trading Catalog - ${prosumer.fullName}`,
      },
      "beckn:bppId": BPP_ID,
      "beckn:bppUri": BPP_URI,
      "beckn:items": [
        {
          "@context": BECKN_CONTEXT_ROOT,
          "@type": "beckn:Item",
          "beckn:networkId": ["p2p-interdiscom-trading-pilot-network"],
          "beckn:isActive": true,
          "beckn:id": itemId,
          "beckn:descriptor": {
            "@type": "beckn:Descriptor",
            "schema:name": `Solar Energy - ${input.quantity} kWh`,
            "beckn:shortDesc": `Rooftop Solar from ${prosumer.utilityId} Prosumer`,
            "beckn:longDesc": `Clean solar energy from ${prosumer.utilityId} net-metered installation`,
          },
          "beckn:provider": {
            "beckn:id": prosumer.providerId,
            "beckn:descriptor": {
              "@type": "beckn:Descriptor",
              "schema:name": `${prosumer.fullName} - ${prosumer.utilityId} Prosumer`,
            },
            "beckn:providerAttributes": {
              "@context": ENERGY_TRADE_SCHEMA_CTX,
              "@type": "EnergyCustomer",
              meterId: prosumer.meterId,
              utilityId: prosumer.utilityId,
              utilityCustomerId: prosumer.consumerNumber,
            },
          },
          "beckn:itemAttributes": {
            "@context": ENERGY_TRADE_SCHEMA_CTX,
            "@type": "EnergyResource",
            sourceType: input.sourceType,
            meterId: prosumer.meterId,
          },
        },
      ],
      "beckn:offers": [
        {
          "@context": BECKN_CONTEXT_ROOT,
          "@type": "beckn:Offer",
          "beckn:id": offerId,
          "beckn:descriptor": {
            "@type": "beckn:Descriptor",
            "schema:name": `Solar Energy Offer - ${input.startHour}:00-${input.startHour + input.duration}:00`,
          },
          "beckn:provider": prosumer.providerId,
          "beckn:items": [itemId],
          "beckn:price": {
            "@type": "schema:PriceSpecification",
            "schema:price": input.price,
            "schema:priceCurrency": "INR",
            unitText: "kWh",
            applicableQuantity: {
              unitQuantity: input.quantity,
              unitText: "kWh",
            },
          },
          "beckn:offerAttributes": {
            "@context": ENERGY_TRADE_SCHEMA_CTX,
            "@type": "EnergyTradeOffer",
            pricingModel: "PER_KWH",
            deliveryWindow: {
              "@type": "beckn:TimePeriod",
              "schema:startTime": deliveryStart,
              "schema:endTime": deliveryEnd,
            },
            validityWindow: {
              "@type": "beckn:TimePeriod",
              "schema:startTime": validityStart,
              "schema:endTime": validityEnd,
            },
          },
        },
      ],
    },
  };
}

function buildPublishRequest(catalog: any): {
  request: any;
  messageId: string;
  transactionId: string;
} {
  const messageId = uuidv4();
  const transactionId = uuidv4();

  return {
    messageId,
    transactionId,
    request: {
      context: {
        version: "2.0.0",
        action: "catalog_publish",
        timestamp: new Date().toISOString(),
        message_id: messageId,
        transaction_id: transactionId,
        bap_id: BAP_ID,
        bap_uri: BAP_URI,
        bpp_id: BPP_ID,
        bpp_uri: BPP_URI,
        ttl: "PT30S",
        domain: BECKN_DOMAIN,
      },
      message: {
        catalogs: [catalog],
      },
    },
  };
}

export const tradeRoutes = () => {
  const router = Router();

  // POST /api/publish - Accept minimal input, build catalog server-side
  router.post(
    "/publish",
    authMiddleware,
    async (req: Request, res: Response) => {
      const db = getDB();

      try {
        // 1. Validate minimal input
        const parseResult = publishInputSchema.safeParse(req.body);
        if (!parseResult.success) {
          return res.status(400).json({
            error: "VALIDATION_ERROR",
            details: parseResult.error.flatten(),
          });
        }
        const input = parseResult.data;

        // 2. Get user from DB
        const userId = (req as any).user.userId;
        const user = await db
          .collection("users")
          .findOne({ _id: new ObjectId(userId) });

        if (!user) {
          return res.status(404).json({ error: "USER_NOT_FOUND" });
        }

        // 3. Verify user is a prosumer and extract details
        let prosumerDetails: ProsumerDetails;
        try {
          prosumerDetails = extractProsumerDetails(user);
        } catch (error: any) {
          // Missing generationProfile or required fields
          if (error.message.includes("generationProfile")) {
            return res.status(403).json({
              error: "NOT_PROSUMER",
              message: error.message,
            });
          }
          return res.status(400).json({
            error: "MISSING_PROFILE_DATA",
            message: error.message,
          });
        }

        console.log(
          `[API] POST /publish - User: ${prosumerDetails.fullName}, Meter: ${prosumerDetails.meterId}`,
        );

        // 4. Build spec-compliant catalog
        const { catalog, catalogId, itemId, offerId } = buildCatalog(
          input,
          prosumerDetails,
        );

        // 5. Build publish request for ONIX
        const { request, messageId, transactionId } =
          buildPublishRequest(catalog);

        // 6. Store in MongoDB (primary action)
        await catalogStore.saveCatalog(catalog, userId);

        for (const item of catalog["beckn:items"] || []) {
          await catalogStore.saveItem(catalogId, item, userId);
        }

        for (const offer of catalog["beckn:offers"] || []) {
          await catalogStore.saveOffer(catalogId, offer);
        }

        // 7. Forward to ONIX BPP (secondary action - don't fail if this fails)
        const forwardUrl = `${ONIX_BPP_URL}/bpp/caller/publish`;
        console.log(`[API] Forwarding to ${forwardUrl}`);

        let onixResponse = null;
        let onixError = null;

        try {
          const onixRes = await axios.post(forwardUrl, request, {
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

        // 8. Store publish record for audit trail
        await db.collection("publish_records").insertOne({
          message_id: messageId,
          transaction_id: transactionId,
          catalog_id: catalogId,
          item_id: itemId,
          offer_id: offerId,
          userId,
          input,
          onix_request: request,
          onix_forwarded: onixError === null,
          onix_response: onixResponse,
          onix_error: onixError,
          createdAt: new Date(),
        });

        return res.status(200).json({
          success: true,
          message_id: messageId,
          transaction_id: transactionId,
          catalog_id: catalogId,
          item_id: itemId,
          offer_id: offerId,
          prosumer: {
            name: prosumerDetails.fullName,
            meterId: prosumerDetails.meterId,
            utilityId: prosumerDetails.utilityId,
          },
          onix_forwarded: onixError === null,
          onix_response: onixResponse,
        });
      } catch (error: any) {
        console.error(`[API] Error:`, error.message);
        return res.status(500).json({
        success: false,
        error: isAxiosError(error) ? error.response?.data : error.message,
      });
      }
    },
  );

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

    // GET /api/published-items/ - List user's published items
  router.get(
    "/published-items",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const userDetails = (req as any).user;
        console.log("User Details:", userDetails);
        if (!userDetails) {
          return res
            .status(401)
            .json({ success: false, error: "Unauthorized" });
        }

        // Fetch orders for this user using the authenticated user's ID
        const getPublishedItems = await catalogStore.getPublishedItems(
          userDetails.userId
        );

        res.json({
          success: true,
          data: getPublishedItems,
        });
      } catch (error: any) {
        console.error("[API] Error fetching published items:", error);
        res.status(500).json({
          success: false,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to list published items",
            details: error.message,
          },
        });
      }
    },
  );

  return router;
};
