#!/usr/bin/env node

const fs = require('fs');
const readline = require('readline');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');

// Fixed BAP config
const BAP = {
  id: "p2p.terrarexenergy.com",
  uri: "https://p2p.terrarexenergy.com/bap/receiver"
};

// Schema context URL for EnergyTrade v0.3
const ENERGY_TRADE_CONTEXT = 'https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld';

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = q => new Promise(r => rl.question(q, r));

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node select-builder.js <catalog.json> [--copy]');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Support both direct catalog and on_discover response formats
  const catalog = data.message?.catalogs?.[0] || data;
  const bppId = catalog['beckn:bppId'] || data.context?.bpp_id;
  const bppUri = catalog['beckn:bppUri'] || data.context?.bpp_uri;
  const items = catalog['beckn:items'] || [];
  const offers = catalog['beckn:offers'] || [];

  if (!bppId || !bppUri) { console.error('ERROR: Missing bpp_id/bpp_uri'); process.exit(1); }
  if (!items.length || !offers.length) { console.error('ERROR: No items/offers'); process.exit(1); }

  // Show items
  console.error('\nItems:');
  items.forEach((item, i) => {
    const id = item['beckn:id'];
    const qty = item['beckn:itemAttributes']?.availableQuantity || '?';
    console.error(`  [${i + 1}] ${id} (${qty} kWh)`);
  });

  // Select item
  const itemIdx = items.length === 1 ? 0 : parseInt(await ask('\nItem [1]: ') || '1') - 1;
  const item = items[itemIdx];
  const itemId = item['beckn:id'];

  // Filter offers for this item
  const itemOffers = offers.filter(o => o['beckn:items']?.includes(itemId));
  console.error('\nOffers:');
  itemOffers.forEach((offer, i) => {
    const price = offer['beckn:offerAttributes']?.['beckn:price'] || offer['beckn:price'];
    const val = price?.value ?? price?.['schema:price'] ?? '?';
    console.error(`  [${i + 1}] ${offer['beckn:id']} (${val} INR/kWh)`);
  });

  // Select offer
  const offerIdx = itemOffers.length === 1 ? 0 : parseInt(await ask('\nOffer [1]: ') || '1') - 1;
  const offer = itemOffers[offerIdx];
  const offerAttrs = offer['beckn:offerAttributes'] || {};

  // Get quantity
  const min = offerAttrs.minimumQuantity || 0;
  const max = offerAttrs.maximumQuantity || 999999;
  console.error(`\nQuantity (${min}-${max} kWh):`);
  const qty = parseFloat(await ask('> '));
  if (qty < min || qty > max) { console.error('ERROR: Invalid quantity'); process.exit(1); }

  // Get buyer info (defaults from HEAD ADMIN BRPL's ConsumptionProfileCredential)
  const buyerId = await ask('Buyer ID [buyer-152685823]: ') || 'buyer-152685823';
  const buyerMeterId = await ask('Buyer Meter ID [41410739]: ') || '41410739';
  const buyerUtilityCustomerId = await ask('Buyer Utility Customer ID [152685823]: ') || '152685823';
  const buyerUtilityId = await ask('Buyer Utility ID [BRPL]: ') || 'BRPL';
  rl.close();

  // Build request
  const provider = offer['beckn:provider'] || item['beckn:provider']?.['beckn:id'] || 'unknown';

  // Extract seller/provider attributes from catalog
  const providerAttrs = item['beckn:provider']?.['beckn:providerAttributes'] || {};
  const sellerMeterId = providerAttrs.meterId || item['beckn:itemAttributes']?.meterId || 'unknown';
  const sellerUtilityCustomerId = providerAttrs.utilityCustomerId || 'unknown';
  const sellerUtilityId = providerAttrs.utilityId || 'unknown';

  const request = {
    context: {
      version: "2.0.0",
      action: "select",
      timestamp: new Date().toISOString(),
      message_id: `sel-${uuidv4().slice(0, 8)}`,
      transaction_id: `txn-${uuidv4().slice(0, 16)}`,
      bap_id: BAP.id,
      bap_uri: BAP.uri,
      bpp_id: bppId,
      bpp_uri: bppUri,
      ttl: "PT30S",
      domain: "beckn.one:deg:p2p-trading-interdiscom:2.0.0"
    },
    message: {
      order: {
        "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
        "@type": "beckn:Order",
        "beckn:orderStatus": "CREATED",
        "beckn:seller": provider,
        "beckn:buyer": {
          "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Buyer",
          "beckn:id": buyerId,
          "beckn:buyerAttributes": {
            "@context": ENERGY_TRADE_CONTEXT,
            "@type": "EnergyCustomer",
            "meterId": buyerMeterId,
            "utilityCustomerId": buyerUtilityCustomerId,
            "utilityId": buyerUtilityId
          }
        },
        "beckn:orderAttributes": {
          "@context": ENERGY_TRADE_CONTEXT,
          "@type": "EnergyTradeOrder",
          "bap_id": BAP.id,
          "bpp_id": bppId,
          "total_quantity": {
            "unitQuantity": qty,
            "unitText": "kWh"
          }
        },
        "beckn:orderItems": [{
          "beckn:orderedItem": itemId,
          "beckn:orderItemAttributes": {
            "@context": ENERGY_TRADE_CONTEXT,
            "@type": "EnergyOrderItem",
            "providerAttributes": {
              "@context": ENERGY_TRADE_CONTEXT,
              "@type": "EnergyCustomer",
              "meterId": sellerMeterId,
              "utilityCustomerId": sellerUtilityCustomerId,
              "utilityId": sellerUtilityId
            }
          },
          "beckn:quantity": { "unitQuantity": qty, "unitText": "kWh" },
          "beckn:acceptedOffer": {
            "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
            "@type": "beckn:Offer",
            "beckn:id": offer['beckn:id'],
            "beckn:descriptor": offer['beckn:descriptor'],
            "beckn:provider": provider,
            "beckn:items": [itemId],
            "beckn:price": offer['beckn:price'],
            "beckn:offerAttributes": {
              "@context": ENERGY_TRADE_CONTEXT,
              "@type": "EnergyTradeOffer",
              ...offerAttrs
            }
          }
        }]
      }
    }
  };

  const json = JSON.stringify(request, null, 2);

  if (process.argv.includes('--copy')) {
    execSync('pbcopy', { input: json });
    console.error('\n✓ Copied to clipboard');
  } else {
    console.log(json);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
