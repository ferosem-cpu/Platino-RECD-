import { Router } from "express";
import bcrypt from "bcryptjs";
import {
  loginSchema,
  requestOtpSchema,
  verifyOtpSchema,
  customerRegisterSchema,
  customerVerifySchema,
  googleLoginSchema,
  mobileStorageVariants,
  storedMobileMatches,
  LOGIN_OTP_POLICY,
  LOGIN_OTP_PURPOSE,
  ROLE_KEY,
  passwordChangeSchema,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { verifyGoogleIdToken } from "../lib/googleAuth";
import { authenticateAllowingPasswordChange, AuthenticatedRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import {
  OTP_BAD_CODE_MESSAGE,
  OTP_DELIVERY_FAILED_MESSAGE,
  OTP_DEV_ECHO_MESSAGE,
  OTP_LIMIT_MESSAGE,
  OTP_REQUEST_ACCEPTED_MESSAGE,
  OTP_UNAVAILABLE_MESSAGE,
  consumeLoginOtp,
  otpCooldownMessage,
  requestLoginOtp,
  type LoginOtpRequestOutcome,
} from "../lib/loginOtp";
import { getOtpDelivery } from "../lib/otpDelivery";
import { isPhoneOtpLoginAllowed } from "@recd/shared";

export const authRouter = Router();

// Throttle the credential/OTP endpoints: 10 attempts per IP per 15 minutes. Enough for a real
// user fumbling a password or OTP, far below what a brute-force needs against an 8-char password
// or a 6-digit code.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: "auth" });

/** Get current session profile. */
authRouter.get("/me", authenticateAllowingPasswordChange, async (req: AuthenticatedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    include: {
      role: {
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      },
    },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.isActive) return res.status(401).json({ error: "Account is inactive" });

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    vendorId: user.vendorId,
    role: {
      key: user.role.key,
      name: user.role.name,
    },
    permissions: user.role.permissions.map((rp) => rp.permission.key),
  });
});

/** Email/password login for internal roles (everyone except customer). */
authRouter.post("/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // The schema normalised the address (trimmed, lower case); stored addresses keep whatever case they were saved with, so match insensitively.
  const user = await prisma.user.findFirst({
    where: { email: { equals: parsed.data.email, mode: "insensitive" } },
    include: { role: true },
  });
  if (!user?.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (!user.isActive) {
    return res.status(401).json({ error: "Account is inactive" });
  }

  const token = signToken({ userId: user.id, roleKey: user.role.key, customerId: user.customerId, tokenVersion: user.tokenVersion });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role.key } });
});

/**
 * "Sign in with Google" for STAFF - an additional login method alongside email/password, not
 * a replacement, and deliberately not available to customers. Only Google accounts whose
 * email already matches an existing, active staff user can sign in this way; there is no
 * separate allowlist to maintain - the User.email column IS the allowlist, same as it already
 * gates password login.
 *
 * Customers are rejected here on purpose: their login is RECD Serial Number + phone + emailed
 * OTP (see /customer/register and /customer/verify below) and that must stay the only way in
 * for them. Do not relax this check into a general-purpose email login.
 */
authRouter.post("/google", authLimiter, async (req, res) => {
  const parsed = googleLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let googleEmail: string;
  try {
    const verified = await verifyGoogleIdToken(parsed.data.credential);
    if (!verified.emailVerified) return res.status(401).json({ error: "Google account email is not verified" });
    googleEmail = verified.email;
  } catch (err) {
    console.error("Google ID token verification failed", err);
    return res.status(401).json({ error: "Google sign-in failed" });
  }

  const user = await prisma.user.findFirst({ where: { email: { equals: googleEmail.trim(), mode: "insensitive" } }, include: { role: true } });
  if (!user) return res.status(401).json({ error: "No staff account is linked to this Google account" });
  if (!user.isActive) return res.status(401).json({ error: "Account is inactive" });
  if (user.role.key === ROLE_KEY.CUSTOMER || user.customerId) {
    return res.status(401).json({ error: "Customers sign in with their RECD Serial Number and phone number" });
  }

  const token = signToken({ userId: user.id, roleKey: user.role.key, customerId: user.customerId, tokenVersion: user.tokenVersion });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role.key } });
});

