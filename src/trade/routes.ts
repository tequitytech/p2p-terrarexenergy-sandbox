import { Router, Request, Response } from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { catalogStore } from '../services/catalog-store';
import { settlementStore, SettlementStatus } from '../services/settlement-store';
import { settlementPoller, pollOnce, refreshSettlement, getPollingStatus } from '../services/settlement-poller';
import { ledgerClient } from '../services/ledger-client';
import dotenv from "dotenv";
import { parseError } from '../utils';
import { authMiddleware } from "../auth/routes";
dotenv.config();

const ONIX_BPP_URL = process.env.ONIX_BPP_URL || 'http://onix-bpp:8082';
const EXCESS_DATA_PATH = process.env.EXCESS_DATA_PATH || 'data/excess_predicted_hourly.json';

export const tradeRoutes = () => {
  const router = Router();

  // POST /api/publish - Store catalog and forward to ONIX
  router.post(
    "/publish",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const catalog = req.body.message?.catalogs?.[0];
        if (!catalog) {
          return res.status(400).json({ error: "No catalog in request" });
        }
      
        const userDetails = (req as any).user; // From authMiddleware

      console.log(`[API] POST /publish - Catalog: ${catalog['beckn:id']}`);

        // Store in MongoDB (primary action)
        const catalogId = await catalogStore.saveCatalog(catalog, userDetails.userId);

      for (const item of catalog['beckn:items'] || []) {
        await catalogStore.saveItem(catalogId, item, userDetails.userId);
      }

      for (const offer of catalog['beckn:offers'] || []) {
        await catalogStore.saveOffer(catalogId, offer);
      }

      // Forward to ONIX BPP (secondary action - don't fail if this fails)
      const forwardUrl = `${ONIX_BPP_URL}/bpp/caller/publish`;
      console.log(`[API] Forwarding to ${forwardUrl}`);

      let onixResponse = null;
      let onixError = null;

      try {
        const onixRes = await axios.post(forwardUrl, req.body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });
        onixResponse = onixRes.data;
        console.log(`[API] ONIX forwarding successful`);
      } catch (error: any) {
        onixError = parseError(error);
        console.warn(`[API] ONIX forwarding failed (catalog saved locally): ${error.message}`);
      }

      return res.status(200).json({
        success: true,
        catalog_id: catalogId,
        onix_forwarded: onixError === null,
        onix_error: onixError,
        onix_response: onixResponse
      });
    } catch (error: any) {
      console.error(`[API] Error:`, error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /api/inventory
  router.get('/inventory', async (req: Request, res: Response) => {
    const items = await catalogStore.getInventory();
    res.json({ items });
  });

  // GET /api/items
  router.get('/items', async (req: Request, res: Response) => {
    const items = await catalogStore.getAllItems();
    res.json({ items });
  });

  // GET /api/offers
  router.get('/offers', async (req: Request, res: Response) => {
    const offers = await catalogStore.getAllOffers();
    res.json({ offers });
  });

  // GET /api/forecast - Return excess predicted hourly data
  router.get('/forecast', async (req: Request, res: Response) => {
    try {
      const filePath = path.resolve(EXCESS_DATA_PATH);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: 'Forecast data not found',
          path: filePath
        });
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json(data);
    } catch (error: any) {
      console.error(`[API] Error reading forecast:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // Settlement Tracking API
  // ============================================

  // GET /api/settlements - List all settlements
  router.get('/settlements', async (req: Request, res: Response) => {
    try {
      const status = req.query.status as SettlementStatus | undefined;
      const settlements = await settlementStore.getSettlements(status);
      const stats = await settlementStore.getStats();

      res.json({
        settlements,
        stats,
        polling: getPollingStatus()
      });
    } catch (error: any) {
      console.error(`[API] Error listing settlements:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/settlements/stats - Get settlement statistics
  router.get('/settlements/stats', async (req: Request, res: Response) => {
    try {
      const stats = await settlementStore.getStats();
      const polling = getPollingStatus();
      const ledgerHealth = await ledgerClient.getLedgerHealth();

      res.json({
        stats,
        polling,
        ledger: {
          url: ledgerClient.LEDGER_URL,
          ...ledgerHealth
        }
      });
    } catch (error: any) {
      console.error(`[API] Error getting settlement stats:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/settlements/:transactionId - Get specific settlement
  router.get('/settlements/:transactionId', async (req: Request, res: Response) => {
    try {
      const transactionId = req.params.transactionId as string;
      const settlement = await settlementStore.getSettlement(transactionId);

      if (!settlement) {
        return res.status(404).json({
          error: 'Settlement not found',
          transactionId
        });
      }

      res.json({ settlement });
    } catch (error: any) {
      console.error(`[API] Error getting settlement:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/settlements/poll - Manually trigger a polling cycle
  router.post('/settlements/poll', async (req: Request, res: Response) => {
    try {
      console.log(`[API] Manual poll triggered`);
      const result = await pollOnce();
      res.json({
        success: true,
        result
      });
    } catch (error: any) {
      console.error(`[API] Error during manual poll:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/settlements/:transactionId/refresh - Force refresh from ledger
  router.post('/settlements/:transactionId/refresh', async (req: Request, res: Response) => {
    try {
      const transactionId = req.params.transactionId as string;
      console.log(`[API] Force refresh: ${transactionId}`);

      const settlement = await refreshSettlement(transactionId);

      if (!settlement) {
        return res.status(404).json({
          error: 'Settlement not found or no ledger data available',
          transactionId
        });
      }

      res.json({
        success: true,
        settlement
      });
    } catch (error: any) {
      console.error(`[API] Error refreshing settlement:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
