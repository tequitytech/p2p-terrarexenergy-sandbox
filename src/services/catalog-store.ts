import { getDB } from '../db';
import { ObjectId } from 'mongodb';

export const catalogStore = {
  async saveCatalog(catalog: any, userId?: string, giftOptionId?: string) {
    const db = getDB();
    const catalogId = catalog['beckn:id'];
    const usrId = userId || null;
    const giftingOptionId = giftOptionId ? new ObjectId(giftOptionId) : null;
    await db.collection('catalogs').updateOne(
      { 'beckn:id': catalogId },
      { $set: { ...catalog, updatedAt: new Date(), userId: usrId, ...(giftingOptionId && { giftingOptionId }) } },
      { upsert: true }
    );

    console.log(`[DB] Catalog saved: ${catalogId}`);
    return catalogId;
  },

  async saveItem(catalogId: string, item: any, userId?: string, giftOptionId?: string) {
    const db = getDB();
    const itemId = item['beckn:id'];
    const usrId = userId || null;
    const giftingOptionId = giftOptionId ? new ObjectId(giftOptionId) : null;
    await db.collection('items').updateOne(
      { 'beckn:id': itemId },
      { $set: { ...item, catalogId, updatedAt: new Date(), userId: usrId, ...(giftingOptionId && { giftingOptionId }) } },
      { upsert: true }
    );

    console.log(`[DB] Item saved: ${itemId}`);
  },

  async saveOffer(catalogId: string, offer: any, userId?: string, giftOptionId?: string) {
    const db = getDB();
    const offerId = offer['beckn:id'];
    const usrId = userId || null;
    const giftingOptionId = giftOptionId ? new ObjectId(giftOptionId) : null;
    await db.collection('offers').updateOne(
      { 'beckn:id': offerId },
      { $set: { ...offer, catalogId, updatedAt: new Date(), userId: usrId, ...(giftingOptionId && { giftingOptionId }) } },
      { upsert: true }
    );

    console.log(`[DB] Offer saved: ${offerId}`);
  },

  async getAllItems() {
    return getDB().collection('items').find({}).toArray();
  },

  async getAllOffers() {
    return getDB().collection('offers').find({}).toArray();
  },

  async getInventory() {
    // Read inventory from offers collection (quantity stored in beckn:price.applicableQuantity)
    return getDB().collection('offers').find({}, {
      projection: {
        'beckn:id': 1,
        'beckn:items': 1,
        'beckn:price.applicableQuantity': 1,
        catalogId: 1
      }
    }).toArray();
  },

  /**
   * @deprecated Use reduceOfferInventory instead - quantity is now stored on offers
   */
  async reduceInventory(itemId: string, amount: number) {
    const db = getDB();
    const result = await db.collection('items').findOneAndUpdate(
      { 'beckn:id': itemId, 'beckn:itemAttributes.availableQuantity': { $gte: amount } },
      { $inc: { 'beckn:itemAttributes.availableQuantity': -amount } },
      { returnDocument: 'after' }
    );

    if (!result) throw new Error(`Insufficient inventory: ${itemId}`);
    return result['beckn:itemAttributes'].availableQuantity;
  },

  async reduceOfferInventory(offerId: string, amount: number) {
    const db = getDB();
    const result = await db.collection('offers').findOneAndUpdate(
      {
        'beckn:id': offerId,
        'beckn:price.applicableQuantity.unitQuantity': { $gte: amount }
      },
      {
        $inc: { 'beckn:price.applicableQuantity.unitQuantity': -amount }
      },
      { returnDocument: 'after' }
    );

    if (!result) throw new Error(`Insufficient inventory for offer: ${offerId}`);
    return result['beckn:price'].applicableQuantity.unitQuantity;
  },

  async getItem(itemId: string) {
    return getDB().collection('items').findOne({ 'beckn:id': itemId });
  },

  async getOffersByItemId(itemId: string) {
    // Offers have beckn:items array referencing which items they apply to
    return getDB().collection('offers').find({
      'beckn:items': itemId
    }).toArray();
  },

  async getOffer(offerId: string) {
    return getDB().collection('offers').findOne({ 'beckn:id': offerId });
  },

  async getCatalog(catalogId: string) {
    return getDB().collection('catalogs').findOne({ 'beckn:id': catalogId });
  },

  async getItemsByCatalog(catalogId: string) {
    return getDB().collection('items').find({ catalogId }).toArray();
  },

  async getOffersByCatalog(catalogId: string) {
    return getDB().collection('offers').find({ catalogId }).toArray();
  },

  async buildCatalogForPublish(catalogId: string) {
    const catalog = await this.getCatalog(catalogId);
    if (!catalog) throw new Error(`Catalog not found: ${catalogId}`);

    const items = await this.getItemsByCatalog(catalogId);
    const offers = await this.getOffersByCatalog(catalogId);

    /*
     * IMPORTANT: Strip internal/MongoDB fields before republishing to ONIX.
     * ONIX Beckn schema uses `additionalProperties: false` on Item and Offer
     * objects — any non-spec field causes a 400 validation error.
     *
     * If you add a new internal field to saveItem/saveOffer/saveCatalog,
     * you MUST add it to both cleanItem and cleanOffer below.
     *
     * See also: onSelect and onInit cleanup in webhook/controller.ts —
     * all three locations must stay in sync.
     */
    const cleanItem = (item: any) => {
      const { _id, catalogId, updatedAt, userId, giftingOptionId, ...rest } = item;
      return rest;
    };

    const cleanOffer = (offer: any) => {
      const {
        _id, catalogId, updatedAt, userId, giftingOptionId,
        // Gift DB-only fields — must not leak into ONIX publish payload
        isGift, giftStatus, claimSecret, recipientPhone,
        expiresAt, claimedAt, claimedBy,
        lookupHash, claimVerifier,
        ...rest
      } = offer;

      // Keep claimVerifier in beckn:offerAttributes.gift — it's a hash (not the raw secret)
      // and ONIX schema validation requires it for gift offer republish

      return rest;
    };

    const { _id, updatedAt, userId, ...catalogBase } = catalog;

    return {
      ...catalogBase,
      'beckn:items': items.map(cleanItem),
      'beckn:offers': offers.map(cleanOffer)
    };
  },

  // Order persistence for status tracking
  async saveOrder(transactionId: string, orderData: any): Promise<void> {
    const db = getDB();
    await db.collection('orders').updateOne(
      { transactionId },
      {
        $set: {
          ...orderData,
          transactionId,
          confirmedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`[DB] Order saved: ${transactionId}`);
  },

  async getOrderByTransactionId(transactionId: string): Promise<any> {
    const db = getDB();
    return db.collection('orders').findOne({ transactionId });
  },

  async getSellerEarnings(sellerId: string, from?: Date, to: Date = new Date()): Promise<number> {
    const db = getDB();

    const confirmedAt: { $gte?: Date, $lte?: Date } = {};
    if(from) confirmedAt['$gte'] = from;
    if(to) confirmedAt['$lte'] = to;
    
    const pipeline = [
      {
        $match: {
          'order.beckn:seller': sellerId,
          'order.beckn:orderStatus': {
            $in: ['CREATED', 'CONFIRMED', 'SCHEDULED']
          },
          confirmedAt,
        }
      },
      {
        $unwind: '$order.beckn:orderItems'
      },
      {
        $project: {
          quantity: { 
            $ifNull: [
              '$order.beckn:orderItems.beckn:quantity.unitQuantity', 
              0
            ] 
          },
          price: {
            $ifNull: [
              '$order.beckn:orderItems.beckn:acceptedOffer.beckn:price.schema:price',
              '$order.beckn:orderItems.beckn:acceptedOffer.beckn:offerAttributes.beckn:price.value',
              '$order.beckn:orderItems.beckn:acceptedOffer.beckn:price.value',
              0
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: { $multiply: ['$quantity', '$price'] } }
        }
      }
    ];

    const result = await db.collection('orders').aggregate(pipeline).toArray();
    return Number((result[0]?.totalEarnings || 0).toFixed(2));
  },

  async getSellerTotalSold(sellerId: string, from?: Date, to: Date = new Date()): Promise<number> {
    const db = getDB();
    
    const confirmedAt: { $gte?: Date, $lte?: Date } = {};
    if(from) confirmedAt['$gte'] = from;
    if(to) confirmedAt['$lte'] = to;
    

    const pipeline = [
      {
        $match: {
          'order.beckn:seller': sellerId,
          'order.beckn:orderStatus': {
            $in: ['CREATED', 'CONFIRMED', 'SCHEDULED']
          },
          confirmedAt
        }
      },
      {
        $unwind: '$order.beckn:orderItems'
      },
      {
        $group: {
          _id: null,
          totalQuantity: { 
            $sum: { 
              $ifNull: ['$order.beckn:orderItems.beckn:quantity.unitQuantity', 0] 
            } 
          }
        }
      }
    ];

    const result = await db.collection('orders').aggregate(pipeline).toArray();
    return result[0]?.totalQuantity || 0;
  },

  async getSellerTotalGifted(sellerId: string, from?: Date, to: Date = new Date()): Promise<number> {
    const db = getDB();

    const confirmedAt: { $gte?: Date, $lte?: Date } = {};
    if (from) confirmedAt['$gte'] = from;
    if (to) confirmedAt['$lte'] = to;

    const pipeline = [
      {
        $match: {
          'order.beckn:seller': sellerId,
          isGift: true,
          'order.beckn:orderStatus': {
            $in: ['CREATED', 'CONFIRMED', 'SCHEDULED', 'COMPLETED']
          },
          confirmedAt
        }
      },
      {
        $unwind: '$order.beckn:orderItems'
      },
      {
        $group: {
          _id: null,
          totalQuantity: {
            $sum: {
              $ifNull: ['$order.beckn:orderItems.beckn:quantity.unitQuantity', 0]
            }
          }
        }
      }
    ];

    const result = await db.collection('orders').aggregate(pipeline).toArray();
    return result[0]?.totalQuantity || 0;
  },

  async getSellerAvailableInventory(sellerId: string): Promise<number> {
    const db = getDB();
    const result = await db.collection('offers').aggregate([
      {
        $match: {
          'beckn:provider': sellerId,
        }
      },
      {
         $group: {
            _id: null,
            totalAvailable: { $sum: '$beckn:price.applicableQuantity.unitQuantity' }
         }
      }
    ]).toArray();
    
    return result[0]?.totalAvailable || 0;
  },

  async getBeneficiaryDonations(sellerId: string): Promise<number> {
      const db = getDB();
      const verifiedAccounts = await db.collection("users").find({
        vcVerified: true,
        isVerifiedBeneficiary: true
      }).toArray();

      const verifiedAccountIds = new Set(verifiedAccounts.map(p => p.profiles.consumptionProfile.id));
      const pipeline = [
        {
          $match: {
            'order.beckn:seller': sellerId,
            'order.beckn:orderStatus': { $in: ['CREATED', 'CONFIRMED', 'SCHEDULED', 'COMPLETED'] },
            'order.beckn:buyer.beckn:id': { $in: Array.from(verifiedAccountIds) }
          }
        }
      ];
  
      const result = await db.collection('orders').aggregate(pipeline).toArray();
      const quantity = result.map(p => p.order["beckn:orderAttributes"]["total_quantity"]).reduce((a,b) => a + b,0);
      return quantity;
  },

  /**
   * Helper to retrieve context-aware seller userId for an item
   * Fallback to the catalog's userId if not present on the item (legacy data)
   */
  async getSellerUserIdForItem(itemId: string): Promise<string | null> {
    const db = getDB();
    const item = await this.getItem(itemId);
    if (!item) return null;
    if (item.userId) return item.userId;

    if (item.catalogId) {
      const catalog = await this.getCatalog(item.catalogId);
      if (catalog) {
        if (catalog.userId) return catalog.userId;

        // Fallback: Get meterId from catalog and search users
        const meterId = catalog['beckn:items']?.[0]?.['beckn:itemAttributes']?.meterId

        if (meterId) {
          const user = await db.collection('users').findOne({ meters: meterId });
          if (user) {
            console.log(`[CatalogStore] Seller userId found via meterId fallback: ${user._id}`);
            return user._id.toString();
          }
        }
      }
    }
    return null;
  },

  async getPublishedItems(userId: string) {
    try {
      const db = getDB();
      return await db
        .collection("items")
        .aggregate([
          // Stage 1: Match items with userId and isActive = true
          {
            $match: {
              userId: userId,
              "beckn:isActive": true,
            },
          },

          // Stage 2: Lookup matching offers
          {
            $lookup: {
              from: "offers",
              let: { itemId: "$beckn:id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        // Ensure beckn:items exists and is an array
                        { $isArray: "$beckn:items" },
                        // Check if itemId is in beckn:items array
                        { $in: ["$$itemId", "$beckn:items"] },
                        // Ensure price path exists and unitQuantity > 0
                        {
                          $gt: [
                            {
                              $ifNull: [
                                "$beckn:price.applicableQuantity.unitQuantity",
                                0,
                              ],
                            },
                            0,
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
              as: "beckn:offers",
            },
          },

          // Stage 3: Filter out items that don't have matching offers
          {
            $match: {
              "beckn:offers": { $ne: [] },
            },
          },
        ])
        .toArray();
    } catch (error: any) {
      console.error(
        `[CatalogStore] Error retrieving published items: ${error.message}`,
      );
      throw error;
    }
  },
};
