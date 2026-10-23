// Requirement 9 / 10 audit follow-ups on the web screens. The repo has no component-test runner, so these are source-level checks of the wiring plus
// runs of the pure helpers. They do NOT replace trying the screens in a real browser (not done).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vendorRequiredOnEdit } from "../src/lib/userAdminUi";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const users = read("apps/admin-web/src/app/users/page.tsx");
const orders = read("apps/admin-web/src/app/orders/page.tsx");
const site = read("apps/admin-web/src/app/sites/[id]/page.tsx");

test("R10: the Vendor box is required for a vendor-linked engineer or someone moved INTO the role - not for an existing internal engineer", () => {
  assert.equal(vendorRequiredOnEdit({ roleKey: "erection_engineer", vendorId: null }, "erection_engineer"), false, "internal engineer: name edit must not demand a vendor");
  assert.equal(vendorRequiredOnEdit({ roleKey: "erection_engineer", vendorId: undefined }, "erection_engineer"), false);
  assert.equal(vendorRequiredOnEdit({ roleKey: "erection_engineer", vendorId: "v1" }, "erection_engineer"), true, "vendor-linked: may be changed, not emptied");
  assert.equal(vendorRequiredOnEdit({ roleKey: "sales", vendorId: null }, "erection_engineer"), true, "moving into the role needs a vendor");
  assert.equal(vendorRequiredOnEdit({ roleKey: "erection_engineer", vendorId: null }, "sales"), false, "other roles never need one");
  assert.equal(vendorRequiredOnEdit({ roleKey: "sales", vendorId: null }, "sales"), false);
});

test("R10: the edit dialog uses that rule for the select, and sends a vendor only when it changed", () => {
  assert.match(users, /required=\{vendorRequiredOnEdit\(\{ roleKey: editUser\.role\.key, vendorId: editUser\.vendorId \}, editForm\.roleKey\)\}/);
  assert.match(users, /roleNeedsVendor\(editForm\.roleKey\) && editForm\.vendorId !== \(editUser\.vendorId \?\? ""\)\) body\.vendorId/);
  assert.match(users, /No vendor \(internal engineer\)/);
  // the create dialog still insists on a vendor
  assert.match(users, /roleNeedsVendor\(form\.roleKey\) && \(/);
});

test("R9: a refused order removes the customer / product that THIS attempt created (no orphans); an existing one is never touched", () => {
  assert.match(orders, /let createdCustomerId: string \| null = null;/);
  assert.match(orders, /createdCustomerId = created\.id;/);
  assert.match(orders, /createdProductId = created\.id;/);
  const catchBlock = orders.slice(orders.indexOf("// Best effort and safe"), orders.indexOf("} finally {", orders.indexOf("// Best effort and safe")));
  assert.match(catchBlock, /api\(`\/products\/\$\{createdProductId\}`, \{ method: "DELETE" \}\)/);
  assert.match(catchBlock, /api\(`\/customers\/\$\{createdCustomerId\}`, \{ method: "DELETE" \}\)/);
  assert.match(catchBlock, /if \(createdProductId\)/);
  assert.match(catchBlock, /if \(createdCustomerId\)/);
});

test("R9: the 'separate order' form of a site takes an optional PO and the administrator's duplicate tick, and sends them to clone-order", () => {
  assert.match(site, /data-testid="clone-po-number"/);
  assert.match(site, /data-testid="clone-allow-duplicate-po"/);
  assert.match(site, /canOverrideDuplicatePo\(user\?\.role\.key\)/, "the tick is only offered to the override roles (the API checks it again)");
  assert.match(site, /poNumber: clonePo\.trim\(\) \|\| undefined,/);
  assert.match(site, /allowDuplicatePo: \(canOverridePo && cloneAllowDuplicate\) \|\| undefined,/);
});
