/**
 * AMC contracts (Requirement 7): customer contracts (AmcOrder) and vendor contracts (VendorAmc) share one set of rules for their
 * period, renewal history, expiry alerts and reminder timing. The two kinds stay in separate tables and are never mixed; this
 * module only avoids writing the same transaction twice. All date maths lives in packages/shared/src/amc.ts.
 */
import { Prisma } from "@prisma/client";
import {
  AMC_DATES_SOURCE,
  AMC_PARTY,
  AMC_PARTY_LABELS,
  AMC_RENEWAL_KIND,
  PERMISSION_KEY,
  amcContractStatus,
  amcReminderDue,
  effectivePeriod,
  isoDay,
  parseDay,
  planRenewal,
  resolveAmcPolicy,
  toDateOnly,
  type AmcPolicy,
  type RenewalInput,
} from "@recd/shared";
import { prisma } from "./prisma";
import { send as sendNotification } from "../services/notifications/notificationService";

export type AmcParty = (typeof AMC_PARTY)[keyof typeof AMC_PARTY];

/** A client-visible problem (HTTP status, our own safe message, optional machine code). */
export class AmcError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code?: string) {
    super(message);
    this.name = "AmcError";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const modelOf = (db: any, party: AmcParty) => (party === AMC_PARTY.CUSTOMER ? db.amcOrder : db.vendorAmc);
const parentKey = (party: AmcParty) => (party === AMC_PARTY.CUSTOMER ? "amcOrderId" : "vendorAmcId");
const NOT_FOUND = "AMC contract not found";

/** The configured duration / reminder timing; an empty setting falls back to the compatible default (12 months, 30 days, every 3 days). */
export async function loadAmcPolicy(): Promise<AmcPolicy> {
  return resolveAmcPolicy(await prisma.companySettings.findUnique({ where: { id: "singleton" } }));
}

/** The date, status and renewal fields every AMC response carries, computed on the server so no screen re-derives them. */
export function describeContract(
  row: { poDate?: Date | null; startDate?: Date | null; endDate?: Date | null; datesSource?: string | null; _count?: { renewals: number }; renewals?: { previousEndDate: Date }[] },
  policy: AmcPolicy,
  now: Date = new Date(),
) {
  const period = effectivePeriod({ poDate: row.poDate ?? new Date(0), startDate: row.startDate, endDate: row.endDate });
  // A vendor contract always has dates; a customer contract without them is shown with the legacy-derived dates.
  const hasDates = !!(row.startDate && row.endDate);
  // the latest RENEWAL (not a correction): if its old period still covers today, the contract is "renewed", not merely "upcoming"
  const { status, daysRemaining } = amcContractStatus(period, now, policy.reminderLeadDays, row.renewals?.[0]?.previousEndDate);
  return {
    startDate: isoDay(period.start),
    endDate: isoDay(period.end),
    datesSource: hasDates ? (row.datesSource ?? AMC_DATES_SOURCE.EXPLICIT) : AMC_DATES_SOURCE.LEGACY_PO_DATE,
    contractStatus: status,
    daysRemaining,
    renewalCount: row._count?.renewals ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Renewal and date correction (transactional)
// ---------------------------------------------------------------------------------------------------------------------

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * RENEWS a contract: the same contract continues into a new period (creating a separate contract is the normal "create" flow).
 * One transaction: the period is changed with a conditional update on the end date the caller saw, then the history row is written.
 * Any failure rolls both back, so a renewal is either fully recorded or not at all. A double submit or a race cannot record it twice:
 * the second caller no longer matches the end date (409 STALE_PERIOD) and a partial unique index backs that up (409 DUPLICATE_RENEWAL).
 * The reminder state is reset so expiry reminders apply to the new period.
 */
export async function renewContract(party: AmcParty, id: string, input: RenewalInput & { expectedEndDate: string; note?: string }, actorId: string) {
  const policy = await loadAmcPolicy();
  return prisma.$transaction(async (tx) => {
    const db = tx as any;
    const row = await modelOf(db, party).findUnique({ where: { id } });
    if (!row) throw new AmcError(404, NOT_FOUND);
    const period = effectivePeriod({ poDate: row.poDate ?? new Date(0), startDate: row.startDate, endDate: row.endDate });
    if (isoDay(period.end) !== input.expectedEndDate) {
      throw new AmcError(409, `This contract's end date is ${isoDay(period.end)}, not ${input.expectedEndDate}: it was already renewed or changed. Reload before renewing.`, "STALE_PERIOD");
    }
    const plan = planRenewal(period, input, policy.durationMonths);
    if (!plan.ok) throw new AmcError(400, plan.error);

    const claimed = await modelOf(db, party).updateMany({
      where: { id, endDate: row.endDate ?? null },
      data: {
        startDate: plan.newStart,
        endDate: plan.newEnd,
        ...(party === AMC_PARTY.CUSTOMER ? { datesSource: AMC_DATES_SOURCE.EXPLICIT } : {}),
        lastExpiryReminderAt: null,
        expiryReminderClearedAt: null,
        expiryReminderClearedById: null,
      },
    });
    if (claimed.count !== 1) throw new AmcError(409, "This contract was changed by someone else just now. Reload before renewing.", "STALE_PERIOD");
    try {
      await db.amcRenewal.create({
        data: {
          kind: AMC_RENEWAL_KIND.RENEWAL,
          [parentKey(party)]: id,
          previousStartDate: period.start,
          previousEndDate: period.end,
          newStartDate: plan.newStart,
          newEndDate: plan.newEnd,
          renewedById: actorId,
          note: input.note || null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AmcError(409, "This period has already been renewed.", "DUPLICATE_RENEWAL");
      throw err;
    }
    return { id, previousStartDate: isoDay(period.start), previousEndDate: isoDay(period.end), newStartDate: isoDay(plan.newStart), newEndDate: isoDay(plan.newEnd) };
  });
}

/**
 * Edits a contract. Plain fields are updated directly; a change to the start / end date is a CORRECTION: it is validated, needs a
 * reason, and is written to the renewal history (kind "correction") in the same transaction, so a date can never change without a trace.
 */
export async function updateContract(
  party: AmcParty,
  id: string,
  fields: Record<string, unknown>,
  dates: { startDate?: string; endDate?: string; reason?: string },
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    const db = tx as any;
    const row = await modelOf(db, party).findUnique({ where: { id } });
    if (!row) throw new AmcError(404, NOT_FOUND);
    const period = effectivePeriod({ poDate: row.poDate ?? new Date(0), startDate: row.startDate, endDate: row.endDate });
    const data: Record<string, unknown> = { ...fields };
    let correction: { newStart: Date; newEnd: Date } | null = null;

    if (dates.startDate !== undefined || dates.endDate !== undefined) {
      const newStart = dates.startDate !== undefined ? parseDay(dates.startDate) : period.start;
      const newEnd = dates.endDate !== undefined ? parseDay(dates.endDate) : period.end;
      if (!newStart || !newEnd) throw new AmcError(400, "Enter the dates as real calendar dates (YYYY-MM-DD)");
      if (newEnd.getTime() <= newStart.getTime()) throw new AmcError(400, "The end date must be after the start date");
      if (newStart.getTime() === period.start.getTime() && newEnd.getTime() === period.end.getTime()) throw new AmcError(400, "The dates are unchanged");
      correction = { newStart, newEnd };
      data.startDate = newStart;
      data.endDate = newEnd;
      if (party === AMC_PARTY.CUSTOMER) data.datesSource = AMC_DATES_SOURCE.EXPLICIT;
      // the reminder state belongs to the old end date
      data.lastExpiryReminderAt = null;
    }
    if (Object.keys(data).length === 0) throw new AmcError(400, "Nothing to change");

    const claimed = await modelOf(db, party).updateMany({ where: { id, endDate: row.endDate ?? null }, data });
    if (claimed.count !== 1) throw new AmcError(409, "This contract was changed by someone else just now. Reload and try again.", "STALE_PERIOD");
    if (correction) {
      await db.amcRenewal.create({
        data: {
          kind: AMC_RENEWAL_KIND.CORRECTION,
          [parentKey(party)]: id,
          previousStartDate: period.start,
          previousEndDate: period.end,
          newStartDate: correction.newStart,
          newEndDate: correction.newEnd,
          renewedById: actorId,
          note: dates.reason ?? null,
        },
      });
    }
    return modelOf(db, party).findUnique({ where: { id } });
  });
}

/** The renewal / correction history of one contract, newest first. The caller has already checked access to the contract. */
export async function listHistory(party: AmcParty, id: string) {
  const rows = await prisma.amcRenewal.findMany({
    where: { [parentKey(party)]: id },
    orderBy: { createdAt: "desc" },
    include: { renewedBy: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    previousStartDate: isoDay(r.previousStartDate),
    previousEndDate: isoDay(r.previousEndDate),
    newStartDate: isoDay(r.newStartDate),
    newEndDate: isoDay(r.newEndDate),
    at: r.createdAt,
    by: r.renewedBy?.name ?? null,
    note: r.note,
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// What a reminder / alert says about a contract
// ---------------------------------------------------------------------------------------------------------------------

/** The site name(s) a customer contract applies to: the distinct names of the sites of its covered units, else its free-text location. */
export function customerAmcSiteName(o: { location?: string | null; units?: Array<{ unit?: { site?: { companyName?: string | null } | null } | null }> }): string | null {
  const names = [...new Set((o.units ?? []).map((u) => u.unit?.site?.companyName?.trim()).filter((n): n is string => !!n))];
  return names.length ? names.join(", ") : o.location?.trim() || null;
}

/**
 * The facts every expiry reminder carries (type, customer, site, vendor, expiry date, days remaining, where to act). Customer and vendor
 * contracts use the same shape; the vendor's name is only ever in `vendorName`, and `customerName` is the customer the contract applies to
 * (null when a vendor contract is a general one). `poNo` is kept as the contract reference for older templates.
 */
export function amcReminderData(c: {
  kind: AmcParty;
  ref: string;
  customerName?: string | null;
  siteName?: string | null;
  vendorName?: string | null;
  amcType?: string | null;
  endDate: Date;
  daysRemaining: number;
}) {
  const base = (process.env.ADMIN_WEB_URL || "").replace(/\/$/, "");
  const actionPath = c.kind === AMC_PARTY.VENDOR ? "/vendor-amcs" : "/amc-orders";
  return {
    kind: c.kind,
    amcTypeLabel: AMC_PARTY_LABELS[c.kind],
    amcType: c.amcType ?? null,
    ref: c.ref,
    poNo: c.ref,
    customerName: c.customerName ?? null,
    siteName: c.siteName ?? null,
    vendorName: c.vendorName ?? null,
    expiryDate: c.endDate.toISOString(),
    daysRemaining: c.daysRemaining,
    actionPath,
    actionUrl: base ? `${base}${actionPath}` : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Login-time alerts
// ---------------------------------------------------------------------------------------------------------------------

export interface AmcAlert {
  key: string;
  kind: AmcParty;
  id: string;
  ref: string;
  partyName: string;
  /** The customer and site the contract applies to (customer AMC: its customer; vendor AMC: only when one was recorded). */
  customerName: string | null;
  siteName: string | null;
  amcType: string | null;
  startDate: string;
  endDate: string;
  status: "expiring_soon" | "expired";
  daysRemaining: number;
}

const MAX_ALERTS = 50;

/**
 * Contracts the caller may see that are expiring soon (inside the configured window) or already expired, and not yet marked acquired.
 *  - staff holding the AMC permission: customer AND vendor contracts;
 *  - a customer login: that customer's own contracts only;
 *  - a vendor login: that vendor's own contracts only;
 *  - everyone else: nothing.
 * A contract's `key` includes its end date and status, so a renewed contract (new end date) is a new alert and an unchanged one is not.
 */
export async function buildAmcAlerts(
  auth: { permissions: Set<string>; customerId?: string | null; vendorId?: string | null },
  now: Date = new Date(),
): Promise<{ alerts: AmcAlert[]; truncated: boolean; leadDays: number }> {
  const policy = await loadAmcPolicy();
  const staff = auth.permissions.has(PERMISSION_KEY.MANAGE_AMC_ORDERS);
  const wantCustomer = staff || !!auth.customerId;
  const wantVendor = staff || !!auth.vendorId;
  const alerts: AmcAlert[] = [];

  if (wantCustomer) {
    const orders = await prisma.amcOrder.findMany({
      where: { expiryReminderClearedAt: null, ...(staff ? {} : { customerId: auth.customerId! }) },
      include: { customer: { select: { name: true } }, units: { select: { unit: { select: { site: { select: { companyName: true } } } } } } },
    });
    for (const o of orders) {
      const d = describeContract(o, policy, now);
      if (d.contractStatus !== "expiring_soon" && d.contractStatus !== "expired") continue;
      alerts.push({ key: `customer:${o.id}:${d.endDate}:${d.contractStatus}`, kind: "customer", id: o.id, ref: o.poNo, partyName: o.customer.name, customerName: o.customer.name, siteName: customerAmcSiteName(o), amcType: o.amcType, startDate: d.startDate, endDate: d.endDate, status: d.contractStatus, daysRemaining: d.daysRemaining });
    }
  }
  if (wantVendor) {
    const contracts = await prisma.vendorAmc.findMany({
      where: { expiryReminderClearedAt: null, ...(staff ? {} : { vendorId: auth.vendorId! }) },
      include: { vendor: { select: { name: true } }, customer: { select: { name: true } }, site: { select: { companyName: true } } },
    });
    for (const c of contracts) {
      const d = describeContract(c, policy, now);
      if (d.contractStatus !== "expiring_soon" && d.contractStatus !== "expired") continue;
      alerts.push({ key: `vendor:${c.id}:${d.endDate}:${d.contractStatus}`, kind: "vendor", id: c.id, ref: c.contractRef ?? c.title, partyName: c.vendor.name, customerName: c.customer?.name ?? null, siteName: c.site?.companyName ?? null, amcType: null, startDate: d.startDate, endDate: d.endDate, status: d.contractStatus, daysRemaining: d.daysRemaining });
    }
  }
  alerts.sort((a, b) => a.endDate.localeCompare(b.endDate));
  return { alerts: alerts.slice(0, MAX_ALERTS), truncated: alerts.length > MAX_ALERTS, leadDays: policy.reminderLeadDays };
}

// ---------------------------------------------------------------------------------------------------------------------
// Scheduled expiry reminders (the existing job, now using explicit dates and the configured timing)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sends the expiry reminders that are due and records them. Behaviour is unchanged by default (30 days before the end date, repeated
 * every 3 days, to everyone holding the AMC permission, until the contract is marked acquired) - but the dates are the contract's
 * explicit dates and the timing comes from the settings. The `lastExpiryReminderAt` stamp is now taken with a conditional update
 * BEFORE sending, so two overlapping runs cannot both send the same reminder.
 */
export async function runAmcExpiryReminders(now: Date = new Date()) {
  const policy = await loadAmcPolicy();
  const recipients = await prisma.user.findMany({
    where: { isActive: true, role: { permissions: { some: { permission: { key: PERMISSION_KEY.MANAGE_AMC_ORDERS } } } } },
    select: { id: true },
  });
  const staleBefore = new Date(now.getTime() - policy.reminderRepeatDays * 24 * 3600 * 1000);
  const claimable = (id: string) => ({ id, expiryReminderClearedAt: null, OR: [{ lastExpiryReminderAt: null }, { lastExpiryReminderAt: { lte: staleBefore } }] });

  /** Sends to every recipient; true only when at least one E-MAIL was accepted by the provider (the in-app row is a log, WhatsApp / Telegram are stubs). */
  const notify = async (data: Record<string, unknown>): Promise<boolean> => {
    const results = await Promise.all(
      recipients.map((r) => sendNotification({ recipientId: r.id, templateKey: "amc_expiry_reminder", data, channels: ["in_app", "email", "whatsapp", "telegram"] }).catch((err) => { console.error("AMC reminder failed", err); return []; })),
    );
    return results.flat().some((row) => row.channel === "email" && row.status === "sent");
  };

  let customerSent = 0;
  const orders = await prisma.amcOrder.findMany({
    where: { expiryReminderClearedAt: null },
    include: { customer: { select: { name: true } }, units: { select: { unit: { select: { site: { select: { companyName: true } } } } } } },
  });
  for (const o of orders) {
    const period = effectivePeriod(o);
    if (!amcReminderDue(period.end, o, now, policy)) continue;
    const claimed = await prisma.amcOrder.updateMany({ where: claimable(o.id), data: { lastExpiryReminderAt: now } });
    if (claimed.count !== 1) continue; // another run took it
    const { daysRemaining } = amcContractStatus(period, now, policy.reminderLeadDays);
    const delivered = await notify(amcReminderData({ kind: AMC_PARTY.CUSTOMER, ref: o.poNo, customerName: o.customer.name, siteName: customerAmcSiteName(o), amcType: o.amcType, endDate: period.end, daysRemaining }));
    if (recipients.length > 0 && !delivered) {
      // Nothing was accepted: give the claim back so the next run retries instead of waiting a whole repeat interval.
      await prisma.amcOrder.updateMany({ where: { id: o.id, lastExpiryReminderAt: now }, data: { lastExpiryReminderAt: o.lastExpiryReminderAt } });
      continue;
    }
    customerSent++;
  }

  let vendorSent = 0;
  const contracts = await prisma.vendorAmc.findMany({
    where: { expiryReminderClearedAt: null },
    include: { vendor: { select: { name: true } }, customer: { select: { name: true } }, site: { select: { companyName: true } } },
  });
  for (const c of contracts) {
    const period = effectivePeriod({ poDate: c.startDate, startDate: c.startDate, endDate: c.endDate });
    if (!amcReminderDue(period.end, c, now, policy)) continue;
    const claimed = await prisma.vendorAmc.updateMany({ where: claimable(c.id), data: { lastExpiryReminderAt: now } });
    if (claimed.count !== 1) continue;
    const { daysRemaining } = amcContractStatus(period, now, policy.reminderLeadDays);
    const delivered = await notify(amcReminderData({ kind: AMC_PARTY.VENDOR, ref: c.contractRef ?? c.title, customerName: c.customer?.name, siteName: c.site?.companyName, vendorName: c.vendor.name, endDate: period.end, daysRemaining }));
    if (recipients.length > 0 && !delivered) {
      await prisma.vendorAmc.updateMany({ where: { id: c.id, lastExpiryReminderAt: now }, data: { lastExpiryReminderAt: c.lastExpiryReminderAt } });
      continue;
    }
    vendorSent++;
  }
  return { remindersSent: customerSent, vendorRemindersSent: vendorSent, recipients: recipients.length, now: toDateOnly(now) };
}
