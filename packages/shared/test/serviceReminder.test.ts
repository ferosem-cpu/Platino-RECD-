import test from "node:test";
import assert from "node:assert/strict";
import {
  AMC_VISIT_STATUS,
  MAX_REMINDER_ESCALATION_LEVEL,
  REGION_MAPPABLE_ROLE_KEYS,
  classifyDue,
  createAmcVisitSchema,
  escalationDue,
  reminderEligible,
  reminderPolicySchema,
  PROPOSED_REMINDER_POLICY,
  REMINDER_POLICY_DEFAULTS,
  setTicketDueDateSchema,
  updateAmcVisitSchema,
} from "../src/index";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

test("due state: a due date is a calendar day - overdue only once that whole day has passed; no date is its own state", () => {
  const due = "2026-10-20";
  assert.equal(classifyDue(null, D("2026-10-20"), 3), "no_due_date");
  assert.equal(classifyDue(undefined, D("2026-10-20"), 3), "no_due_date");
  assert.equal(classifyDue("garbage", D("2026-10-20"), 3), "no_due_date");
  assert.equal(classifyDue(D(due), new Date("2026-10-20T00:00:00Z"), null), "pending", "due today: not yet overdue");
  assert.equal(classifyDue(D(due), new Date("2026-10-20T23:59:59Z"), null), "pending");
  assert.equal(classifyDue(D(due), new Date("2026-10-21T00:00:00Z"), null), "overdue", "the day has passed");
  assert.equal(classifyDue(D(due), new Date("2026-11-30T00:00:00Z"), 3), "overdue");
});

test("due soon exists only when the policy sets a lead time", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  assert.equal(classifyDue(D("2026-10-19"), now, 3), "due_soon");
  assert.equal(classifyDue(D("2026-10-20"), now, 3), "due_soon", "exactly at the edge");
  assert.equal(classifyDue(D("2026-10-21"), now, 3), "pending");
  assert.equal(classifyDue(D("2026-10-19"), now, null), "pending", "no lead time approved: never 'due soon'");
  assert.equal(classifyDue(D("2026-10-19"), now, 0), "pending");
});

test("a reminder is created only with a due date AND an approved lead time, and only once due soon or overdue", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  assert.equal(reminderEligible(D("2026-10-10"), now, null), false, "policy off: even an overdue activity is not reminded");
  assert.equal(reminderEligible(null, now, 3), false, "no due date: nothing is invented");
  assert.equal(reminderEligible(D("2026-12-01"), now, 3), false, "far in the future");
  assert.equal(reminderEligible(D("2026-10-19"), now, 3), true);
  assert.equal(reminderEligible(D("2026-10-10"), now, 3), true);
});

test("escalation is due only for an unacknowledged, delivered reminder, after the approved time, one level at a time", () => {
  const sentAt = new Date("2026-10-17T00:00:00Z");
  const r = { status: "sent", sentAt, acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null as Date | null };
  const at = (h: number) => new Date(sentAt.getTime() + h * 3600 * 1000);
  assert.equal(escalationDue(r, null, at(500)), false, "no escalation time approved");
  assert.equal(escalationDue(r, 24, at(23)), false);
  assert.equal(escalationDue(r, 24, at(24)), true);
  assert.equal(escalationDue({ ...r, acknowledgedAt: at(1) }, 24, at(500)), false, "acknowledged");
  for (const status of ["pending", "sending", "acknowledged", "closed"]) assert.equal(escalationDue({ ...r, status }, 24, at(500)), false, status); // failed / no_recipient: see the undelivered test below
  assert.equal(escalationDue({ ...r, sentAt: null }, 24, at(500)), false);
  const l1 = { ...r, escalationLevel: 1, lastEscalatedAt: at(30) };
  assert.equal(escalationDue(l1, 24, at(53)), false, "the next level is measured from the last escalation");
  assert.equal(escalationDue(l1, 24, at(54)), true);
  assert.equal(escalationDue({ ...l1, escalationLevel: MAX_REMINDER_ESCALATION_LEVEL }, 24, at(900)), false, "two levels at most");
});

test("both Service Managers and Regional Managers can be mapped to a region - nobody else", () => {
  assert.deepEqual([...REGION_MAPPABLE_ROLE_KEYS].sort(), ["regional_manager", "service_manager"]);
});

test("input schemas: real calendar dates only, due dates can be cleared, AMC visits take only the order, the unit and a date", () => {
  assert.equal(setTicketDueDateSchema.safeParse({ dueDate: "2026-11-05" }).success, true);
  assert.equal(setTicketDueDateSchema.safeParse({ dueDate: null }).success, true);
  for (const bad of ["05-11-2026", "2026-02-30", "2026-13-01", "soon", "", 5, undefined]) assert.equal(setTicketDueDateSchema.safeParse({ dueDate: bad }).success, false, String(bad));
  const visit = createAmcVisitSchema.parse({ amcOrderId: "a", unitId: "u", dueDate: "2026-11-05", customerId: "cB", siteId: "sB", serialNo: "FAKE" });
  assert.deepEqual(Object.keys(visit).sort(), ["amcOrderId", "dueDate", "unitId"]);
  assert.equal(createAmcVisitSchema.safeParse({ amcOrderId: "a", unitId: "u" }).success, false, "a visit without a due date is not trackable");
  assert.equal(updateAmcVisitSchema.safeParse({}).success, false);
  assert.equal(updateAmcVisitSchema.safeParse({ status: AMC_VISIT_STATUS.COMPLETED }).success, true);
  assert.equal(updateAmcVisitSchema.safeParse({ status: "scheduled" }).success, false, "cannot be set back to scheduled");
});

