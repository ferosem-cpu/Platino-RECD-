/**
 * Service reminders (Requirement 6): which activities are tracked, who is responsible for a region, the scheduled job that
 * creates / sends / escalates reminders, and the data behind the dashboard.
 *
 * TRACKED ACTIVITIES (only those with an EXPLICIT due date entered by a person - nothing is derived):
 *   - a service ticket with Complaint.dueDate, until it is resolved / closed;
 *   - a scheduled AMC visit (AmcVisit.dueDate), until it is completed / cancelled. The AMC contract expiry is NOT a visit due date.
 *
 * POLICY (CompanySettings, both NULL = off until the business approves values):
 *   - reminderLeadDays: a reminder is created and sent once an activity is due within this many days, or overdue.
 *   - reminderEscalationHours: a reminder nobody acknowledged is escalated after this many hours (twice, one level at a time).
 *   With the lead time unset the job sends NOTHING (it still tidies up reminders of finished activities).
 *
 * WHO IS TOLD (defaults documented in docs/HANDOVER.md, to be confirmed by the mentor):
 *   first reminder  -> the ACTIVE Service Managers mapped to the activity's region; if the region has none, its active
 *                      Regional Managers; if neither (or the activity has no region) the reminder is "no recipient" - it is
 *                      shown on the dashboard and retried on every run, and is never sent to anyone unrelated.
 *   escalation 1    -> the region's active Regional Managers who have not already had the reminder; if there are none, Management.
 *   escalation 2    -> Management (management and owner/admin roles).
 *
 * WHAT "DELIVERED" MEANS: only an accepted e-mail. The in-app channel writes a NotificationLog row that no screen or API reads,
 * so it is recorded (event `in_app_recorded`) but never counted as delivery. With no SMTP configured nothing is delivered and
 * the reminder says so (`failed`).
 *
 * RETRIES ARE PER RECIPIENT: every attempt writes one event per recipient and channel (`sent` / `delivery_failed` /
 * `in_app_recorded`, with the attempt number). A recipient whose e-mail was accepted at a level is never e-mailed again at that
 * level; only the others are retried. The first reminder is `sent` only when EVERY recipient got it (`failed` with reason
 * `partial_delivery` / `delivery_failed` otherwise, retried up to MAX_DELIVERY_ATTEMPTS). An escalation level advances
 * (`escalationLevel`) only once that level was delivered to all its recipients (or had nobody to tell); until then the level is
 * retried on later runs, up to MAX_DELIVERY_ATTEMPTS, under a lease (`escalationClaimedAt`) that overlapping runs respect.
 *
 * SAFE TO RUN TWICE / AT THE SAME TIME: reminders are unique per activity; sending is claimed with a conditional update on
 * `status`; an escalation attempt is claimed with a conditional update on `escalationLevel` + the lease; a recipient that already
 * received a level is skipped on retry. A failed delivery is retried on the next run.
 */
import { Prisma } from "@prisma/client";
import {
  MAX_DELIVERY_ATTEMPTS,
  REMINDER_ACTIVITY,
  REMINDER_EVENT,
  REMINDER_STATUS,
  ROLE_KEY,
  SENDING_STALE_MINUTES,
  TICKET_FINISHED_STATUSES,
  AMC_VISIT_STATUS,
  classifyDue,
  escalationDue,
  ESCALATABLE_REMINDER_STATUSES,
  reminderEligible,
  type DueState,
} from "@recd/shared";
import { prisma } from "./prisma";
import { send as sendNotification } from "../services/notifications/notificationService";
import type { ReminderScope } from "./regions";

const DAY_MS = 24 * 3600 * 1000;
export const amcRef = (amcOrderId: string) => `AMC-${amcOrderId.slice(-6).toUpperCase()}`;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const REMINDER_CHANNELS = ["in_app", "email"] as const;

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface Recipients {
  ids: string[];
  /** Why there is nobody (no_region | no_active_manager | no_management). */
  reason?: string;
}

