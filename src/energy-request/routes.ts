import { Router } from 'express';
import { createEnergyRequest, getEnergyRequests, findBestSeller, giftEnergy } from './controller';
import { authMiddleware } from '../auth/routes';

export function energyRequestRoutes() {
  const router = Router();

  // Create Request (requires auth)
  router.post('/request-energy', authMiddleware, createEnergyRequest);

  // Get Requests (for donate/gift listing)
  // Requirement says /api/accounts/donate and /api/accounts/gift
  // Since we mount at /api usually, these will be /accounts/donate etc.
  // Assuming mount point in app.ts is root or includes /api prefix.
  // Let's assume we mount this router at root so we define full path relative to it.
  router.get('/accounts/donate', getEnergyRequests);
  router.get('/accounts/gift', getEnergyRequests);

  // Find Seller
  router.get('/find-seller/:requestId', findBestSeller);

  // Gift Energy (purchase on behalf)
  // Requirement says /api/gift
  router.post('/gift', authMiddleware, giftEnergy);

  // Donate Energy (publish catalog/free energy)
  // Requirement says /api/donate
  // User note: "Modify donate endpoint... require authentication... for publishing catalog"
  // This implies /api/donate might trigger a catalog publish of type "donation"??
  // Or it's similar to gift but price is 0?
  // For now, I'll map it to a placeholder or reuse gift if logic aligns, 
  // but "publish catalog" suggests it's a seller action (I have energy, I donate it).
  // "Gift" suggests I buy someone else's energy for a requester.
  // Let's implement a stub for /api/donate or logic if clear.
  // Given "required for publishing catalog", it might mean "I am a prosumer, I want to donate my energy".
  // This would be creating an *Offer* with price 0.
  // Let's create a `donateEnergy` controller method if needed.
  // For now, I will wire it to a new controller function `donateEnergy` which I'll add to controller.ts
  
  router.post('/donate', authMiddleware, async (req, res) => {
      // Placeholder until logic is defined or I can infer from "publishing catalog"
      // If it means creating an offer check trade/routes.ts
      res.status(501).json({ message: "Donate endpoint implementation pending clarification on catalog publish logic" });
  });

  return router;
}
