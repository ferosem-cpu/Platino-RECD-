import { z } from "zod";

/**
 * AMC contract periods, status, renewals and reminder timing (Requirement 7) - shared so the API, the scheduled job, the login
 * notice and the screens agree.
 *
 * DATE CONVENTIONS (the same as service due dates in serviceReminder.ts)
 *  - A contract period is two calendar DATES, stored as UTC-midnight DATE values: `startDate` .. `endDate`, both INCLUSIVE
 *    (the contract is in force on its end date and expired from the next day).
 *  - "Today" is the UTC calendar day. Nothing here uses local time.
 *  - New contracts default to `startDate + duration months - 1 day` (12 months from 1 Oct = 30 Sep). LEGACY contracts that only
 *    had a PO date keep the old rule - expiry = PO date + 1 year (same calendar date) - so their effective dates do not move.
 *
 * ASSUMPTIONS (documented, not invented policy): an AMC "vendor" contract is a maintenance agreement with one of our existing
 * Vendors (kept in its own table, never mixed with customer AMCs); a renewal EXTENDS the same contract (same row, same units
 * and reports) and keeps the old period in history, while creating a separate contract is the existing "create order" flow.
 */

export const AMC_DEFAULTS = {
  /** Compatible with the old behaviour: a contract ran one year from its PO date. */
  DURATION_MONTHS: 12,
  /** Compatible with the old behaviour: reminders started 30 days (the old "1 month") before expiry. */
  REMINDER_LEAD_DAYS: 30,
  /** Compatible with the old behaviour: repeated every 3 days until the contract was marked acquired / renewed. */
  REMINDER_REPEAT_DAYS: 3,
} as const;

/** RENEWED = renewed before it ended: the old period still covers today and the renewed period has not started yet. */
export const AMC_CONTRACT_STATUS = { UPCOMING: "upcoming", ACTIVE: "active", EXPIRING_SOON: "expiring_soon", EXPIRED: "expired", RENEWED: "renewed" } as const;
export type AmcContractStatus = (typeof AMC_CONTRACT_STATUS)[keyof typeof AMC_CONTRACT_STATUS];
export const AMC_CONTRACT_STATUS_LABELS: Record<string, string> = {
  upcoming: "Upcoming",
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired",
  renewed: "Renewed",
};

/** Where a contract's dates came from: typed in (explicit) or derived from the PO date (legacy). */
export const AMC_DATES_SOURCE = { EXPLICIT: "explicit", LEGACY_PO_DATE: "legacy_po_date" } as const;
export const AMC_RENEWAL_KIND = { RENEWAL: "renewal", CORRECTION: "correction" } as const;
export const AMC_PARTY = { CUSTOMER: "customer", VENDOR: "vendor" } as const;
/** The two kinds of AMC agreement, as shown to people: ours with a customer, ours with a vendor. Not the CAMC / NAMC class (AmcOrder.amcType). */
export const AMC_PARTY_LABELS: Record<(typeof AMC_PARTY)[keyof typeof AMC_PARTY], string> = { customer: "Customer AMC", vendor: "Vendor AMC" };

const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Calendar-date helpers (UTC, whole days)
// ---------------------------------------------------------------------------------------------------------------------

export const toDateOnly = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number): Date => new Date(toDateOnly(d).getTime() + n * DAY_MS);
export const daysBetween = (from: Date, to: Date): number => Math.round((toDateOnly(to).getTime() - toDateOnly(from).getTime()) / DAY_MS);

/** Adds calendar months, clamping the day to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, months: number): Date {
  const base = toDateOnly(d);
  const total = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(base.getUTCDate(), lastDay)));
}

/** "YYYY-MM-DD" that is a real calendar date, else null. */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && isoDay(d) === value ? d : null;
}

/** The end date of a new period: `months` from the start, minus one day (the end date is inclusive). */
export const defaultEndDate = (start: Date, months: number): Date => addDays(addMonths(start, months), -1);

/** The legacy rule (kept for existing contracts): expiry = PO date + 1 year, same calendar date. */
export const legacyExpiryDate = (poDate: Date): Date => addMonths(poDate, 12);

// ---------------------------------------------------------------------------------------------------------------------
// Effective period, status and reminder timing
// ---------------------------------------------------------------------------------------------------------------------

export interface AmcPeriod {
  start: Date;
  end: Date;
  source: "explicit" | "legacy_po_date";
}

/**
 * The contract's period. Explicit dates win; a contract without them (created by older code, or before the explicit-date migration
 * reached it) falls back to the legacy rule so its effective dates never change silently.
 */
