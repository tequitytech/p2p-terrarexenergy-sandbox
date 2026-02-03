import { Router } from 'express';
import { syncSelect, syncInit, syncConfirm, syncStatus, syncHealth, validateSelect, validateInit, validateConfirm } from './controller';
import { authMiddleware } from '../auth/routes';

/**
 * Optional auth middleware - passes through if no auth header,
 * validates token if present. Used for catalog-based select which
 * requires auth, while raw beckn format does not.
 */
function optionalAuthMiddleware(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No auth header - proceed without auth (for raw beckn format)
    return next();
  }
  // Auth header present - validate it (for catalog-based format)
  return authMiddleware(req, res, next);
}

export const syncApiRoutes = () => {
  const router = Router();

  // Select: optional auth (required for catalog-based, not for raw beckn)
  router.post('/select', optionalAuthMiddleware, validateSelect, syncSelect);
  // Init: optional auth (required for select-based, not for raw beckn)
  router.post('/init', optionalAuthMiddleware, validateInit, syncInit);
  // Confirm: optional auth (required for init-based, not for raw beckn)
  router.post('/confirm', optionalAuthMiddleware, validateConfirm, syncConfirm);
  router.post('/status', syncStatus);
  router.get('/sync/health', syncHealth);

  return router;
};
