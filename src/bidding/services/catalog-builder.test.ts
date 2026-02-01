/**
 * Tests for catalog-builder.ts
 *
 * Tests Beckn catalog construction, item/offer building, and schema compliance
 */

import { buildItem, buildOffer, buildCatalog, buildPublishRequest, extractIds } from './catalog-builder';
import { createCalculatedBid, createValidityWindow } from '../../test-utils';

describe('catalog-builder', () => {
  const mockParams = {
    provider_id: 'test-provider',
    meter_id: '100200300',
    source_type: 'SOLAR',
    date: '2026-01-28',
    quantity: 10,
    validityWindow: createValidityWindow('2026-01-28')
  };

  describe('buildItem', () => {
    it('should create valid Beckn Item structure', () => {
      const item = buildItem(mockParams);

      expect(item['@type']).toBe('beckn:Item');
      expect(item['@context']).toContain('context.jsonld');
      expect(item['beckn:id']).toBeDefined();
      expect(item['beckn:id']).toContain('item-');
      expect(item['beckn:id']).toContain(mockParams.provider_id);
    });

    it('should include EnergyResource item attributes', () => {
      const item = buildItem(mockParams);
      const attrs = item['beckn:itemAttributes'];

      expect(attrs['@type']).toBe('EnergyResource');
      expect(attrs.sourceType).toBe('SOLAR');
      expect(attrs.deliveryMode).toBe('GRID_INJECTION');
      expect(attrs.meterId).toBe('100200300');
      expect(attrs.availableQuantity).toBe(10);
    });

    it('should include production window', () => {
      const item = buildItem(mockParams);
      const productionWindow = item['beckn:itemAttributes'].productionWindow;

      expect(productionWindow).toHaveLength(1);
      expect(productionWindow[0]['@type']).toBe('beckn:TimePeriod');
      expect(productionWindow[0]['schema:startTime']).toBe(mockParams.validityWindow.start);
      expect(productionWindow[0]['schema:endTime']).toBe(mockParams.validityWindow.end);
    });

    it('should include provider reference', () => {
      const item = buildItem(mockParams);

      expect(item['beckn:provider']['beckn:id']).toBe('test-provider');
    });

    it('should include descriptor with name', () => {
      const item = buildItem(mockParams);

      expect(item['beckn:descriptor']['@type']).toBe('beckn:Descriptor');
      expect(item['beckn:descriptor']['schema:name']).toContain('Solar Energy');
      expect(item['beckn:descriptor']['schema:name']).toContain('2026-01-28');
    });

    it('should include source verification', () => {
      const item = buildItem(mockParams);
      const verification = item['beckn:itemAttributes'].sourceVerification;

      expect(verification.verified).toBe(true);
      expect(verification.certificates).toContain('BESCOM-NM-100200300');
    });

    it('should generate unique item IDs', () => {
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(now + 1);

      const item1 = buildItem(mockParams);
      const item2 = buildItem(mockParams);

      // IDs include timestamp so should be different
      expect(item1['beckn:id']).not.toBe(item2['beckn:id']);
      
      spy.mockRestore();
    });

    it('should handle different source types', () => {
      const windItem = buildItem({ ...mockParams, source_type: 'WIND' });
      const batteryItem = buildItem({ ...mockParams, source_type: 'BATTERY' });

      expect(windItem['beckn:itemAttributes'].sourceType).toBe('WIND');
      expect(batteryItem['beckn:itemAttributes'].sourceType).toBe('BATTERY');
    });
  });

  describe('buildOffer', () => {
    const offerParams = {
      provider_id: 'test-provider',
      item_id: 'item-test-001',
      date: '2026-01-28',
      price: 7.5,
      quantity: 10,
      validityWindow: createValidityWindow('2026-01-28')
    };

    it('should create valid Beckn Offer structure', () => {
      const offer = buildOffer(offerParams);

      expect(offer['@type']).toBe('beckn:Offer');
      expect(offer['@context']).toContain('context.jsonld');
      expect(offer['beckn:id']).toBeDefined();
      expect(offer['beckn:id']).toContain('offer-');
    });

    it('should include price specification', () => {
      const offer = buildOffer(offerParams);
      const price = offer['beckn:price'];

      expect(price['@type']).toBe('schema:PriceSpecification');
      expect(price['schema:price']).toBe(7.5);
      expect(price['schema:priceCurrency']).toBe('INR');
      expect(price['schema:unitText']).toBe('kWh');
    });

    it('should include EnergyTradeOffer attributes', () => {
      const offer = buildOffer(offerParams);
      const attrs = offer['beckn:offerAttributes'];

      expect(attrs['@type']).toBe('EnergyTradeOffer');
      expect(attrs.pricingModel).toBe('PER_KWH');
      expect(attrs.settlementType).toBe('DAILY');
      expect(attrs.minimumQuantity).toBe(5.0);
      expect(attrs.maximumQuantity).toBe(10);
    });

    it('should include wheeling charges', () => {
      const offer = buildOffer(offerParams);
      const wheeling = offer['beckn:offerAttributes'].wheelingCharges;

      expect(wheeling.amount).toBe(0.40);
      expect(wheeling.currency).toBe('INR');
    });

    it('should include validity window', () => {
      const offer = buildOffer(offerParams);
      const validity = offer['beckn:offerAttributes'].validityWindow;

      expect(validity['@type']).toBe('beckn:TimePeriod');
      expect(validity['schema:startTime']).toBe(offerParams.validityWindow.start);
    });

    it('should reference item IDs correctly', () => {
      const offer = buildOffer(offerParams);

      expect(offer['beckn:items']).toContain('item-test-001');
    });

    it('should include duplicate price in beckn:price format', () => {
      const offer = buildOffer(offerParams);
      const becknPrice = offer['beckn:offerAttributes']['beckn:price'];

      expect(becknPrice.value).toBe(7.5);
      expect(becknPrice.currency).toBe('INR');
    });

    it('should include max quantity specification', () => {
      const offer = buildOffer(offerParams);
      const maxQty = offer['beckn:offerAttributes']['beckn:maxQuantity'];

      expect(maxQty.unitQuantity).toBe(10);
      expect(maxQty.unitText).toBe('kWh');
    });
  });

  describe('buildCatalog', () => {
    const bid = createCalculatedBid('2026-01-28', 10, 7.5);
    const catalogParams = {
      provider_id: 'test-provider',
      meter_id: '100200300',
      source_type: 'SOLAR',
      bid
    };

    it('should create valid Beckn Catalog structure', () => {
      const catalog = buildCatalog(catalogParams);

      expect(catalog['@type']).toBe('beckn:Catalog');
      expect(catalog['@context']).toContain('context.jsonld');
      expect(catalog['beckn:id']).toBeDefined();
      expect(catalog['beckn:id']).toContain('catalog-');
    });

    it('should include items array with one item', () => {
      const catalog = buildCatalog(catalogParams);

      expect(catalog['beckn:items']).toHaveLength(1);
      expect(catalog['beckn:items'][0]['@type']).toBe('beckn:Item');
    });

    it('should include offers array with one offer', () => {
      const catalog = buildCatalog(catalogParams);

      expect(catalog['beckn:offers']).toHaveLength(1);
      expect(catalog['beckn:offers'][0]['@type']).toBe('beckn:Offer');
    });

    it('should use bid quantity for item and offer', () => {
      const catalog = buildCatalog(catalogParams);

      const itemQty = catalog['beckn:items'][0]['beckn:itemAttributes'].availableQuantity;
      const offerMaxQty = catalog['beckn:offers'][0]['beckn:offerAttributes'].maximumQuantity;

      expect(itemQty).toBe(10);
      expect(offerMaxQty).toBe(10);
    });

    it('should use bid price for offer', () => {
      const catalog = buildCatalog(catalogParams);

      const price = catalog['beckn:offers'][0]['beckn:price']['schema:price'];
      expect(price).toBe(7.5);
    });

    it('should include BPP identifiers', () => {
      const catalog = buildCatalog(catalogParams);

      expect(catalog['beckn:bppId']).toBe('p2p.terrarexenergy.com');
      expect(catalog['beckn:bppUri']).toBe('https://p2p.terrarexenergy.com/bpp/receiver');
      expect(catalog['beckn:isActive']).toBe(true);
    });

    it('should include date in catalog name', () => {
      const catalog = buildCatalog(catalogParams);

      expect(catalog['beckn:descriptor']['schema:name']).toContain('2026-01-28');
      expect(catalog['beckn:descriptor']['schema:name']).toContain('test-provider');
    });
  });

  describe('buildPublishRequest', () => {
    const bid = createCalculatedBid('2026-01-28', 10, 7.5);
    const params = {
      provider_id: 'test-provider',
      meter_id: '100200300',
      source_type: 'SOLAR',
      bid
    };

    it('should create valid publish request structure', () => {
      const request = buildPublishRequest(params);

      expect(request).toHaveProperty('context');
      expect(request).toHaveProperty('message');
      expect(request.message).toHaveProperty('catalogs');
    });

    it('should include proper context for catalog_publish', () => {
      const request = buildPublishRequest(params);
      const ctx = request.context;

      expect(ctx.action).toBe('catalog_publish');
      expect(ctx.version).toBe('2.0.0');
      expect(ctx.domain).toBe('beckn.one:deg:p2p-trading:2.0.0');
      expect(ctx.message_id).toBeDefined();
      expect(ctx.transaction_id).toBeDefined();
      expect(ctx.timestamp).toBeDefined();
    });

    it('should include BAP and BPP identifiers', () => {
      const request = buildPublishRequest(params);
      const ctx = request.context;

      expect(ctx.bap_id).toBe('p2p.terrarexenergy.com');
      expect(ctx.bpp_id).toBe('p2p.terrarexenergy.com');
      expect(ctx.bap_uri).toContain('terrarexenergy.com');
      expect(ctx.bpp_uri).toContain('terrarexenergy.com');
    });

    it('should include TTL', () => {
      const request = buildPublishRequest(params);

      expect(request.context.ttl).toBe('PT30S');
    });

    it('should include single catalog in message', () => {
      const request = buildPublishRequest(params);

      expect(request.message.catalogs).toHaveLength(1);
      expect(request.message.catalogs[0]['@type']).toBe('beckn:Catalog');
    });

    it('should generate unique message IDs', () => {
      const request1 = buildPublishRequest(params);
      const request2 = buildPublishRequest(params);

      expect(request1.context.message_id).not.toBe(request2.context.message_id);
    });

    it('should generate unique transaction IDs', () => {
      const request1 = buildPublishRequest(params);
      const request2 = buildPublishRequest(params);

      expect(request1.context.transaction_id).not.toBe(request2.context.transaction_id);
    });
  });

  describe('extractIds', () => {
    it('should extract all IDs from catalog', () => {
      const bid = createCalculatedBid('2026-01-28', 10, 7.5);
      const catalog = buildCatalog({
        provider_id: 'test-provider',
        meter_id: '100200300',
        source_type: 'SOLAR',
        bid
      });

      const ids = extractIds(catalog);

      expect(ids.catalog_id).toBe(catalog['beckn:id']);
      expect(ids.item_id).toBe(catalog['beckn:items'][0]['beckn:id']);
      expect(ids.offer_id).toBe(catalog['beckn:offers'][0]['beckn:id']);
    });

    it('should handle missing items gracefully', () => {
      const catalog = { 'beckn:id': 'catalog-001', 'beckn:offers': [] };

      const ids = extractIds(catalog);

      expect(ids.catalog_id).toBe('catalog-001');
      expect(ids.item_id).toBe('unknown');
    });

    it('should handle missing offers gracefully', () => {
      const catalog = { 'beckn:id': 'catalog-001', 'beckn:items': [] };

      const ids = extractIds(catalog);

      expect(ids.catalog_id).toBe('catalog-001');
      expect(ids.offer_id).toBe('unknown');
    });
  });

  describe('ID generation patterns', () => {
    it('should include provider ID in generated IDs', () => {
      const item = buildItem({ ...mockParams, provider_id: 'my-provider' });

      expect(item['beckn:id']).toContain('my-provider');
    });

    it('should include date in generated IDs', () => {
      const item = buildItem({ ...mockParams, date: '2026-12-31' });

      expect(item['beckn:id']).toContain('2026-12-31');
    });

    it('should include timestamp for uniqueness', () => {
      const beforeTime = Date.now();
      const item = buildItem(mockParams);
      const afterTime = Date.now();

      // Extract timestamp from ID (last segment after last -)
      const idParts = item['beckn:id'].split('-');
      const timestamp = parseInt(idParts[idParts.length - 1]);

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('schema compliance', () => {
    it('should produce valid JSON-LD context references', () => {
      const bid = createCalculatedBid('2026-01-28', 10, 7.5);
      const catalog = buildCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        bid
      });

      // All @context should be valid URLs
      expect(catalog['@context']).toMatch(/^https?:\/\//);
      expect(catalog['beckn:items'][0]['@context']).toMatch(/^https?:\/\//);
      expect(catalog['beckn:offers'][0]['@context']).toMatch(/^https?:\/\//);
    });

    it('should include EnergyResource context in items', () => {
      const item = buildItem(mockParams);

      expect(item['beckn:itemAttributes']['@context']).toContain('EnergyResource');
    });

    it('should include EnergyTradeOffer context in offers', () => {
      const offer = buildOffer({
        provider_id: 'test',
        item_id: 'item-001',
        date: '2026-01-28',
        price: 7.0,
        quantity: 10,
        validityWindow: createValidityWindow('2026-01-28')
      });

      expect(offer['beckn:offerAttributes']['@context']).toContain('EnergyTradeOffer');
    });
  });
});
