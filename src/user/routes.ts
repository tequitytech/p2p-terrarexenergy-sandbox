import { Router } from "express";

import { getDB } from "../db";

import type { Request, Response } from "express";
import { authMiddleware, normalizeIndianPhone } from "../auth/routes";

import { ObjectId } from "mongodb";
import { z } from "zod";
import multer from "multer";
import { S3Service } from "../services/s3-service";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
    cb(null, true);
  },
});
const createGiftingOptionSchema = z.object({
  beneficiaryUserId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId"),
  badge: z.string().min(1, "Badge is required"),
  deliveryDescription: z.string().min(1, "Delivery description is required"),
  quantity: z.number().positive().max(1000), // kWh
  price: z.number().min(0, "Price cannot be negative"),
  contributionAmount: z.number().min(0, "Contribution amount cannot be negative"),
  startHour: z.number().int().min(0).max(23).default(10),
  duration: z.number().int().min(1).max(12).default(1),
  sourceType: z.enum(["SOLAR", "WIND", "HYDRO"]).default("SOLAR"),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const getGiftingOptionsSchema = z.object({
  userId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId")
});

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

        // Find specific contact details for this user
        const contact = contacts.find(c => c.contactUserId.toString() === user._id.toString());

        return {
          id: user.profiles?.consumptionProfile?.id,
          userId: user._id,
          phone: user.phone,
          name: user.name,
          vcVerified: user.vcVerified || false,
          verifiedGiftingBeneficiary: user.isVerifiedGiftingBeneficiary || false,
          type: "Gifting Beneficiary",
          role,
          meters: user.meters || [],
          imageKey: contact?.imageKey || "",
          contactType: contact?.contactType || ""
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
  router.post("/contacts", authMiddleware, (req: Request, res: Response, next: any) => {
    upload.single("image")(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({ success: false, error: err.message });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { phone:phoneNumber, contactType, isImageRemove } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: "Phone number is required" });
      }

      const db = getDB();

      const phone = normalizeIndianPhone(phoneNumber);

      // 1. Find the contact user
      const contactUser = await db.collection("users").findOne({ phone });
      if (!contactUser) {
        return res.status(404).json({ success: false, error: "User with this phone number not found on our system" });
      }

      if (!contactUser.vcVerified) {
        return res.status(403).json({ success: false, error: "User with this phone number is not verified" });
      }
      
      if (!contactUser.isVerifiedGiftingBeneficiary) {
        return res.status(403).json({ success: false, error: "User with this phone number is not a gifting beneficiary" });
      }


      if (contactUser._id.toString() === user.userId.toString()) {
        return res.status(400).json({ success: false, error: "Cannot add yourself as a contact" });
      }

      const userIdObj = new ObjectId(user.userId);
      let key = "";

      // Handle image upload if present
      if (req.file) {
        try {
          key = await S3Service.uploadFile(req.file.buffer, req.file.mimetype);
        } catch (error) {
          console.error("Failed to upload image:", error);
          return res.status(500).json({ success: false, error: "Failed to upload image" });          
        }
      }

      // 2. Add to contacts collection (upsert to avoid duplicates)
      const updateData: any = {
        userId: userIdObj,
        contactUserId: contactUser._id,
        updatedAt: new Date()
      };

      if (contactType !== undefined) {
          updateData.contactType = contactType; // can be null
      }

      if (key) {
        updateData.imageKey = key;
      } else if (isImageRemove === 'true' || isImageRemove === true) {
        updateData.imageKey = null;
      }


      await db.collection("contacts").updateOne(
        { userId: userIdObj, contactUserId: contactUser._id },
        {
          $set: updateData,
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      return res.status(200).json({
        success: true,
        message: "Contact added successfully",
      });

    } catch (error: any) {
      console.error("[API] Error adding contact:", error.message);
      return res.status(500).json({ success: false, error: "Failed to add contact" });
    }
  });

  // POST /api/gifting-options - Create a new gifting option
  router.post("/gifting-options", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const validationResult = createGiftingOptionSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({ success: false, error: "Validation failed", details: validationResult.error.issues });
      }

      const {
        beneficiaryUserId,
        badge,
        deliveryDescription,
        quantity,
        price,
        contributionAmount,
        startHour,
        duration,
        sourceType,
        deliveryDate
      } = validationResult.data;

      const db = getDB();

      // 1. Validate beneficiary
      const beneficiary = await db.collection("users").findOne({ _id: new ObjectId(beneficiaryUserId) });
      if (!beneficiary) {
        return res.status(404).json({ success: false, error: "Beneficiary not found" });
      }

      if (!beneficiary.isVerifiedGiftingBeneficiary) {
        return res.status(400).json({ success: false, error: "User is not a verified gifting beneficiary" });
      }

      // 2. Security Check: Ensure the beneficiary is in the requester's contacts
      const contactEntry = await db.collection("contacts").findOne({
        userId: new ObjectId(user.userId),
        contactUserId: new ObjectId(beneficiaryUserId)
      });

      if (!contactEntry) {
        return res.status(403).json({ success: false, error: "Beneficiary is not in your contacts" });
      }

      // 3. Create gifting option
      const giftingOption = {
        beneficiaryUserId: new ObjectId(beneficiaryUserId),
        badge,
        beneficiaryName: beneficiary.name,
        deliveryDescription,
        quantity: Number(quantity || 5),
        price: Number(price || 0), // Order price (e.g., 0)
        contributionAmount: Number(contributionAmount), // UI price
        startHour: Number(startHour || 11),
        duration: Number(duration || 1),
        sourceType: sourceType || "SOLAR",
        isGift: true,
        isActive: true,
        deliveryDate: new Date(deliveryDate),
        createdBy: new ObjectId(user.userId),
        createdAt: new Date()
      };

      const result = await db.collection("gifting_options").insertOne(giftingOption);

      return res.status(201).json({
        success: true,
        message: "Gifting option created successfully",
        giftingOption: { ...giftingOption, _id: result.insertedId }
      });

    } catch (error: any) {
      console.error("[API] Error creating gifting option:", error.message);
      return res.status(500).json({ success: false, error: "Failed to create gifting option" });
    }
  });

  // GET /api/gifting-options/:userId - Get gifting options for a beneficiary
  router.get("/gifting-options/:userId", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const validationResult = getGiftingOptionsSchema.safeParse(req.params);

      if (!validationResult.success) {
        return res.status(400).json({ success: false, error: "Invalid User ID format" });
      }

      const { userId } = validationResult.data;
      const db = getDB();

      // Security Check: Ensure the requested beneficiary (userId) is in the requester's (user.userId) contacts
      const contactEntry = await db.collection("contacts").findOne({
        userId: new ObjectId(user.userId),
        contactUserId: new ObjectId(userId)
      });

      if (!contactEntry) {
        return res.status(403).json({ success: false, error: "User is not in your contacts" });
      }

      const options = await db.collection("gifting_options").find({
        beneficiaryUserId: new ObjectId(userId),
        createdBy: new ObjectId(user.userId),
        isActive: true
      }).toArray();

      return res.status(200).json({
        success: true,
        options
      });

    } catch (error: any) {
      console.error("[API] Error fetching gifting options:", error.message);
      return res.status(500).json({ success: false, error: "Failed to fetch gifting options" });
    }
  });

  // GET /loan - return loan flow URL
  router.get("/loan", (req: Request, res: Response) => {
    try {
      const loanUrl = process.env.LOAN_URL;

      if (!loanUrl) {
        throw new Error("LOAN_URL not configured");
      }

      const solarPay = [
        {
          title: "₹0 installation cost",
          description: "We install a premium 10kW solar system with digital backed financing. No upfront payment required."
        },
        {
          title: "Energy sales repay your EMI",
          description: "70% of our electricity is sold in our marketplace at a guaranteed buyback price that covers your EMI."
        },
        {
          title: "You own the system fully",
          description: "After the 5–7 year loan tenure, 100% of the electricity and savings are yours for the remaining 15–20+ years."
        }
      ];

      const knowMore = `
<div>
  <h3>Terra Rex Energy</h3>
  <p>Zero Upfront Solar Ownership Model (Become Urjadata)</p>

  <h4>1. The Big Idea</h4>
  <p>Install a 10kW rooftop solar system at zero upfront cost. Use part of the electricity for your home. Sell the remaining electricity through our energy marketplace. The earnings from the sale automatically repay your loan. After the loan ends, you own 100% of the solar system.</p>

  <h4>2. How It Works (Simple 4 Steps)</h4>
  <p><strong>Step 1 – Instant Loan Approval</strong><br>
  We arrange digital financing through our NBFC partner.<br>
  No heavy paperwork. Fast approval.</p>

  <p><strong>Step 2 – Professional Installation</strong><br>
  We install a premium 10kW solar system at your home.<br>
  You pay nothing upfront.</p>

  <p><strong>Step 3 – Energy Split Model</strong><br>
  Your system generates approximately 1,200 units per month on average.<br>
  Energy split:<br>
  • 30% → Used at home<br>
  • 70% → Sold through our energy marketplace</p>

  <p><strong>Step 4 – Loan Repayment Through Energy Sales</strong><br>
  We guarantee a minimum buyback price for your 70% energy.<br>
  This guaranteed payout covers your EMI.<br>
  If market price goes higher, you keep the extra profit.</p>

  <h4>3. Real Example (North India – 10kW System)</h4>
  <p>Average generation: 1,200 units per month</p>
  
  <p><strong>Your Share (30%)</strong><br>
  360 units used at home<br>
  If electricity rate = ₹8 per unit<br>
  Savings = ₹2,880 per month</p>

  <p><strong>Marketplace Share (70%)</strong><br>
  840 units sold<br>
  If guaranteed rate = ₹6 per unit<br>
  Guaranteed payout = ₹5,040 per month</p>

  <p><strong>Total Monthly Impact</strong><br>
  ₹2,880 savings + ₹5,040 payout = ₹7,920 benefit<br>
  If EMI = ₹5,000<br>
  You are still positive.</p>

  <h4>4. What Happens After Loan Completion?</h4>
  <p>After loan tenure, typically 5–7 years:<br>
  • 100% of electricity is yours<br>
  • No EMI<br>
  • No sharing<br>
  • Full savings or full earning</p>

  <p>Solar panels last 25+ years.<br>
  That means 15–20 years of pure benefit after loan closure.</p>

  <h4>5. Why This Model Works</h4>
  <ul>
    <li>No upfront investment</li>
    <li>Immediate electricity savings</li>
    <li>Guaranteed minimum payout</li>
    <li>Upside when energy prices rise</li>
    <li>Long-term asset ownership</li>
    <li>25+ year system life</li>
  </ul>

  <h4>6. Who Is This Ideal For?</h4>
  <p>Best suited for homeowners who:</p>
  <ul>
    <li>Have ₹8,000+ monthly electricity bill</li>
    <li>Have shadow-free rooftop space</li>
    <li>Want long-term energy security</li>
    <li>Prefer asset creation over expense</li>
  </ul>

  <h4>7. Risk Protection</h4>
  <p><strong>What if energy prices fall?</strong><br>
  Minimum price guarantee protects EMI.</p>
  
  <p><strong>What if generation is lower?</strong><br>
  System designed conservatively with buffer.</p>

  <p><strong>What if the market fluctuates?</strong><br>
  Floor price structure ensures stability.</p>

  <h4>8. Why Terra Rex Energy?</h4>
  <ul>
    <li>NBFC-backed digital financing</li>
    <li>Professional installation team</li>
    <li>Real-time monitoring app</li>
    <li>Guaranteed minimum buyback structure</li>
    <li>Long-term service support</li>
  </ul>

  <h4>9. The Long-Term Value</h4>
  <p>Solar is not an expense.<br>
  It is a 25-year energy asset.</p>
  <p>With this model:<br>
  • You start saving immediately<br>
  • You do not pay upfront<br>
  • The system pays itself<br>
  • You own it fully after loan</p>
</div>
`;

      return res.status(200).json({
        success: true,
        data: {
          url: loanUrl,
          solarPay,
          knowMore
        }
      });
    } catch (error: any) {
      console.error("[API] Error fetching loan URL:", error);
      return res.status(500).json({ success: false, error: "Failed to fetch loan URL" });
    }
  });

  return router;
}
