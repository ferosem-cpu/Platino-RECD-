// Mobile screens: RECD serial numbers and contact mobile numbers (Requirement 2). The app has no component-test runner, so these are
// source-level checks of the wiring (the screens read the fields the API returns and show them through the shared, unit-tested
// helpers) plus a run of those helpers against the shapes the mobile API calls return. They do NOT replace trying the screens on a
// device or emulator - that has not been done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NO_MOBILE_LABEL, SERIAL_MISSING_LABEL, siteContactLines, unitLines, unitSerialsSummary } from "@recd/shared";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const myOrders = read("src/screens/MyOrdersScreen.tsx");
const mySites = read("src/screens/MySitesScreen.tsx");
const orderDetail = read("src/screens/OrderDetailScreen.tsx");
const siteDetail = read("src/screens/SiteDetailScreen.tsx");
const units = read("src/components/UnitSerials.tsx");
const contacts = read("src/components/SiteContacts.tsx");

test("customer order list shows the serial(s) of each order, from the units the API already returns on GET /orders", () => {
  assert.match(myOrders, /units\?: Array<\{ id: string; serialNo: string \| null \}>/);
  assert.match(myOrders, /unitSerialsSummary\(item\.units\)/);
});

test("field engineer's site list shows the serial(s) and the Site POC with number, from GET /sites?assigned_to=me", () => {
  assert.match(mySites, /unitSerialsSummary\(item\.units\)/);
  assert.match(mySites, /sitePocName/);
  assert.match(mySites, /mobileOrNone\(item\.sitePocNumber\)/);
});

test("order detail (customer) and site detail (field) show the RECD serial and the site contacts from GET /sites/:id", () => {
  for (const [name, src] of [["OrderDetail", orderDetail], ["SiteDetail", siteDetail]] as const) {
    assert.match(src, /<UnitSerials units=\{site\.units\} \/>/, name);
    assert.match(src, /<SiteContacts site=\{site\} \/>/, name);
    assert.match(src, /contacts\?: Array<\{ id: string; name: string; role: string \| null; phone: string \| null \}>/, name);
  }
});

test("the components format through the shared helpers, so a missing value always reads the standard text", () => {
  assert.match(units, /unitLines\(units\)/);
  assert.match(contacts, /siteContactLines\(site\)/);
  assert.match(contacts, /telHref\(c\.phone\)/, "a number is only a call link when it is a plain number");
  assert.doesNotMatch(units + contacts, /\bphone \|\| |serialNo \|\| /, "no ad-hoc fallbacks that could show another value");
});

test("no mobile screen builds a phone number from a different record (only the API's own contact fields are read)", () => {
  for (const src of [mySites, orderDetail, siteDetail, contacts]) {
    assert.doesNotMatch(src, /assignedEngineer\??\.phone|vendor\??\.(contactPhone|phone)|customer\??\.(phone|contacts)/);
  }
});

test("what the API returns for a legacy site (no units, no contact, POC without a number) renders as the standard text, not blanks", () => {
  assert.equal(unitSerialsSummary(undefined), "No RECD recorded");
  assert.deepEqual(unitLines([{ id: "u1", serialNo: null, status: "active" }]).map((l) => l.serial), [SERIAL_MISSING_LABEL]);
  const lines = siteContactLines({ sitePocName: "Ravi", sitePocNumber: null, contacts: [{ id: "c1", name: "Desk", role: "Security", phone: "" }] });
  assert.deepEqual(lines.map((l) => l.phone), [NO_MOBILE_LABEL, NO_MOBILE_LABEL]);
});

test("a normal site renders its serial and both kinds of contact", () => {
  const site = { sitePocName: "Ravi", sitePocNumber: "9876543210", contacts: [{ id: "c1", name: "Desk", role: null, phone: "9123456780" }] };
  assert.equal(unitSerialsSummary([{ id: "u1", serialNo: "SN-1" }, { id: "u2", serialNo: "SN-2" }]), "SN-1, SN-2");
  assert.deepEqual(siteContactLines(site).map((l) => `${l.heading}|${l.name}|${l.phone}`), ["Site POC|Ravi|9876543210", "Site contact|Desk|9123456780"]);
});
