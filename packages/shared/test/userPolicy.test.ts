import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PASSWORD_LENGTH,
  ROLE_KEY,
  USER_AUDIT_ACTION,
  assignableRoleKeys,
  canAssignRole,
  canManageAccount,
  createUserSchema,
  emailField,
  loginSchema,
  normalizeEmail,
  passwordChangeSchema,
  planAssociations,
  updateUserSchema,
} from "../src";

const R = ROLE_KEY;

test("e-mail identity: trimmed and lower-cased before validation, so the same address is always one identity", () => {
  assert.equal(normalizeEmail(" Example@Company.com "), "example@company.com");
  for (const raw of ["Example@Company.com", "example@company.com", " example@company.com ", "EXAMPLE@COMPANY.COM\t"]) {
    const p = emailField.safeParse(raw);
    assert.equal(p.success && p.data, "example@company.com", JSON.stringify(raw));
  }
  assert.equal(emailField.safeParse("not-an-email").success, false);
  assert.equal(emailField.safeParse("   ").success, false);
  const base = { name: "  Asha Rao ", roleKey: R.SALES, phone: "9876543210" };
  const c = createUserSchema.safeParse({ ...base, email: " Asha@Example.COM " });
  assert.deepEqual(c.success && [c.data.email, c.data.name], ["asha@example.com", "Asha Rao"]);
  assert.equal(updateUserSchema.safeParse({ email: " A@B.Co " }).success && (updateUserSchema.parse({ email: " A@B.Co " }).email), "a@b.co");
  assert.equal(loginSchema.parse({ email: " Boss@Platino.IN ", password: "longenough" }).email, "boss@platino.in");
});

test("only a Super Admin may grant the Super Admin role or manage a Super Admin account", () => {
  for (const actor of [R.OWNER_ADMIN, R.MANAGEMENT, R.SALES, R.SERVICE_MANAGER, R.REGIONAL_MANAGER]) {
    assert.equal(canAssignRole(actor, R.SUPER_ADMIN), false, `${actor} cannot grant`);
    assert.equal(canManageAccount(actor, R.SUPER_ADMIN), false, `${actor} cannot manage`);
  }
  assert.equal(canAssignRole(R.SUPER_ADMIN, R.SUPER_ADMIN), true);
  assert.equal(canManageAccount(R.SUPER_ADMIN, R.SUPER_ADMIN), true);
  // below the two privileged roles nothing changed: management and owner/admin manage each other (REVIEW) and every lower role
  for (const role of [R.MANAGEMENT, R.SALES, R.ERECTION_ENGINEER, R.SERVICE_ENGINEER, R.FINANCE]) {
    assert.equal(canAssignRole(R.MANAGEMENT, role), true, role);
    assert.equal(canManageAccount(R.MANAGEMENT, role), true, role);
    assert.equal(canAssignRole(R.OWNER_ADMIN, role), true, role);
    assert.equal(canManageAccount(R.OWNER_ADMIN, role), true, role);
  }
});

test("Owner/Admin accounts: only a Super Admin or an Owner/Admin may grant the role or manage the account - Management and every lower role may not", () => {
  for (const actor of [R.SUPER_ADMIN, R.OWNER_ADMIN]) {
    assert.equal(canAssignRole(actor, R.OWNER_ADMIN), true, actor);
    assert.equal(canManageAccount(actor, R.OWNER_ADMIN), true, actor);
  }
  for (const actor of [R.MANAGEMENT, R.SALES, R.OPERATIONS_PM, R.SERVICE_MANAGER, R.REGIONAL_MANAGER, R.SERVICE_ENGINEER, R.CUSTOMER, "unknown_role"]) {
    assert.equal(canAssignRole(actor, R.OWNER_ADMIN), false, `${actor} cannot grant`);
    assert.equal(canManageAccount(actor, R.OWNER_ADMIN), false, `${actor} cannot manage`);
  }
});

