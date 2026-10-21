/**
 * Pure helpers for the public (login-free) complaint OTP flow - no database, no Express - so
 * the security-relevant logic (hashing, expiry, throttling decisions, WhatsApp payload) is unit
 * tested in isolation. The route in routes/publicComplaints.ts wires these to Prisma.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "crypto";
import { PUBLIC_OTP } from "@recd/shared";
import { otpHmacSecret } from "./otpSecret";

const secret = otpHmacSecret; // OTP_HMAC_SECRET when set, otherwise JWT_SECRET (lib/otpSecret.ts)

/** Cryptographically random 6-digit code (leading zeros preserved). */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** PUBLIC_OTP.CODE_LENGTH)).padStart(PUBLIC_OTP.CODE_LENGTH, "0");
}

/** The code is bound to the row id + phone so a hash cannot be replayed against another OTP. */
export function hashOtpCode(otpId: string, phone: string, code: string): string {
  return createHmac("sha256", secret()).update(`${otpId}:${phone}:${code}`).digest("hex");
}

export function verifyOtpCode(otpId: string, phone: string, code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOtpCode(otpId, phone, code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Opaque single-use token handed to the browser after a successful verification. */
export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface OtpRowState {
  expiresAt: Date;
  attempts: number;
  verifiedAt: Date | null;
}

export type OtpCheck = "ok" | "expired" | "locked" | "already_verified";

/** Can this OTP row still be attempted? */
export function checkOtpAttemptable(row: OtpRowState, now = new Date()): OtpCheck {
  if (row.verifiedAt) return "already_verified";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.attempts >= PUBLIC_OTP.MAX_VERIFY_ATTEMPTS) return "locked";
  return "ok";
}

export interface ThrottleInput {
  /** OTP requests in the last hour for this mobile / serial / ip. */
  phoneLastHour: number;
  serialLastHour: number;
  ipLastHour: number;
  /** Seconds since this mobile's most recent request, or null if none. */
  secondsSinceLastForPhone: number | null;
}

export const OTP_REQUEST_LIMITS = { PER_PHONE_HOUR: 5, PER_SERIAL_HOUR: 10, PER_IP_HOUR: 20 } as const;

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number; reason: "cooldown" | "limit" };

export function decideOtpRequest(i: ThrottleInput): ThrottleDecision {
  if (i.secondsSinceLastForPhone !== null && i.secondsSinceLastForPhone < PUBLIC_OTP.RESEND_COOLDOWN_SECONDS) {
    return { allowed: false, reason: "cooldown", retryAfterSeconds: Math.ceil(PUBLIC_OTP.RESEND_COOLDOWN_SECONDS - i.secondsSinceLastForPhone) };
  }
  if (
    i.phoneLastHour >= OTP_REQUEST_LIMITS.PER_PHONE_HOUR ||
    i.serialLastHour >= OTP_REQUEST_LIMITS.PER_SERIAL_HOUR ||
    i.ipLastHour >= OTP_REQUEST_LIMITS.PER_IP_HOUR
  ) {
    return { allowed: false, reason: "limit", retryAfterSeconds: 3600 };
  }
  return { allowed: true };
}
