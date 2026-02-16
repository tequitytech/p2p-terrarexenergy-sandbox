import { v4 as uuidv4 } from 'uuid';

import {
  BECKN_CONTEXT_ROOT,
  ENERGY_RESOURCE_SCHEMA_CTX,
  ENERGY_TRADE_OFFER_SCHEMA_CTX,
  NETWORK_ID
} from '../../constants/schemas';

import type { CalculatedBid, ValidityWindow } from '../types';

/**
 * Generate unique IDs for catalog elements (includes timestamp for uniqueness)
 */
function generateCatalogId(providerId: string, date: string): string {
  return `catalog-${providerId}-${date}-${Date.now()}`;
}

function generateItemId(providerId: string, date: string): string {
  return `item-${providerId}-${date}-${Date.now()}`;
}

function generateOfferId(providerId: string, date: string): string {
  return `offer-${providerId}-${date}-${Date.now()}`;
}

/**
 * Build a Beckn Item with EnergyResource attributes
 */
export function buildItem(params: {
  provider_id: string;
  meter_id: string;
  source_type: string;
  date: string;
  quantity: number;
  validityWindow: ValidityWindow;
}): any {
  const itemId = generateItemId(params.provider_id, params.date);

  return {
    "@context": BECKN_CONTEXT_ROOT,
    "@type": "beckn:Item",
    "beckn:id": itemId,
    "beckn:networkId": [NETWORK_ID],
    "beckn:isActive": true,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": `Solar Energy - ${params.date}`,
      "beckn:shortDesc": `Grid-injected solar energy from meter ${params.meter_id}`,
      "beckn:longDesc": `Clean solar energy available for P2P trading on ${params.date}`
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
          "schema:startTime": params.validityWindow.start,
          "schema:endTime": params.validityWindow.end
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
 * Build a Beckn Offer with EnergyTradeOffer attributes
 */
export function buildOffer(params: {
  provider_id: string;
  item_id: string;
  date: string;
  price: number;
  quantity: number;
  validityWindow: ValidityWindow;
}): any {
  const offerId = generateOfferId(params.provider_id, params.date);

  return {
    "@context": BECKN_CONTEXT_ROOT,
    "@type": "beckn:Offer",
    "beckn:id": offerId,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": `Solar Offer - ${params.date}`
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
      "settlementType": "DAILY",
      "sourceMeterId": params.provider_id,
      "wheelingCharges": {
        "amount": 0,
        "currency": "INR",
        "description": "Wheeling charge"
      },
      "minimumQuantity": 5.0,
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
 * Build a complete Beckn Catalog for a single day's bid
 */
export function buildCatalog(params: {
  provider_id: string;
  meter_id: string;
  source_type: string;
  bid: CalculatedBid;
}): any {
  const catalogId = generateCatalogId(params.provider_id, params.bid.date);
  const itemId = generateItemId(params.provider_id, params.bid.date);

  const item = buildItem({
    provider_id: params.provider_id,
    meter_id: params.meter_id,
    source_type: params.source_type,
    date: params.bid.date,
    quantity: params.bid.buffered_quantity_kwh,
    validityWindow: params.bid.validity_window
  });

  const offer = buildOffer({
    provider_id: params.provider_id,
    item_id: itemId,
    date: params.bid.date,
    price: params.bid.calculated_price_inr,
    quantity: params.bid.buffered_quantity_kwh,
    validityWindow: params.bid.validity_window
  });

  return {
    "@context": BECKN_CONTEXT_ROOT,
    "@type": "beckn:Catalog",
    "beckn:id": catalogId,
    "beckn:descriptor": {
      "@type": "beckn:Descriptor",
      "schema:name": `${params.provider_id} Solar Catalog - ${params.bid.date}`,
      "beckn:shortDesc": `Optimized solar energy offer for ${params.bid.date}`
    },
    "beckn:bppId": "p2p.terrarexenergy.com",
    "beckn:bppUri": "https://p2p.terrarexenergy.com/bpp/receiver",
    "beckn:isActive": true,
    "beckn:items": [item],
    "beckn:offers": [offer]
  };
}

/**
 * Build full publish request payload
 */
export function buildPublishRequest(params: {
  provider_id: string;
  meter_id: string;
  source_type: string;
  bid: CalculatedBid;
}): any {
  const catalog = buildCatalog(params);

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
export function extractIds(catalog: any): { catalog_id: string; item_id: string; offer_id: string } {
  return {
    catalog_id: catalog['beckn:id'],
    item_id: catalog['beckn:items']?.[0]?.['beckn:id'] || 'unknown',
    offer_id: catalog['beckn:offers']?.[0]?.['beckn:id'] || 'unknown'
  };
}
