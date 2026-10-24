import { Router } from "express";
import { AMC_VISIT_STATUS, PERMISSION_KEY, ROLE_KEY, createAmcVisitSchema, updateAmcVisitSchema } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asOptionalString, asString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { amcRef } from "../lib/reminders";

/**
 * Scheduled AMC visits: a RECD unit covered by an AMC order, with an EXPLICIT due date entered by an AMC manager. This is the
 * only thing that makes an AMC activity eligible for reminders - the contract expiry date is a different thing (it has its own
 * renewal reminder) and amcFrequencyPerYear does not generate visits. Same access boundary as the AMC module (MANAGE_AMC_ORDERS).
 */
export const amcVisitsRouter = Router();
amcVisitsRouter.use(authenticate);
amcVisitsRouter.use(requirePermission(PERMISSION_KEY.MANAGE_AMC_ORDERS));

const visitView = (v: { id: string; amcOrderId: string; unitId: string; dueDate: Date; status: string; completedAt: Date | null; unit?: { serialNo: string | null } }) => ({
  id: v.id, amcOrderId: v.amcOrderId, amcRef: amcRef(v.amcOrderId), unitId: v.unitId, serialNo: v.unit?.serialNo ?? null,
  dueDate: v.dueDate.toISOString().slice(0, 10), status: v.status, completedAt: v.completedAt,
});

/** A vendor / regional user (should one ever hold the AMC permission) only reaches units at their own sites. */
async function siteAllowed(req: AuthenticatedRequest, site: { vendorId: string | null; regionId: string | null } | null): Promise<boolean> {
  const a = req.auth!;
  if (a.vendorId) return !!site && site.vendorId === a.vendorId;
  if (a.roleKey === ROLE_KEY.REGIONAL_MANAGER) return !!site?.regionId && (await managedRegionIds(a.userId, a.roleKey)).includes(site.regionId);
  return true;
}

amcVisitsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const amcOrderId = asOptionalString(req.query.amcOrderId);
  if (!amcOrderId) return res.status(400).json({ error: "amcOrderId is required" });
  if (req.auth!.vendorId || req.auth!.roleKey === ROLE_KEY.REGIONAL_MANAGER) return res.status(403).json({ error: "Forbidden" });
  const visits = await prisma.amcVisit.findMany({ where: { amcOrderId }, include: { unit: { select: { serialNo: true } } }, orderBy: { dueDate: "asc" } });
  res.json(visits.map(visitView));
});

amcVisitsRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = createAmcVisitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { amcOrderId, unitId, dueDate } = parsed.data;

  const amc = await prisma.amcOrder.findUnique({ where: { id: amcOrderId }, select: { id: true, customerId: true, units: { select: { unitId: true } } } });
  if (!amc) return res.status(404).json({ error: "AMC order not found" });
  // The unit must be covered by THIS order, belong to its customer, be active and carry a serial - the customer and site are
  // never taken from the request.
  if (!amc.units.some((l) => l.unitId === unitId)) return res.status(400).json({ error: "That RECD unit is not covered by this AMC order.", code: "UNIT_NOT_IN_AMC" });
  const unit = await prisma.recdUnit.findUnique({ where: { id: unitId }, select: { id: true, serialNo: true, status: true, order: { select: { customerId: true } }, site: { select: { vendorId: true, regionId: true } } } });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (unit.order.customerId !== amc.customerId) return res.status(400).json({ error: "That RECD unit does not belong to this AMC order's customer.", code: "UNIT_CUSTOMER_MISMATCH" });
  if (unit.status !== "active") return res.status(400).json({ error: "That RECD unit is retired.", code: "UNIT_RETIRED" });
  if (!(await siteAllowed(req, unit.site))) return res.status(403).json({ error: "You cannot schedule a visit for this site" });

  const visit = await prisma.amcVisit.create({
    data: { amcOrderId, unitId, dueDate: new Date(`${dueDate}T00:00:00.000Z`), createdById: req.auth!.userId },
    include: { unit: { select: { serialNo: true } } },
  });
  res.status(201).json(visitView(visit));
});

amcVisitsRouter.patch("/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = updateAmcVisitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const visit = await prisma.amcVisit.findUnique({ where: { id }, include: { unit: { select: { serialNo: true, site: { select: { vendorId: true, regionId: true } } } } } });
  if (!visit) return res.status(404).json({ error: "AMC visit not found" });
  if (!(await siteAllowed(req, visit.unit.site))) return res.status(403).json({ error: "You cannot change this visit" });
  if (visit.status !== AMC_VISIT_STATUS.SCHEDULED) return res.status(409).json({ error: `A ${visit.status} visit cannot be changed.`, code: "VISIT_FINISHED" });

  const finishing = parsed.data.status;
  // Conditional update: a visit completed / cancelled by someone else in the meantime is not overwritten.
  const claimed = await prisma.amcVisit.updateMany({
    where: { id, status: AMC_VISIT_STATUS.SCHEDULED },
    data: {
      ...(parsed.data.dueDate ? { dueDate: new Date(`${parsed.data.dueDate}T00:00:00.000Z`) } : {}),
      ...(finishing ? { status: finishing, ...(finishing === AMC_VISIT_STATUS.COMPLETED ? { completedAt: new Date() } : {}) } : {}),
    },
  });
  if (claimed.count !== 1) return res.status(409).json({ error: "This visit was just changed by someone else.", code: "VISIT_FINISHED" });
  const fresh = await prisma.amcVisit.findUniqueOrThrow({ where: { id }, include: { unit: { select: { serialNo: true } } } });
  res.json(visitView(fresh));
});
