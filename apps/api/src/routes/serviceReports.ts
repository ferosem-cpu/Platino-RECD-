import { Router, type Response } from "express";
import { Prisma } from "@prisma/client";
import {
  AMC_TYPE_LABELS,
  COMPLAINT_EVENT,
  PERMISSION_KEY,
  ROLE_KEY,
  SERVICE_REPORT_FINAL_STATUSES,
  SERVICE_REPORT_KIND,
  SERVICE_REPORT_OPEN_STATUSES,
  SERVICE_REPORT_STATUS,
  canTransitionServiceReport,
  createAmcServiceReportSchema,
  createServiceReportSchema,
  reopenServiceReportSchema,
  serviceReportMissingFields,
  signServiceReportSchema,
  submitServiceReportSchema,
  updateServiceReportSchema,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, type AuthenticatedRequest } from "../middleware/auth";
import { asString, asOptionalString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { logComplaintEvent } from "../lib/ticketEvents";
import { checkSignatureDataUrl } from "../lib/signatureImage";
import { buildServiceReportPdf, type ServiceReportPdfInput } from "../lib/serviceReportPdf";
import { getReportStorage, sha256Hex, type ReportStorage } from "../lib/reportStorage";

/**
 * Digital service reports. Two kinds share ONE table, one state machine, one signature check, one PDF builder and one
 * file store:
 *   - "ticket" (Requirement 4): a visit on a service ticket.
 *   - "amc"    (Requirement 5): a visit under an AMC order, for ONE RECD unit that the order covers.
 *
 * States: draft -> awaiting_signature -> signed (final). An AMC report whose acknowledgement is marked NOT required
 * (an explicit, stored per-report rule) goes draft -> submitted (final, clearly "not signed"). Final reports are
 * immutable (API and database trigger).
 *
 * WHO MAY DO WHAT (all enforced here, never by the screens):
 *  TICKET reports - write: MANAGE_COMPLAINTS, or ACT_ASSIGNED_COMPLAINTS on a ticket assigned to that user (vendor users
 *    only for their vendor's sites, Regional Managers only for their regions). Read: those staff plus
 *    VIEW_COMPLAINTS_OVERVIEW holders.
 *  AMC reports - the existing AMC boundary: write AND read need MANAGE_AMC_ORDERS (management-level roles today; field
 *    engineers, service staff, sales and vendors cannot even list AMC orders, so they get no AMC reports - widening that
 *    needs mentor approval). Vendor-scoped users and Regional Managers are additionally limited to their sites/regions.
 *  Customers (both kinds) - read reports of their OWN customer once they have left draft; sign only reports awaiting
 *    signature. The signer is the logged-in customer contact; the typed name and drawn image are recorded evidence.
 *  customerId / siteId / unitId / serial are never read from a request body: tickets give them for ticket reports; the AMC
 *  order and the covered unit give them for AMC reports.
 */
export const serviceReportsRouter = Router();
serviceReportsRouter.use(authenticate);

const MAX_NUMBER_ATTEMPTS = 3;
const NOT_FOUND = { error: "Service report not found" };
const EVENT_UPDATED = "service_report_updated";
const amcRef = (amcOrderId: string) => `AMC-${amcOrderId.slice(-6).toUpperCase()}`;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface Access {
  read: boolean;
  write: boolean;
}
const NONE: Access = { read: false, write: false };

interface TicketScope {
  assignedToId: string | null;
  site: { regionId: string | null; vendorId: string | null } | null;
}

/** What staff may do with a ticket's reports. Customers are never staff. */
async function staffAccess(req: AuthenticatedRequest, ticket: TicketScope): Promise<Access> {
  const a = req.auth!;
  if (a.customerId) return NONE;
  const manage = a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS);
  const act = a.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS) && ticket.assignedToId === a.userId;
  const overview = a.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  if (!manage && !act && !overview) return NONE;
  if (a.vendorId && ticket.site?.vendorId !== a.vendorId) return NONE;
  if (a.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    const regions = await managedRegionIds(a.userId, a.roleKey);
    if (!ticket.site?.regionId || !regions.includes(ticket.site.regionId)) return NONE;
  }
  return { read: true, write: manage || act };
}

/**
 * What staff may do with AMC reports: the AMC boundary (MANAGE_AMC_ORDERS), narrowed by the unit's site for vendor and
 * regional users. `site` is null when no particular site is in play (a list for a whole AMC order): scoped users then
 * get nothing, which is the conservative reading.
 */
async function amcStaffAccess(req: AuthenticatedRequest, site: { regionId: string | null; vendorId: string | null } | null | undefined, scoped = true): Promise<Access> {
  const a = req.auth!;
  if (a.customerId || !a.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS)) return NONE;
  if (a.vendorId && (!scoped || site?.vendorId !== a.vendorId)) return NONE;
  if (a.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    const regions = await managedRegionIds(a.userId, a.roleKey);
    if (!scoped || !site?.regionId || !regions.includes(site.regionId)) return NONE;
  }
  return { read: true, write: true };
}

const isOwnCustomer = (req: AuthenticatedRequest, customerId: string) => !!req.auth!.customerId && req.auth!.customerId === customerId;

const ticketSelect = {
  id: true,
  archivedAt: true,
  ticketNumber: true,
  status: true,
  customerId: true,
  siteId: true,
  unitId: true,
  assignedToId: true,
  site: { select: { id: true, regionId: true, vendorId: true } },
} as const;

