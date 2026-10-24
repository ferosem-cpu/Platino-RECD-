// Users page and change-password screen (Requirement 10). No component runner in this repo, so: unit tests of the display helpers plus
// source-level checks of the wiring. These controls only improve usability - the API enforces every rule (see apps/api/test/userAdmin.test.ts
// and test/db/userAdmin.db.test.ts) - and they do not replace trying the screens in a browser (done separately; see HANDOVER).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROLE_KEY } from "@recd/shared";
import { OWN_ACCOUNT_REASON, SUPER_ADMIN_ONLY_REASON, checkEmailInput, roleNeedsVendor, roleOptionsFor, rowActionsFor, userAdminErrorMessage } from "../src/lib/userAdminUi";
import { ApiRequestError } from "../src/lib/apiClient";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const page = read("apps/admin-web/src/app/users/page.tsx");
const change = read("apps/admin-web/src/app/change-password/page.tsx");
const R = ROLE_KEY;
const roles = [R.SUPER_ADMIN, R.OWNER_ADMIN, R.MANAGEMENT, R.SALES, R.ERECTION_ENGINEER].map((key) => ({ key, name: key }));

test("role picker: Super Admin is offered only to a Super Admin; an account's current role is always kept so an edit never drops it", () => {
  assert.deepEqual(roleOptionsFor(R.MANAGEMENT, roles).map((r) => r.key), [R.MANAGEMENT, R.SALES, R.ERECTION_ENGINEER], "Management is not offered the Owner/Admin role either");
  assert.deepEqual(roleOptionsFor(R.OWNER_ADMIN, roles).map((r) => r.key), [R.OWNER_ADMIN, R.MANAGEMENT, R.SALES, R.ERECTION_ENGINEER]);
  assert.deepEqual(roleOptionsFor(R.SUPER_ADMIN, roles).map((r) => r.key), roles.map((r) => r.key));
  assert.ok(roleOptionsFor(R.MANAGEMENT, roles, R.SUPER_ADMIN).some((r) => r.key === R.SUPER_ADMIN), "viewing a Super Admin row keeps its own role in the list");
});

test("row actions: a Super Admin row is locked for everyone else; nobody can reset or deactivate themselves; a Super Admin can manage other Super Admins", () => {
  const sa = { id: "sa", role: { key: R.SUPER_ADMIN } };
  const sales = { id: "s", role: { key: R.SALES } };
  const mgmt = { id: "m", actor: true, role: { key: R.MANAGEMENT } };
  assert.deepEqual(rowActionsFor({ id: "m", roleKey: R.MANAGEMENT }, sa), { edit: false, reset: false, toggleActive: false, reason: SUPER_ADMIN_ONLY_REASON });
  assert.deepEqual(rowActionsFor({ id: "m", roleKey: R.OWNER_ADMIN }, sa), { edit: false, reset: false, toggleActive: false, reason: SUPER_ADMIN_ONLY_REASON });
  const owner = { id: "o", role: { key: R.OWNER_ADMIN } };
  assert.deepEqual(rowActionsFor({ id: "m", roleKey: R.MANAGEMENT }, owner), { edit: false, reset: false, toggleActive: false, reason: SUPER_ADMIN_ONLY_REASON }, "Management cannot manage an Owner/Admin row");
  assert.deepEqual(rowActionsFor({ id: "x", roleKey: R.OWNER_ADMIN }, owner), { edit: true, reset: true, toggleActive: true, reason: null }, "an Owner/Admin can manage another Owner/Admin");
  assert.deepEqual(rowActionsFor({ id: "m", roleKey: R.MANAGEMENT }, sales), { edit: true, reset: true, toggleActive: true, reason: null });
  assert.deepEqual(rowActionsFor({ id: "m", roleKey: R.MANAGEMENT }, mgmt), { edit: true, reset: false, toggleActive: false, reason: OWN_ACCOUNT_REASON });
  assert.deepEqual(rowActionsFor({ id: "x", roleKey: R.SUPER_ADMIN }, sa), { edit: true, reset: true, toggleActive: true, reason: null });
  assert.deepEqual(rowActionsFor({ id: "sa", roleKey: R.SUPER_ADMIN }, sa), { edit: true, reset: false, toggleActive: false, reason: OWN_ACCOUNT_REASON });
  assert.deepEqual(rowActionsFor(null, sales), { edit: false, reset: false, toggleActive: false, reason: null });
});

test("vendor picker appears for the vendor-scoped role only", () => {
  assert.equal(roleNeedsVendor(R.ERECTION_ENGINEER), true);
  for (const r of [R.SALES, R.MANAGEMENT, R.CUSTOMER, R.SUPER_ADMIN]) assert.equal(roleNeedsVendor(r), false, r);
});

