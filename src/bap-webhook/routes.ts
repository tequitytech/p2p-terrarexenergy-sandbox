import { Router } from "express";

import {
  onSelect,
  onInit,
  onConfirm,
  onStatus,
  onCancel,
  onUpdate,
  onRating,
  onSupport,
  onTrack
} from "./controller";

export const bapWebhookRoutes = () => {
  const router = Router();

  router.post("/on_select", onSelect);
  router.post("/on_init", onInit);
  router.post("/on_confirm", onConfirm);
  router.post("/on_status", onStatus);
  router.post("/on_cancel", onCancel);
  router.post("/on_update", onUpdate);
  router.post("/on_rating", onRating);
  router.post("/on_support", onSupport);
  router.post("/on_track", onTrack);

  return router;
};
