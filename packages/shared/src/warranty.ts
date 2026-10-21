/**
 * RECD unit warranty (Requirement 8): one shared place for the warranty period rules and the status, so the API, the web app and the
 * reminder job can never disagree. Dates are calendar days (UTC, date-only) and the expiry date is INCLUSIVE:
 *   expiry = start + N calendar months - 1 day   (the warranty is still valid ON the expiry date and is expired the day after).
 * Month-end / leap-year handling is the R7 `addMonths` (31 Jan + 1 month = 28/29 Feb). Nothing here invents a start date: a unit
 * without dates is UNKNOWN, never active.
 */
import { z } from "zod";
import { daysBetween, defaultEndDate, isoDay, parseDay, toDateOnly } from "./amc";

export const WARRANTY_STATUS = { UNKNOWN: "unknown", UPCOMING: "upcoming", ACTIVE: "active", EXPIRING_SOON: "expiring_soon", EXPIRED: "expired" } as const;
export type WarrantyStatus = (typeof WARRANTY_STATUS)[keyof typeof WARRANTY_STATUS];
export const WARRANTY_STATUS_LABELS: Record<string, string> = {
  unknown: "Not recorded",
  upcoming: "Upcoming",
  active: "Active",
  expiring_soon: "Near Expiry",
  expired: "Expired",
};

/**
 * Where the recorded period came from (provenance):
 *  - manual: a person entered both the start and the expiry date;
 *  - calculated: the expiry was calculated from the entered start and an entered duration;
 *  - product_default: the expiry was calculated from the entered start and the product's configured duration at that time.
 * No source means "no warranty recorded". A start date is never derived from an order, PO, dispatch, delivery or commissioning date.
 */
export const WARRANTY_SOURCE = { MANUAL: "manual", CALCULATED: "calculated", PRODUCT_DEFAULT: "product_default" } as const;
export type WarrantySource = (typeof WARRANTY_SOURCE)[keyof typeof WARRANTY_SOURCE];
export const WARRANTY_SOURCE_LABELS: Record<string, string> = {
  manual: "Entered by staff (start and expiry dates)",
  calculated: "Calculated from the start date and an entered duration",
  product_default: "Calculated from the start date and the product's duration",
};

export const WARRANTY_HISTORY_KIND = { ESTABLISHED: "established", CORRECTION: "correction" } as const;

/** Defaults for the warranty reminder settings (empty setting = this). Chosen to match the AMC expiry reminders; not a separately approved policy. */
export const WARRANTY_DEFAULTS = { REMINDER_LEAD_DAYS: 30, REMINDER_REPEAT_DAYS: 3 } as const;
/** How long after the expiry date an expired warranty still appears in the login notice. */
export const WARRANTY_EXPIRED_NOTICE_DAYS = 30;

export interface WarrantyPolicy {
  reminderLeadDays: number;
  reminderRepeatDays: number;
}

export function resolveWarrantyPolicy(s: { warrantyReminderLeadDays?: number | null; warrantyReminderRepeatDays?: number | null } | null | undefined): WarrantyPolicy {
  return {
    reminderLeadDays: s?.warrantyReminderLeadDays ?? WARRANTY_DEFAULTS.REMINDER_LEAD_DAYS,
    reminderRepeatDays: s?.warrantyReminderRepeatDays ?? WARRANTY_DEFAULTS.REMINDER_REPEAT_DAYS,
  };
}

/** A usable duration: a whole number of months from 1 to 120. */
export const isValidWarrantyMonths = (m: unknown): m is number => typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 120;

export interface WarrantyPeriod {
  start: Date;
  end: Date;
}

/** The recorded period, or null when either date is missing (legacy / not recorded). */
export function warrantyPeriodOf(u: { warrantyStartDate?: Date | null; warrantyEndDate?: Date | null }): WarrantyPeriod | null {
  return u.warrantyStartDate && u.warrantyEndDate ? { start: toDateOnly(u.warrantyStartDate), end: toDateOnly(u.warrantyEndDate) } : null;
}

export interface WarrantyStatusResult {
  status: WarrantyStatus;
  /** Days until the expiry date (0 ON the expiry date) while the warranty has started and is not expired; otherwise null. */
  daysRemaining: number | null;
  /** Days until the warranty starts (upcoming only), otherwise null. */
  daysUntilStart: number | null;
  /** Days since the expiry date (expired only: 1 the day after), otherwise null. */
  daysSinceExpiry: number | null;
}

/**
 * The one status calculation. `leadDays` is the expiring-soon window (days before the expiry date; the expiry date itself counts).
 * UNKNOWN: no period. UPCOMING: today is before the start. EXPIRED: today is after the inclusive expiry date.
 * EXPIRING_SOON: valid, with `daysRemaining <= leadDays`. ACTIVE: valid otherwise.
 */
