import { v4 as uuidv4 } from 'uuid';
import { HourlyBid, VALIDITY_BUFFER_HOURS } from '../types';
import {
  BECKN_CONTEXT_ROOT,
  ENERGY_RESOURCE_SCHEMA_CTX,
  ENERGY_TRADE_OFFER_SCHEMA_CTX
} from '../../constants/schemas';

/**
 * Generate unique IDs for catalog elements (includes timestamp + hour for uniqueness)
 */
function generateCatalogId(providerId: string, date: string, hour: string): string {
  const hourClean = hour.replace(':', '');
  return `catalog-${providerId}-${date}-${hourClean}-${Date.now()}`;
}

function generateItemId(providerId: string, date: string, hour: string): string {
  const hourClean = hour.replace(':', '');
  return `item-${providerId}-${date}-${hourClean}-${Date.now()}`;
}

function generateOfferId(providerId: string, date: string, hour: string): string {
  const hourClean = hour.replace(':', '');
  return `offer-${providerId}-${date}-${hourClean}-${Date.now()}`;
}

/**
 * Build delivery window for a 1-hour slot
 * e.g., hour "12:00" on 2026-01-28 → 12:00-13:00 IST
 */
export function buildDeliveryWindow(date: string, hour: string): { start: string; end: string } {
  const [hourNum] = hour.split(':').map(Number);

  // Start of hour
  const start = new Date(`${date}T${hour.padStart(5, '0')}:00+05:30`);

  // End of hour (1 hour later)
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

/**
 * Build validity window: starts "now", expires 4 hours before delivery start
 * This means buyers can accept the offer from creation until 4 hours before delivery.
 */
export function buildValidityWindow(date: string, hour: string): { start: string; end: string } {
  const delivery = buildDeliveryWindow(date, hour);

  // Validity starts now (when offer is created)
  const validityStart = new Date();

  // Validity ends 4 hours before delivery starts (offer expires then)
  const validityEnd = new Date(new Date(delivery.start).getTime() - VALIDITY_BUFFER_HOURS * 60 * 60 * 1000);

  return {
    start: validityStart.toISOString(),
    end: validityEnd.toISOString()
  };
}

/**
 * Build a Beckn Item with EnergyResource attributes for hourly bid
 */
export function buildHourlyItem(params: {
  provider_id: string;
  meter_id: string;
  source_type: string;
  date: string;
  hour: string;
  quantity: number;
  deliveryWindow: { start: string; end: string };
}): any {
  const itemId = generateItemId(params.provider_id, params.date, params.hour);

  return {
    "@context": BECKN_CONTEXT_ROOT,
    "@type": "beckn:Item",
    "beckn:id": itemId,
    "beckn:networkId": ["p2p-interdiscom-trading-pilot-network"],
    "beckn:isActive": true,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": `Solar Energy - ${params.date} ${params.hour}`,
      "beckn:shortDesc": `Grid-injected solar energy from meter ${params.meter_id} for ${params.hour}-${getNextHour(params.hour)}`,
      "beckn:longDesc": `Clean solar energy available for P2P trading on ${params.date} from ${params.hour} to ${getNextHour(params.hour)}`
    },
    "beckn:provider": {
      "beckn:id": params.provider_id,
      "beckn:descriptor": {
        "@type": "beckn:Descriptor",
        "schema:name": params.provider_id
      }
    },
    "beckn:itemAttributes": {
      "@context": ENERGY_RESOURCE_SCHEMA_CTX,
      "@type": "EnergyResource",
      "sourceType": params.source_type,
      "deliveryMode": "GRID_INJECTION",
      "certificationStatus": "BESCOM Net Metered",
      "meterId": params.meter_id,
      "availableQuantity": params.quantity,
      "productionWindow": [
        {
          "@type": "beckn:TimePeriod",
          "schema:startTime": params.deliveryWindow.start,
          "schema:endTime": params.deliveryWindow.end
        }
      ],
      "sourceVerification": {
        "verified": true,
        "verificationDate": new Date().toISOString().split('T')[0] + "T00:00:00Z",
        "certificates": [`BESCOM-NM-${params.meter_id}`]
      }
    }
  };
}

/**
 * Get next hour string (e.g., "12:00" -> "13:00")
 */
function getNextHour(hour: string): string {
  const [hourNum] = hour.split(':').map(Number);
  const nextHour = (hourNum + 1) % 24;
  return `${nextHour.toString().padStart(2, '0')}:00`;
}

/**
 * Build a Beckn Offer with EnergyTradeOffer attributes for hourly bid
 */
