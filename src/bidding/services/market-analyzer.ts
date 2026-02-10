import axios from "axios";
import { v4 as uuidv4 } from "uuid";

import { getDB } from "../../db";
import {
  DEFAULT_UNDERCUT_PERCENT,
  FLOOR_PRICE
} from "../types";

import type { DeliveryMode } from "../../types";
import type {
  CompetitorOffer,
  MarketAnalysis,
  MarketSnapshot} from "../types";

const UNDERCUT_PERCENT = parseFloat(
  process.env.UNDERCUT_PERCENT || String(DEFAULT_UNDERCUT_PERCENT),
);

/**
 * Build discover request for ONIX BAP
 */
export function buildDiscoverRequest({
  sourceType,
  deliveryMode,
  itemId,
  isActive,
}: {
  sourceType?: string;
  deliveryMode?: DeliveryMode;
  sortBy?: string;
  order?: string;
  itemId?: string;
  isActive?: boolean;
}) {
  const conditions = [];

  // Network Id - checking inside items
  conditions.push(
    `@.beckn:items[*].beckn:networkId[*] == 'p2p-interdiscom-trading-pilot-network'`,
  );

  // 1. Delivery Mode - checking inside item attributes
  if (deliveryMode) {
    conditions.push(
      `@.beckn:items[*].beckn:itemAttributes.deliveryMode == '${deliveryMode}'`,
    );
  }

  // 2. Source Type - checking inside item attributes
  if (sourceType) {
    conditions.push(
      `@.beckn:items[*].beckn:itemAttributes.sourceType == '${sourceType}'`,
    );
  }

  // 7. Active Status - checking inside items (or catalog if applicable, assuming items based on precedent)
  if (isActive !== undefined) {
    conditions.push(`@.beckn:items[*].beckn:isActive == ${isActive}`);
  }

  // 8. Item Id - checking inside items (path check)
  if (itemId) {
    conditions.push(`@.beckn:items[*].beckn:id == "${itemId}"`);
  }

    const expression = `$.catalogs[*] ? (${conditions.join(" && ")})`;

  console.log(
    `[MARKET-ANALYZER] Fetching market data with expression: ${expression}`,
  );

  return {
    context: {
      version: "2.0.0",
      action: "discover",
      timestamp: new Date().toISOString(),
      message_id: uuidv4(),
      transaction_id: uuidv4(),
      bap_id: "p2p.terrarexenergy.com",
      bap_uri: "https://p2p.terrarexenergy.com/bap/receiver",
      bpp_id: "p2p.terrarexenergy.com",
      bpp_uri: "https://p2p.terrarexenergy.com/bpp/receiver",
      ttl: "PT30S",
      domain: "beckn.one:deg:p2p-trading-interdiscom:2.0.0",
      location: {
        city: { code: "BLR", name: "Bangalore" },
        country: { code: "IND", name: "India" },
      },
      schema_context: [
        "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld",
      ],
    },
    message: {
      filters: {
        type: "jsonpath",
        expression
      },
    },
  };
}

/**
 * Parse CDS response into competitor offers
 */
function parseCDSResponse(response: any): CompetitorOffer[] {
  const offers: CompetitorOffer[] = [];

  try {
    const catalogs = response?.message?.catalogs || [];

    for (const catalog of catalogs) {
      const catalogOffers = catalog["beckn:offers"] || [];
      const catalogItems = catalog["beckn:items"] || [];

      // Get quantity from first item's itemAttributes
      const firstItem = catalogItems[0];
      const quantity =
        firstItem?.["beckn:itemAttributes"]?.availableQuantity || 0;

      for (const offer of catalogOffers) {
        // Extract price from offer
        const price =
          offer["beckn:price"]?.["schema:price"] ||
          offer["beckn:offerAttributes"]?.["beckn:price"]?.value;

        if (price) {
          // Extract validity window to determine date
          const validityWindow =
            offer["beckn:offerAttributes"]?.validityWindow ||
            offer["beckn:offerAttributes"]?.["beckn:timeWindow"];

          const startTime =
            validityWindow?.["schema:startTime"] || validityWindow?.start;
          const endTime =
            validityWindow?.["schema:endTime"] || validityWindow?.end;
          const date = startTime ? startTime.split("T")[0] : "unknown";

          offers.push({
            offer_id: offer["beckn:id"] || "unknown",
            provider_id:
              offer["beckn:provider"] || catalog["beckn:bppId"] || "unknown",
            price_per_kwh: parseFloat(price),
            quantity_kwh: quantity,
            source_type: "SOLAR",
            date,
            validity_window: {
              start: startTime || "",
              end: endTime || "",
            },
          });
        }
      }
    }
  } catch (error) {
    console.log(`[BidService] Error parsing CDS response:`, error);
  }

  return offers;
}

/**
 * Fetch market data via ONIX BAP discover
 */
