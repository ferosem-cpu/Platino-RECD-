// Service-report links and staff list (Requirement 4). The repo has no component-test runner, so the screens are checked at source level
// (reading the files as text) and the pure helpers are run directly. Trying the pages in a real browser has NOT been done by these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCustomerReportPath, SERVICE_REPORT_LIST_PERMISSIONS } from "../src/lib/routeAccess";
import { EMPTY_REPORT_FILTERS, REPORT_LIST_PAGE_SIZE, pageRange, reportListQuery, reportSource } from "../src/lib/serviceReportList";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const nav = read("apps/admin-web/src/components/Nav.tsx");
const portal = read("apps/admin-web/src/app/customer/portal/page.tsx");
const page = read("apps/admin-web/src/app/service-reports/page.tsx");
const all = read("apps/admin-web/src/app/service-reports/AllServiceReports.tsx");
const unitPage = read("apps/admin-web/src/app/recd-units/[id]/page.tsx");
const complaints = read("apps/admin-web/src/app/complaints/page.tsx");
const remindersApi = read("apps/api/src/routes/reminders.ts");

test("a customer may open the report list and a single report - and nothing else besides the portal", () => {
  for (const ok of ["/service-reports", "/service-reports/", "/service-reports/ckabc123"]) assert.equal(isCustomerReportPath(ok), true, ok);
  for (const no of ["/", "/customer/portal", "/complaints", "/customers", "/orders", "/service-reports/ckabc123/pdf", "/service-reports/a/b", "/service-reports-evil", "/xservice-reports", "/amc-orders"]) {
    assert.equal(isCustomerReportPath(no), false, no);
  }
});

test("REGRESSION: every service-report link the customer portal renders lands on a page a customer may open (it used to bounce back to the portal)", () => {
  const hrefs = [...portal.matchAll(/href=\{`([^`]*service-reports[^`]*)`\}/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 2, "the portal links to the ticket's reports and to each report");
  for (const href of hrefs) {
    const path = href.replace(/\$\{[^}]*\}/g, "someid").split("?")[0];
    assert.equal(isCustomerReportPath(path), true, `${href} -> ${path}`);
  }
  assert.ok(hrefs.some((h) => h.includes("?complaintId=")), "the ticket link carries the ticket in the query string, which is not part of the path the guard checks");
});

test("the guard uses that one rule for the redirect AND for what it renders to a customer", () => {
  assert.match(guard, /import \{ isCustomerReportPath, SERVICE_REPORT_LIST_PERMISSIONS \} from "@\/lib\/routeAccess"/);
  assert.match(guard, /pathname !== "\/customer\/portal" && !isCustomerReportPath\(pathname\)/);
  assert.match(guard, /isCustomerPortal \|\| isCustomerReportPath\(pathname\)/);
  assert.doesNotMatch(guard, /function isCustomerReportPath/, "no second, stricter copy of the rule");
});

test("staff: the report list has a menu entry and a route rule, both limited to people who hold a ticket or AMC permission", () => {
  assert.deepEqual([...SERVICE_REPORT_LIST_PERMISSIONS].sort(), ["act_assigned_complaints", "manage_amc_orders", "manage_complaints", "view_complaints_overview"]);
  assert.match(guard, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  assert.match(nav, /"\/service-reports": \[\.\.\.SERVICE_REPORT_LIST_PERMISSIONS\]/);
  assert.match(nav, /href: "\/service-reports", label: "Service reports"/);
});

test("links from other screens still point at the per-ticket / per-AMC lists and single reports, as before", () => {
  assert.match(complaints, /\/service-reports\?complaintId=\$\{c\.id\}/);
  assert.match(unitPage, /\/service-reports\/\$\{r\.id\}/);
  assert.match(remindersApi, /\/service-reports\?complaintId=\$\{r\.activityId\}/, "the reminders API link for a ticket (staff)");
  assert.match(page, /if \(!params\.get\("complaintId"\) && !params\.get\("amcOrderId"\)\) return <AllServiceReports \/>/, "no ticket / AMC order in the address -> the list");
});

test("the list screen: customers read /mine (own non-draft reports) with no staff filters; staff read the scoped list with filters and paging; nobody gets a create form here", () => {
  assert.match(all, /api<\{ reports: Row\[\] \}>\("\/service-reports\/mine"\)/);
  assert.match(all, /`\/service-reports\?\$\{reportListQuery\(filters\)\}`/);
  assert.match(all, /!isCustomer && \(\s*<form/, "filters only for staff");
  assert.match(all, /data-testid="reports-paging"/);
  assert.doesNotMatch(all, /method: "POST"/, "listing never writes");
  for (const col of ["Report", "For", "Customer / site", "RECD serial", "Status"]) assert.match(all, new RegExp(col), col);
  assert.match(all, /Serial not entered/, "a legacy unit without a serial reads clearly");
});

test("reportListQuery: only known values reach the address; paging is bounded; free text is trimmed and capped", () => {
  assert.equal(reportListQuery(EMPTY_REPORT_FILTERS), `limit=${REPORT_LIST_PAGE_SIZE}&offset=0`);
  assert.equal(
    reportListQuery({ status: "signed", kind: "amc", q: "  SN-1  ", offset: 50 }),
    `status=signed&kind=amc&q=SN-1&limit=${REPORT_LIST_PAGE_SIZE}&offset=50`,
  );
  assert.equal(reportListQuery({ status: "approved", kind: "other", q: "", offset: -5 }), `limit=${REPORT_LIST_PAGE_SIZE}&offset=0`, "unknown status / kind and a negative offset are dropped");
  assert.ok(reportListQuery({ ...EMPTY_REPORT_FILTERS, q: "x".repeat(500) }).includes(`q=${"x".repeat(100)}&`));
  assert.ok(!reportListQuery({ ...EMPTY_REPORT_FILTERS, q: "a&status=signed" }).includes("&status=signed"), "the search text cannot inject another filter");
});

test("reportSource and pageRange: the labels the list shows", () => {
  assert.equal(reportSource({ kind: "ticket", ticketNumber: "TCK-1", amc: null }), "TCK-1");
  assert.equal(reportSource({ kind: "amc", ticketNumber: null, amc: { ref: "AMC-ABC123" } }), "AMC AMC-ABC123");
  assert.equal(reportSource({ kind: "ticket", ticketNumber: null, amc: null }), "Ticket");
  assert.equal(pageRange(0, 25, 60), "1-25 of 60");
  assert.equal(pageRange(50, 10, 60), "51-60 of 60");
  assert.equal(pageRange(0, 0, 0), "0 of 0");
});
