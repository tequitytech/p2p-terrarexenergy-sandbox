import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../auth/routes";
import { getDB } from "../db";
import { orderService } from "../services/order-service";

// Extend Request type to include rawBody if we capture it in app.ts
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const ordersRoutes = () => {
  const router = Router();


  // GET /api/orders/buyer/ - List user's buy orders
  router.get(
    "/orders/buyer",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const userDetails = (req as any).user;
        if (!userDetails) {
          return res
            .status(401)
            .json({ success: false, error: "Unauthorized" });
        }

        const db = getDB();
        let user = await db
          .collection("users")
          .findOne({ phone: userDetails.phone });

        if (!user) {
          return res.status(401).json({
            success: false,
            error: {
              code: "INVALID_USER",
              message: "User Not Found",
            },
          });
        }

        // Fetch orders for this user
        const orders = await orderService.getBuyerOrders({
          userId: user._id,
          userPhone: user.phone,
        });
        res.json({
          success: true,
          data: orders,
        });
      } catch (error: any) {
        console.error("[API] Error fetching buyer orders:", error);
        res.status(500).json({
          success: false,
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to list orders",
            details: error.message,
          },
        });
      }
    },
  );

  return router;
};
