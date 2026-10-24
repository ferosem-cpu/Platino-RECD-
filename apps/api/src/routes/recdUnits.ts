import { Router } from "express";
import { canCorrectSerial, correctRecdSerialSchema, setRecdSerialSchema, setWarrantySchema, PERMISSION_KEY, RECD_UNIT_STATUS, ROLE_KEY, SERVICE_REPORT_KIND, SERVICE_REPORT_STATUS } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { asString, asOptionalString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { canViewUnit } from "../lib/unitLinks";
import { takenSerialsMessage } from "../lib/serials";
import { customerTicketView } from "../lib/ticketViews";
import { isSerialConflict } from "../lib/uniqueViolations";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { WarrantyError, describeWarranty, listWarrantyHistory, loadWarrantyPolicy, setUnitWarranty } from "../lib/warranty";

export const recdUnitsRouter = Router();
recdUnitsRouter.use(authenticate);

const ALREADY_HAS_SERIAL = "This unit already has a serial number";
const STALE_SERIAL = "The serial number of this unit changed meanwhile - reload and try again.";

const unitInclude = {
  product: { select: { id: true, name: true, model: true, warrantyMonths: true } },
  order: { select: { id: true, orderNumber: true, poNumber: true, customer: { select: { id: true, name: true } } } },
  // The DG the RECD is fitted to is recorded on its site (dgModel / dgCapacityKva).
  site: {
    select: {
      id: true, companyName: true, address: true, regionId: true, vendorId: true,
      dgModel: true, dgCapacityKva: true,
      region: { select: { id: true, name: true } },
    },
  },
} as const;

/** List/search units. `search` matches serial number; `pending=1` lists units still awaiting a serial. */
recdUnitsRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const search = asOptionalString(req.query.search)?.trim();
  const pending = asOptionalString(req.query.pending) === "1";
  const orderId = asOptionalString(req.query.orderId);
  const customerId = asOptionalString(req.query.customerId);

  const where: Record<string, unknown> = {};
  if (search) where.serialNo = { contains: search, mode: "insensitive" };
  if (pending) where.serialNo = null;
  if (orderId) where.orderId = orderId;
  if (customerId) where.order = { customerId };
  if (req.auth!.customerId) where.order = { customerId: req.auth!.customerId };
  if (req.auth!.vendorId) where.site = { vendorId: req.auth!.vendorId };
  if (req.auth!.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    where.site = { regionId: { in: await managedRegionIds(req.auth!.userId, req.auth!.roleKey) } };
  }

  const units = await prisma.recdUnit.findMany({
    where,
    include: unitInclude,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
  // One settings read for the whole list; the warranty status is computed per row from the unit's own columns (no extra query per row).
  const policy = await loadWarrantyPolicy();
  res.json(units.map((u) => ({ ...u, warranty: describeWarranty(u, policy) })));
});

recdUnitsRouter.get("/:id", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const unit = await prisma.recdUnit.findUnique({ where: { id: asString(req.params.id) }, include: unitInclude });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (!(await canAccessUnit(req, unit))) return res.status(403).json({ error: "Forbidden" });
  res.json({ ...unit, warranty: describeWarranty(unit, await loadWarrantyPolicy()) });
});

/** Scoping shared by the unit detail and history routes (customer / vendor / regional manager). */
async function canAccessUnit(req: AuthenticatedRequest, unit: { order: { customer: { id: string } }; site: { vendorId: string | null; regionId: string | null } | null }) {
  const auth = req.auth!;
  return canViewUnit(
    auth,
    { customerId: unit.order.customer.id, vendorId: unit.site?.vendorId ?? null, regionId: unit.site?.regionId ?? null },
    await managedRegionIds(auth.userId, auth.roleKey),
  );
}

/**
 * Everything known about one RECD, keyed by its serial: where it is (customer / site / DG),
 * every service ticket raised against it (with the uploaded service report and the ticket's
 * event history) and every AMC order that covers it.
 */
