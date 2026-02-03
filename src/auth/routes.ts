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

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'p2p-trading-pilot-secret';

// VC Verification API
// const VC_API_BASE = 'http://35.244.45.209/credential/credentials';
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

// --- JWT Utilities ---

interface JWTPayload {
  phone: string;
  userId?: string;
  iat: number;
}

function signToken(phone: string, userId?: string): string {
  return jwt.sign({ phone, userId }, JWT_SECRET, { algorithm: 'HS256' });
}

function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
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

  const token = signToken(phone, user._id.toString());

  return res.json({
    success: true,
    token,
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
      const profile = {
        did,
        ...vc.credentialSubject,
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

  // POST /api/auth/verify-vc (requires JWT)
  router.post('/auth/verify-vc', authMiddleware, validateBody(verifyVcSchema), verifyVc);

  // GET /api/auth/me (requires JWT)
  router.get('/auth/me', authMiddleware, getMe);

  return router;
}

// Export utilities for testing
export { signToken, verifyToken, authMiddleware, validateBody, loginSchema, verifyVcSchema };
