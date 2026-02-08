import express from "express";
import request from "supertest";

import { authMiddleware } from "../auth/routes";
import { orderService } from "../services/order-service";

import { ordersRoutes } from "./routes";

// --- Mocks ---
jest.mock("../auth/routes");
jest.mock("../services/order-service");

const mockAuthMiddleware = authMiddleware as jest.MockedFunction<
  typeof authMiddleware
>;
const mockOrderService = orderService as jest.Mocked<typeof orderService>;

describe("Orders Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api", ordersRoutes());

    jest.clearAllMocks();

    // Default: authenticated user
    mockAuthMiddleware.mockImplementation((req, res, next) => {
      (req as any).user = {
        phone: "9876543210",
        userId: "user-id-123",
      };
      next();
      return undefined as any;
    });
  });

  describe("GET /api/orders/buyer", () => {
    it("should return buyer orders for authenticated user", async () => {
      const mockOrders = [
        {
          transactionId: "txn-1",
          status: "SCHEDULED",
          type: "buyer",
          createdAt: new Date(),
        },
        {
          transactionId: "txn-2",
          status: "INITIATED",
          type: "buyer",
          createdAt: new Date(),
        },
      ];
      mockOrderService.getBuyerOrders.mockResolvedValue(mockOrders as any);

      const res = await request(app).get("/api/orders/buyer");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(mockOrderService.getBuyerOrders).toHaveBeenCalledWith({
        userId: "user-id-123",
      });
    });

    it("should return 401 when not authenticated", async () => {
      mockAuthMiddleware.mockImplementation((req, res, next) => {
        // Don't set req.user — simulate middleware passing through without auth
        next();
        return undefined as any;
      });

      const res = await request(app).get("/api/orders/buyer");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should return empty array when user has no buyer orders", async () => {
      mockOrderService.getBuyerOrders.mockResolvedValue([]);

      const res = await request(app).get("/api/orders/buyer");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe("GET /api/orders/seller", () => {
    it("should return seller orders for authenticated user", async () => {
      const mockOrders = [
        {
          transactionId: "txn-s1",
          status: "SCHEDULED",
          type: "seller",
          createdAt: new Date(),
        },
      ];
      mockOrderService.getSellerOrders.mockResolvedValue(mockOrders as any);

      const res = await request(app).get("/api/orders/seller");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(mockOrderService.getSellerOrders).toHaveBeenCalledWith({
        userId: "user-id-123",
      });
    });

    it("should return 401 when not authenticated", async () => {
      mockAuthMiddleware.mockImplementation((req, res, next) => {
        next();
        return undefined as any;
      });

      const res = await request(app).get("/api/orders/seller");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("should return empty array when user has no seller orders", async () => {
      mockOrderService.getSellerOrders.mockResolvedValue([]);

      const res = await request(app).get("/api/orders/seller");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe("GET /api/orders/combined", () => {
    it("should return both buyer and seller orders", async () => {
      const mockOrders = [
        {
          transactionId: "txn-s1",
          type: "seller",
          createdAt: new Date("2026-01-03"),
        },
        {
          transactionId: "txn-b1",
          type: "buyer",
          createdAt: new Date("2026-01-02"),
        },
        {
          transactionId: "txn-b2",
          type: "buyer",
          createdAt: new Date("2026-01-01"),
        },
      ];
      mockOrderService.getCombinedOrders.mockResolvedValue(mockOrders as any);

      const res = await request(app).get("/api/orders/combined");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(mockOrderService.getCombinedOrders).toHaveBeenCalledWith(
        "user-id-123"
      );
    });

    it("should return 401 when not authenticated", async () => {
      mockAuthMiddleware.mockImplementation((req, res, next) => {
        next();
        return undefined as any;
      });

      const res = await request(app).get("/api/orders/combined");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("should return 500 when orderService throws", async () => {
      mockOrderService.getCombinedOrders.mockRejectedValue(
        new Error("DB connection lost")
      );

      const errorSpy = jest.spyOn(console, "error").mockImplementation();

      const res = await request(app).get("/api/orders/combined");

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(res.body.error.details).toBe("DB connection lost");

      errorSpy.mockRestore();
    });
  });
});
