/**
 * User Authentication Routes
 *
 * POST /api/auth/login - Phone + PIN authentication
 * POST /api/auth/verify-vc - VC verification (requires JWT)
 * GET /api/auth/me - Get user profile (requires JWT)
 */

import axios from 'axios';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { smsService } from '../services/sms-service';
import crypto from "crypto";
import { createBecknAuthHeader } from '../services/ledger-client';
import { otpSendLimiter } from "./rate-limiter";

import { getDB } from '../db';

import type { Request, Response, NextFunction } from 'express';


// JWT Configuration - RS256 (Asymmetric)
const ACCESS_TOKEN_EXPIRY: string = process.env.ACCESS_TOKEN_EXPIRY || '1h';
const REFRESH_TOKEN_EXPIRY: string = process.env.REFRESH_TOKEN_EXPIRY || '30d';
// Module-level constants
const OTP_EXPIRY_MINUTES: number = parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);
// VC Verification API
const VC_API_BASE = process.env.VC_API_BASE;
const VC_TIMEOUT = 10000; // 10 seconds

// Valid VC types we accept
const VALID_VC_TYPES = [
  'UtilityCustomerCredential',
  'ConsumptionProfileCredential',
  'GenerationProfileCredential',
  'StorageProfileCredential',
  'UtilityProgramEnrollmentCredential',
] as const;

type VCType = typeof VALID_VC_TYPES[number];

// VC Type to profile field mapping
const VC_TYPE_TO_PROFILE: Record<VCType, string> = {
  UtilityCustomerCredential: 'utilityCustomer',
  ConsumptionProfileCredential: 'consumptionProfile',
  GenerationProfileCredential: 'generationProfile',
  StorageProfileCredential: 'storageProfile',
  UtilityProgramEnrollmentCredential: 'programEnrollment',
};

// --- Zod Schemas ---

const loginSchema = z.object({
  phone: z
    .string()
    .min(10, 'Phone number must be at least 10 digits')
    .max(15, 'Phone number must be at most 15 characters')
    .regex(/^[\d\s]+$/, 'Phone number must contain only digits and spaces'),
  pin: z
    .string()
    .length(6, 'PIN must be exactly 6 digits')
    .regex(/^\d{6}$/, 'PIN must be 6 digits'),
  fcmToken: z.string().optional(),
});

const vcDocumentSchema = z.object({
  id: z
    .string()
    .min(1, 'Credential id is required')
    .regex(/^did:rcw:/, "Credential id must start with 'did:rcw:'"),
  type: z
    .array(z.string())
    .refine(
      (types) => types.includes('VerifiableCredential'),
      "type array must include 'VerifiableCredential'"
    )
    .refine(
      (types) => types.some((t) => VALID_VC_TYPES.includes(t as VCType)),
      `type array must include one of: ${VALID_VC_TYPES.join(', ')}`
    ),
  credentialSubject: z.object({
    consumerNumber: z.string().min(1, 'consumerNumber is required'),
  }).passthrough(),
}).passthrough();

const verifyVcSchema = z.object({
  credentials: z
    .array(vcDocumentSchema)
    .min(1, 'At least one credential is required')
    .max(10, 'Maximum 10 credentials per request'),
});

const sendOtpSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Phone number must be exactly 10 digits"), // only digits, exactly 10
});

const verifyOtpInputSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Phone number must be exactly 10 digits"), // only digits, exactly 10,
  otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"), // only digits, exactly 6,
  fcmToken: z.string().optional(),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
  fcmToken: z.string().optional(),
});

// --- JWT Utilities (RS256) ---

interface JWTPayload {
  phone: string;
  userId?: string;
  iat: number;
  exp: number; 
  type: string;
}

const privateKey = process.env.JWT_PRIVATE_KEY;
function signAccessToken(phone: string, userId?: string): string {
  return jwt.sign({ phone, userId, type: "access" }, privateKey as string, {
    algorithm: "RS256",
    expiresIn: ACCESS_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'],
  });
}

function signRefreshToken(phone: string, userId?: string): string {
  return jwt.sign({ phone, userId, type: "refresh" }, privateKey as string, {
    algorithm: "RS256",
    expiresIn: REFRESH_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'],
  });
}

// Backwards compatibility alias
const signToken = signAccessToken;

const publicKey = process.env.JWT_PUBLIC_KEY;
function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, publicKey as string, {
    algorithms: ["RS256"],
  }) as JWTPayload;
}

function verifyRefreshToken(token: string): JWTPayload {
  return jwt.verify(token, publicKey as string, {
    algorithms: ["RS256"],
  }) as JWTPayload;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

// --- Middleware ---

function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.issues.map((e: z.ZodIssue) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      });
    }
    next();
  };
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
      },
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (_err: any) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'TOKEN_MALFORMED',
        message: 'Invalid or malformed token',
      },
    });
  }
}