test("role picker: the Super Admin option is offered only to a Super Admin", () => {
  const roles = [R.SUPER_ADMIN, R.MANAGEMENT, R.SALES].map((key) => ({ key }));
  assert.deepEqual(assignableRoleKeys(R.MANAGEMENT, roles).map((r) => r.key), [R.MANAGEMENT, R.SALES]);
  assert.deepEqual(assignableRoleKeys(R.OWNER_ADMIN, roles).map((r) => r.key), [R.MANAGEMENT, R.SALES]);
  assert.deepEqual(assignableRoleKeys(R.MANAGEMENT, [{ key: R.OWNER_ADMIN }, ...roles]).map((r) => r.key), [R.MANAGEMENT, R.SALES], "Owner/Admin is not offered to Management");
  assert.deepEqual(assignableRoleKeys(R.OWNER_ADMIN, [{ key: R.OWNER_ADMIN }, ...roles]).map((r) => r.key), [R.OWNER_ADMIN, R.MANAGEMENT, R.SALES]);
  assert.deepEqual(assignableRoleKeys(R.SUPER_ADMIN, roles).map((r) => r.key), [R.SUPER_ADMIN, R.MANAGEMENT, R.SALES]);
});

test("audit actions: the two new ones exist and the old ones are unchanged", () => {
  assert.equal(USER_AUDIT_ACTION.ASSOCIATION_CHANGED, "association_changed");
  assert.equal(USER_AUDIT_ACTION.ACTION_DENIED, "action_denied");
  assert.deepEqual([USER_AUDIT_ACTION.CREATED, USER_AUDIT_ACTION.UPDATED, USER_AUDIT_ACTION.ROLE_CHANGED, USER_AUDIT_ACTION.DEACTIVATED, USER_AUDIT_ACTION.ACTIVATED, USER_AUDIT_ACTION.PASSWORD_RESET], ["created", "updated", "role_changed", "deactivated", "activated", "password_reset"]);
});

const none = { vendorId: null, customerId: null };
const plan = (i: Parameters<typeof planAssociations>[0]) => planAssociations(i);
const ok = (p: ReturnType<typeof planAssociations>) => (p.ok ? { v: p.vendorId, c: p.customerId, vc: p.vendorChanged, cc: p.customerChanged } : p.error);

test("associations on create: customer needs a customer, erection engineer needs a vendor, others need neither", () => {
  assert.deepEqual(ok(plan({ fromRole: null, toRole: R.CUSTOMER, current: none, requested: { customerId: "c1" } })), { v: null, c: "c1", vc: false, cc: true });
  assert.equal(ok(plan({ fromRole: null, toRole: R.CUSTOMER, current: none, requested: {} })), "A customer account must be linked to a customer");
  assert.equal(ok(plan({ fromRole: null, toRole: R.CUSTOMER, current: none, requested: { customerId: "c1", vendorId: "v1" } })), "A customer account cannot belong to a vendor");
  assert.deepEqual(ok(plan({ fromRole: null, toRole: R.ERECTION_ENGINEER, current: none, requested: { vendorId: "v1" } })), { v: "v1", c: null, vc: true, cc: false });
  assert.equal(ok(plan({ fromRole: null, toRole: R.ERECTION_ENGINEER, current: none, requested: {} })), "An erection engineer must be assigned to a vendor");
  assert.equal(ok(plan({ fromRole: null, toRole: R.SALES, current: none, requested: { customerId: "c1" } })), "Only a customer account can be linked to a customer");
  assert.deepEqual(ok(plan({ fromRole: null, toRole: R.SALES, current: none, requested: {} })), { v: null, c: null, vc: false, cc: false });
});

