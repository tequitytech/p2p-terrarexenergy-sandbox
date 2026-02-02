import { Router } from 'express';
import { previewSellerBid, confirmSellerBid } from './controller';
import { authMiddleware } from '../auth/routes';

export function sellerBiddingRoutes(): Router {
  const router = Router();

  // POST /api/seller/preview - Calculate optimal hourly bids for tomorrow (top 5 by revenue)
  router.post('/seller/preview', authMiddleware, previewSellerBid);

  // POST /api/seller/confirm - Place hourly bids via internal publish API
  router.post('/seller/confirm', authMiddleware, confirmSellerBid);

  return router;
}
