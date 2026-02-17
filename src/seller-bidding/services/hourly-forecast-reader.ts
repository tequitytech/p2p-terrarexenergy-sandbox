import { HOURLY_MIN_THRESHOLD } from '../types';

import { readPrData, calculateHourlyGeneration } from './hourly-market-analyzer';

import type { DailyForecast, HourlyExcess, SkippedHour } from '../types';

/**
 * Get tomorrow's date as YYYY-MM-DD in IST (UTC+5:30)
 * Using IST ensures consistent date handling for Indian market
 */
export function getTomorrowDate(): string {
  // Get current time in IST by adding 5:30 hours to UTC
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // 5:30 hours in ms
  const istNow = new Date(now.getTime() + istOffset);

  // Add one day for tomorrow
  istNow.setUTCDate(istNow.getUTCDate() + 1);

  // Format as YYYY-MM-DD
  const year = istNow.getUTCFullYear();
  const month = String(istNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istNow.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Generate tomorrow's forecast using PR computation data and safeLimit
 * Instead of reading excess_predicted_hourly.json, calculates generation as safeLimit * random_pr
 */
export function getTomorrowForecast(safeLimit: number): DailyForecast | null {
  const prData = readPrData();
  if (!prData) {
    return null;
  }

  const tomorrow = getTomorrowDate();
  const hourly: HourlyExcess[] = [];

  for (const prSlot of prData) {
    // Extract start hour from slot string e.g. "10:00-11:00" -> "10:00"
    const hour = prSlot.slot.split('-')[0];

    const result = calculateHourlyGeneration(hour, safeLimit, prData);
    if (result) {
      hourly.push({
        hour,
        excess_kwh: result.generation_kwh
      });
    }
  }

  if (hourly.length === 0) {
    console.log(`[SellerBidding] No generation hours calculated for ${tomorrow}`);
    return null;
  }

  console.log(`[SellerBidding] Generated PR-based forecast for ${tomorrow} with ${hourly.length} hours`);
  return { date: tomorrow, hourly };
}

/**
 * Filter valid hours (>= 1 kWh threshold) and track skipped hours
 */
export function filterValidHours(forecast: DailyForecast): {
  valid: HourlyExcess[];
  skipped: SkippedHour[];
} {
  const valid: HourlyExcess[] = [];
  const skipped: SkippedHour[] = [];

  for (const hourData of forecast.hourly) {
    if (hourData.excess_kwh >= HOURLY_MIN_THRESHOLD) {
      valid.push(hourData);
    } else if (hourData.excess_kwh > 0) {
      // Only log skipped hours that have some production but below threshold
      skipped.push({
        hour: hourData.hour,
        reason: `Below ${HOURLY_MIN_THRESHOLD} kWh minimum (${hourData.excess_kwh.toFixed(2)} kWh)`
      });
    }
    // Hours with 0 excess are not logged as skipped (no production expected)
  }

  console.log(`[SellerBidding] Valid hours: ${valid.length}, Skipped hours: ${skipped.length}`);
  return { valid, skipped };
}
