import { Router } from 'express';

import { previewBid, confirmBid } from './controller';

export function biddingRoutes(): Router {
  const router = Router();

  // POST /api/bid/preview - Calculate optimal bids without placing
  router.post('/bid/preview', previewBid);

  // POST /api/bid/confirm - Place bids via publish
  router.post('/bid/confirm', confirmBid);

  return router;
}
