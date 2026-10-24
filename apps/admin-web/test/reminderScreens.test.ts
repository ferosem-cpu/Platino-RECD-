// Reminder dashboard, region mapping, policy settings and AMC visit scheduling (Requirement 6). The repo has no component-test
// runner, so these are source-level checks of the wiring (reading the files as text) plus unit tests of the status wording.
// They do NOT replace trying the screens in a real browser - that has not been done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reminderLabel } from "../src/lib/reminderUi";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const dash = read("apps/admin-web/src/app/reminders/page.tsx");
const regions = read("apps/admin-web/src/app/regions/page.tsx");
const settingsComp = read("apps/admin-web/src/components/ReminderSettings.tsx");
const settingsPage = read("apps/admin-web/src/app/settings/page.tsx");
const reports = read("apps/admin-web/src/app/service-reports/page.tsx");
const nav = read("apps/admin-web/src/components/Nav.tsx");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");

test("status wording: a failed, recipient-less or waiting reminder is never described as sent", () => {
  const base = { statusReason: null, escalationLevel: 0 };
  assert.equal(reminderLabel(null, true).text, "No reminder yet");
  assert.equal(reminderLabel(null, false).text, "Reminders off");
  assert.equal(reminderLabel({ ...base, status: "sent" }, true).text, "Sent - not acknowledged");
  assert.match(reminderLabel({ ...base, status: "sent", escalationLevel: 2 }, true).text, /escalated \(level 2\)/);
  assert.equal(reminderLabel({ ...base, status: "acknowledged" }, true).text, "Acknowledged");
  assert.match(reminderLabel({ ...base, status: "failed" }, true).text, /Delivery failed/);
  assert.match(reminderLabel({ ...base, status: "no_recipient", statusReason: "no_region" }, true).text, /site has no region/);
  assert.match(reminderLabel({ ...base, status: "no_recipient", statusReason: "no_active_manager" }, true).text, /no active manager/);
  for (const status of ["failed", "no_recipient", "pending", "sending"]) assert.doesNotMatch(reminderLabel({ ...base, status }, true).text, /^Sent|Acknowledged/);
});

test("dashboard: shows customer, site, serial (or says it is missing), due date, region, managers and the reminder state", () => {
  for (const needle of ["row.customerName", "row.siteName", "row.serialNo", 'data-testid="serial-missing"', "row.dueDate", "row.regionName", "row.managers", "reminderLabel(row.reminder"]) assert.ok(dash.includes(needle), needle);
  assert.match(dash, /not recorded/);
  assert.match(dash, /no active manager/);
});

test("dashboard: filters for status, region, manager, reminder state and date range; states for loading, empty, error and 'off'", () => {
  assert.match(dash, /data-testid="reminder-filters"/);
  for (const f of ['aria-label="Status"', 'aria-label="Region"', 'aria-label="Manager"', 'aria-label="Reminder status"', 'aria-label="Due from"', 'aria-label="Due to"']) assert.ok(dash.includes(f), f);
  for (const t of ["reminders-loading", "reminders-empty", "reminders-off"]) assert.ok(dash.includes(`data-testid="${t}"`), t);
  assert.match(dash, /role="alert"/);
  assert.match(dash, /Reminders are switched OFF/);
  assert.match(dash, /data-testid="reminder-counts"/);
});