export function effectivePeriod(c: { poDate: Date; startDate?: Date | null; endDate?: Date | null }): AmcPeriod {
  if (c.startDate && c.endDate) return { start: toDateOnly(c.startDate), end: toDateOnly(c.endDate), source: "explicit" };
  return { start: toDateOnly(c.poDate), end: legacyExpiryDate(c.poDate), source: "legacy_po_date" };
}

export interface AmcPolicy {
  durationMonths: number;
  reminderLeadDays: number;
  reminderRepeatDays: number;
}

/** The configured values, falling back to the compatible defaults where a setting is empty. */
export function resolveAmcPolicy(s: { amcDefaultDurationMonths?: number | null; amcReminderLeadDays?: number | null; amcReminderRepeatDays?: number | null } | null | undefined): AmcPolicy {
  return {
    durationMonths: s?.amcDefaultDurationMonths ?? AMC_DEFAULTS.DURATION_MONTHS,
    reminderLeadDays: s?.amcReminderLeadDays ?? AMC_DEFAULTS.REMINDER_LEAD_DAYS,
    reminderRepeatDays: s?.amcReminderRepeatDays ?? AMC_DEFAULTS.REMINDER_REPEAT_DAYS,
  };
}

/**
 * upcoming (not started) | renewed (renewed in advance: the previous period still covers today, `renewedUntil` is its end) | expired (end
 * date passed) | expiring_soon (end date within `leadDays`, today counts) | active.
 * `daysRemaining` is days until the end date (0 on the end date itself, negative once expired).
 */
export function amcContractStatus(period: { start: Date; end: Date }, now: Date, leadDays: number, renewedUntil?: Date | null): { status: AmcContractStatus; daysRemaining: number } {
  const today = toDateOnly(now);
  const daysRemaining = daysBetween(today, period.end);
  if (today.getTime() < period.start.getTime()) {
    const covered = !!renewedUntil && toDateOnly(renewedUntil).getTime() >= today.getTime();
    return { status: covered ? AMC_CONTRACT_STATUS.RENEWED : AMC_CONTRACT_STATUS.UPCOMING, daysRemaining };
  }
  if (daysRemaining < 0) return { status: AMC_CONTRACT_STATUS.EXPIRED, daysRemaining };
  if (daysRemaining <= leadDays) return { status: AMC_CONTRACT_STATUS.EXPIRING_SOON, daysRemaining };
  return { status: AMC_CONTRACT_STATUS.ACTIVE, daysRemaining };
}

/**
 * Is an expiry reminder due now? Same behaviour as before, but with configurable timing: from `leadDays` before the end date, every
 * `repeatDays`, until the contract is marked acquired (cleared) or renewed (renewal clears the reminder state).
 */
export function amcReminderDue(
  end: Date,
  state: { lastExpiryReminderAt: Date | null; expiryReminderClearedAt: Date | null },
  now: Date,
  policy: { reminderLeadDays: number; reminderRepeatDays: number },
): boolean {
  if (state.expiryReminderClearedAt) return false;
  if (toDateOnly(now).getTime() < addDays(end, -policy.reminderLeadDays).getTime()) return false;
  if (!state.lastExpiryReminderAt) return true;
  return now.getTime() - state.lastExpiryReminderAt.getTime() >= policy.reminderRepeatDays * DAY_MS;
}

// ---------------------------------------------------------------------------------------------------------------------
// Renewal planning (pure; the API applies it inside a transaction)
// ---------------------------------------------------------------------------------------------------------------------

export interface RenewalInput {
  newStartDate?: string;
  newEndDate?: string;
  durationMonths?: number;
}

export type RenewalPlan = { ok: true; newStart: Date; newEnd: Date } | { ok: false; error: string };

/**
 * The renewed period. Defaults: it starts the day after the old end date and lasts `durationMonths` (the configured default when
 * not given). It may start later (a lapsed contract renewed late) but may NOT overlap or precede the period it renews.
 */
export function planRenewal(previous: { start: Date; end: Date }, input: RenewalInput, defaultDurationMonths: number): RenewalPlan {
  const start = input.newStartDate ? parseDay(input.newStartDate) : addDays(previous.end, 1);
  if (!start) return { ok: false, error: "Enter the new start date as a real calendar date (YYYY-MM-DD)" };
  if (start.getTime() <= previous.end.getTime()) return { ok: false, error: `The renewed period must start after the current end date (${isoDay(previous.end)})` };
  let end: Date | null;
  if (input.newEndDate) {
    end = parseDay(input.newEndDate);
    if (!end) return { ok: false, error: "Enter the new end date as a real calendar date (YYYY-MM-DD)" };
  } else {
    end = defaultEndDate(start, input.durationMonths ?? defaultDurationMonths);
  }
  if (end.getTime() <= start.getTime()) return { ok: false, error: "The new end date must be after the new start date" };
  return { ok: true, newStart: start, newEnd: end };
}

