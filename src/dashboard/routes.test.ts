/**
 * Tests for dashboard/routes.ts
 * 
 * Covers: GET /dashboard/stats
 */

import express from 'express';
import request from 'supertest';
import { dashboardRoutes } from './routes';

// Mock dependencies  
jest.mock('../services/catalog-store', () => ({
    catalogStore: {
        getSellerEarnings: jest.fn(),
        getSellerTotalSold: jest.fn(),
        getSellerAvailableInventory: jest.fn(),
        getBeneficiaryDonations: jest.fn()
    }
}));

// settlementStore is imported but not used, still mock it
jest.mock('../services/settlement-store', () => ({
    settlementStore: {}
}));

import { catalogStore } from '../services/catalog-store';

describe('dashboard/routes', () => {
    let app: express.Express;

    beforeEach(() => {
        jest.clearAllMocks();

        app = express();
        app.use(express.json());
        app.use('/api', dashboardRoutes());
    });

    describe('GET /dashboard/stats', () => {
        it('should return dashboard stats for seller', async () => {
            (catalogStore.getSellerEarnings as jest.Mock).mockResolvedValue(5000);
            (catalogStore.getSellerTotalSold as jest.Mock).mockResolvedValue(100);
            (catalogStore.getSellerAvailableInventory as jest.Mock).mockResolvedValue(50);
            (catalogStore.getBeneficiaryDonations as jest.Mock).mockResolvedValue(25);

            const response = await request(app)
                .get('/api/dashboard/stats?sellerId=seller-123')
                .expect(200);

            expect(response.body).toEqual({
                totalEnergySold: 100,
                availableEnergy: 50,
                totalEarnings: 5000,
                donatedEnergy: 25
            });
        });

        it('should return zeros for new seller with no activity', async () => {
            (catalogStore.getSellerEarnings as jest.Mock).mockResolvedValue(0);
            (catalogStore.getSellerTotalSold as jest.Mock).mockResolvedValue(0);
            (catalogStore.getSellerAvailableInventory as jest.Mock).mockResolvedValue(0);
            (catalogStore.getBeneficiaryDonations as jest.Mock).mockResolvedValue(0);

            const response = await request(app)
                .get('/api/dashboard/stats?sellerId=new-seller')
                .expect(200);

            expect(response.body.totalEnergySold).toBe(0);
            expect(response.body.totalEarnings).toBe(0);
        });

        it('should return 400 when sellerId is missing', async () => {
            const response = await request(app)
                .get('/api/dashboard/stats')
                .expect(400);

            expect(response.body).toHaveProperty('error');
            expect(response.body.error).toContain('sellerId');
        });

        it('should return 500 on service error', async () => {
            (catalogStore.getSellerEarnings as jest.Mock).mockRejectedValue(new Error('Service unavailable'));
            (catalogStore.getSellerTotalSold as jest.Mock).mockResolvedValue(0);
            (catalogStore.getSellerAvailableInventory as jest.Mock).mockResolvedValue(0);
            (catalogStore.getBeneficiaryDonations as jest.Mock).mockResolvedValue(0);

            const response = await request(app)
                .get('/api/dashboard/stats?sellerId=seller-123')
                .expect(500);

            expect(response.body).toHaveProperty('error');
        });

        it('should call catalog store methods with correct seller ID', async () => {
            (catalogStore.getSellerEarnings as jest.Mock).mockResolvedValue(1000);
            (catalogStore.getSellerTotalSold as jest.Mock).mockResolvedValue(50);
            (catalogStore.getSellerAvailableInventory as jest.Mock).mockResolvedValue(25);
            (catalogStore.getBeneficiaryDonations as jest.Mock).mockResolvedValue(10);

            await request(app).get('/api/dashboard/stats?sellerId=my-seller-id').expect(200);

            expect(catalogStore.getSellerEarnings).toHaveBeenCalledWith('my-seller-id');
            expect(catalogStore.getSellerTotalSold).toHaveBeenCalledWith('my-seller-id');
            expect(catalogStore.getSellerAvailableInventory).toHaveBeenCalledWith('my-seller-id');
            expect(catalogStore.getBeneficiaryDonations).toHaveBeenCalledWith('my-seller-id');
        });

        it('should round values to 2 decimal places', async () => {
            (catalogStore.getSellerEarnings as jest.Mock).mockResolvedValue(1000.567);
            (catalogStore.getSellerTotalSold as jest.Mock).mockResolvedValue(50.123);
            (catalogStore.getSellerAvailableInventory as jest.Mock).mockResolvedValue(25.999);
            (catalogStore.getBeneficiaryDonations as jest.Mock).mockResolvedValue(10.4551);

            const response = await request(app)
                .get('/api/dashboard/stats?sellerId=seller-123')
                .expect(200);

            expect(response.body.totalEnergySold).toBe(50.12);
            expect(response.body.availableEnergy).toBe(26);
            expect(response.body.totalEarnings).toBe(1000.57);
            expect(response.body.donatedEnergy).toBe(10.46);
        });
    });
});
