// Service-report screens. The repo has no component-test runner, so these are source-level checks of the wiring
// (reading the files as text) plus the shared rules the screens rely on. They do NOT replace trying the screens in a
// real browser (mouse and touch signing, PDF download) - that has not been done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const pad = read("apps/admin-web/src/components/SignaturePad.tsx");
const detail = read("apps/admin-web/src/app/service-reports/[id]/page.tsx");
const list = read("apps/admin-web/src/app/service-reports/page.tsx");
const complaints = read("apps/admin-web/src/app/complaints/page.tsx");
const portal = read("apps/admin-web/src/app/customer/portal/page.tsx");
const unitPage = read("apps/admin-web/src/app/recd-units/[id]/page.tsx");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const files = read("apps/admin-web/src/lib/reportFiles.ts");

test("signature pad: drawn with mouse, finger or stylus (Pointer Events), no page scroll while signing, clearable", () => {
  assert.match(pad, /onPointerDown/);
  assert.match(pad, /onPointerMove/);
  assert.match(pad, /onPointerUp/);
  assert.match(pad, /setPointerCapture/);
  assert.match(pad, /touchAction: "none"/);
  assert.match(pad, /toDataURL\("image\/png"\)/);
  assert.match(pad, /clearRect/);
  assert.match(pad, /onChange\(null\)/, "clearing reports 'no signature' to the form");
  assert.match(pad, /disabled/);
});

test("signing screen: the customer reviews the report, types a name, draws, confirms - and cannot sign until all are done", () => {
  assert.match(detail, /Review and sign/);
  assert.match(detail, /<SignaturePad/);
  assert.match(detail, /const canFinishSigning = !!signatureImage && signerName\.trim\(\)\.length >= SERVICE_REPORT_LIMITS\.SIGNER_NAME_MIN && confirm/);
  assert.match(detail, /disabled=\{!canFinishSigning\}/);
  assert.match(detail, /I have reviewed this report and approve it/);
  assert.match(detail, /p\.canSign/, "the section only shows when the server says this user may sign");
  assert.match(detail, /version: report!\.version/, "the signature is bound to the version that was reviewed");
  assert.match(detail, /confirm: true/);
});

test("signing screen: success and failure are both shown, and a stale or already-signed answer reloads the report", () => {
  assert.match(detail, /the report is signed and final/);
  assert.match(detail, /kind: "error"/);
  assert.match(detail, /STALE_VERSION/);
  assert.match(detail, /ALREADY_SIGNED/);
  const run = detail.slice(detail.indexOf("async function run"), detail.indexOf("const payload"));
  assert.ok(run.indexOf("okText") < run.indexOf("catch"), "the success text is only set after the work succeeded");
});

test("staff workflow: edit a draft, save, submit for signature, take back; all driven by the server's permission flags", () => {
  for (const flag of ["canEdit", "canSubmit", "canReopen", "canSign"]) assert.match(detail, new RegExp(`p\.${flag}|permissions\.${flag}|${flag}:`), flag);
  assert.match(detail, /Save draft/);
  assert.match(detail, /Submit for customer signature/);
  assert.match(detail, /Take back to draft to edit/);
  assert.match(detail, /expectedVersion/);
  assert.match(detail, /serviceReportMissingFields\(form\)/, "incomplete reports are caught before the request too");
});

test("signed state: signature, signer, time, download and open - the files are fetched with the login token", () => {
  assert.match(detail, /Signed and final/);
  assert.match(detail, /Download signed PDF/);
  assert.match(detail, /apiBlob\(`\/service-reports\/\$\{report\.id\}\/signature`\)/);
  assert.match(files, /apiBlob\(`\/service-reports\/\$\{reportId\}\/pdf`\)/);
  assert.match(files, /a\.download = `service-report-\$\{reportNumber\}\.pdf`/);
  assert.match(detail, /pdfAvailable/);
});

test("loading, empty and error states exist on both screens", () => {
  assert.match(detail, /data-testid="report-loading"/);
  assert.match(detail, /data-testid="report-error"/);
  assert.match(list, /data-testid="reports-loading"/);
  assert.match(list, /data-testid="reports-empty"/);
  assert.match(list, /Suspense/, "useSearchParams needs a Suspense boundary for the production build");
});