/** Active managers mapped to a region, split by their CURRENT role. */
async function mappedManagers(regionId: string) {
  const rows = await prisma.regionManager.findMany({
    where: { regionId, user: { isActive: true, role: { key: { in: [ROLE_KEY.SERVICE_MANAGER, ROLE_KEY.REGIONAL_MANAGER] } } } },
    select: { userId: true, user: { select: { role: { select: { key: true } } } } },
  });
  return {
    serviceManagers: rows.filter((r) => r.user.role.key === ROLE_KEY.SERVICE_MANAGER).map((r) => r.userId),
    regionalManagers: rows.filter((r) => r.user.role.key === ROLE_KEY.REGIONAL_MANAGER).map((r) => r.userId),
  };
}

export async function firstLineRecipients(regionId: string | null): Promise<Recipients> {
  if (!regionId) return { ids: [], reason: "no_region" };
  const m = await mappedManagers(regionId);
  if (m.serviceManagers.length) return { ids: [...new Set(m.serviceManagers)] };
  if (m.regionalManagers.length) return { ids: [...new Set(m.regionalManagers)] };
  return { ids: [], reason: "no_active_manager" };
}

async function managementRecipients(): Promise<Recipients> {
  const users = await prisma.user.findMany({
    where: { isActive: true, role: { key: { in: [ROLE_KEY.MANAGEMENT, ROLE_KEY.OWNER_ADMIN] } } },
    select: { id: true },
  });
  return users.length ? { ids: users.map((u) => u.id) } : { ids: [], reason: "no_management" };
}