const reportInclude = {
  complaint: { select: ticketSelect },
  amcOrder: { select: { id: true, poNo: true, poDate: true, amcType: true, amcFrequencyPerYear: true, location: true } },
  site: { select: { id: true, regionId: true, vendorId: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

type ReportRow = Prisma.ServiceReportGetPayload<{ include: typeof reportInclude }>;

async function accessTo(req: AuthenticatedRequest, report: ReportRow): Promise<Access> {
  if (report.kind === SERVICE_REPORT_KIND.AMC) return amcStaffAccess(req, report.site);
  return report.complaint ? staffAccess(req, report.complaint) : NONE;
}

/** Loads a report and decides what the caller may do with it. Unknown OR forbidden both look like "not found" to customers. */
async function loadWithAccess(req: AuthenticatedRequest, res: Response, id: string): Promise<{ report: ReportRow; staff: Access; customer: boolean } | null> {
  const report = await prisma.serviceReport.findUnique({ where: { id }, include: reportInclude });
  if (!report) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  const staff = await accessTo(req, report);
  const customer = isOwnCustomer(req, report.customerId) && report.status !== SERVICE_REPORT_STATUS.DRAFT;
  if (!staff.read && !customer) {
    if (req.auth!.customerId) res.status(404).json(NOT_FOUND);
    else res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { report, staff, customer };
}

// ---------------------------------------------------------------------------
// Presentation + integrity
// ---------------------------------------------------------------------------

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const isFinal = (status: string) => (SERVICE_REPORT_FINAL_STATUSES as string[]).includes(status);

function toApi(r: ReportRow) {
  return {
    id: r.id,
    reportNumber: r.reportNumber,
    kind: r.kind,
    complaintId: r.complaintId,
    ticketNumber: r.complaint?.ticketNumber ?? null,
    amc: r.amcOrder
      ? { id: r.amcOrder.id, ref: amcRef(r.amcOrder.id), poNo: r.amcOrder.poNo, type: r.amcOrder.amcType, typeLabel: AMC_TYPE_LABELS[r.amcOrder.amcType] ?? r.amcOrder.amcType }
      : null,
    customerId: r.customerId,
    siteId: r.siteId,
    unitId: r.unitId,
    unitSerialNo: r.unitSerialNo,
    acknowledgementRequired: r.acknowledgementRequired,
    status: r.status,
    version: r.version,
    visitDate: dateOnly(r.visitDate),
    workPerformed: r.workPerformed,
    findings: r.findings,
    resolution: r.resolution,
    partsUsed: r.partsUsed,
    remarks: r.remarks,
    engineer: r.createdBy,
    createdAt: r.createdAt,
    submittedAt: r.submittedAt,
    signedAt: r.signedAt,
    signerName: r.signerName,
    signedVersion: r.signedVersion,
    /** True when a final PDF exists (signed, or submitted without signature) - served only by GET /:id/pdf after authorisation. */
    pdfAvailable: isFinal(r.status) && !!r.pdfFileId,
  };
}

type Fingerprinted = Pick<ReportRow, "reportNumber" | "complaintId" | "customerId" | "siteId" | "unitId" | "visitDate" | "workPerformed" | "findings" | "resolution" | "partsUsed" | "remarks" | "version"> &
  Partial<Pick<ReportRow, "kind" | "amcOrderId" | "unitSerialNo" | "acknowledgementRequired">>;

/**
 * Fingerprint of everything the customer is asked to approve. The TICKET formula is exactly the Requirement 4 one (so
 * reports already awaiting signature when AMC support shipped still verify); AMC reports also bind the AMC order, the
 * serial snapshot and the acknowledgement rule.
 */
export function reportContentHash(r: Fingerprinted): string {
  const core = [r.reportNumber, r.complaintId, r.customerId, r.siteId, r.unitId, dateOnly(r.visitDate), r.workPerformed, r.findings, r.resolution, r.partsUsed ?? "", r.remarks ?? "", r.version];
  return sha256Hex(JSON.stringify(r.kind === SERVICE_REPORT_KIND.AMC ? [...core, "amc", r.amcOrderId, r.unitSerialNo, r.acknowledgementRequired] : core));
}

/** Audit: every report keeps its own history; ticket reports also appear in the ticket history. */
async function event(req: AuthenticatedRequest, r: ReportRow, type: string, toValue: string, fromValue?: string | null, extra: Record<string, unknown> = {}) {
  const detail = { reportId: r.id, reportNumber: r.reportNumber, kind: r.kind, version: r.version, amcOrderId: r.amcOrderId, unitId: r.unitId, ...extra } as Prisma.InputJsonValue;
  try {
    await prisma.serviceReportEvent.create({ data: { reportId: r.id, type, fromValue: fromValue ?? null, toValue, actorId: req.auth!.userId, detail } });
  } catch (err) {
    console.error("Failed to log service report event", err instanceof Error ? err.name : "unknown");
  }
  if (r.complaintId && type !== EVENT_UPDATED) {
    await logComplaintEvent({ complaintId: r.complaintId, type: type as never, fromValue: fromValue ?? null, toValue, actorId: req.auth!.userId, detail });
  }
}

const staleVersion = (res: Response) =>
  res.status(409).json({ error: "This report was changed by someone else. Reload it and try again.", code: "STALE_VERSION" });

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

/**
 * Which reports a STAFF user may list, as a Prisma filter - the same rules as staffAccess / amcStaffAccess, expressed once for a whole list:
 *  - ticket reports: MANAGE_COMPLAINTS or VIEW_COMPLAINTS_OVERVIEW see every ticket's reports; ACT_ASSIGNED_COMPLAINTS only those of tickets
 *    assigned to them; a vendor user only their vendor's sites; a Regional Manager only their mapped regions (a ticket without a site is out of
 *    every region and out of every vendor).
 *  - AMC reports: MANAGE_AMC_ORDERS, narrowed by the report's site for vendor and regional users in the same way.
 * Returns null when the user may list nothing. Customers never get here (they use /mine or a ticket / AMC order they own).
 */
async function staffListScope(req: AuthenticatedRequest): Promise<Prisma.ServiceReportWhereInput | null> {
  const a = req.auth!;
  if (a.customerId) return null;
  const regions = a.roleKey === ROLE_KEY.REGIONAL_MANAGER ? await managedRegionIds(a.userId, a.roleKey) : null;
  const siteScope = (): Prisma.SiteWhereInput => ({
    ...(a.vendorId ? { vendorId: a.vendorId } : {}),
    ...(regions ? { regionId: { in: regions } } : {}),
  });
  const scoped = !!a.vendorId || !!regions;

  const clauses: Prisma.ServiceReportWhereInput[] = [];
  const seesAllTickets = a.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || a.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  const seesAssigned = a.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS);
  if (seesAllTickets || seesAssigned) {
    clauses.push({
      kind: SERVICE_REPORT_KIND.TICKET,
      complaint: {
        ...(seesAllTickets ? {} : { assignedToId: a.userId }),
        ...(scoped ? { site: siteScope() } : {}),
      },
    });
  }
  if (a.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS)) {
    clauses.push({ kind: SERVICE_REPORT_KIND.AMC, ...(scoped ? { site: siteScope() } : {}) });
  }
  return clauses.length ? { OR: clauses } : null;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

const listInclude = {
  ...reportInclude,
  customer: { select: { id: true, name: true } },
  site: { select: { id: true, regionId: true, vendorId: true, companyName: true } },
  unit: { select: { id: true, serialNo: true } },
} as const;

/**
 * Staff list of service reports across tickets and AMC orders, narrowed by the caller's own scope (staffListScope) AND the optional filters
 * status, kind, customerId, siteId, unitId and a free-text q (report number, ticket number, serial, customer, site). A filter can only ever
 * narrow what the caller may already see.
 */
async function listForStaff(req: AuthenticatedRequest, res: Response) {
  const scope = await staffListScope(req);
  if (!scope) return res.status(403).json({ error: "Forbidden" });

  const status = asOptionalString(req.query.status);
  const kind = asOptionalString(req.query.kind);
  if (status && !Object.values(SERVICE_REPORT_STATUS).includes(status as never)) return res.status(400).json({ error: "Unknown status" });
  if (kind && !Object.values(SERVICE_REPORT_KIND).includes(kind as never)) return res.status(400).json({ error: "Unknown kind" });
  const customerId = asOptionalString(req.query.customerId);
  const siteId = asOptionalString(req.query.siteId);
  const unitId = asOptionalString(req.query.unitId);
  const q = asOptionalString(req.query.q)?.trim().slice(0, 100);
  const limit = Math.min(Math.max(parseInt(asOptionalString(req.query.limit) ?? "", 10) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(parseInt(asOptionalString(req.query.offset) ?? "", 10) || 0, 0);

  const contains = (v: string) => ({ contains: v, mode: "insensitive" as const });
  const where: Prisma.ServiceReportWhereInput = {
    AND: [
      scope,
      ...(status ? [{ status }] : []),
      ...(kind ? [{ kind }] : []),
      ...(customerId ? [{ customerId }] : []),
      ...(siteId ? [{ siteId }] : []),
      ...(unitId ? [{ unitId }] : []),
      ...(q
        ? [
            {
              OR: [
                { reportNumber: contains(q) },
                { unitSerialNo: contains(q) },
                { unit: { serialNo: contains(q) } },
                { complaint: { ticketNumber: contains(q) } },
                { customer: { name: contains(q) } },
                { site: { companyName: contains(q) } },
              ],
            },
          ]
        : []),
    ],
  };

  const [total, rows] = await Promise.all([
    prisma.serviceReport.count({ where }),
    prisma.serviceReport.findMany({ where, include: listInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: limit, skip: offset }),
  ]);
  res.json({
    total,
    limit,
    offset,
    reports: rows.map((r) => ({
      ...toApi(r as unknown as ReportRow),
      customerName: r.customer.name,
      siteName: r.site?.companyName ?? null,
      // An AMC report prints its own snapshot; a ticket report has none, so the unit's current serial is shown.
      unitSerial: r.unitSerialNo ?? r.unit?.serialNo ?? null,
    })),
  });
}

serviceReportsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const complaintId = asOptionalString(req.query.complaintId);
  const amcOrderId = asOptionalString(req.query.amcOrderId);
  if (complaintId && amcOrderId) return res.status(400).json({ error: "Ask for the reports of a ticket OR of an AMC order, not both" });
  if (!complaintId && !amcOrderId) {
    // No ticket / AMC order named: staff get their scoped list; a customer must name one of their own (or use /mine).
    if (req.auth!.customerId) return res.status(400).json({ error: "complaintId or amcOrderId is required" });
    return listForStaff(req, res);
  }

  if (amcOrderId) {
    const amc = await prisma.amcOrder.findUnique({
      where: { id: amcOrderId },
      select: {
        id: true, poNo: true, poDate: true, amcType: true, amcFrequencyPerYear: true, location: true, customerId: true,
        customer: { select: { name: true } },
        units: { select: { unit: { select: { id: true, serialNo: true, status: true, site: { select: { companyName: true, address: true } } } } } },
      },
    });
    if (!amc) return res.status(req.auth!.customerId ? 404 : 404).json({ error: "AMC order not found" });
    const staff = await amcStaffAccess(req, null, false);
    const customer = isOwnCustomer(req, amc.customerId);
    if (!staff.read && !customer) return res.status(req.auth!.customerId ? 404 : 403).json(req.auth!.customerId ? { error: "AMC order not found" } : { error: "Forbidden" });

    const unitFilter = asOptionalString(req.query.unitId);
    const reports = await prisma.serviceReport.findMany({
      where: { amcOrderId, ...(unitFilter ? { unitId: unitFilter } : {}), ...(staff.read ? {} : { status: { not: SERVICE_REPORT_STATUS.DRAFT } }) },
      include: reportInclude,
      orderBy: { createdAt: "asc" },
    });
    return res.json({
      canWrite: staff.write,
      reports: reports.map(toApi),
      context: {
        kind: SERVICE_REPORT_KIND.AMC,
        amc: { id: amc.id, ref: amcRef(amc.id), poNo: amc.poNo, poDate: dateOnly(amc.poDate), type: amc.amcType, typeLabel: AMC_TYPE_LABELS[amc.amcType] ?? amc.amcType, location: amc.location, visitsPerYear: amc.amcFrequencyPerYear, customerName: amc.customer.name },
        units: amc.units.map((l) => ({ id: l.unit.id, serialNo: l.unit.serialNo, status: l.unit.status, siteName: l.unit.site?.companyName ?? null, address: l.unit.site?.address ?? null })),
      },
    });
  }

  const ticket = await prisma.complaint.findUnique({ where: { id: complaintId! }, select: ticketSelect });
  if (!ticket) return res.status(404).json({ error: "Complaint not found" });

  const staff = await staffAccess(req, ticket);
  const customer = isOwnCustomer(req, ticket.customerId);
  if (!staff.read && !customer) return res.status(customer || req.auth!.customerId ? 404 : 403).json(req.auth!.customerId ? { error: "Complaint not found" } : { error: "Forbidden" });

  const reports = await prisma.serviceReport.findMany({
    where: { complaintId: complaintId!, ...(staff.read ? {} : { status: { not: SERVICE_REPORT_STATUS.DRAFT } }) },
    include: reportInclude,
    orderBy: { createdAt: "asc" },
  });
  res.json({ canWrite: staff.write, reports: reports.map(toApi) });
});

/** A customer's own reports (tickets and AMC) that have left draft - the customer-facing entry point. */
serviceReportsRouter.get("/mine", async (req: AuthenticatedRequest, res) => {
  const customerId = req.auth!.customerId;
  if (!customerId) return res.status(403).json({ error: "Forbidden" });
  const reports = await prisma.serviceReport.findMany({
    where: { customerId, status: { not: SERVICE_REPORT_STATUS.DRAFT } },
    include: { ...reportInclude, unit: { select: { serialNo: true } } },
    orderBy: { createdAt: "desc" },
  });
  // unitSerial: an AMC report prints its own snapshot; a ticket report has none, so the unit's current serial is shown (the customer's own unit).
  res.json({ reports: reports.map((r) => ({ ...toApi(r as unknown as ReportRow), unitSerial: r.unitSerialNo ?? r.unit?.serialNo ?? null })) });
});

serviceReportsRouter.get("/:id", async (req: AuthenticatedRequest, res) => {
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  const [customer, site, unit] = await Promise.all([
    prisma.customer.findUnique({ where: { id: report.customerId }, select: { name: true } }),
    report.siteId ? prisma.site.findUnique({ where: { id: report.siteId }, select: { companyName: true, address: true, dgModel: true, dgCapacityKva: true } }) : null,
    report.unitId ? prisma.recdUnit.findUnique({ where: { id: report.unitId }, select: { serialNo: true, product: { select: { name: true, model: true } } } }) : null,
  ]);
  const open = report.status === SERVICE_REPORT_STATUS.DRAFT;
  res.json({
    ...toApi(report),
    customerName: customer?.name ?? null,
    amcDetails: report.amcOrder
      ? { ref: amcRef(report.amcOrder.id), poNo: report.amcOrder.poNo, poDate: dateOnly(report.amcOrder.poDate), location: report.amcOrder.location, visitsPerYear: report.amcOrder.amcFrequencyPerYear }
      : null,
    site: site ? { name: site.companyName, address: site.address, dgModel: site.dgModel, dgCapacityKva: site.dgCapacityKva } : null,
    // The serial printed on the report is the snapshot taken when it was written; the live unit only supplies the model.
    unit: report.unitId || report.unitSerialNo ? { serialNo: report.unitSerialNo ?? unit?.serialNo ?? null, model: unit?.product ? `${unit.product.name} (${unit.product.model})` : null } : null,
    permissions: {
      canEdit: found.staff.write && open,
      canSubmit: found.staff.write && open,
      canReopen: found.staff.write && report.status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE,
      canSign: isOwnCustomer(req, report.customerId) && report.status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE,
    },
  });
});

// ---------------------------------------------------------------------------
// Create (draft)
// ---------------------------------------------------------------------------

async function createTicketReport(req: AuthenticatedRequest, res: Response) {
  const parsed = createServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const ticket = await prisma.complaint.findUnique({ where: { id: d.complaintId }, select: ticketSelect });
  if (!ticket) return res.status(404).json({ error: "Complaint not found" });
  if (!(await staffAccess(req, ticket)).write) return res.status(403).json({ error: "You cannot create a service report for this ticket" });
  if (ticket.archivedAt) return res.status(409).json({ error: "This ticket is archived, so no new service report can be created for it." });

  // One report in progress per ticket (also a database-level partial unique index). A finished one does not block a new visit.
  const inProgress = await prisma.serviceReport.findFirst({ where: { complaintId: ticket.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true, status: true } });
  if (inProgress) {
    return res.status(409).json({ error: `Report ${inProgress.reportNumber} for this ticket is still ${inProgress.status.replace(/_/g, " ")}. Finish it first.`, code: "REPORT_IN_PROGRESS", reportId: inProgress.id });
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const n = (await prisma.serviceReport.count({ where: { complaintId: ticket.id } })) + 1 + attempt;
    try {
      const created = await prisma.serviceReport.create({
        data: {
          reportNumber: `${ticket.ticketNumber}-R${n}`,
          complaintId: ticket.id,
          // Derived from the TICKET - never from the request.
          customerId: ticket.customerId,
          siteId: ticket.siteId,
          unitId: ticket.unitId,
          createdById: req.auth!.userId,
          visitDate: new Date(`${d.visitDate}T00:00:00.000Z`),
          workPerformed: d.workPerformed,
          findings: d.findings,
          resolution: d.resolution,
          partsUsed: d.partsUsed || null,
          remarks: d.remarks || null,
        },
        include: reportInclude,
      });
      await event(req, created, COMPLAINT_EVENT.SERVICE_REPORT_CREATED, SERVICE_REPORT_STATUS.DRAFT);
      return res.status(201).json(toApi(created));
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const raced = await prisma.serviceReport.findFirst({ where: { complaintId: ticket.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true } });
      if (raced) return res.status(409).json({ error: `Report ${raced.reportNumber} was just started for this ticket.`, code: "REPORT_IN_PROGRESS", reportId: raced.id });
      // otherwise a report-number collision: try the next number
    }
  }
  return res.status(409).json({ error: "Could not allocate a report number. Nothing was saved - please try again.", code: "REPORT_NUMBER_CONFLICT" });
}

async function createAmcReport(req: AuthenticatedRequest, res: Response) {
  if ((req.body as Record<string, unknown>).complaintId !== undefined) {
    return res.status(400).json({ error: "A service report belongs to a ticket or to an AMC order, not both." });
  }
  // The AMC boundary comes first, before anything about the order is revealed.
  if (req.auth!.customerId || !req.auth!.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS)) return res.status(403).json({ error: "You cannot create an AMC service report" });

  const parsed = createAmcServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const amc = await prisma.amcOrder.findUnique({ where: { id: d.amcOrderId }, select: { id: true, customerId: true, units: { select: { unitId: true } } } });
  if (!amc) return res.status(404).json({ error: "AMC order not found" });
  // 1. the unit must be covered by THIS AMC order (the AmcOrderUnit link) ...
  if (!amc.units.some((l) => l.unitId === d.unitId)) return res.status(400).json({ error: "That RECD unit is not covered by this AMC order.", code: "UNIT_NOT_IN_AMC" });
  const unit = await prisma.recdUnit.findUnique({
    where: { id: d.unitId },
    select: { id: true, serialNo: true, status: true, siteId: true, order: { select: { customerId: true } }, site: { select: { id: true, regionId: true, vendorId: true } } },
  });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  // 2. ... must belong to the AMC's customer (defence in depth: the link was checked when the AMC was created) ...
  if (unit.order.customerId !== amc.customerId) return res.status(400).json({ error: "That RECD unit does not belong to this AMC order's customer.", code: "UNIT_CUSTOMER_MISMATCH" });
  // 3. ... must carry a serial (it is printed on the report) and still be in service.
  if (!unit.serialNo) return res.status(400).json({ error: "That RECD unit has no serial number yet.", code: "UNIT_NO_SERIAL" });
  if (unit.status !== "active") return res.status(400).json({ error: "That RECD unit is retired.", code: "UNIT_RETIRED" });
  if (!(await amcStaffAccess(req, unit.site)).write) return res.status(403).json({ error: "You cannot create a service report for this site" });

  const open = await prisma.serviceReport.findFirst({ where: { amcOrderId: amc.id, unitId: unit.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true, status: true } });
  if (open) {
    return res.status(409).json({ error: `Report ${open.reportNumber} for this unit is still ${open.status.replace(/_/g, " ")}. Finish it first.`, code: "REPORT_IN_PROGRESS", reportId: open.id });
  }

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const n = (await prisma.serviceReport.count({ where: { amcOrderId: amc.id } })) + 1 + attempt;
    try {
      const created = await prisma.serviceReport.create({
        data: {
          reportNumber: `${amcRef(amc.id)}-R${n}`,
          kind: SERVICE_REPORT_KIND.AMC,
          amcOrderId: amc.id,
          // Derived from the AMC order and the covered unit - never from the request.
          customerId: amc.customerId,
          siteId: unit.siteId,
          unitId: unit.id,
          unitSerialNo: unit.serialNo,
          acknowledgementRequired: d.acknowledgementRequired,
          createdById: req.auth!.userId,
          visitDate: new Date(`${d.visitDate}T00:00:00.000Z`),
          workPerformed: d.workPerformed,
          findings: d.findings,
          resolution: d.resolution,
          partsUsed: d.partsUsed || null,
          remarks: d.remarks || null,
        },
        include: reportInclude,
      });
      await event(req, created, COMPLAINT_EVENT.SERVICE_REPORT_CREATED, SERVICE_REPORT_STATUS.DRAFT, null, { acknowledgementRequired: created.acknowledgementRequired, unitSerialNo: created.unitSerialNo });
      return res.status(201).json(toApi(created));
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const raced = await prisma.serviceReport.findFirst({ where: { amcOrderId: amc.id, unitId: unit.id, status: { in: SERVICE_REPORT_OPEN_STATUSES } }, select: { id: true, reportNumber: true } });
      if (raced) return res.status(409).json({ error: `Report ${raced.reportNumber} was just started for this unit.`, code: "REPORT_IN_PROGRESS", reportId: raced.id });
    }
  }
  return res.status(409).json({ error: "Could not allocate a report number. Nothing was saved - please try again.", code: "REPORT_NUMBER_CONFLICT" });
}

serviceReportsRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && body.amcOrderId !== undefined) return createAmcReport(req, res);
  return createTicketReport(req, res);
});

