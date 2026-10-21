import test from "node:test";
import assert from "node:assert/strict";
import {
  AMC_DEFAULTS,
  AMC_PARTY,
  AMC_PARTY_LABELS,
  addMonths,
  amcContractStatus,
  amcReminderDue,
  amcSettingsSchema,
  createAmcOrderSchema,
  createVendorAmcSchema,
  defaultEndDate,
  effectivePeriod,
  isoDay,
  legacyExpiryDate,
  parseDay,
  planNewPeriod,
  planRenewal,
  renewAmcSchema,
  resolveAmcPolicy,
  updateAmcOrderSchema,
  updateVendorAmcSchema,
} from "../src";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

test("defaults preserve the old behaviour: 12 months, 30 days before the end, every 3 days", () => {
  assert.deepEqual(resolveAmcPolicy(null), { durationMonths: 12, reminderLeadDays: 30, reminderRepeatDays: 3 });
  assert.deepEqual(resolveAmcPolicy({ amcDefaultDurationMonths: null, amcReminderLeadDays: null, amcReminderRepeatDays: null }), { durationMonths: AMC_DEFAULTS.DURATION_MONTHS, reminderLeadDays: 30, reminderRepeatDays: 3 });
  assert.deepEqual(resolveAmcPolicy({ amcDefaultDurationMonths: 6, amcReminderLeadDays: 45, amcReminderRepeatDays: 7 }), { durationMonths: 6, reminderLeadDays: 45, reminderRepeatDays: 7 });
});

test("calendar maths: month clamping, inclusive default end date, leap days", () => {
  assert.equal(isoDay(addMonths(d("2026-01-31"), 1)), "2026-02-28");
  assert.equal(isoDay(addMonths(d("2024-01-31"), 1)), "2024-02-29");
  assert.equal(isoDay(defaultEndDate(d("2026-03-01"), 12)), "2027-02-28");
  assert.equal(isoDay(defaultEndDate(d("2026-01-15"), 12)), "2027-01-14");
  assert.equal(isoDay(legacyExpiryDate(d("2024-02-29"))), "2025-02-28", "Feb 29 + 1 year clamps to Feb 28 (the SQL backfill does the same)");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("2026-13-01"), null);
  assert.equal(parseDay("26-01-01"), null);
  assert.equal(isoDay(parseDay("2026-02-28")!), "2026-02-28");
});

test("effectivePeriod: explicit dates win; a contract without them keeps the legacy PO date + 1 year", () => {
  const explicit = effectivePeriod({ poDate: d("2026-01-01"), startDate: d("2026-03-01"), endDate: d("2027-02-28") });
  assert.deepEqual([isoDay(explicit.start), isoDay(explicit.end), explicit.source], ["2026-03-01", "2027-02-28", "explicit"]);
  const legacy = effectivePeriod({ poDate: d("2026-01-01"), startDate: null, endDate: null });
  assert.deepEqual([isoDay(legacy.start), isoDay(legacy.end), legacy.source], ["2026-01-01", "2027-01-01", "legacy_po_date"]);
});

test("status: upcoming / active / expiring soon / expired, with the boundaries", () => {
  const period = { start: d("2026-01-01"), end: d("2026-12-31") };
  const at = (s: string, lead = 30) => amcContractStatus(period, d(s), lead);
  assert.equal(at("2025-12-31").status, "upcoming");
  assert.equal(at("2026-01-01").status, "active");
  assert.equal(at("2026-11-30").status, "active", "31 days left is not yet inside a 30-day window");
  assert.equal(at("2026-12-01").daysRemaining, 30);
  assert.equal(at("2026-12-01").status, "expiring_soon");
  assert.equal(at("2026-12-31").status, "expiring_soon");
  assert.equal(at("2026-12-31").daysRemaining, 0);
  assert.equal(at("2027-01-01").status, "expired");
  assert.equal(at("2027-01-01").daysRemaining, -1);
  assert.equal(at("2026-06-01").status, "active");
  assert.equal(at("2026-06-01", 365).status, "expiring_soon", "the window is configurable");
  // renewed in advance: the old period still covers today but the new one has not started
  const renewed = { start: d("2027-01-01"), end: d("2027-12-31") };
  assert.equal(amcContractStatus(renewed, d("2026-12-15"), 30, d("2026-12-31")).status, "renewed");
  assert.equal(amcContractStatus(renewed, d("2026-12-31"), 30, d("2026-12-31")).status, "renewed", "the old end date itself is still covered");
  assert.equal(amcContractStatus(renewed, d("2027-01-01"), 30, d("2026-12-31")).status, "active", "once the new period starts it is simply active");
  assert.equal(amcContractStatus(renewed, d("2026-12-15"), 30, null).status, "upcoming", "a contract that was never renewed is just upcoming");
  assert.equal(amcContractStatus(renewed, d("2026-12-15"), 30, d("2026-12-01")).status, "upcoming", "a renewal whose old period already ended does not cover today");
});

