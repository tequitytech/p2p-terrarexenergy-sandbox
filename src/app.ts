import express, { Router, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { webhookRoutes } from "./webhook/routes";
import { bapWebhookRoutes } from "./bap-webhook/routes";
import { tradeRoutes } from "./trade/routes";
import { syncApiRoutes } from "./sync-api/routes";
import { biddingRoutes } from "./bidding/routes";
import { sellerBiddingRoutes } from "./seller-bidding/routes";
import { authRoutes, authMiddleware } from "./auth/routes";
import { paymentRoutes } from "./payment/routes";
import { notificationRoutes } from "./notification/routes";
import { voiceRoutes } from "./voice/routes";
import { connectDB } from "./db";
import { startPolling, stopPolling } from "./services/settlement-poller";
import { ZodError } from "zod";
import { ordersRoutes } from "./orders/routes";
import { discoverRoutes } from "./discover/routes";
import { dashboardRoutes } from "./dashboard/routes";
import { userRoutes } from "./user/routes";
import { energyRequestRoutes } from "./energy-request/routes";

export async function createApp() {
  // Connect to MongoDB on startup
  await connectDB();

  // Start settlement polling service
  startPolling();

  const app = express();
  app.use(cors());
  app.use(helmet());
  app.use(express.json({ limit: "5mb" }));

  // Create main API router
  const apiRouter = Router();

  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode}`);
    });
    next();
  })

  // Mount all routes under the main API router
  apiRouter.use("/webhook", webhookRoutes());
  apiRouter.use("/bap-webhook", bapWebhookRoutes());
  apiRouter.use("/", tradeRoutes());  // Mount at root: /api/publish, /api/inventory, etc.
  apiRouter.use("/", discoverRoutes());  // Mounts /api/discover
  apiRouter.use("/", syncApiRoutes());  // Mounts /api/select, /api/init, etc.
  apiRouter.use("/", biddingRoutes());  // Mounts /api/bid/preview, /api/bid/confirm
  apiRouter.use("/", sellerBiddingRoutes());  // Mounts /api/seller/preview, /api/seller/confirm
  apiRouter.use("/", authRoutes());  // Mounts /api/auth/login, /api/auth/verify-vc, /api/auth/me
  apiRouter.use("/", userRoutes());  // Mounts /api/social-impact-accounts
  apiRouter.use("/", paymentRoutes()); // Mounts /api/payment/order, /api/payment/verify, /api/payment/:orderId, /webhook/razorpay
  apiRouter.use("/", notificationRoutes()); // Mounts /api/notification/sms
  apiRouter.use("/", dashboardRoutes()); // Mounts /api/dashboard/stats
  apiRouter.use("/voice", authMiddleware, voiceRoutes());  // Mounts /api/voice/intent
  apiRouter.use("/", ordersRoutes()); // Mounts /api/orders
  apiRouter.use("/", energyRequestRoutes()); // Mounts energy request routes

  // Mount the main API router with /api prefix
  apiRouter.use("/health", (req: Request, res: Response) => {
    return res.status(200).json({ message: "OK!" });
  });
  app.use("/api", apiRouter);

  // Global error fallback
  app.use((err: any, req: any, res: any, _next: any) => {
    if(err instanceof ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues[0]?.message || 'Request validation failed',
          details: err.issues.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        }
      });
    }
    req?.log?.error?.(err);
    res.status(err.status || 500).json({ error: "internal_error" });
  });

  // Graceful shutdown handler
  const shutdown = () => {
    console.log('[App] Shutting down...');
    stopPolling();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return app;
}