test("entry points: ticket list (staff), customer portal, and the RECD unit history", () => {
  assert.match(complaints, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.match(portal, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.match(unitPage, /Download signed PDF/);
  assert.match(unitPage, /serviceReports/);
  assert.match(unitPage, /No service report uploaded/, "the legacy attachment text and download are kept");
  assert.match(unitPage, /download=\{reportFileName\(c\.ticketNumber, c\.serviceReportUrl\)\}/);
});

test("the staff permission rule for /service-reports never reaches a customer (customers sign there); the API decides access", () => {
  // Staff list: a route rule exists (menu + guard), but the customer branch of the guard runs and returns BEFORE the permission check.
  assert.match(guard, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  const customerBranch = guard.indexOf('user.role.key === "customer"');
  const permissionCheck = guard.indexOf("const matched = matchRoute(pathname);");
  assert.ok(customerBranch > 0 && permissionCheck > customerBranch, "customers are handled first");
});

// ---------------------------------------------------------------------------------------------------------
// AMC service reports (Requirement 5) - source-level checks, NOT a substitute for a browser / phone test.
const amcOrders = read("apps/admin-web/src/app/amc-orders/page.tsx");
const reportUi = read("apps/admin-web/src/lib/serviceReportUi.ts");

test("AMC order list: every order links to its service reports", () => {
  assert.match(amcOrders, /\/service-reports\?amcOrderId=\$\{o\.id\}/);
  assert.match(amcOrders, /Service reports/);
});

test("AMC list screen: shows the AMC, offers only units the AMC covers, states the acknowledgement rule, and explains frequency vs reports", () => {
  assert.match(list, /amcOrderId/);
  assert.match(list, /data-testid="amc-context"/);
  assert.match(list, /data-testid="amc-unit-select"/);
  assert.match(list, /u\.status === "active" && u\.serialNo/, "only active units with a serial are offered");
  assert.match(list, /data-testid="ack-required"/);
  assert.match(list, /acknowledgementRequired/);
  assert.match(list, /schedule/i);
  assert.match(list, /Contracted visits per year/);
  assert.match(list, /\{ amcOrderId, unitId, acknowledgementRequired, \.\.\.form \}/, "the client sends only the AMC and the unit - never customer, site or serial");
  const bodyLine = list.split(/\r?\n/).find((l) => l.includes("const body = amcOrderId")) ?? "";
  assert.doesNotMatch(bodyLine, /customerId|siteId|serial/i);
});

test("AMC detail screen: AMC order, type, serial are shown; the acknowledgement rule is explicit; no-signature submission is labelled", () => {
  assert.match(detail, /AMC order/);
  assert.match(detail, /RECD serial number/);
  assert.match(detail, /data-testid="ack-required-toggle"/);
  assert.match(detail, /Finalise without customer signature/);
  assert.match(detail, /data-testid="ack-rule"/);
  assert.match(detail, /Submitted and final - not signed/);
  assert.match(detail, /data-testid="submitted-section"/);
});

test("a submitted (unsigned) report is never styled or worded as signed", () => {
  assert.doesNotMatch(reportUi.slice(reportUi.indexOf("SUBMITTED")), /status-pill-success/);
  const submitted = detail.slice(detail.indexOf('data-testid="submitted-section"'), detail.indexOf("{/* Signed */}"));
  assert.doesNotMatch(submitted, /Signed and final|Signed by/i);
  assert.match(submitted, /not signed/i);
  assert.match(detail, /report\.status === SERVICE_REPORT_STATUS\.SIGNED && \(/, "the signed block is only for status signed");
});

test("customer entry point: the portal lists their reports and the sign step stays behind the server's canSign flag", () => {
  assert.match(portal, /\/service-reports\/mine/);
  assert.match(portal, /data-testid="my-service-reports"/);
  assert.match(portal, /Review & sign/);
  assert.match(detail, /p\.canSign/);
});

test("RECD unit page shows its AMC reports only inside the AMC section (which is hidden from roles without AMC access)", () => {
  assert.match(unitPage, /amcVisible && \(data\.amcServiceReports \?\? \[\]\)\.length > 0/);
  assert.match(unitPage, /data-testid="unit-amc-reports"/);
});

test("page guard: a customer is NOT bounced off the report pages (found in the browser walkthrough), but only those pages", () => {
  const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
  // the helper (now in lib/routeAccess.ts, shared with its tests) and its use in both the redirect effect and the render branch
  assert.match(guard, /from "@\/lib\/routeAccess"/);
  assert.match(guard, /pathname !== "\/customer\/portal" && !isCustomerReportPath\(pathname\)/);
  assert.match(guard, /isCustomerPortal \|\| isCustomerReportPath\(pathname\)/);
  // the exact path rule: the report list (the portal's "Service reports & signing" link) or one report id, nothing broader
  const access = read("apps/admin-web/src/lib/routeAccess.ts");
  assert.match(access, /export function isCustomerReportPath/);
  assert.ok(guard.includes("service-reports"), "the guard names the report route");
});
