import { Router } from "express";

import { sendSmsHandler, sendEmailHandler, getNotificationsHandler, markAsReadHandler } from "./controller";
import { authMiddleware } from "../auth/routes";

export const notificationRoutes = () => {
  const router = Router();

  router.post("/notification/sms",authMiddleware, sendSmsHandler);
  router.post("/notification/email",authMiddleware, sendEmailHandler);

  // In-App Notifications
  router.get("/notifications", authMiddleware, getNotificationsHandler);
  router.put("/notifications/:id/read", authMiddleware, markAsReadHandler);

  return router;
};
