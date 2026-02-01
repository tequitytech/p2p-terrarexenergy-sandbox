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

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = q => new Promise(r => rl.question(q, r));

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node init-builder.js <select-response.json> [--copy]');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Extract from on_select response
  const selectCtx = data.context;
  const order = data.message?.order;

  if (!selectCtx || !order) {
    console.error('ERROR: Invalid on_select response format');
    process.exit(1);
  }

  const bppId = selectCtx.bpp_id;
  const bppUri = selectCtx.bpp_uri;
  const transactionId = selectCtx.transaction_id;

  // Show order summary
  console.error('\n=== on_select Order Summary ===');
  console.error(`Seller: ${order['beckn:seller']}`);
  console.error(`Buyer: ${order['beckn:buyer']?.['beckn:id']}`);
  console.error(`Total Quantity: ${order['beckn:orderAttributes']?.total_quantity} kWh`);

  const orderItems = order['beckn:orderItems'] || [];
  console.error(`\nOrder Items (${orderItems.length}):`);

  let totalAmount = 0;
  let currency = 'INR';

  orderItems.forEach((item, i) => {
    const qty = item['beckn:quantity']?.unitQuantity || 0;
    const price = item['beckn:acceptedOffer']?.['beckn:offerAttributes']?.['beckn:price'];
    const priceVal = price?.value || 0;
    currency = price?.currency || 'INR';
    const itemTotal = qty * priceVal;
    totalAmount += itemTotal;
    console.error(`  [${i + 1}] ${qty} kWh @ ${priceVal} ${currency} = ${itemTotal.toFixed(2)} ${currency}`);
  });

  console.error(`\nCalculated Total: ${totalAmount.toFixed(2)} ${currency}`);

  // Get buyer meter ID
  const buyerMeterId = await ask('\nBuyer Meter ID [98765456]: ') || '98765456';

  // Get payment details
  console.error('\n=== Payment Details ===');
  const accountHolder = await ask('Account Holder Name [Energy Consumer Pvt Ltd]: ') || 'Energy Consumer Pvt Ltd';
  const accountNumber = await ask('Account Number [1234567890]: ') || '1234567890';
  const ifscCode = await ask('IFSC Code [HDFC0001234]: ') || 'HDFC0001234';
  const bankName = await ask('Bank Name [HDFC Bank]: ') || 'HDFC Bank';
  const vpa = await ask('UPI VPA [energy-buyer@upi]: ') || 'energy-buyer@upi';
  rl.close();

  // Build init request
  const request = {
    context: {
      version: "2.0.0",
      action: "init",
      timestamp: new Date().toISOString(),
      message_id: `init-${uuidv4().slice(0, 8)}`,
      transaction_id: transactionId,
      bap_id: BAP.id,
      bap_uri: BAP.uri,
      bpp_id: bppId,
      bpp_uri: bppUri,
      ttl: "PT30S",
      domain: selectCtx.domain || "beckn.one:deg:p2p-trading-interdiscom:2.0.0"
    },
    message: {
      order: {
        "@context": order['@context'],
        "@type": order['@type'],
        "beckn:orderStatus": order['beckn:orderStatus'],
        "beckn:seller": order['beckn:seller'],
        "beckn:buyer": order['beckn:buyer'],
        "beckn:orderAttributes": order['beckn:orderAttributes'],
        "beckn:orderItems": orderItems.map(item => ({
          ...item,
          "beckn:orderItemAttributes": {
            ...item['beckn:orderItemAttributes'],
            "providerAttributes": {
              ...item['beckn:orderItemAttributes']?.providerAttributes,
              "meterId": buyerMeterId
            }
          }
        })),
        "beckn:fulfillment": {
          "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Fulfillment",
          "beckn:id": `fulfillment-${uuidv4().slice(0, 8)}`,
          "beckn:mode": "DELIVERY"
        },
        "beckn:payment": {
          "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Payment",
          "beckn:id": `payment-${uuidv4().slice(0, 8)}`,
          "beckn:amount": {
            "currency": currency,
            "value": parseFloat(totalAmount.toFixed(2))
          },
          "beckn:beneficiary": "BPP",
          "beckn:paymentStatus": "INITIATED",
          "beckn:paymentAttributes": {
            "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/PaymentSettlement/v1/context.jsonld",
            "@type": "PaymentSettlement",
            "settlementAccounts": [{
              "beneficiaryId": BAP.id,
              "accountHolderName": accountHolder,
              "accountNumber": accountNumber,
              "ifscCode": ifscCode,
              "bankName": bankName,
              "vpa": vpa
            }]
          }
        }
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
