import { Router } from "express";

import { getDB } from "../db";

import type { Request, Response } from "express";
import { authMiddleware } from "../auth/routes";
import { normalizeIndianPhone } from "../utils";

import { ObjectId } from "mongodb";
import { z } from "zod";
import multer from "multer";
import { S3Service } from "../services/s3-service";
import { paymentService } from "../services/payment-service";
import { smsService } from "../services/sms-service";
import { generateOtp } from "../auth/routes";
import { getUserTransactionHistory } from "../services/report-service";
import crypto from "crypto";

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
  badge: z.string().min(1, "Badge is required"),
  deliveryDescription: z.string().min(1, "Delivery description is required"),
  quantity: z.number().positive().max(1000), // kWh
  price: z.number().min(0, "Price cannot be negative"),
  contributionAmount: z.number().min(0, "Contribution amount cannot be negative"),
  startHour: z.number().int().min(0).max(23).default(10),
  duration: z.number().int().min(1).max(12).default(1),
  sourceType: z.enum(["SOLAR", "WIND", "HYDRO"]).default("SOLAR"),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const payoutDetailsSchema = z.object({
  // name: z.string().min(1, "Name is required"),
  accountType: z.enum(["bank_account", "vpa"]),
  bankAccount: z.object({
    accountNumber: z.string().min(5),
    ifsc: z.string().min(11).max(11),
  }).optional(),
  upiId: z.string().optional(),
}).refine((data) => {
  if (data.accountType === "bank_account") return !!data.bankAccount;
  if (data.accountType === "vpa") return !!data.upiId;
  return false;
}, { message: "Provide appropriate details based on accountType" });

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
          key = await S3Service.uploadFile(req.file.buffer, req.file.mimetype,"contacts");
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

      // 3. Create gifting option
      const giftingOption: any = {
        badge,
        deliveryDescription,
        quantity: Number(quantity || 5),
        price: Number(price || 0), // Order price (e.g., 0)
        contributionAmount: Number(contributionAmount), // UI price
        startHour: Number(startHour || 11),
        duration: Number(duration || 1),
        sourceType: sourceType || "SOLAR",
        isGift: true,
        isActive: true,
        createdBy: new ObjectId(user.userId),
        createdAt: new Date()
      };

      if (deliveryDate) {
        giftingOption.deliveryDate = new Date(deliveryDate);
      }
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
          description: "We install a premium 10 units solar system with digital backed financing. No upfront payment required."
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
  <p>Install a 10 units rooftop solar system at zero upfront cost. Use part of the electricity for your home. Sell the remaining electricity through our energy marketplace. The earnings from the sale automatically repay your loan. After the loan ends, you own 100% of the solar system.</p>

  <h4>2. How It Works (Simple 4 Steps)</h4>
  <p><strong>Step 1 – Instant Loan Approval</strong><br>
  We arrange digital financing through our NBFC partner.<br>
  No heavy paperwork. Fast approval.</p>

  <p><strong>Step 2 – Professional Installation</strong><br>
  We install a premium 10 units solar system at your home.<br>
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

  <h4>3. Real Example (North India – 10 units System)</h4>
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

  // POST /api/profile-image - Add a user profile image
  router.post(
    "/profile-image",
    authMiddleware,
    (req: Request, res: Response, next: any) => {
      upload.single("image")(req, res, (err: any) => {
        if (err) {
          return res.status(400).json({ success: false, error: err.message });
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const user = (req as any).user;
        if (!user) {
          return res
            .status(401)
            .json({ success: false, error: "Unauthorized" });
        }
        const db = getDB();
        const userProfile = await db
          .collection("users")
          .findOne({ phone: user.phone });

        if (!userProfile) {
          return res
            .status(404)
            .json({ success: false, error: "User profile not found" });
        }
        let imgUri = "";
        if (req.file) {
          try {
            // Upload to S3 with 'donate' folder
            imgUri = await S3Service.uploadFile(
              req.file.buffer,
              req.file.mimetype,
              "user",
            );
          } catch (error) {
            console.error("[EnergyRequest] S3 Upload Error:", error);
            return res
              .status(500)
              .json({ success: false, error: "Failed to upload image" });
          }
          await db.collection("users").updateOne(
            { _id: userProfile._id},
            {
              $set: {imgUri}
            }
          );

          return res.status(200).json({
            success: true,
            message: "Image added successfully",
          });
        }else{
            return res.status(404).json({
            success: false,
            message: "Image Not Found",
          });
        }
      } catch (error) {
                   console.error("Failed to upload profile image:", error);
            return res
              .status(500)
              .json({ success: false, error: "Failed to profile image" });
      }
    },
  );
  
  // GET /discoms - Get list of discoms
  router.get("/discoms", async (req: Request, res: Response) => {
    try {
      const db = getDB();
      const discoms = await db.collection("discoms").find({}, { projection: { _id: 0, name: 1, link: 1 } }).toArray();
      console.log("[API Discom List Length]", discoms.length)
      return res.status(200).json({
        success: true,
        discoms
      });
    } catch (error: any) {
      console.error("[API] Error fetching discoms:", error);
      return res.status(500).json({ success: false, error: "Failed to fetch discoms" });
    }
  });

  // --- Payout Verification & OTP Flow ---

  /**
   * Step 1: Verify Bank Account or UPI details
   * POST /api/payout-details/verify
   * - Validates the account via RazorpayX
   * - Returns the account holder name
   */
  router.post("/payout-details/verify", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });
      const { accountType, bankAccount, upiId } = payoutDetailsSchema.parse(req.body);

      // Both UPI and Bank use the same /v1/fund_accounts/validations endpoint,
      // with polling until completed.
      let validationData: any;

      if (accountType === "vpa") {
        validationData = await paymentService.validateBankAccount(
          upiId!,   // accountNumber slot holds UPI address for VPA type
          "",       // ifsc is not applicable for VPA
          "Customer",
          { maxWaitMs: 20000 } // VPA typically resolves faster
        );
      } else {
        validationData = await paymentService.validateBankAccount(
          bankAccount!.accountNumber,
          bankAccount!.ifsc
        );
      }

      if (validationData.results?.account_status === "invalid") {
        return res.status(400).json({
          success: false,
          error: accountType === "vpa"
            ? "Invalid UPI ID. Please check and try again."
            : "Bank account details could not be verified. Please check and try again."
        });
      }

      return res.status(200).json({
        success: true,
        accountHolderName: validationData.results?.registered_name || null,
        validationData
      });
    } catch (error: any) {
      console.error("[API] Payout verification failed:", error.response?.data || error.message);
      const errorMsg = error.response?.data?.error?.description || "Failed to verify account details";
      return res.status(error.response?.status || 400).json({ success: false, error: errorMsg });
    }
  });


  /**
   * Step 2: Send OTP to registered mobile for Payout Confirmation
   * POST /api/payout-details/send-otp
   */
  router.post("/payout-details/send-otp", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

      const db = getDB();
      const userDoc = await db.collection("users").findOne({ _id: new ObjectId(user.userId) });
      if (!userDoc || !userDoc.phone) {
        return res.status(404).json({ success: false, error: "User phone not found" });
      }

      // Generate 6-digit OTP
      const otp = generateOtp();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
      const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

      // Store in DB (upsert for the user)
      await db.collection("otps").updateOne(
        { userId: new ObjectId(user.userId), purpose: "payout_setup" },
        {
          $set: {
            otp: hashedOtp,
            expiresAt,
            verified: false,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      // Send SMS
      const message = `Your OTP for adding payout details is ${otp}. Valid for 5 minutes.`;
      const messageId = await smsService.sendSms(userDoc.phone, message);

      console.log(`[Payout] SMS sent to ${userDoc.phone}, MessageId: ${messageId}`);

      return res.status(200).json({
        success: true,
        message: "OTP sent to your registered mobile number"
      });
    } catch (error: any) {
      console.error("[API] Error sending payout OTP:", error.message);
      return res.status(500).json({ success: false, error: "Failed to send OTP" });
    }
  });

  /**
   * Step 3: Verify OTP
   * POST /api/payout-details/verify-otp
   */
  router.post("/payout-details/verify-otp", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { otp } = req.body;

      if (!otp) return res.status(400).json({ success: false, error: "OTP is required" });

      const db = getDB();
      const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");
      const otpDoc = await db.collection("otps").findOne({
        userId: new ObjectId(user.userId),
        purpose: "payout_setup",
        otp: hashedOtp,
        expiresAt: { $gt: new Date() }
      });

      if (!otpDoc) {
        return res.status(400).json({ success: false, error: "Invalid or expired OTP" });
      }

      // Mark as verified
      await db.collection("otps").updateOne(
        { _id: otpDoc._id },
        { $set: { verified: true, updatedAt: new Date() } }
      );

      return res.status(200).json({
        success: true,
        message: "OTP verified successfully"
      });
    } catch (error: any) {
      console.error("[API] Error verifying payout OTP:", error.message);
      return res.status(500).json({ success: false, error: "Failed to verify OTP" });
    }
  });

  // POST /payout-details
  router.post("/payout-details", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const db = getDB();

      // SECURITY CHECK: Ensure OTP was verified within the last 15 minutes
      const otpDoc = await db.collection("otps").findOne({
        userId: new ObjectId(user.userId),
        purpose: "payout_setup",
        verified: true,
        updatedAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) }
      });

      if (!otpDoc) {
        return res.status(403).json({
          success: false,
          error: "Verification required. Please verify OTP before saving payout details."
        });
      }

      const validationResult = payoutDetailsSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: validationResult.error.issues,
        });
      }

      const { accountType, bankAccount, upiId } = validationResult.data;
      // Retrieve existing user
      const userProfile = await db.collection("users").findOne({ _id: new ObjectId(user.userId) });
      if (!userProfile) {
        return res.status(404).json({ success: false, error: "User not found" });
      }
      const name = userProfile?.name;

      // Step 1: Create Razorpay Contact (if not already existing in our DB)
      let contactId = userProfile.razorpayContactId;
      if (!contactId) {
        // Use user.userId as the referenceId
        const contact = await paymentService.createContact(
          name,
          userProfile.email || undefined,
          userProfile.phone,
          userProfile.caNumber || user.userId // Reference ID
        );
        contactId = contact.id;
      }

      // Step 2: Create Fund Account
      let fundAccount;
      let lastFourDigit = null;
      let vpaId = null;
      let bankName = null;

      if (accountType === "bank_account" && bankAccount) {
        fundAccount = await paymentService.createFundAccount(
          contactId,
          "bank_account",
          {
            name: name,
            ifsc: bankAccount.ifsc,
            account_number: bankAccount.accountNumber,
          }
        );
        lastFourDigit = bankAccount.accountNumber.slice(-4);
        bankName = fundAccount?.bank_account?.bank_name || fundAccount?.vpa?.bank_name || fundAccount?.vpa?.bank || null;
      } else if (accountType === "vpa" && upiId) {
        fundAccount = await paymentService.createFundAccount(
          contactId,
          "vpa",
          {
            name: name,
            address: upiId,
          }
        );
        vpaId = upiId;
        bankName = fundAccount?.vpa?.bank_name || fundAccount?.vpa?.bank || fundAccount?.bank_account?.bank_name || null;
      } else {
        return res.status(400).json({ success: false, error: "Invalid account details provided" });
      }

      // Step 3: Save Reference IDs to Database
      const newFundAccountRecord = {
        id: fundAccount.id,
        accountType: accountType,
        ...(lastFourDigit ? { lastFourDigit } : {}),
        ...(vpaId ? { vpaId } : {}),
        ...(bankName ? { bankName } : {}),
        addedAt: new Date()
      };

      const isFirstAccount = !userProfile.razorpayFundAccountId;

      const updatePayload: any = {
        $push: {
          fundAccounts: newFundAccountRecord
        } as any
      };

      if (isFirstAccount) {
        updatePayload.$set = {
          razorpayContactId: contactId,
          razorpayFundAccountId: fundAccount.id, // Set as default since it's the first one
          payoutAccountType: accountType,
          ...(lastFourDigit ? { lastFourDigit } : {}),
          ...(vpaId ? { vpaId } : {}),
          ...(bankName ? { bankName } : {}),
          updatedAt: new Date(),
        };
      }

      await db.collection("users").updateOne(
        { _id: new ObjectId(user.userId) },
        updatePayload
      );

      // Invalidate the OTP immediately after successful save to prevent reuse within the 15-minute window
      await db.collection("otps").deleteOne({
        userId: new ObjectId(user.userId),
        purpose: "payout_setup"
      });

      return res.status(200).json({
        success: true,
        message: "Payout details saved successfully",
      });

    } catch (error: any) {
      console.error("[API] Error saving payout details:", error.message || error);
      return res.status(500).json({ success: false, error: "Failed to save payout details" });
    }
  });

  // GET /payout-details
  router.get("/payout-details", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const db = getDB();
      const userProfile = await db.collection("users").findOne({ _id: new ObjectId(user.userId) });

      if (!userProfile) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      // Query the embedded fundAccounts array
      const fundAccounts = userProfile.fundAccounts || [];

      // Return ONLY the masked identifier and status, NEVER return actual sensitive details
      if (fundAccounts && fundAccounts.length > 0) {
        // Map and enrich accounts (optional: could fetch missing bankNames here)
        const enrichedAccounts = await Promise.all(fundAccounts.map(async (fa: any) => {
          let bName = fa.bankName;

          // If bankName is missing (legacy), try to fetch it once
          if (fa.accountType === "bank_account" && !bName) {
            try {
              const rzpFa = await paymentService.getFundAccount(fa.id);
              bName = rzpFa?.bank_account?.bank_name || null;
              if (bName) {
                // Update DB in background
                db.collection("users").updateOne(
                  { _id: new ObjectId(user.userId), "fundAccounts.id": fa.id },
                  { $set: { "fundAccounts.$.bankName": bName } }
                ).catch(e => console.error("Failed to update bankName in background", e));
              }
            } catch (e) {
              console.error(`Failed to fetch fund account info for ${fa.id}`, e);
            }
          }

          const isPrimary = fa.id === userProfile.razorpayFundAccountId;

          return {
            id: fa.id,
            accountType: fa.accountType,
            title: bName || (fa.accountType === "vpa" ? (fa.vpaId || "UPI Account") : "Bank Account"),
            subtitle: fa.accountType === "vpa" ? `UPI ID - ${fa.vpaId}` : `A/c no - ${fa.lastFourDigit}`,
            lastFourDigit: fa.lastFourDigit,
            vpaId: fa.vpaId,
            bankName: bName,
            isPrimary
          };
        }));

        return res.status(200).json({
          success: true,
          payoutDetails: {
            linked: true,
            primaryAccountId: userProfile.razorpayFundAccountId,
            accounts: enrichedAccounts
          },
        });
      } else if (userProfile.razorpayFundAccountId) {
        // Fallback Enrichment for legacy single account
        let bName = userProfile.bankName;
        if (!bName) {
          try {
            const rzpFa = await paymentService.getFundAccount(userProfile.razorpayFundAccountId);
            bName = rzpFa?.bank_account?.bank_name || rzpFa?.vpa?.bank_name || null;
            if (bName) {
              db.collection("users").updateOne(
                { _id: new ObjectId(user.userId) },
                { $set: { bankName: bName } }
              ).catch(e => console.error("Failed to update legacy bankName", e));
            }
          } catch (e) {
            console.error("Failed to fetch legacy fund account", e);
          }
        }

        return res.status(200).json({
          success: true,
          payoutDetails: {
            linked: true,
            primaryAccountId: userProfile.razorpayFundAccountId,
            accounts: [{
              id: userProfile.razorpayFundAccountId,
              accountType: userProfile.payoutAccountType || "unknown",
              title: bName || (userProfile.payoutAccountType === "vpa" ? "UPI Account" : "Bank Account"),
              subtitle: userProfile.payoutAccountType === "vpa" ? `UPI ID - ${userProfile.vpaId}` : `A/c no - ${userProfile.lastFourDigit}`,
              ...(userProfile.lastFourDigit ? { lastFourDigit: userProfile.lastFourDigit } : {}),
              ...(userProfile.vpaId ? { vpaId: userProfile.vpaId } : {}),
              ...(bName ? { bankName: bName } : {}),
              isPrimary: true
            }]
          },
        });
      } else {
        return res.status(200).json({
          success: true,
          payoutDetails: {
            linked: false,
            accounts: []
          },
        });
      }
    } catch (error: any) {
      console.error("[API] Error fetching payout details:", error.message || error);
      return res.status(500).json({ success: false, error: "Failed to fetch payout details" });
    }
  });

  // PUT /payout-details/primary
  router.put("/payout-details/primary", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { accountId } = req.body;
      if (!accountId) {
        return res.status(400).json({ success: false, error: "Account ID is required" });
      }

      const db = getDB();
      const userProfile = await db.collection("users").findOne({ _id: new ObjectId(user.userId) });

      if (!userProfile) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      // Verify the requested account ID actually belongs to this user's stored funds
      const fundAccounts = userProfile.fundAccounts || [];
      const targetAccount = fundAccounts.find((fa: any) => fa.id === accountId);

      if (!targetAccount) {
        return res.status(404).json({ success: false, error: "Requested account not found in user's saved payout methods" });
      }

      // Update the user profile to swap out the active attributes to this target account
      await db.collection("users").updateOne(
        { _id: new ObjectId(user.userId) },
        {
          $set: {
            razorpayFundAccountId: targetAccount.id,
            payoutAccountType: targetAccount.accountType,
            ...(targetAccount.lastFourDigit ? { lastFourDigit: targetAccount.lastFourDigit } : {}),
            ...(targetAccount.vpaId ? { vpaId: targetAccount.vpaId } : {}),
            ...(targetAccount.bankName ? { bankName: targetAccount.bankName } : {}),
            updatedAt: new Date()
          }
        }
      );

      return res.status(200).json({
        success: true,
        message: "Primary payout method updated successfully"
      });

    } catch (error: any) {
      console.error("[API] Error updating primary payout method:", error.message || error);
      return res.status(500).json({ success: false, error: "Failed to update primary payout method" });
    }
  });

  // GET /api/transactions - Get user transaction history
  router.get("/transactions", authMiddleware, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const transactions = await getUserTransactionHistory(user.userId, user.phone);

      return res.status(200).json({
        success: true,
        transactions
      });
    } catch (error: any) {
      console.error("[API] Error fetching transaction history:", error.message);
      return res.status(500).json({ success: false, error: "Failed to fetch transaction history" });
    }
  });

  return router;
}
