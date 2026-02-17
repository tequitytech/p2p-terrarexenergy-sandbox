/**
 * Test Utilities - Mock factories and helpers for unit tests
 */


import type { DailyForecast, HourlyExcess, ValidityWindow, CalculatedBid, CompetitorOffer, MarketAnalysis } from '../bidding/types';
import type { HourlyBid, SkippedHour } from '../seller-bidding/types';
import type { Request, Response } from 'express';

// ============================================
// Express Request/Response Mocks
// ============================================

export function mockRequest(body: any = {}, params: any = {}, query: any = {}): Partial<Request> {
  return {
    body,
    params,
    query,
    headers: {},
    get: jest.fn((_name: string) => undefined),
  };
}

export function mockResponse(): { res: Partial<Response>; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnThis();
  const res: Partial<Response> = {
    status,
    json,
    send: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
  };
  // Allow chaining: res.status(200).json({})
  status.mockReturnValue(res);
  return { res, json, status };
}

export function mockNext(): jest.Mock {
  return jest.fn();
}

// ============================================
// Forecast Data Factories
// ============================================

export function createHourlyExcess(hour: string, excess_kwh: number): HourlyExcess {
  return { hour, excess_kwh };
}

export function createDailyForecast(date: string, hourlyData: Array<{ hour: string; excess_kwh: number }>): DailyForecast {
  return {
    date,
    hourly: hourlyData.map(h => createHourlyExcess(h.hour, h.excess_kwh))
  };
}

export function createWeekForecast(startDate: string = '2026-01-28'): DailyForecast[] {
  const forecasts: DailyForecast[] = [];
  const baseDate = new Date(startDate);

  for (let i = 0; i < 7; i++) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];

    forecasts.push(createDailyForecast(dateStr, [
      { hour: '08:00', excess_kwh: 2.5 + i },
      { hour: '09:00', excess_kwh: 5.0 + i },
      { hour: '10:00', excess_kwh: 8.5 + i },
      { hour: '11:00', excess_kwh: 12.0 + i },
      { hour: '12:00', excess_kwh: 15.0 + i },
      { hour: '13:00', excess_kwh: 14.0 + i },
      { hour: '14:00', excess_kwh: 11.0 + i },
      { hour: '15:00', excess_kwh: 7.5 + i },
      { hour: '16:00', excess_kwh: 4.0 + i },
      { hour: '17:00', excess_kwh: 1.5 + i }
    ]));
  }

  return forecasts;
}

// ============================================
// Validity Window Factories
// ============================================

export function createValidityWindow(date: string, startHour: string = '08:00', endHour: string = '17:00'): ValidityWindow {
  return {
    start: `${date}T${startHour}:00Z`,
    end: `${date}T${endHour}:00Z`
  };
}

// ============================================
// Market Data Factories
// ============================================