// ---------------------------------------------------------------------------
// Edit / submit / reopen
// ---------------------------------------------------------------------------

serviceReportsRouter.patch("/:id", async (req: AuthenticatedRequest, res) => {
  const parsed = updateServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot edit this report" });
  if (isFinal(report.status)) return res.status(409).json({ error: `A ${report.status} report is final and cannot be edited.`, code: "REPORT_FINAL" });
  if (report.status !== SERVICE_REPORT_STATUS.DRAFT) return res.status(409).json({ error: "This report is awaiting the customer's signature. Reopen it to edit.", code: "REPORT_NOT_DRAFT" });
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);
  if (parsed.data.acknowledgementRequired !== undefined && report.kind !== SERVICE_REPORT_KIND.AMC) {
    return res.status(400).json({ error: "Service reports on a ticket always need the customer's signature." });
  }

  const { expectedVersion, visitDate, partsUsed, remarks, acknowledgementRequired, ...rest } = parsed.data;
  const claimed = await prisma.serviceReport.updateMany({
    // status AND version in the condition: a concurrent submit/edit makes this a no-op instead of an overwrite.
    where: { id: report.id, status: SERVICE_REPORT_STATUS.DRAFT, version: expectedVersion },
    data: {
      ...rest,
      ...(visitDate ? { visitDate: new Date(`${visitDate}T00:00:00.000Z`) } : {}),
      ...(partsUsed !== undefined ? { partsUsed: partsUsed || null } : {}),
      ...(remarks !== undefined ? { remarks: remarks || null } : {}),
      ...(acknowledgementRequired !== undefined ? { acknowledgementRequired } : {}),
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return staleVersion(res);
  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, EVENT_UPDATED, SERVICE_REPORT_STATUS.DRAFT, SERVICE_REPORT_STATUS.DRAFT);
  res.json(toApi(fresh));
});

/** Everything the PDF needs besides the report row. */
async function pdfContext(report: ReportRow): Promise<Omit<ServiceReportPdfInput, "signerName" | "signedAt" | "signaturePng" | "contentHash" | "finalState" | "submittedAt">> {
  const [customer, site, unit, engineer] = await Promise.all([
    prisma.customer.findUnique({ where: { id: report.customerId }, select: { name: true } }),
    report.siteId ? prisma.site.findUnique({ where: { id: report.siteId }, select: { companyName: true, address: true, dgModel: true, dgCapacityKva: true } }) : null,
    report.unitId ? prisma.recdUnit.findUnique({ where: { id: report.unitId }, select: { serialNo: true, product: { select: { name: true, model: true } } } }) : null,
    prisma.user.findUnique({ where: { id: report.createdById }, select: { name: true } }),
  ]);
  return {
    reportNumber: report.reportNumber,
    kind: report.kind === SERVICE_REPORT_KIND.AMC ? "amc" : "ticket",
    ticketNumber: report.complaint?.ticketNumber ?? null,
    amc: report.amcOrder
      ? {
          orderRef: amcRef(report.amcOrder.id),
          poNo: report.amcOrder.poNo,
          poDate: report.amcOrder.poDate,
          typeLabel: AMC_TYPE_LABELS[report.amcOrder.amcType] ?? report.amcOrder.amcType,
          frequencyPerYear: report.amcOrder.amcFrequencyPerYear,
          location: report.amcOrder.location,
        }
      : null,
    customerName: customer?.name ?? "-",
    siteName: site?.companyName ?? null,
    siteAddress: site?.address ?? null,
    // The serial printed is the one recorded when the report was written (AMC) - not whatever the unit row says today.
    recdSerial: report.unitSerialNo ?? unit?.serialNo ?? null,
    recdModel: unit?.product ? `${unit.product.name} (${unit.product.model})` : null,
    dgModel: site?.dgModel ?? null,
    dgCapacityKva: site?.dgCapacityKva != null ? Number(site.dgCapacityKva) : null,
    visitDate: report.visitDate,
    engineerName: engineer?.name ?? report.createdBy.name,
    workPerformed: report.workPerformed,
    findings: report.findings,
    resolution: report.resolution,
    partsUsed: report.partsUsed,
    remarks: report.remarks,
    version: report.version,
  };
}

async function discard(storage: ReportStorage, refs: Array<string | undefined>) {
  for (const ref of refs) {
    if (!ref) continue;
    try {
      await storage.delete(ref);
    } catch (err) {
      console.error("[service-report] could not remove an orphaned file", err instanceof Error ? err.name : "unknown");
    }
  }
}

serviceReportsRouter.post("/:id/submit", async (req: AuthenticatedRequest, res) => {
  const parsed = submitServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot submit this report" });
  // Needs the customer's signature -> awaiting_signature; explicitly not required (AMC only) -> final "submitted".
  const target = report.acknowledgementRequired ? SERVICE_REPORT_STATUS.AWAITING_SIGNATURE : SERVICE_REPORT_STATUS.SUBMITTED;
  if (!canTransitionServiceReport(report.status, target)) {
    return res.status(409).json({ error: `A ${report.status.replace(/_/g, " ")} report cannot be submitted.`, code: "BAD_TRANSITION" });
  }
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);

  const missing = serviceReportMissingFields(report);
  if (missing.length) return res.status(400).json({ error: `Complete these before submitting: ${missing.join(", ")}.`, missing });

  const contentHash = reportContentHash(report);

  if (target === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE) {
    const claimed = await prisma.serviceReport.updateMany({
      where: { id: report.id, status: SERVICE_REPORT_STATUS.DRAFT, version: report.version },
      data: { status: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, submittedAt: new Date(), submittedById: req.auth!.userId, contentHash },
    });
    if (claimed.count !== 1) return staleVersion(res);
    const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
    await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_SUBMITTED, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, SERVICE_REPORT_STATUS.DRAFT);
    return res.json(toApi(fresh));
  }

  // Final without a customer signature: build and store the PDF first, then claim the report, and clean up on any failure.
  const storage = getReportStorage();
  if (!storage) return res.status(503).json({ error: "Signed-report storage is not configured. Please contact Platino service.", code: "STORAGE_NOT_CONFIGURED" });
  const submittedAt = new Date();
  let pdf: Buffer;
  try {
    pdf = await buildServiceReportPdf({ ...(await pdfContext(report)), finalState: "submitted", submittedAt, contentHash });
  } catch (err) {
    console.error("[service-report] PDF generation failed", err instanceof Error ? err.name : "unknown");
    return res.status(500).json({ error: "The report PDF could not be created. Nothing was saved - please try again.", code: "PDF_GENERATION_FAILED" });
  }
  let stored: Awaited<ReturnType<ReportStorage["put"]>>;
  try {
    stored = await storage.put(pdf, "application/pdf");
  } catch (err) {
    console.error("[service-report] storing the report failed", err instanceof Error ? err.name : "unknown");
    return res.status(502).json({ error: "The report could not be stored. Nothing was saved - please try again.", code: "STORAGE_FAILED" });
  }
  let count: number;
  try {
    const claimed = await prisma.serviceReport.updateMany({
      where: { id: report.id, status: SERVICE_REPORT_STATUS.DRAFT, version: report.version },
      data: { status: SERVICE_REPORT_STATUS.SUBMITTED, submittedAt, submittedById: req.auth!.userId, contentHash, pdfFileId: stored.ref, pdfSha256: stored.sha256 },
    });
    count = claimed.count;
  } catch (err) {
    await discard(storage, [stored.ref]);
    throw err;
  }
  if (count !== 1) {
    await discard(storage, [stored.ref]);
    return staleVersion(res);
  }
  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_SUBMITTED, SERVICE_REPORT_STATUS.SUBMITTED, SERVICE_REPORT_STATUS.DRAFT, { finalPdfGenerated: true, pdfSha256: stored.sha256, signed: false });
  res.json(toApi(fresh));
});