recdUnitsRouter.get("/:id/history", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const unit = await prisma.recdUnit.findUnique({ where: { id: asString(req.params.id) }, include: unitInclude });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (!(await canAccessUnit(req, unit))) return res.status(403).json({ error: "Forbidden" });

  // Tickets and AMC are only shown to roles that can already see them elsewhere (GET /complaints,
  // GET /complaints/:id/history, /amc-orders); VIEW_SITE_STATUS alone - sales, erection
  // engineers, vendors - gets the unit but not its service data. Internal ticket events
  // (assignment, escalation, staff names) stay staff-only, so customers never receive them.
  const perms = req.auth!.permissions;
  const isCustomer = !!req.auth!.customerId;
  const canManageTickets = perms.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || perms.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  const canSeeTickets = isCustomer || canManageTickets || perms.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS) || perms.has(PERMISSION_KEY.RAISE_COMPLAINT);
  const canSeeEvents = !isCustomer && (canManageTickets || perms.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS));
  const canSeeAmc = isCustomer || perms.has(PERMISSION_KEY.MANAGE_AMC_ORDERS);
  // Field engineers only see tickets assigned to them (same rule as the complaints list).
  const ticketScope = !isCustomer && !canManageTickets ? { assignedToId: req.auth!.userId } : {};

  const [complaints, amcLinks] = await Promise.all([
    !canSeeTickets ? [] : prisma.complaint.findMany({
      where: { unitId: unit.id, archivedAt: null, ...ticketScope },
      // A customer's query never loads the staff-only columns (root cause, notes, remarks, staff report link, assignee); the rows are then
      // shaped by the same whitelist as GET /complaints (lib/ticketViews.ts). Staff keep the full working row below.
      select: isCustomer
        ? {
            id: true, ticketNumber: true, customerId: true, siteId: true, unitId: true, category: true, issueCategory: true, description: true,
            severity: true, status: true, source: true, reporterName: true, reporterType: true, createdAt: true, closedAt: true,
          }
        : {
        id: true, ticketNumber: true, category: true, issueCategory: true, description: true, severity: true,
        status: true, rootCause: true, resolutionNotes: true, remarks: true, serviceReportUrl: true,
        createdAt: true, closedAt: true, source: true,
        assignedTo: { select: { id: true, name: true } },
        ...(canSeeEvents
          ? {
              events: {
                select: { id: true, type: true, fromValue: true, toValue: true, actorLabel: true, createdAt: true, actor: { select: { id: true, name: true } } },
                orderBy: { createdAt: "asc" as const },
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    }),
    !canSeeAmc ? [] : prisma.amcOrderUnit.findMany({
      where: { unitId: unit.id },
      select: {
        amcOrder: {
          select: {
            id: true, poNo: true, poDate: true, amcType: true, amcFrequencyPerYear: true, status: true,
            expiryReminderClearedAt: true,
          },
        },
      },
    }),
  ]);

  // Ticket reports that have left draft, for the tickets this caller may already see (same scoping as the tickets above).
  const LEFT_DRAFT = [SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, SERVICE_REPORT_STATUS.SIGNED, SERVICE_REPORT_STATUS.SUBMITTED];
  const reportSelect = { id: true, reportNumber: true, kind: true, complaintId: true, amcOrderId: true, unitSerialNo: true, status: true, visitDate: true, signedAt: true, signerName: true, pdfFileId: true } as const;
  const serviceReports = !canSeeTickets || complaints.length === 0
    ? []
    : await prisma.serviceReport.findMany({
        where: { unitId: unit.id, kind: SERVICE_REPORT_KIND.TICKET, complaintId: { in: complaints.map((c) => c.id) }, status: { in: LEFT_DRAFT } },
        select: reportSelect,
        orderBy: { createdAt: "desc" },
      });
  // AMC reports for this unit: only for callers who may already see the unit's AMC orders (the AMC boundary).
  const amcReports = !canSeeAmc
    ? []
    : await prisma.serviceReport.findMany({
        where: { unitId: unit.id, kind: SERVICE_REPORT_KIND.AMC, status: { in: LEFT_DRAFT }, ...(isCustomer ? { customerId: req.auth!.customerId! } : {}) },
        select: reportSelect,
        orderBy: { createdAt: "desc" },
      });
  const shapeReport = ({ pdfFileId, ...r }: (typeof serviceReports)[number]) => ({ ...r, pdfAvailable: (r.status === SERVICE_REPORT_STATUS.SIGNED || r.status === SERVICE_REPORT_STATUS.SUBMITTED) && !!pdfFileId });

  const amcOrders = amcLinks
    .map((l) => {
      const expiresOn = new Date(l.amcOrder.poDate);
      expiresOn.setFullYear(expiresOn.getFullYear() + 1);
      return { ...l.amcOrder, expiresOn };
    })
    .sort((a, b) => b.poDate.getTime() - a.poDate.getTime());

  res.json({
    unit: { ...unit, warranty: describeWarranty(unit, await loadWarrantyPolicy()) },
    // Tell the UI when a section is hidden by permission rather than genuinely empty.
    complaintsVisible: canSeeTickets,
    amcVisible: canSeeAmc,
    complaints: complaints.map((c) => (isCustomer ? { ...customerTicketView(c), events: [] } : { ...c, events: canSeeEvents && "events" in c ? c.events : [] })),
    serviceReports: serviceReports.map(shapeReport),
    amcServiceReports: amcReports.map(shapeReport),
    amcOrders,
  });
});

/**
 * Warranty history of one unit (Requirement 8). Same access rule as the unit itself; staff also see who changed it and why, customers and
 * vendors (read-only) see the periods only.
 */
recdUnitsRouter.get("/:id/warranty-history", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const unit = await prisma.recdUnit.findUnique({ where: { id: asString(req.params.id) }, include: unitInclude });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (!(await canAccessUnit(req, unit))) return res.status(403).json({ error: "Forbidden" });
  const staffView = !req.auth!.customerId && !req.auth!.vendorId;
  res.json(await listWarrantyHistory(unit.id, staffView));
});

/**
 * Establish or correct a unit's warranty. Needs the explicit manage_warranty permission AND access to the unit; customers and vendors can
 * never write. The change and its history row are one transaction (lib/warranty.ts).
 */
recdUnitsRouter.put("/:id/warranty", requirePermission(PERMISSION_KEY.MANAGE_WARRANTY), async (req: AuthenticatedRequest, res) => {
  const parsed = setWarrantySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const unit = await prisma.recdUnit.findUnique({ where: { id }, include: unitInclude });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (!(await canAccessUnit(req, unit))) return res.status(403).json({ error: "Forbidden" });
  try {
    await setUnitWarranty(id, parsed.data, req.auth!.userId);
  } catch (err) {
    if (err instanceof WarrantyError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    throw err;
  }
  const fresh = await prisma.recdUnit.findUnique({ where: { id }, include: unitInclude });
  res.json({ ...fresh!, warranty: describeWarranty(fresh!, await loadWarrantyPolicy()) });
});

/** Sets the serial on a unit that has none yet. Serials are write-once here: correcting an
 *  already-set serial would silently orphan service history keyed to it, so it needs an
 *  explicit admin path (not part of this phase). */
recdUnitsRouter.put("/:id/serial", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const parsed = setRecdSerialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const unit = await prisma.recdUnit.findUnique({ where: { id } });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (unit.serialNo) return res.status(409).json({ error: ALREADY_HAS_SERIAL });

  const clash = await prisma.recdUnit.findUnique({ where: { serialNo: parsed.data.serialNo } });
  if (clash) return res.status(409).json({ error: takenSerialsMessage([parsed.data.serialNo]) });

  try {
    // Atomic: the write only happens while the unit STILL has no serial. Two simultaneous requests with different serials cannot both
    // succeed - the loser matches no row (the read above is only for a friendly 404 / message).
    const { count } = await prisma.recdUnit.updateMany({ where: { id, serialNo: null }, data: { serialNo: parsed.data.serialNo } });
    if (count === 0) return res.status(409).json({ error: ALREADY_HAS_SERIAL });
    res.json(await prisma.recdUnit.findUnique({ where: { id }, include: unitInclude }));
  } catch (err) {
    // Lost a race with another request registering the same serial.
    if (isSerialConflict(err)) return res.status(409).json({ error: takenSerialsMessage([parsed.data.serialNo]) });
    throw err;
  }
});

/**
 * CORRECTS a serial that was entered wrongly (a data-entry mistake - it is not a replacement of the physical unit and not a move of the
 * serial to another unit). Restricted to the administrative roles in SERIAL_CORRECTION_ROLE_KEYS (on top of `manage_orders`); a reason is
 * mandatory and every correction is recorded (previous serial, new serial, actor, time) in RecdUnitSerialHistory in the same transaction.
 * The caller names the serial it is looking at (`expectedSerialNo`); if the unit no longer carries it, nothing changes (409). Tickets,
 * reports, AMC and warranty records reference the unit, so they follow the corrected serial; AMC reports keep their own serial snapshot.
 */
recdUnitsRouter.patch("/:id/serial", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  if (!canCorrectSerial(req.auth!.roleKey)) return res.status(403).json({ error: "Only an administrator can correct a serial number." });
  const parsed = correctRecdSerialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { expectedSerialNo, serialNo, reason } = parsed.data;
  if (serialNo === expectedSerialNo) return res.status(400).json({ error: "The new serial number is the same as the current one." });

  const id = asString(req.params.id);
  const unit = await prisma.recdUnit.findUnique({ where: { id } });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (!unit.serialNo) return res.status(409).json({ error: "This unit has no serial number yet - enter it instead of correcting it." });
  if (unit.status !== RECD_UNIT_STATUS.ACTIVE) return res.status(409).json({ error: "A retired unit keeps its serial number." });
  if (unit.serialNo !== expectedSerialNo) return res.status(409).json({ error: STALE_SERIAL });

  const clash = await prisma.recdUnit.findUnique({ where: { serialNo } });
  if (clash) return res.status(409).json({ error: takenSerialsMessage([serialNo]) });

  try {
    const changed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.recdUnit.updateMany({ where: { id, serialNo: expectedSerialNo, status: RECD_UNIT_STATUS.ACTIVE }, data: { serialNo } });
      if (count === 0) return false;
      await tx.recdUnitSerialHistory.create({ data: { unitId: id, previousSerialNo: expectedSerialNo, newSerialNo: serialNo, reason, actorId: req.auth!.userId } });
      return true;
    });
    if (!changed) return res.status(409).json({ error: STALE_SERIAL });
    res.json(await prisma.recdUnit.findUnique({ where: { id }, include: unitInclude }));
  } catch (err) {
    if (isSerialConflict(err)) return res.status(409).json({ error: takenSerialsMessage([serialNo]) });
    throw err;
  }
});
