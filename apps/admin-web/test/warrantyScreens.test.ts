// Unit warranty screens (Requirement 8). The repo has no component-test runner, so these are unit tests of the display helpers plus
// source-level checks of the wiring (reading the files as text). They do NOT replace trying the screens in a real browser (done
// separately; see HANDOVER).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unseenAlerts } from "../src/lib/amcUi";
import { WARRANTY_NOTICE_STORAGE_KEY, warrantyDaysText, warrantyFormError, warrantyRange, warrantySourceLabel, warrantyStatusLabel, warrantyStatusPill } from "../src/lib/warrantyUi";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const panel = read("apps/admin-web/src/components/WarrantyPanel.tsx");
const detail = read("apps/admin-web/src/app/recd-units/[id]/page.tsx");
const list = read("apps/admin-web/src/app/recd-units/page.tsx");
const portal = read("apps/admin-web/src/app/customer/portal/page.tsx");
const portalCard = read("apps/admin-web/src/components/CustomerWarrantyCard.tsx");
const notice = read("apps/admin-web/src/components/WarrantyExpiryNotice.tsx");
const settingsComp = read("apps/admin-web/src/components/WarrantySettings.tsx");
const settingsPage = read("apps/admin-web/src/app/settings/page.tsx");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");
const productsPage = read("apps/admin-web/src/app/products/page.tsx");
const productDetail = read("apps/admin-web/src/app/products/[id]/page.tsx");

test("status labels and pill classes: unknown reads 'Not recorded' and is never styled as valid", () => {
  assert.equal(warrantyStatusLabel("unknown"), "Not recorded");
  assert.equal(warrantyStatusLabel("upcoming"), "Upcoming");
  assert.equal(warrantyStatusLabel("active"), "Active");
  assert.equal(warrantyStatusLabel("expiring_soon"), "Near Expiry");
  assert.equal(warrantyStatusLabel("expired"), "Expired");
  assert.equal(warrantyStatusLabel("weird"), "weird");
  assert.match(warrantyStatusPill("active"), /success/);
  assert.match(warrantyStatusPill("expiring_soon"), /warning/);
  assert.match(warrantyStatusPill("expired"), /error/);
  assert.equal(warrantyStatusPill("unknown"), "status-pill");
  assert.equal(warrantyStatusPill("upcoming"), "status-pill");
});

test("days text: no countdown for unknown or expired, a countdown only while valid", () => {
  const w = (status: any, daysRemaining: number | null = null, daysUntilStart: number | null = null, daysSinceExpiry: number | null = null) => ({ status, daysRemaining, daysUntilStart, daysSinceExpiry });
  assert.match(warrantyDaysText(w("unknown")), /No warranty period has been recorded/);
  assert.doesNotMatch(warrantyDaysText(w("unknown")), /\d/);
  assert.equal(warrantyDaysText(w("active", 45)), "45 days left");
  assert.equal(warrantyDaysText(w("expiring_soon", 1)), "1 day left");
  assert.equal(warrantyDaysText(w("expiring_soon", 0)), "expires today");
  assert.equal(warrantyDaysText(w("upcoming", null, 10)), "starts in 10 days");
  assert.equal(warrantyDaysText(w("upcoming", null, 1)), "starts in 1 day");
  assert.equal(warrantyDaysText(w("expired", null, null, 1)), "expired 1 day ago");
  assert.equal(warrantyDaysText(w("expired", null, null, 12)), "expired 12 days ago");
  assert.doesNotMatch(warrantyDaysText(w("expired", null, null, 12)), /left/);
});

test("source labels and the date range text, including 'not recorded'", () => {
  assert.match(warrantySourceLabel("manual"), /Entered by staff/);
  assert.match(warrantySourceLabel("product_default"), /product/);
  assert.equal(warrantySourceLabel(null), "-");
  const fmt = (iso: string | null) => `<${iso}>`;
  assert.equal(warrantyRange({ startDate: "2026-02-01", endDate: "2027-01-31" }, fmt), "<2026-02-01> to <2027-01-31>");
  assert.equal(warrantyRange({ startDate: null, endDate: null }, fmt), "Not recorded");
  assert.equal(warrantyRange({ startDate: "2026-02-01", endDate: null }, fmt), "Not recorded");
});

test("form validation before submit (the server repeats every rule)", () => {
  const ok = { startDate: "2026-02-01", endDate: "", months: "", reason: "", hasExisting: false };
  assert.equal(warrantyFormError(ok), null);
  assert.equal(warrantyFormError({ ...ok, startDate: "" }), "Enter the warranty start date");
  assert.match(warrantyFormError({ ...ok, endDate: "2026-01-31" })!, /cannot be before/);
  assert.equal(warrantyFormError({ ...ok, endDate: "2026-02-01" }), null, "a one-day period is allowed");
  for (const m of ["0", "-1", "1.5", "121", "abc"]) assert.match(warrantyFormError({ ...ok, months: m })!, /whole number of months/, m);
  assert.equal(warrantyFormError({ ...ok, months: "24" }), null);
  assert.match(warrantyFormError({ ...ok, hasExisting: true })!, /reason/);
  assert.match(warrantyFormError({ ...ok, hasExisting: true, reason: "ab" })!, /reason/);
  assert.equal(warrantyFormError({ ...ok, hasExisting: true, reason: "certificate" }), null);
});

