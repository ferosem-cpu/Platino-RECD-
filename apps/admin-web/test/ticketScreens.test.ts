// Ticket screen (Requirement 11). No component runner in this repo: source-level checks of the wiring. The server enforces every rule (see
// apps/api/test/ticketAdmin.test.ts and test/db/ticketAdmin.db.test.ts); these only check what the screen sends and shows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPLAINT_STATUS_VALUES, CLOSED_TICKET_READ_ONLY, REOPEN_REASON_REQUIRED, RESOLUTION_NOTES_REQUIRED } from "@recd/shared";
import { statusChoices, ticketFormProblem } from "../src/lib/ticketForm";

const root = resolve(__dirname, "../../..");
const page = readFileSync(resolve(root, "apps/admin-web/src/app/complaints/page.tsx"), "utf8");

test("the status dropdown offers only the statuses the shared workflow allows next (all nine exist in the shared definition)", () => {
  assert.match(page, /import \{ COMPLAINT_STATUS \} from "@recd\/shared"/);
  assert.match(page, /statusChoices\(editing\.status, canManage\)\.map\(\(o\) =>/);
  assert.equal(COMPLAINT_STATUS_VALUES.length, 9);
});

test("the editor loads the assignees for THIS ticket (vendor engineers only for that ticket's vendor), not a global list", () => {
  assert.match(page, /\/complaints\/assignees\?ticketId=\$\{encodeURIComponent\(c\.id\)\}/);
  assert.doesNotMatch(page, /api<Assignee\[\]>\("\/complaints\/assignees"\)/);
});

test("server refusals (403 scope, 409 reopen conflict, 400 assignment) are shown with the server's own wording", () => {
  assert.match(page, /apiErrorMessage\(err, "Failed to update complaint"\)/);
  assert.match(page, /apiErrorMessage\(err, "Failed to delete complaint"\)/);
  assert.doesNotMatch(page, /err instanceof Error \? err\.message/);
});

test("reopening is explained (the closure date is cleared, the history keeps it) and delete archives: the ticket and its history are kept", () => {
  assert.match(page, /data-testid="reopen-note"/);
  assert.match(page, /editing\.status === "closed" && form\.status !== "closed"/);
  assert.match(page, /the ticket and its full history are kept/);
  assert.doesNotMatch(page, /cannot be recovered/);
  assert.match(page, /e.type === "archived"/);
});

test("history wording covers the new events: reopened, notes updated (fields only), and an escalation that could not be delivered", () => {
  assert.match(page, /reopened - closure date cleared/);
  assert.match(page, /e\.type === "notes_updated"/);
  assert.match(page, /e\.type === "escalation_failed"/);
  assert.match(page, /will be retried/);
  assert.match(page, /Escalated to Regional Manager \(SLA\)/, "the existing escalated wording is kept");
});

test("a closed ticket is read-only for non-managers (explained, Save disabled); managers see a required reopen reason, sent as reopenReason", () => {
  assert.match(page, /isReadOnlyForUser\(editing\.status, canManage\)/);
  assert.match(page, /data-testid="reopen-manager-only"/);
  assert.match(page, /Only a ticket manager can reopen it or add notes to it/);
  assert.match(page, /data-testid="reopen-reason"/);
  assert.match(page, /reopenReason: form\.reopenReason\.trim\(\)/);
  assert.match(page, /ticketFormProblem\(editing\.status, form, canManage, editing\.resolutionNotes\)/);
});

test("archived tickets: managers can list them and restore one (POST /complaints/:id/restore); there is no purge button or route in the screen", () => {
  assert.match(page, /\/complaints\?includeArchived=1/);
  assert.match(page, /\/complaints\/\$\{c\.id\}\/restore/);
  assert.match(page, /data-testid=\{`restore-\$\{c\.ticketNumber\}`\}/);
  assert.doesNotMatch(page, /purge|permanent/i);
});

test("ticket form rules (mirror of the API): choices follow the workflow; reopening needs a reason; resolving needs meaningful notes; a closed ticket is read-only for non-managers", () => {
  const f = (status: string, resolutionNotes = "", reopenReason = "") => ({ status, resolutionNotes, reopenReason });
  const values = (from: string, mgr: boolean) => statusChoices(from, mgr).filter((c) => !c.disabled).map((c) => c.value);
  assert.equal(values("in_progress", false).includes("closed"), false, "no direct closure from an active status");
  assert.equal(values("in_progress", true).includes("closed"), false);
  assert.equal(values("in_progress", true).includes("resolved"), true);
  assert.equal(values("resolved", true).includes("closed"), true);
  assert.equal(values("resolved", false).includes("closed"), false, "an engineer resolves, a manager closes");
  assert.deepEqual(values("closed", false), ["closed"], "a non-manager can only stay on closed");
  assert.equal(values("closed", true).includes("resolved"), false);
  assert.equal(values("closed", true).includes("open"), true);
  assert.equal(ticketFormProblem("closed", f("closed"), false, null), CLOSED_TICKET_READ_ONLY);
  assert.equal(ticketFormProblem("closed", f("open"), true, null), REOPEN_REASON_REQUIRED);
  assert.equal(ticketFormProblem("closed", f("open", "", "customer reports the fault is back"), true, null), null);
  assert.equal(ticketFormProblem("closed", f("closed"), true, null), null, "a manager's note on a closed ticket needs no reason");
  assert.equal(ticketFormProblem("in_progress", f("resolved", "done"), false, null), RESOLUTION_NOTES_REQUIRED);
  assert.equal(ticketFormProblem("in_progress", f("resolved", "", ""), false, "Belt replaced and tested"), null, "notes already saved on the ticket count");
  assert.equal(ticketFormProblem("in_progress", f("resolved", "Belt replaced and tested"), false, null), null);
  assert.equal(ticketFormProblem("in_progress", f("in_progress"), false, null), null);
});


test("customer portal opens the site of the order the customer signed in with, not simply the first site", () => {
  const portal = readFileSync(resolve(root, "apps/admin-web/src/app/customer/portal/page.tsx"), "utf8");
  assert.match(portal, /recd_customer_ord/);
  assert.match(portal, /s\.order\?\.orderNumber === signedInOrder/);
});
