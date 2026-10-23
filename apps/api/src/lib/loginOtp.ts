/**
 * One-time codes for the customer login (order number + mobile) and the phone-only login used by the
 * mobile app. (The public complaint OTP has its own implementation in lib/publicOtp.ts.)
 *
 *  - Codes are delivered by WhatsApp to the account's REGISTERED mobile number, read from the stored user /
 *    contact record - never from the request. There is no email fallback.
 *  - Codes come from crypto.randomInt, never Math.random().
 *  - The database never holds a code: `OtpCode.code` stores an HMAC of (row id, user id, code) keyed with a
 *    server secret. The row also records the purpose and the destination number; verification must match both.
 *  - A code is single use (claimed atomically) and expires after LOGIN_OTP_POLICY.EXPIRY_SECONDS.
 *  - Issuing a code voids every earlier unused code of the same user and purpose. A partial unique index makes
 *    "at most one live code per user and purpose" a database guarantee, so simultaneous requests cannot leave two.
 *  - Request limits (30 s cooldown, 5 per hour) and guess limits (5 per code, 10 per hour across codes) are
 *    counted in the database, so they hold across server instances and cannot be reset by requesting a new code.
 *  - Nothing in here logs a code, a phone number or an email address.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { LOGIN_OTP_POLICY, normalizeIndianMobile, type LoginOtpPurpose } from "@recd/shared";
import { prisma } from "./prisma";
import { devEchoAllowed, getOtpDelivery } from "./otpDelivery";
import { otpHmacSecret } from "./otpSecret";
import { lockKeys } from "./advisoryLock";

export const LOGIN_OTP = {
  /** 6 digits, never a leading zero (format the flows always had). */
  MIN: 100_000,
  MAX_EXCLUSIVE: 1_000_000,
  TTL_MS: LOGIN_OTP_POLICY.EXPIRY_SECONDS * 1000,
} as const;

const HOUR_MS = 60 * 60 * 1000;

const secret = otpHmacSecret; // OTP_HMAC_SECRET when set, otherwise JWT_SECRET (lib/otpSecret.ts)

/** A uniformly random 6-digit code (100000-999999) from the operating system's CSPRNG. */
export function generateLoginOtpCode(): string {
  return String(randomInt(LOGIN_OTP.MIN, LOGIN_OTP.MAX_EXCLUSIVE));
}

/** What is stored instead of the code. The "login-otp" prefix keeps it separate from every other HMAC in the app. */
export function hashLoginOtp(otpId: string, userId: string, code: string): string {
  return createHmac("sha256", secret()).update(`login-otp:${otpId}:${userId}:${code}`).digest("hex");
}

