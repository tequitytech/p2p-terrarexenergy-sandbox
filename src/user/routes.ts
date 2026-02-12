import { Router } from "express";

import { getDB } from "../db";

import type { Request, Response } from "express";
import { authMiddleware } from "../auth/routes";

import { ObjectId } from "mongodb";

export function userRoutes(): Router {
  const router = Router();

  // GET /api/beneficiary-accounts
  router.get("/beneficiary-accounts", async (req: Request, res: Response) => {
    try {
      const db = getDB();
      // Find all users who are social impact verified
      const accounts = await db.collection("users").find({
        isVerifiedBeneficiary: true,
        vcVerified: true
      }).toArray();

      // Return simplified list safe for public view / client use
      const result = accounts.map(user => ({
        id: user.profiles?.consumptionProfile?.id || user.profiles?.utilityCustomer?.did || user.phone, // Prioritize DIDs, fallback to phone
        name: user.name,
        verified: true,
        type: "Verified Beneficiary",
        requiredEnergy: user.requiredEnergy
      }));

      res.json({
        success: true,
        accounts: result
      });
    } catch (error: any) {
      console.error("[API] Error fetching beneficiary accounts:", error);
      res.status(500).json({ error: "Failed to fetch accounts" });
    }
  });

  // GET /api/gifting-beneficiaries
  router.get("/gifting-beneficiaries", authMiddleware, async (req: Request, res: Response) => {
    try {

      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const db = getDB();
      const userIdObj = new ObjectId(user.userId);

      // 1. Fetch user's contacts
      const contacts = await db.collection("contacts").find({ userId: userIdObj }).toArray();
      const contactUserIds = contacts.map(c => c.contactUserId);

      // 2. Find verified gifting beneficiaries WHO ARE ALSO IN CONTACTS
      const users = await db.collection("users").find({
        _id: { $in: contactUserIds },
        isVerifiedGiftingBeneficiary: true,
        vcVerified: true
      }).toArray();

      const result = users.map(user => {
        // Derive role based on generationProfile
        const role = user.profiles?.generationProfile ? 'prosumer' : 'consumer';

        return {
          id: user.profiles?.consumptionProfile?.id,
          userId: user._id,
          phone: user.phone,
          name: user.name,
          vcVerified: user.vcVerified || false,
          verifiedGiftingBeneficiary: user.isVerifiedGiftingBeneficiary || false,
          type: "Gifting Beneficiary",
          role,
          meters: user.meters || []
        };
      });

      return res.status(200).json({
        success: true,
        accounts: result
      });
    } catch (error: any) {
      console.error("[API] Error fetching gifting beneficiaries:", error.message);
      return res.status(500).json({ success: false, error: "Failed to fetch gifting beneficiaries" });
    }
  });

  // POST /api/contacts - Add a user to contacts
  router.post("/contacts", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ success: false, error: "Phone number is required" });
      }

      const db = getDB();

      // 1. Find the contact user
      const contactUser = await db.collection("users").findOne({ phone });
      if (!contactUser) {
        return res.status(404).json({ success: false, error: "User with this phone number not found" });
      }

      if (contactUser._id.toString() === user.userId.toString()) {
        return res.status(400).json({ success: false, error: "Cannot add yourself as a contact" });
      }

      const userIdObj = new ObjectId(user.userId);

      // 2. Add to contacts collection (upsert to avoid duplicates)
      await db.collection("contacts").updateOne(
        { userId: userIdObj, contactUserId: contactUser._id },
        {
          $set: {
            userId: userIdObj,
            contactUserId: contactUser._id,
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      return res.status(200).json({ success: true, message: "Contact added successfully" });

    } catch (error: any) {
      console.error("[API] Error adding contact:", error.message);
      return res.status(500).json({ success: false, error: "Failed to add contact" });
    }
  });

  return router;
}
