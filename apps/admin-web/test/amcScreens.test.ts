// AMC dates, vendor AMC, renewal and notice screens (Requirement 7). The repo has no component-test runner, so these are unit tests of
// the display helpers plus source-level checks of the wiring (reading the files as text). They do NOT replace trying the screens in a
// real browser (done separately; see HANDOVER).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AMC_NOTICE_STORAGE_KEY, contractStatusLabel, contractStatusPill, daysText, formatDay, unseenAlerts } from "../src/lib/amcUi";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const orders = read("apps/admin-web/src/app/amc-orders/page.tsx");
const vendor = read("apps/admin-web/src/app/vendor-amcs/page.tsx");
const dialogs = read("apps/admin-web/src/components/AmcContractDialogs.tsx");
const notice = read("apps/admin-web/src/components/AmcExpiryNotice.tsx");
const settingsComp = read("apps/admin-web/src/components/AmcSettings.tsx");
const settingsPage = read("apps/admin-web/src/app/settings/page.tsx");
const nav = read("apps/admin-web/src/components/Nav.tsx");
const guard = read("apps/admin-web/src/components/AuthGuard.tsx");

test("formatDay shows the calendar day exactly as stored, in any time zone", () => {
  assert.equal(formatDay("2027-01-14"), formatDay("2027-01-14T00:00:00.000Z"));
  assert.match(formatDay("2027-01-14"), /14/);
  assert.match(formatDay("2027-01-14"), /2027/);
  assert.equal(formatDay(null), "-");
  assert.equal(formatDay("not-a-date"), "-");
  assert.doesNotThrow(() => formatDay("2027-02-30"), "an impossible date never throws");
});

test("status labels, pill classes and the days sentence", () => {
  assert.equal(contractStatusLabel("expiring_soon"), "Expiring soon");
  assert.equal(contractStatusLabel("upcoming"), "Upcoming");
  assert.equal(contractStatusLabel("renewed"), "Renewed");
  assert.equal(contractStatusLabel("weird"), "weird");
  assert.match(contractStatusPill("active"), /success/);
  assert.match(contractStatusPill("expiring_soon"), /warning/);
  assert.match(contractStatusPill("expired"), /error/);
  assert.match(contractStatusPill("renewed"), /success/);
  assert.equal(contractStatusPill("upcoming"), "status-pill");
  assert.equal(daysText("active", 45), "45 days left");
  assert.equal(daysText("expiring_soon", 1), "1 day left");
  assert.equal(daysText("expiring_soon", 0), "ends today");
  assert.equal(daysText("expired", -1), "expired 1 day ago");
  assert.equal(daysText("expired", -12), "expired 12 days ago");
  assert.equal(daysText("upcoming", 400), "not started yet");
  assert.match(daysText("renewed", 400), /new period has not started/);
});

test("the login notice does not repeat a contract already shown in this session, but shows a changed one", () => {
  const a = { key: "customer:1:2026-12-31:expiring_soon" };
  const b = { key: "vendor:2:2026-11-01:expired" };
  assert.deepEqual(unseenAlerts([a, b], []), [a, b]);
  assert.deepEqual(unseenAlerts([a, b], [a.key]), [b]);
  assert.deepEqual(unseenAlerts([a, b], [a.key, b.key]), []);
  const renewedOrWorse = { key: "customer:1:2026-12-31:expired" };
  assert.deepEqual(unseenAlerts([renewedOrWorse], [a.key]), [renewedOrWorse], "same contract, new status: shown again");
  assert.equal(AMC_NOTICE_STORAGE_KEY, "recd_amc_notice_seen");
});

test("the customer AMC page no longer derives its expiry from the PO date in the browser", () => {
  assert.doesNotMatch(orders, /amcExpiryDate|setFullYear|isInReminderWindow|ONE_MONTH_MS/);
  assert.match(orders, /o\.startDate/);
  assert.match(orders, /o\.endDate/);
  assert.match(orders, /contractStatusPill\(o\.contractStatus\)/);
  assert.match(orders, /datesSource === "legacy_po_date"/, "derived dates are labelled");
});

test("customer AMC page: optional start / end / duration in the create form, and renew / edit / history actions with loading and empty states", () => {
  for (const id of ["amc-start-date", "amc-end-date", "amc-duration"]) assert.match(orders, new RegExp(id));
  assert.match(orders, /durationMonths/);
  assert.match(orders, /RenewDialog/);
  assert.match(orders, /EditDialog/);
  assert.match(orders, /HistoryDialog/);
  assert.match(orders, /amc-loading/);
  assert.match(orders, /No AMC orders found/);
  assert.match(orders, /role="alert"/);
  assert.match(orders, /basePath="\/amc-orders"/);
});