async function escalationRecipients(level: number, regionId: string | null, alreadyNotified: Set<string>): Promise<Recipients> {
  if (level === 1 && regionId) {
    const m = await mappedManagers(regionId);
    const fresh = m.regionalManagers.filter((id) => !alreadyNotified.has(id));
    if (fresh.length) return { ids: [...new Set(fresh)] };
  }
  return managementRecipients();
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export interface ActivityView {
  activityType: "ticket" | "amc_visit";
  activityId: string;
  activityRef: string;
  customerId: string;
  customerName: string;
  siteId: string | null;
  siteName: string | null;
  regionId: string | null;
  unitId: string | null;
  serialNo: string | null;
  dueDate: Date | null;
}

type TicketRow = {
  id: string; ticketNumber: string; dueDate: Date | null; customerId: string; siteId: string | null; unitId: string | null;
  customer: { name: string }; site: { id: string; companyName: string | null; regionId: string | null } | null; unit: { id: string; serialNo: string | null } | null;
};
type VisitRow = {
  id: string; dueDate: Date; amcOrderId: string; unitId: string;
  amcOrder: { id: string; customerId: string; customer: { name: string } };
  unit: { id: string; serialNo: string | null; site: { id: string; companyName: string | null; regionId: string | null } | null };
};

const ticketSelect = {
  id: true, ticketNumber: true, dueDate: true, customerId: true, siteId: true, unitId: true,
  customer: { select: { name: true } },
  site: { select: { id: true, companyName: true, regionId: true } },
  unit: { select: { id: true, serialNo: true } },
} as const;
const visitSelect = {
  id: true, dueDate: true, amcOrderId: true, unitId: true,
  amcOrder: { select: { id: true, customerId: true, customer: { select: { name: true } } } },
  unit: { select: { id: true, serialNo: true, site: { select: { id: true, companyName: true, regionId: true } } } },
} as const;

const fromTicket = (t: TicketRow): ActivityView => ({
  activityType: REMINDER_ACTIVITY.TICKET, activityId: t.id, activityRef: t.ticketNumber, customerId: t.customerId, customerName: t.customer.name,
  siteId: t.site?.id ?? t.siteId, siteName: t.site?.companyName ?? null, regionId: t.site?.regionId ?? null, unitId: t.unit?.id ?? t.unitId, serialNo: t.unit?.serialNo ?? null, dueDate: t.dueDate,
});
const fromVisit = (v: VisitRow): ActivityView => ({
  activityType: REMINDER_ACTIVITY.AMC_VISIT, activityId: v.id, activityRef: amcRef(v.amcOrderId), customerId: v.amcOrder.customerId, customerName: v.amcOrder.customer.name,
  siteId: v.unit.site?.id ?? null, siteName: v.unit.site?.companyName ?? null, regionId: v.unit.site?.regionId ?? null, unitId: v.unit.id, serialNo: v.unit.serialNo, dueDate: v.dueDate,
});

// ---------------------------------------------------------------------------
// The scheduled job
// ---------------------------------------------------------------------------

export interface ReminderJobResult {
  enabled: boolean;
  closed: number;
  created: number;
  sent: number;
  failed: number;
  noRecipient: number;
  escalated: number;
  escalationNoRecipient: number;
  /** Escalation levels whose delivery did not complete this run; they stay due and are retried. */
  escalationRetryPending: number;
}

function messageData(r: { id: string; activityType: string; activityRef: string; customerName: string; siteName: string | null; unitSerialNo: string | null; dueDate: Date }, now: Date, extra: Record<string, unknown> = {}) {
  const base = (process.env.ADMIN_WEB_URL || "").replace(/\/$/, "");
  return {
    activityType: r.activityType,
    activityRef: r.activityRef,
    customerName: r.customerName,
    siteName: r.siteName,
    serialNo: r.unitSerialNo, // null is printed as "not recorded"
    dueDate: dateOnly(r.dueDate),
    overdue: classifyDue(r.dueDate, now, null) === "overdue",
    link: `${base}/reminders?focus=${r.id}`,
    ...extra,
  };
}

/**
 * One delivery pass for one level of one reminder. Records an event per recipient and channel and returns who has now been
 * delivered to. DELIVERED means an accepted e-mail (the only channel that can reach a person); the in-app row is a record only.
 * A recipient already e-mailed at this level (an earlier attempt) is skipped, so retries never produce a second successful
 * notification; the in-app record is also written once per recipient and level.
 */
async function deliver(
  reminderId: string,
  level: number,
  recipientIds: string[],
  templateKey: string,
  data: Record<string, unknown>,
  attempt: number,
): Promise<{ delivered: Set<string>; pending: string[] }> {
  const prior = await prisma.serviceReminderEvent.findMany({
    where: { reminderId, level, type: { in: [REMINDER_EVENT.SENT, REMINDER_EVENT.IN_APP_RECORDED] } },
    select: { recipientId: true, type: true },
  });
  const delivered = new Set(prior.filter((e) => e.type === REMINDER_EVENT.SENT).map((e) => e.recipientId as string));
  const recorded = new Set(prior.filter((e) => e.type === REMINDER_EVENT.IN_APP_RECORDED).map((e) => e.recipientId as string));

  for (const recipientId of recipientIds) {
    if (delivered.has(recipientId)) continue;
    const channels = ["email", ...(recorded.has(recipientId) ? [] : ["in_app"])] as ("email" | "in_app")[];
    try {
      const logs = await sendNotification({ recipientId, templateKey, data, channels });
      for (const log of logs) {
        const ok = log.status === "sent";
        if (log.channel === "email") {
          if (ok) delivered.add(recipientId);
          await prisma.serviceReminderEvent.create({ data: { reminderId, type: ok ? REMINDER_EVENT.SENT : REMINDER_EVENT.DELIVERY_FAILED, level, recipientId, channel: "email", detail: { logStatus: log.status, attempt } } });
        } else {
          await prisma.serviceReminderEvent.create({ data: { reminderId, type: ok ? REMINDER_EVENT.IN_APP_RECORDED : REMINDER_EVENT.DELIVERY_FAILED, level, recipientId, channel: log.channel, detail: { logStatus: log.status, attempt, ...(ok ? { note: "recorded only - no inbox shows it, so it is not a delivery" } : {}) } } });
        }
      }
    } catch (err) {
      await prisma.serviceReminderEvent.create({ data: { reminderId, type: REMINDER_EVENT.DELIVERY_FAILED, level, recipientId, channel: null, detail: { error: err instanceof Error ? err.name : "unknown", attempt } } });
    }
  }
  return { delivered, pending: recipientIds.filter((id) => !delivered.has(id)) };
}

export async function runReminderJob(now: Date = new Date()): Promise<ReminderJobResult> {
  const result: ReminderJobResult = { enabled: false, closed: 0, created: 0, sent: 0, failed: 0, noRecipient: 0, escalated: 0, escalationNoRecipient: 0, escalationRetryPending: 0 };
  const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
  const leadDays = settings?.reminderLeadDays ?? null;
  const escalationHours = settings?.reminderEscalationHours ?? null;

  // 1. Housekeeping (runs even when the policy is off): reminders whose activity is finished, or lost its due date, are closed.
  const open = await prisma.serviceReminder.findMany({
    where: { status: { not: REMINDER_STATUS.CLOSED } },
    select: { id: true, complaint: { select: { status: true, dueDate: true, archivedAt: true } }, amcVisit: { select: { status: true, dueDate: true } } },
  });
  for (const r of open) {
    const done = r.complaint ? TICKET_FINISHED_STATUSES.includes(r.complaint.status) || !r.complaint.dueDate || !!r.complaint.archivedAt : r.amcVisit ? r.amcVisit.status !== AMC_VISIT_STATUS.SCHEDULED : false;
    if (!done) continue;
    const claimed = await prisma.serviceReminder.updateMany({ where: { id: r.id, status: { not: REMINDER_STATUS.CLOSED } }, data: { status: REMINDER_STATUS.CLOSED, closedAt: now } });
    if (claimed.count === 1) {
      result.closed++;
      await prisma.serviceReminderEvent.create({ data: { reminderId: r.id, type: REMINDER_EVENT.CLOSED, detail: { reason: "activity_finished" } } });
    }
  }

  // No lead time approved: nothing is created, sent or escalated.
  if (leadDays == null) return result;
  result.enabled = true;

  // 2. Create / refresh a reminder for every eligible activity.
  const horizon = new Date(now.getTime() + leadDays * DAY_MS);
  const tickets = (await prisma.complaint.findMany({
    where: { dueDate: { not: null, lte: horizon }, status: { notIn: TICKET_FINISHED_STATUSES }, archivedAt: null },
    select: ticketSelect,
  })) as unknown as TicketRow[];
  const visits = (await prisma.amcVisit.findMany({
    where: { status: AMC_VISIT_STATUS.SCHEDULED, dueDate: { lte: horizon } },
    select: visitSelect,
  })) as unknown as VisitRow[];

  for (const a of [...tickets.map(fromTicket), ...visits.map(fromVisit)]) {
    if (!a.dueDate || !reminderEligible(a.dueDate, now, leadDays)) continue;
    const key = a.activityType === REMINDER_ACTIVITY.TICKET ? { complaintId: a.activityId } : { amcVisitId: a.activityId };
    const existing = await prisma.serviceReminder.findFirst({ where: key, select: { id: true, status: true, dueDate: true, regionId: true } });
    if (!existing) {
      try {
        const created = await prisma.serviceReminder.create({
          data: {
            activityType: a.activityType, ...key, regionId: a.regionId, customerId: a.customerId, customerName: a.customerName, siteId: a.siteId, siteName: a.siteName,
            unitId: a.unitId, unitSerialNo: a.serialNo, activityRef: a.activityRef, dueDate: a.dueDate,
          },
          select: { id: true },
        });
        result.created++;
        await prisma.serviceReminderEvent.create({ data: { reminderId: created.id, type: REMINDER_EVENT.CREATED, detail: { dueDate: dateOnly(a.dueDate) } } });
      } catch (err) {
        // A parallel run created it first (unique per activity): fine.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      }
    } else if (existing.status !== REMINDER_STATUS.CLOSED) {
      // Keep the region and due date current; a changed due date is recorded but does not trigger a second reminder.
      const changedDue = existing.dueDate.getTime() !== a.dueDate.getTime();
      if (changedDue || existing.regionId !== a.regionId) {
        await prisma.serviceReminder.update({ where: { id: existing.id }, data: { dueDate: a.dueDate, regionId: a.regionId } });
        if (changedDue) await prisma.serviceReminderEvent.create({ data: { reminderId: existing.id, type: REMINDER_EVENT.DUE_DATE_CHANGED, detail: { from: dateOnly(existing.dueDate), to: dateOnly(a.dueDate) } } });
      }
    }
  }

  // 3. Send: pending, previously failed, previously without a recipient, or stuck "sending" past the timeout.
  const stale = new Date(now.getTime() - SENDING_STALE_MINUTES * 60_000);
  const toSend = await prisma.serviceReminder.findMany({
    where: {
      attempts: { lt: MAX_DELIVERY_ATTEMPTS },
      OR: [{ status: { in: [REMINDER_STATUS.PENDING, REMINDER_STATUS.FAILED, REMINDER_STATUS.NO_RECIPIENT] } }, { status: REMINDER_STATUS.SENDING, lastAttemptAt: { lt: stale } }],
    },
    select: { id: true },
  });
  for (const { id } of toSend) {
    const claimed = await prisma.serviceReminder.updateMany({
      where: { id, attempts: { lt: MAX_DELIVERY_ATTEMPTS }, OR: [{ status: { in: [REMINDER_STATUS.PENDING, REMINDER_STATUS.FAILED, REMINDER_STATUS.NO_RECIPIENT] } }, { status: REMINDER_STATUS.SENDING, lastAttemptAt: { lt: stale } }] },
      data: { status: REMINDER_STATUS.SENDING, lastAttemptAt: now, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue; // another run owns it
    const r = await prisma.serviceReminder.findUniqueOrThrow({ where: { id } });
    const recipients = await firstLineRecipients(r.regionId);
    if (!recipients.ids.length) {
      await prisma.serviceReminder.update({ where: { id }, data: { status: REMINDER_STATUS.NO_RECIPIENT, statusReason: recipients.reason ?? "no_active_manager" } });
      await prisma.serviceReminderEvent.create({ data: { reminderId: id, type: REMINDER_EVENT.NO_RECIPIENT, detail: { reason: recipients.reason } } });
      result.noRecipient++;
      continue;
    }
    // Only recipients not yet e-mailed are tried again (deliver() skips the rest); "sent" needs EVERY recipient delivered.
    const out = await deliver(id, 0, recipients.ids, "service_reminder", messageData(r, now), r.attempts);
    if (out.pending.length === 0) {
      await prisma.serviceReminder.update({ where: { id }, data: { status: REMINDER_STATUS.SENT, statusReason: null, sentAt: r.sentAt ?? now } });
      result.sent++;
    } else {
      const reachedSome = out.pending.length < recipients.ids.length;
      await prisma.serviceReminder.update({ where: { id }, data: { status: REMINDER_STATUS.FAILED, statusReason: reachedSome ? "partial_delivery" : "delivery_failed" } });
      result.failed++;
    }
  }

  // 4. Escalate unacknowledged reminders (only when an escalation time has been approved). escalationLevel advances only once
  //    the level was DELIVERED (or had nobody to tell); a failed level stays due and is retried (up to MAX_DELIVERY_ATTEMPTS).
  if (escalationHours != null) {
    // Delivered reminders AND undelivered ones (failed / no recipient): a failed delivery must not stop an overdue activity from being escalated.
    const sent = await prisma.serviceReminder.findMany({ where: { status: { in: ESCALATABLE_REMINDER_STATUSES }, acknowledgedAt: null, escalationLevel: { lt: 2 }, closedAt: null } });
    for (const r of sent) {
      if (!escalationDue(r, escalationHours, now)) continue;
      if ((r.escalationAttempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) continue;
      const level = r.escalationLevel + 1;
      // Lease the attempt: a parallel run that got here first leaves count 0 (its lease is fresh), so only one run delivers.
      const claimed = await prisma.serviceReminder.updateMany({
        where: {
          id: r.id, status: { in: ESCALATABLE_REMINDER_STATUSES }, acknowledgedAt: null, closedAt: null, escalationLevel: r.escalationLevel,
          OR: [{ escalationClaimedAt: null }, { escalationClaimedAt: { lt: stale } }],
        },
        data: { escalationClaimedAt: now, escalationAttempts: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;
      const attempt = (r.escalationAttempts ?? 0) + 1;
      // Who already had the ORIGINAL reminder (level 0) - never this level's own earlier deliveries, so a retry picks the same people.
      const notified = new Set((await prisma.serviceReminderEvent.findMany({ where: { reminderId: r.id, type: REMINDER_EVENT.SENT, level: 0 }, select: { recipientId: true } })).map((e) => e.recipientId as string));
      const recipients = await escalationRecipients(level, r.regionId, notified);
      const completeLevel = () => prisma.serviceReminder.updateMany({
        where: { id: r.id, escalationLevel: r.escalationLevel },
        data: { escalationLevel: level, lastEscalatedAt: now, escalationClaimedAt: null, escalationAttempts: 0 },
      });
      if (!recipients.ids.length) {
        await prisma.serviceReminderEvent.create({ data: { reminderId: r.id, type: REMINDER_EVENT.ESCALATION_NO_RECIPIENT, level, detail: { reason: recipients.reason, attempt } } });
        await completeLevel(); // nobody to tell: the level is settled (no endless retry), exactly as before
        result.escalationNoRecipient++;
        continue;
      }
      const out = await deliver(r.id, level, recipients.ids, "service_reminder_escalated", messageData(r, now, { level }), attempt);
      if (out.pending.length === 0) {
        await prisma.serviceReminderEvent.create({ data: { reminderId: r.id, type: REMINDER_EVENT.ESCALATED, level, detail: { recipients: recipients.ids.length, attempt } } });
        await completeLevel();
        result.escalated++;
      } else {
        // Not delivered to everyone: release the lease, keep the level due, retry next run (those already delivered are skipped).
        await prisma.serviceReminder.updateMany({ where: { id: r.id, escalationLevel: r.escalationLevel }, data: { escalationClaimedAt: null } });
        result.escalationRetryPending++;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface OverviewFilters {
  regionId?: string;
  managerId?: string;
  state?: DueState | "all";
  from?: string;
  to?: string;
  reminder?: "unacknowledged" | "acknowledged" | "escalated" | "no_recipient" | "failed";
}

export async function buildOverview(scope: ReminderScope, f: OverviewFilters, now: Date = new Date()) {
  const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
  const leadDays = settings?.reminderLeadDays ?? null;

  // Region restriction: the user's scope AND the filter. Activities without a region are visible only to unscoped users.
  let regionIds: string[] | null = scope.all ? null : scope.regionIds;
  if (f.regionId) regionIds = regionIds ? regionIds.filter((r) => r === f.regionId) : [f.regionId];
  if (f.managerId) {
    const mapped = (await prisma.regionManager.findMany({ where: { userId: f.managerId }, select: { regionId: true } })).map((m) => m.regionId);
    regionIds = regionIds ? regionIds.filter((r) => mapped.includes(r)) : mapped;
  }
  const regionWhere = regionIds ? { in: regionIds } : undefined;
  const range = {
    ...(f.from ? { gte: new Date(`${f.from}T00:00:00.000Z`) } : {}),
    ...(f.to ? { lte: new Date(`${f.to}T00:00:00.000Z`) } : {}),
  };

  const tickets = (await prisma.complaint.findMany({
    where: {
      status: { notIn: TICKET_FINISHED_STATUSES },
      archivedAt: null,
      ...(regionWhere ? { site: { regionId: regionWhere } } : {}),
      // Tickets without a due date are not tracked: they are only listed when asked for ("no_due_date"), and counted.
      dueDate: f.state === "no_due_date" ? null : Object.keys(range).length ? range : { not: null },
    },
    select: ticketSelect,
    orderBy: [{ dueDate: "asc" }],
    take: 500,
  })) as unknown as TicketRow[];
  const noDueDate = await prisma.complaint.count({ where: { status: { notIn: TICKET_FINISHED_STATUSES }, archivedAt: null, dueDate: null, ...(regionWhere ? { site: { regionId: regionWhere } } : {}) } });
  const visits = (f.state === "no_due_date" ? [] : await prisma.amcVisit.findMany({
    where: {
      status: AMC_VISIT_STATUS.SCHEDULED,
      ...(regionWhere ? { unit: { site: { regionId: regionWhere } } } : {}),
      ...(Object.keys(range).length ? { dueDate: range } : {}),
    },
    select: visitSelect,
    orderBy: [{ dueDate: "asc" }],
    take: 500,
  })) as unknown as VisitRow[];

  const activities = [...tickets.map(fromTicket), ...visits.map(fromVisit)];
  const reminders = activities.length
    ? await prisma.serviceReminder.findMany({
        where: { OR: [{ complaintId: { in: tickets.map((t) => t.id) } }, { amcVisitId: { in: visits.map((v) => v.id) } }] },
        include: { acknowledgedBy: { select: { name: true } }, events: { orderBy: { createdAt: "desc" }, take: 12, include: { recipient: { select: { name: true } } } } },
      })
    : [];
  const byActivity = new Map(reminders.map((r) => [r.complaintId ?? r.amcVisitId!, r]));
  const regionIdsInRows = [...new Set(activities.map((a) => a.regionId).filter((x): x is string => !!x))];
  const regions = regionIdsInRows.length ? await prisma.region.findMany({ where: { id: { in: regionIdsInRows } }, select: { id: true, name: true } }) : [];
  const mapped = regionIdsInRows.length
    ? await prisma.regionManager.findMany({ where: { regionId: { in: regionIdsInRows }, user: { isActive: true } }, select: { regionId: true, user: { select: { id: true, name: true, role: { select: { key: true } } } } } })
    : [];

  let rows = activities.map((a) => {
    const reminder = byActivity.get(a.activityId) ?? null;
    return {
      key: `${a.activityType}:${a.activityId}`,
      activityType: a.activityType,
      activityId: a.activityId,
      activityRef: a.activityRef,
      customerName: a.customerName,
      siteName: a.siteName,
      serialNo: a.serialNo,
      serialMissing: !a.serialNo,
      unitId: a.unitId,
      dueDate: a.dueDate ? dateOnly(a.dueDate) : null,
      state: classifyDue(a.dueDate, now, leadDays),
      regionId: a.regionId,
      regionName: regions.find((r) => r.id === a.regionId)?.name ?? null,
      managers: mapped.filter((m) => m.regionId === a.regionId).map((m) => ({ id: m.user.id, name: m.user.name, role: m.user.role.key })),
      reminder: reminder && {
        id: reminder.id, status: reminder.status, statusReason: reminder.statusReason, attempts: reminder.attempts, sentAt: reminder.sentAt,
        acknowledgedAt: reminder.acknowledgedAt, acknowledgedBy: reminder.acknowledgedBy?.name ?? null, escalationLevel: reminder.escalationLevel, lastEscalatedAt: reminder.lastEscalatedAt, escalationAttempts: reminder.escalationAttempts ?? 0,
        events: reminder.events.map((e) => ({ id: e.id, type: e.type, level: e.level, channel: e.channel, recipient: e.recipient?.name ?? null, at: e.createdAt, attempt: typeof (e.detail as { attempt?: unknown } | null)?.attempt === "number" ? (e.detail as { attempt: number }).attempt : null })),
      },
    };
  });
  if (f.state && f.state !== "all") rows = rows.filter((r) => r.state === f.state);
  if (f.reminder) {
    rows = rows.filter((r) => {
      const m = r.reminder;
      if (!m) return false;
      switch (f.reminder) {
        case "unacknowledged": return !m.acknowledgedAt && m.status !== "closed";
        case "acknowledged": return !!m.acknowledgedAt;
        case "escalated": return m.escalationLevel > 0;
        case "no_recipient": return m.status === "no_recipient";
        case "failed": return m.status === "failed";
        default: return true;
      }
    });
  }
  const count = (s: DueState) => rows.filter((r) => r.state === s).length;
  return {
    policy: { reminderLeadDays: leadDays, reminderEscalationHours: settings?.reminderEscalationHours ?? null, remindersEnabled: leadDays != null },
    counts: { pending: count("pending"), dueSoon: count("due_soon"), overdue: count("overdue"), noDueDate, noRecipient: rows.filter((r) => r.reminder?.status === "no_recipient").length },
    rows,
  };
}
