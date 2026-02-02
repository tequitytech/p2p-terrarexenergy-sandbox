import { Router, Request, Response } from "express";
import { catalogStore } from "../services/catalog-store";
import { settlementStore } from "../services/settlement-store";

export const dashboardRoutes = () => {
  const router = Router();

  /**
   * GET /api/dashboard/stats
   * returns {
   *    totalEnergySold: number,
   *    availableEnergy: number,
   *    totalEarnings: number,
   *    yourSocialImpact: number,
   * }
   */
  router.get("/dashboard/stats", async (req: Request, res: Response) => {
    try {
      const sellerId = req.query.sellerId as string;
      if (!sellerId) {
        return res
          .status(400)
          .json({ error: "Missing sellerId query parameter" });
      }

      console.log(`[Dashboard] GET /stats for seller: ${sellerId}`);

      const [earningsToday, totalSold, availableInventory, socialDonations] = await Promise.all([
        catalogStore.getSellerEarnings(sellerId),
        catalogStore.getSellerTotalSold(sellerId),
        catalogStore.getSellerAvailableInventory(sellerId),
        catalogStore.getSocialImpactDonations(sellerId)
      ]);

      // Use actual calculated donations
      const socialImpact = Number(socialDonations.toFixed(2));

      res.json({
        totalEnergySold: Number(totalSold.toFixed(2)),
        availableEnergy: Number(availableInventory.toFixed(2)),
        totalEarnings: Number(earningsToday.toFixed(2)),
        yourSocialImpact: Number(socialImpact.toFixed(2)),
      });
    } catch (error: any) {
      console.error(`[Dashboard] Error getting stats:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
