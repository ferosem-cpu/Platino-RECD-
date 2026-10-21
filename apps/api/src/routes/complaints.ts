import { Router } from "express";
import {
  createComplaintSchema,
  updateComplaintStatusSchema,
  PERMISSION_KEY,
  COMPLAINT_STATUS,
  COMPLAINT_EVENT,
  ROLE_KEY,
  resolveComplaintUnit,
  isComplaintStatus,
  TICKET_CLOSED_STATUSES,
  TICKET_LIST_LIMIT_DEFAULT,
  TICKET_LIST_LIMIT_MAX,
} from "@recd/shared";
import type { Prisma } from "@prisma/client";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Statuses that count as "resolved" for the one-open-complaint-per-RECD-serial-number rule (matches the partial unique index). */
const CLOSED_COMPLAINT_STATUSES: string[] = [...TICKET_CLOSED_STATUSES];
import { prisma } from "../lib/prisma";
import { isTicketNumberConflict } from "../lib/uniqueViolations";
import { findBlockingActiveTicket, isActiveTicketConflict } from "../lib/ticketDuplicates";
import { buildTicketContactInfo, contactAudience } from "../lib/ticketContacts";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";
import { asOptionalString, asString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { logComplaintEventStrict } from "../lib/ticketEvents";
import { notifyMany, ticketRecipients } from "../lib/ticketNotify";
import { ticketAccessError } from "../lib/ticketAccess";
import { CUSTOMER_REF_SELECT, SITE_ORDER_SELECT } from "../lib/safeSelect";
import { TicketError, archiveTicket, restoreTicket, listAssignees, updateTicket } from "../lib/ticketAdmin";

/** How many times a freshly generated ticket number is tried before giving up (matches the public flow). */
const MAX_TICKET_NUMBER_ATTEMPTS = 3;

export const complaintsRouter = Router();
complaintsRouter.use(authenticate);

/** Best-effort notify: a provider failure must never roll back an already-committed write. */
async function notifySafely(args: Parameters<typeof sendNotification>[0]) {
  try {
    await sendNotification(args);
  } catch (err) {
    console.error("Notification failed", err);
  }
}

const authOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, roleKey: req.auth!.roleKey, vendorId: req.auth!.vendorId, permissions: req.auth!.permissions });

/** Maps a ticket refusal (400 / 403 / 404 / 409) to its HTTP answer; anything else is a real failure. */
function sendTicketError(res: import("express").Response, err: unknown) {
  if (err instanceof TicketError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
}

/**
 * Optional filters of the ticket list (all optional - without them the answer is exactly what it always was). They are applied AFTER the
 * role / region / vendor scope, so a filter can only narrow what the caller may already see. Unknown or malformed values are ignored.
 */
function listFilters(query: Record<string, any>): Prisma.ComplaintWhereInput[] {
  const out: Prisma.ComplaintWhereInput[] = [];
  const search = asOptionalString(query.search)?.trim().slice(0, 80);
  if (search) {
    out.push({
      OR: [
        { ticketNumber: { contains: search, mode: "insensitive" } },
        { unit: { serialNo: { contains: search, mode: "insensitive" } } },
        { customer: { name: { contains: search, mode: "insensitive" } } },
        { site: { companyName: { contains: search, mode: "insensitive" } } },
      ],
    });
  }
  const status = asOptionalString(query.status);
  if (status) {
    const wanted = status.split(",").map((s) => s.trim()).filter(isComplaintStatus);
    if (wanted.length) out.push({ status: { in: wanted } });
  }
  const assignedToId = asOptionalString(query.assignedToId);
  if (assignedToId) out.push({ assignedToId });
  const date = (v: any): Date | null => {
    const s = asOptionalString(v);
    if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const createdFrom = date(query.createdFrom);
  const createdTo = date(query.createdTo);
  if (createdFrom || createdTo) out.push({ createdAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) } });
  const dueFrom = date(query.dueFrom);
  const dueTo = date(query.dueTo);
  if (dueFrom || dueTo) out.push({ dueDate: { ...(dueFrom ? { gte: dueFrom } : {}), ...(dueTo ? { lte: dueTo } : {}) } });
  return out;
}

