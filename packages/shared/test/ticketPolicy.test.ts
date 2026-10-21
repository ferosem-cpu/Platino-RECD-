import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedNextStatuses,
  isMeaningfulResolutionNotes,
  isValidReopenReason,
  COMPLAINT_EVENT,
  COMPLAINT_STATUS,
  COMPLAINT_STATUS_VALUES,
  SLA_DEFAULTS,
  SLA_PAUSED_STATUSES,
  TICKET_ASSIGNEE_ROLES,
  TICKET_CLOSED_STATUSES,
  TICKET_FINISHED_STATUSES,
  TICKET_LIST_LIMIT_DEFAULT,
  TICKET_LIST_LIMIT_MAX,
  classifyStatusChange,
  closedAtFor,
  complaintStatusSchema,
  isComplaintStatus,
  isStatusTransitionAllowed,
  updateComplaintStatusSchema,
} from "../src";

test("the nine existing statuses are unchanged and are the only accepted values", () => {
  assert.deepEqual([...COMPLAINT_STATUS_VALUES].sort(), ["acknowledged", "assigned", "closed", "escalated", "in_progress", "open", "resolved", "waiting_for_customer", "waiting_for_part"]);
  assert.equal(COMPLAINT_STATUS_VALUES.length, 9);
  for (const s of COMPLAINT_STATUS_VALUES) assert.equal(complaintStatusSchema.safeParse(s).success, true, s);
  for (const bad of ["banana", "OPEN", "Open", " open", "closed ", "", "in progress", "cancelled", "archived", 1, null, undefined, {}]) assert.equal(complaintStatusSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(isComplaintStatus("closed"), true);
  assert.equal(isComplaintStatus("banana"), false);
  const msg = complaintStatusSchema.safeParse("banana");
  assert.ok(!msg.success && /Status must be one of/.test(msg.error.issues[0].message));
});

test("the PATCH schema rejects an arbitrary status and keeps every other field as it was", () => {
  assert.equal(updateComplaintStatusSchema.safeParse({ status: "banana" }).success, false);
  assert.equal(updateComplaintStatusSchema.safeParse({}).success, false);
  const ok = updateComplaintStatusSchema.safeParse({ status: "resolved", rootCause: "a", resolutionNotes: "b", remarks: "c", serviceReportUrl: "d", assignedToId: null });
  assert.equal(ok.success, true);
  assert.equal(updateComplaintStatusSchema.safeParse({ status: "open", assignedToId: "x" }).success, true);
});

test("existing policy values are preserved: SLA defaults, paused statuses, finished statuses, the open-ticket rule", () => {
  assert.deepEqual(SLA_DEFAULTS, { REGIONAL_MANAGER_HOURS: 24, MANAGEMENT_HOURS: 48 });
  assert.deepEqual([...SLA_PAUSED_STATUSES].sort(), ["closed", "resolved", "waiting_for_customer"], "waiting_for_part and escalated are NOT paused (unchanged; a decision for the mentor)");
  assert.deepEqual([...TICKET_FINISHED_STATUSES].sort(), ["closed", "resolved"]);
  assert.deepEqual([...TICKET_CLOSED_STATUSES].sort(), ["closed", "resolved"], "resolved and closed permit a new ticket, as the partial unique index says");
  assert.deepEqual([...TICKET_ASSIGNEE_ROLES].sort(), ["commissioning_engineer", "erection_engineer", "service_engineer", "service_team"]);
});

test("transitions: the proposed workflow lives in ONE table (active <-> active, active -> resolved, resolved -> closed / active, closed -> active)", () => {
  const active = ["open", "acknowledged", "assigned", "in_progress", "waiting_for_customer", "waiting_for_part", "escalated"];
  for (const a of active) {
    for (const b of active) assert.equal(isStatusTransitionAllowed(a, b), true, `${a} -> ${b}`);
    assert.equal(isStatusTransitionAllowed(a, "resolved"), true, `${a} -> resolved`);
    assert.equal(isStatusTransitionAllowed(a, "closed"), false, `${a} -> closed directly is not allowed (an engineer resolves, a manager closes)`);
    assert.equal(isStatusTransitionAllowed("resolved", a), true, `resolved -> ${a} (the fix did not hold)`);
    assert.equal(isStatusTransitionAllowed("closed", a), true, `closed -> ${a} (reopen)`);
  }
  assert.equal(isStatusTransitionAllowed("resolved", "closed"), true);
  assert.equal(isStatusTransitionAllowed("closed", "resolved"), false, "reopen to an active status first");
  for (const s of COMPLAINT_STATUS_VALUES) assert.equal(isStatusTransitionAllowed(s, s), true, "staying put is not a transition");
  assert.equal(isStatusTransitionAllowed("open", "banana"), false);
  assert.deepEqual(allowedNextStatuses("closed").sort(), [...active].sort());
  assert.equal(allowedNextStatuses("resolved").includes("closed"), true);
  assert.equal(allowedNextStatuses("banana").length, 0);
});

test("resolution notes: meaningful = trimmed, 10+ characters, 2+ words, not one repeated character", () => {
  for (const bad of [undefined, null, 5, "", "   ", "done", "fixed it", "aaaaaaaaaaaa", "abababababab", "oneverylongwordwithoutspaces"]) assert.equal(isMeaningfulResolutionNotes(bad), false, JSON.stringify(bad));
  for (const good of ["Replaced the belt", "  Reset the controller and re-tested  ", "Belt replaced; tensioner adjusted"]) assert.equal(isMeaningfulResolutionNotes(good), true, good);
});

test("reopen reason: trimmed, 10 to 1000 characters", () => {
  for (const bad of [undefined, null, "", "          ", "too short", "x".repeat(1001)]) assert.equal(isValidReopenReason(bad), false, JSON.stringify(bad)?.slice(0, 20));
  for (const good of ["customer reports the fault is back", "  ten chars!  ", "y".repeat(1000)]) assert.equal(isValidReopenReason(good), true);
});

test("closure semantics: closed sets once, a repeat leaves it alone, leaving closed clears it, other changes never touch it", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const earlier = new Date("2026-10-01T09:00:00Z");
  assert.equal(classifyStatusChange("open", "closed"), "closed");
  assert.equal(classifyStatusChange("resolved", "closed"), "closed");
  assert.equal(classifyStatusChange("closed", "closed"), "unchanged");
  assert.equal(classifyStatusChange("closed", "open"), "reopened");
  assert.equal(classifyStatusChange("closed", "resolved"), "reopened");
  assert.equal(classifyStatusChange("resolved", "open"), "other");
  assert.equal(classifyStatusChange("open", "in_progress"), "other");
  assert.equal(classifyStatusChange("open", "open"), "unchanged");
  assert.equal(closedAtFor("closed", null, now), now);
  assert.equal(closedAtFor("closed", earlier, now), earlier, "an existing closure time is never replaced");
  assert.equal(closedAtFor("unchanged", earlier, now), undefined, "a repeated closure writes nothing");
  assert.equal(closedAtFor("reopened", earlier, now), null);
  assert.equal(closedAtFor("other", earlier, now), undefined);
  assert.equal(closedAtFor("other", null, now), undefined);
});

test("two new history event types exist next to the old ones", () => {
  assert.equal(COMPLAINT_EVENT.NOTES_UPDATED, "notes_updated");
  assert.equal(COMPLAINT_EVENT.ESCALATION_FAILED, "escalation_failed");
  assert.deepEqual([COMPLAINT_EVENT.CREATED, COMPLAINT_EVENT.STATUS_CHANGED, COMPLAINT_EVENT.ASSIGNED, COMPLAINT_EVENT.ESCALATED], ["created", "status_changed", "assigned", "escalated"]);
  assert.equal(COMPLAINT_STATUS.CLOSED, "closed");
});

test("list limits: capped, with a default that keeps the old behaviour for callers that send nothing", () => {
  assert.equal(TICKET_LIST_LIMIT_MAX, 500);
  assert.equal(TICKET_LIST_LIMIT_DEFAULT, 1000);
});
