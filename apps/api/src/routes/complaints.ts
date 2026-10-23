import { Router } from "express";
import { createComplaintSchema, updateComplaintStatusSchema, PERMISSION_KEY, COMPLAINT_STATUS, COMPLAINT_EVENT, ROLE_KEY } from "@recd/shared";

/** Statuses that count as "resolved" for the one-open-complaint-per-RECD-serial-number rule. */
const CLOSED_COMPLAINT_STATUSES: string[] = [COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.CLOSED];
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";
import { asString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { logComplaintEvent } from "../lib/ticketEvents";
import { notifyMany, ticketRecipients } from "../lib/ticketNotify";

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

    const complaints = await prisma.complaint.findMany({
      where,
      include: {
        site: { include: { order: { include: { customer: true } } } },
        assignedTo: { select: { id: true, name: true } },
        unit: { select: { id: true, serialNo: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(complaints);
  },
);

/** Company-wide count-by-status - Owner/Admin and Management only (see project notes). */
complaintsRouter.get("/overview", requirePermission(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW), async (_req, res) => {
  const grouped = await prisma.complaint.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = Object.fromEntries(Object.values(COMPLAINT_STATUS).map((s) => [s, 0]));
  for (const row of grouped) counts[row.status] = row._count._all;
  res.json({ countsByStatus: counts });
});

/** Field engineers a manager can assign a complaint to. */
complaintsRouter.get("/assignees", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (_req, res) => {
  const engineers = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { key: { in: [ROLE_KEY.ERECTION_ENGINEER, ROLE_KEY.COMMISSIONING_ENGINEER, ROLE_KEY.SERVICE_TEAM, ROLE_KEY.SERVICE_ENGINEER] } },
    },
    select: { id: true, name: true, role: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  res.json(engineers);
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

  // Only one complaint may be open against a given RECD at a time. With a unitId that is the
  // specific unit; without one (older clients) it falls back to the whole site.
  let unitId: string | undefined;
  if (parsed.data.unitId) {
    const unit = await prisma.recdUnit.findUnique({ where: { id: parsed.data.unitId } });
    if (!unit || unit.siteId !== parsed.data.siteId) {
      return res.status(400).json({ error: "That RECD does not belong to this site" });
    }
    unitId = unit.id;
  }
  const openComplaint = await prisma.complaint.findFirst({
    where: unitId
      ? { unitId, status: { notIn: CLOSED_COMPLAINT_STATUSES } }
      : { siteId: parsed.data.siteId, status: { notIn: CLOSED_COMPLAINT_STATUSES } },
  });
  if (openComplaint) {
    return res.status(400).json({
      error: `An open complaint (${openComplaint.ticketNumber}) already exists for this RECD serial number. It must be closed before raising another.`,
    });
  }

  const ticketNumber = `TCK-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const complaint = await prisma.complaint.create({
    data: {
      ticketNumber,
      customerId: req.auth!.customerId,
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

  await logComplaintEvent({
    complaintId: complaint.id,
    type: COMPLAINT_EVENT.CREATED,
    toValue: complaint.status,
    actorId: req.auth!.userId,
    detail: { source: "portal" },
  });

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
    const existing = await prisma.complaint.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Complaint not found" });

    const canManage = req.auth!.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS);
    // Field engineers may only touch tickets assigned to them, and may never reassign.
    if (!canManage && existing.assignedToId !== req.auth!.userId) {
      return res.status(403).json({ error: "This complaint is not assigned to you" });
    }

    const data: Record<string, unknown> = {
      status: parsed.data.status,
      rootCause: parsed.data.rootCause,
      resolutionNotes: parsed.data.resolutionNotes,
      remarks: parsed.data.remarks,
      serviceReportUrl: parsed.data.serviceReportUrl,
      closedAt: parsed.data.status === COMPLAINT_STATUS.CLOSED ? new Date() : undefined,
    };
    if (canManage && parsed.data.assignedToId !== undefined) {
      data.assignedToId = parsed.data.assignedToId; // string to assign, null to unassign
    }

    const complaint = await prisma.complaint.update({
      where: { id },
      data,
      include: { customer: { include: { contacts: true } } },
    });

    if (parsed.data.status !== existing.status) {
      await logComplaintEvent({
        complaintId: id,
        type: COMPLAINT_EVENT.STATUS_CHANGED,
        fromValue: existing.status,
        toValue: parsed.data.status,
        actorId: req.auth!.userId,
      });
    }
    if (canManage && parsed.data.assignedToId !== undefined && parsed.data.assignedToId !== existing.assignedToId) {
      await logComplaintEvent({
        complaintId: id,
        type: COMPLAINT_EVENT.ASSIGNED,
        fromValue: existing.assignedToId,
        toValue: parsed.data.assignedToId,
        actorId: req.auth!.userId,
      });
    }

    // Notify the customer of the status change.
    const customerContact = complaint.customer.contacts[0];
    if (customerContact) {
      await notifySafely({
        recipientId: customerContact.id,
        templateKey: "complaint_status_updated",
        data: { ticketNumber: complaint.ticketNumber, status: complaint.status },
      });
    }
    // Notify a newly-assigned engineer that a ticket has landed on their plate.
    if (canManage && typeof data.assignedToId === "string" && data.assignedToId !== existing.assignedToId) {
      await notifySafely({
        recipientId: data.assignedToId,
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
    const ticket = await prisma.complaint.findUnique({ where: { id }, include: { site: { select: { regionId: true } } } });
    if (!ticket) return res.status(404).json({ error: "Complaint not found" });

    const { userId, roleKey, permissions } = req.auth!;
    const broad = permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
    if (roleKey === ROLE_KEY.REGIONAL_MANAGER) {
      const regions = await managedRegionIds(userId, roleKey);
      if (!ticket.site?.regionId || !regions.includes(ticket.site.regionId)) return res.status(403).json({ error: "Forbidden" });
    } else if (!broad && ticket.assignedToId !== userId) {
      return res.status(403).json({ error: "This complaint is not assigned to you" });
    }

    const events = await prisma.complaintEvent.findMany({
      where: { complaintId: id },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ slaEscalationLevel: ticket.slaEscalationLevel, events });
  },
);

/** Remove a spam / wrong-RECD-serial-number complaint entry. Manager-only, hard delete. */
complaintsRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.complaint.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Complaint not found" });

  await prisma.complaint.delete({ where: { id } });
  res.status(204).send();
});