test("reminder timing: starts at the lead, repeats at the interval, stops when acquired; configurable", () => {
  const end = d("2026-12-31");
  const none = { lastExpiryReminderAt: null, expiryReminderClearedAt: null };
  const policy = { reminderLeadDays: 30, reminderRepeatDays: 3 };
  assert.equal(amcReminderDue(end, none, d("2026-11-30"), policy), false, "31 days out: too early");
  assert.equal(amcReminderDue(end, none, d("2026-12-01"), policy), true, "30 days out: first reminder");
  const sent = new Date("2026-12-01T06:00:00Z");
  assert.equal(amcReminderDue(end, { ...none, lastExpiryReminderAt: sent }, new Date("2026-12-04T05:59:00Z"), policy), false, "under 3 days since the last");
  assert.equal(amcReminderDue(end, { ...none, lastExpiryReminderAt: sent }, new Date("2026-12-04T06:00:00Z"), policy), true);
  assert.equal(amcReminderDue(end, { lastExpiryReminderAt: null, expiryReminderClearedAt: new Date() }, d("2027-03-01"), policy), false, "acquired: never again");
  assert.equal(amcReminderDue(end, none, d("2026-11-15"), { reminderLeadDays: 60, reminderRepeatDays: 3 }), true, "configured lead");
});

test("planNewPeriod: explicit dates, or start + months; start defaults to the PO date", () => {
  const ok = (r: ReturnType<typeof planNewPeriod>) => (r.ok ? [isoDay(r.newStart), isoDay(r.newEnd)] : r.error);
  assert.deepEqual(ok(planNewPeriod({}, d("2026-05-10"), 12)), ["2026-05-10", "2027-05-09"]);
  assert.deepEqual(ok(planNewPeriod({ startDate: "2026-06-01", durationMonths: 6 }, d("2026-05-10"), 12)), ["2026-06-01", "2026-11-30"]);
  assert.deepEqual(ok(planNewPeriod({ startDate: "2026-06-01", endDate: "2026-08-31" }, d("2026-05-10"), 12)), ["2026-06-01", "2026-08-31"]);
  assert.match(String(ok(planNewPeriod({ startDate: "2026-06-01", endDate: "2026-06-01" }, d("2026-05-10"), 12))), /after the start/);
  assert.match(String(ok(planNewPeriod({ startDate: "2026-06-01", endDate: "2026-05-01" }, d("2026-05-10"), 12))), /after the start/);
  assert.match(String(ok(planNewPeriod({ startDate: "2026-02-30" }, d("2026-05-10"), 12))), /real calendar date/);
});

test("planRenewal: continues the day after the old end; never overlaps; honours explicit dates and duration", () => {
  const prev = { start: d("2026-01-01"), end: d("2026-12-31") };
  const ok = (r: ReturnType<typeof planRenewal>) => (r.ok ? [isoDay(r.newStart), isoDay(r.newEnd)] : r.error);
  assert.deepEqual(ok(planRenewal(prev, {}, 12)), ["2027-01-01", "2027-12-31"]);
  assert.deepEqual(ok(planRenewal(prev, { durationMonths: 6 }, 12)), ["2027-01-01", "2027-06-30"]);
  assert.deepEqual(ok(planRenewal(prev, { newStartDate: "2027-02-01", newEndDate: "2028-01-31" }, 12)), ["2027-02-01", "2028-01-31"]);
  assert.match(String(ok(planRenewal(prev, { newStartDate: "2026-12-31" }, 12))), /must start after/);
  assert.match(String(ok(planRenewal(prev, { newStartDate: "2026-06-01" }, 12))), /must start after/, "overlap refused");
  assert.match(String(ok(planRenewal(prev, { newEndDate: "2027-01-01" }, 12))), /after the new start/);
});

