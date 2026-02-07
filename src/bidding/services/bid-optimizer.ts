import axios from 'axios';

import {
  FLOOR_PRICE
} from '../types';

import { buildPublishRequest, extractIds } from './catalog-builder';
import { getProcessedForecasts } from './forecast-reader';
import { fetchMarketData, analyzeCompetitors, calculatePrice } from './market-analyzer';

import type {
  BidRequest,
  CalculatedBid,
  PreviewResponse,
  ConfirmResponse,
  PlacedBid,
  ProcessedDay,
  CompetitorOffer,
  SellerInfo} from '../types';

// Internal publish API URL - calls our own /api/publish endpoint
const SANDBOX_API_URL = process.env.SANDBOX_API_URL || 'http://sandbox-bpp:3002';

/**
 * Calculate bids for all biddable days
 */
async function calculateBids(
  request: BidRequest,
  biddableDays: ProcessedDay[],
  competitorOffers: CompetitorOffer[],
  cached: boolean
): Promise<CalculatedBid[]> {
  const bids: CalculatedBid[] = [];

  for (const day of biddableDays) {
    // Analyze competitors for this specific date
    const marketAnalysis = analyzeCompetitors(day.date, competitorOffers, cached);

    // Calculate optimal price
    const { price, reasoning } = calculatePrice(marketAnalysis.lowest_competitor_price);

    const bid: CalculatedBid = {
      date: day.date,
      raw_excess_kwh: day.rawTotal,
      buffered_quantity_kwh: day.bufferedQuantity,
      validity_window: day.validityWindow,
      market_analysis: marketAnalysis,
      calculated_price_inr: price,
      reasoning
    };

    console.log(`[BidService] Day ${day.date}: ${marketAnalysis.competitors_found > 0 ?
      `Lowest competitor ${marketAnalysis.lowest_competitor_price?.toFixed(2)}, ` : ''}bidding at ${price.toFixed(2)}`);

    bids.push(bid);
  }

  return bids;
}

/**
 * Calculate summary statistics
 */
function calculateSummary(allDays: ProcessedDay[], bids: CalculatedBid[]) {
  const totalQuantity = bids.reduce((sum, b) => sum + b.buffered_quantity_kwh, 0);
  const totalRevenue = bids.reduce((sum, b) => sum + (b.buffered_quantity_kwh * b.calculated_price_inr), 0);
  const baselineRevenue = totalQuantity * FLOOR_PRICE;

  return {
    total_days: allDays.length,
    biddable_days: bids.length,
    skipped_days: allDays.length - bids.length,
    total_quantity_kwh: Math.round(totalQuantity * 100) / 100,
    total_potential_revenue_inr: Math.round(totalRevenue * 100) / 100,
    baseline_revenue_at_floor_inr: Math.round(baselineRevenue * 100) / 100,
    strategy_advantage_inr: Math.round((totalRevenue - baselineRevenue) * 100) / 100
  };
}

/**
 * Preview bid calculations without publishing
 */
