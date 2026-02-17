import * as fs from 'fs';
import * as path from 'path';

import type { CompetitorOffer, MarketAnalysis, PrSlotData } from '../types';

const PR_DATA_FILE = path.join(__dirname, '../../../data/pr-computation.json');

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

/**
 * Read and parse the PR computation data file
 */
export function readPrData(): PrSlotData[] | null {
  try {
    if (!fs.existsSync(PR_DATA_FILE)) {
      console.log(`[SellerBidding] PR data file not found: ${PR_DATA_FILE}`);
      return null;
    }

    const content = fs.readFileSync(PR_DATA_FILE, 'utf-8');
    const data = JSON.parse(content) as PrSlotData[];

    if (!Array.isArray(data)) {
      console.log(`[SellerBidding] PR data file is not an array`);
      return null;
    }

    return data;
  } catch (error: any) {
    console.log(`[SellerBidding] Error reading PR data file: ${error.message}`);
    return null;
  }
}

/**
 * Generate a random value between min and max (inclusive)
 */
export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Find the PR slot matching a given hour string (e.g. "10:00" -> "10:00-11:00")
 */
export function findPrSlotForHour(hour: string, prData: PrSlotData[]): PrSlotData | null {
  const slot = prData.find(s => s.slot.startsWith(hour + '-'));
  return slot ?? null;
}

/**
 * Calculate maximum hourly energy generation capacity using PR data
 *
 * Formula: generation_kwh = safeLimit * random_pr
 * where random_pr is a random value between pr_min and pr_max for the given hour slot
 *
 * @param hour - Hour string e.g. "10:00"
 * @param safeLimit - Safe generation limit in kW (from limit-validator: min(genCap, sanctionLoad) * sellerSafetyFactor)
 * @param prData - Optional PR data array (if not provided, reads from file)
 * @returns generation capacity in kWh for the hour, or null if no PR data for that slot
 */
export function calculateHourlyGeneration(
  hour: string,
  safeLimit: number,
  prData?: PrSlotData[] | null
): { generation_kwh: number; pr_used: number; slot: string } | null {
  const data = prData ?? readPrData();
  if (!data) {
    console.log(`[SellerBidding] No PR data available for generation calculation`);
    return null;
  }

  const prSlot = findPrSlotForHour(hour, data);
  if (!prSlot) {
    console.log(`[SellerBidding] No PR slot found for hour ${hour}`);
    return null;
  }

  const pr = randomBetween(prSlot.pr_min, prSlot.pr_max);
  const generation = Math.round(safeLimit * pr * 100) / 100;

  console.log(`[SellerBidding] Hour ${hour}: PR=${pr.toFixed(4)} (range ${prSlot.pr_min}-${prSlot.pr_max}), safeLimit=${safeLimit} kW, generation=${generation} kWh`);

  return {
    generation_kwh: generation,
    pr_used: Math.round(pr * 10000) / 10000,
    slot: prSlot.slot
  };
}
