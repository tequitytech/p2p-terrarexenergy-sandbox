// Enums (New)
export enum DeliveryMode {
  EV_CHARGING = "EV_CHARGING",
  BATTERY_SWAP = "BATTERY_SWAP",
  V2G = "V2G",
  GRID_INJECTION = "GRID_INJECTION"
}

export enum SourceType {
  SOLAR = "SOLAR",
  BATTERY = "BATTERY",
  GRID = "GRID",
  HYBRID = "HYBRID",
  RENEWABLE = "RENEWABLE"
}

export enum PricingModel {
  PER_KWH = "PER_KWH",
  TIME_OF_DAY = "TIME_OF_DAY",
  SUBSCRIPTION = "SUBSCRIPTION",
  FIXED = "FIXED"
}

export enum SettlementType {
  REAL_TIME = "REAL_TIME",
  HOURLY = "HOURLY",
  DAILY = "DAILY",
  WEEKLY = "WEEKLY",
  MONTHLY = "MONTHLY"
}

export const FLOOR_PRICE = 6.0;
export const DEFAULT_UNDERCUT_PERCENT = 10;

export interface CompetitorOffer {
  offer_id: string;
  provider_id: string;
  price_per_kwh: number;
  quantity_kwh: number;
  source_type: string;
  date: string;
  validity_window?: {
    start: string;
    end: string;
  };
}

export interface MarketAnalysis {
  competitors_found: number;
  lowest_competitor_price: number | null;
  lowest_competitor_quantity_kwh: number | null;
  lowest_competitor_validity_window: { start: string; end: string } | null;
  lowest_competitor_id: string | null;
  cached: boolean;
}

export interface MarketSnapshot {
  fetched_at: Date;
  date_range: {
    start: string;
    end: string;
  };
  offers: any[];
}