/** A new contract's period from what the request gave: explicit dates, or a start plus a duration. */
export function planNewPeriod(input: { startDate?: string; endDate?: string; durationMonths?: number }, fallbackStart: Date, defaultDurationMonths: number): RenewalPlan {
  const start = input.startDate ? parseDay(input.startDate) : toDateOnly(fallbackStart);
  if (!start) return { ok: false, error: "Enter the start date as a real calendar date (YYYY-MM-DD)" };
  let end: Date | null;
  if (input.endDate) {
    end = parseDay(input.endDate);
    if (!end) return { ok: false, error: "Enter the end date as a real calendar date (YYYY-MM-DD)" };
  } else {
    end = defaultEndDate(start, input.durationMonths ?? defaultDurationMonths);
  }
  if (end.getTime() <= start.getTime()) return { ok: false, error: "The end date must be after the start date" };
  return { ok: true, newStart: start, newEnd: end };
}

// ---------------------------------------------------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------------------------------------------------

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD").refine((v) => parseDay(v) !== null, "Enter a real calendar date");
const duration = z.number().int().min(1).max(120);

export const amcDurationFields = {
  startDate: dayString.optional(),
  endDate: dayString.optional(),
  durationMonths: duration.optional(),
};

/** An explicit end date and a duration together are ambiguous. */
export const eitherEndOrDuration = (v: { endDate?: string; durationMonths?: number }) => !(v.endDate !== undefined && v.durationMonths !== undefined);
export const EITHER_END_OR_DURATION_MESSAGE = "Give an end date or a duration in months, not both";

export const updateAmcOrderSchema = z
  .object({
    location: z.string().min(1).optional(),
    item: z.string().min(1).optional(),
    qty: z.number().int().positive().optional(),
    amcFrequencyPerYear: z.number().int().positive().optional(),
    amcType: z.enum(["camc", "namc"]).optional(),
    startDate: dayString.optional(),
    endDate: dayString.optional(),
    /** Why the dates are being corrected (kept in the contract's history). Required when a date changes. */
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "reason" && (v as Record<string, unknown>)[k] !== undefined), { message: "Nothing to change" })
  .refine((v) => (v.startDate === undefined && v.endDate === undefined) || !!v.reason, { message: "Give a reason for changing the contract dates", path: ["reason"] });

export const renewAmcSchema = z
  .object({
    /** The end date the caller believes is current. A renewal is refused if the contract moved on (double submit, another user). */
    expectedEndDate: dayString,
    newStartDate: dayString.optional(),
    newEndDate: dayString.optional(),
    durationMonths: duration.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => eitherEndOrDuration({ endDate: v.newEndDate, durationMonths: v.durationMonths }), { message: EITHER_END_OR_DURATION_MESSAGE });

export const createVendorAmcSchema = z
  .object({
    vendorId: z.string().min(1),
    /** The vendor's own reference for the agreement (optional). */
    contractRef: z.string().trim().max(100).optional(),
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(1000).optional(),
    /** Where the vendor's support applies (optional). A site needs its customer; that the site belongs to the customer is checked by the API. */
    customerId: z.string().min(1).optional(),
    siteId: z.string().min(1).optional(),
    startDate: dayString,
    endDate: dayString.optional(),
    durationMonths: duration.optional(),
  })
  .refine(eitherEndOrDuration, { message: EITHER_END_OR_DURATION_MESSAGE })
  .refine((v) => !v.siteId || !!v.customerId, { message: "Choose the customer the site belongs to", path: ["customerId"] });

export const updateVendorAmcSchema = z
  .object({
    contractRef: z.string().trim().max(100).nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    /** undefined = keep, null = clear. Changing the customer clears the site unless a new site is sent with it. */
    customerId: z.string().min(1).nullable().optional(),
    siteId: z.string().min(1).nullable().optional(),
    startDate: dayString.optional(),
    endDate: dayString.optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "reason" && (v as Record<string, unknown>)[k] !== undefined), { message: "Nothing to change" })
  .refine((v) => (v.startDate === undefined && v.endDate === undefined) || !!v.reason, { message: "Give a reason for changing the contract dates", path: ["reason"] });

/** AMC reminder / duration settings. null = use the compatible default (12 months, 30 days, every 3 days). */
export const amcSettingsSchema = z.object({
  amcDefaultDurationMonths: z.number().int().min(1).max(120).nullable(),
  amcReminderLeadDays: z.number().int().min(0).max(365).nullable(),
  amcReminderRepeatDays: z.number().int().min(1).max(90).nullable(),
});
