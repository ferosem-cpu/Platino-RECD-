/**
 * RECD unit warranty (Requirement 8): reading, recording / correcting (with its history, in one transaction), the login-time alerts and the
 * expiry-reminder job. All date and status rules live in packages/shared/src/warranty.ts; nothing here invents a warranty period.
 * Unit warranty is separate from AMC contracts (lib/amcContracts.ts): different tables, settings and reminders.
 */
import {
  PERMISSION_KEY,
  ROLE_KEY,
  WARRANTY_EXPIRED_NOTICE_DAYS,
  WARRANTY_HISTORY_KIND,
  WARRANTY_STATUS,
  addDays,
  isoDay,
  planWarranty,
  resolveWarrantyPolicy,
  toDateOnly,
  warrantyPeriodOf,
  warrantyStatus,
  type WarrantyPolicy,
} from "@recd/shared";
import { prisma } from "./prisma";
import { managedRegionIds } from "./regions";
import { send as sendNotification } from "../services/notifications/notificationService";

/** A client-visible problem (HTTP status, our own safe message, optional machine code). */
export class WarrantyError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code?: string) {
    super(message);
    this.name = "WarrantyError";
  }
}

export async function loadWarrantyPolicy(): Promise<WarrantyPolicy> {
  return resolveWarrantyPolicy(await prisma.companySettings.findUnique({ where: { id: "singleton" } }));
}

type UnitWarrantyFields = { warrantyStartDate?: Date | null; warrantyEndDate?: Date | null; warrantyMonths?: number | null; warrantySource?: string | null };

/** The warranty block every unit response carries: recorded dates (or null), the effective duration, provenance and the computed status. */
export function describeWarranty(unit: UnitWarrantyFields, policy: WarrantyPolicy, now: Date = new Date()) {
  const period = warrantyPeriodOf(unit);
  const s = warrantyStatus(period, now, policy.reminderLeadDays);
  return {
    startDate: period ? isoDay(period.start) : null,
    endDate: period ? isoDay(period.end) : null,
    durationMonths: period ? unit.warrantyMonths ?? null : null,
    source: period ? unit.warrantySource ?? null : null,
    status: s.status,
    daysRemaining: s.daysRemaining,
    daysUntilStart: s.daysUntilStart,
    daysSinceExpiry: s.daysSinceExpiry,
  };
}

/** The where-clause a caller's unit scope implies - the same rule as GET /recd-units and canViewUnit (customer / vendor / regional manager / everyone else). */
export async function unitScopeWhere(auth: { userId: string; roleKey: string; customerId?: string | null; vendorId?: string | null }): Promise<Record<string, unknown>> {
  if (auth.customerId) return { order: { customerId: auth.customerId } };
  if (auth.vendorId) return { site: { vendorId: auth.vendorId } };
  if (auth.roleKey === ROLE_KEY.REGIONAL_MANAGER) return { site: { regionId: { in: await managedRegionIds(auth.userId, auth.roleKey) } } };
  return {};
}

// ---------------------------------------------------------------------------------------------------------------------
// Record / correct (transactional, with history)
// ---------------------------------------------------------------------------------------------------------------------

export interface SetWarrantyInput {
  startDate: string;
  endDate?: string;
  durationMonths?: number;
  expectedEndDate: string | null;
  reason?: string;
}

/**
 * Establishes or corrects a unit's warranty. One transaction: the unit is changed with a conditional update on the expiry date the caller
 * saw, then the history row is written; any failure rolls both back, so a warranty can never change without its audit record. Product
 * duration changes never reach this code: only an explicit call changes a unit's warranty.
 *  - no period yet: kind "established" (a reason is optional);
 *  - a period exists: kind "correction", a reason is required, and an unchanged period is refused.
 */
export async function setUnitWarranty(unitId: string, input: SetWarrantyInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const unit = await tx.recdUnit.findUnique({ where: { id: unitId }, include: { product: { select: { warrantyMonths: true } } } });
    if (!unit) throw new WarrantyError(404, "RECD unit not found");
    const current = warrantyPeriodOf(unit);
    const currentEnd = current ? isoDay(current.end) : null;
    if (input.expectedEndDate !== currentEnd) {
      throw new WarrantyError(409, currentEnd ? `This unit's warranty now expires on ${currentEnd}: it was changed by someone else. Reload before editing.` : "A warranty has been recorded for this unit since you opened it. Reload before editing.", "STALE_WARRANTY");
    }
    const plan = planWarranty(input, unit.product.warrantyMonths);
    if (!plan.ok) throw new WarrantyError(400, plan.error);
    const reason = input.reason?.trim() || null;

    if (current) {
      if (!reason) throw new WarrantyError(400, "Give a reason for changing the warranty dates");
      if (plan.start.getTime() === current.start.getTime() && plan.end.getTime() === current.end.getTime() && plan.months === (unit.warrantyMonths ?? null) && plan.source === unit.warrantySource) {
        throw new WarrantyError(400, "The warranty is unchanged");
      }
    }
    const claimed = await tx.recdUnit.updateMany({
      where: { id: unitId, warrantyEndDate: unit.warrantyEndDate ?? null },
      data: { warrantyStartDate: plan.start, warrantyEndDate: plan.end, warrantyMonths: plan.months, warrantySource: plan.source },
    });
    if (claimed.count !== 1) throw new WarrantyError(409, "This unit's warranty was changed by someone else just now. Reload and try again.", "STALE_WARRANTY");
    await tx.warrantyHistory.create({
      data: {
        unitId,
        kind: current ? WARRANTY_HISTORY_KIND.CORRECTION : WARRANTY_HISTORY_KIND.ESTABLISHED,
        previousStartDate: current?.start ?? null,
        previousEndDate: current?.end ?? null,
        previousMonths: current ? unit.warrantyMonths ?? null : null,
        previousSource: current ? unit.warrantySource ?? null : null,
        newStartDate: plan.start,
        newEndDate: plan.end,
        newMonths: plan.months,
        newSource: plan.source,
        reason,
        actorId,
      },
    });
    return { id: unitId, startDate: isoDay(plan.start), endDate: isoDay(plan.end), durationMonths: plan.months, source: plan.source };
  });
}

