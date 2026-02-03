#!/usr/bin/env node

const readline = require('readline');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');

const BAP = {
  id: "p2p.terrarexenergy.com",
  uri: "https://p2p.terrarexenergy.com/bap/receiver"
};

const BPP = {
  id: "p2p.terrarexenergy.com",
  uri: "https://p2p.terrarexenergy.com/bpp/receiver"
};

const SCHEMA = {
  core: "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
  energy: "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld"
};

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = q => new Promise(r => rl.question(q, r));

async function main() {
  // Prosumer details
  console.error('\n=== Prosumer Details ===');
  const fullName = await ask('Prosumer Name [Lata Deka]: ') || 'Lata Deka';
  const meterId = await ask('Meter Number [41434064]: ') || '41434064';
  const utilityId = await ask('Utility [BRPL]: ') || 'BRPL';
  const consumerNumber = await ask('Consumer Number [152630256]: ') || '152630256';
  const providerId = await ask('Provider DID [did:rcw:consumption-152630256-1769510076218]: ') || 'did:rcw:consumption-152630256-1769510076218';

  // Offer details
  console.error('\n=== Offer Details ===');
  const sourceType = await ask('Source Type [SOLAR]: ') || 'SOLAR';
  const quantity = parseFloat(await ask('Quantity kWh [7]: ') || '7');
  const price = parseFloat(await ask('Price INR/kWh [4.50]: ') || '4.50');

  // Delivery window
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDate = tomorrow.toISOString().split('T')[0];

  const deliveryDate = await ask(`Delivery Date [${defaultDate}]: `) || defaultDate;
  const startHour = parseInt(await ask('Delivery Start Hour [10]: ') || '10');
  const duration = parseInt(await ask('Duration Hours [1]: ') || '1');
  rl.close();

  // Build time windows (round hours only, no :30s)
  const deliveryStart = `${deliveryDate}T${String(startHour).padStart(2,'0')}:00:00.000Z`;
  const deliveryEnd = `${deliveryDate}T${String(startHour + duration).padStart(2,'0')}:00:00.000Z`;

  // Validity: next round hour from now until 1 hour before delivery
  const now = new Date();
  const validityStartHour = now.getUTCHours() + 1;
  const todayDate = now.toISOString().split('T')[0];
  const validityStart = `${todayDate}T${String(validityStartHour).padStart(2,'0')}:00:00.000Z`;
  const validityEnd = `${deliveryDate}T${String(startHour - 1).padStart(2,'0')}:00:00.000Z`;

  // Build catalog IDs
  const catalogId = `catalog-${meterId}-${Date.now()}`;
  const itemId = `item-${meterId}-${Date.now()}`;
  const offerId = `offer-${meterId}-${Date.now()}`;

  const request = {
    context: {
      version: "2.0.0",
      action: "catalog_publish",
      timestamp: new Date().toISOString(),
      message_id: uuidv4(),
      transaction_id: uuidv4(),
      bap_id: BAP.id,
      bap_uri: BAP.uri,
      bpp_id: BPP.id,
      bpp_uri: BPP.uri,
      ttl: "PT30S",
      domain: "beckn.one:deg:p2p-trading-interdiscom:2.0.0"
    },
    message: {
      catalogs: [{
        "@context": SCHEMA.core,
        "@type": "beckn:Catalog",
        "beckn:id": catalogId,
        "beckn:descriptor": {
          "@type": "beckn:Descriptor",
          "schema:name": `Solar Energy Trading Catalog - ${fullName}`
        },
        "beckn:bppId": BPP.id,
        "beckn:bppUri": BPP.uri,
        "beckn:items": [{
          "@context": SCHEMA.core,
          "@type": "beckn:Item",
          "beckn:networkId": ["p2p-interdiscom-trading-pilot-network"],
          "beckn:isActive": true,
          "beckn:id": itemId,
          "beckn:descriptor": {
            "@type": "beckn:Descriptor",
            "schema:name": `Solar Energy - ${quantity} kWh`,
            "beckn:shortDesc": `Rooftop Solar from ${utilityId} Prosumer`,
            "beckn:longDesc": `Clean solar energy from ${utilityId} net-metered installation`
          },
          "beckn:provider": {
            "beckn:id": providerId,
            "beckn:descriptor": {
              "@type": "beckn:Descriptor",
              "schema:name": `${fullName} - ${utilityId} Prosumer`
            },
            "beckn:providerAttributes": {
              "@context": SCHEMA.energy,
              "@type": "EnergyCustomer",
              "meterId": meterId,
              "utilityId": utilityId,
              "utilityCustomerId": consumerNumber
            }
          },
          "beckn:itemAttributes": {
            "@context": SCHEMA.energy,
            "@type": "EnergyResource",
            "sourceType": sourceType,
            "meterId": meterId
          }
        }],
        "beckn:offers": [{
          "@context": SCHEMA.core,
          "@type": "beckn:Offer",
          "beckn:id": offerId,
          "beckn:descriptor": {
            "@type": "beckn:Descriptor",
            "schema:name": `Solar Energy Offer - ${startHour}:00-${startHour + duration}:00`
          },
          "beckn:provider": providerId,
          "beckn:items": [itemId],
          "beckn:price": {
            "@type": "schema:PriceSpecification",
            "schema:price": price,
            "schema:priceCurrency": "INR",
            "unitText": "kWh",
            "applicableQuantity": {
              "unitQuantity": quantity,
              "unitText": "kWh"
            }
          },
          "beckn:offerAttributes": {
            "@context": SCHEMA.energy,
            "@type": "EnergyTradeOffer",
            "pricingModel": "PER_KWH",
            "deliveryWindow": {
              "@type": "beckn:TimePeriod",
              "schema:startTime": deliveryStart,
              "schema:endTime": deliveryEnd
            },
            "validityWindow": {
              "@type": "beckn:TimePeriod",
              "schema:startTime": validityStart,
              "schema:endTime": validityEnd
            }
          }
        }]
      }]
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
