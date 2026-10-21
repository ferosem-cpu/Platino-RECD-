// Missing order date / value / site name display (Requirement 1 follow-up). The helpers are tested directly; the screens are
// checked at source level (the repo has no component-test runner). Not a browser check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATE_NOT_RECORDED, VALUE_NOT_RECORDED, formatOptionalDate, formatOptionalRupees } from "../src/lib/format";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

test("a missing order date is never shown as 1/1/1970", () => {
  for (const missing of [null, undefined, "", "not a date"]) {
    const out = formatOptionalDate(missing as string | null | undefined);
    assert.equal(out, DATE_NOT_RECORDED);
    assert.doesNotMatch(out, /1970/);
  }
  assert.equal(DATE_NOT_RECORDED, "Date not recorded");
});

test("a recorded date keeps the existing display", () => {
  assert.equal(formatOptionalDate("2026-10-19T00:00:00.000Z"), new Date("2026-10-19T00:00:00.000Z").toLocaleDateString());
  const d = new Date(2026, 0, 5);
  assert.equal(formatOptionalDate(d), d.toLocaleDateString());
});

test("a missing order value is the placeholder, a genuine zero is still shown", () => {
  for (const missing of [null, undefined, "", "abc"]) assert.equal(formatOptionalRupees(missing as string | null | undefined), VALUE_NOT_RECORDED);
  assert.equal(formatOptionalRupees(0), "₹0");
  assert.equal(formatOptionalRupees("0"), "₹0");
  assert.equal(formatOptionalRupees("850000"), "₹8,50,000");
  assert.equal(formatOptionalRupees(850000.5), `₹${(850000.5).toLocaleString("en-IN")}`);
});

test("order screens use the helpers instead of formatting null directly", () => {
  const detail = read("apps/admin-web/src/app/orders/[id]/page.tsx");
  assert.doesNotMatch(detail, /new Date\(order\.orderDate\)/);
  assert.doesNotMatch(detail, /Number\(order\.value\)/);
  assert.match(detail, /formatOptionalDate\(order\.orderDate\)/);
  assert.match(detail, /formatOptionalRupees\(order\.value\)/);
  const list = read("apps/admin-web/src/app/orders/page.tsx");
  assert.doesNotMatch(list, /₹\{Number\(o\.value\)/); // (the sort accessor still uses Number(o.value); only the display changed)
  assert.match(list, /formatOptionalRupees\(o\.value\)/);
  assert.match(read("apps/admin-web/src/app/customer/portal/page.tsx"), /formatOptionalDate\(site\.order\.orderDate\)/);
});

test("the legacy serial-entry error is unwrapped (no literal quotes) and serial rules are untouched", () => {
  const detail = read("apps/admin-web/src/app/orders/[id]/page.tsx");
  assert.match(detail, /setError\(apiErrorMessage\(err, "Failed to save serial number"\)\)/);
  assert.match(detail, /serialNo/);
});

test("the unit screens fall back to 'Not set' for a missing site name (same as the order screens), never a bare 'Site'", () => {
  for (const p of ["apps/admin-web/src/app/recd-units/page.tsx", "apps/admin-web/src/app/recd-units/[id]/page.tsx"]) {
    const src = read(p);
    assert.match(src, /companyName \?\? "Not set"/);
    assert.doesNotMatch(src, /Unnamed site/);
    assert.doesNotMatch(src, /companyName \?\? "Site"/);
  }
});

test("the orders list shows 'Not set' for a missing site name, in the table and the card view", () => {
  const src = read("apps/admin-web/src/app/orders/page.tsx");
  assert.match(src, /render: \(o\) => o\.site\?\.companyName \?\? "Not set"/);
  assert.match(src, /o\.site\?\.companyName \?\? "Not set"\}<\/p>/);
  assert.match(read("apps/admin-web/src/app/orders/[id]/page.tsx"), /order\.site\.companyName \?\? "Not set"/);
});

test("the order form drops only the technical 'recdSerials:' prefix from its error", () => {
  assert.match(read("apps/admin-web/src/app/orders/page.tsx"), /withoutFieldPrefix\(apiErrorMessage\(err, "Failed to create order"\), "recdSerials"\)/);
});
