import * as fs from 'fs';
import * as path from 'path';

import { HOURLY_MIN_THRESHOLD } from '../types';

import type { DailyForecast, HourlyExcess, SkippedHour} from '../types';

const FORECAST_FILE = path.join(__dirname, '../../../data/excess_predicted_hourly.json');

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
 * Read and parse the hourly forecast file
 */
function readForecastFile(): DailyForecast[] | null {
  try {
    if (!fs.existsSync(FORECAST_FILE)) {
      console.log(`[SellerBidding] Forecast file not found: ${FORECAST_FILE}`);
      return null;
    }

    const content = fs.readFileSync(FORECAST_FILE, 'utf-8');
    const data = JSON.parse(content) as DailyForecast[];

    if (!Array.isArray(data)) {
      console.log(`[SellerBidding] Forecast file is not an array`);
      return null;
    }

    return data;
  } catch (error: any) {
    console.log(`[SellerBidding] Error reading forecast file: ${error.message}`);
    return null;
  }
}

/**
 * Get tomorrow's forecast from the data
 */
export function getTomorrowForecast(): DailyForecast | null {
  const forecasts = readForecastFile();
  if (!forecasts) {
    return null;
  }

  const tomorrow = getTomorrowDate();
  const tomorrowForecast = forecasts.find(f => f.date === tomorrow);

  if (!tomorrowForecast) {
    console.log(`[SellerBidding] No forecast found for tomorrow (${tomorrow})`);
    return null;
  }

  console.log(`[SellerBidding] Found forecast for ${tomorrow} with ${tomorrowForecast.hourly.length} hours`);
  return tomorrowForecast;
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