export async function fetchMarketData(
  startDate: string,
  endDate: string,
  sourceType: string,
): Promise<CompetitorOffer[]> {
  const discoverUrl = `https://p2p.terrarexenergy.com/bap/caller/discover`;
  console.log(`[BidService] Fetching market data via ONIX: ${discoverUrl}`);

  try {
    const request = buildDiscoverRequest({
      sourceType,
    });

    const response = await axios.post(discoverUrl, request, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000, // 15 second timeout
    });

    const offers = parseCDSResponse(response.data);
    console.log(`[BidService] Found ${offers.length} competitor offers in CDS`);

    // Save snapshot for fallback
    await saveSnapshot({ start: startDate, end: endDate }, response.data);

    return offers;
  } catch (error: any) {
    console.log(`[BidService] CDS fetch failed: ${error.message}`);

    // Try cached data
    const cached = await getCachedSnapshot(startDate, endDate);
    if (cached) {
      console.log(`[BidService] Using cached market snapshot`);
      return parseCDSResponse({ message: { catalogs: cached } });
    }

    console.log(
      `[BidService] No cached data available, proceeding with empty competitor list`,
    );
    return [];
  }
}

/**
 * Save market snapshot to MongoDB for fallback
 */
async function saveSnapshot(
  dateRange: { start: string; end: string },
  response: any,
): Promise<void> {
  try {
    const db = getDB();
    const snapshot: MarketSnapshot = {
      fetched_at: new Date(),
      date_range: dateRange,
      offers: response?.message?.catalogs || [],
    };

    await db.collection("market_snapshots").updateOne(
      {
        "date_range.start": dateRange.start,
        "date_range.end": dateRange.end,
      },
      { $set: snapshot },
      { upsert: true },
    );
  } catch (error) {
    console.log(`[BidService] Failed to save market snapshot:`, error);
  }
}

/**
 * Get cached market snapshot from MongoDB
 */
async function getCachedSnapshot(
  startDate: string,
  endDate: string,
): Promise<any[] | null> {
  try {
    const db = getDB();
    const snapshot = await db.collection("market_snapshots").findOne({
      "date_range.start": startDate,
      "date_range.end": endDate,
    });

    return snapshot?.offers || null;
  } catch (error) {
    console.log(`[BidService] Failed to get cached snapshot:`, error);
    return null;
  }
}

/**
 * Analyze competitors for a specific date
 */
export function analyzeCompetitors(
  date: string,
  allOffers: CompetitorOffer[],
  cached: boolean = false,
): MarketAnalysis {
  // Filter offers for this specific date
  const dayOffers = allOffers.filter(
    (o) => o.date === date || o.date === "unknown",
  );

  if (dayOffers.length === 0) {
    return {
      competitors_found: 0,
      lowest_competitor_price: null,
      lowest_competitor_quantity_kwh: null,
      lowest_competitor_validity_window: null,
      lowest_competitor_id: null,
      cached,
    };
  }

  // Find lowest price
  const sorted = [...dayOffers].sort(
    (a, b) => a.price_per_kwh - b.price_per_kwh,
  );
  const lowest = sorted[0];

  return {
    competitors_found: dayOffers.length,
    lowest_competitor_price: lowest.price_per_kwh,
    lowest_competitor_quantity_kwh: lowest.quantity_kwh,
    lowest_competitor_validity_window: lowest.validity_window ?? null,
    lowest_competitor_id: lowest.offer_id,
    cached,
  };
}

/**
 * Calculate optimal bid price based on competitor analysis
 */
export function calculatePrice(lowestCompetitorPrice: number | null): {
  price: number;
  reasoning: string;
} {
  // No competitors - bid at floor
  if (lowestCompetitorPrice === null) {
    return {
      price: FLOOR_PRICE,
      reasoning: `No competitors found. Bidding at floor: ${FLOOR_PRICE.toFixed(2)}`,
    };
  }

  // Competitor below floor - bid at floor
  if (lowestCompetitorPrice <= FLOOR_PRICE) {
    return {
      price: FLOOR_PRICE,
      reasoning: `Competitor price (${lowestCompetitorPrice.toFixed(2)}) below floor. Bidding at floor: ${FLOOR_PRICE.toFixed(2)}`,
    };
  }

  // Undercut competitor by configured percentage
  const undercutMultiplier = 1 - UNDERCUT_PERCENT / 100;
  const calculatedPrice =
    Math.round(lowestCompetitorPrice * undercutMultiplier * 100) / 100;

  // Ensure we don't go below floor
  const finalPrice = Math.max(calculatedPrice, FLOOR_PRICE);

  return {
    price: finalPrice,
    reasoning: `Undercut lowest competitor (${lowestCompetitorPrice.toFixed(2)}) by ${UNDERCUT_PERCENT}% = ${finalPrice.toFixed(2)}`,
  };
}
