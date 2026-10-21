import { Router } from "express";
import { authenticate, type AuthenticatedRequest } from "../middleware/auth";
import { buildWarrantyAlerts, runWarrantyReminders } from "../lib/warranty";

/** Login-time warranty notice: the units the CALLER may see whose warranty is expiring soon or recently expired. Read-only; scoping lives in buildWarrantyAlerts. */
export const warrantyAlertsRouter = Router();
warrantyAlertsRouter.use(authenticate);

warrantyAlertsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const { userId, roleKey, permissions, customerId, vendorId } = req.auth!;
  res.json(await buildWarrantyAlerts({ userId, roleKey, permissions, customerId, vendorId }));
});

/**
 * Cron entry point for the warranty-expiry reminders. Authenticates with the shared CRON_SECRET (no user session), like the other cron
 * routes. Scheduled daily in vercel.json (04:30 UTC) so requirement 8 ("send reminders before expiry") runs by itself; it only sends when CRON_SECRET and
 * an e-mail provider are configured in the environment, and the 30-day / 3-day policy is an UNCONFIRMED default (Settings -> Warranty overrides it).
 */
export const warrantyCronRouter = Router();
warrantyCronRouter.get("/send-reminders", async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorized" });
  const r = await runWarrantyReminders(new Date());
  res.json({ ok: true, ...r });
});
