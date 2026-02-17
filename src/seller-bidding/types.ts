// Seller Bidding Types - Hourly Optimization Module

// Re-export shared types from bidding module
export { MarketAnalysis, CompetitorOffer, ValidityWindow, FLOOR_PRICE, DEFAULT_UNDERCUT_PERCENT } from '../bidding/types';

// Constants specific to hourly bidding
export const HOURLY_MIN_THRESHOLD = 1.0;  // kWh - minimum biddable quantity per hour
export const VALIDITY_BUFFER_HOURS = 4;   // Hours before delivery that offer becomes valid
export const TOP_N_HOURS = 5;             // Number of top hours to select
export const HOURLY_START_TIME = parseInt(process.env.HOURLY_START_TIME || '10', 10); // Start hour (24h format)
export const HOURLY_END_TIME = parseInt(process.env.HOURLY_END_TIME || '16', 10);   // End hour (24h format)

// PR (Performance Ratio) computation types
export interface PrSlotData {
  slot: string;       // "07:00-08:00"
  pr_min: number;
  pr_max: number;
  midpoint: number;
}

// Input types
export interface SellerBidRequest {
  provider_id: string;
  meter_id: string;
  source_type: 'SOLAR' | 'WIND' | 'BATTERY';
}

// Hourly forecast structures
export interface HourlyExcess {
  hour: string;      // "12:00"
  excess_kwh: number;
}

export interface DailyForecast {
  date: string;      // "2026-01-28"
  hourly: HourlyExcess[];
}

// Processed hourly bid
export interface HourlyBid {
  hour: string;                    // "12:00"
  quantity_kwh: number;
  existing_usage_kwh: number;      // Already allocated capacity for this hour
  generation_kwh: number;          // PR-based generation before usage subtraction
  price_inr: number;
  expected_revenue_inr: number;
  delivery_window: {
    start: string;  // ISO 8601
    end: string;
  };
  validity_window: {
    start: string;  // ISO 8601
    end: string;
  };
  market_analysis: import('../bidding/types').MarketAnalysis;
  reasoning: string;
}

// Skipped hour info
export interface SkippedHour {
  hour: string;
  reason: string;
}

// Seller info for preview response
export interface SellerInfo {
  provider_id: string;
  meter_id: string;
  source_type: string;
  total_quantity_kwh: number;
  offering_period: {
    start_date: string;
    end_date: string;
  };
}

// Preview response
export interface SellerPreviewSummary {
  total_hours_in_forecast: number;
  valid_hours: number;
  selected_hours: number;
  skipped_hours: number;
  total_quantity_kwh: number;
  total_expected_revenue_inr: number;
}

export interface SellerPreviewResponse {
  success: boolean;
  target_date: string;
  seller: SellerInfo;
  bids: HourlyBid[];
  skipped_hours: SkippedHour[];
  summary: SellerPreviewSummary;
}

// Confirm response
export interface PlacedHourlyBid {
  hour: string;
  quantity_kwh: number;
  price_inr: number;
  catalog_id: string;
  offer_id: string;
  item_id: string;
  status: 'PUBLISHED' | 'FAILED';
  error?: string;
}

export interface SellerConfirmResponse {
  success: boolean;
  target_date: string;
  placed_bids: PlacedHourlyBid[];
  failed_at: {
    hour: string;
    error: string;
  } | null;
}
