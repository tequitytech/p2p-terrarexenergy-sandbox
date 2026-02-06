/**
 * Tests for user/routes.ts
 * 
 * Covers: GET /beneficiary-accounts
 */

import express from 'express';
import request from 'supertest';
import { userRoutes } from './routes';

// Mock dependencies
jest.mock('../db', () => ({
    getDB: jest.fn()
}));

import { getDB } from '../db';

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;

describe('user/routes', () => {
    let app: express.Express;
    let mockUsersCollection: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockUsersCollection = {
            find: jest.fn().mockReturnThis(),
            toArray: jest.fn()
        };

        mockedGetDB.mockReturnValue({
            collection: jest.fn().mockReturnValue(mockUsersCollection)
        } as any);

        app = express();
        app.use(express.json());
        app.use('/api', userRoutes());
    });

    describe('GET /beneficiary-accounts', () => {
        it('should return verified beneficiaries', async () => {
            const mockBeneficiaries = [
                {
                    phone: '9876543210',
                    name: 'John Farmer',
                    profiles: { consumptionProfile: { id: 'did:test:123' } },
                    isVerifiedBeneficiary: true,
                    vcVerified: true,
                    requiredEnergy: 50
                },
                {
                    phone: '9876543211',
                    name: 'Jane Farm',
                    profiles: { utilityCustomer: { did: 'did:test:456' } },
                    isVerifiedBeneficiary: true,
                    vcVerified: true,
                    requiredEnergy: 30
                }
            ];
            mockUsersCollection.toArray.mockResolvedValue(mockBeneficiaries);

            const response = await request(app)
                .get('/api/beneficiary-accounts')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.accounts).toHaveLength(2);
            expect(response.body.accounts[0]).toHaveProperty('name');
            expect(response.body.accounts[0]).toHaveProperty('verified', true);
        });

        it('should return empty accounts array when no beneficiaries exist', async () => {
            mockUsersCollection.toArray.mockResolvedValue([]);

            const response = await request(app)
                .get('/api/beneficiary-accounts')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.accounts).toEqual([]);
        });

        it('should filter by isVerifiedBeneficiary and vcVerified', async () => {
            mockUsersCollection.toArray.mockResolvedValue([]);

            await request(app).get('/api/beneficiary-accounts');

            expect(mockUsersCollection.find).toHaveBeenCalledWith({
                isVerifiedBeneficiary: true,
                vcVerified: true
            });
        });

        it('should return 500 on database error', async () => {
            mockUsersCollection.toArray.mockRejectedValue(new Error('DB error'));

            const response = await request(app)
                .get('/api/beneficiary-accounts')
                .expect(500);

            expect(response.body).toHaveProperty('error');
        });

        it('should return simplified account data with type and verified flag', async () => {
            const mockBeneficiaries = [{
                phone: '9876543210',
                name: 'John Farmer',
                profiles: {},
                isVerifiedBeneficiary: true,
                vcVerified: true,
                requiredEnergy: 25
            }];
            mockUsersCollection.toArray.mockResolvedValue(mockBeneficiaries);

            const response = await request(app)
                .get('/api/beneficiary-accounts')
                .expect(200);

            expect(response.body.accounts[0]).toHaveProperty('type', 'Verified Beneficiary');
            expect(response.body.accounts[0]).toHaveProperty('verified', true);
            expect(response.body.accounts[0]).toHaveProperty('requiredEnergy', 25);
        });
    });
});