/** What every OTP request answers with, so the apps can show the expiry and run the resend countdown. */
const otpTiming = {
  expiresInSeconds: LOGIN_OTP_POLICY.EXPIRY_SECONDS,
  resendAfterSeconds: LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS,
};

/** Maps the outcome of requestLoginOtp to the HTTP answer. A failure is NEVER reported as "sent". */
function respondToOtpRequest(res: import("express").Response, outcome: LoginOtpRequestOutcome) {
  if (outcome.kind === "throttled") {
    res.setHeader("Retry-After", String(outcome.retryAfterSeconds));
    return res.status(429).json({
      error: outcome.reason === "cooldown" ? otpCooldownMessage(outcome.retryAfterSeconds) : OTP_LIMIT_MESSAGE,
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  if (outcome.kind === "delivery_failed") {
    return res.status(503).json({ error: OTP_DELIVERY_FAILED_MESSAGE, code: "OTP_DELIVERY_FAILED" });
  }
  return res.json({
    ok: true,
    message: outcome.devCode ? OTP_DEV_ECHO_MESSAGE : OTP_REQUEST_ACCEPTED_MESSAGE,
    ...otpTiming,
    ...(outcome.devCode ? { devCode: outcome.devCode } : {}),
  });
}

/** Answered for unknown / inactive / non-matching accounts: same body as a real request, nothing created or sent. */
const genericOtpAccepted = () => ({ ok: true, message: OTP_REQUEST_ACCEPTED_MESSAGE, ...otpTiming });

const otpUnavailable = (res: import("express").Response) =>
  res.status(503).json({ error: OTP_UNAVAILABLE_MESSAGE, code: "OTP_UNAVAILABLE" });

/**
 * The customer-login identifier is labelled "RECD Serial Number" (HANDOVER section 20). An order has always been found by its order number
 * (legacy orders: the first unit's serial IS the order number); since per-unit serials (phase 1) the serial printed on a RECD is a different
 * value, so the serial of any unit of the order is accepted too. Unknown identifiers behave exactly like before (no order -> the generic reply).
 */
async function findOrderForCustomerLogin(identifier: string) {
  const include = { customer: { include: { contacts: true } } } as const;
  const byNumber = await prisma.order.findUnique({ where: { orderNumber: identifier }, include });
  if (byNumber) return byNumber;
  const unit = await prisma.recdUnit.findUnique({ where: { serialNo: identifier.trim().toUpperCase() }, select: { orderId: true } });
  return unit ? prisma.order.findUnique({ where: { id: unit.orderId }, include }) : null;
}

/**
 * Customer OTP request (order number + mobile number).
 *
 * The caller learns nothing about which orders/numbers exist: an unknown order, a number that is not a
 * contact of that order's customer and an inactive contact all get the same reply as a real request,
 * and no code is created. A code is only created - and only sent by WhatsApp to the contact's own REGISTERED
 * mobile number as stored on the contact record, never to anything the caller supplies - when the order and
 * number match an ACTIVE contact. If the message could not be sent the caller is told so (the code is voided),
 * never "sent". Requesting again replaces the previous code (30 s cooldown, 5 requests per hour).
 */
authRouter.post("/customer/register", authLimiter, async (req, res) => {
  const parsed = customerRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { orderNumber, phone } = parsed.data;

  // No delivery provider configured: say so for everyone (so a missing configuration cannot reveal accounts).
  if (!getOtpDelivery()) return otpUnavailable(res);

  const order = await findOrderForCustomerLogin(orderNumber);
  // `phone` is already normalised to 10 digits; the stored value may still be in an older format.
  const contact = order?.customer.contacts.find((c) => storedMobileMatches(c.phone, phone));
  if (!order || !contact || !contact.isActive) return res.json(genericOtpAccepted());

  const outcome = await requestLoginOtp({ userId: contact.id, purpose: LOGIN_OTP_PURPOSE.CUSTOMER_LOGIN, registeredPhone: contact.phone });
  return respondToOtpRequest(res, outcome);
});

/** Customer OTP verification. Every failure is the same 401, whatever the reason. */
authRouter.post("/customer/verify", authLimiter, async (req, res) => {
  const parsed = customerVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { orderNumber, phone, code } = parsed.data;

  const order = await findOrderForCustomerLogin(orderNumber);
  const contact = order?.customer.contacts.find((c) => storedMobileMatches(c.phone, phone));
  if (
    !order ||
    !contact ||
    !contact.isActive ||
    !(await consumeLoginOtp({ userId: contact.id, purpose: LOGIN_OTP_PURPOSE.CUSTOMER_LOGIN, destination: phone, code }))
  ) {
    return res.status(401).json({ error: OTP_BAD_CODE_MESSAGE });
  }

  const userWithRole = await prisma.user.findUniqueOrThrow({
    where: { id: contact.id },
    include: { role: true },
  });

  const token = signToken({
    userId: contact.id,
    roleKey: userWithRole.role.key,
    customerId: contact.customerId,
    tokenVersion: userWithRole.tokenVersion,
  });

  res.json({
    token,
    user: {
      id: contact.id,
      name: contact.name,
      role: userWithRole.role.key,
      customerId: contact.customerId,
      orderNumber: order.orderNumber,
    },
  });
});

/**
 * Phone-only OTP login (used by the mobile app). Same rules as the customer flow: the code goes only to the
 * account's own REGISTERED mobile number (WhatsApp), deactivated accounts get no code and no session, an
 * unknown number gets the same answer as a real request, and a failed delivery is reported as a failure.
 */
authRouter.post("/otp/request", authLimiter, async (req, res) => {
  const parsed = requestOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (!getOtpDelivery()) return otpUnavailable(res);

  const user = await prisma.user.findFirst({
    where: { phone: { in: mobileStorageVariants(parsed.data.phone) } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  // Unknown, deactivated and not-eligible accounts (administrative roles - see isPhoneOtpLoginAllowed) all get the same answer and no code.
  if (!user || !user.isActive || !isPhoneOtpLoginAllowed(user)) return res.json(genericOtpAccepted());

  const outcome = await requestLoginOtp({ userId: user.id, purpose: LOGIN_OTP_PURPOSE.PHONE_LOGIN, registeredPhone: user.phone });
  return respondToOtpRequest(res, outcome);
});

authRouter.post("/otp/verify", authLimiter, async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findFirst({
    where: { phone: { in: mobileStorageVariants(parsed.data.phone) } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  // Unknown number, deactivated account and wrong/expired/used code are indistinguishable. The account
  // status is checked BEFORE the code is consumed and again implicitly before a token is signed.
  if (
    !user ||
    !user.isActive ||
    !isPhoneOtpLoginAllowed(user) ||
    !(await consumeLoginOtp({ userId: user.id, purpose: LOGIN_OTP_PURPOSE.PHONE_LOGIN, destination: parsed.data.phone, code: parsed.data.code }))
  ) {
    return res.status(401).json({ error: OTP_BAD_CODE_MESSAGE });
  }

  const token = signToken({ userId: user.id, roleKey: user.role.key, customerId: user.customerId, tokenVersion: user.tokenVersion });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role.key } });
});

/**
 * Own password change. The new password must meet the same minimum as sign-in (the login form requires 8 characters). The change revokes every
 * existing session of the account (tokenVersion + 1) and answers with a FRESH token for this one, so the person stays signed in here while
 * any other device / stolen token stops working. The audit trail is for administrative actions, so a self-service change is not written to it.
 */
authRouter.post("/change-password", authenticateAllowingPasswordChange, async (req: AuthenticatedRequest, res) => {
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, include: { role: true } });
  if (!user || !user.passwordHash) {
    return res.status(404).json({ error: "User not found" });
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    return res.status(400).json({ error: "Invalid current password" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } },
  });

  const token = signToken({ userId: updated.id, roleKey: user.role.key, customerId: updated.customerId, tokenVersion: updated.tokenVersion });
  res.json({ ok: true, token });
});