test("reminder policy: empty = off; values are bounded", () => {
  assert.equal(reminderPolicySchema.safeParse({ reminderLeadDays: null, reminderEscalationHours: null }).success, true);
  assert.equal(reminderPolicySchema.safeParse({ reminderLeadDays: 0, reminderEscalationHours: 1 }).success, true);
  for (const bad of [{ reminderLeadDays: -1 }, { reminderLeadDays: 366 }, { reminderLeadDays: 1.5 }, { reminderEscalationHours: 0 }, { reminderEscalationHours: 100000 }, { reminderLeadDays: "3" }]) {
    assert.equal(reminderPolicySchema.safeParse({ reminderLeadDays: 3, reminderEscalationHours: null, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(reminderPolicySchema.safeParse({}).success, false, "both fields must be stated, so switching off is deliberate");
});

test("the proposed workflow (3 days, 24 hours) is a valid policy, but it is only a proposal: the stored default stays OFF", () => {
  assert.deepEqual({ ...PROPOSED_REMINDER_POLICY }, { reminderLeadDays: 3, reminderEscalationHours: 24 });
  assert.equal(reminderPolicySchema.safeParse(PROPOSED_REMINDER_POLICY).success, true);
  assert.deepEqual({ ...REMINDER_POLICY_DEFAULTS }, { reminderLeadDays: null, reminderEscalationHours: null });
});

test("the proposed lead time: eligible from 3 calendar days before the due date, not before", () => {
  const due = new Date("2026-10-22T00:00:00.000Z");
  const at = (iso: string) => new Date(iso);
  assert.equal(reminderEligible(due, at("2026-10-19T00:00:00.000Z"), 3), true, "exactly 3 days before");
  assert.equal(reminderEligible(due, at("2026-10-19T23:59:00.000Z"), 3), true);
  assert.equal(reminderEligible(due, at("2026-10-18T23:59:00.000Z"), 3), false, "4 days and a minute before: too early");
  assert.equal(reminderEligible(due, at("2026-10-25T00:00:00.000Z"), 3), true, "overdue activities are always eligible");
  assert.equal(reminderEligible(due, at("2026-10-19T00:00:00.000Z"), null), false, "policy off: never");
});

test("escalationDue: an undelivered (failed / no recipient) reminder escalates after the same hours, counted from creation; a delivered one still counts from delivery", () => {
  const H = 3600 * 1000;
  const t0 = new Date("2026-01-01T00:00:00Z");
  const at = (h: number) => new Date(t0.getTime() + h * H);
  const base = { acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, createdAt: t0 };
  for (const status of ["failed", "no_recipient"]) {
    const r = { ...base, status, sentAt: null };
    assert.equal(escalationDue(r, 24, at(23)), false, `${status}: too early`);
    assert.equal(escalationDue(r, 24, at(24)), true, `${status}: due, although never delivered`);
    assert.equal(escalationDue({ ...r, escalationLevel: 1, lastEscalatedAt: at(30) }, 24, at(53)), false, `${status}: level 2 counts from level 1`);
    assert.equal(escalationDue({ ...r, escalationLevel: 1, lastEscalatedAt: at(30) }, 24, at(54)), true);
    assert.equal(escalationDue({ ...r, escalationLevel: 2 }, 24, at(500)), false, "two levels at most");
    assert.equal(escalationDue({ ...r, acknowledgedAt: at(1) }, 24, at(500)), false, "acknowledged");
    assert.equal(escalationDue(r, null, at(500)), false, "policy off");
    assert.equal(escalationDue({ ...r, createdAt: null }, 24, at(500)), false, "no clock to count from");
  }
  const sent = { ...base, status: "sent", sentAt: at(10) };
  assert.equal(escalationDue(sent, 24, at(33)), false, "24 h run from the delivery, not from creation");
  assert.equal(escalationDue(sent, 24, at(34)), true);
  assert.equal(escalationDue({ ...sent, sentAt: null }, 24, at(500)), false, "a 'sent' reminder without a delivery time is not escalated");
  for (const status of ["pending", "sending", "acknowledged", "closed"]) assert.equal(escalationDue({ ...base, status, sentAt: null }, 24, at(500)), false, status);
  assert.equal(escalationDue({ ...base, status: "sent", sentAt: at(40), escalationAttempts: 1 }, 24, at(41)), true, "a level that was already attempted stays due until delivered");
});