test("dashboard: acknowledge is offered only to users the server allows and only for open, unacknowledged reminders; history and escalation are shown", () => {
  assert.match(dash, /data\?\.canAcknowledge && hasPermission\("manage_complaints"\)/);
  assert.match(dash, /canAck && row\.reminder && !row\.reminder\.acknowledgedAt && row\.reminder\.status === "sent"/); // only a delivered reminder can be acknowledged
  assert.match(dash, /\/reminders\/\$\{row\.reminder\.id\}\/acknowledge/);
  assert.match(dash, /Acknowledged by/);
  assert.match(dash, /Escalated to level/);
  assert.match(dash, /History \(/);
});

test("dashboard: undated tickets can be given a due date (and are not invented one); links go to the ticket reports, AMC orders and the unit", () => {
  assert.match(dash, /row\.state === "no_due_date"/);
  assert.match(dash, /\/reminders\/tickets\/\$\{row\.activityId\}\/due-date/);
  assert.match(dash, /row\.links\.activity/);
  assert.match(dash, /row\.links\.unit/);
});

test("navigation and route guard: the dashboard needs the overview / manage-tickets permission, so customers, vendors and engineers do not see it", () => {
  assert.match(nav, /"\/reminders": \["view_complaints_overview", "manage_complaints"\]/);
  assert.match(guard, /"\/reminders": \["view_complaints_overview", "manage_complaints"\]/);
});

test("regions screen: Service Managers and Regional Managers can be picked (each labelled), the empty state warns that reminders have no recipient, and the change history is shown", () => {
  assert.match(regions, /MAPPABLE_ROLES = \["regional_manager", "service_manager"\]/);
  assert.match(regions, /ROLE_LABEL\[u\.role\.key\]/);
  assert.match(regions, /No manager mapped yet - reminders for this region have no recipient/);
  assert.match(regions, /data-testid="region-audit"/);
  assert.match(regions, /\/regions\/\$\{r\.id\}\/audit/);
});

test("settings: the reminder policy starts empty (= off), is saved through its own endpoint and cannot set escalation without a lead time", () => {
  assert.match(settingsComp, /data-testid="reminder-settings"/);
  assert.match(settingsComp, /placeholder="empty = off"/);
  assert.match(settingsComp, /\/settings\/reminders/);
  assert.match(settingsComp, /disabled=\{lead\.trim\(\) === ""\}/);
  assert.doesNotMatch(settingsComp, /useState\("\d/, "no default values are pre-filled");
  assert.match(settingsPage, /<ReminderSettings \/>/);
});

test("AMC screen: visits are scheduled explicitly with a due date (nothing generated from the yearly frequency or the expiry)", () => {
  assert.match(reports, /data-testid="amc-visits"/);
  assert.match(reports, /\/amc-visits/);
  assert.match(reports, /not created from the contracted visits per year/);
  assert.match(reports, /unrelated to the contract expiry/);
  assert.match(reports, /isAmc && canWrite/);
});

test("delivery wording: a partly delivered reminder says so, and an in-app record is never described as a delivery", () => {
  const base = { statusReason: null, escalationLevel: 0 };
  assert.match(reminderLabel({ ...base, status: "failed", statusReason: "partial_delivery" }, true).text, /some managers.*retrying the rest/);
  assert.match(reminderLabel({ ...base, status: "failed", statusReason: "delivery_failed" }, true).text, /Delivery failed/);
  assert.ok(dash.includes('sent: "E-mail delivered"'));
  assert.ok(dash.includes('in_app_recorded: "In-app record written (not a delivery)"'));
});

// ---- escalation retry visibility, attempt numbers in history, friendly errors -------------------------------------
import { MAX_DELIVERY_ATTEMPTS } from "@recd/shared";
import { attemptSuffix, escalationInfo } from "../src/lib/reminderUi";
import { friendlyApiMessage } from "../src/lib/apiError";

test("escalation line: nothing attempted yet, off, retrying, exhausted, and delivered - all from the API's own values", () => {
  const sent = { status: "sent", escalationLevel: 0, escalationAttempts: 0 };
  assert.equal(escalationInfo(sent, 24)?.text, "No escalation attempted yet");
  assert.equal(escalationInfo(sent, null)?.text, "Escalation is off");
  assert.equal(escalationInfo({ ...sent, escalationAttempts: 3 }, 24)?.text, `Escalation retrying - level 1: 3 of ${MAX_DELIVERY_ATTEMPTS} attempts failed`);
  assert.match(escalationInfo({ ...sent, escalationAttempts: MAX_DELIVERY_ATTEMPTS }, 24)?.text ?? "", /Escalation attempt limit reached - level 1: 5 of 5 attempts failed, no more retries/);
  // level 1 delivered, level 2 now retrying
  assert.equal(escalationInfo({ status: "sent", escalationLevel: 1, escalationAttempts: 2 }, 24)?.text, `Escalation level 1 delivered. Escalation retrying - level 2: 2 of ${MAX_DELIVERY_ATTEMPTS} attempts failed`);
  // a level that was simply delivered is stated by the existing "Escalated to level N" line
  assert.equal(escalationInfo({ status: "sent", escalationLevel: 1, escalationAttempts: 0 }, 24), null);
  assert.match(escalationInfo({ status: "sent", escalationLevel: 2, escalationAttempts: 0 }, 24)?.text ?? "", /level 2 delivered - last level reached/);
  assert.equal(escalationInfo({ status: "sent", escalationLevel: 1, escalationAttempts: 0 }, 24, 5), null);
});

test("escalation line: only for reminders it applies to, and no value is invented when the API did not send an attempt count", () => {
  assert.equal(escalationInfo(null, 24), null, "no reminder");
  for (const status of ["pending", "failed", "no_recipient", "closed"]) assert.equal(escalationInfo({ status, escalationLevel: 0, escalationAttempts: 4 }, 24), null, status);
  assert.equal(escalationInfo({ status: "sent", escalationLevel: 0 }, 24)?.text, "No escalation attempted yet", "an older API response without the field never shows attempts");
  assert.doesNotMatch(escalationInfo({ status: "sent", escalationLevel: 0 }, 24)?.text ?? "", /attempt \d|of \d/);
});

test("history: delivery and escalation events show their recorded attempt number; older events without one show nothing", () => {
  assert.equal(attemptSuffix({ type: "delivery_failed", attempt: 3 }), " - attempt 3");
  assert.equal(attemptSuffix({ type: "sent", attempt: 1 }), " - attempt 1");
  assert.equal(attemptSuffix({ type: "escalated", attempt: 2 }), " - attempt 2");
  assert.equal(attemptSuffix({ type: "in_app_recorded", attempt: 1 }), " - attempt 1");
  for (const e of [{ type: "sent" }, { type: "delivery_failed", attempt: null }, { type: "sent", attempt: undefined }, { type: "delivery_failed", attempt: 0 }, { type: "escalated", attempt: Number.NaN }]) assert.equal(attemptSuffix(e as any), "", JSON.stringify(e));
  for (const type of ["created", "acknowledged", "closed", "due_date_changed", "no_recipient"]) assert.equal(attemptSuffix({ type, attempt: 4 }), "", `${type} is not a delivery attempt`);
});

test("dashboard source: shows the escalation line and the attempt suffix, and reads the fields the API returns", () => {
  assert.match(dash, /escalationInfo\(row\.reminder, data\.policy\.reminderEscalationHours\)/);
  assert.match(dash, /data-testid=\{`escalation-\$\{row\.activityRef\}`\}/);
  assert.match(dash, /attemptSuffix\(e\)/);
  assert.match(dash, /escalationAttempts\?: number \| null/);
  assert.match(dash, /attempt\?: number \| null/);
  assert.match(read("apps/api/src/lib/reminders.ts"), /escalationAttempts: reminder\.escalationAttempts \?\? 0/);
  assert.match(read("apps/api/src/lib/reminders.ts"), /attempt: typeof/);
});

test("friendly errors: a network failure or a server error becomes one clear sentence (details go to the console); meaningful 4xx answers are kept", () => {
  const FALLBACK = "Unable to load reminders. Please try again.";
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    assert.equal(friendlyApiMessage(new TypeError("Failed to fetch"), FALLBACK), FALLBACK);
    assert.equal(friendlyApiMessage(new Error("NetworkError when attempting to fetch resource."), FALLBACK), FALLBACK);
    assert.equal(friendlyApiMessage(new Error("Load failed"), FALLBACK), FALLBACK);
    const server = Object.assign(new Error(JSON.stringify("Internal server error")), { status: 500 });
    assert.equal(friendlyApiMessage(server, FALLBACK), FALLBACK);
    assert.equal(logged.length, 4, "each hidden error is still logged for developers");
    assert.ok(logged.every((l) => l[0] === "[api] request failed"));
  } finally {
    console.error = realError;
  }
  // meaningful errors are not hidden
  const forbidden = Object.assign(new Error(JSON.stringify("This reminder is outside your regions")), { status: 403 });
  assert.equal(friendlyApiMessage(forbidden, FALLBACK), "This reminder is outside your regions");
  const conflict = Object.assign(new Error(JSON.stringify("This reminder has not been delivered yet, so it cannot be acknowledged.")), { status: 409 });
  assert.equal(friendlyApiMessage(conflict, FALLBACK), "This reminder has not been delivered yet, so it cannot be acknowledged.");
  const validation = Object.assign(new Error(JSON.stringify({ formErrors: [], fieldErrors: { dueDate: ["Enter a real calendar date"] } })), { status: 400 });
  assert.equal(friendlyApiMessage(validation, FALLBACK), "dueDate: Enter a real calendar date");
  assert.equal(friendlyApiMessage("not an error", FALLBACK), FALLBACK);
  assert.doesNotMatch(dash, /apiErrorMessage/);
  assert.match(dash, /Unable to load reminders\. Please try again\./);
});

test("settings: the proposed workflow (3 days, 24 h per stage) is shown for review and only FILLS the boxes - saving stays a separate, deliberate step", () => {
  assert.match(settingsComp, /data-testid="reminder-proposed-policy"/);
  assert.match(settingsComp, /Proposed workflow \(for mentor review - not active\)/);
  assert.match(settingsComp, /PROPOSED_REMINDER_POLICY\.reminderLeadDays/);
  assert.match(settingsComp, /PROPOSED_REMINDER_POLICY\.reminderEscalationHours/);
  assert.match(settingsComp, /data-testid="reminder-fill-proposed"/);
  // the button only sets the two inputs; it must not call the API
  const handler = settingsComp.slice(settingsComp.indexOf('data-testid="reminder-fill-proposed"') - 400, settingsComp.indexOf('data-testid="reminder-fill-proposed"'));
  assert.match(handler, /setLead\(String\(PROPOSED_REMINDER_POLICY\.reminderLeadDays\)\)/);
  assert.match(handler, /setHours\(String\(PROPOSED_REMINDER_POLICY\.reminderEscalationHours\)\)/);
  assert.doesNotMatch(handler, /api\(/);
  assert.match(settingsComp, /reminders stay off, until the policy is saved/);
});
