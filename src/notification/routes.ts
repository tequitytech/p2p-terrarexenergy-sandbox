import { Router } from "express";

import { sendSmsHandler, sendEmailHandler } from "./controller";

export const notificationRoutes = () => {
  const router = Router();

  router.post("/notification/sms", sendSmsHandler);
  router.post("/notification/email", sendEmailHandler);

  return router;
};
