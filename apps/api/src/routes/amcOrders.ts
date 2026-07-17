import { Router } from "express";
import { createAmcOrderSchema, PERMISSION_KEY, AMC_ORDER_STATUS } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";
import { asString } from "../lib/params";

export const amcOrdersRouter = Router();

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function amcExpiryDate(poDate: Date): Date {
  const d = new Date(poDate);
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function isReminderDue(order: { poDate: Date; lastExpiryReminderAt: Date | null; expiryReminderClearedAt: Date | null }, now: Date): boolean {
  if (order.expiryReminderClearedAt) return false;
  const expiry = amcExpiryDate(order.poDate);
  const reminderStart = new Date(expiry.getTime() - ONE_MONTH_MS);
  if (now < reminderStart) return false;
  if (!order.lastExpiryReminderAt) return true;
  return now.getTime() - order.lastExpiryReminderAt.getTime() >= THREE_DAYS_MS;
}

/**
 * Cron entry point (Vercel Cron, see apps/api/vercel.json) - runs daily, not tied to a user
 * session, so it authenticates via a shared secret instead of the normal JWT middleware.
 * Registered BEFORE the router-wide `authenticate`/`requirePermission` below on purpose.
 */
amcOrdersRouter.get("/send-expiry-reminders", async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = new Date();
  const orders = await prisma.amcOrder.findMany({
    where: { expiryReminderClearedAt: null },
    include: { customer: { select: { name: true } } },
  });
  const due = orders.filter((o) => isReminderDue(o, now));

  const recipients = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { permissions: { some: { permission: { key: PERMISSION_KEY.MANAGE_AMC_ORDERS } } } },
    },
    select: { id: true },
  });

  for (const order of due) {
    const expiry = amcExpiryDate(order.poDate);
    await Promise.all(
      recipients.map((r) =>
        sendNotification({
          recipientId: r.id,
          templateKey: "amc_expiry_reminder",
          data: {
            poNo: order.poNo,
            customerName: order.customer.name,
            expiryDate: expiry.toISOString(),
          },
          channels: ["in_app", "email", "whatsapp", "telegram"],
        }),
      ),
    );
    await prisma.amcOrder.update({ where: { id: order.id }, data: { lastExpiryReminderAt: now } });
  }

  res.json({ ok: true, remindersSent: due.length, recipients: recipients.length });
});

amcOrdersRouter.use(authenticate);
amcOrdersRouter.use(requirePermission(PERMISSION_KEY.MANAGE_AMC_ORDERS));

amcOrdersRouter.get("/", async (_req, res) => {
  const orders = await prisma.amcOrder.findMany({
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  const counts = {
    total: orders.length,
    completed: orders.filter((o) => o.status === AMC_ORDER_STATUS.COMPLETED).length,
    inProgress: orders.filter((o) => o.status === AMC_ORDER_STATUS.IN_PROGRESS).length,
    yetToStart: orders.filter((o) => o.status === AMC_ORDER_STATUS.YET_TO_START).length,
  };

  res.json({ orders, counts });
});

amcOrdersRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = createAmcOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.amcOrder.create({
    data: {
      poNo: parsed.data.poNo,
      poDate: new Date(parsed.data.poDate),
      customerId: parsed.data.customerId,
      location: parsed.data.location,
      item: parsed.data.item,
      qty: parsed.data.qty,
      amcFrequencyPerYear: parsed.data.amcFrequencyPerYear,
      status: AMC_ORDER_STATUS.YET_TO_START,
      createdById: req.auth!.userId,
    },
    include: { customer: { select: { id: true, name: true } } },
  });

  res.status(201).json(order);
});

/** "AMC Acquired" - stops further expiry reminders for this order. */
amcOrdersRouter.patch("/:id/clear-reminder", async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.amcOrder.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "AMC order not found" });

  const order = await prisma.amcOrder.update({
    where: { id },
    data: { expiryReminderClearedAt: new Date(), expiryReminderClearedById: req.auth!.userId },
    include: { customer: { select: { id: true, name: true } } },
  });

  res.json(order);
});