test("the notice remembers dismissals per session (key = unit + expiry date + status) and uses its own storage key", () => {
  assert.equal(WARRANTY_NOTICE_STORAGE_KEY, "recd_warranty_notice_seen");
  const a = { key: "warranty:u1:2026-12-31:expiring_soon" };
  const b = { key: "warranty:u2:2026-11-01:expired" };
  assert.deepEqual(unseenAlerts([a, b], [a.key]), [b]);
  assert.deepEqual(unseenAlerts([{ key: "warranty:u1:2026-12-31:expired" }], [a.key]), [{ key: "warranty:u1:2026-12-31:expired" }], "same unit, new status: shown again");
  assert.deepEqual(unseenAlerts([{ key: "warranty:u1:2027-12-31:expiring_soon" }], [a.key]).length, 1, "a corrected expiry date: shown again");
});

test("unit detail: keeps the product's default duration, adds the warranty panel, and editing depends on manage_warranty", () => {
  assert.match(detail, /Product warranty \(default duration\)/);
  assert.match(detail, /unit\.product\.warrantyMonths/);
  assert.match(detail, /<WarrantyPanel /);
  assert.match(detail, /canEdit=\{hasPermission\("manage_warranty"\)\}/);
  assert.match(detail, /onChanged=\{load\}/, "the page refreshes after a save");
  assert.match(detail, /data-testid="unit-loading"/);
  assert.match(detail, /data-testid="unit-error"/);
});

test("warranty panel: unknown is explicit, dates and provenance shown, history with loading / empty / error, edit button only when allowed", () => {
  assert.match(panel, /warranty-unknown/);
  assert.match(panel, /not treated as active/);
  assert.match(panel, /warranty-dates/);
  assert.match(panel, /Expiry date \(inclusive\)/);
  assert.match(panel, /warrantySourceLabel/);
  assert.match(panel, /warranty-history-empty/);
  assert.match(panel, /Loading…/);
  assert.match(panel, /Could not load the warranty history/);
  assert.match(panel, /\{canEdit && \(/, "the control is not rendered for others (the server enforces it too)");
  assert.match(panel, /\/recd-units\/\$\{unitId\}\/warranty-history/);
});

test("warranty edit dialog: validates first, sends the expiry it saw, ignores a second click, requires a reason to correct, shows server errors", () => {
  assert.match(panel, /warrantyFormError\(/);
  assert.match(panel, /expectedEndDate: warranty\.endDate/);
  assert.match(panel, /if \(saving\) return/);
  assert.match(panel, /hasExisting \? "Reason for the correction/);
  assert.match(panel, /data-testid="warranty-error"/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /method: "PUT"/);
  assert.match(panel, /\/warranty`/);
  assert.match(panel, /product&apos;s standard duration/, "explains the product duration is only a default");
});

test("unit list: a warranty column using the status computed by the API (no extra request per row)", () => {
  assert.match(list, /<th className="px-3 py-2">Warranty<\/th>/);
  assert.match(list, /u\.warranty\.status/);
  assert.match(list, /warrantyStatusPill/);
  assert.match(list, /u\.warranty\.endDate/);
  assert.match(list, /colSpan=\{8\}/);
  assert.match(list, /recd-unit-search/, "the existing search is kept");
  assert.doesNotMatch(list.replace(/api<UnitRow\[\]>\(`\/recd-units\?\$\{q\.toString\(\)\}`\)/, ""), /api</, "only the existing list request");
});

test("customer portal: read-only warranty of the customer's own units from the scoped list; no edit or history controls", () => {
  assert.match(portal, /<CustomerWarrantyCard \/>/);
  assert.match(portalCard, /api<PortalUnit\[]>\("\/recd-units"\)/);
  assert.match(portalCard, /Warranty dates have not been recorded yet/);
  assert.match(portalCard, /No RECD units are registered/);
  assert.match(portalCard, /role="alert"/);
  assert.doesNotMatch(portalCard, /method: "PUT"|warranty-edit|Correct warranty|warranty-history|<input|<button/);
});

test("login notice: asks the server, waits for the AMC notice, remembers dismissals, never blocks sign-in, links only where allowed", () => {
  assert.match(notice, /api<[^>]*>\("\/warranty-alerts"\)/);
  assert.match(notice, /amc-expiry-notice/, "never stacks on the AMC notice");
  assert.match(notice, /sessionStorage/);
  assert.match(notice, /catch\(\(\) => \{\}\)/);
  assert.match(notice, /linkToUnits \?/);
  assert.match(notice, /\/recd-units\/\$\{a\.unitId\}/);
  assert.match(notice, /expiry \{formatDay\(a\.endDate\)\}/);
  assert.match(guard, /<WarrantyExpiryNotice userId=\{user\.id\} linkToUnits=\{false\} \/>/, "the customer portal has no unit page to link to");
  assert.match(guard, /linkToUnits=\{user\.permissions\.includes\("view_site_status"\)\}/);
  assert.match(guard, /<AmcExpiryNotice /, "the AMC notice is still mounted");
});

test("warranty settings: own endpoint, empty means default, on the Settings page (manage_settings only), separate from the AMC settings", () => {
  assert.match(settingsComp, /\/settings\/warranty/);
  assert.match(settingsComp, /trim\(\) === "" \? null/);
  assert.match(settingsComp, /not a separately approved warranty policy/);
  assert.doesNotMatch(settingsComp, /amcReminder|amcDefault|settings.amc/);
  assert.match(settingsPage, /<WarrantySettings \/>/);
  assert.match(settingsPage, /<AmcSettings \/>/);
  assert.match(guard, /"\/settings": \["manage_settings"\]/);
});

test("product screens keep their warranty-duration input and display, now labelled as the default", () => {
  assert.match(productsPage, /placeholder="Warranty \(months\)"/);
  assert.match(productsPage, /warrantyMonths: form\.warrantyMonths \? parseInt\(form\.warrantyMonths, 10\) : undefined/);
  assert.match(productsPage, /A unit keeps the duration it was recorded with/);
  assert.match(productDetail, /Warranty \(default duration\)/);
  assert.match(productDetail, /product\.warrantyMonths != null/);
});