/** Staff pull a report back from "awaiting signature" to fix it. The version moves on, so a customer who had the old one open cannot sign it. */
serviceReportsRouter.post("/:id/reopen", async (req: AuthenticatedRequest, res) => {
  const parsed = reopenServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  if (!found.staff.write) return res.status(403).json({ error: "You cannot reopen this report" });
  if (!canTransitionServiceReport(report.status, SERVICE_REPORT_STATUS.DRAFT)) {
    return res.status(409).json({ error: isFinal(report.status) ? `A ${report.status} report is final and cannot be reopened.` : "Only a report awaiting signature can be reopened.", code: "BAD_TRANSITION" });
  }
  if (parsed.data.expectedVersion !== report.version) return staleVersion(res);

  const claimed = await prisma.serviceReport.updateMany({
    where: { id: report.id, status: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, version: report.version },
    data: { status: SERVICE_REPORT_STATUS.DRAFT, version: { increment: 1 }, contentHash: null, submittedAt: null, submittedById: null },
  });
  if (claimed.count !== 1) return staleVersion(res);
  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_REOPENED, SERVICE_REPORT_STATUS.DRAFT, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE);
  res.json(toApi(fresh));
});

// ---------------------------------------------------------------------------
// Sign (customer)
// ---------------------------------------------------------------------------