test("vendor AMC page: separate endpoint, approved vendors only, all states and the same dialogs", () => {
  assert.match(vendor, /"\/vendor-amcs"/);
  assert.doesNotMatch(vendor, /"\/amc-orders/);
  assert.match(vendor, /status === "approved"/);
  assert.match(vendor, /vendor-amc-loading/);
  assert.match(vendor, /No vendor AMC contracts yet/);
  assert.match(vendor, /basePath="\/vendor-amcs"/);
  for (const d of ["RenewDialog", "EditDialog", "HistoryDialog"]) assert.match(vendor, new RegExp(d));
});

test("dialogs: a renewal sends the end date the user saw, ignores a second click, and shows errors; a date edit asks for a reason; history has loading / empty / error", () => {
  assert.match(dialogs, /expectedEndDate: target\.endDate/);
  assert.match(dialogs, /if \(saving\) return/);
  assert.match(dialogs, /data-testid="renew-error"/);
  assert.match(dialogs, /edit-reason/);
  assert.match(dialogs, /datesChanged && /);
  assert.match(dialogs, /Loading…/);
  assert.match(dialogs, /history-empty/);
  assert.match(dialogs, /Could not load the history/);
  assert.match(dialogs, /\/renew`/);
  assert.match(dialogs, /\/renewals`/);
});

test("the notice asks the server what to show, remembers dismissals per session, never blocks sign-in on failure, and links only for users with AMC access", () => {
  assert.match(notice, /api<[^>]*>\("\/amc-alerts"\)/);
  assert.match(notice, /sessionStorage/);
  assert.match(notice, /catch\(\(\) => \{\}\)/);
  assert.match(notice, /canOpenAmc &&/);
  assert.match(guard, /<AmcExpiryNotice userId=\{user\.id\} canOpenAmc=\{false\} \/>/, "customer portal: no link to staff pages");
  assert.match(guard, /canOpenAmc=\{user\.permissions\.includes\("manage_amc_orders"\)\}/);
});

test("settings component writes to the AMC endpoint, empty means default, and it is on the Settings page (which is itself manage_settings only)", () => {
  assert.match(settingsComp, /\/settings\/amc/);
  assert.match(settingsComp, /trim\(\) === "" \? null/);
  assert.match(settingsPage, /<AmcSettings \/>/);
  assert.match(guard, /"\/settings": \["manage_settings"\]/);
});

test("navigation and route guard: the vendor AMC page needs the AMC permission", () => {
  assert.match(nav, /href: "\/vendor-amcs"/);
  assert.match(nav, /"\/vendor-amcs": \["manage_amc_orders"\]/);
  assert.match(guard, /"\/vendor-amcs": \["manage_amc_orders"\]/);
});

test("Vendor AMC form: optional customer and site (the site list comes from the customer's units); sent only when chosen", () => {
  assert.match(vendor, /data-testid="vendor-amc-customer"/);
  assert.match(vendor, /data-testid="vendor-amc-site"/);
  assert.match(vendor, /\/recd-units\?customerId=\$\{encodeURIComponent\(form\.customerId\)\}/, "sites are those of the customer's units, like the customer AMC form");
  assert.match(vendor, /form\.customerId \? \{ customerId: form\.customerId \} : \{\}/);
  assert.match(vendor, /form\.customerId && form\.siteId \? \{ siteId: form\.siteId \} : \{\}/, "a site is never sent without its customer");
  assert.match(vendor, /disabled=\{!form\.customerId\}/, "the site list is disabled until a customer is chosen");
  assert.match(vendor, /setForm\(\{ \.\.\.form, customerId: e\.target\.value, siteId: "" \}\)/, "changing the customer clears the site");
});

test("Vendor AMC list shows the customer and site, 'All sites' for a customer-wide contract and 'General agreement' otherwise", () => {
  assert.match(vendor, /Customer \/ site/);
  assert.match(vendor, /r\.customer \?/);
  assert.match(vendor, /All sites/);
  assert.match(vendor, /General agreement/);
  assert.match(vendor, /r\.site\.companyName \?\? "Not set"/, "a site without a name uses the same fallback as the other screens");
  assert.match(vendor, /colSpan=\{7\}/, "the empty and loading rows span the new column");
});

test("the login notice names the customer and site; for a vendor contract only when one was recorded", () => {
  assert.match(notice, /data-testid="amc-notice-where"/);
  assert.match(notice, /a\.kind === "vendor" \? a\.customerName \|\| a\.siteName : a\.siteName/);
  assert.match(notice, /a\.kind === "vendor" \? "Vendor AMC" : "Customer AMC"/, "the notice still labels the AMC type");
});

test("login pop-up shows the AMC type (CAMC / NAMC label), customer, site and the expiry date (R7)", () => {
  const src = readFileSync(resolve(__dirname, "../src/components/AmcExpiryNotice.tsx"), "utf8");
  assert.match(src, /AMC_TYPE_LABELS\[a\.amcType\]/);
  assert.match(src, /Expiry \{formatDay\(a\.endDate\)\}/);
  assert.match(src, /data-testid="amc-notice-where"/);
});
