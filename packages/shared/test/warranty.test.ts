import test from "node:test";
import assert from "node:assert/strict";
import {
  WARRANTY_DEFAULTS,
  WARRANTY_EXPIRED_NOTICE_DAYS,
  isoDay,
  planWarranty,
  resolveWarrantyPolicy,
  setWarrantySchema,
  warrantyPeriodOf,
  warrantyReminderEligible,
  warrantySettingsSchema,
  warrantyStatus,
} from "../src";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const P = (s: string, e: string) => ({ start: d(s), end: d(e) });

test("defaults and settings resolution: empty = 30 days / every 3 days; separate from the AMC settings", () => {
  assert.deepEqual(WARRANTY_DEFAULTS, { REMINDER_LEAD_DAYS: 30, REMINDER_REPEAT_DAYS: 3 });
  assert.deepEqual(resolveWarrantyPolicy(null), { reminderLeadDays: 30, reminderRepeatDays: 3 });
  assert.deepEqual(resolveWarrantyPolicy({ warrantyReminderLeadDays: null, warrantyReminderRepeatDays: null }), { reminderLeadDays: 30, reminderRepeatDays: 3 });
  assert.deepEqual(resolveWarrantyPolicy({ warrantyReminderLeadDays: 0, warrantyReminderRepeatDays: 7 }), { reminderLeadDays: 0, reminderRepeatDays: 7 }, "0 days is a real value, not 'empty'");
  assert.equal(WARRANTY_EXPIRED_NOTICE_DAYS, 30);
});

test("period of a unit: both dates or nothing - a half-recorded or empty unit has no period", () => {
  assert.equal(warrantyPeriodOf({}), null);
  assert.equal(warrantyPeriodOf({ warrantyStartDate: d("2026-01-01"), warrantyEndDate: null }), null);
  assert.equal(warrantyPeriodOf({ warrantyStartDate: null, warrantyEndDate: d("2026-12-31") }), null);
  const p = warrantyPeriodOf({ warrantyStartDate: new Date("2026-01-01T13:45:00Z"), warrantyEndDate: d("2026-12-31") })!;
  assert.deepEqual([isoDay(p.start), isoDay(p.end)], ["2026-01-01", "2026-12-31"], "date-only: a time of day never changes the calendar date");
});

test("status: unknown is never active; upcoming / active / expiring soon / expired with the day boundaries", () => {
  const period = P("2026-01-01", "2026-12-31");
  const at = (day: string, lead = 30) => warrantyStatus(period, d(day), lead);
  assert.equal(warrantyStatus(null, d("2026-06-01"), 30).status, "unknown");
  assert.deepEqual(warrantyStatus(null, d("2026-06-01"), 30), { status: "unknown", daysRemaining: null, daysUntilStart: null, daysSinceExpiry: null });
  assert.deepEqual(at("2025-12-31"), { status: "upcoming", daysRemaining: null, daysUntilStart: 1, daysSinceExpiry: null });
  assert.deepEqual(at("2026-01-01"), { status: "active", daysRemaining: 364, daysUntilStart: null, daysSinceExpiry: null }, "valid on the start date");
  assert.equal(at("2026-11-30").status, "active", "31 days left: outside a 30-day window");
  assert.deepEqual([at("2026-12-01").status, at("2026-12-01").daysRemaining], ["expiring_soon", 30], "30 days left: inside the window");
  assert.deepEqual(at("2026-12-31"), { status: "expiring_soon", daysRemaining: 0, daysUntilStart: null, daysSinceExpiry: null }, "ON the expiry date it is still valid (expiring soon, not expired)");
  assert.deepEqual(at("2027-01-01"), { status: "expired", daysRemaining: null, daysUntilStart: null, daysSinceExpiry: 1 }, "expired the day AFTER the inclusive expiry date, with no countdown");
  assert.equal(at("2030-01-01").status, "expired");
  assert.equal(at("2026-06-01", 365).status, "expiring_soon", "the window is configurable");
  assert.equal(at("2026-12-31", 0).status, "expiring_soon", "a 0-day window still flags the expiry day itself");
  assert.equal(at("2026-12-30", 0).status, "active");
});

test("status ignores the time of day and the viewer's time zone", () => {
  const period = P("2026-01-01", "2026-12-31");
  assert.equal(warrantyStatus(period, new Date("2026-12-31T23:59:59Z"), 30).status, "expiring_soon");
  assert.equal(warrantyStatus(period, new Date("2027-01-01T00:00:00Z"), 30).status, "expired");
});

test("reminder eligibility: only a started, unexpired warranty inside the window; never unknown, upcoming or expired", () => {
  const period = P("2026-01-01", "2026-12-31");
  assert.equal(warrantyReminderEligible(period, d("2026-11-30"), 30), false, "outside the window");
  assert.equal(warrantyReminderEligible(period, d("2026-12-01"), 30), true, "entering the window");
  assert.equal(warrantyReminderEligible(period, d("2026-12-31"), 30), true, "on the expiry date");
  assert.equal(warrantyReminderEligible(period, d("2027-01-01"), 30), false, "expired");
  assert.equal(warrantyReminderEligible(null, d("2026-12-15"), 30), false, "unknown dates are excluded");
  assert.equal(warrantyReminderEligible(P("2027-01-01", "2027-12-31"), d("2026-12-15"), 365), false, "upcoming");
});

