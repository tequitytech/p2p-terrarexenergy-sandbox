import { getDB } from '../db';

export const catalogStore = {
  async saveCatalog(catalog: any, userId?: string) {
    const db = getDB();
    const catalogId = catalog['beckn:id'];
    let usrId = userId || null;
    await db.collection('catalogs').updateOne(
      { 'beckn:id': catalogId },
      { $set: { ...catalog, updatedAt: new Date(), userId: usrId } },
      { upsert: true }
    );

    console.log(`[DB] Catalog saved: ${catalogId}`);
    return catalogId;
  },

  async saveItem(catalogId: string, item: any, userId?: string) {
    const db = getDB();
    const itemId = item['beckn:id'];
    let usrId = userId || null;
    await db.collection('items').updateOne(
      { 'beckn:id': itemId },
      { $set: { ...item, catalogId, updatedAt: new Date(), userId: usrId } },
      { upsert: true }
    );

    console.log(`[DB] Item saved: ${itemId}`);
  },

  async saveOffer(catalogId: string, offer: any) {
    const db = getDB();
    const offerId = offer['beckn:id'];

    await db.collection('offers').updateOne(
      { 'beckn:id': offerId },
      { $set: { ...offer, catalogId, updatedAt: new Date() } },
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
    return getDB().collection('items').find({}, {
      projection: {
        'beckn:id': 1,
        'beckn:itemAttributes.availableQuantity': 1,
        catalogId: 1
      }
    }).toArray();
  },

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

    // Remove MongoDB fields and rebuild catalog structure
    const cleanItem = (item: any) => {
      const { _id, catalogId, updatedAt, ...rest } = item;
      return rest;
    };

    const cleanOffer = (offer: any) => {
      const { _id, catalogId, updatedAt, ...rest } = offer;
      return rest;
    };

    const { _id, updatedAt, ...catalogBase } = catalog;

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

  async getOrderByTransactionId(transactionId: string): Promise<any | null> {
    const db = getDB();
    return db.collection('orders').findOne({ transactionId });
  }
};
