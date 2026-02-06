/**
 * User Authentication Routes
 *
 * POST /api/auth/login - Phone + PIN authentication
 * POST /api/auth/verify-vc - VC verification (requires JWT)
 * GET /api/auth/me - Get user profile (requires JWT)
 */

import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import axios from 'axios';
import { getDB } from '../db';
import { ObjectId } from 'mongodb';
import { smsService } from '../services/sms-service';

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'p2p-trading-pilot-secret';
const REFRESH_SECRET = process.env.REFRESH_SECRET || (JWT_SECRET + '_refresh');

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = '30d';

// VC Verification API
const VC_API_BASE = 'https://35.244.45.209.sslip.io/credential/credentials';
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
  phone: z
    .string()
    .min(10, 'Phone number must be at least 10 digits')
    .max(10, 'Phone number must be at most 10 characters')
    .regex(/^[\d]+$/, 'Phone number must contain only digits'),
});

const verifyOtpInputSchema = z.object({
  phone: z
    .string()
    .min(10, "Phone number is required")
    .max(10, "Phone number must be at most 10 characters")
    .regex(/^[\d]+$/, "Phone number must contain only digits"),
  otp: z.string().length(6, "OTP must be 6 digits"),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

// --- JWT Utilities ---

interface JWTPayload {
  phone: string;
  userId?: string;
  iat: number;
  exp: number; 
  type: string;
}

function signAccessToken(phone: string, userId?: string): string {
  return jwt.sign({ phone, userId, type: 'access' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_EXPIRY
  });
}

function signRefreshToken(phone: string, userId?: string): string {
  return jwt.sign({ phone, userId, type: 'refresh' }, REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: REFRESH_TOKEN_EXPIRY
  });
}

// Backwards compatibility alias if needed, or deprecate
const signToken = signAccessToken;

function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

function verifyRefreshToken(token: string): JWTPayload {
  return jwt.verify(token, REFRESH_SECRET) as JWTPayload;
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
  } catch (err: any) {
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
  // Generate a random 6-digit number
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOtp(req: Request, res: Response) {
  const { phone } = req.body;
  console.log(`[Auth] Received OTP request for phone: ${phone}`); // Debug log
  const db = getDB();

  try {
    // 1. Check if user exists, create if not
    let user = await db.collection('users').findOne({ phone });

    if (!user) {
      console.log(`[Auth] Creating new user for phone: ${phone}`);
      const result = await db.collection('users').insertOne({
        phone,
        createdAt: new Date(),
        updatedAt: new Date(),
        vcVerified: false,
        meters: [],
      });
      user = await db.collection('users').findOne({ _id: result.insertedId });
    }

    if (!user) {
      throw new Error("Failed to find or create user");
    }

    const userId = user._id;

    // 2. Rate Limiting Check
    const existingOtp = await db.collection('otps').findOne({ phone });
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    let sendAttempts = existingOtp?.sendAttempts || 0;
    let lastRequestAt = existingOtp?.lastRequestAt || new Date(0);

    // Reset attempts if window passed
    if (lastRequestAt < tenMinutesAgo) {
      sendAttempts = 0;
    }

    if (sendAttempts >= 5) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Max OTP send attempts reached. Please try again in 10 minutes.',
        },
      });
    }

    // 3. Generate and Save OTP
    const otp = generateOtp();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes expiry

    const updateDoc: any = {
      $set: {
        userId,
        otp,
        expiresAt,
        verified: false,
        attempts: 0, // Reset verify attempts for new OTP
        lastRequestAt: now,
      }
    };

    if (lastRequestAt < tenMinutesAgo) {
      // Reset window: Set sendAttempts to 1
      updateDoc.$set.sendAttempts = 1;
    } else {
      // Within window: Increment sendAttempts
      updateDoc.$inc = { sendAttempts: 1 };
    }

    await db.collection('otps').updateOne(
      { phone },
      updateDoc,
      { upsert: true }
    );

    // add SNS to send otp
    const message = `Your Terrarex login OTP is ${otp}`;
    const messageId = await smsService.sendSms(`+91${phone}`, message);

    console.log(`[Auth] SMS sent to ${phone}, MessageId: ${messageId}`);

    return res.json({
      success: true,
      message: 'OTP sent successfully',
    });

  } catch (err: any) {
    console.error('Send OTP Error:', err);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to send OTP',
      },
    });
  }
}

async function verifyOtp(req: Request, res: Response) {
  const { phone, otp } = req.body;
  const db = getDB();

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

    // 3. Verify Code
    if (otpRecord.otp !== otp) {
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

async function login(req: Request, res: Response) {
  const { phone, pin } = req.body;

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

  const token = signAccessToken(phone, user._id.toString());
  const refreshToken = signRefreshToken(phone, user._id.toString());

  return res.json({
    success: true,
    token, // Keeping 'token' for backward compatibility
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
      const response = await axios.get(verifyUrl, { timeout: VC_TIMEOUT });
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
  const { refreshToken } = req.body;

  try {
    // 1. Verify the refresh token
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded || decoded?.type !== "refresh") {
      return res.status(401).json({
        data: null,
        error: {
          code: 401,
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