export async function preview(request: BidRequest): Promise<PreviewResponse> {
  console.log(`[BidService] Starting preview for provider: ${request.provider_id}`);

  // Step 1 & 2: Read and process forecasts
  const { all, biddable } = getProcessedForecasts();

  if (biddable.length === 0) {
    return {
      success: true,
      seller: {
        provider_id: request.provider_id,
        meter_id: request.meter_id,
        source_type: request.source_type,
        total_quantity_kwh: 0,
        offering_period: {
          start_date: all.length > 0 ? all[0].date : '',
          end_date: all.length > 0 ? all[all.length - 1].date : ''
        }
      },
      summary: {
        total_days: all.length,
        biddable_days: 0,
        skipped_days: all.length,
        total_quantity_kwh: 0,
        total_potential_revenue_inr: 0,
        baseline_revenue_at_floor_inr: 0,
        strategy_advantage_inr: 0
      },
      bids: []
    };
  }

  // Step 3: Fetch market data (parallel with forecast processing in real scenario)
  const startDate = biddable[0].date;
  const endDate = biddable[biddable.length - 1].date;

  let competitorOffers: CompetitorOffer[] = [];
  let cached = false;

  try {
    competitorOffers = await fetchMarketData(startDate, endDate, request.source_type);
  } catch (_error) {
    console.log(`[BidService] Market data fetch failed, proceeding with floor price`);
    cached = true;
  }

  // Step 4: Calculate bids
  const bids = await calculateBids(request, biddable, competitorOffers, cached);

  // Step 5: Calculate summary
  const summary = calculateSummary(all, bids);

  console.log(`[BidService] Preview complete: ${bids.length} bids, estimated revenue ${summary.total_potential_revenue_inr.toFixed(2)} INR`);

  // Build seller info
  const seller: SellerInfo = {
    provider_id: request.provider_id,
    meter_id: request.meter_id,
    source_type: request.source_type,
    total_quantity_kwh: summary.total_quantity_kwh,
    offering_period: {
      start_date: biddable[0].date,
      end_date: biddable[biddable.length - 1].date
    }
  };

  return {
    success: true,
    seller,
    summary,
    bids
  };
}

/**
 * Confirm and publish bids
 * Places bids sequentially via internal /api/publish endpoint, halts on first failure
 *
 * @param request - Bid request with provider info
 * @param maxBids - Limit number of bids (for testing)
 */
export async function confirm(request: BidRequest, maxBids?: number): Promise<ConfirmResponse> {
  console.log(`[BidService] Starting confirm for provider: ${request.provider_id}${maxBids ? ` (max ${maxBids} bids)` : ''}`);

  // First generate preview to get calculated bids
  const previewResult = await preview(request);

  if (!previewResult.success || previewResult.bids.length === 0) {
    return {
      success: true,
      placed_bids: [],
      failed_at: null
    };
  }

  const placedBids: PlacedBid[] = [];
  let failedAt: { date: string; error: string } | null = null;

  // Limit number of bids if specified
  const bidsToPlace = maxBids ? previewResult.bids.slice(0, maxBids) : previewResult.bids;

  // Place bids sequentially via internal publish API
  for (const bid of bidsToPlace) {
    try {
      console.log(`[BidService] Publishing bid for ${bid.date}...`);

      // Build publish request
      const publishRequest = buildPublishRequest({
        provider_id: request.provider_id,
        meter_id: request.meter_id,
        source_type: request.source_type,
        bid
      });

      const catalog = publishRequest.message.catalogs[0];
      const ids = extractIds(catalog);

      // Call internal /api/publish endpoint
      // This handles MongoDB storage + ONIX forwarding
      const publishUrl = `${SANDBOX_API_URL}/api/publish`;
      console.log(`[BidService] Calling publish API: ${publishUrl}`);

      const response = await axios.post(publishUrl, publishRequest, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      });

      console.log(`[BidService] Publish API response:`, response.status);

      placedBids.push({
        date: bid.date,
        quantity_kwh: bid.buffered_quantity_kwh,
        price_inr: bid.calculated_price_inr,
        offer_id: ids.offer_id,
        catalog_id: ids.catalog_id,
        item_id: ids.item_id,
        status: 'PUBLISHED'
      });

      console.log(`[BidService] Successfully published bid for ${bid.date}: offer ${ids.offer_id}`);

    } catch (error: any) {
      console.error(`[BidService] Failed to publish bid for ${bid.date}:`, error.message);

      failedAt = {
        date: bid.date,
        error: error.message || 'Unknown error'
      };

      // Halt on first failure
      break;
    }
  }

  const success = failedAt === null;
  console.log(`[BidService] Confirm complete: ${placedBids.length} bids placed${failedAt ? `, failed at ${failedAt.date}` : ''}`);

  return {
    success,
    placed_bids: placedBids,
    failed_at: failedAt
  };
}