test("error messages: refusals keep the server's wording (403 with a lead), conflicts are shown as they are, expired sessions say so", () => {
  const e = (status: number, error: unknown) => new ApiRequestError(JSON.stringify(error), status, { error });
  assert.equal(userAdminErrorMessage(e(403, "Only a Super Admin can grant the Super Admin role or manage a Super Admin account"), "x"), "Not allowed: Only a Super Admin can grant the Super Admin role or manage a Super Admin account");
  assert.match(userAdminErrorMessage(e(409, "That email address is already used by another user (email addresses are not case-sensitive)"), "x"), /^That email address is already used/);
  assert.match(userAdminErrorMessage(e(409, "That mobile number is already used by another user"), "x"), /mobile number/);
  assert.match(userAdminErrorMessage(e(401, "Your session is no longer valid - please sign in again"), "x"), /sign in again/);
  assert.equal(userAdminErrorMessage(e(400, { formErrors: [], fieldErrors: { email: ["Invalid email"] } }), "x"), "email: Invalid email");
  assert.equal(userAdminErrorMessage(new Error(""), "Failed to add user"), "Failed to add user");
  assert.equal(userAdminErrorMessage(null, "Failed to add user"), "Failed to add user");
});

test("email input is normalised the way the server does it and obviously bad input is caught before submit", () => {
  assert.deepEqual(checkEmailInput("  Example@Company.COM "), { ok: true, email: "example@company.com" });
  assert.deepEqual(checkEmailInput("   "), { ok: false, error: "Enter an email address" });
  for (const bad of ["plain", "a@b", "a b@c.com", "@x.com"]) assert.deepEqual(checkEmailInput(bad), { ok: false, error: "Enter a valid email address" }, bad);
});

test("users page: role options come from the policy helper, the vendor is chosen by destination role, own row cannot change role or links", () => {
  assert.match(page, /import \{[^}]*roleOptionsFor[^}]*\} from "@\/lib\/userAdminUi"/);
  assert.match(page, /roleOptionsFor\(actor\?\.roleKey \?\? "", roles\)/, "create form");
  assert.match(page, /roleOptionsFor\(actor\?\.roleKey \?\? "", roles, editUser\.role\.key\)/, "edit form keeps the current role");
  assert.match(page, /roleNeedsVendor\(form\.roleKey\)/);
  assert.match(page, /roleNeedsVendor\(editForm\.roleKey\)/);
  assert.match(page, /disabled=\{editUser\.id === actor\?\.id\}/);
  assert.match(page, /edit-vendor-cleared-note/, "moving out of the erection-engineer role warns that the vendor link and sessions go");
  assert.match(page, /vendorId: user\.vendorId \?\? ""/, "the existing vendor is preserved when editing");
  assert.match(page, /if \(editForm\.roleKey !== editUser\.role\.key\) body\.roleKey/, "an unchanged role is not re-sent");
});

test("users page: unavailable row actions are disabled with the reason, in both the table and the mobile cards; errors are shown for every action", () => {
  assert.equal((page.match(/disabled=\{!actionsFor\(u\)\.edit\}/g) ?? []).length, 2);
  assert.equal((page.match(/disabled=\{!actionsFor\(u\)\.reset\}/g) ?? []).length, 2);
  assert.equal((page.match(/disabled=\{!actionsFor\(u\)\.toggleActive\}/g) ?? []).length, 4, "deactivate and activate, table and cards");
  assert.match(page, /actionsFor\(u\)\.reason/);
  for (const m of ["Failed to add user", "Failed to update user", "Failed to deactivate user", "Failed to activate user", "Failed to reset password"]) assert.match(page, new RegExp(`userAdminErrorMessage\\(err, "${m}"\\)`));
  assert.match(page, /data-testid="edit-error"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /association_changed: "Customer \/ vendor link changed"/);
  assert.match(page, /action_denied: "Refused \(not allowed\)"/);
});

test("users page: e-mail is checked and normalised before submit on create and edit; the existing phone check and password-reset confirmation remain", () => {
  assert.equal((page.match(/checkEmailInput\(/g) ?? []).length, 2);
  assert.match(page, /mobileFieldError\(form\.phone\)/);
  assert.match(page, /mobileFieldError\(editForm\.phone\)/);
  assert.match(page, /Generate a new temporary password for/);
  assert.match(page, /data-testid="users-mobile-cards"/, "the responsive card list is still there");
});

test("change-password: same minimum as sign-in, keeps this session on the fresh token the server returns, shows server messages", () => {
  assert.match(change, /MIN_PASSWORD_LENGTH/);
  assert.match(change, /setToken\(result\.token\)/);
  assert.match(change, /apiErrorMessage\(err, "Failed to change password"\)/);
  assert.doesNotMatch(change, /length < 6/);
});
