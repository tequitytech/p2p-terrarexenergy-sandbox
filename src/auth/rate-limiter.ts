/**
 * Rate Limiter Configuration
 * 
 * Uses rate-limiter-flexible for robust rate limiting.
 * Configured for OTP send attempts: 5 requests per 10 minutes per phone.
 */

import { RateLimiterMemory } from 'rate-limiter-flexible';

// OTP Send Rate Limiter: 5 attempts per 10 minutes per phone number
export const otpSendLimiter = new RateLimiterMemory({
    points: 5, // 5 requests
    duration: 10 * 60, // per 10 minutes (in seconds)
    keyPrefix: 'otp_send',
});

// OTP Verify Rate Limiter: 5 attempts per OTP session
// Note: This is handled via DB tracking for persistence across restarts
// But we add an in-memory limiter as an additional layer
export const otpVerifyLimiter = new RateLimiterMemory({
    points: 5,
    duration: 5 * 60, // 5 minutes (OTP validity period)
    keyPrefix: 'otp_verify',
});
