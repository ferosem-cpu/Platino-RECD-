import { Router } from "express";
import bcrypt from "bcryptjs";
import { loginSchema, requestOtpSchema, verifyOtpSchema } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { send as sendNotification } from "../services/notifications/notificationService";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";

export const authRouter = Router();

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
    role: {
      key: user.role.key,
      name: user.role.name,
    },
    permissions: user.role.permissions.map((rp) => rp.permission.key),
  });
});

/** Email/password login for internal roles (everyone except customer). */
authRouter.post("/login", async (req, res) => {
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
authRouter.post("/customer/register", async (req, res) => {
  const { orderNumber, phone } = req.body;
  if (!orderNumber || !phone) {
    return res.status(400).json({ error: "Order number and phone number are required" });
  }

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

  // Log OTP to terminal for dev verification
  console.log(`[OTP GENERATED] Order ${orderNumber} - Phone ${phone} - OTP: ${code}`);

  res.json({ ok: true, message: "OTP generated", code });
});

/** Customer OTP verification. */
authRouter.post("/customer/verify", async (req, res) => {
  const { orderNumber, phone, code } = req.body;
  if (!orderNumber || !phone || !code) {
    return res.status(400).json({ error: "Order number, phone number, and OTP code are required" });
  }

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
authRouter.post("/otp/request", async (req, res) => {
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

authRouter.post("/otp/verify", async (req, res) => {
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
