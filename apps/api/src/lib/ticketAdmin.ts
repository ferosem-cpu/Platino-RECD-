/**
 * Ticket changes (Requirement 11): update (status / notes / assignment), delete, and the assignee list. The routes are thin; the rules are here:
 *  1. authorisation per ticket (lib/ticketAccess.ts) for every write - regional, vendor and "assigned to me" scope;
 *  2. a proposed assignee is validated (exists, active, a suitable role, inside the ticket's vendor scope) and answered with 400 / 403 instead
 *     of a foreign-key 500;
 *  3. the status is one of the existing nine (shared/ticketPolicy.ts) - already enforced by the request schema;
 *  4. the ticket change and its history rows are ONE transaction, with a conditional update so two simultaneous requests cannot both apply
 *     the same change (the loser gets 409); a failed history write rolls the change back;
 *  5. `closedAt` is set on the first move INTO closed, never overwritten by a repeated closure, and cleared when the ticket leaves closed;
 *  6. a no-op (nothing changes) writes nothing, records nothing and notifies nobody;
 *  7. closure records WHO closed (closedById, with closedAt; both cleared on reopening - the history keeps every closure), and a changed
 *     root cause / resolution notes / remarks is recorded with its BEFORE and AFTER text, so closure details are never silently overwritten;
 *  8. an ARCHIVED ticket cannot be changed (409 TICKET_ARCHIVED);
 *  9. final closure is for managers: moving a ticket INTO closed needs manage_complaints (403 CLOSE_REQUIRES_MANAGER) - an engineer resolves;
 * 10. so is reopening: moving a ticket OUT of closed needs manage_complaints (403 REOPEN_REQUIRES_MANAGER). The scope rules (region / vendor /
 *     assigned) are checked first and still apply to managers; a refused attempt writes nothing and records nothing.
 * Notifications are sent by the caller AFTER the commit, never inside the transaction.
 */
import {
  COMPLAINT_EVENT,
  PERMISSION_KEY,
  TICKET_ASSIGNEE_ROLES,
  CLOSE_REQUIRES_MANAGER,
  REOPEN_REQUIRES_MANAGER,
  TICKET_CLOSED_STATUSES,
  TICKET_CLOSE_PERMISSION,
  TICKET_REOPEN_PERMISSION,
  classifyStatusChange,
  closedAtFor,
  isStatusTransitionAllowed,
  isMeaningfulResolutionNotes,
  isValidReopenReason,
  RESOLUTION_NOTES_REQUIRED,
  REOPEN_REASON_REQUIRED,
  CLOSED_TICKET_READ_ONLY,
  COMPLAINT_STATUS,
} from "@recd/shared";
import { prisma } from "./prisma";
import { logComplaintEventStrict } from "./ticketEvents";
import { findBlockingActiveTicket, isActiveTicketConflict } from "./ticketDuplicates";
import { ticketAccessError, type TicketAuth } from "./ticketAccess";

export class TicketError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code?: string) {
    super(message);
    this.name = "TicketError";
  }
}

const NOTE_FIELDS = ["rootCause", "resolutionNotes", "remarks", "serviceReportUrl"] as const;
/** Text fields whose before / after VALUES are kept in the history. serviceReportUrl is an uploaded file (data URL): only its name is recorded. */
const NOTE_TEXT_FIELDS = ["rootCause", "resolutionNotes", "remarks"] as const;

export interface UpdateTicketInput {
  status: string;
  rootCause?: string;
  resolutionNotes?: string;
  remarks?: string;
  serviceReportUrl?: string;
  /** Required when a CLOSED ticket is reopened. */
  reopenReason?: string;
  assignedToId?: string | null;
}

export interface UpdateTicketResult {
  /** false = nothing changed (no write, no event, no notification) */
  changed: boolean;
  statusChanged: { from: string; to: string } | null;
  /** set only when the assignee actually changed (null = unassigned) */
  assignedChanged: { from: string | null; to: string | null } | null;
  ticketId: string;
}

