import { Router } from "express";
import {
  ACKNOWLEDGEABLE_REMINDER_STATUS,
  UNDELIVERED_REMINDER_STATUSES,
  COMPLAINT_EVENT,
  PERMISSION_KEY,
  REMINDER_EVENT,
  REMINDER_STATUS,
  TICKET_FINISHED_STATUSES,
  setTicketDueDateSchema,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asOptionalString, asString } from "../lib/params";
import { reminderScope, type ReminderScope } from "../lib/regions";
import { buildOverview, runReminderJob, type OverviewFilters } from "../lib/reminders";
import { logComplaintEvent } from "../lib/ticketEvents";
import { runServiceDigest } from "../lib/serviceDigest";

/**
 * Scheduled reminder processing. Invoked by Vercel Cron (see vercel.json), which sends `Authorization: Bearer $CRON_SECRET`.
 * Mounted BEFORE the authenticated router. With no CRON_SECRET configured it refuses to run (same pattern as the other crons).
 * Until the reminder policy is filled in (Settings) the job sends nothing - it only tidies reminders of finished activities.
 */
export const reminderCronRouter = Router();

reminderCronRouter.get("/run", async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorized" });
  const now = new Date();
  const reminders = await runReminderJob(now);
  // The daily Service Manager digest rides on this cron; its failure must not hide the reminder result.
  const digest = await runServiceDigest(now).catch((err) => {
    console.error("Service digest failed", err);
    return { enabled: true, error: true };
  });
  res.json({ ok: true, ...reminders, digest });
});

export const remindersRouter = Router();
remindersRouter.use(authenticate);

const STATES = ["all", "pending", "due_soon", "overdue", "no_due_date"] as const;
const REMINDER_FILTERS = ["unacknowledged", "acknowledged", "escalated", "no_recipient", "failed"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const inScope = (scope: ReminderScope, regionId: string | null) => scope.all || (!!regionId && scope.regionIds.includes(regionId));

/**
 * The reminder dashboard: pending, due-soon, overdue and (on request) undated activities with their reminder state.
 * Needs the ticket overview permission - customers, vendors and field engineers have none. What a user sees is limited by
 * reminderScope (Regional Managers: their regions; Service Managers: their mapped regions, or all when unmapped).
 */
remindersRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW, PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  if (req.auth!.customerId || req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });
  const state = asOptionalString(req.query.state) ?? "all";
  const reminder = asOptionalString(req.query.reminder);
  const from = asOptionalString(req.query.from);
  const to = asOptionalString(req.query.to);
  if (!(STATES as readonly string[]).includes(state)) return res.status(400).json({ error: "Unknown state filter" });
  if (reminder && !(REMINDER_FILTERS as readonly string[]).includes(reminder)) return res.status(400).json({ error: "Unknown reminder filter" });
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) return res.status(400).json({ error: "Dates must be YYYY-MM-DD" });

  const filters: OverviewFilters = {
    state: state as OverviewFilters["state"],
    reminder: reminder as OverviewFilters["reminder"],
    regionId: asOptionalString(req.query.regionId),
    managerId: asOptionalString(req.query.managerId),
    from,
    to,
  };
  const scope = await reminderScope(req.auth!.userId, req.auth!.roleKey);
  const overview = await buildOverview(scope, filters);
  // Links only to places this user may already open: AMC pages need the AMC permission.
  const canAmc = req.auth!.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS);
  res.json({
    ...overview,
    canAcknowledge: req.auth!.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS),
    rows: overview.rows.map((r) => ({
      ...r,
      links: {
        activity: r.activityType === "ticket" ? `/service-reports?complaintId=${r.activityId}` : canAmc ? `/amc-orders` : null,
        unit: r.unitId ? `/recd-units/${r.unitId}` : null,
      },
    })),
  });
});