serviceReportsRouter.post("/:id/sign", async (req: AuthenticatedRequest, res) => {
  // Only a logged-in customer contact may sign - checked before anything about the report is revealed.
  if (!req.auth!.customerId) return res.status(403).json({ error: "Only the customer can sign a service report" });

  const parsed = signServiceReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const report = await prisma.serviceReport.findUnique({ where: { id: asString(req.params.id) }, include: reportInclude });
  if (!report || report.customerId !== req.auth!.customerId || report.status === SERVICE_REPORT_STATUS.DRAFT) return res.status(404).json(NOT_FOUND);
  if (report.status === SERVICE_REPORT_STATUS.SIGNED) return res.status(409).json({ error: "This report has already been signed.", code: "ALREADY_SIGNED" });
  if (!canTransitionServiceReport(report.status, SERVICE_REPORT_STATUS.SIGNED) || !report.acknowledgementRequired) {
    return res.status(409).json({ error: "This report does not need a signature or cannot be signed.", code: "BAD_TRANSITION" });
  }
  if (parsed.data.version !== report.version) {
    return res.status(409).json({ error: "This report changed after you opened it. Please review the latest version before signing.", code: "STALE_VERSION" });
  }
  // The content must still be exactly what was submitted for signature.
  const missing = serviceReportMissingFields(report);
  if (missing.length || !report.contentHash || report.contentHash !== reportContentHash(report)) {
    return res.status(409).json({ error: "This report is not in a signable state. Please contact Platino service.", code: "REPORT_NOT_SIGNABLE" });
  }

  const signature = checkSignatureDataUrl(parsed.data.signatureImage);
  if (!signature.ok) return res.status(400).json({ error: signature.reason, code: "BAD_SIGNATURE" });

  const storage = getReportStorage();
  if (!storage) return res.status(503).json({ error: "Signed-report storage is not configured. Please contact Platino service.", code: "STORAGE_NOT_CONFIGURED" });

  const signedAt = new Date();
  let pdf: Buffer;
  try {
    pdf = await buildServiceReportPdf({
      ...(await pdfContext(report)),
      finalState: "signed",
      signerName: parsed.data.signerName,
      signedAt,
      contentHash: report.contentHash,
      signaturePng: signature.bytes,
    });
  } catch (err) {
    console.error("[service-report] PDF generation failed", err instanceof Error ? err.name : "unknown");
    return res.status(500).json({ error: "The signed PDF could not be created. Nothing was saved - please try again.", code: "PDF_GENERATION_FAILED" });
  }

  // 1. store the files, 2. claim the report in ONE conditional update, 3. on any failure remove the files again.
  let signatureRef: string | undefined;
  let pdfRef: string | undefined;
  let pdfSha256: string;
  try {
    const sig = await storage.put(signature.bytes, "image/png");
    signatureRef = sig.ref;
    const stored = await storage.put(pdf, "application/pdf");
    pdfRef = stored.ref;
    pdfSha256 = stored.sha256;
  } catch (err) {
    console.error("[service-report] storing the signed files failed", err instanceof Error ? err.name : "unknown");
    await discard(storage, [signatureRef, pdfRef]);
    return res.status(502).json({ error: "The signed report could not be stored. Nothing was saved - please try again.", code: "STORAGE_FAILED" });
  }

  let claimedCount: number;
  try {
    const claimed = await prisma.serviceReport.updateMany({
      where: { id: report.id, status: SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, version: report.version },
      data: {
        status: SERVICE_REPORT_STATUS.SIGNED,
        signedAt,
        signedVersion: report.version,
        signerName: parsed.data.signerName,
        signedById: req.auth!.userId,
        signatureFileId: signatureRef,
        pdfFileId: pdfRef,
        pdfSha256,
      },
    });
    claimedCount = claimed.count;
  } catch (err) {
    await discard(storage, [signatureRef, pdfRef]);
    throw err;
  }
  if (claimedCount !== 1) {
    // Someone else signed (or staff reopened) in the meantime: our files are surplus.
    await discard(storage, [signatureRef, pdfRef]);
    return res.status(409).json({ error: "This report was just signed or changed. Please reload it.", code: "ALREADY_SIGNED" });
  }

  const fresh = await prisma.serviceReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude });
  await event(req, fresh, COMPLAINT_EVENT.SERVICE_REPORT_SIGNED, SERVICE_REPORT_STATUS.SIGNED, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE, { finalPdfGenerated: true, pdfSha256, signerName: parsed.data.signerName });
  res.json(toApi(fresh));
});