test("schemas: create customer AMC takes optional dates or duration, never both end date and duration", () => {
  const base = { poNo: "PO-1", poDate: "2026-01-01T00:00:00.000Z", customerId: "c1", location: "L", item: "I", qty: 1, amcFrequencyPerYear: 4, amcType: "camc" };
  assert.equal(createAmcOrderSchema.safeParse(base).success, true, "legacy clients that send no dates still work");
  assert.equal(createAmcOrderSchema.safeParse({ ...base, startDate: "2026-02-01", endDate: "2027-01-31" }).success, true);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, durationMonths: 24 }).success, true);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, endDate: "2027-01-31", durationMonths: 24 }).success, false);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, startDate: "01/02/2026" }).success, false);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, durationMonths: 0 }).success, false);
  assert.equal(createAmcOrderSchema.safeParse({ ...base, durationMonths: 121 }).success, false);
});

test("schemas: editing dates needs a reason; nothing-to-change is refused", () => {
  assert.equal(updateAmcOrderSchema.safeParse({ location: "New" }).success, true);
  assert.equal(updateAmcOrderSchema.safeParse({ endDate: "2027-03-31" }).success, false);
  assert.equal(updateAmcOrderSchema.safeParse({ endDate: "2027-03-31", reason: "typo in PO" }).success, true);
  assert.equal(updateAmcOrderSchema.safeParse({}).success, false);
  assert.equal(updateAmcOrderSchema.safeParse({ reason: "only a reason" }).success, false);
  assert.equal(updateVendorAmcSchema.safeParse({ startDate: "2026-01-01" }).success, false);
  assert.equal(updateVendorAmcSchema.safeParse({ title: "x" }).success, true);
});

test("schemas: renewal needs the expected end date; vendor contract needs vendor, title, start; settings are bounded", () => {
  assert.equal(renewAmcSchema.safeParse({}).success, false);
  assert.equal(renewAmcSchema.safeParse({ expectedEndDate: "2026-12-31" }).success, true);
  assert.equal(renewAmcSchema.safeParse({ expectedEndDate: "2026-12-31", newEndDate: "2028-01-01", durationMonths: 6 }).success, false);
  assert.equal(createVendorAmcSchema.safeParse({ vendorId: "v1", title: "Cooling AMC", startDate: "2026-01-01" }).success, true);
  assert.equal(createVendorAmcSchema.safeParse({ vendorId: "v1", title: "", startDate: "2026-01-01" }).success, false);
  assert.equal(createVendorAmcSchema.safeParse({ vendorId: "v1", title: "x" }).success, false);
  assert.equal(amcSettingsSchema.safeParse({ amcDefaultDurationMonths: null, amcReminderLeadDays: null, amcReminderRepeatDays: null }).success, true);
  assert.equal(amcSettingsSchema.safeParse({ amcDefaultDurationMonths: 0, amcReminderLeadDays: 30, amcReminderRepeatDays: 3 }).success, false);
  assert.equal(amcSettingsSchema.safeParse({ amcDefaultDurationMonths: 12, amcReminderLeadDays: -1, amcReminderRepeatDays: 3 }).success, false);
  assert.equal(amcSettingsSchema.safeParse({ amcDefaultDurationMonths: 12, amcReminderLeadDays: 30, amcReminderRepeatDays: 0 }).success, false);
  assert.equal(amcSettingsSchema.safeParse({ amcDefaultDurationMonths: 12.5, amcReminderLeadDays: 30, amcReminderRepeatDays: 3 }).success, false);
});

test("vendor AMC schemas: customer and site are optional, a site needs its customer, and the kinds have their own labels", () => {
  const base = { vendorId: "v1", title: "Support", startDate: "2026-02-01", durationMonths: 12 };
  assert.equal(createVendorAmcSchema.safeParse(base).success, true, "a general agreement with the vendor");
  assert.equal(createVendorAmcSchema.safeParse({ ...base, customerId: "c1" }).success, true);
  assert.equal(createVendorAmcSchema.safeParse({ ...base, customerId: "c1", siteId: "s1" }).success, true);
  const noCustomer = createVendorAmcSchema.safeParse({ ...base, siteId: "s1" });
  assert.equal(noCustomer.success, false);
  assert.equal(createVendorAmcSchema.safeParse({ ...base, customerId: "" }).success, false, "an empty id is not 'none'");
  assert.equal(updateVendorAmcSchema.safeParse({ customerId: null }).success, true, "null clears");
  assert.equal(updateVendorAmcSchema.safeParse({ siteId: null }).success, true);
  assert.equal(updateVendorAmcSchema.safeParse({}).success, false, "nothing to change");
  assert.deepEqual([AMC_PARTY_LABELS[AMC_PARTY.CUSTOMER], AMC_PARTY_LABELS[AMC_PARTY.VENDOR]], ["Customer AMC", "Vendor AMC"]);
});