export function buildHourlyOffer(params: {
  provider_id: string;
  meter_id: string;
  item_id: string;
  date: string;
  hour: string;
  price: number;
  quantity: number;
  validityWindow: { start: string; end: string };
}): any {
  const offerId = generateOfferId(params.provider_id, params.date, params.hour);

  return {
    "@context": BECKN_CONTEXT_ROOT,
    "@type": "beckn:Offer",
    "beckn:id": offerId,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": `Solar Offer - ${params.date} ${params.hour}`
    },
    "beckn:provider": params.provider_id,
    "beckn:items": [params.item_id],
    "beckn:price": {
      "@type": "schema:PriceSpecification",
      "schema:price": params.price,
      "schema:priceCurrency": "INR",
      "schema:unitText": "kWh"
    },
    "beckn:offerAttributes": {
      "@context": ENERGY_TRADE_OFFER_SCHEMA_CTX,
      "@type": "EnergyTradeOffer",
      "pricingModel": "PER_KWH",
      "settlementType": "HOURLY",
      "sourceMeterId": params.meter_id,
      "wheelingCharges": {
        "amount": 0.40,
        "currency": "INR",
        "description": "BESCOM inter-discom wheeling charge"
      },
      "minimumQuantity": 1.0,  // Hourly minimum is 1 kWh
      "maximumQuantity": params.quantity,
      "validityWindow": {
        "@type": "beckn:TimePeriod",
        "schema:startTime": params.validityWindow.start,
        "schema:endTime": params.validityWindow.end
      },
      "beckn:price": {
        "value": params.price,
        "currency": "INR",
        "unitText": "kWh"
      },
      "beckn:maxQuantity": {
        "unitQuantity": params.quantity,
        "unitText": "kWh",
        "unitCode": "KWH"
      },
      "beckn:timeWindow": {
        "@type": "beckn:TimePeriod",
        "schema:startTime": params.validityWindow.start,
        "schema:endTime": params.validityWindow.end
      }
    }
  };
}

/**
 * Build a complete Beckn Catalog for a single hour's bid
 */
export function buildHourlyCatalog(params: {
  provider_id: string;
  meter_id: string;
  source_type: string;
  date: string;
  bid: HourlyBid;
}): any {
  const catalogId = generateCatalogId(params.provider_id, params.date, params.bid.hour);
  const itemId = generateItemId(params.provider_id, params.date, params.bid.hour);

  const item = buildHourlyItem({
    provider_id: params.provider_id,
    meter_id: params.meter_id,
    source_type: params.source_type,
    date: params.date,
    hour: params.bid.hour,
    quantity: params.bid.quantity_kwh,
    deliveryWindow: params.bid.delivery_window
  });

  const offer = buildHourlyOffer({
    provider_id: params.provider_id,
    meter_id: params.meter_id,
    item_id: itemId,
    date: params.date,
    hour: params.bid.hour,
    price: params.bid.price_inr,
    quantity: params.bid.quantity_kwh,
    validityWindow: params.bid.validity_window
  });

  return {
    "@context": BECKN_CONTEXT_ROOT,
    "@type": "beckn:Catalog",
    "beckn:id": catalogId,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": `${params.provider_id} Solar Catalog - ${params.date} ${params.bid.hour}`,
      "beckn:shortDesc": `Optimized solar energy offer for ${params.date} ${params.bid.hour}-${getNextHour(params.bid.hour)}`
    },
    "beckn:bppId": "p2p.terrarexenergy.com",
    "beckn:bppUri": "https://p2p.terrarexenergy.com/bpp/receiver",
    "beckn:isActive": true,
    "beckn:items": [item],
    "beckn:offers": [offer]
  };
}

/**
 * Build full publish request payload for hourly bid
 */
export function buildHourlyPublishRequest(params: {
  provider_id: string;
  meter_id: string;
  source_type: string;
  date: string;
  bid: HourlyBid;
}): any {
  const catalog = buildHourlyCatalog(params);

  return {
    context: {
      version: "2.0.0",
      action: "catalog_publish",
      timestamp: new Date().toISOString(),
      message_id: uuidv4(),
      transaction_id: uuidv4(),
      bap_id: "p2p.terrarexenergy.com",
      bap_uri: "https://p2p.terrarexenergy.com/bap/receiver",
      bpp_id: "p2p.terrarexenergy.com",
      bpp_uri: "https://p2p.terrarexenergy.com/bpp/receiver",
      ttl: "PT30S",
      domain: "beckn.one:deg:p2p-trading-interdiscom:2.0.0"
    },
    message: {
      catalogs: [catalog]
    }
  };
}

/**
 * Extract IDs from a catalog for response
 */
export function extractHourlyIds(catalog: any): { catalog_id: string; item_id: string; offer_id: string } {
  return {
    catalog_id: catalog['beckn:id'],
    item_id: catalog['beckn:items']?.[0]?.['beckn:id'] || 'unknown',
    offer_id: catalog['beckn:offers']?.[0]?.['beckn:id'] || 'unknown'
  };
}