/** Validates a proposed assignee for a ticket. `site` is the ticket's own site (never an id the client sent). */
export async function validateAssignee(
  actor: TicketAuth,
  assigneeId: string,
  site: { vendorId: string | null } | null,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true, isActive: true, vendorId: true, role: { select: { key: true } } } });
  if (!user) throw new TicketError(400, "The person you are assigning this ticket to does not exist", "ASSIGNEE_NOT_FOUND");
  if (!user.isActive) throw new TicketError(400, "The person you are assigning this ticket to is deactivated", "ASSIGNEE_INACTIVE");
  if (!TICKET_ASSIGNEE_ROLES.includes(user.role.key)) throw new TicketError(400, "That person's role cannot be assigned tickets", "ASSIGNEE_ROLE");
  // A vendor-scoped engineer works only on their own vendor's sites.
  if (user.vendorId && user.vendorId !== (site?.vendorId ?? null)) {
    throw new TicketError(400, "That engineer belongs to a different vendor than this ticket's site", "ASSIGNEE_VENDOR_SCOPE");
  }
  // A vendor-scoped caller can only hand a ticket to their own vendor's people.
  if (actor.vendorId && user.vendorId !== actor.vendorId) {
    throw new TicketError(403, "You can only assign tickets to your own vendor's engineers", "ASSIGNEE_OUT_OF_SCOPE");
  }
}