export function verifyLoginOtpHash(otpId: string, userId: string, code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashLoginOtp(otpId, userId, code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- issue ----------------------------------------------------------------------------------

export type IssueResult =
  | { ok: true; id: string; code: string }
  | { ok: false; reason: "cooldown" | "limit"; retryAfterSeconds: number };

/**
 * Creates a fresh code for (user, purpose) and returns it ONCE, for delivery. Only its hash is stored.
 * Blocked (nothing created, nothing voided) during the resend cooldown and once the hourly request cap is hit.
 * On success every earlier unused code of this user and purpose is voided first.
 */
export async function issueLoginOtp(args: { userId: string; purpose: LoginOtpPurpose; destination: string }): Promise<IssueResult> {
  const { userId, purpose, destination } = args;
  // Check, void and insert are ONE decision: without the lock, parallel requests all pass the cooldown / hourly checks
  // (nothing is committed yet when they read), and each then voids the previous request's code and issues its own.
  return prisma.$transaction(
    async (tx): Promise<IssueResult> => {
      await lockKeys(tx, [`login-otp:${userId}:${purpose}`]);
      const now = Date.now();
      const hourAgo = new Date(now - HOUR_MS);
      const cooldownMs = LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS * 1000;

      const [requestsLastHour, lastDelivered] = await Promise.all([
        tx.otpCode.count({ where: { userId, purpose, createdAt: { gte: hourAgo } } }),
        // A request whose delivery failed does not hold the user back from trying again.
        tx.otpCode.findFirst({
          where: { userId, purpose, deliveryStatus: { not: "failed" } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);

      if (lastDelivered && now - lastDelivered.createdAt.getTime() < cooldownMs) {
        return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil((cooldownMs - (now - lastDelivered.createdAt.getTime())) / 1000) };
      }
      if (requestsLastHour >= LOGIN_OTP_POLICY.MAX_REQUESTS_PER_HOUR) {
        const oldest = await tx.otpCode.findFirst({
          where: { userId, purpose, createdAt: { gte: hourAgo } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        });
        const wait = oldest ? Math.ceil((oldest.createdAt.getTime() + HOUR_MS - now) / 1000) : 3600;
        return { ok: false, reason: "limit", retryAfterSeconds: Math.max(1, wait) };
      }

      await tx.otpCode.updateMany({ where: { userId, purpose, consumedAt: null }, data: { consumedAt: new Date(now) } });

      const id = randomUUID();
      const code = generateLoginOtpCode();
      try {
        await tx.otpCode.create({
          data: {
            id,
            userId,
            purpose,
            destination,
            code: hashLoginOtp(id, userId, code),
            expiresAt: new Date(now + LOGIN_OTP.TTL_MS),
          },
        });
      } catch (err) {
        // Defence in depth behind the lock: the partial unique index (one live code per user and purpose) still refuses a second one.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return { ok: false, reason: "cooldown", retryAfterSeconds: LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS };
        }
        throw err;
      }
      return { ok: true, id, code };
    },
    { timeout: 15_000 },
  );
}

/** Voids a code that could not be delivered, so an undelivered code can never be used. */
export async function voidLoginOtp(otpId: string): Promise<void> {
  await prisma.otpCode.updateMany({ where: { id: otpId, consumedAt: null }, data: { consumedAt: new Date(), deliveryStatus: "failed" } });
}

export async function markLoginOtpSent(otpId: string): Promise<void> {
  await prisma.otpCode.updateMany({ where: { id: otpId }, data: { deliveryStatus: "sent" } });
}

// ---- consume --------------------------------------------------------------------------------

/**
 * True only for a correct, unexpired, unused code that belongs to THIS user, was issued for THIS purpose and
 * was delivered to THIS number; the code is consumed in the same step (an atomic claim, so two parallel requests
 * cannot both succeed). Every guess is counted in the database BEFORE it is compared
 * (and given back if it turns out to be right, so only wrong guesses use up the budget).
 */
export async function consumeLoginOtp(args: { userId: string; purpose: LoginOtpPurpose; destination: string; code: string }): Promise<boolean> {
  const { userId, purpose, destination, code } = args;
  const now = new Date();

  // Guesses across ALL of the user's codes in the last hour: requesting a new code does not reset this.
  const recent = await prisma.otpCode.aggregate({
    _sum: { attempts: true },
    where: { userId, purpose, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
  });
  if ((recent._sum.attempts ?? 0) >= LOGIN_OTP_POLICY.MAX_FAILED_PER_HOUR) return false;

  const row = await prisma.otpCode.findFirst({
    // "failed" rows are voided when delivery fails; excluding them here as well keeps an undelivered code unusable even if that void was lost.
    where: { userId, purpose, destination, consumedAt: null, deliveryStatus: { not: "failed" }, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;

  // Count the guess atomically and only while the code is under its cap, so parallel guesses cannot exceed it.
  const counted = await prisma.otpCode.updateMany({
    where: { id: row.id, consumedAt: null, attempts: { lt: LOGIN_OTP_POLICY.MAX_ATTEMPTS_PER_CODE } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) return false;

  if (!verifyLoginOtpHash(row.id, userId, code, row.code)) return false;

  // The guess was right, so it must not eat into the budget for WRONG guesses (a double-click or a retry after a
  // dropped connection presents the right code more than once).
  await prisma.otpCode.updateMany({ where: { id: row.id, attempts: { gt: 0 } }, data: { attempts: { decrement: 1 } } });

  const claimed = await prisma.otpCode.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  return claimed.count === 1;
}

// ---- delivery -------------------------------------------------------------------------------

export type DeliveryOutcome = { delivered: boolean; provider: "whatsapp" | "dev" | null };

/**
 * Sends the code to the REGISTERED mobile number by WhatsApp. `registeredPhone` must come from the stored
 * user/contact record. Returns delivered=true only when the provider accepted the message (or, in explicitly
 * enabled local development, when the code will be echoed instead). Never throws, never logs the code or number.
 */
export async function deliverLoginOtp(registeredPhone: string | null | undefined, code: string): Promise<DeliveryOutcome> {
  const phone10 = registeredPhone ? normalizeIndianMobile(registeredPhone) : null;
  if (!phone10) return { delivered: false, provider: null };
  const provider = getOtpDelivery();
  if (!provider) return { delivered: false, provider: null };
  try {
    const result = await provider.send(phone10, code);
    if (!result.ok) console.error("[login-otp] delivery failed", { provider: provider.name, reason: result.error ?? "unknown" });
    return { delivered: result.ok, provider: provider.name };
  } catch (err) {
    console.error("[login-otp] delivery failed", { provider: provider.name, reason: err instanceof Error ? err.name : "unknown" });
    return { delivered: false, provider: provider.name };
  }
}

/** Retention: a code row (hash + destination number) is useless after its life and the one-hour limit windows; drop old ones now and then. */
const LOGIN_OTP_RETENTION_MS = 24 * 60 * 60 * 1000;
function purgeOldLoginOtps(): void {
  if (randomInt(0, 50) !== 0) return; // about one request in fifty
  try {
    prisma.otpCode.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - LOGIN_OTP_RETENTION_MS) } } }).catch(() => undefined);
  } catch {
    /* best effort */
  }
}

export type LoginOtpRequestOutcome =
  | { kind: "sent"; devCode?: string }
  | { kind: "throttled"; reason: "cooldown" | "limit"; retryAfterSeconds: number }
  | { kind: "delivery_failed" };

/**
 * The whole "send a code" step for an existing, active account: throttle, issue (voiding older codes), deliver
 * to the registered number, and void the new code again if delivery failed. The destination is the number
 * stored on the account, normalised with the shared helper.
 */
export async function requestLoginOtp(args: { userId: string; purpose: LoginOtpPurpose; registeredPhone: string | null | undefined }): Promise<LoginOtpRequestOutcome> {
  const destination = args.registeredPhone ? normalizeIndianMobile(args.registeredPhone) : null;
  if (!destination) {
    console.error("[login-otp] account has no valid registered mobile number", { userId: args.userId });
    return { kind: "delivery_failed" };
  }
  const issued = await issueLoginOtp({ userId: args.userId, purpose: args.purpose, destination });
  if (!issued.ok) return { kind: "throttled", reason: issued.reason, retryAfterSeconds: issued.retryAfterSeconds };

  purgeOldLoginOtps();
  const { delivered, provider } = await deliverLoginOtp(destination, issued.code);
  if (!delivered) {
    await voidLoginOtp(issued.id);
    return { kind: "delivery_failed" };
  }
  await markLoginOtpSent(issued.id);
  // Only when nothing was actually sent (explicit local-development switch) is the code returned to the caller.
  return { kind: "sent", ...(provider === "dev" && devEchoAllowed() ? { devCode: issued.code } : {}) };
}

// ---- messages (one wording for every outcome that must not reveal whether an account exists) ----

export const OTP_REQUEST_ACCEPTED_MESSAGE =
  "If those details match an active account, a one-time code has been sent to its registered mobile number on WhatsApp.";
export const OTP_BAD_CODE_MESSAGE = "Invalid or expired code";
export const OTP_DELIVERY_FAILED_MESSAGE =
  "We could not send the code right now. Please try again in a few minutes, or contact Platino service if this keeps happening.";
export const OTP_UNAVAILABLE_MESSAGE =
  "Sign-in by one-time code is not available right now. Please contact Platino service.";
export const OTP_DEV_ECHO_MESSAGE = "Development mode: nothing was sent to a phone. The code is shown below.";

export function otpCooldownMessage(retryAfterSeconds: number): string {
  return `Please wait ${retryAfterSeconds}s before requesting another code.`;
}
export const OTP_LIMIT_MESSAGE = "Too many code requests. Please try again later.";