// --- Handlers ---

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export async function findOrCreateUser(db: Db, phone: string) {
  // Check if user exists
  let user = await db.collection("users").findOne({ phone });

  // If not, create the user
  if (!user) {
    console.log(`[Auth] Creating new user for phone: ${phone}`);
    const timestamp = new Date()
    const result = await db.collection('users').insertOne({
        phone,
        createdAt: timestamp,
        updatedAt: timestamp,
        vcVerified: false,
        meters: [],
      });
    user = await db.collection("users").findOne({ _id: result.insertedId });
  }

  return user;
}


export function normalizeIndianPhone(phoneNumber: string): string {

  // Strip +91 if already present
  if (phoneNumber.startsWith("+91")) {
    phoneNumber = phoneNumber.slice(3);
  }

  // Validate 10-digit number
  if (!/^\d{10}$/.test(phoneNumber)) {
    throw new Error("Invalid phone number. Must be a 10-digit Indian mobile number");
  }

  // Return normalized phone with +91
  return `+91${phoneNumber}`;
}

async function sendOtp(req: Request, res: Response) {
  let { phone: phoneNumber } = req.body;

  const phone = normalizeIndianPhone(phoneNumber);

  console.log(`[Auth] Received OTP request for phone: ${phone}`); // Debug log
  const db = getDB();

  try {
    /*
     * Pilot mode: only pre-approved users can login.
     * Users must be added directly to the `users` collection in MongoDB
     * before they can request an OTP. No auto-creation on first request.
     *
     * Previously this called findOrCreateUser() which would insert a new
     * user record for any phone number. That is disabled for the pilot to
     * restrict access to a curated set of participants.
     */
    const user = await db.collection('users').findOne({ phone });

    if (!user) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'This phone number is not registered for the pilot program.',
        },
      });
    }

    const userId = user._id;

    // 2. Rate Limiting Check using rate-limiter-flexible
    try {
      let resl = await otpSendLimiter.consume(phone);
    } catch (rateLimiterRes: any) {
      // rateLimiterRes.msBeforeNext gives milliseconds until the next available point
      const retryAfterSeconds = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
      const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);

      return res.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message:`Max OTP send attempts reached. Please try again in ${retryAfterMinutes} minutes.`,
        },
      });
    }

    // 3. Generate and Save OTP
    const now = new Date();
    const otp = generateOtp();
    const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000); // 5 minutes expiry
    const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

    await db.collection("otps").updateOne(
      { phone },
      {
        $set: {
          userId,
          otp: hashedOtp,
          expiresAt,
          verified: false,
          attempts: 0, // Reset verify attempts for new OTP
          lastRequestAt: now,
        },
      },
      { upsert: true },
    );

    // add SNS to send otp
    const message = `Your Terrarex login OTP is ${otp}`;
    const messageId = await smsService.sendSms(phone, message);

    console.log(`[Auth] SMS sent to ${phone}, MessageId: ${messageId}, ${otp}`);

    return res.json({
      success: true,
      message: "OTP sent successfully",
    });
  } catch (err: any) {
    console.error("Send OTP Error:", err);
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to send OTP",
      },
    });
  }
}

async function verifyOtp(req: Request, res: Response) {
  let { phone: phoneNumber, otp, fcmToken } = req.body;
  const db = getDB();

  const phone = normalizeIndianPhone(phoneNumber);


  try {
    const otpRecord = await db.collection('otps').findOne({ phone });
    const now = new Date();

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'No OTP request found for this number. Please request a new OTP.',
        },
      });
    }

    // 1. Check if blocked by max attempts
    if (otpRecord.attempts >= 5) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MAX_ATTEMPTS_REACHED',
          message: 'Too many failed attempts. Please request a new OTP.',
        },
      });
    }

    // 2. Check Expiry
    if (otpRecord.expiresAt < now) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'OTP_EXPIRED',
          message: 'OTP has expired. Please request a new one.',
        },
      });
    }

    const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

    // 3. Verify Code
    if (otpRecord.otp !== hashedOtp) {
      // Increment attempts
      await db.collection('otps').updateOne(
        { phone },
        { $inc: { attempts: 1 } }
      );

      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_OTP',
          message: 'Invalid OTP. Please try again.',
        },
      });
    }

    // 4. Success Flow
    // Don't delete, just mark verified or consume (we keep it for rate limiting history)
    await db.collection('otps').updateOne(
      { phone },
      {
        $set: { verified: true },
        $unset: { otp: "" } // Optional: remove OTP so it can't be reused
      }
    );

    // Update FCM Token if provided
    if (fcmToken) {
      await db.collection("users").updateOne(
        { _id: otpRecord.userId },
        { $set: { fcmToken, updatedAt: new Date() } }
      );
    }

    const user = await db.collection('users').findOne({ _id: otpRecord.userId });

    if (!user) {
      // Should not happen as we created it in sendOtp, but safe falback
      return res.status(500).json({
        success: false,
        error: {
          code: 'USER_SYNC_ERROR',
          message: 'User record missing.',
        },
      });
    }

    const token = signAccessToken(phone, user._id.toString());
    const refreshToken = signRefreshToken(phone, user._id.toString());

    return res.json({
      success: true,
      accessToken: token,
      refreshToken,
      user: {
        phone: user.phone,
        name: user.name,
        vcVerified: user.vcVerified || false,
      },
    });

  } catch (err: any) {
    console.error('Verify OTP Error:', err);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to verify OTP',
      },
    });
  }
}
/**
 * @deprecated Use `send-otp` (the new auth flow) instead.
 * This method is kept only for backward compatibility.
 */
