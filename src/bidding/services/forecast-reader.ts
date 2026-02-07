import * as fs from 'fs';
import * as path from 'path';

import { BUFFER_RATE, MIN_THRESHOLD } from '../types';

import type { DailyForecast, ProcessedDay, ValidityWindow} from '../types';

const EXCESS_DATA_PATH = process.env.EXCESS_DATA_PATH || 'data/excess_predicted_hourly.json';

/**
 * Read and parse the excess energy forecast file
 */
export function readForecast(): DailyForecast[] {
  const filePath = path.resolve(EXCESS_DATA_PATH);

  console.log(`[BidService] Reading excess forecast from ${filePath}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Excess energy file not found at ${filePath}`);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      throw new Error('Excess energy file must contain an array of daily forecasts');
    }

    // Validate structure
    for (const day of data) {
      if (!day.date || !Array.isArray(day.hourly)) {
        throw new Error('Each forecast entry must have date and hourly array');
      }
    }

    return data;
  } catch (error: any) {
    if (error.message.includes('Unexpected token') || error.message.includes('JSON')) {
      throw new Error(`Excess energy file is malformed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Derive validity window from non-zero hours
 * Returns the first and last hour with excess > 0
 */
function deriveValidityWindow(day: DailyForecast): ValidityWindow {
  const nonZeroHours = day.hourly.filter(h => h.excess_kwh > 0);

  if (nonZeroHours.length === 0) {
    // Default window if no production
    return {
      start: `${day.date}T08:00:00Z`,
      end: `${day.date}T17:00:00Z`
    };
  }

  const firstHour = nonZeroHours[0].hour;
  const lastHour = nonZeroHours[nonZeroHours.length - 1].hour;

  // Add 1 hour to end time (if 16:00 is last hour with production, end at 17:00)
  const lastHourNum = parseInt(lastHour.split(':')[0]);
  const endHour = String(lastHourNum + 1).padStart(2, '0') + ':00';

  return {
    start: `${day.date}T${firstHour}:00Z`,
    end: `${day.date}T${endHour}:00Z`
  };
}

/**
 * Process a single day's forecast
 * - Sum hourly values
 * - Apply buffer (10% reduction)
 * - Check minimum threshold
 * - Derive validity window
 */
export function processDailyForecast(day: DailyForecast): ProcessedDay {
  // Sum all hourly excess values (round to 2 decimals)
  const rawTotal = Math.round(day.hourly.reduce((sum, h) => sum + h.excess_kwh, 0) * 100) / 100;

  // Apply 10% buffer (multiply by 0.9)
  const bufferedQuantity = Math.round(rawTotal * BUFFER_RATE * 100) / 100;

  // Check if biddable (>= 5 kWh after buffer)
  const isBiddable = bufferedQuantity >= MIN_THRESHOLD;

  // Derive validity window from non-zero production hours
  const validityWindow = deriveValidityWindow(day);

  console.log(`[BidService] Day ${day.date}: ${rawTotal.toFixed(2)} kWh raw → ${bufferedQuantity.toFixed(2)} kWh biddable${!isBiddable ? ' (SKIPPED < 5 kWh)' : ''}`);

  return {
    date: day.date,
    rawTotal,
    bufferedQuantity,
    isBiddable,
    validityWindow
  };
}

/**
 * Read and process all forecasts
 * Returns only biddable days
 */
export function getProcessedForecasts(): { all: ProcessedDay[]; biddable: ProcessedDay[] } {
  const forecasts = readForecast();
  const all = forecasts.map(processDailyForecast);
  const biddable = all.filter(d => d.isBiddable);

  return { all, biddable };
}