complaintsRouter.get(
  "/",
  requirePermission(
    PERMISSION_KEY.RAISE_COMPLAINT,
    PERMISSION_KEY.MANAGE_COMPLAINTS,
    PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW,
    PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS,
  ),
  async (req: AuthenticatedRequest, res) => {
    const { customerId, userId, permissions } = req.auth!;

    // Scope the list to what the caller is allowed to see:
    // - customers see only their own tickets;
    // - managers / service team / overview-viewers see everything;
    // - field engineers see only tickets assigned to them.
    let where: Record<string, unknown> = {};
    if (customerId) {
      where = { customerId };
    } else if (
      !permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) &&
      !permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW)
    ) {
      where = { assignedToId: userId };
    }
    // A Regional Manager only sees tickets for sites in the regions mapped to them.
    if (!customerId && req.auth!.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
      where = { site: { regionId: { in: await managedRegionIds(userId, req.auth!.roleKey) } } };
    }
    // A vendor-scoped user only sees tickets on their vendor's sites (same rule as the unit and site lists).
    if (!customerId && req.auth!.vendorId) {
      where = { AND: [where, { site: { vendorId: req.auth!.vendorId } }] };
    }
    // Filters narrow the scoped set; they never widen it.
    const filters = listFilters(req.query);
    // Archived tickets are out of every working view. Staff who manage / oversee tickets can ask for them with ?includeArchived=1 (never a customer).
    const wantsArchived = !customerId && asOptionalString(req.query.includeArchived) === "1" && (permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW));
    const live = wantsArchived ? [] : [{ archivedAt: null }];
    const scoped = filters.length ? { AND: [where, ...live, ...filters] } : wantsArchived ? where : { ...where, archivedAt: null };

    const limitParam = Number.parseInt(asOptionalString(req.query.limit) ?? "", 10);
    const offsetParam = Number.parseInt(asOptionalString(req.query.offset) ?? "", 10);
    const paged = Number.isInteger(limitParam) && limitParam > 0;
    const take = paged ? Math.min(limitParam, TICKET_LIST_LIMIT_MAX) : TICKET_LIST_LIMIT_DEFAULT;
    const skip = Number.isInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;
    if (paged) res.setHeader("X-Total-Count", String(await prisma.complaint.count({ where: scoped })));

    // Contact numbers are loaded - through each ticket's OWN site and customer, never through an id the
    // client sends - only for roles that need them to do the job (see lib/ticketContacts.ts).
    const audience = contactAudience(req.auth!);
    const complaints = await prisma.complaint.findMany({
      where: scoped,
      include: {
        site: {
          include: {
            order: { select: { ...SITE_ORDER_SELECT, customer: { select: CUSTOMER_REF_SELECT } } },
            ...(audience !== "none" ? { contacts: { select: { id: true, name: true, role: true, phone: true }, orderBy: { createdAt: "asc" as const } } } : {}),
          },
        },
        assignedTo: { select: { id: true, name: true } },
        unit: { select: { id: true, serialNo: true } },
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    // The registered customer's primary contact = its oldest contact (same rule as PUT /customers/:id).
    const primaryContact = new Map<string, { name: string; phone: string | null }>();
    if (audience === "desk" && complaints.length) {
      const contacts = await prisma.user.findMany({
        where: { customerId: { in: [...new Set(complaints.map((c) => c.customerId))] } },
        select: { customerId: true, name: true, phone: true },
        orderBy: { createdAt: "asc" },
      });
      for (const u of contacts) if (u.customerId && !primaryContact.has(u.customerId)) primaryContact.set(u.customerId, { name: u.name, phone: u.phone });
    }

    res.json(
      complaints.map((c) => {
        const { reporterPhone, site, ...rest } = c as typeof c & { site: any };
        // A customer is never shown the phone number of a third party (a reseller) who raised a ticket on their unit.
        if (audience === "none") return { ...rest, site };
        const { contacts: siteContacts, ...siteWithoutContacts } = site ?? {};
        return {
          ...rest,
          reporterPhone,
          site: site ? siteWithoutContacts : site,
          contactInfo: buildTicketContactInfo(
            { ticket: c, site: site ? { sitePocName: site.sitePocName, sitePocNumber: site.sitePocNumber, contacts: siteContacts ?? [] } : null, customerContact: primaryContact.get(c.customerId) ?? null },
            audience,
          ),
        };
      }),
    );
  },
);

/** Count-by-status: company-wide for Owner/Admin and Management; a Regional Manager only gets their own regions (see the handler). */
complaintsRouter.get("/overview", requirePermission(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW), async (req: AuthenticatedRequest, res) => {
  // A Regional Manager's counts cover their own regions only (same scope as the list); everyone else sees the company-wide counts.
  const regionScope = req.auth!.roleKey === ROLE_KEY.REGIONAL_MANAGER ? { site: { regionId: { in: await managedRegionIds(req.auth!.userId, req.auth!.roleKey) } } } : {};
  const grouped = await prisma.complaint.groupBy({ by: ["status"], where: { archivedAt: null, ...regionScope }, _count: { _all: true } });
  const counts: Record<string, number> = Object.fromEntries(Object.values(COMPLAINT_STATUS).map((s) => [s, 0]));
  for (const row of grouped) counts[row.status] = row._count._all;
  res.json({ countsByStatus: counts });
});

/**
 * Field engineers a manager can assign a complaint to. Pass `?ticketId=` to get the people valid for THAT ticket (vendor-scoped engineers only
 * for their own vendor's sites); without it only unscoped (internal) engineers are listed.
 */
complaintsRouter.get("/assignees", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  try {
    res.json(await listAssignees(authOf(req), asOptionalString(req.query.ticketId)));
  } catch (err) {
    return sendTicketError(res, err);
  }
});

