import express from "express";
import request from "supertest";

import { catalogStore } from "../services/catalog-store";
import { dashboardRoutes } from "./routes";

jest.mock("../services/catalog-store");

const mockCatalogStore = catalogStore as jest.Mocked<typeof catalogStore>;

describe("Dashboard Routes — GET /api/dashboard/stats", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api", dashboardRoutes());

    jest.clearAllMocks();
  });

  it("should return 400 when sellerId query param is missing", async () => {
    const res = await request(app).get("/api/dashboard/stats");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing sellerId query parameter");
  });

  it("should return aggregated stats for valid sellerId", async () => {
    mockCatalogStore.getSellerEarnings.mockResolvedValue(1250.5);
    mockCatalogStore.getSellerTotalSold.mockResolvedValue(340.75);
    mockCatalogStore.getSellerAvailableInventory.mockResolvedValue(120.3);
    mockCatalogStore.getBeneficiaryDonations.mockResolvedValue(45.2);
    mockCatalogStore.getSellerTotalGifted.mockResolvedValue(12.5);

    const res = await request(app)
      .get("/api/dashboard/stats")
      .query({ sellerId: "seller-001" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalEnergySold: 340.75,
      availableEnergy: 120.3,
      totalEarnings: 1250.5,
      donatedEnergy: 45.2,
      totalGifted: 12.5,
    });

    expect(mockCatalogStore.getSellerEarnings).toHaveBeenCalledWith(
      "seller-001"
    );
    expect(mockCatalogStore.getSellerTotalSold).toHaveBeenCalledWith(
      "seller-001"
    );
    expect(mockCatalogStore.getSellerAvailableInventory).toHaveBeenCalledWith(
      "seller-001"
    );
    expect(mockCatalogStore.getBeneficiaryDonations).toHaveBeenCalledWith(
      "seller-001"
    );
    expect(mockCatalogStore.getSellerTotalGifted).toHaveBeenCalledWith(
      "seller-001"
    );
  });

  it("should return all values rounded to 2 decimal places", async () => {
    mockCatalogStore.getSellerEarnings.mockResolvedValue(100.456);
    mockCatalogStore.getSellerTotalSold.mockResolvedValue(50.789);
    mockCatalogStore.getSellerAvailableInventory.mockResolvedValue(25.1234);
    mockCatalogStore.getBeneficiaryDonations.mockResolvedValue(10.999);
    mockCatalogStore.getSellerTotalGifted.mockResolvedValue(5.555);

    const res = await request(app)
      .get("/api/dashboard/stats")
      .query({ sellerId: "seller-002" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalEnergySold: 50.79,
      availableEnergy: 25.12,
      totalEarnings: 100.46,
      donatedEnergy: 11,
      totalGifted: 5.55,
    });
  });

  it("should return zeros when seller has no data", async () => {
    mockCatalogStore.getSellerEarnings.mockResolvedValue(0);
    mockCatalogStore.getSellerTotalSold.mockResolvedValue(0);
    mockCatalogStore.getSellerAvailableInventory.mockResolvedValue(0);
    mockCatalogStore.getBeneficiaryDonations.mockResolvedValue(0);
    mockCatalogStore.getSellerTotalGifted.mockResolvedValue(0);

    const res = await request(app)
      .get("/api/dashboard/stats")
      .query({ sellerId: "seller-no-data" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalEnergySold: 0,
      availableEnergy: 0,
      totalEarnings: 0,
      donatedEnergy: 0,
      totalGifted: 0,
    });
  });

  it("should return 500 when catalogStore throws", async () => {
    mockCatalogStore.getSellerEarnings.mockRejectedValue(
      new Error("DB connection failed")
    );

    const res = await request(app)
      .get("/api/dashboard/stats")
      .query({ sellerId: "seller-err" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("DB connection failed");
  });
});
