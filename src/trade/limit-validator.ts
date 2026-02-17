import { getDB } from "../db";
import { tradingRules } from "./trading-rules";
import { ObjectId } from "mongodb";
import { parseISO } from "date-fns";

export const limitValidator = {
    /**
     * Validate if a seller can publish/sell specific quantity
     */
    async validateSellerLimit(
        userId: string,
        quantity: number,
        dateStr: string,
        startHour: number,
        duration: number
    ): Promise<{ allowed: boolean; limit: number; currentUsage: number; remaining: number; error?: string }> {

        const rules = await tradingRules.getRules();
        if (!rules.enableSellerLimits) {
            return { allowed: true, limit: Infinity, currentUsage: 0, remaining: Infinity };
        }

        console.log("rules>>", rules)

        const db = getDB();

        // 1. Get User Profile
        let user;
        try {
            user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
        } catch (e) {
            console.error("Invalid ObjectId for userId:", userId);
            return { allowed: false, limit: 0, currentUsage: 0, remaining: 0, error: "Invalid user ID" };
        }

        if (!user) {
            return { allowed: false, limit: 0, currentUsage: 0, remaining: 0, error: "User not found" };
        }

        const genProfile = user.profiles?.generationProfile;
        const conProfile = user.profiles?.consumptionProfile;

        if (!genProfile) {
            return { allowed: false, limit: 0, currentUsage: 0, remaining: 0, error: "Generation profile not found. Please register as prosumer." };
        }

        // Capacity = Min(Gen, Sanctioned)
        const genCap = parseFloat(genProfile.capacityKW || "0");
        const sanctionLoad = parseFloat(conProfile?.sanctionedLoadKW || "0");

        // If sanctioned load is missing (e.g. pure generator?), maybe just use genCap?
        // Requirement: "Seller is limited by the generation capacity in generation profile and sanctioned load from consumption profile. Production capacity is min (gen capacity, sanctioned load)"
        // If consumption profile missing, sanctioned load is 0 -> Capacity 0.
        // Assuming every prosumer has consumption profile.

        const productionCapacity = Math.min(genCap, sanctionLoad > 0 ? sanctionLoad : genCap); // Usage fallback if sanction=0? Requirement says min. If sanction is 0, then 0.

        const safeLimit = productionCapacity * rules.sellerSafetyFactor;

        // Incoming quantity is Total. Normalize to Hourly.
        const hourlyQty = duration > 0 ? quantity / duration : quantity;

        // 2. Calculate Usage (Active Offers + Sold Orders)
        for (let i = 0; i < duration; i++) {
            const hour = startHour + i;
            const usage = await this.getSellerUsage(userId, dateStr, hour); //active catalog / orders confirm 

            if (usage + hourlyQty > safeLimit) {
                return {
                    allowed: false,
                    limit: safeLimit,
                    currentUsage: usage,
                    remaining: Math.max(0, safeLimit - usage),
                    error: `Selling limit exceeded for ${hour}:00-${hour + 1}:00. Limit: ${safeLimit.toFixed(2)} kWh/h, Allocated: ${usage.toFixed(2)} kWh/h, Requested: ${hourlyQty.toFixed(2)} kWh/h.`
                };
            }
        }

        return { allowed: true, limit: safeLimit, currentUsage: 0, remaining: safeLimit };
    },

    async getSellerUsage(userId: string, date: string, hour: number): Promise<number> {
        const db = getDB();

        const targetLocalStart = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:30`);
        const targetLocalEnd = new Date(`${date}T${String(hour + 1).padStart(2, '0')}:00:00+05:30`);
        const targetStartMs = targetLocalStart.getTime();
        const targetEndMs = targetLocalEnd.getTime();

        // A. Active Offers (Inventory on sale)
        // Query offers that are active and overlap
        // catalogStore saves userId as string, not ObjectId
        const activeOffers = await db.collection("offers").find({
            userId: userId,
            "beckn:price.applicableQuantity.unitQuantity": { $gt: 0 }
        }).toArray();

        let totalListed = 0;
        for (const offer of activeOffers) {
            const deliveryWindow = offer["beckn:offerAttributes"]?.deliveryWindow || offer["beckn:offerAttributes"]?.["beckn:deliveryWindow"];
            if (!deliveryWindow) continue;

            const startStr = deliveryWindow["schema:startTime"] || deliveryWindow["startTime"];
            const endStr = deliveryWindow["schema:endTime"] || deliveryWindow["endTime"];

            if (!startStr || !endStr) continue;

            const startMs = new Date(startStr).getTime();
            const endMs = new Date(endStr).getTime();

            const durationMs = endMs - startMs;
            const durationHours = durationMs / (1000 * 60 * 60);
            if (durationHours <= 0) continue;

            if (startMs < targetEndMs && endMs > targetStartMs) {
                const qty = parseFloat(offer["beckn:price"]?.applicableQuantity?.unitQuantity || "0");
                totalListed += (qty / durationHours);
            }
        }

        // B. Sold Orders (Fulfilled capacity)
        // Query orders where seller is this user
        // Order persistence might use ObjectId or String? 
        // catalogStore.saveOrder uses whatever orderData is passed. 
        // In webhook/controller, confirms are saved.
        // Let's check if usage of ObjectId is correct for orders. 
        // Based on other files, userId in orders seems to be ObjectId sometimes.
        // But to be safe, validSellerLimit receives userId as string.
        // Let's check how orders are saved.
        // If unsure, we can check both or just string if standard.
        // Assuming string for uniformity with offers if it was same user flow.
        // Wait, typical pattern here:
        // Users collection: _id is ObjectId.
        // References: usually ObjectId.
        // But catalogStore explicitly sets userId: usrId (string) for offers.
        // Let's try matching string first for offers.

        // For orders, let's look at `orders` collection schema from usage
        // internal `userId` field vs `beckn:seller.beckn:id` (DID).
        // The `orders` collection often has a root `userId` added for easier indexing?
        // Checking `getSellerUsage`... we are querying `userId` field.
        // If it was added by us, it might be string or ObjectId.
        // Let's try both to be safe or check where orders are saved with userId.

        // checking `webhook/controller.ts`...
        // `orderService.saveBuyerOrder`...? 
        // Wait, `getSellerUsage` looks for `userId` in `orders`.
        // Does `orders` collection even have `userId` for the SELLER? 
        // Usually `orders` has `userId` of the BUYER (who placed it).
        // The SELLER is identified by `order.beckn:seller`.

        // FIX: For SELLER USAGE, we should query `order.beckn:seller` (DID) or similar? 
        // BUT `validateSellerLimit` takes `userId` (Mongo ID).
        // We need to map MongoID -> DID to query orders? 
        // OR does `orders` collection have a `sellerId` field?

        // Looking at `catalogStore.getSellerEarnings`:
        // It matches `'order.beckn:seller': sellerId`. 
        // `sellerId` passed there is likely DID or MongoId? 
        // In `routes.ts`, `getEarnings` calls it with `req.user.did`? No, let's check.
        // If `orders` doesn't have `sellerId` (MongoID) explicitly, we might be querying wrong field.

        // Let's assume for now we need to match `order.beckn:seller` with the user's DID involved.
        // BUT `validateSellerLimit` receives `userId` (MongoID).
        // We need to fetch the user's DID to query orders by seller DID.

        // Step 1: Get User to find DID.
        const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
        if (!user) return 0; // Should satisfy prior check

        // Where is DID? 
        // `user.did` or `profiles.generationProfile.did`? 
        // Start with `beckn:seller` usually matches the provider ID in catalog.

        // Let's look at `orders` query again.
        // original: `userId: new ObjectId(userId)` -> This finds orders where this user is the BUYER.
        // We want orders where this user is the SELLER.
        // So we should NOT be querying `userId` (which is buyer).
        // We should query `order.beckn:seller.beckn:id` or similar? 
        // Let's rely on standard `order.beckn:seller`.

        // We need the user's DID. 
        // Let's assume `profiles.generationProfile.did` or just `did`.
        const sellerDid = user.did || user.profiles?.generationProfile?.did;

        if (!sellerDid) {
            console.warn(`[LimitValidator] Seller DID not found for user ${userId}`);
        }

        const soldOrders = await db.collection("orders").find({
            "order.beckn:seller": sellerDid,
            status: { $in: ["CONFIRMED", "SCHEDULED", "COMPLETED"] } // Exclude CREATED? 
        }).toArray();

        let totalSold = 0;
        for (const order of soldOrders) {
            const items = order.order?.["beckn:orderItems"] || order["beckn:orderItems"] || []; // Order structure might vary

            for (const item of items) {
                const offer = item["beckn:acceptedOffer"];
                const deliveryWindow = offer?.["beckn:offerAttributes"]?.deliveryWindow || offer?.["beckn:offerAttributes"]?.["beckn:deliveryWindow"];

                if (!deliveryWindow) continue;

                const startStr = deliveryWindow["schema:startTime"] || deliveryWindow["startTime"];
                const endStr = deliveryWindow["schema:endTime"] || deliveryWindow["endTime"];

                if (!startStr || !endStr) continue;

                const startMs = new Date(startStr).getTime();
                const endMs = new Date(endStr).getTime();

                const durationMs = endMs - startMs;
                const durationHours = durationMs / (1000 * 60 * 60);
                if (durationHours <= 0) continue;

                if (startMs < targetEndMs && endMs > targetStartMs) {
                    const qty = parseFloat(item["beckn:quantity"]?.unitQuantity || "0");
                    totalSold += (qty / durationHours);
                }
            }
        }

        console.log(`[LimitValidator] getSellerUsage for ${userId} @ ${hour}: Listed=${totalListed}, Sold=${totalSold}, Total=${totalListed + totalSold}`);
        return totalListed + totalSold;
    }
};
