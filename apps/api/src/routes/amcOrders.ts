import { Router, type Response } from "express";
import { createAmcOrderSchema, updateAmcOrderSchema, renewAmcSchema, planNewPeriod, PERMISSION_KEY, AMC_ORDER_STATUS, AMC_PARTY, AMC_DATES_SOURCE } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";
import { validateAmcUnitLinks } from "../lib/unitLinks";
import { AmcError, describeContract, listHistory, loadAmcPolicy, renewContract, runAmcExpiryReminders, updateContract } from "../lib/amcContracts";

/** What the AMC list/create responses carry for each covered unit: serial + product + site. */
const amcInclude = {
  customer: { select: { id: true, name: true } },
  _count: { select: { renewals: true } },
  renewals: { where: { kind: "renewal" }, orderBy: { createdAt: "desc" }, take: 1, select: { previousEndDate: true } },
  units: {
    select: {
      unit: {
        select: {
          id: true,
          serialNo: true,
          status: true,
          product: { select: { name: true, model: true } },
          site: { select: { id: true, companyName: true, address: true, dgModel: true, dgCapacityKva: true } },
        },
      },
    },
  },
} as const;

export const amcOrdersRouter = Router();

/** Maps the contract errors (404 / 409 / 400) to their HTTP answer; anything else is a real failure and goes to the error handler. */
function sendAmcError(res: Response, err: unknown) {
  if (err instanceof AmcError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
}

/**
 * Cron entry point (Vercel Cron, see apps/api/vercel.json) - runs daily, not tied to a user
 * session, so it authenticates via a shared secret instead of the normal JWT middleware.
 * Registered BEFORE the router-wide `authenticate`/`requirePermission` below on purpose.
 * The dates, reminder window and repeat interval come from the contract's explicit dates and the AMC
 * settings (defaults: 30 days before the end date, every 3 days) - see lib/amcContracts.ts.
 */
amcOrdersRouter.get("/send-expiry-reminders", async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await runAmcExpiryReminders(new Date());
  res.json({ ok: true, remindersSent: result.remindersSent, vendorRemindersSent: result.vendorRemindersSent, recipients: result.recipients });
});

amcOrdersRouter.use(authenticate);
amcOrdersRouter.use(requirePermission(PERMISSION_KEY.MANAGE_AMC_ORDERS));

amcOrdersRouter.get("/", async (_req, res) => {
  const [orders, policy] = await Promise.all([prisma.amcOrder.findMany({ include: amcInclude, orderBy: { createdAt: "desc" } }), loadAmcPolicy()]);
  const described = orders.map((o) => ({ ...o, ...describeContract(o, policy) }));

  const counts = {
    total: orders.length,
    completed: orders.filter((o) => o.status === AMC_ORDER_STATUS.COMPLETED).length,
    inProgress: orders.filter((o) => o.status === AMC_ORDER_STATUS.IN_PROGRESS).length,
    yetToStart: orders.filter((o) => o.status === AMC_ORDER_STATUS.YET_TO_START).length,
  };
  const contractCounts = {
    upcoming: described.filter((o) => o.contractStatus === "upcoming").length,
    renewed: described.filter((o) => o.contractStatus === "renewed").length,
    active: described.filter((o) => o.contractStatus === "active").length,
    expiringSoon: described.filter((o) => o.contractStatus === "expiring_soon").length,
    expired: described.filter((o) => o.contractStatus === "expired").length,
  };

  res.json({ orders: described, counts, contractCounts, policy: { reminderLeadDays: policy.reminderLeadDays, durationMonths: policy.durationMonths } });
});

amcOrdersRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = createAmcOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // The customer must exist: without this check a bad id surfaces as a foreign-key 500.
  const customer = await prisma.customer.findUnique({ where: { id: parsed.data.customerId }, select: { id: true } });
  if (!customer) return res.status(400).json({ error: "Customer not found" });

  // Every covered unit must exist, carry a serial, be active and belong to this AMC's customer.
  const { unitIds } = parsed.data;
  if (unitIds.length) {
    const found = await prisma.recdUnit.findMany({
      where: { id: { in: unitIds } },
      select: { id: true, serialNo: true, status: true, order: { select: { customerId: true } } },
    });
    const linkError = validateAmcUnitLinks(
      unitIds,
      found.map((u) => ({ id: u.id, serialNo: u.serialNo, status: u.status, customerId: u.order.customerId })),
      parsed.data.customerId,
    );
    if (linkError) return res.status(400).json({ error: linkError });
  }

  // The contract period is explicit: typed dates, or a start (default: the PO date) plus the configured duration.
  const poDate = new Date(parsed.data.poDate);
  const policy = await loadAmcPolicy();
  const period = planNewPeriod(
    { startDate: parsed.data.startDate, endDate: parsed.data.endDate, durationMonths: parsed.data.durationMonths },
    poDate,
    policy.durationMonths,
  );
  if (!period.ok) return res.status(400).json({ error: period.error });

  const order = await prisma.amcOrder.create({
    data: {
      poNo: parsed.data.poNo,
      poDate,
      customerId: parsed.data.customerId,
      location: parsed.data.location,
      item: parsed.data.item,
      qty: parsed.data.qty,
      amcFrequencyPerYear: parsed.data.amcFrequencyPerYear,
      amcType: parsed.data.amcType,
      status: AMC_ORDER_STATUS.YET_TO_START,
      createdById: req.auth!.userId,
      startDate: period.newStart,
      endDate: period.newEnd,
      datesSource: AMC_DATES_SOURCE.EXPLICIT,
      units: { create: unitIds.map((unitId) => ({ unitId })) },
    },
    include: amcInclude,
  });

  res.status(201).json({ ...order, ...describeContract(order, policy) });
});

amcOrdersRouter.get("/:id", async (req, res) => {
  const order = await prisma.amcOrder.findUnique({ where: { id: asString(req.params.id) }, include: amcInclude });
  if (!order) return res.status(404).json({ error: "AMC order not found" });
  res.json({ ...order, ...describeContract(order, await loadAmcPolicy()) });
});

/** Edit a customer contract. Plain details change directly; changing the start / end date is a CORRECTION that needs a reason and is kept in the history. */
amcOrdersRouter.patch("/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = updateAmcOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { startDate, endDate, reason, ...plain } = parsed.data;
  const fields = Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined));
  try {
    await updateContract(AMC_PARTY.CUSTOMER, asString(req.params.id), fields, { startDate, endDate, reason }, req.auth!.userId);
  } catch (err) {
    return sendAmcError(res, err);
  }
  const order = await prisma.amcOrder.findUnique({ where: { id: asString(req.params.id) }, include: amcInclude });
  res.json({ ...order!, ...describeContract(order!, await loadAmcPolicy()) });
});

/** RENEW a contract (it continues into a new period, the old one kept in history). Not the same as creating a separate new contract. */
amcOrdersRouter.post("/:id/renew", async (req: AuthenticatedRequest, res) => {
  const parsed = renewAmcSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await renewContract(AMC_PARTY.CUSTOMER, asString(req.params.id), parsed.data, req.auth!.userId);
    res.status(201).json(result);
  } catch (err) {
    return sendAmcError(res, err);
  }
});

amcOrdersRouter.get("/:id/renewals", async (req, res) => {
  const id = asString(req.params.id);
  const exists = await prisma.amcOrder.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return res.status(404).json({ error: "AMC order not found" });
  res.json(await listHistory(AMC_PARTY.CUSTOMER, id));
});

/** "AMC Acquired" - stops further expiry reminders for this order. */
amcOrdersRouter.patch("/:id/clear-reminder", async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.amcOrder.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "AMC order not found" });

  const order = await prisma.amcOrder.update({
    where: { id },
    data: { expiryReminderClearedAt: new Date(), expiryReminderClearedById: req.auth!.userId },
    include: amcInclude,
  });

  res.json({ ...order, ...describeContract(order, await loadAmcPolicy()) });
});
