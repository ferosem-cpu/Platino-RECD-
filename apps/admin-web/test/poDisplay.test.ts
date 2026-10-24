// PO number display (Requirement 9). The repo has no component-test runner, so these are source-level checks that every
// screen showing an order also shows its PO number (and the duplicate marker where the order record is available).
// They do NOT replace trying the screens in a real browser - that has not been done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

test("orders list, order page and unit pages show the PO number", () => {
  assert.match(read("apps/admin-web/src/app/orders/page.tsx"), /label: "PO #"/);
  assert.match(read("apps/admin-web/src/app/orders/[id]/page.tsx"), /Customer PO/);
  assert.match(read("apps/admin-web/src/app/recd-units/page.tsx"), /PO \{u\.order\.poNumber\}/);
  assert.match(read("apps/admin-web/src/app/recd-units/[id]/page.tsx"), /poNumber/);
});

test("the customer page lists each order's PO (with the duplicate marker), and the site page shows the PO under the order number", () => {
  const customer = read("apps/admin-web/src/app/customers/[id]/page.tsx");
  assert.match(customer, /data-testid="order-po"/);
  assert.match(customer, /o\.poNumber \?\? "-"/);
  assert.match(customer, /o\.poDuplicateFlag/);
  const site = read("apps/admin-web/src/app/sites/[id]/page.tsx");
  assert.match(site, /data-testid="site-po"/);
  assert.match(site, /site\.order\.poNumber/);
  assert.match(site, /site\.order\.poDuplicateFlag/);
});

// Duplicate-PO override checkbox: shown only to the roles the API honours (shared list), and never sent otherwise.
// Source-level checks (no component runner); the server remains the authority - see apps/api/test/orderCreation.test.ts.
import { canOverrideDuplicatePo, ROLE_KEY } from "@recd/shared";

test("the override checkbox is gated by the shared override-role list, which only the administrator roles satisfy", () => {
  for (const r of [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT]) assert.equal(canOverrideDuplicatePo(r), true, r);
  for (const r of Object.values(ROLE_KEY).filter((k) => ![ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT].includes(k as never))) {
    assert.equal(canOverrideDuplicatePo(r), false, r);
  }
  assert.equal(canOverrideDuplicatePo(undefined), false);
  assert.equal(canOverrideDuplicatePo(null), false);
  const page = read("apps/admin-web/src/app/orders/page.tsx");
  assert.match(page, /canOverridePo = canOverrideDuplicatePo\(user\?\.role\.key\)/);
  assert.match(page, /\{canOverridePo && \(\s*<label[^>]*>\s*<input type="checkbox" data-testid="order-allow-duplicate-po"/);
  assert.match(page, /allowDuplicatePo: \(canOverridePo && form\.allowDuplicatePo\) \|\| undefined/);
});
