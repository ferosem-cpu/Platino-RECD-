import { Router } from "express";
import bcrypt from "bcryptjs";
import { loginSchema, requestOtpSchema, verifyOtpSchema } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { send as sendNotification } from "../services/notifications/notificationService";

export const authRouter = Router();

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

  const token = signToken({ userId: user.id, roleKey: user.role.key, customerId: user.customerId });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role.key } });
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
