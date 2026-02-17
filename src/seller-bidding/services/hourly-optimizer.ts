import axios from "axios";

import {
  fetchMarketData,
  calculatePrice,
} from "../../bidding/services/market-analyzer";
import { limitValidator } from "../../trade/limit-validator";
import {
  HOURLY_MIN_THRESHOLD,
  HOURLY_START_TIME,
  HOURLY_END_TIME,
} from "../types";
import {
  buildDeliveryWindow,
  buildValidityWindow,
} from "./hourly-catalog-builder";
import {
  getTomorrowDate,
  getTomorrowForecast,
  filterValidHours,
} from "./hourly-forecast-reader";
import { analyzeCompetitorsForHour } from "./hourly-market-analyzer";

import type {
  SellerBidRequest,
  HourlyBid,
  SkippedHour,
  SellerPreviewResponse,
  SellerConfirmResponse,
  PlacedHourlyBid} from "../types";

const PUBLISH_URL =
  process.env.PUBLISH_URL || "http://localhost:3002/api/publish";

/**
 * Calculate expected revenue for an hour
 */
function calculateExpectedRevenue(quantity: number, price: number): number {
  return Math.round(quantity * price * 100) / 100;
}

/**
 * Preview hourly bids for tomorrow (top 5 by expected revenue)
 */