export async function updateTicket(actor: TicketAuth, id: string, input: UpdateTicketInput): Promise<UpdateTicketResult> {
  const canManage = actor.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS);
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.complaint.findUnique({ where: { id }, include: { site: { select: { regionId: true, vendorId: true } } } });
      if (!existing) throw new TicketError(404, "Complaint not found");
      const denied = await ticketAccessError(actor, existing);
      if (denied) throw new TicketError(403, denied);
      if (existing.archivedAt) throw new TicketError(409, "This ticket is archived and can no longer be changed.", "TICKET_ARCHIVED");

      // ---- status
      const kind = classifyStatusChange(existing.status, input.status);
      if (kind === "reopened" && !actor.permissions.has(TICKET_REOPEN_PERMISSION)) throw new TicketError(403, REOPEN_REQUIRES_MANAGER, "REOPEN_REQUIRES_MANAGER");
      if (kind === "closed" && !actor.permissions.has(TICKET_CLOSE_PERMISSION)) throw new TicketError(403, CLOSE_REQUIRES_MANAGER, "CLOSE_REQUIRES_MANAGER");
      // A closed ticket is read-only for non-managers (they may not reopen it - above - and may not add notes or change anything else).
      if (existing.status === COMPLAINT_STATUS.CLOSED && kind === "unchanged" && !canManage) throw new TicketError(403, CLOSED_TICKET_READ_ONLY, "CLOSED_TICKET_READ_ONLY");
      if (kind !== "unchanged" && !isStatusTransitionAllowed(existing.status, input.status)) {
        throw new TicketError(409, `A ticket cannot move from ${existing.status} to ${input.status}`, "TRANSITION_NOT_ALLOWED");
      }
      // Reopening a CLOSED ticket needs a reason (checked after the permission and transition rules; a refusal changes nothing).
      if (kind === "reopened" && !isValidReopenReason(input.reopenReason)) throw new TicketError(400, REOPEN_REASON_REQUIRED, "REOPEN_REASON_REQUIRED");
      // Resolution notes: required to ENTER resolved (the notes sent now, else those already on the ticket); once resolved / closed they can
      // be corrected but never blanked or replaced by something that is not meaningful.
      const effectiveNotes = input.resolutionNotes !== undefined ? input.resolutionNotes : existing.resolutionNotes;
      const resultingStatus = kind === "unchanged" ? existing.status : input.status;
      if (input.status === COMPLAINT_STATUS.RESOLVED && kind !== "unchanged" && !isMeaningfulResolutionNotes(effectiveNotes)) {
        throw new TicketError(400, RESOLUTION_NOTES_REQUIRED, "RESOLUTION_NOTES_REQUIRED");
      }
      if (input.resolutionNotes !== undefined && input.resolutionNotes !== existing.resolutionNotes && TICKET_CLOSED_STATUSES.includes(resultingStatus) && !isMeaningfulResolutionNotes(input.resolutionNotes)) {
        throw new TicketError(400, RESOLUTION_NOTES_REQUIRED, "RESOLUTION_NOTES_REQUIRED");
      }
      // Becoming ACTIVE again (resolved / closed -> an active status): the same duplicate definition as creation applies (lib/ticketDuplicates.ts).
      // The indexes below remain the guarantee under simultaneous requests.
      if (kind !== "unchanged" && TICKET_CLOSED_STATUSES.includes(existing.status) && !TICKET_CLOSED_STATUSES.includes(input.status)) {
        const blocking = await findBlockingActiveTicket(tx, existing, id);
        if (blocking) throw new TicketError(409, `Another ticket (${blocking.ticketNumber}) is already open for this RECD, so this one cannot be reopened. Close that ticket first.`, "OPEN_TICKET_EXISTS");
      }
      const data: Record<string, unknown> = {};
      if (kind !== "unchanged") data.status = input.status;
      const closedAt = closedAtFor(kind, existing.closedAt, new Date());
      if (closedAt !== undefined) data.closedAt = closedAt;
      // Who closed it: set together with closedAt (a repeated closure keeps the original closer), cleared when the ticket leaves closed.
      if (kind === "closed") data.closedById = existing.closedAt ? existing.closedById : actor.userId;
      if (kind === "reopened") data.closedById = null;

      // ---- assignment (complaint managers only; engineers can never reassign)
      let assignedChanged: UpdateTicketResult["assignedChanged"] = null;
      if (canManage && input.assignedToId !== undefined && input.assignedToId !== existing.assignedToId) {
        if (input.assignedToId !== null) await validateAssignee(actor, input.assignedToId, existing.site);
        data.assignedToId = input.assignedToId;
        assignedChanged = { from: existing.assignedToId, to: input.assignedToId };
      }

      // ---- notes (only the fields that were sent AND differ)
      const changedNotes = NOTE_FIELDS.filter((f) => input[f] !== undefined && input[f] !== existing[f]);
      for (const f of changedNotes) data[f] = input[f];

      if (Object.keys(data).length === 0) {
        return { changed: false, statusChanged: null, assignedChanged: null, ticketId: id };
      }

      // Conditional update: only if the ticket still has the status / assignee we read. A simultaneous request that got there first makes this one a 409.
      const claimed = await tx.complaint.updateMany({ where: { id, status: existing.status, assignedToId: existing.assignedToId, archivedAt: null }, data });
      if (claimed.count !== 1) throw new TicketError(409, "This ticket was changed by someone else just now. Reload it and try again.", "TICKET_CHANGED");

      // ---- history (mandatory, same transaction)
      if (kind !== "unchanged") {
        await logComplaintEventStrict(tx, {
          complaintId: id,
          type: COMPLAINT_EVENT.STATUS_CHANGED,
          fromValue: existing.status,
          toValue: input.status,
          actorId: actor.userId,
          ...(kind === "closed" ? { detail: { transition: "closed" } } : kind === "reopened" ? { detail: { transition: "reopened", closedAtCleared: true, reason: input.reopenReason!.trim() } } : {}),
        });
      }
      if (assignedChanged) {
        await logComplaintEventStrict(tx, { complaintId: id, type: COMPLAINT_EVENT.ASSIGNED, fromValue: assignedChanged.from, toValue: assignedChanged.to, actorId: actor.userId });
      }
      if (changedNotes.length) {
        // The event names WHICH fields changed and keeps the BEFORE / AFTER text of the closure fields (root cause, resolution notes, remarks), so an
        // overwritten closure detail stays in the history. Only people who may read this ticket can read its history. The uploaded report is a file: name only.
        const values: Record<string, { from: string | null; to: string | null }> = {};
        for (const f of changedNotes) if ((NOTE_TEXT_FIELDS as readonly string[]).includes(f)) values[f] = { from: (existing[f] as string | null) ?? null, to: (input[f] as string | undefined) ?? null };
        await logComplaintEventStrict(tx, { complaintId: id, type: COMPLAINT_EVENT.NOTES_UPDATED, actorId: actor.userId, detail: { fields: [...changedNotes], ...(Object.keys(values).length ? { values } : {}) } });
      }
      return {
        changed: true,
        statusChanged: kind !== "unchanged" ? { from: existing.status, to: input.status } : null,
        assignedChanged,
        ticketId: id,
      };
    });
  } catch (err) {
    // Reopening a resolved / closed ticket while another ACTIVE ticket exists for the same RECD (or, for a unit-less ticket, the same site):
    // the partial unique indexes (see lib/ticketDuplicates.ts).
    if (isActiveTicketConflict(err)) {
      const t = await prisma.complaint.findUnique({ where: { id }, select: { unitId: true, siteId: true } });
      const open = t ? await findBlockingActiveTicket(prisma, t, id) : null;
      throw new TicketError(409, `Another ticket${open ? ` (${open.ticketNumber})` : ""} is already open for this RECD, so this one cannot be reopened. Close that ticket first.`, "OPEN_TICKET_EXISTS");
    }
    throw err;
  }
}

