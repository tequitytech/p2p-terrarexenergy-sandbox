
export const BECKN_CONTEXT_ROOT = "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/tags/core-2.0.0-rc-eos-release/schema/core/v2/context.jsonld";

//after change the url while publish we got the error so again changed to the old one
// export const BECKN_CONTEXT_ROOT = "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld";

// DEG P2P Trading uses consolidated EnergyTrade schema from protocol-specifications-v2
export const ENERGY_TRADE_SCHEMA_CTX = "https://raw.githubusercontent.com/beckn/DEG/tags/deg-1.0.0/specification/schema/EnergyTrade/v0.3/context.jsonld";

// export const ENERGY_TRADE_SCHEMA_CTX = "https://raw.githubusercontent.com/beckn/DEG/refs/heads/p2p-trading/specification/schema/EnergyTrade/v0.3/context.jsonld";
// All energy schemas point to consolidated EnergyTrade/v0.3
export const ENERGY_RESOURCE_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_TRADE_OFFER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_TRADE_ORDER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_ORDER_ITEM_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_TRADE_DELIVERY_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_CUSTOMER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_DISCOVER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;

// Payment settlement schema for init/confirm flows
export const PAYMENT_SETTLEMENT_SCHEMA_CTX = "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/PaymentSettlement/v1/context.jsonld";

// Network identifier for P2P inter-discom trading
export const NETWORK_ID = process.env.NETWORK_ID || "p2p-interdiscom-trading-pilot-network";
export const MOCK_NETWORK_ID = process.env.MOCK_NETWORK_ID || "p2p-interdiscom-trading-aisummit-inbooth";

// Policy Constants
export const MIN_DELIVERY_GAP_HOURS = 4;
export const MIN_VALIDITY_GAP_HOURS = 4;