test("plan: expiry = start + months - 1 day, including month ends and leap years", () => {
  const end = (start: string, months: number) => { const r = planWarranty({ startDate: start, durationMonths: months }, null); return r.ok ? isoDay(r.end) : r.error; };
  assert.equal(end("2026-01-15", 12), "2027-01-14");
  assert.equal(end("2026-03-01", 12), "2027-02-28");
  assert.equal(end("2027-03-01", 12), "2028-02-29", "ends in a leap February");
  assert.equal(end("2024-02-29", 12), "2025-02-27", "29 Feb + 12 months clamps to 28 Feb, minus a day");
  assert.equal(end("2026-01-31", 1), "2026-02-27", "31 Jan + 1 month clamps to 28 Feb, minus a day");
  assert.equal(end("2024-01-31", 1), "2024-02-28", "leap year: 29 Feb minus a day");
  assert.equal(end("2026-05-10", 24), "2028-05-09");
  assert.equal(end("2026-12-01", 1), "2026-12-31");
});

test("plan: the product duration is the default only when valid; the stored months are the effective duration", () => {
  let r = planWarranty({ startDate: "2026-02-01" }, 24);
  assert.deepEqual(r.ok && [isoDay(r.start), isoDay(r.end), r.months, r.source], ["2026-02-01", "2028-01-31", 24, "product_default"]);
  for (const bad of [null, undefined, 0, -3, 1.5, 121]) {
    r = planWarranty({ startDate: "2026-02-01" }, bad as any);
    assert.equal(r.ok, false, String(bad));
    assert.match((r as any).error, /no warranty duration configured/);
  }
  r = planWarranty({ startDate: "2026-02-01", durationMonths: 6 }, 24);
  assert.deepEqual(r.ok && [isoDay(r.end), r.months, r.source], ["2026-07-31", 6, "calculated"], "an entered duration beats the product's");
});

test("plan: manual dates are kept exactly as typed; a duration given too must agree; nothing is adjusted silently", () => {
  let r = planWarranty({ startDate: "2026-02-01", endDate: "2027-03-15" }, 12);
  assert.deepEqual(r.ok && [isoDay(r.end), r.months, r.source], ["2027-03-15", null, "manual"]);
  r = planWarranty({ startDate: "2026-02-01", endDate: "2027-01-31", durationMonths: 12 }, null);
  assert.deepEqual(r.ok && [isoDay(r.end), r.months, r.source], ["2027-01-31", 12, "manual"], "consistent start + expiry + duration is accepted");
  r = planWarranty({ startDate: "2026-02-01", endDate: "2027-02-01", durationMonths: 12 }, null);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /do not agree/);
  r = planWarranty({ startDate: "2026-02-01", endDate: "2026-02-01" }, null);
  assert.equal(r.ok, true, "a one-day period is allowed");
});

test("plan: invalid input is rejected with a message", () => {
  const err = (i: any, m: any = 12) => { const r = planWarranty(i, m); return r.ok ? "OK" : r.error; };
  assert.match(err({ startDate: "2026-02-30" }), /real calendar date/);
  assert.match(err({ startDate: "26-02-01" }), /real calendar date/);
  assert.match(err({ startDate: "2026-02-01", endDate: "2026-13-01" }), /expiry date as a real calendar date/);
  assert.match(err({ startDate: "2026-02-01", endDate: "2026-01-31" }), /cannot be before the start/);
  for (const m of [0, -1, 1.5, 121, NaN]) assert.match(err({ startDate: "2026-02-01", durationMonths: m }), /whole number of months from 1 to 120/, String(m));
});

test("setWarrantySchema: dates are validated, expectedEndDate must be present (null = none recorded), reason is bounded", () => {
  const ok = { startDate: "2026-02-01", expectedEndDate: null };
  assert.equal(setWarrantySchema.safeParse(ok).success, true);
  assert.equal(setWarrantySchema.safeParse({ ...ok, endDate: "2027-01-31", durationMonths: 12, reason: "per commissioning certificate" }).success, true);
  assert.equal(setWarrantySchema.safeParse({ startDate: "2026-02-01" }).success, false, "expectedEndDate is required");
  assert.equal(setWarrantySchema.safeParse({ ...ok, startDate: "2026-02-30" }).success, false);
  assert.equal(setWarrantySchema.safeParse({ ...ok, startDate: "01/02/2026" }).success, false);
  assert.equal(setWarrantySchema.safeParse({ ...ok, durationMonths: 0 }).success, false);
  assert.equal(setWarrantySchema.safeParse({ ...ok, durationMonths: 12.5 }).success, false);
  assert.equal(setWarrantySchema.safeParse({ ...ok, reason: "ab" }).success, false);
  assert.equal(setWarrantySchema.safeParse({ ...ok, expectedEndDate: "2027-02-30" }).success, false);
});

test("warrantySettingsSchema: bounded; null = default", () => {
  assert.equal(warrantySettingsSchema.safeParse({ warrantyReminderLeadDays: null, warrantyReminderRepeatDays: null }).success, true);
  assert.equal(warrantySettingsSchema.safeParse({ warrantyReminderLeadDays: 45, warrantyReminderRepeatDays: 7 }).success, true);
  assert.equal(warrantySettingsSchema.safeParse({ warrantyReminderLeadDays: -1, warrantyReminderRepeatDays: 7 }).success, false);
  assert.equal(warrantySettingsSchema.safeParse({ warrantyReminderLeadDays: 366, warrantyReminderRepeatDays: 7 }).success, false);
  assert.equal(warrantySettingsSchema.safeParse({ warrantyReminderLeadDays: 30, warrantyReminderRepeatDays: 0 }).success, false);
  assert.equal(warrantySettingsSchema.safeParse({ warrantyReminderLeadDays: 30 }).success, false);
});
