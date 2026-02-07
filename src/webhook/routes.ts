import { Router, Request, Response } from "express";

import {
  onSelect,
  onInit,
  onConfirm,
  onStatus,
  onCancel,
  onUpdate,
  onRating,
  onSupport,
  onTrack,
  triggerOnStatus,
  triggerOnCancel,
  triggerOnUpdate
} from "./controller";

export const webhookRoutes = () => {
  const router = Router();

  router.post("/select", onSelect);
  router.post("/init", onInit);
  router.post("/confirm", onConfirm);
  router.post("/status", onStatus);
  router.post("/cancel", onCancel);
  router.post("/update", onUpdate);
  router.post("/rating", onRating);
  router.post("/support", onSupport);
  router.post("/track", onTrack);

  // Unsolicited triggering routes
  router.post("/trigger/on_status", triggerOnStatus);
  router.post("/trigger/on_cancel", triggerOnCancel);
  router.post("/trigger/on_update", triggerOnUpdate);

  return router;
};
