import { getDB } from "../db";

export interface TradingRulesConfig {
    buyerSafetyFactor: number; // 0.0 to 1.0 (default 1.0)
    sellerSafetyFactor: number; // 0.0 to 1.0 (default 1.0)
    enableBuyerLimits: boolean;
    enableSellerLimits: boolean;
    updatedAt?: Date;
}

const DEFAULT_RULES: TradingRulesConfig = {
    buyerSafetyFactor: 1.0,
    sellerSafetyFactor: 1.0,
    enableBuyerLimits: true, // Default to true as requested
    enableSellerLimits: true,
};

export const tradingRules = {
    async getRules(): Promise<TradingRulesConfig> {
        try {
            const db = getDB();
            const config = await db.collection("system_configs").findOne({ type: "trading_rules" });

            if (!config) {
                return DEFAULT_RULES;
            }

            return {
                buyerSafetyFactor: config.buyerSafetyFactor ?? DEFAULT_RULES.buyerSafetyFactor,
                sellerSafetyFactor: config.sellerSafetyFactor ?? DEFAULT_RULES.sellerSafetyFactor,
                enableBuyerLimits: config.enableBuyerLimits ?? DEFAULT_RULES.enableBuyerLimits,
                enableSellerLimits: config.enableSellerLimits ?? DEFAULT_RULES.enableSellerLimits,
            };
        } catch (error) {
            console.error("[TradingRules] Failed to fetch rules:", error);
            return DEFAULT_RULES;
        }
    },

    async updateRules(updates: Partial<TradingRulesConfig>): Promise<void> {
        const db = getDB();
        await db.collection("system_configs").updateOne(
            { type: "trading_rules" },
            {
                $set: {
                    ...updates,
                    type: "trading_rules",
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
        console.log("[TradingRules] Updated rules:", updates);
    }
};