export function createCompetitorOffer(
  date: string,
  price: number,
  quantity: number = 10,
  options: { validity_window?: ValidityWindow | null } & Omit<Partial<CompetitorOffer>, 'validity_window'> = {}
): CompetitorOffer {
  // Extract validity_window option - null means explicitly no window, undefined means use default
  const { validity_window: windowOption, ...restOptions } = options;

  // If windowOption is null, don't include validity_window
  // If windowOption is undefined, use default
  // If windowOption is a ValidityWindow, use it
  const validityWindow = windowOption === null
    ? undefined
    : (windowOption ?? createValidityWindow(date));

  return {
    offer_id: `offer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    provider_id: 'competitor-provider',
    price_per_kwh: price,
    quantity_kwh: quantity,
    source_type: 'SOLAR',
    date,
    validity_window: validityWindow,
    ...restOptions
  };
}

export function createMarketAnalysis(
  competitorPrice: number | null,
  competitorsFound: number = competitorPrice ? 1 : 0,
  cached: boolean = false
): MarketAnalysis {
  return {
    competitors_found: competitorsFound,
    lowest_competitor_price: competitorPrice,
    lowest_competitor_quantity_kwh: competitorPrice ? 10 : null,
    lowest_competitor_validity_window: competitorPrice ? createValidityWindow('2026-01-28') : null,
    lowest_competitor_id: competitorPrice ? 'competitor-offer-001' : null,
    cached
  };
}

// ============================================
// Bid Factories
// ============================================

export function createCalculatedBid(
  date: string,
  quantity: number,
  price: number,
  options: Partial<CalculatedBid> = {}
): CalculatedBid {
  return {
    date,
    raw_excess_kwh: Math.round(quantity / 0.9 * 100) / 100, // Reverse buffer calculation
    buffered_quantity_kwh: quantity,
    validity_window: createValidityWindow(date),
    market_analysis: createMarketAnalysis(price > 6 ? price + 0.5 : null),
    calculated_price_inr: price,
    reasoning: price === 6 ? 'No competitors found. Bidding at floor: 6.00' : `Undercut competitor at ${price.toFixed(2)}`,
    ...options
  };
}

export function createHourlyBid(
  hour: string,
  quantity: number,
  price: number,
  date: string = '2026-01-28',
  options: Partial<HourlyBid> = {}
): HourlyBid {
  const deliveryStart = new Date(`${date}T${hour.padStart(5, '0')}:00+05:30`);
  const deliveryEnd = new Date(deliveryStart.getTime() + 60 * 60 * 1000);
  const validityStart = new Date();
  const validityEnd = new Date(deliveryStart.getTime() - 4 * 60 * 60 * 1000);

  return {
    hour,
    quantity_kwh: quantity,
    existing_usage_kwh: 0,
    generation_kwh: quantity,
    price_inr: price,
    expected_revenue_inr: Math.round(quantity * price * 100) / 100,
    delivery_window: {
      start: deliveryStart.toISOString(),
      end: deliveryEnd.toISOString()
    },
    validity_window: {
      start: validityStart.toISOString(),
      end: validityEnd.toISOString()
    },
    market_analysis: createMarketAnalysis(price > 6 ? price + 0.5 : null),
    reasoning: 'Test reasoning',
    ...options
  };
}

export function createSkippedHour(hour: string, reason: string = 'Below 1 kWh minimum'): SkippedHour {
  return { hour, reason };
}

// ============================================
// Beckn Catalog Factories
// ============================================

export function createBecknItem(
  itemId: string,
  providerId: string,
  meterId: string,
  quantity: number,
  sourceType: string = 'SOLAR'
): any {
  return {
    '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
    '@type': 'beckn:Item',
    'beckn:id': itemId,
    'beckn:descriptor': {
      '@type': 'beckn:Descriptor',
      'schema:name': `Solar Energy - Test`,
      'beckn:shortDesc': `Grid-injected solar energy from meter ${meterId}`
    },
    'beckn:provider': {
      'beckn:id': providerId,
      'beckn:descriptor': { '@type': 'beckn:Descriptor', 'schema:name': providerId }
    },
    'beckn:itemAttributes': {
      '@type': 'EnergyResource',
      sourceType,
      deliveryMode: 'GRID_INJECTION',
      meterId,
      availableQuantity: quantity,
      productionWindow: [{
        '@type': 'beckn:TimePeriod',
        'schema:startTime': '2026-01-28T08:00:00Z',
        'schema:endTime': '2026-01-28T17:00:00Z'
      }]
    }
  };
}

export function createBecknOffer(
  offerId: string,
  itemId: string,
  providerId: string,
  price: number,
  quantity: number
): any {
  return {
    '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
    '@type': 'beckn:Offer',
    'beckn:id': offerId,
    'beckn:provider': providerId,
    'beckn:items': [itemId],
    'beckn:price': {
      '@type': 'schema:PriceSpecification',
      'schema:price': price,
      'schema:priceCurrency': 'INR',
      'schema:unitText': 'kWh'
    },
    'beckn:offerAttributes': {
      '@type': 'EnergyTradeOffer',
      pricingModel: 'PER_KWH',
      minimumQuantity: 5.0,
      maximumQuantity: quantity,
      validityWindow: {
        '@type': 'beckn:TimePeriod',
        'schema:startTime': '2026-01-28T08:00:00Z',
        'schema:endTime': '2026-01-28T17:00:00Z'
      },
      'beckn:price': { value: price, currency: 'INR', unitText: 'kWh' }
    }
  };
}

export function createBecknCatalog(
  catalogId: string,
  items: any[],
  offers: any[]
): any {
  return {
    '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
    '@type': 'beckn:Catalog',
    'beckn:id': catalogId,
    'beckn:descriptor': { '@type': 'beckn:Descriptor', 'schema:name': 'Test Catalog' },
    'beckn:bppId': 'p2p.terrarexenergy.com',
    'beckn:bppUri': 'https://p2p.terrarexenergy.com/bpp/receiver',
    'beckn:isActive': true,
    'beckn:items': items,
    'beckn:offers': offers
  };
}

// ============================================
// Ledger Record Factories
// ============================================

export function createLedgerRecord(
  transactionId: string,
  options: {
    statusBuyerDiscom?: 'PENDING' | 'COMPLETED';
    statusSellerDiscom?: 'PENDING' | 'COMPLETED';
    actualDelivered?: number;
    contractedQuantity?: number;
  } = {}
): any {
  const actualDelivered = options.actualDelivered ?? 10;
  const contracted = options.contractedQuantity ?? 10;

  return {
    transactionId,
    orderItemId: `order-item-${transactionId}`,
    platformIdBuyer: 'p2p.terrarexenergy.com',
    platformIdSeller: 'p2p.terrarexenergy.com',
    discomIdBuyer: 'TPDDL',
    discomIdSeller: 'BESCOM',
    buyerId: 'buyer-001',
    sellerId: 'seller-001',
    tradeTime: new Date().toISOString(),
    deliveryStartTime: '2026-01-28T08:00:00Z',
    deliveryEndTime: '2026-01-28T17:00:00Z',
    tradeDetails: [{ tradeQty: contracted, tradeType: 'PURCHASE', tradeUnit: 'kWh' }],
    statusBuyerDiscom: options.statusBuyerDiscom ?? 'PENDING',
    statusSellerDiscom: options.statusSellerDiscom ?? 'PENDING',
    buyerFulfillmentValidationMetrics: [
      { validationMetricType: 'ACTUAL_PUSHED', validationMetricValue: actualDelivered }
    ],
    sellerFulfillmentValidationMetrics: [
      { validationMetricType: 'ACTUAL_DELIVERED', validationMetricValue: actualDelivered }
    ]
  };
}

// ============================================
// CDS Response Factories
// ============================================

export function createCDSResponse(catalogs: any[]): any {
  return {
    message: { catalogs }
  };
}

export function createCDSCatalogWithOffers(
  offers: Array<{ price: number; quantity: number; date: string }>
): any {
  const catalogOffers = offers.map((o, idx) => ({
    'beckn:id': `offer-${idx}`,
    'beckn:provider': 'competitor-provider',
    'beckn:price': { 'schema:price': o.price },
    'beckn:offerAttributes': {
      validityWindow: {
        'schema:startTime': `${o.date}T08:00:00Z`,
        'schema:endTime': `${o.date}T17:00:00Z`
      }
    }
  }));

  return {
    'beckn:id': 'competitor-catalog',
    'beckn:offers': catalogOffers,
    'beckn:items': [{ 'beckn:itemAttributes': { availableQuantity: 10 } }]
  };
}

// ============================================
// Beckn Context Factories
// ============================================

export function createBecknContext(action: string, transactionId?: string): any {
  return {
    version: '2.0.0',
    action,
    timestamp: new Date().toISOString(),
    message_id: `msg-${Date.now()}`,
    transaction_id: transactionId || `txn-${Date.now()}`,
    bap_id: 'p2p.terrarexenergy.com',
    bap_uri: 'https://p2p.terrarexenergy.com/bap/receiver',
    bpp_id: 'p2p.terrarexenergy.com',
    bpp_uri: 'https://p2p.terrarexenergy.com/bpp/receiver',
    ttl: 'PT30S',
    domain: 'beckn.one:deg:p2p-trading-interdiscom:2.0.0'
  };
}

// ============================================
// Async Test Helpers
// ============================================

export async function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