complaintsRouter.post("/", requirePermission(PERMISSION_KEY.RAISE_COMPLAINT), async (req: AuthenticatedRequest, res) => {
  const parsed = createComplaintSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.auth!.customerId) return res.status(403).json({ error: "Only customers can raise complaints" });

  // Object-level authorization: a customer may only raise complaints against their own sites.
  // Without this a customer could pass any siteId and attach a ticket to another customer's site
  // (and leak that customer's details back through their own complaint list).
  const targetSite = await prisma.site.findUnique({
    where: { id: parsed.data.siteId },
    include: { order: true },
  });
  if (!targetSite) return res.status(404).json({ error: "Site not found" });
  if (targetSite.order.customerId !== req.auth!.customerId) {
    return res.status(403).json({ error: "You can only raise complaints for your own sites" });
  }

  // The complaint must name a RECD of THIS site: the site was just checked against the caller's
  // customer, so resolving the unit among the site's own units rules out units of other
  // customers or sites. With several units the caller has to say which one (shared rule, also
  // used by the portal and mobile app); one open complaint per RECD is enforced below.
  const siteUnits = await prisma.recdUnit.findMany({
    where: { siteId: parsed.data.siteId },
    select: { id: true, status: true, serialNo: true },
  });
  const resolved = resolveComplaintUnit(siteUnits, parsed.data.unitId);
  if ("error" in resolved) return res.status(400).json({ error: resolved.error });
  const unitId = resolved.unitId;
  const serialNo = siteUnits.find((u) => u.id === unitId)?.serialNo ?? null;
  // The SAME duplicate definition the database indexes enforce (lib/ticketDuplicates.ts): per unit, or - for a ticket with no unit - per site
  // among tickets that also have no unit. The indexes stay the guarantee under simultaneous requests.
  const openComplaint = await findBlockingActiveTicket(prisma, { unitId: unitId ?? null, siteId: parsed.data.siteId });
  if (openComplaint) {
    return res.status(400).json({
      error: `An open complaint (${openComplaint.ticketNumber}) already exists for this RECD serial number. It must be closed before raising another.`,
    });
  }

  // Ticket numbers are random (TCK-<year>-<5 digits>) and unique. On the rare collision a new number
  // is generated and the insert retried, exactly like the public complaint flow does. ONLY a
  // ticket-number collision is retried: the open-ticket index and every other error are not.
  // Each attempt is ONE transaction: the ticket and its CREATED history row (which records the serial and site as reported) commit together.
  let ticketNumber = "";
  let complaint;
  for (let attempt = 0; attempt < MAX_TICKET_NUMBER_ATTEMPTS && !complaint; attempt++) {
    ticketNumber = `TCK-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
    try {
      complaint = await prisma.$transaction(async (tx) => {
        const created = await tx.complaint.create({
          data: {
            ticketNumber,
            customerId: req.auth!.customerId!,
            siteId: parsed.data.siteId,
            unitId,
            category: parsed.data.category,
            issueCategory: parsed.data.issueCategory,
            description: parsed.data.description,
            severity: parsed.data.severity,
            attachmentUrl: parsed.data.attachmentUrl,
            status: COMPLAINT_STATUS.OPEN,
          },
        });
        await logComplaintEventStrict(tx, {
          complaintId: created.id,
          type: COMPLAINT_EVENT.CREATED,
          toValue: created.status,
          actorId: req.auth!.userId,
          // What was reported, as it was at the time (the ticket's links are cleared if the unit or site is later deleted).
          detail: { source: "portal", serialNo, siteName: targetSite.companyName ?? null, siteId: targetSite.id, unitId: unitId ?? null },
        });
        return created;
      });
    } catch (err) {
      // Two requests raced past the open-ticket check; the partial unique index (one open ticket
      // per RECD) caught the second one.
      if (isActiveTicketConflict(err)) {
        return res.status(400).json({ error: "An open complaint already exists for this RECD serial number. It must be closed before raising another." });
      }
      if (!isTicketNumberConflict(err)) throw err; // unrelated failures are never hidden
    }
  }
  if (!complaint) {
    return res.status(409).json({
      error: "We could not allocate a ticket number just now. Nothing was saved - please submit the complaint again.",
      code: "TICKET_NUMBER_CONFLICT",
    });
  }

  // Service desk, Service Managers, Management and the site region's Regional Managers.
  try {
    const recipients = await ticketRecipients("raised", { regionId: targetSite.regionId });
    await notifyMany(recipients, "complaint_raised", { ticketNumber });
  } catch (err) {
    console.error("Complaint notification failed", err);
  }

  res.status(201).json(complaint);
});

complaintsRouter.patch(
  "/:id",
  requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = updateComplaintStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const id = asString(req.params.id);

    let result;
    try {
      result = await updateTicket(authOf(req), id, parsed.data);
    } catch (err) {
      return sendTicketError(res, err);
    }

    const complaint = await prisma.complaint.findUnique({ where: { id }, include: { customer: { include: { contacts: true } } } });
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    // Notifications go out AFTER the commit and only for a change that really happened (a no-op update notifies nobody).
    if (result.statusChanged) {
      // Deterministic recipient: the customer's oldest ACTIVE contact (the same "primary contact" rule the list uses).
      const customerContact = await prisma.user.findFirst({ where: { customerId: complaint.customerId, isActive: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
      if (customerContact) {
        await notifySafely({
          recipientId: customerContact.id,
          templateKey: "complaint_status_updated",
          data: { ticketNumber: complaint.ticketNumber, status: complaint.status },
        });
      }
    }
    if (result.assignedChanged?.to) {
      await notifySafely({
        recipientId: result.assignedChanged.to,
        templateKey: "complaint_assigned",
        data: { ticketNumber: complaint.ticketNumber },
      });
    }

    res.json(complaint);
  },
);

/** Ticket history (created, status changes, assignment, escalations), oldest first. */
complaintsRouter.get(
  "/:id/history",
  requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS, PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW),
  async (req: AuthenticatedRequest, res) => {
    const id = asString(req.params.id);
    const ticket = await prisma.complaint.findUnique({ where: { id }, include: { site: { select: { regionId: true, vendorId: true } } } });
    if (!ticket) return res.status(404).json({ error: "Complaint not found" });

    // Same rule as every ticket write: regional / vendor / assigned-to-me scope (lib/ticketAccess.ts).
    const denied = await ticketAccessError(authOf(req), ticket);
    if (denied) return res.status(403).json({ error: denied });

    const events = await prisma.complaintEvent.findMany({
      where: { complaintId: id },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ slaEscalationLevel: ticket.slaEscalationLevel, events });
  },
);

/**
 * "Delete" a spam / wrong-RECD-serial-number complaint entry = ARCHIVE it (manager-only, scoped like every other write - a Regional Manager
 * only in their regions). Nothing is destroyed: the ticket, its history, reminder and escalation records stay; it only leaves the working
 * views. An optional { reason } in the body is recorded in the ticket history. 204 as before.
 */
complaintsRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  try {
    await archiveTicket(authOf(req), asString(req.params.id), reason);
  } catch (err) {
    return sendTicketError(res, err);
  }
  res.status(204).send();
});

/**
 * Restore an archived ticket to the working views (manager-only, same scope rules; see lib/ticketAdmin.ts restoreTicket). Optional { reason }.
 * 204 on success; 409 when it is not archived or would duplicate an active ticket. There is no purge route.
 */
complaintsRouter.post("/:id/restore", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  try {
    await restoreTicket(authOf(req), asString(req.params.id), reason);
  } catch (err) {
    return sendTicketError(res, err);
  }
  res.status(204).send();
});
