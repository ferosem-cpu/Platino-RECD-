import { Router, type Response } from "express";
import { createVendorAmcSchema, updateVendorAmcSchema, renewAmcSchema, planNewPeriod, PERMISSION_KEY, AMC_PARTY, VENDOR_STATUS } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";
import { AmcError, describeContract, listHistory, loadAmcPolicy, renewContract, updateContract } from "../lib/amcContracts";

/**
 * Vendor AMC contracts (Requirement 7): agreements with one of our existing Vendors, separate from customer AMC orders.
 * Staff holding manage_amc_orders get everything; a vendor login may only READ its own vendor's contracts and history.
 */
export const vendorAmcsRouter = Router();
vendorAmcsRouter.use(authenticate);

const include = { vendor: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } }, site: { select: { id: true, companyName: true } }, _count: { select: { renewals: true } },
  renewals: { where: { kind: "renewal" }, orderBy: { createdAt: "desc" }, take: 1, select: { previousEndDate: true } },
} as const;

function sendAmcError(res: Response, err: unknown) {
  if (err instanceof AmcError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
}

/**
 * The optional customer / site a vendor contract applies to. Returns a message when the combination is not valid: a site needs a
 * customer, both must exist, and the site must belong to that customer (a site is reached through its order).
 */
async function linkError(customerId: string | null | undefined, siteId: string | null | undefined): Promise<string | null> {
  if (siteId && !customerId) return "Choose the customer the site belongs to";
  if (customerId && !(await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) return "Customer not found";
  if (siteId) {
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, order: { select: { customerId: true } } } });
    if (!site) return "Site not found";
    if (site.order.customerId !== customerId) return "That site does not belong to the selected customer";
  }
  return null;
}

/** Staff: everything. Vendor login: reads only (scoped in the handler). Anyone else (customers, engineers without the permission): 403. */
const canManage = (req: AuthenticatedRequest) => req.auth!.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS);
function requireManage(req: AuthenticatedRequest, res: Response): boolean {
  if (canManage(req)) return true;
  res.status(403).json({ error: "Forbidden" });
  return false;
}
/** The scope a caller may read: all (staff), their own vendor, or nothing (null). */
function readScope(req: AuthenticatedRequest): { vendorId?: string } | null {
  if (canManage(req)) return {};
  if (req.auth!.vendorId) return { vendorId: req.auth!.vendorId };
  return null;
}

vendorAmcsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const scope = readScope(req);
  if (!scope) return res.status(403).json({ error: "Forbidden" });
  const [rows, policy] = await Promise.all([prisma.vendorAmc.findMany({ where: scope, include, orderBy: { endDate: "asc" } }), loadAmcPolicy()]);
  const contracts = rows.map((r) => ({ ...r, ...describeContract(r, policy) }));
  const contractCounts = {
    upcoming: contracts.filter((c) => c.contractStatus === "upcoming").length,
    renewed: contracts.filter((c) => c.contractStatus === "renewed").length,
    active: contracts.filter((c) => c.contractStatus === "active").length,
    expiringSoon: contracts.filter((c) => c.contractStatus === "expiring_soon").length,
    expired: contracts.filter((c) => c.contractStatus === "expired").length,
  };
  res.json({ contracts, contractCounts, policy: { reminderLeadDays: policy.reminderLeadDays, durationMonths: policy.durationMonths }, canManage: canManage(req) });
});

vendorAmcsRouter.post("/", async (req: AuthenticatedRequest, res) => {
  if (!requireManage(req, res)) return;
  const parsed = createVendorAmcSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const vendor = await prisma.vendor.findUnique({ where: { id: parsed.data.vendorId }, select: { id: true, status: true } });
  if (!vendor) return res.status(400).json({ error: "Vendor not found" });
  if (vendor.status !== VENDOR_STATUS.APPROVED) return res.status(400).json({ error: "Only an approved vendor can have an AMC contract" });

  const linkProblem = await linkError(parsed.data.customerId, parsed.data.siteId);
  if (linkProblem) return res.status(400).json({ error: linkProblem });

  const policy = await loadAmcPolicy();
  const period = planNewPeriod(
    { startDate: parsed.data.startDate, endDate: parsed.data.endDate, durationMonths: parsed.data.durationMonths },
    new Date(parsed.data.startDate),
    policy.durationMonths,
  );
  if (!period.ok) return res.status(400).json({ error: period.error });

  const row = await prisma.vendorAmc.create({
    data: {
      vendorId: vendor.id,
      contractRef: parsed.data.contractRef || null,
      title: parsed.data.title,
      notes: parsed.data.notes || null,
      customerId: parsed.data.customerId ?? null,
      siteId: parsed.data.siteId ?? null,
      startDate: period.newStart,
      endDate: period.newEnd,
      createdById: req.auth!.userId,
    },
    include,
  });
  res.status(201).json({ ...row, ...describeContract(row, policy) });
});

