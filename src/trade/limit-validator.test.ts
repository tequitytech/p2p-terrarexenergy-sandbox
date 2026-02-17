import { ObjectId } from 'mongodb';
import { limitValidator } from './limit-validator';
import { tradingRules } from './trading-rules';
import { getDB } from '../db';

jest.mock('../db');
jest.mock('./trading-rules');

describe('LimitValidator', () => {
    const mockDb = {
        collection: jest.fn()
    };
    const mockCollection = {
        findOne: jest.fn(),
        find: jest.fn(),
        toArray: jest.fn()
    };

    beforeEach(() => {
        (getDB as jest.Mock).mockReturnValue(mockDb);
        mockDb.collection.mockReturnValue(mockCollection);
        mockCollection.find.mockReturnValue(mockCollection);
        mockCollection.toArray.mockResolvedValue([]);

        // Default rules
        (tradingRules.getRules as jest.Mock).mockResolvedValue({
            buyerSafetyFactor: 1.0,
            sellerSafetyFactor: 1.0,
            enableBuyerLimits: true,
            enableSellerLimits: true
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('validateSellerLimit', () => {
        const userId = new ObjectId().toString();
        const mockUser = {
            _id: new ObjectId(userId),
            profiles: {
                generationProfile: { capacityKW: '8' },
                consumptionProfile: { sanctionedLoadKW: '10' }
            }
        };
        // Limit = Min(8, 10) = 8kW.

        it('should allow selling within limit', async () => {
            mockCollection.findOne.mockResolvedValue(mockUser);
            // reset mocks for multiple calls (findOne user vs find orders)
            // But strict mocking in beforeEach handles findOne/find separately if needed?
            // Actually findOne is for User. find is for Orders/Offers.
            // Using different return values based on collection name is hard with this simple mock setup 
            // unless we define mockImplementation.

            mockDb.collection.mockImplementation((name) => {
                if (name === 'users') return { findOne: jest.fn().mockResolvedValue(mockUser) };
                if (name === 'offers' || name === 'orders') return {
                    find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) })
                };
                return mockCollection;
            });

            const result = await limitValidator.validateSellerLimit(userId, 5, '2023-10-10', 10, 1);
            expect(result.allowed).toBe(true);
            expect(result.limit).toBe(8);
        });

        it('should include active offers in usage', async () => {
            mockDb.collection.mockImplementation((name) => {
                if (name === 'users') return { findOne: jest.fn().mockResolvedValue(mockUser) };
                if (name === 'offers') return {
                    find: jest.fn().mockReturnValue({
                        toArray: jest.fn().mockResolvedValue([{
                            "beckn:price": { applicableQuantity: { unitQuantity: 4 } },
                            "beckn:offerAttributes": {
                                deliveryWindow: {
                                    "schema:startTime": "2023-10-10T10:00:00+05:30",
                                    "schema:endTime": "2023-10-10T11:00:00+05:30"
                                }
                            }
                        }])
                    })
                };
                if (name === 'orders') return {
                    find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) })
                };
                return mockCollection;
            });

            // Limit 8. Offer 4. Request 5. Total 9 > 8. Fail.
            const result = await limitValidator.validateSellerLimit(userId, 5, '2023-10-10', 10, 1);
            expect(result.allowed).toBe(false);
            expect(result.currentUsage).toBe(4);
        });
    });
});