/**
 * "Delete" now ARCHIVES (Requirement 11: complete ticket history). The ticket, its history (ComplaintEvent), its reminder and its escalation
 * records are all kept; the ticket only leaves the working views (lists, SLA escalation, reminders, the one-open-ticket-per-unit rule). The
 * archive is recorded in the ticket history (who, when, optional reason, the status it was in). Scoped like every other write. A ticket
 * with service reports cannot be archived (unchanged rule: submitted / signed reports belong to a live ticket). There is deliberately NO purge
 * and no restore here - what a purge or an undo would mean is a business decision (see docs/HANDOVER.md).
 */
export async function archiveTicket(actor: TicketAuth, id: string, reason?: string | null): Promise<void> {
  const cleanReason = reason?.trim() ? reason.trim().slice(0, 500) : null;
  await prisma.$transaction(async (tx) => {
    const existing = await tx.complaint.findUnique({ where: { id }, include: { site: { select: { regionId: true, vendorId: true } } } });
    if (!existing) throw new TicketError(404, "Complaint not found");
    const denied = await ticketAccessError(actor, existing);
    if (denied) throw new TicketError(403, denied);
    if (existing.archivedAt) throw new TicketError(409, "This ticket is already archived.", "TICKET_ARCHIVED");
    if ((await tx.serviceReport.count({ where: { complaintId: id } })) > 0) {
      throw new TicketError(409, "This ticket has service reports and cannot be archived.", "HAS_SERVICE_REPORTS");
    }
    const claimed = await tx.complaint.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), archivedById: actor.userId, archiveReason: cleanReason } });
    if (claimed.count !== 1) throw new TicketError(409, "This ticket was changed by someone else just now. Reload it and try again.", "TICKET_CHANGED");
    await logComplaintEventStrict(tx, {
      complaintId: id,
      type: COMPLAINT_EVENT.ARCHIVED,
      fromValue: existing.status,
      actorId: actor.userId,
      detail: { statusAtArchive: existing.status, ...(cleanReason ? { reason: cleanReason } : {}) },
    });
  });
}

/**
 * RESTORE an archived ticket (manager-only: manage_complaints, scoped like every other write). The ticket comes back in the status it had when it
 * was archived, with its history intact; the archive event stays and a `restored` event (who, when, optional reason) is added. Before it returns
 * to the working views everything is re-checked as of NOW:
 *  - authorisation (region / vendor scope) against the ticket's current site;
 *  - its links: a site that still exists must still belong to the ticket's customer's order, and a unit that still exists must still be a unit
 *    of that site and of that customer (a link that was cleared because the site / unit was deleted is not re-invented);
 *  - the duplicate rule: if the restored ticket would be ACTIVE (not resolved / closed) while another active ticket exists for the same RECD
 *    (or, unit-less, the same site) the restore is refused with 409 OPEN_TICKET_EXISTS naming that ticket - never a silent duplicate. The
 *    partial unique indexes catch a simultaneous race.
 * Restoring does not touch the SLA fields: the escalation clock still runs from the ticket's creation, so a long-archived active ticket may
 * escalate at the next run. There is deliberately NO purge (see docs/HANDOVER.md).
 */