export async function preview(
  request: SellerBidRequest,
  safeLimit: number,
  userId?: string,
): Promise<SellerPreviewResponse> {
  const targetDate = getTomorrowDate();
  console.log(`[SellerBidding] Generating preview for ${targetDate}`);

  // Step 1: Get tomorrow's forecast using PR data and safeLimit
  const forecast = getTomorrowForecast(safeLimit);

  if (!forecast) {
    console.log(`[SellerBidding] No forecast available, returning empty bids`);
    return {
      success: true,
      target_date: targetDate,
      seller: {
        provider_id: request.provider_id,
        meter_id: request.meter_id,
        source_type: request.source_type,
        total_quantity_kwh: 0,
        offering_period: {
          start_date: targetDate,
          end_date: targetDate,
        },
      },
      bids: [],
      skipped_hours: [],
      summary: {
        total_hours_in_forecast: 0,
        valid_hours: 0,
        selected_hours: 0,
        skipped_hours: 0,
        total_quantity_kwh: 0,
        total_expected_revenue_inr: 0,
      },
    };
  }

  // Step 2: Filter valid hours (>= 1 kWh) and apply time window
  const { valid: rawValidHours, skipped: rawSkippedHours } =
    filterValidHours(forecast);

  const validHours: typeof rawValidHours = [];
  const skippedHours = [...rawSkippedHours];

  for (const hourData of rawValidHours) {
    const hourNum = parseInt(hourData.hour.split(':')[0], 10);
    
    // Check strict time window (default 10am - 4pm)
    if (hourNum >= HOURLY_START_TIME && hourNum < HOURLY_END_TIME) {
      validHours.push(hourData);
    } else {
      skippedHours.push({
        hour: hourData.hour,
        reason: `Outside trading hours (${HOURLY_START_TIME}:00 - ${HOURLY_END_TIME}:00)`
      });
    }
  }

  if (validHours.length === 0) {
    console.log(`[SellerBidding] No valid hours found, returning empty bids`);
    return {
      success: true,
      target_date: targetDate,
      seller: {
        provider_id: request.provider_id,
        meter_id: request.meter_id,
        source_type: request.source_type,
        total_quantity_kwh: 0,
        offering_period: {
          start_date: targetDate,
          end_date: targetDate,
        },
      },
      bids: [],
      skipped_hours: skippedHours,
      summary: {
        total_hours_in_forecast: forecast.hourly.length,
        valid_hours: 0,
        selected_hours: 0,
        skipped_hours: skippedHours.length,
        total_quantity_kwh: 0,
        total_expected_revenue_inr: 0,
      },
    };
  }

  // Step 3: Query CDS for market data
  let competitorOffers: any[] = [];
  try {
    competitorOffers = await fetchMarketData(
      targetDate,
      targetDate,
      request.source_type,
    );
    console.log(
      `[SellerBidding] Found ${competitorOffers.length} competitor offers`,
    );
  } catch (error: any) {
    console.log(
      `[SellerBidding] CDS query failed: ${error.message}, using floor price`,
    );
  }

  // Step 4: Fetch existing seller usage for all hours in parallel
  const usageMap = new Map<string, number>();
  if (userId) {
    const usageResults = await Promise.allSettled(
      validHours.map(async (hourData) => {
        const hourNum = parseInt(hourData.hour.split(':')[0], 10);
        const usage = await limitValidator.getSellerUsage(userId, targetDate, hourNum);
        return { hour: hourData.hour, usage };
      }),
    );

    for (const result of usageResults) {
      if (result.status === 'fulfilled') {
        usageMap.set(result.value.hour, result.value.usage);
      } else {
        console.log(
          `[SellerBidding] Failed to fetch seller usage: ${result.reason?.message}, using full generation`,
        );
      }
    }
  }

  // Step 5: Calculate bids for all valid hours, subtracting existing usage
  const allBids: HourlyBid[] = [];
  const capacitySkipped: SkippedHour[] = [];

  for (const hourData of validHours) {
    // Subtract existing seller usage (active offers + sold orders) from available capacity
    let availableQty = hourData.excess_kwh;
    const existingUsage = usageMap.get(hourData.hour);
    if (existingUsage !== undefined) {
      availableQty = Math.min(
        Math.max(0, safeLimit - existingUsage),
        hourData.excess_kwh,
      );

      if (existingUsage > 0) {
        console.log(
          `[SellerBidding] Hour ${hourData.hour}: existing usage=${existingUsage.toFixed(2)} kWh, available=${availableQty.toFixed(2)} kWh`,
        );
      }
    }

    // Skip hour if remaining capacity is below threshold
    if (availableQty < HOURLY_MIN_THRESHOLD) {
      capacitySkipped.push({
        hour: hourData.hour,
        reason: `Capacity already allocated (available: ${availableQty.toFixed(2)} kWh)`,
      });
      continue;
    }

    const deliveryWindow = buildDeliveryWindow(targetDate, hourData.hour);
    const validityWindow = buildValidityWindow(targetDate, hourData.hour);

    // Analyze competitors for this specific hour's delivery window
    const marketAnalysis = analyzeCompetitorsForHour(
      targetDate,
      hourData.hour,
      deliveryWindow,
      competitorOffers,
      false,
    );

    // Calculate optimal price
    const { price, reasoning } = calculatePrice(
      marketAnalysis.lowest_competitor_price,
    );

    // Calculate expected revenue using available quantity
    const expectedRevenue = calculateExpectedRevenue(
      availableQty,
      price,
    );

    allBids.push({
      hour: hourData.hour,
      quantity_kwh: availableQty,
      existing_usage_kwh: existingUsage ?? 0,
      generation_kwh: hourData.excess_kwh,
      price_inr: price,
      expected_revenue_inr: expectedRevenue,
      delivery_window: deliveryWindow,
      validity_window: validityWindow,
      market_analysis: marketAnalysis,
      reasoning,
    });
  }

  // Merge capacity-skipped hours into skipped list
  skippedHours.push(...capacitySkipped);

  // Step 5: Use all valid hours, sorted by hour for display
  const selectedBids = [...allBids].sort(
    (a, b) => a.hour.localeCompare(b.hour),
  );

  // Log selection
  console.log(
    `[SellerBidding] Selected ${selectedBids.length} hours:`,
  );
  for (const bid of selectedBids) {
    console.log(
      `  ${bid.hour}: ${bid.quantity_kwh} kWh @ ${bid.price_inr} INR = ${bid.expected_revenue_inr} INR`,
    );
  }

  // Calculate summary
  const totalQuantity = selectedBids.reduce(
    (sum, b) => sum + b.quantity_kwh,
    0,
  );
  const totalRevenue = selectedBids.reduce(
    (sum, b) => sum + b.expected_revenue_inr,
    0,
  );

  return {
    success: true,
    target_date: targetDate,
    seller: {
      provider_id: request.provider_id,
      meter_id: request.meter_id,
      source_type: request.source_type,
      total_quantity_kwh: Math.round(totalQuantity * 100) / 100,
      offering_period: {
        start_date: targetDate,
        end_date: targetDate,
      },
    },
    bids: selectedBids,
    skipped_hours: skippedHours,
    summary: {
      total_hours_in_forecast: forecast.hourly.length,
      valid_hours: validHours.length,
      selected_hours: selectedBids.length,
      skipped_hours: skippedHours.length,
      total_quantity_kwh: Math.round(totalQuantity * 100) / 100,
      total_expected_revenue_inr: Math.round(totalRevenue * 100) / 100,
    },
  };
}

