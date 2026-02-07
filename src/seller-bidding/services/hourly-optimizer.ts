import axios from "axios";

import {
  fetchMarketData,
  calculatePrice,
} from "../../bidding/services/market-analyzer";
import {
  TOP_N_HOURS,
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
): Promise<SellerPreviewResponse> {
  const targetDate = getTomorrowDate();
  console.log(`[SellerBidding] Generating preview for ${targetDate}`);

  // Step 1: Get tomorrow's forecast
  const forecast = getTomorrowForecast();

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

  // Step 2: Filter valid hours (>= 1 kWh)
  const { valid: validHours, skipped: skippedHours } =
    filterValidHours(forecast);

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

  // Step 4: Calculate bids for all valid hours
  const allBids: HourlyBid[] = [];

  for (const hourData of validHours) {
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

    // Calculate expected revenue
    const expectedRevenue = calculateExpectedRevenue(
      hourData.excess_kwh,
      price,
    );

    allBids.push({
      hour: hourData.hour,
      quantity_kwh: hourData.excess_kwh,
      price_inr: price,
      expected_revenue_inr: expectedRevenue,
      delivery_window: deliveryWindow,
      validity_window: validityWindow,
      market_analysis: marketAnalysis,
      reasoning,
    });
  }

  // Step 5: Select top N hours by expected revenue
  const sortedBids = [...allBids].sort(
    (a, b) => b.expected_revenue_inr - a.expected_revenue_inr,
  );
  const selectedBids = sortedBids.slice(0, TOP_N_HOURS);

  // Log selection decision
  console.log(
    `[SellerBidding] Selected top ${selectedBids.length} hours by revenue:`,
  );
  for (const bid of selectedBids) {
    console.log(
      `  ${bid.hour}: ${bid.quantity_kwh} kWh @ ${bid.price_inr} INR = ${bid.expected_revenue_inr} INR`,
    );
  }

  // Sort selected bids by hour for display
  selectedBids.sort((a, b) => a.hour.localeCompare(b.hour));

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
): Promise<SellerConfirmResponse> {
  const targetDate = getTomorrowDate();
  console.log(`[SellerBidding] Confirming bids for ${targetDate}`);

  // First generate the preview to get the selected bids
  const previewResult = await preview(request);

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
        sourceType: request.source_type
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