vendorAmcsRouter.get("/:id", async (req: AuthenticatedRequest, res) => {
  const scope = readScope(req);
  if (!scope) return res.status(403).json({ error: "Forbidden" });
  const row = await prisma.vendorAmc.findFirst({ where: { id: asString(req.params.id), ...scope }, include });
  if (!row) return res.status(404).json({ error: "AMC contract not found" }); // also what another vendor's id answers: no existence leak
  res.json({ ...row, ...describeContract(row, await loadAmcPolicy()) });
});

vendorAmcsRouter.patch("/:id", async (req: AuthenticatedRequest, res) => {
  if (!requireManage(req, res)) return;
  const parsed = updateVendorAmcSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { startDate, endDate, reason, ...plain } = parsed.data;
  const fields = Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined));
  if (plain.customerId !== undefined || plain.siteId !== undefined) {
    const existing = await prisma.vendorAmc.findUnique({ where: { id: asString(req.params.id) }, select: { customerId: true, siteId: true } });
    if (!existing) return res.status(404).json({ error: "AMC contract not found" });
    const customerId = plain.customerId !== undefined ? plain.customerId : existing.customerId;
    // changing the customer drops the old site (it belonged to the old customer) unless a new one is sent
    const siteId = plain.siteId !== undefined ? plain.siteId : plain.customerId !== undefined && plain.customerId !== existing.customerId ? null : existing.siteId;
    const linkProblem = await linkError(customerId, siteId);
    if (linkProblem) return res.status(400).json({ error: linkProblem });
    fields.customerId = customerId;
    fields.siteId = siteId;
  }
  try {
    await updateContract(AMC_PARTY.VENDOR, asString(req.params.id), fields, { startDate, endDate, reason }, req.auth!.userId);
  } catch (err) {
    return sendAmcError(res, err);
  }
  const row = await prisma.vendorAmc.findUnique({ where: { id: asString(req.params.id) }, include });
  res.json({ ...row!, ...describeContract(row!, await loadAmcPolicy()) });
});

vendorAmcsRouter.post("/:id/renew", async (req: AuthenticatedRequest, res) => {
  if (!requireManage(req, res)) return;
  const parsed = renewAmcSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.status(201).json(await renewContract(AMC_PARTY.VENDOR, asString(req.params.id), parsed.data, req.auth!.userId));
  } catch (err) {
    return sendAmcError(res, err);
  }
});

vendorAmcsRouter.get("/:id/renewals", async (req: AuthenticatedRequest, res) => {
  const scope = readScope(req);
  if (!scope) return res.status(403).json({ error: "Forbidden" });
  const id = asString(req.params.id);
  const exists = await prisma.vendorAmc.findFirst({ where: { id, ...scope }, select: { id: true } });
  if (!exists) return res.status(404).json({ error: "AMC contract not found" });
  res.json(await listHistory(AMC_PARTY.VENDOR, id));
});

/** "AMC Acquired" - stops further expiry reminders for this contract. */
vendorAmcsRouter.patch("/:id/clear-reminder", async (req: AuthenticatedRequest, res) => {
  if (!requireManage(req, res)) return;
  const id = asString(req.params.id);
  const existing = await prisma.vendorAmc.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: "AMC contract not found" });
  const row = await prisma.vendorAmc.update({ where: { id }, data: { expiryReminderClearedAt: new Date(), expiryReminderClearedById: req.auth!.userId }, include });
  res.json({ ...row, ...describeContract(row, await loadAmcPolicy()) });
});