async function login(req: Request, res: Response) {
  const { phone, pin, fcmToken } = req.body;

  // Normalize phone (keep spaces for now, just use as-is for lookup)
  const db = getDB();
  const user = await db.collection('users').findOne({ phone });

  if (!user || user.pin !== pin) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid phone number or PIN',
      },
    });
  }

  // Update FCM Token if provided
  if (fcmToken) {
    await db.collection("users").updateOne(
      { _id: user._id },
      { $set: { fcmToken, updatedAt: new Date() } }
    );
  }

  const token = signAccessToken(phone, user._id.toString());
  const refreshToken = signRefreshToken(phone, user._id.toString());

  return res.json({
    success: true,
    /**
     * @deprecated Use `accessToken` instead.
     * Kept only for backward compatibility.
     */
    token, // deprecated
    accessToken: token,
    refreshToken,
    user: {
      phone: user.phone,
      name: user.name,
      vcVerified: user.vcVerified || false,
    },
  });
}

async function verifyVc(req: Request, res: Response) {
  const { credentials } = req.body;
  const phone = req.user!.phone;

  const db = getDB();
  const user = await db.collection('users').findOne({ phone });

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      },
    });
  }

  const verified: Record<string, boolean> = {};
  const failed: Array<{ did: string; type: string; reason: string }> = [];
  const profileUpdates: Record<string, any> = {};
  const newMeters = new Set<string>(user.meters || []);

  for (const vc of credentials) {
    const did = vc.id;
    const vcType = vc.type.find((t: string) => VALID_VC_TYPES.includes(t as VCType)) as VCType;
    const profileField = VC_TYPE_TO_PROFILE[vcType];

    try {
      // Call external verify API
      const verifyUrl = `${VC_API_BASE}/${encodeURIComponent(did)}/verify`;
      const response = await axios.get(verifyUrl, {
        timeout: VC_TIMEOUT,
        headers: { Authorization: createBecknAuthHeader('') },
      });
      const { status, checks } = response.data;

      // Check verification status
      if (status !== 'ISSUED') {
        failed.push({
          did,
          type: vcType,
          reason: `Credential status is ${status}, expected ISSUED`,
        });
        continue;
      }

      // Check all verification checks passed
      const failedChecks = [];
      for (const check of checks || []) {
        if (check.revoked && check.revoked !== 'OK') failedChecks.push('revoked');
        if (check.expired && check.expired !== 'OK') failedChecks.push('expired');
        if (check.proof && check.proof !== 'OK') failedChecks.push('proof');
      }

      if (failedChecks.length > 0) {
        failed.push({
          did,
          type: vcType,
          reason: `Verification failed: ${failedChecks.join(', ')} check failed`,
        });
        continue;
      }

      // Verification passed - extract credentialSubject and store
      // Map VC fields to expected profile fields
      const mappedSubject: Record<string, any> = { ...vc.credentialSubject };

      // Map issuerName → utilityId for all credential types that have it
      // (GenerationProfile, ConsumptionProfile, UtilityCustomer all use issuerName for DISCOM)
      if (mappedSubject.issuerName) {
        mappedSubject.utilityId = mappedSubject.issuerName;
        delete mappedSubject.issuerName;
      }

      const profile = {
        did,
        ...mappedSubject,
        verifiedAt: new Date(),
      };

      profileUpdates[`profiles.${profileField}`] = profile;
      verified[profileField] = true;

      // Extract meter number if present
      if (vc.credentialSubject.meterNumber) {
        newMeters.add(vc.credentialSubject.meterNumber);
      }
    } catch (err: any) {
      // Handle different error types
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return res.status(503).json({
          success: false,
          error: {
            code: 'VC_SERVICE_UNAVAILABLE',
            message: 'VC verification service is unavailable. Please try again later.',
          },
        });
      }

      if (err.response?.status >= 500) {
        return res.status(503).json({
          success: false,
          error: {
            code: 'VC_SERVICE_UNAVAILABLE',
            message: 'VC verification service is unavailable. Please try again later.',
          },
        });
      }

      if (err.response?.status === 404) {
        failed.push({
          did,
          type: vcType,
          reason: 'Credential not found in verification service',
        });
        continue;
      }

      // Other 4xx errors
      failed.push({
        did,
        type: vcType,
        reason: `Verification failed: ${err.response?.data || err.message}`,
      });
    }
  }

  // Update user in database
  const hasVerifiedAny = Object.keys(verified).length > 0;
  const updateDoc: any = {
    ...profileUpdates,
    meters: Array.from(newMeters),
    updatedAt: new Date(),
  };

  if (hasVerifiedAny) {
    updateDoc.vcVerified = true;
  }

  await db.collection('users').updateOne(
    { phone },
    { $set: updateDoc }
  );

  // Fetch updated user
  const updatedUser = await db.collection('users').findOne({ phone });

  return res.json({
    success: true,
    verified,
    failed,
    user: {
      phone: updatedUser!.phone,
      name: updatedUser!.name,
      vcVerified: updatedUser!.vcVerified || false,
    },
  });
}

