// Bidding Service Types

// Input types
export interface BidRequest {
  provider_id: string;
  meter_id: string;
  source_type: 'SOLAR' | 'WIND' | 'BATTERY';
}

// Forecast data structures
export interface HourlyExcess {
  hour: string;      // "08:00"
  excess_kwh: number;
}

export interface DailyForecast {
  date: string;      // "2026-01-27"
  hourly: HourlyExcess[];
}

// Processed forecast
export interface ProcessedDay {
  date: string;
  rawTotal: number;
  bufferedQuantity: number;
  isBiddable: boolean;
  validityWindow: ValidityWindow;
}

// Market analysis
export interface CompetitorOffer {
  offer_id: string;
  provider_id: string;
  price_per_kwh: number;
  quantity_kwh: number;
  source_type: string;
  date: string;
  validity_window?: ValidityWindow;  // Optional for offers without specific window
}

export interface MarketAnalysis {
  competitors_found: number;
  lowest_competitor_price: number | null;
  lowest_competitor_quantity_kwh: number | null;
  lowest_competitor_validity_window: ValidityWindow | null;
  lowest_competitor_id: string | null;
  cached: boolean;
}

// Bid calculation
export interface ValidityWindow {
  start: string;  // ISO 8601
  end: string;
}

export interface CalculatedBid {
  date: string;
  raw_excess_kwh: number;
  buffered_quantity_kwh: number;
  validity_window: ValidityWindow;
  market_analysis: MarketAnalysis;
  calculated_price_inr: number;
  reasoning: string;
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

// Response types
export interface PreviewSummary {
  total_days: number;
  biddable_days: number;
  skipped_days: number;
  total_quantity_kwh: number;
  total_potential_revenue_inr: number;
  baseline_revenue_at_floor_inr: number;
  strategy_advantage_inr: number;
}

export interface PreviewResponse {
  success: boolean;
  seller: SellerInfo;
  summary: PreviewSummary;
  bids: CalculatedBid[];
}

export interface PlacedBid {
  date: string;
  quantity_kwh: number;
  price_inr: number;
  offer_id: string;
  catalog_id: string;
  item_id: string;
  status: 'PUBLISHED' | 'FAILED';
  error?: string;
}

export interface ConfirmResponse {
  success: boolean;
  placed_bids: PlacedBid[];
  failed_at: {
    date: string;
    error: string;
  } | null;
}

// MongoDB snapshot
export interface MarketSnapshot {
  fetched_at: Date;
  date_range: { start: string; end: string };
  offers: any[];  // Raw CDS response
}

// Config constants
export const FLOOR_PRICE = 6.0;  // INR/kWh - fixed, not configurable
export const BUFFER_RATE = 0.9;  // 10% buffer (multiply by 0.9)
export const MIN_THRESHOLD = 5;  // kWh - minimum biddable quantity
export const DEFAULT_UNDERCUT_PERCENT = 10;  // Percentage to undercut competitors