/**
 * Confirm and publish hourly bids
 */
export async function confirm(
  request: SellerBidRequest,
  authorizationToken: string,
  safeLimit: number,
  userId?: string,
): Promise<SellerConfirmResponse> {
  const targetDate = getTomorrowDate();
  console.log(`[SellerBidding] Confirming bids for ${targetDate}`);

  // First generate the preview to get the selected bids
  const previewResult = await preview(request, safeLimit, userId);

  if (previewResult.bids.length === 0) {
    console.log(`[SellerBidding] No bids to publish`);
    return {
      success: true,
      target_date: targetDate,
      placed_bids: [],
      failed_at: null,
    };
  }

  // Publish each bid sequentially, halt on first failure
  const placedBids: PlacedHourlyBid[] = [];
  let failedAt: { hour: string; error: string } | null = null;

  for (const bid of previewResult.bids) {
    console.log(`[SellerBidding] Publishing bid for ${bid.hour}...`);

    try {
      // 1. Construct simplified payload for /api/publish
      const hourNum = parseInt(bid.hour.split(':')[0], 10);
      
      const publishPayload = {
        quantity: bid.quantity_kwh,
        price: bid.price_inr,
        deliveryDate: targetDate,
        startHour: hourNum,
        duration: 1, // Hourly bids are always 1 hour duration
        sourceType: request.source_type,
        skipNotification: true // Suppress individual notifications for auto-bid
      };

      // 2. POST to internal publish API
      const response = await axios.post(PUBLISH_URL, publishPayload, {
        headers: {
          "Content-Type": "application/json",
          authorization: authorizationToken,
        },
        timeout: 30000,
      });

      if (response.status === 200 || response.status === 201) {
        const { catalog_id, offer_id, item_id } = response.data;
        
        console.log(
          `[SellerBidding] Published bid for ${bid.hour}: catalog=${catalog_id}`,
        );
        placedBids.push({
          hour: bid.hour,
          quantity_kwh: bid.quantity_kwh,
          price_inr: bid.price_inr,
          catalog_id: catalog_id,
          offer_id: offer_id,
          item_id: item_id,
          status: "PUBLISHED",
        });
      } else {
        throw new Error(`Unexpected response status: ${response.status}`);
      }
    } catch (error: any) {
      const errorMsg =
        error.response?.data?.error || error.message || "Unknown error";
      console.error(
        `[SellerBidding] Failed to publish bid for ${bid.hour}: ${errorMsg}`,
      );

      placedBids.push({
        hour: bid.hour,
        quantity_kwh: bid.quantity_kwh,
        price_inr: bid.price_inr,
        catalog_id: "",
        offer_id: "",
        item_id: "",
        status: "FAILED",
        error: errorMsg,
      });

      // Halt on first failure
      failedAt = { hour: bid.hour, error: errorMsg };
      break;
    }
  }

  const allSucceeded = failedAt === null;
  console.log(
    `[SellerBidding] Confirm complete: ${placedBids.filter((b) => b.status === "PUBLISHED").length}/${previewResult.bids.length} published`,
  );

  return {
    success: allSucceeded,
    target_date: targetDate,
    placed_bids: placedBids,
    failed_at: failedAt,
  };
}
