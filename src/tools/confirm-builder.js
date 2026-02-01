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
    console.error('Usage: node confirm-builder.js <init-response.json> [--copy]');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Extract from on_init response
  const initCtx = data.context;
  const order = data.message?.order;

  if (!initCtx || !order) {
    console.error('ERROR: Invalid on_init response format');
    process.exit(1);
  }

  const bppId = initCtx.bpp_id;
  const bppUri = initCtx.bpp_uri;
  const transactionId = initCtx.transaction_id;

  // Show order summary
  console.error('\n=== on_init Order Summary ===');
  console.error(`Transaction ID: ${transactionId}`);
  console.error(`Seller: ${order['beckn:seller']}`);
  console.error(`Buyer: ${order['beckn:buyer']?.['beckn:id']}`);
  console.error(`Total Quantity: ${order['beckn:orderAttributes']?.total_quantity} kWh`);

  const payment = order['beckn:payment'];
  const amount = payment?.['beckn:amount'];
  console.error(`\nPayment Amount: ${amount?.value} ${amount?.currency}`);
  console.error(`Payment Status: ${payment?.['beckn:paymentStatus']}`);

  // Get existing buyer settlement account
  const existingAccounts = payment?.['beckn:paymentAttributes']?.settlementAccounts || [];
  const buyerAccount = existingAccounts[0];

  if (buyerAccount) {
    console.error(`\nBuyer Account: ${buyerAccount.accountHolderName} (${buyerAccount.bankName})`);
  }

  // Get seller settlement account details
  console.error('\n=== Seller Settlement Account ===');
  const sellerAccountHolder = await ask('Seller Account Holder [Solar Provider Pvt Ltd]: ') || 'Solar Provider Pvt Ltd';
  const sellerAccountNumber = await ask('Seller Account Number [9876543210]: ') || '9876543210';
  const sellerIfscCode = await ask('Seller IFSC Code [ICICI0005678]: ') || 'ICICI0005678';
  const sellerBankName = await ask('Seller Bank Name [ICICI Bank]: ') || 'ICICI Bank';
  const sellerVpa = await ask('Seller UPI VPA [solar-provider@upi]: ') || 'solar-provider@upi';
  rl.close();

  // Build settlement accounts array (buyer + seller)
  const settlementAccounts = [];

  // Add buyer account (from on_init or default)
  if (buyerAccount) {
    settlementAccounts.push(buyerAccount);
  } else {
    settlementAccounts.push({
      beneficiaryId: BAP.id,
      accountHolderName: "Energy Consumer Pvt Ltd",
      accountNumber: "1234567890",
      ifscCode: "HDFC0001234",
      bankName: "HDFC Bank",
      vpa: "energy-buyer@upi"
    });
  }

  // Add seller account
  settlementAccounts.push({
    beneficiaryId: bppId,
    accountHolderName: sellerAccountHolder,
    accountNumber: sellerAccountNumber,
    ifscCode: sellerIfscCode,
    bankName: sellerBankName,
    vpa: sellerVpa
  });

  // Build confirm request
  const request = {
    context: {
      version: "2.0.0",
      action: "confirm",
      timestamp: new Date().toISOString(),
      message_id: `confirm-${uuidv4().slice(0, 8)}`,
      transaction_id: transactionId,
      bap_id: BAP.id,
      bap_uri: BAP.uri,
      bpp_id: bppId,
      bpp_uri: bppUri,
      ttl: "PT30S",
      domain: initCtx.domain || "beckn.one:deg:p2p-trading:2.0.0"
    },
    message: {
      order: {
        "@context": order['@context'],
        "@type": order['@type'],
        "beckn:orderStatus": order['beckn:orderStatus'],
        "beckn:seller": order['beckn:seller'],
        "beckn:buyer": order['beckn:buyer'],
        "beckn:orderAttributes": order['beckn:orderAttributes'],
        "beckn:orderItems": order['beckn:orderItems'],
        "beckn:fulfillment": order['beckn:fulfillment'],
        "beckn:payment": {
          "@context": payment?.['@context'] || "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": payment?.['@type'] || "beckn:Payment",
          "beckn:id": payment?.['beckn:id'] || `payment-${uuidv4().slice(0, 8)}`,
          "beckn:amount": amount,
          "beckn:beneficiary": payment?.['beckn:beneficiary'] || "BPP",
          "beckn:paymentStatus": "AUTHORIZED",
          "beckn:paymentAttributes": {
            "@context": "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/PaymentSettlement/v1/context.jsonld",
            "@type": "PaymentSettlement",
            "settlementAccounts": settlementAccounts
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