/** Acknowledge a reminder. Only users who may manage tickets AND whose region scope includes the reminder's region. */
remindersRouter.post("/:id/acknowledge", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  if (req.auth!.customerId || req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });
  const id = asString(req.params.id);
  const reminder = await prisma.serviceReminder.findUnique({ where: { id }, select: { id: true, regionId: true, status: true, acknowledgedAt: true, escalationLevel: true } });
  if (!reminder) return res.status(404).json({ error: "Reminder not found" });
  const scope = await reminderScope(req.auth!.userId, req.auth!.roleKey);
  if (!inScope(scope, reminder.regionId)) return res.status(403).json({ error: "This reminder is outside your regions" });
  if (reminder.status === REMINDER_STATUS.CLOSED) return res.status(409).json({ error: "This activity is already finished, so the reminder is closed.", code: "REMINDER_CLOSED" });
  if (reminder.acknowledgedAt) return res.status(409).json({ error: "This reminder was already acknowledged.", code: "ALREADY_ACKNOWLEDGED" });
  // Only a reminder that was actually delivered can be acknowledged: not one that is waiting, failed (fully or partly) or has no recipient.
  // The exception: an undelivered one that an escalation has since put in front of somebody (they must be able to take it over).
  const escalatedAndUndelivered = UNDELIVERED_REMINDER_STATUSES.includes(reminder.status) && reminder.escalationLevel >= 1;
  if (reminder.status !== ACKNOWLEDGEABLE_REMINDER_STATUS && !escalatedAndUndelivered) {
    return res.status(409).json({ error: "This reminder has not been delivered yet, so it cannot be acknowledged.", code: "REMINDER_NOT_DELIVERED" });
  }

  // Conditional claim (still requiring "delivered"): two people acknowledging at once record exactly one acknowledgement.
  const now = new Date();
  const claimed = await prisma.serviceReminder.updateMany({
    where: {
      id, acknowledgedAt: null,
      OR: [{ status: ACKNOWLEDGEABLE_REMINDER_STATUS }, { status: { in: UNDELIVERED_REMINDER_STATUSES }, escalationLevel: { gte: 1 } }],
    },
    data: { acknowledgedAt: now, acknowledgedById: req.auth!.userId, status: REMINDER_STATUS.ACKNOWLEDGED },
  });
  if (claimed.count !== 1) return res.status(409).json({ error: "This reminder was already acknowledged.", code: "ALREADY_ACKNOWLEDGED" });
  await prisma.serviceReminderEvent.create({ data: { reminderId: id, type: REMINDER_EVENT.ACKNOWLEDGED, actorId: req.auth!.userId } });
  res.json({ id, status: REMINDER_STATUS.ACKNOWLEDGED, acknowledgedAt: now });
});

/** Set or clear the explicit due date of a ticket. Managers only, within their region scope. */
remindersRouter.put("/tickets/:id/due-date", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  if (req.auth!.customerId || req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });
  const parsed = setTicketDueDateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const ticket = await prisma.complaint.findUnique({ where: { id }, select: { id: true, status: true, dueDate: true, archivedAt: true, site: { select: { regionId: true } } } });
  if (!ticket) return res.status(404).json({ error: "Complaint not found" });
  const scope = await reminderScope(req.auth!.userId, req.auth!.roleKey);
  if (!inScope(scope, ticket.site?.regionId ?? null)) return res.status(403).json({ error: "This ticket is outside your regions" });
  if (ticket.archivedAt) return res.status(409).json({ error: "This ticket is archived." });
  if (TICKET_FINISHED_STATUSES.includes(ticket.status)) return res.status(409).json({ error: "A resolved or closed ticket has no due date to track." });

  const dueDate = parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T00:00:00.000Z`) : null;
  await prisma.complaint.update({ where: { id }, data: { dueDate } });
  await logComplaintEvent({
    complaintId: id,
    type: COMPLAINT_EVENT.DUE_DATE_SET,
    fromValue: ticket.dueDate ? ticket.dueDate.toISOString().slice(0, 10) : null,
    toValue: parsed.data.dueDate,
    actorId: req.auth!.userId,
  });
  res.json({ id, dueDate: parsed.data.dueDate });
});