export async function restoreTicket(actor: TicketAuth, id: string, reason?: string | null): Promise<void> {
  const cleanReason = reason?.trim() ? reason.trim().slice(0, 500) : null;
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.complaint.findUnique({
        where: { id },
        include: { site: { select: { regionId: true, vendorId: true, order: { select: { customerId: true } } } }, unit: { select: { siteId: true, order: { select: { customerId: true } } } } },
      });
      if (!existing) throw new TicketError(404, "Complaint not found");
      const denied = await ticketAccessError(actor, existing);
      if (denied) throw new TicketError(403, denied);
      if (!existing.archivedAt) throw new TicketError(409, "This ticket is not archived.", "NOT_ARCHIVED");
      if (existing.site && existing.site.order.customerId !== existing.customerId) {
        throw new TicketError(409, "This ticket's site no longer belongs to the ticket's customer, so it cannot be restored.", "RESTORE_LINK_INVALID");
      }
      if (existing.unit && (existing.unit.siteId !== existing.siteId || existing.unit.order.customerId !== existing.customerId)) {
        throw new TicketError(409, "This ticket's RECD is no longer on the ticket's site / customer, so it cannot be restored.", "RESTORE_LINK_INVALID");
      }
      if (!TICKET_CLOSED_STATUSES.includes(existing.status)) {
        const blocking = await findBlockingActiveTicket(tx, existing, id);
        if (blocking) throw new TicketError(409, `Another ticket (${blocking.ticketNumber}) is already open for this RECD, so this one cannot be restored. Close that ticket first.`, "OPEN_TICKET_EXISTS");
      }
      const claimed = await tx.complaint.updateMany({ where: { id, archivedAt: { not: null } }, data: { archivedAt: null, archivedById: null, archiveReason: null } });
      if (claimed.count !== 1) throw new TicketError(409, "This ticket was changed by someone else just now. Reload it and try again.", "TICKET_CHANGED");
      await logComplaintEventStrict(tx, {
        complaintId: id,
        type: COMPLAINT_EVENT.RESTORED,
        toValue: existing.status,
        actorId: actor.userId,
        detail: { statusAtRestore: existing.status, archivedAt: existing.archivedAt.toISOString(), ...(cleanReason ? { reason: cleanReason } : {}) },
      });
    });
  } catch (err) {
    if (isActiveTicketConflict(err)) {
      const t = await prisma.complaint.findUnique({ where: { id }, select: { unitId: true, siteId: true } });
      const open = t ? await findBlockingActiveTicket(prisma, t, id) : null;
      throw new TicketError(409, `Another ticket${open ? ` (${open.ticketNumber})` : ""} is already open for this RECD, so this one cannot be restored. Close that ticket first.`, "OPEN_TICKET_EXISTS");
    }
    throw err;
  }
}

/**
 * Engineers a manager may assign a ticket to (the same four roles as always). Vendor-scoped engineers are only listed for a ticket whose site
 * belongs to THEIR vendor - with no ticket in hand only unscoped (internal) engineers are listed, so one vendor's people never appear to another.
 */
export async function listAssignees(actor: TicketAuth, ticketId?: string) {
  let siteVendorId: string | null = null;
  if (ticketId) {
    const t = await prisma.complaint.findUnique({ where: { id: ticketId }, include: { site: { select: { regionId: true, vendorId: true } } } });
    if (!t) throw new TicketError(404, "Complaint not found");
    const denied = await ticketAccessError(actor, t);
    if (denied) throw new TicketError(403, denied);
    siteVendorId = t.site?.vendorId ?? null;
  }
  const vendorScope = actor.vendorId ? { vendorId: actor.vendorId } : { OR: [{ vendorId: null }, ...(siteVendorId ? [{ vendorId: siteVendorId }] : [])] };
  return prisma.user.findMany({
    where: { isActive: true, role: { key: { in: [...TICKET_ASSIGNEE_ROLES] } }, ...vendorScope },
    select: { id: true, name: true, role: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
}