test("associations on a role change clear only what the destination role cannot have", () => {
  const eng = { vendorId: "v1", customerId: null };
  // leaving the vendor-scoped erection-engineer role drops the vendor link that role needed
  assert.deepEqual(ok(plan({ fromRole: R.ERECTION_ENGINEER, toRole: R.MANAGEMENT, current: eng, requested: {} })), { v: null, c: null, vc: true, cc: false });
  assert.deepEqual(ok(plan({ fromRole: R.ERECTION_ENGINEER, toRole: R.SERVICE_ENGINEER, current: eng, requested: {} })), { v: null, c: null, vc: true, cc: false });
  // ... unless the request deliberately keeps a vendor link
  assert.deepEqual(ok(plan({ fromRole: R.ERECTION_ENGINEER, toRole: R.COMMISSIONING_ENGINEER, current: eng, requested: { vendorId: "v1" } })), { v: "v1", c: null, vc: false, cc: false });
  // erection engineer -> erection engineer keeps the vendor
  assert.deepEqual(ok(plan({ fromRole: R.ERECTION_ENGINEER, toRole: R.ERECTION_ENGINEER, current: eng, requested: {} })), { v: "v1", c: null, vc: false, cc: false });
  // another role that happens to carry a vendor link keeps it (no assumption that vendorId means "vendor role")
  assert.deepEqual(ok(plan({ fromRole: R.SALES, toRole: R.MANAGEMENT, current: eng, requested: {} })), { v: "v1", c: null, vc: false, cc: false });
  // a customer converted to staff loses the customer link; staff converted to customer needs one and loses any vendor link
  assert.deepEqual(ok(plan({ fromRole: R.CUSTOMER, toRole: R.SALES, current: { vendorId: null, customerId: "c1" }, requested: {} })), { v: null, c: null, vc: false, cc: true });
  assert.equal(ok(plan({ fromRole: R.SALES, toRole: R.CUSTOMER, current: eng, requested: {} })), "A customer account must be linked to a customer");
  assert.deepEqual(ok(plan({ fromRole: R.ERECTION_ENGINEER, toRole: R.CUSTOMER, current: eng, requested: { customerId: "c9" } })), { v: null, c: "c9", vc: true, cc: true });
  // moving into the erection-engineer role without a vendor is refused
  assert.equal(ok(plan({ fromRole: R.SALES, toRole: R.ERECTION_ENGINEER, current: none, requested: {} })), "An erection engineer must be assigned to a vendor");
  // explicitly removing a required link is refused; removing an optional one is fine
  assert.equal(ok(plan({ fromRole: R.ERECTION_ENGINEER, toRole: R.ERECTION_ENGINEER, current: eng, requested: { vendorId: null } })), "An erection engineer must be assigned to a vendor");
  assert.deepEqual(ok(plan({ fromRole: R.SALES, toRole: R.SALES, current: eng, requested: { vendorId: null } })), { v: null, c: null, vc: true, cc: false });
});

test("password policy: the same minimum as sign-in", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "short" }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "1234567" }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "12345678" }).success, true);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "", newPassword: "12345678" }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ newPassword: "12345678" }).success, false);
});

test("R10: an existing internal erection engineer (no vendor, role unchanged) can be edited; every other path to 'erection engineer without a vendor' is still refused", () => {
  const internal = { vendorId: null as string | null, customerId: null as string | null };
  // profile edit: nothing about the vendor is requested
  const edit = plan({ fromRole: "erection_engineer", toRole: "erection_engineer", current: internal, requested: {} });
  assert.deepEqual(ok(edit), { v: null, c: null, vc: false, cc: false });
  // an explicit "no vendor" for someone who has none is also a no-op
  assert.deepEqual(ok(plan({ fromRole: "erection_engineer", toRole: "erection_engineer", current: internal, requested: { vendorId: null } })), { v: null, c: null, vc: false, cc: false });
  // still refused: creating, moving into the role, clearing an existing vendor
  assert.equal(ok(plan({ fromRole: null, toRole: "erection_engineer", current: internal, requested: {} })), "An erection engineer must be assigned to a vendor");
  assert.equal(ok(plan({ fromRole: "sales", toRole: "erection_engineer", current: internal, requested: {} })), "An erection engineer must be assigned to a vendor");
  assert.equal(ok(plan({ fromRole: "erection_engineer", toRole: "erection_engineer", current: { vendorId: "v1", customerId: null }, requested: { vendorId: null } })), "An erection engineer must be assigned to a vendor");
  // a vendor can be set on an internal engineer
  assert.deepEqual(ok(plan({ fromRole: "erection_engineer", toRole: "erection_engineer", current: internal, requested: { vendorId: "v2" } })), { v: "v2", c: null, vc: true, cc: false });
  // a vendor-linked engineer keeps theirs on a profile edit
  assert.deepEqual(ok(plan({ fromRole: "erection_engineer", toRole: "erection_engineer", current: { vendorId: "v1", customerId: null }, requested: {} })), { v: "v1", c: null, vc: false, cc: false });
});
