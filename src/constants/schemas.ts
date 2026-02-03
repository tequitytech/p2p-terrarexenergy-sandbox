
export const BECKN_CONTEXT_ROOT = "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld";

// DEG P2P Trading uses consolidated EnergyTrade schema from protocol-specifications-v2
export const ENERGY_TRADE_SCHEMA_CTX = "https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld";

// All energy schemas point to consolidated EnergyTrade/v0.3
export const ENERGY_RESOURCE_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_TRADE_OFFER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_TRADE_ORDER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_ORDER_ITEM_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_TRADE_DELIVERY_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
export const ENERGY_CUSTOMER_SCHEMA_CTX = ENERGY_TRADE_SCHEMA_CTX;
