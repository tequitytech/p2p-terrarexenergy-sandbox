import { Router, Request, Response } from "express";
import { getDB } from "../db";

export function userRoutes(): Router {
  const router = Router();

  // GET /api/social-impact-accounts
  router.get("/social-impact-accounts", async (req: Request, res: Response) => {
    try {
      const db = getDB();
      // Find all users who are social impact verified
      const accounts = await db.collection("users").find({
        socialImpactVerified: true,
        vcVerified: true
      }).toArray();

      // Return simplified list safe for public view / client use
      const result = accounts.map(user => ({
        id: user.profiles?.consumptionProfile?.id || user.profiles?.utilityCustomer?.did || user.phone, // Prioritize DIDs, fallback to phone
        name: user.name,
        verified: true,
        type: "Social Impact Entity",
        requiredEnergy: user.requiredEnergy
      }));

      res.json({
        success: true,
        accounts: result
      });
    } catch (error: any) {
      console.error("[API] Error fetching social impact accounts:", error);
      res.status(500).json({ error: "Failed to fetch accounts" });
    }
  });

  return router;
}
