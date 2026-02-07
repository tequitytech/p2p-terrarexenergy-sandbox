import type { CompetitorOffer, MarketAnalysis } from '../types';

/**
 * Check if two time ranges overlap
 */
function timeRangesOverlap(
  range1Start: string,
  range1End: string,
  range2Start: string,
  range2End: string
): boolean {
  const start1 = new Date(range1Start).getTime();
  const end1 = new Date(range1End).getTime();
  const start2 = new Date(range2Start).getTime();
  const end2 = new Date(range2End).getTime();

  // Ranges overlap if one starts before the other ends
  return start1 < end2 && start2 < end1;
}

/**
 * Analyze competitors for a specific hour's delivery window
 * Filters offers whose validity window overlaps with the target delivery hour
 */
export function analyzeCompetitorsForHour(
  date: string,
  hour: string,
  deliveryWindow: { start: string; end: string },
  allOffers: CompetitorOffer[],
  cached: boolean = false
): MarketAnalysis {
  // Filter offers that overlap with this hour's delivery window
  const hourlyOffers = allOffers.filter(offer => {
    // Must be same date
    if (offer.date !== date && offer.date !== 'unknown') {
      return false;
    }

    // If offer has validity window, check for overlap with delivery window
    if (offer.validity_window?.start && offer.validity_window?.end) {
      return timeRangesOverlap(
        offer.validity_window.start,
        offer.validity_window.end,
        deliveryWindow.start,
        deliveryWindow.end
      );
    }

    // If no validity window, include offers from same date (conservative)
    return offer.date === date;
  });

  if (hourlyOffers.length === 0) {
    return {
      competitors_found: 0,
      lowest_competitor_price: null,
      lowest_competitor_quantity_kwh: null,
      lowest_competitor_validity_window: null,
      lowest_competitor_id: null,
      cached
    };
  }

  // Find lowest price among hourly competitors
  const sorted = [...hourlyOffers].sort((a, b) => a.price_per_kwh - b.price_per_kwh);
  const lowest = sorted[0];

  console.log(`[SellerBidding] Hour ${hour}: Found ${hourlyOffers.length} competing offers, lowest price: ${lowest.price_per_kwh} INR`);

  return {
    competitors_found: hourlyOffers.length,
    lowest_competitor_price: lowest.price_per_kwh,
    lowest_competitor_quantity_kwh: lowest.quantity_kwh,
    lowest_competitor_validity_window: lowest.validity_window ?? null,
    lowest_competitor_id: lowest.offer_id,
    cached
  };
}