/** History of one unit, newest first. The caller has already checked access to the unit. `staffView` adds who and why; others get dates only. */
export async function listWarrantyHistory(unitId: string, staffView: boolean) {
  const rows = await prisma.warrantyHistory.findMany({
    where: { unitId },
    orderBy: { createdAt: "desc" },
    include: { actor: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    previousStartDate: r.previousStartDate ? isoDay(r.previousStartDate) : null,
    previousEndDate: r.previousEndDate ? isoDay(r.previousEndDate) : null,
    previousMonths: r.previousMonths,
    newStartDate: isoDay(r.newStartDate),
    newEndDate: isoDay(r.newEndDate),
    newMonths: r.newMonths,
    newSource: r.newSource,
    at: r.createdAt,
    ...(staffView ? { by: r.actor?.name ?? null, reason: r.reason } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Login-time alerts
// ---------------------------------------------------------------------------------------------------------------------

export interface WarrantyAlert {
  key: string;
  unitId: string;
  serialNo: string | null;
  productName: string;
  customerName: string;
  siteName: string | null;
  endDate: string;
  status: "expiring_soon" | "expired";
  daysRemaining: number | null;
  daysSinceExpiry: number | null;
}

const MAX_ALERTS = 50;

/**
 * Units the caller may see whose warranty is expiring soon, or expired within the last WARRANTY_EXPIRED_NOTICE_DAYS days. Scoped exactly
 * like the unit list (customer: own units; vendor: units at their sites; regional manager: their regions; other staff: all), requires the
 * same VIEW_SITE_STATUS permission as the unit routes, never lists a unit whose warranty is not recorded, and is one query (not one per row).
 */
export async function buildWarrantyAlerts(
  auth: { userId: string; roleKey: string; permissions: Set<string>; customerId?: string | null; vendorId?: string | null },
  now: Date = new Date(),
): Promise<{ alerts: WarrantyAlert[]; truncated: boolean; leadDays: number }> {
  const policy = await loadWarrantyPolicy();
  if (!auth.permissions.has(PERMISSION_KEY.VIEW_SITE_STATUS)) return { alerts: [], truncated: false, leadDays: policy.reminderLeadDays };
  const today = toDateOnly(now);
  const units = await prisma.recdUnit.findMany({
    where: {
      ...(await unitScopeWhere(auth)),
      status: "active",
      warrantyStartDate: { lte: today },
      warrantyEndDate: { gte: addDays(today, -WARRANTY_EXPIRED_NOTICE_DAYS), lte: addDays(today, policy.reminderLeadDays) },
    },
    select: {
      id: true, serialNo: true, warrantyStartDate: true, warrantyEndDate: true,
      product: { select: { name: true } },
      order: { select: { customer: { select: { name: true } } } },
      site: { select: { companyName: true } },
    },
    orderBy: { warrantyEndDate: "asc" },
    take: MAX_ALERTS + 1,
  });
  const alerts: WarrantyAlert[] = [];
  for (const u of units) {
    const s = warrantyStatus(warrantyPeriodOf(u), now, policy.reminderLeadDays);
    if (s.status !== WARRANTY_STATUS.EXPIRING_SOON && s.status !== WARRANTY_STATUS.EXPIRED) continue;
    const endDate = isoDay(u.warrantyEndDate!);
    alerts.push({
      key: `warranty:${u.id}:${endDate}:${s.status}`,
      unitId: u.id,
      serialNo: u.serialNo,
      productName: u.product.name,
      customerName: u.order.customer.name,
      siteName: u.site?.companyName ?? null,
      endDate,
      status: s.status,
      daysRemaining: s.daysRemaining,
      daysSinceExpiry: s.daysSinceExpiry,
    });
  }
  return { alerts: alerts.slice(0, MAX_ALERTS), truncated: alerts.length > MAX_ALERTS, leadDays: policy.reminderLeadDays };
}

// ---------------------------------------------------------------------------------------------------------------------
// Expiry reminders
// ---------------------------------------------------------------------------------------------------------------------

/** A recipient is retried at most this many times per round, and not more often than every RETRY_AFTER_MS. */
export const WARRANTY_MAX_ATTEMPTS = 5;
export const WARRANTY_RETRY_AFTER_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/**
 * Sends the warranty-expiry reminders that are due.
 *  - Units: active, warranty recorded and started, expiry within the lead window (so never an unknown, upcoming or expired warranty).
 *  - Recipients: active users holding manage_warranty (the staff who can already see and change every unit's warranty). No customer or vendor
 *    is e-mailed, so a customer's unit details only reach staff who may already see them.
 *  - Delivery means the e-mail provider ACCEPTED the message. Only the e-mail channel is used, so a retry never writes a second in-app log
 *    row, and "no SMTP / provider refused" is recorded as a failed attempt, never as delivered.
 *  - One state row per (unit, expiry date, recipient). The attempt is claimed with a conditional update BEFORE sending, so two overlapping runs
 *    cannot both send; a delivered recipient is not sent again until the repeat interval has passed; a failed one is retried after an hour,
 *    up to WARRANTY_MAX_ATTEMPTS, then waits a full repeat interval. A corrected expiry date is a new row (a fresh reminder cycle).
 */
export async function runWarrantyReminders(now: Date = new Date()) {
  const policy = await loadWarrantyPolicy();
  const today = toDateOnly(now);
  const recipients = await prisma.user.findMany({
    where: { isActive: true, role: { permissions: { some: { permission: { key: PERMISSION_KEY.MANAGE_WARRANTY } } } } },
    select: { id: true },
  });
  const units = await prisma.recdUnit.findMany({
    where: { status: "active", warrantyStartDate: { lte: today }, warrantyEndDate: { gte: today, lte: addDays(today, policy.reminderLeadDays) } },
    select: {
      id: true, serialNo: true, warrantyStartDate: true, warrantyEndDate: true,
      product: { select: { name: true, model: true } },
      order: { select: { customerId: true, customer: { select: { name: true } } } },
      site: { select: { companyName: true } },
    },
    orderBy: { warrantyEndDate: "asc" },
  });
  const base = (process.env.ADMIN_WEB_URL || "").replace(/\/$/, "");
  const repeatStale = new Date(now.getTime() - policy.reminderRepeatDays * DAY_MS);
  const retryStale = new Date(now.getTime() - WARRANTY_RETRY_AFTER_MS);
  const result = { unitsInWindow: units.length, delivered: 0, failed: 0, skipped: 0, recipients: recipients.length };
  if (recipients.length === 0) return result;

  for (const u of units) {
    const period = warrantyPeriodOf(u);
    if (!period) continue; // unknown expiry: never reminded (the query already excludes it)
    const status = warrantyStatus(period, now, policy.reminderLeadDays);
    await prisma.warrantyReminderDelivery.createMany({
      data: recipients.map((r) => ({ unitId: u.id, warrantyEndDate: period.end, recipientId: r.id })),
      skipDuplicates: true,
    });
    for (const r of recipients) {
      const key = { unitId: u.id, warrantyEndDate: period.end, recipientId: r.id };
      const claim = await prisma.warrantyReminderDelivery.updateMany({
        where: {
          ...key,
          AND: [
            { OR: [{ deliveredAt: null }, { deliveredAt: { lte: repeatStale } }] },
            { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: retryStale } }] },
            { OR: [{ attempts: { lt: WARRANTY_MAX_ATTEMPTS } }, { lastAttemptAt: { lte: repeatStale } }] },
          ],
        },
        data: { lastAttemptAt: now },
      });
      if (claim.count !== 1) { result.skipped++; continue; } // not due, or another run took it
      let delivered = false;
      try {
        const logs = await sendNotification({
          recipientId: r.id,
          templateKey: "warranty_expiry_reminder",
          channels: ["email"],
          data: {
            unitId: u.id,
            serialNo: u.serialNo,
            productName: `${u.product.name} (${u.product.model})`,
            customerName: u.order.customer.name,
            siteName: u.site?.companyName ?? null,
            expiryDate: isoDay(period.end),
            status: status.status,
            daysRemaining: status.daysRemaining,
            link: base ? `${base}/recd-units/${u.id}` : null,
          },
        });
        delivered = logs.some((l) => l.channel === "email" && l.status === "sent");
      } catch (err) {
        console.error("Warranty reminder failed", err);
      }
      if (delivered) {
        await prisma.warrantyReminderDelivery.updateMany({ where: key, data: { deliveredAt: now, attempts: 0 } });
        result.delivered++;
      } else {
        await prisma.warrantyReminderDelivery.updateMany({ where: key, data: { attempts: { increment: 1 } } });
        result.failed++;
      }
    }
  }
  return result;
}
