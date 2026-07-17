import { Router } from "express";
import bcrypt from "bcryptjs";
import { loginSchema, requestOtpSchema, verifyOtpSchema, customerRegisterSchema, customerVerifySchema } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { send as sendNotification } from "../services/notifications/notificationService";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";

export const authRouter = Router();

// Throttle the credential/OTP endpoints: 10 attempts per IP per 15 minutes. Enough for a real
// user fumbling a password or OTP, far below what a brute-force needs against an 8-char password
// or a 6-digit code.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: "auth" });

/** Get current session profile. */
authRouter.get("/me", authenticate, async (req: AuthenticatedRequest, res) => {
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

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    include: { role: true },
  });
  if (!user?.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (!user.isActive) {
    return res.status(401).json({ error: "Account is inactive" });
  }

  const token = signToken({ userId: user.id, roleKey: user.role.key, customerId: user.customerId });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role.key } });
});

/** Customer OTP register / request. */
authRouter.post("/customer/register", authLimiter, async (req, res) => {
  const parsed = customerRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { orderNumber, phone } = parsed.data;

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      customer: {
        include: {
          contacts: true,
        },
      },
    },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const contact = order.customer.contacts.find((c) => c.phone === phone);
  if (!contact) {
    return res.status(404).json({ error: "No customer contact with that phone number found for this order" });
  }
  if (!contact.isActive) {
    return res.status(401).json({ error: "Account is inactive" });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.otpCode.create({
    data: {
      userId: contact.id,
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    },
  });

  // Deliver the OTP over the customer's registered email. SMS and WhatsApp are stubbed
  // channels in Phase 1 (see project notes); enabling them later is a channels change here only.
  try {
    await sendNotification({
      recipientId: contact.id,
      templateKey: "otp_code",
      data: { code, orderNumber },
      channels: ["email"],
    });
  } catch (err) {
    console.error("Failed to send customer OTP email", err);
  }
  console.log(`[OTP GENERATED] Order ${orderNumber} - Phone ${phone} - OTP: ${code}`);

  // In development we echo the code back so the flow is testable without a live mail provider.
  // In production the code is delivered only over the notification channel, never in the response.
  const devCode = process.env.NODE_ENV === "production" ? undefined : code;
  res.json({ ok: true, message: "OTP sent to your registered email", devCode });
});

/** Customer OTP verification. */
authRouter.post("/customer/verify", authLimiter, async (req, res) => {
  const parsed = customerVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { orderNumber, phone, code } = parsed.data;

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      customer: {
        include: {
          contacts: true,
        },
      },
    },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const contact = order.customer.contacts.find((c) => c.phone === phone);
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  if (!contact.isActive) return res.status(401).json({ error: "Account is inactive" });

  const otp = await prisma.otpCode.findFirst({
    where: {
      userId: contact.id,
      code,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return res.status(401).json({ error: "Invalid or expired OTP code" });

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumedAt: new Date() },
  });

  const userWithRole = await prisma.user.findUniqueOrThrow({
    where: { id: contact.id },
    include: { role: true },
  });

  const token = signToken({
    userId: contact.id,
    roleKey: userWithRole.role.key,
    customerId: contact.customerId,
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
 * Customer login is OTP-based per the original spec, but delivered over email rather than
 * SMS: SMS is a deferred/stubbed channel in Phase 1 (see project notes), email is live.
 * Swap the delivery channel here once SMS is activated - nothing else about this flow changes.
 */
authRouter.post("/otp/request", authLimiter, async (req, res) => {
  const parsed = requestOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { phone: parsed.data.phone } });
  if (!user) return res.status(404).json({ error: "No account found for that phone number" });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.otpCode.create({
    data: { userId: user.id, code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });

  await sendNotification({
    recipientId: user.id,
    templateKey: "otp_code",
    data: { code },
    channels: ["email"],
  });

  res.json({ ok: true, message: "OTP sent to your registered email" });
});

authRouter.post("/otp/verify", authLimiter, async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { phone: parsed.data.phone }, include: { role: true } });
  if (!user) return res.status(404).json({ error: "No account found for that phone number" });

  const otp = await prisma.otpCode.findFirst({
    where: { userId: user.id, code: parsed.data.code, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return res.status(401).json({ error: "Invalid or expired code" });

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  const token = signToken({ userId: user.id, roleKey: user.role.key, customerId: user.customerId });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role.key } });
});

authRouter.post("/change-password", authenticate, async (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password are required" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user || !user.passwordHash) {
    return res.status(404).json({ error: "User not found" });
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    return res.status(400).json({ error: "Invalid current password" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      mustChangePassword: false,
    },
  });

  res.json({ ok: true });
});