async function refreshTokenHandler(req: Request, res: Response) {
  const { refreshToken, fcmToken } = req.body;

  try {
    // 1. Verify the refresh token
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded || decoded?.type !== "refresh") {
      return res.status(401).json({
        success: false,
        error: {
          code: "INVALID_REFRESH_TOKEN",
          message: "Invalid Refresh Token",
        },
      });
    }

    // 2. Check if user still exists
    const db = getDB();
    const user = await db.collection("users").findOne({
      _id: new ObjectId(decoded.userId),
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: "USER_NOT_FOUND",
          message: "User no longer exists",
        },
      });
    }

    // Update FCM Token if provided
    if (fcmToken) {
      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { fcmToken, updatedAt: new Date() } }
      );
    }

    // 3. Issue new tokens (Sliding Expiration: new RT has fresh 30d)
    const newAccessToken = signAccessToken(user.phone, user._id.toString());
    const newRefreshToken = signRefreshToken(user.phone, user._id.toString());

    return res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err: any) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_REFRESH_TOKEN',
        message: err?.message || 'Invalid or expired refresh token',
      },
    });
  }
}

async function getMe(req: Request, res: Response) {

  const userDetails = req.user;

  if (!userDetails) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized access',
      },
    });
  }
  
  const db = getDB();
  const user = await db.collection('users').findOne({ _id: new ObjectId(userDetails.userId) });
  
  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      },
    });
  }

  // Derive role based on generationProfile
  const role = user.profiles?.generationProfile ? 'prosumer' : 'consumer';

  return res.json({
    success: true,
    user: {
      phone: user.phone,
      name: user.name,
      vcVerified: user.vcVerified || false,
      role,
      profiles: {
        utilityCustomer: user.profiles?.utilityCustomer || null,
        consumptionProfile: user.profiles?.consumptionProfile || null,
        generationProfile: user.profiles?.generationProfile || null,
        storageProfile: user.profiles?.storageProfile || null,
        programEnrollment: user.profiles?.programEnrollment || null,
      },
      meters: user.meters || [],
      memberSince: user.createdAt,
    },
  });
}

// --- Router ---

export function authRoutes(): Router {
  const router = Router();

  // POST /api/auth/login
  router.post('/auth/login', validateBody(loginSchema), login);

  // POST /api/auth/send-otp
  router.post('/auth/send-otp', validateBody(sendOtpSchema), sendOtp);

  // POST /api/auth/verify-otp
  router.post('/auth/verify-otp', validateBody(verifyOtpInputSchema), verifyOtp);

  // POST /api/auth/refresh-token
  router.post('/auth/refresh-token', validateBody(refreshTokenSchema), refreshTokenHandler);

  // POST /api/auth/verify-vc (requires JWT)
  router.post('/auth/verify-vc', authMiddleware, validateBody(verifyVcSchema), verifyVc);

  // GET /api/auth/me (requires JWT)
  router.get('/auth/me', authMiddleware, getMe);

  return router;
}

// Export utilities for testing
export { signToken, verifyToken, authMiddleware, validateBody, loginSchema, verifyVcSchema, sendOtpSchema, verifyOtpInputSchema, signRefreshToken, verifyRefreshToken };