// ---------------------------------------------------------------------------
// Download / view the final files
// ---------------------------------------------------------------------------

async function sendStoredFile(req: AuthenticatedRequest, res: Response, kind: "pdf" | "signature") {
  const found = await loadWithAccess(req, res, asString(req.params.id));
  if (!found) return;
  const { report } = found;
  const ref = kind === "pdf" ? report.pdfFileId : report.signatureFileId;
  const ready = kind === "pdf" ? isFinal(report.status) : report.status === SERVICE_REPORT_STATUS.SIGNED;
  if (!ready || !ref) return res.status(409).json({ error: kind === "pdf" ? "This report has not been finalised yet." : "This report has not been signed.", code: "NOT_SIGNED" });

  const storage = getReportStorage();
  if (!storage) return res.status(503).json({ error: "Signed-report storage is not configured. Please contact Platino service.", code: "STORAGE_NOT_CONFIGURED" });

  let file: Awaited<ReturnType<ReportStorage["get"]>>;
  try {
    file = await storage.get(ref);
  } catch (err) {
    console.error("[service-report] reading a stored file failed", err instanceof Error ? err.name : "unknown");
    return res.status(502).json({ error: "The signed report could not be read right now. Please try again.", code: "STORAGE_FAILED" });
  }
  if (!file) return res.status(404).json({ error: "The signed file is missing. Please contact Platino service.", code: "FILE_MISSING" });
  if (kind === "pdf" && (sha256Hex(file.bytes) !== report.pdfSha256 || file.sha256 !== report.pdfSha256)) {
    console.error("[service-report] stored PDF failed its integrity check", { reportId: report.id });
    return res.status(500).json({ error: "The stored report failed its integrity check. Please contact Platino service.", code: "FILE_INTEGRITY" });
  }

  const inline = asOptionalString(req.query.disposition) === "inline";
  const name = kind === "pdf" ? `service-report-${report.reportNumber}.pdf` : `signature-${report.reportNumber}.png`;
  res.setHeader("Content-Type", kind === "pdf" ? "application/pdf" : "image/png");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.setHeader("Content-Length", String(file.bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(file.bytes);
}

serviceReportsRouter.get("/:id/pdf", (req: AuthenticatedRequest, res) => sendStoredFile(req, res, "pdf"));
serviceReportsRouter.get("/:id/signature", (req: AuthenticatedRequest, res) => sendStoredFile(req, res, "signature"));