export function warrantyStatus(period: WarrantyPeriod | null, now: Date, leadDays: number): WarrantyStatusResult {
  if (!period) return { status: WARRANTY_STATUS.UNKNOWN, daysRemaining: null, daysUntilStart: null, daysSinceExpiry: null };
  const today = toDateOnly(now);
  if (today.getTime() < period.start.getTime()) return { status: WARRANTY_STATUS.UPCOMING, daysRemaining: null, daysUntilStart: daysBetween(today, period.start), daysSinceExpiry: null };
  const remaining = daysBetween(today, period.end);
  if (remaining < 0) return { status: WARRANTY_STATUS.EXPIRED, daysRemaining: null, daysUntilStart: null, daysSinceExpiry: -remaining };
  return { status: remaining <= leadDays ? WARRANTY_STATUS.EXPIRING_SOON : WARRANTY_STATUS.ACTIVE, daysRemaining: remaining, daysUntilStart: null, daysSinceExpiry: null };
}

export type WarrantyPlan = { ok: true; start: Date; end: Date; months: number | null; source: WarrantySource } | { ok: false; error: string };

/**
 * Turns what a staff member entered into a validated period. Nothing is adjusted silently:
 *  - start only: the expiry is calculated from the PRODUCT's configured duration (refused if the product has none);
 *  - start + duration: calculated expiry;
 *  - start + expiry: both stored as typed; a duration given as well must agree with them exactly;
 *  - an expiry before the start, an impossible date or a non-positive / fractional / >120 duration is refused.
 */
export function planWarranty(input: { startDate: string; endDate?: string; durationMonths?: number }, productMonths: number | null | undefined): WarrantyPlan {
  const start = parseDay(input.startDate);
  if (!start) return { ok: false, error: "Enter the warranty start date as a real calendar date (YYYY-MM-DD)" };
  if (input.durationMonths !== undefined && !isValidWarrantyMonths(input.durationMonths)) return { ok: false, error: "The duration must be a whole number of months from 1 to 120" };

  if (input.endDate !== undefined) {
    const end = parseDay(input.endDate);
    if (!end) return { ok: false, error: "Enter the warranty expiry date as a real calendar date (YYYY-MM-DD)" };
    if (end.getTime() < start.getTime()) return { ok: false, error: "The warranty expiry date cannot be before the start date" };
    if (input.durationMonths !== undefined && defaultEndDate(start, input.durationMonths).getTime() !== end.getTime()) {
      return { ok: false, error: `The start date, expiry date and duration do not agree: ${input.durationMonths} months from ${input.startDate} ends on ${isoDay(defaultEndDate(start, input.durationMonths))}, not ${input.endDate}. Change one of them.` };
    }
    return { ok: true, start, end, months: input.durationMonths ?? null, source: WARRANTY_SOURCE.MANUAL };
  }
  if (input.durationMonths !== undefined) {
    return { ok: true, start, end: defaultEndDate(start, input.durationMonths), months: input.durationMonths, source: WARRANTY_SOURCE.CALCULATED };
  }
  if (!isValidWarrantyMonths(productMonths)) {
    return { ok: false, error: "This product has no warranty duration configured. Enter the expiry date or a duration in months." };
  }
  return { ok: true, start, end: defaultEndDate(start, productMonths), months: productMonths, source: WARRANTY_SOURCE.PRODUCT_DEFAULT };
}

/** Is a reminder worth sending now? Only for a recorded warranty that has started and has not expired, inside the lead window. */
export function warrantyReminderEligible(period: WarrantyPeriod | null, now: Date, leadDays: number): boolean {
  return warrantyStatus(period, now, leadDays).status === WARRANTY_STATUS.EXPIRING_SOON;
}

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD").refine((v) => parseDay(v) !== null, "Enter a real calendar date");

/** Set or correct a unit's warranty. `expectedEndDate` is the expiry the caller saw (null = none recorded): a stale caller is refused. A reason is needed when a period already exists. */
export const setWarrantySchema = z.object({
  startDate: dayString,
  endDate: dayString.optional(),
  durationMonths: z.number().int().min(1).max(120).optional(),
  expectedEndDate: dayString.nullable(),
  reason: z.string().trim().min(3).max(500).optional(),
});

/** null = use the default (30 days, every 3 days). */
export const warrantySettingsSchema = z.object({
  warrantyReminderLeadDays: z.number().int().min(0).max(365).nullable(),
  warrantyReminderRepeatDays: z.number().int().min(1).max(90).nullable(),
});
