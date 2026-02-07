/**
 * Tests for hourly-catalog-builder.ts
 *
 * Tests hourly Beckn catalog construction with delivery/validity windows
 */

import { createHourlyBid } from '../../test-utils';
import { VALIDITY_BUFFER_HOURS } from '../types';

import {
  buildDeliveryWindow,
  buildValidityWindow,
  buildHourlyItem,
  buildHourlyOffer,
  buildHourlyCatalog,
  buildHourlyPublishRequest,
  extractHourlyIds
} from './hourly-catalog-builder';

describe('hourly-catalog-builder', () => {
  describe('buildDeliveryWindow', () => {
    it('should create 1-hour delivery window from hour string', () => {
      const result = buildDeliveryWindow('2026-01-28', '12:00');

      const start = new Date(result.start);
      const end = new Date(result.end);

      // Duration should be 1 hour
      expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
    });

    it('should handle single-digit hour', () => {
      const result = buildDeliveryWindow('2026-01-28', '8:00');

      expect(result.start).toBeDefined();
      expect(result.end).toBeDefined();
    });

    it('should handle midnight hour', () => {
      const result = buildDeliveryWindow('2026-01-28', '00:00');

      const start = new Date(result.start);
      expect(start.getUTCHours()).toBe(18); // 00:00 IST = 18:30 previous day UTC
    });

    it('should handle late night hour (23:00)', () => {
      const result = buildDeliveryWindow('2026-01-28', '23:00');

      const start = new Date(result.start);
      const end = new Date(result.end);

      expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
    });

    it('should return ISO string format', () => {
      const result = buildDeliveryWindow('2026-01-28', '12:00');

      expect(result.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(result.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });
  });

  describe('buildValidityWindow', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start validity from creation time (now)', () => {
      const result = buildValidityWindow('2026-01-28', '12:00');
      const start = new Date(result.start);

      // Should be close to "now"
      expect(start.getTime()).toBeCloseTo(Date.now(), -3);
    });

    it('should end validity 4 hours before delivery', () => {
      const result = buildValidityWindow('2026-01-28', '12:00');
      const delivery = buildDeliveryWindow('2026-01-28', '12:00');

      const validityEnd = new Date(result.end);
      const deliveryStart = new Date(delivery.start);

      // Validity should end 4 hours before delivery
      const hoursBefore = (deliveryStart.getTime() - validityEnd.getTime()) / (60 * 60 * 1000);
      expect(hoursBefore).toBe(VALIDITY_BUFFER_HOURS);
    });

    it('should handle edge case where validity ends in past', () => {
      // If delivery is at 14:00 and current time is 11:00 IST
      // Validity end would be at 10:00 IST (in the past)
      jest.setSystemTime(new Date('2026-01-28T05:30:00Z'));  // 11:00 IST

      const result = buildValidityWindow('2026-01-28', '14:00');
      const validityEnd = new Date(result.end);

      // Validity end is in the past - this is a valid edge case
      // The system should still create the window
      expect(validityEnd.getTime()).toBeLessThan(Date.now());
    });
  });

  describe('buildHourlyItem', () => {
    const params = {
      provider_id: 'test-provider',
      meter_id: '100200300',
      source_type: 'SOLAR',
      date: '2026-01-28',
      hour: '12:00',
      quantity: 5,
      deliveryWindow: { start: '2026-01-28T06:30:00.000Z', end: '2026-01-28T07:30:00.000Z' }
    };

    it('should create valid Beckn Item structure', () => {
      const item = buildHourlyItem(params);

      expect(item['@type']).toBe('beckn:Item');
      expect(item['@context']).toContain('context.jsonld');
      expect(item['beckn:id']).toContain('item-');
    });

    it('should include hour in item ID', () => {
      const item = buildHourlyItem(params);

      // Hour should be in ID without colon (1200)
      expect(item['beckn:id']).toContain('1200');
    });

    it('should include hour in descriptor', () => {
      const item = buildHourlyItem(params);

      expect(item['beckn:descriptor']['schema:name']).toContain('12:00');
      expect(item['beckn:descriptor']['beckn:shortDesc']).toContain('12:00');
    });

    it('should include EnergyResource item attributes', () => {
      const item = buildHourlyItem(params);
      const attrs = item['beckn:itemAttributes'];

      expect(attrs['@type']).toBe('EnergyResource');
      expect(attrs.sourceType).toBe('SOLAR');
      expect(attrs.availableQuantity).toBe(5);
    });

    it('should use delivery window for production window', () => {
      const item = buildHourlyItem(params);
      const prodWindow = item['beckn:itemAttributes'].productionWindow[0];

      expect(prodWindow['schema:startTime']).toBe(params.deliveryWindow.start);
      expect(prodWindow['schema:endTime']).toBe(params.deliveryWindow.end);
    });
  });

  describe('buildHourlyOffer', () => {
    const params = {
      provider_id: 'test-provider',
      meter_id: '100200300',
      item_id: 'item-001',
      date: '2026-01-28',
      hour: '12:00',
      price: 7.5,
      quantity: 5,
      validityWindow: { start: '2026-01-28T02:30:00.000Z', end: '2026-01-28T06:30:00.000Z' }
    };

    it('should create valid Beckn Offer structure', () => {
      const offer = buildHourlyOffer(params);

      expect(offer['@type']).toBe('beckn:Offer');
      expect(offer['beckn:id']).toContain('offer-');
    });

    it('should use HOURLY settlement type', () => {
      const offer = buildHourlyOffer(params);

      expect(offer['beckn:offerAttributes'].settlementType).toBe('HOURLY');
    });

    it('should use 1.0 kWh minimum quantity', () => {
      const offer = buildHourlyOffer(params);

      expect(offer['beckn:offerAttributes'].minimumQuantity).toBe(1.0);
    });

    it('should include validity window in offer attributes', () => {
      const offer = buildHourlyOffer(params);
      const validity = offer['beckn:offerAttributes'].validityWindow;

      expect(validity['schema:startTime']).toBe(params.validityWindow.start);
      expect(validity['schema:endTime']).toBe(params.validityWindow.end);
    });

    it('should include hour in offer descriptor', () => {
      const offer = buildHourlyOffer(params);

      expect(offer['beckn:descriptor']['schema:name']).toContain('12:00');
    });
  });

  describe('buildHourlyCatalog', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should create valid catalog with item and offer', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test-provider',
        meter_id: '100200300',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(catalog['@type']).toBe('beckn:Catalog');
      expect(catalog['beckn:items']).toHaveLength(1);
      expect(catalog['beckn:offers']).toHaveLength(1);
    });

    it('should include hour in catalog ID', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(catalog['beckn:id']).toContain('1200');
    });

    it('should include hour range in catalog name', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(catalog['beckn:descriptor']['beckn:shortDesc']).toContain('12:00');
      expect(catalog['beckn:descriptor']['beckn:shortDesc']).toContain('13:00');
    });

    it('should use bid values for item and offer', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      const itemQty = catalog['beckn:items'][0]['beckn:itemAttributes'].availableQuantity;
      const offerPrice = catalog['beckn:offers'][0]['beckn:price']['schema:price'];

      expect(itemQty).toBe(5);
      expect(offerPrice).toBe(7.5);
    });
  });

  describe('buildHourlyPublishRequest', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should create valid publish request structure', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const request = buildHourlyPublishRequest({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(request).toHaveProperty('context');
      expect(request).toHaveProperty('message');
      expect(request.message.catalogs).toHaveLength(1);
    });

    it('should include catalog_publish action', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const request = buildHourlyPublishRequest({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(request.context.action).toBe('catalog_publish');
    });

    it('should generate unique transaction IDs', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const params = {
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      };

      const request1 = buildHourlyPublishRequest(params);
      const request2 = buildHourlyPublishRequest(params);

      expect(request1.context.transaction_id).not.toBe(request2.context.transaction_id);
    });
  });

  describe('extractHourlyIds', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-28T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should extract all IDs from hourly catalog', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      const ids = extractHourlyIds(catalog);

      expect(ids.catalog_id).toBe(catalog['beckn:id']);
      expect(ids.item_id).toBe(catalog['beckn:items'][0]['beckn:id']);
      expect(ids.offer_id).toBe(catalog['beckn:offers'][0]['beckn:id']);
    });

    it('should handle missing items/offers gracefully', () => {
      const catalog = { 'beckn:id': 'cat-001' };

      const ids = extractHourlyIds(catalog);

      expect(ids.catalog_id).toBe('cat-001');
      expect(ids.item_id).toBe('unknown');
      expect(ids.offer_id).toBe('unknown');
    });
  });

  describe('next hour calculation', () => {
    it('should calculate 13:00 for 12:00', () => {
      const bid = createHourlyBid('12:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(catalog['beckn:descriptor']['beckn:shortDesc']).toContain('13:00');
    });

    it('should wrap 23:00 to 00:00', () => {
      const bid = createHourlyBid('23:00', 5, 7.5);
      const catalog = buildHourlyCatalog({
        provider_id: 'test',
        meter_id: '100',
        source_type: 'SOLAR',
        date: '2026-01-28',
        bid
      });

      expect(catalog['beckn:descriptor']['beckn:shortDesc']).toContain('00:00');
    });
  });
});
