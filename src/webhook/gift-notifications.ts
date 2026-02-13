
import { ObjectId } from "mongodb";

import { getDB } from "../db";
import { notificationService } from "../services/notification-service";

interface GiftNotificationParams {
    transactionId: string;
    claimResult: any; // The offer document
    buyerId: string;
    giftQty: number;
    giftOfferId: string;
}

/**
 * Handles background processing for gift claims:
 * 1. Sends and insert Notifications to Buyer and Seller
 *
 * This function should be called without 'await' to avoid blocking the main flow.
 */
export const processGiftNotifications = async ({
    transactionId,
    claimResult,
    buyerId,
    giftQty,
    giftOfferId,
}: GiftNotificationParams) => {
    try {
        const db = getDB();

        // Fetch Seller (Creator of the gift)
        // 1. Try userId from offer (claimResult)
        let sellerUserId = claimResult.userId;

        // 2. Fallback: Try userId from Catalog
        if (!sellerUserId && claimResult.catalogId) {
            const catalog = await db.collection("catalogs").findOne({ "beckn:id": claimResult.catalogId });
            if (catalog?.userId) {
                sellerUserId = catalog.userId;
            }
        }

        const sellerUser = sellerUserId ? await db.collection("users").findOne({ _id: new ObjectId(sellerUserId) }) : null;

        // Fetch Buyer (Claimant)
        const buyerUser = await db.collection("users").findOne({
            $or: [
                { "profiles.consumptionProfile.id": buyerId },
                { "profiles.consumptionProfile.did": buyerId },
                { "profiles.utilityCustomer.did": buyerId },
                { phone: buyerId },
            ],
        });

        const sellerName = sellerUser?.name || "Green Energy Seller";
        const buyerName = buyerUser?.name || buyerId || "Green Energy Buyer";

        console.log(`[GIFT-BG] Insert notification for txn ${transactionId}`);

        // FE will handling certificate generation and upload will send the detials only
        // 1. Notify Seller
        if (sellerUser) {
            await notificationService.createNotification(
                sellerUser._id,
                "GIFT_CLAIM_SELLER",
                "Gifting Successful",
                `The gift of ${giftQty} units of energy to ${buyerName} has been claimed.`,
                {
                    transactionId,
                    buyerId,
                    giftOfferId,
                    buyerUserId: buyerUser?._id || buyerId,
                    buyerName,
                    sellerId: sellerUser?._id,
                    sellerName,
                    giftQty,
                },
            );
        }

        // 2. Notify Buyer
        if (buyerUser) {
            await notificationService.createNotification(
                buyerUser._id,
                "GIFT_CLAIM_BUYER",
                "Gift Claimed",
                `You have successfully claimed a gift of ${giftQty} units of energy from ${sellerName}.`,
                {
                    transactionId,
                    giftOfferId,
                    sellerId: sellerUser?._id,
                    sellerName,
                    giftQty,
                    buyerUserId: buyerUser?._id,
                    buyerName,
                },
            );
        }
        console.log(`[GIFT-BG] Notifications sent for txn ${transactionId}`);
    } catch (error) {
        console.error(`[GIFT-BG] Error in notification flow for txn ${transactionId}:`, error);
    }
};
