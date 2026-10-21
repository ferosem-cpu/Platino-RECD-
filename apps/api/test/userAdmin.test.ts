// Route-level tests for user administration (Requirement 10). No database: the Prisma delegates are replaced with an in-memory store that
// behaves like the real one where it matters - a case-insensitive unique e-mail index, a transaction that rolls everything back on error,
// and an advisory lock that serialises the administrator-guard transactions. The REAL routers, authentication middleware and policy run
// over HTTP. The real-database counterparts are in test/db/userAdmin.db.test.ts.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { createFakeRateLimitStore } from "./helpers/fakeRateLimitStore";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R = ROLE_KEY;
const MANAGE = [PERMISSION_KEY.MANAGE_USERS, PERMISSION_KEY.VIEW_SITE_STATUS];
const PERMS: Record<string, string[]> = {
  [R.SUPER_ADMIN]: [...MANAGE, PERMISSION_KEY.MANAGE_SETTINGS],
  [R.OWNER_ADMIN]: MANAGE,
  [R.MANAGEMENT]: MANAGE,
  [R.SALES]: [PERMISSION_KEY.VIEW_SITE_STATUS],
  [R.ERECTION_ENGINEER]: [PERMISSION_KEY.VIEW_SITE_STATUS],
  [R.CUSTOMER]: [PERMISSION_KEY.VIEW_SITE_STATUS],
  [R.SERVICE_ENGINEER]: [PERMISSION_KEY.VIEW_SITE_STATUS],
};
const roleRows = Object.fromEntries(Object.keys(PERMS).map((key) => [key, { id: `role-${key}`, key, name: key }]));

interface Row { id: string; name: string; email: string | null; phone: string | null; title: string | null; roleKey: string; isActive: boolean; vendorId: string | null; customerId: string | null; tokenVersion: number; passwordHash: string | null; mustChangePassword: boolean }
let users: Row[] = [];
let audit: any[] = [];
let failAudit = false;
let nextId = 1;
let lockTail: Promise<void> = Promise.resolve();
// Per-transaction undo log (a snapshot would clobber what a CONCURRENT transaction committed meanwhile).
const txUndo = new AsyncLocalStorage<Array<() => void>>();
const onRollback = (fn: () => void) => txUndo.getStore()?.push(fn);
const VENDORS: Record<string, any> = { v1: { id: "v1", status: "approved" }, v2: { id: "v2", status: "approved" }, vp: { id: "vp", status: "pending" } };
const CUSTOMERS = new Set(["cA", "cB"]);
const PASSWORD = "Test-pass-123";
const HASH = bcrypt.hashSync(PASSWORD, 4);

const view = (r: Row) => ({ ...r, role: roleRows[r.roleKey], roleId: roleRows[r.roleKey].id });
const key = (e: string | null) => (e ?? "").trim().toLowerCase();
const p2002 = (t: string) => new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "5.22.0", meta: { modelName: "User", target: t } });
const emailTaken = (email: string | null, exceptId?: string) => !!email && users.some((u) => u.id !== exceptId && key(u.email) === key(email));

function seed(id: string, roleKey: string, over: Partial<Row> = {}): Row {
  const r: Row = { id, name: id, email: `${id}@example.test`, phone: null, title: null, roleKey, isActive: true, vendorId: null, customerId: null, tokenVersion: 0, passwordHash: HASH, mustChangePassword: false, ...over };
  users.push(r);
  return r;
}

let server: Server;
let base: string;
let signToken: (p: any) => string;
const tok = (id: string) => { const u = users.find((x) => x.id === id)!; return signToken({ userId: u.id, roleKey: u.roleKey, customerId: u.customerId, tokenVersion: u.tokenVersion }); };

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  createFakeRateLimitStore().install(prisma); // the IP limiter keeps its counters in the database; here they live in memory
  ({ signToken } = await import("../src/lib/jwt"));
  const { usersRouter } = await import("../src/routes/users");
  const { authRouter } = await import("../src/routes/auth");

  const applyData = (row: Row, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) {
      if (k === "roleId") row.roleKey = Object.values(roleRows).find((r) => r.id === v)!.key;
      else if (v && typeof v === "object" && "increment" in v) (row as any)[k] = (row as any)[k] + v.increment;
      else (row as any)[k] = v;
    }
  };
  const define = (model: string, impl: any) => Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  define("user", {
    findMany: () => users.map((u) => ({ ...view(u), regionsManaged: [] })),
    findUnique: async ({ where }: any) => { await new Promise((r) => setImmediate(r)); const u = users.find((x) => (where.id ? x.id === where.id : x.email === where.email)); return u ? withPerms(view(u)) : null; },
    findFirst: ({ where }: any) => {
      if (where?.email?.equals !== undefined) { const u = users.find((x) => key(x.email) === key(where.email.equals)); return u ? withPerms(view(u)) : null; }
      const list: string[] = where?.phone?.in ?? [];
      return users.find((r) => r.phone && list.includes(r.phone) && r.id !== where.id?.not) ?? null;
    },
    count: async ({ where }: any) => { await new Promise((r) => setImmediate(r)); return users.filter((u) => u.roleKey === where.role.key && u.isActive === where.isActive).length; },
    create: async ({ data }: any) => {
      await new Promise((r) => setImmediate(r)); // let a racing request run first
      if (emailTaken(data.email)) throw p2002("User_email_normalized_key");
      const row: Row = { id: `new${nextId++}`, name: data.name, email: data.email, phone: data.phone, title: data.title ?? null, roleKey: Object.values(roleRows).find((r) => r.id === data.roleId)!.key, isActive: true, vendorId: data.vendorId ?? null, customerId: data.customerId ?? null, tokenVersion: 0, passwordHash: data.passwordHash, mustChangePassword: data.mustChangePassword };
      users.push(row);
      onRollback(() => { users = users.filter((x) => x !== row); });
      return view(row);
    },
    update: async ({ where, data }: any) => {
      const row = users.find((u) => u.id === where.id)!;
      if (data.email !== undefined && emailTaken(data.email, row.id)) throw p2002("User_email_normalized_key");
      const prev = { ...row };
      applyData(row, data);
      onRollback(() => Object.assign(row, prev));
      return view(row);
    },
  });
  const withPerms = (u: any) => ({ ...u, role: { ...u.role, permissions: (PERMS[u.role.key] ?? []).map((k) => ({ permission: { key: k } })) } });
  define("role", { findUnique: ({ where }: any) => roleRows[where.key] ?? null });
  define("vendor", { findUnique: ({ where }: any) => VENDORS[where.id] ?? null });
  define("customer", { findUnique: ({ where }: any) => (CUSTOMERS.has(where.id) ? { id: where.id } : null) });
  define("userAuditLog", {
    create: async ({ data }: any) => { if (failAudit) throw new Error("audit disk full"); const a = { id: `a${nextId++}`, ...data }; audit.push(a); onRollback(() => { audit = audit.filter((x) => x !== a); }); return data; },
    findMany: () => audit,
  });
  (prisma as any).$transaction = async (fn: any) => {
    const undo: Array<() => void> = [];
    let release: (() => void) | null = null;
    const tx = Object.create(prisma);
    tx.$executeRaw = async () => { const prev = lockTail; lockTail = new Promise<void>((r) => { release = r; }); await prev; }; // the advisory lock
    try {
      return await txUndo.run(undo, () => fn(tx));
    } catch (err) {
      for (const u of undo.reverse()) u();
      throw err;
    } finally {
      (release as any)?.();
    }
  };

  const app = express();
  app.use(express.json());
  app.use("/users", usersRouter);
  app.use("/auth", authRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

beforeEach(() => {
  users = []; audit = []; failAudit = false; nextId = 1; lockTail = Promise.resolve();
  seed("sa1", R.SUPER_ADMIN); seed("sa2", R.SUPER_ADMIN); seed("owner", R.OWNER_ADMIN); seed("mgmt", R.MANAGEMENT); seed("sales", R.SALES);
});

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${as}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}
const newBody = (over: Record<string, unknown> = {}) => ({ name: "New Person", email: `n${nextId}@example.test`, roleKey: R.SALES, phone: `98765${String(40000 + nextId).slice(0, 5)}`, ...over });
const row = (id: string) => users.find((u) => u.id === id)!;
const actions = (id: string) => audit.filter((a) => a.targetUserId === id).map((a) => a.action);

// ---------------------------------------------------------------------------------------------------------------------
// Privileged roles
// ---------------------------------------------------------------------------------------------------------------------

test("Owner/Admin and Management cannot grant Super Admin (create or update); a Super Admin can; the refusal is recorded as a refusal, not a change", async () => {
  for (const actor of ["owner", "mgmt"]) {
    const c = await call(tok(actor), "POST", "/users", newBody({ roleKey: R.SUPER_ADMIN }));
    assert.equal(c.status, 403);
    assert.match(c.body.error, /Only a Super Admin/);
    assert.equal(users.some((u) => u.name === "New Person"), false, "nothing created");
    const u = await call(tok(actor), "PUT", "/users/sales", { roleKey: R.SUPER_ADMIN });
    assert.equal(u.status, 403);
    assert.deepEqual([row("sales").roleKey, row("sales").tokenVersion], [R.SALES, 0]);
  }
  assert.deepEqual(actions("sales"), ["action_denied", "action_denied"]);
  assert.deepEqual(audit.filter((a) => a.action === "action_denied").map((a) => a.changes.operation), ["create_user", "update_user", "create_user", "update_user"]);
  const ok = await call(tok("sa1"), "POST", "/users", newBody({ roleKey: R.SUPER_ADMIN }));
  assert.equal(ok.status, 201);
  assert.equal((await call(tok("sa1"), "PUT", "/users/sales", { roleKey: R.SUPER_ADMIN })).status, 200);
});

test("a Super Admin account cannot be edited, reset, deactivated or reactivated by Owner/Admin or Management (403, unchanged); a Super Admin can", async () => {
  const before = { ...row("sa2") };
  for (const actor of ["owner", "mgmt"]) {
    for (const [m, p, b] of [["PUT", "/users/sa2", { name: "hijack" }], ["PUT", "/users/sa2", { roleKey: R.SALES }], ["POST", "/users/sa2/reset-password"], ["PUT", "/users/sa2/deactivate"], ["PUT", "/users/sa2/activate"]] as any) {
      assert.equal((await call(tok(actor), m, p, b)).status, 403, `${actor} ${m} ${p}`);
    }
  }
  assert.deepEqual(row("sa2"), before);
  assert.ok(actions("sa2").every((a) => a === "action_denied"));
  assert.equal((await call(tok("sa1"), "PUT", "/users/sa2", { name: "ok" })).status, 200);
  assert.equal((await call(tok("sa1"), "POST", "/users/sa2/reset-password")).status, 200);
  assert.equal((await call(tok("sa1"), "PUT", "/users/sa2/deactivate")).status, 200);
});

test("without manage_users nothing is reachable at all (403), whatever the hierarchy", async () => {
  for (const [m, p, b] of [["GET", "/users"], ["POST", "/users", newBody()], ["PUT", "/users/mgmt", { name: "x" }], ["POST", "/users/mgmt/reset-password"], ["PUT", "/users/mgmt/deactivate"], ["GET", "/users/audit-log"]] as any) {
    assert.equal((await call(tok("sales"), m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.equal((await call(null, "GET", "/users")).status, 401);
});

test("an untouched blank title in the edit form is not a change (nothing written, nothing audited, no sessions revoked)", async () => {
  assert.equal((await call(tok("sa1"), "PUT", "/users/sales", { name: "sales", title: "", phone: "9876512345" })).status, 200);
  assert.equal(row("sales").title, null);
  assert.deepEqual(actions("sales"), ["updated"], "only the phone changed");
  assert.equal((await call(tok("sa1"), "PUT", "/users/sales", { title: "  " })).status, 200);
  assert.deepEqual(actions("sales"), ["updated"]);
  assert.equal(row("sales").tokenVersion, 0);
});

test("self rules: no own role change, no own deactivation, no own reset, no own link change; ordinary self-edits work", async () => {
  const t = tok("mgmt");
  assert.equal((await call(t, "PUT", "/users/mgmt", { roleKey: R.SUPER_ADMIN })).status, 403);
  assert.equal((await call(t, "PUT", "/users/mgmt", { roleKey: R.SALES })).status, 400);
  assert.equal((await call(t, "PUT", "/users/mgmt/deactivate")).status, 400);
  assert.equal((await call(t, "POST", "/users/mgmt/reset-password")).status, 400);
  assert.equal((await call(t, "PUT", "/users/mgmt", { vendorId: "v1" })).status, 400);
  assert.deepEqual([row("mgmt").roleKey, row("mgmt").isActive, row("mgmt").tokenVersion], [R.MANAGEMENT, true, 0]);
  assert.equal((await call(t, "PUT", "/users/mgmt", { title: "Head" })).status, 200);
});

test("the last active Super Admin cannot be demoted or deactivated", async () => {
  row("sa2").isActive = false;
  const t = tok("sa1");
  // sa1 is the only active Super Admin and is the actor: use a second account holding the role as the target
  const only = seed("only", R.SUPER_ADMIN);
  row("sa1").isActive = false;
  const demote = await call(tok("sa2"), "PUT", `/users/${only.id}`, { roleKey: R.MANAGEMENT });
  assert.ok(demote.status === 401 || demote.status === 400, "an inactive actor cannot even authenticate; the guard is exercised directly below");
  void t;
  const lib = await import("../src/lib/userAdmin");
  for (const run of [() => lib.updateUser({ userId: "sa1", roleKey: R.SUPER_ADMIN }, "only", { roleKey: R.MANAGEMENT }), () => lib.setUserActive({ userId: "sa1", roleKey: R.SUPER_ADMIN }, "only", false)]) {
    await assert.rejects(run(), (e: any) => e.status === 400 && e.code === "LAST_SUPER_ADMIN" && /last active Super Admin/.test(e.message));
  }
  assert.deepEqual([row("only").roleKey, row("only").isActive], [R.SUPER_ADMIN, true]);
});

test("two simultaneous operations that would each remove the OTHER Super Admin: exactly one succeeds (advisory lock), one active Super Admin remains", async () => {
  // Called directly (not over HTTP) so both are guaranteed to be in flight together - the second request's sign-in check could otherwise
  // run after the first has committed and never reach the guard.
  const lib = await import("../src/lib/userAdmin");
  const settle = (ps: Array<Promise<unknown>>) => Promise.all(ps.map((p) => p.then(() => "ok", (e: any) => (e.code === "LAST_SUPER_ADMIN" ? "refused" : `error:${e.message}`))));
  users = []; seed("a", R.SUPER_ADMIN); seed("b", R.SUPER_ADMIN);
  const A = { userId: "a", roleKey: R.SUPER_ADMIN };
  const B = { userId: "b", roleKey: R.SUPER_ADMIN };
  assert.deepEqual((await settle([lib.setUserActive(A, "b", false), lib.setUserActive(B, "a", false)])).sort(), ["ok", "refused"]);
  assert.equal(users.filter((u) => u.isActive).length, 1);
  users = []; seed("a", R.SUPER_ADMIN); seed("b", R.SUPER_ADMIN);
  assert.deepEqual((await settle([lib.updateUser(A, "b", { roleKey: R.MANAGEMENT }), lib.updateUser(B, "a", { roleKey: R.MANAGEMENT })])).sort(), ["ok", "refused"]);
  assert.equal(users.filter((u) => u.roleKey === R.SUPER_ADMIN).length, 1);
  // three administrators, three simultaneous removals of each other: at most two can succeed
  users = []; seed("a", R.SUPER_ADMIN); seed("b", R.SUPER_ADMIN); seed("c", R.SUPER_ADMIN);
  const C = { userId: "c", roleKey: R.SUPER_ADMIN };
  const outcome = await settle([lib.setUserActive(A, "b", false), lib.setUserActive(B, "c", false), lib.setUserActive(C, "a", false)]);
  assert.equal(outcome.filter((o) => o === "ok").length, 2);
  assert.equal(users.filter((u) => u.isActive).length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// E-mail identity
// ---------------------------------------------------------------------------------------------------------------------

test("e-mail: stored normalised; exact, case and whitespace duplicates are a clear 409; own address can be re-saved; changing to another's is 409", async () => {
  const sa = tok("sa1");
  const first = await call(sa, "POST", "/users", newBody({ email: "  Example@Company.COM " }));
  assert.equal(first.status, 201);
  assert.equal(first.body.email, "example@company.com");
  for (const v of ["example@company.com", "EXAMPLE@COMPANY.COM", " example@company.com ", "Example@Company.com"]) {
    const r = await call(sa, "POST", "/users", newBody({ email: v }));
    assert.deepEqual([r.status, r.body.code], [409, "EMAIL_IN_USE"], v);
    assert.match(r.body.error, /email address is already used/i);
  }
  assert.equal(users.filter((u) => key(u.email) === "example@company.com").length, 1);
  const legacy = seed("legacy", R.SALES, { email: "Legacy.Person@Example.test" });
  assert.equal((await call(sa, "PUT", "/users/legacy", { email: " legacy.person@EXAMPLE.test " })).status, 200);
  assert.equal(legacy.email, "Legacy.Person@Example.test", "the stored form is kept");
  assert.equal(actions("legacy").length, 0, "a no-op records nothing");
  const clash = await call(sa, "PUT", "/users/sales", { email: "LEGACY.PERSON@example.test" });
  assert.deepEqual([clash.status, clash.body.code], [409, "EMAIL_IN_USE"]);
  assert.equal((await call(sa, "PUT", "/users/sales", { email: " Fresh@Example.test " })).status, 200);
  assert.equal(row("sales").email, "fresh@example.test");
});

test("e-mail: simultaneous creations of one address in different spellings - one 201, the rest 409", async () => {
  const sa = tok("sa1");
  const spellings = ["Race@Example.test", "race@example.test", " RACE@example.test", "race@EXAMPLE.test ", "RACE@EXAMPLE.TEST"];
  const rs = await Promise.all(spellings.map((email, i) => call(sa, "POST", "/users", newBody({ email, phone: `98765${43210 + i}` }))));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal(users.filter((u) => key(u.email) === "race@example.test").length, 1);
});

test("sign-in finds the account whatever the case of the typed address; an inactive account cannot sign in", async () => {
  seed("mixed", R.SALES, { email: "Mixed.Case@Example.test" });
  const ok = await call(null, "POST", "/auth/login", { email: " mixed.CASE@example.TEST ", password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.id, "mixed");
  row("mixed").isActive = false;
  assert.equal((await call(null, "POST", "/auth/login", { email: "mixed.case@example.test", password: PASSWORD })).status, 401);
});

// ---------------------------------------------------------------------------------------------------------------------
// Customer / vendor links
// ---------------------------------------------------------------------------------------------------------------------

test("create: customer needs an existing customer, erection engineer an approved vendor, other roles neither", async () => {
  const t = tok("mgmt");
  const bad: Array<Record<string, unknown>> = [
    { roleKey: R.CUSTOMER }, { roleKey: R.CUSTOMER, customerId: "nope" }, { roleKey: R.CUSTOMER, customerId: "cA", vendorId: "v1" }, { roleKey: R.SALES, customerId: "cA" },
    { roleKey: R.ERECTION_ENGINEER }, { roleKey: R.ERECTION_ENGINEER, vendorId: "nope" }, { roleKey: R.ERECTION_ENGINEER, vendorId: "vp" },
  ];
  for (const b of bad) assert.equal((await call(t, "POST", "/users", newBody(b))).status, 400, JSON.stringify(b));
  assert.equal(users.length, 5, "nothing was created");
  const c = await call(t, "POST", "/users", newBody({ roleKey: R.CUSTOMER, customerId: "cA" }));
  const e = await call(t, "POST", "/users", newBody({ roleKey: R.ERECTION_ENGINEER, vendorId: "v1" }));
  assert.deepEqual([c.status, e.status], [201, 201]);
  assert.deepEqual([row(c.body.id).customerId, row(c.body.id).vendorId, row(e.body.id).vendorId, row(e.body.id).customerId], ["cA", null, "v1", null]);
});

test("update: leaving the erection-engineer role drops its vendor link and revokes sessions; other links are kept; invalid links are refused and change nothing", async () => {
  const t = tok("mgmt");
  seed("eng", R.ERECTION_ENGINEER, { vendorId: "v1" });
  seed("staffv", R.SALES, { vendorId: "v1" });
  seed("cust", R.CUSTOMER, { customerId: "cA" });
  assert.equal((await call(t, "PUT", "/users/eng", { vendorId: "vp" })).status, 400);
  assert.equal((await call(t, "PUT", "/users/eng", { vendorId: null })).status, 400);
  assert.equal((await call(t, "PUT", "/users/eng", { customerId: "cA" })).status, 400);
  assert.equal(row("eng").vendorId, "v1");
  assert.equal((await call(t, "PUT", "/users/eng", { vendorId: "v2" })).status, 200);
  assert.deepEqual([row("eng").vendorId, row("eng").tokenVersion], ["v2", 1]);
  assert.deepEqual(actions("eng"), ["association_changed"]);
  assert.equal((await call(t, "PUT", "/users/eng", { roleKey: R.MANAGEMENT })).status, 200);
  assert.deepEqual([row("eng").vendorId, row("eng").tokenVersion], [null, 2]);
  assert.deepEqual(actions("eng"), ["association_changed", "role_changed", "association_changed"]);
  assert.equal((await call(t, "PUT", "/users/staffv", { roleKey: R.MANAGEMENT })).status, 200);
  assert.equal(row("staffv").vendorId, "v1", "a link carried by a role that is not erection engineer is not erased");
  assert.equal((await call(t, "PUT", "/users/cust", { roleKey: R.SALES })).status, 200);
  assert.equal(row("cust").customerId, null);
  assert.equal((await call(t, "PUT", "/users/cust", { roleKey: R.CUSTOMER })).status, 400);
});

// ---------------------------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------------------------

test("password reset, deactivation, reactivation, role change and link change each revoke the account's old tokens; a plain edit does not", async () => {
  const sa = tok("sa1");
  const old = tok("sales");
  assert.equal((await call(old, "GET", "/auth/me")).status, 200);
  assert.equal((await call(sa, "PUT", "/users/sales", { title: "Lead", name: "Renamed" })).status, 200);
  assert.equal((await call(old, "GET", "/auth/me")).status, 200, "a plain profile edit keeps the session");
  const steps: Array<[string, string, string, any?]> = [["reset", "POST", "/users/sales/reset-password"], ["deactivate", "PUT", "/users/sales/deactivate"], ["activate", "PUT", "/users/sales/activate"], ["role", "PUT", "/users/sales", { roleKey: R.SERVICE_ENGINEER }], ["link", "PUT", "/users/sales", { vendorId: "v1" }]];
  for (const [name, m, p, b] of steps) {
    const before = tok("sales");
    assert.equal((await call(sa, m, p, b)).status, 200, name);
    assert.equal((await call(before, "GET", "/auth/me")).status, 401, `${name}: the token issued before is revoked`);
  }
  assert.equal((await call(tok("sales"), "GET", "/auth/me")).status, 200, "a fresh token works");
});

test("after a reset the account must change its password; the temp password works once, the old one does not; a failed reset changes nothing", async () => {
  const sa = tok("sa1");
  assert.equal((await call(sa, "POST", "/users/missing/reset-password")).status, 404);
  assert.equal(row("sales").tokenVersion, 0);
  const r = await call(sa, "POST", "/users/sales/reset-password");
  assert.equal(r.status, 200);
  assert.deepEqual([row("sales").mustChangePassword, row("sales").tokenVersion], [true, 1]);
  assert.equal((await call(null, "POST", "/auth/login", { email: "sales@example.test", password: r.body.tempPassword })).status, 200);
  assert.equal((await call(null, "POST", "/auth/login", { email: "sales@example.test", password: PASSWORD })).status, 401);
});

test("own password change: strong enough, old token revoked, fresh token returned", async () => {
  const old = tok("sales");
  assert.equal((await call(old, "POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: "short" })).status, 400);
  assert.equal((await call(old, "POST", "/auth/change-password", { currentPassword: "nope-nope", newPassword: "A-new-pass-1" })).status, 400);
  assert.equal(row("sales").tokenVersion, 0);
  const ok = await call(old, "POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: "A-new-pass-1" });
  assert.equal(ok.status, 200);
  assert.equal((await call(old, "GET", "/auth/me")).status, 401);
  assert.equal((await call(ok.body.token, "GET", "/auth/me")).status, 200);
  assert.equal(row("sales").mustChangePassword, false);
});

test("a token without a version (issued before this release) is accepted until a revoking change", async () => {
  const jwt = await import("jsonwebtoken");
  const legacy = jwt.default.sign({ userId: "sales", roleKey: R.SALES, customerId: null }, "test-secret", { expiresIn: "1h" });
  assert.equal((await call(legacy, "GET", "/auth/me")).status, 200);
  await call(tok("sa1"), "POST", "/users/sales/reset-password");
  assert.equal((await call(legacy, "GET", "/auth/me")).status, 401);
});

// ---------------------------------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------------------------------

test("each operation writes its audit row; a failed audit write rolls the whole change back (create, update, deactivate, reset)", async () => {
  const sa = tok("sa1");
  const c = await call(sa, "POST", "/users", newBody());
  assert.equal(c.status, 201);
  await call(sa, "PUT", `/users/${c.body.id}`, { title: "Lead" });
  await call(sa, "PUT", `/users/${c.body.id}`, { roleKey: R.MANAGEMENT });
  await call(sa, "PUT", `/users/${c.body.id}/deactivate`);
  await call(sa, "PUT", `/users/${c.body.id}/activate`);
  await call(sa, "POST", `/users/${c.body.id}/reset-password`);
  assert.deepEqual(actions(c.body.id), ["created", "updated", "role_changed", "deactivated", "activated", "password_reset"]);

  failAudit = true;
  const snapshot = JSON.stringify(users);
  const results = [
    await call(sa, "POST", "/users", newBody({ email: "later@example.test" })),
    await call(sa, "PUT", "/users/sales", { title: "Changed" }),
    await call(sa, "PUT", "/users/sales", { roleKey: R.SERVICE_ENGINEER }),
    await call(sa, "PUT", "/users/sales/deactivate"),
    await call(sa, "POST", "/users/sales/reset-password"),
  ];
  assert.deepEqual(results.map((r) => r.status), [500, 500, 500, 500, 500]);
  assert.equal(JSON.stringify(users), snapshot, "no account changed, nothing was revoked, nothing was created");
});

test("no secret reaches the audit log; a validation failure records nothing; refusals are recorded as refusals with operation and reason only", async () => {
  const sa = tok("sa1");
  const created = await call(sa, "POST", "/users", newBody());
  const reset = await call(sa, "POST", "/users/sales/reset-password");
  await call(sa, "PUT", "/users/mgmt", { phone: "123" }); // invalid
  await call(tok("owner"), "POST", "/users/sa2/reset-password"); // refused
  const blob = JSON.stringify(audit);
  for (const secret of [created.body.tempPassword, reset.body.tempPassword, PASSWORD, "$2a$", "passwordHash", "tokenVersion", "eyJ"]) assert.ok(!blob.includes(secret), `no ${secret.slice(0, 5)}… in audit`);
  assert.equal(actions("mgmt").length, 0);
  const denied = audit.find((a) => a.action === "action_denied");
  assert.deepEqual(Object.keys(denied.changes).sort(), ["operation", "reason"]);
  assert.equal(denied.actorId, "owner");
  assert.equal(audit.filter((a) => a.targetUserId === "sa2" && a.action !== "action_denied").length, 0, "the refused reset is not a 'password_reset' event");
});

test("the users list never contains the password hash or the session counter", async () => {
  const list = await call(tok("mgmt"), "GET", "/users");
  assert.equal(list.status, 200);
  assert.ok(list.body.every((u: any) => !("passwordHash" in u) && !("tokenVersion" in u)));
});

// ---------------------------------------------------------------------------------------------------------------------
// Security remediation: privileged-account boundary matrix (direct API requests, not the UI)
// ---------------------------------------------------------------------------------------------------------------------

function freshWorld() {
  users = []; audit = []; failAudit = false; nextId = 1; lockTail = Promise.resolve();
  seed("sa1", R.SUPER_ADMIN); seed("sa2", R.SUPER_ADMIN); seed("owner", R.OWNER_ADMIN); seed("owner2", R.OWNER_ADMIN);
  seed("mgmt", R.MANAGEMENT); seed("mgmt2", R.MANAGEMENT); seed("sales", R.SALES);
}

type Op = "edit" | "role_change" | "deactivate" | "reset";
const OPS: Record<Op, (t: string, target: string) => Promise<{ status: number; body: any }>> = {
  edit: (t, target) => call(t, "PUT", `/users/${target}`, { name: "Renamed Person" }),
  role_change: (t, target) => call(t, "PUT", `/users/${target}`, { roleKey: R.SERVICE_ENGINEER }),
  deactivate: (t, target) => call(t, "PUT", `/users/${target}/deactivate`),
  reset: (t, target) => call(t, "POST", `/users/${target}/reset-password`),
};

// actor -> target -> may the actor administer that account?
const MAY_ADMINISTER: Record<string, Record<string, boolean>> = {
  sa1: { sa2: true, owner2: true, mgmt2: true, sales: true },
  owner: { sa2: false, owner2: true, mgmt2: true, sales: true },
  mgmt: { sa2: false, owner2: false, mgmt2: true, sales: true },
  sales: { sa2: false, owner2: false, mgmt2: false, sales: false }, // no manage_users at all
};

test("role matrix: who may edit / re-role / deactivate / reset which account - Management can never touch an Owner/Admin or a Super Admin, directly through the API", async () => {
  for (const [actor, targets] of Object.entries(MAY_ADMINISTER)) {
    for (const [target, allowed] of Object.entries(targets)) {
      for (const op of Object.keys(OPS) as Op[]) {
        freshWorld();
        const before = JSON.stringify(users.find((u) => u.id === target));
        const r = await OPS[op](tok(actor), target);
        const label = `${actor} ${op} ${target}`;
        if (allowed) {
          assert.equal(r.status, 200, label);
        } else {
          assert.equal(r.status, 403, label);
          // nothing changed, no session was revoked, and the refusal is recorded as a refusal (not a change)
          assert.equal(JSON.stringify(users.find((u) => u.id === target)), before, `${label}: target untouched`);
          if (actor !== "sales") assert.deepEqual(audit.map((a) => a.action), ["action_denied"], `${label}: only the refusal is recorded`);
          else assert.equal(audit.length, 0, `${label}: no permission, nothing recorded`);
        }
      }
    }
  }
});

test("role matrix: granting a privileged role - Super Admin only by a Super Admin, Owner/Admin only by a Super Admin or Owner/Admin (create and role change)", async () => {
  const GRANT: Record<string, Record<string, boolean>> = {
    sa1: { [R.SUPER_ADMIN]: true, [R.OWNER_ADMIN]: true, [R.MANAGEMENT]: true },
    owner: { [R.SUPER_ADMIN]: false, [R.OWNER_ADMIN]: true, [R.MANAGEMENT]: true },
    mgmt: { [R.SUPER_ADMIN]: false, [R.OWNER_ADMIN]: false, [R.MANAGEMENT]: true },
  };
  for (const [actor, roles] of Object.entries(GRANT)) {
    for (const [roleKey, allowed] of Object.entries(roles)) {
      freshWorld();
      const created = await call(tok(actor), "POST", "/users", newBody({ roleKey }));
      assert.equal(created.status, allowed ? 201 : 403, `${actor} creates ${roleKey}`);
      if (!allowed) assert.equal(users.some((u) => u.name === "New Person"), false, `${actor} creating ${roleKey}: nothing created`);

      freshWorld();
      const promoted = await call(tok(actor), "PUT", "/users/sales", { roleKey });
      assert.equal(promoted.status, allowed ? 200 : 403, `${actor} promotes sales to ${roleKey}`);
      assert.equal(users.find((u) => u.id === "sales")!.roleKey, allowed ? roleKey : R.SALES, `${actor} -> ${roleKey}: stored role`);
    }
  }
});

test("a Management user cannot take over an Owner/Admin account by resetting its password and cannot lock it out by deactivating it", async () => {
  freshWorld();
  const owner = users.find((u) => u.id === "owner2")!;
  const hashBefore = owner.passwordHash;
  const reset = await call(tok("mgmt"), "POST", "/users/owner2/reset-password");
  assert.equal(reset.status, 403);
  assert.equal(reset.body.tempPassword, undefined, "no temporary password is ever returned to the refused caller");
  assert.equal(owner.passwordHash, hashBefore);
  assert.equal((await call(tok("mgmt"), "PUT", "/users/owner2/deactivate")).status, 403);
  assert.equal(owner.isActive, true);
  assert.equal(owner.tokenVersion, 0, "sessions of the protected account were not revoked by a refused request");
});

test("the last-Super-Admin safeguard still holds for a Super Admin acting through the API", async () => {
  freshWorld();
  users = users.filter((u) => u.id !== "sa2"); // only sa1 is left
  assert.equal((await call(tok("sa1"), "PUT", "/users/sa1", { roleKey: R.OWNER_ADMIN })).status, 400); // self role change
  seed("sa3", R.SUPER_ADMIN);
  assert.equal((await call(tok("sa3"), "PUT", "/users/sa1/deactivate")).status, 200);
  assert.equal((await call(tok("sa3"), "PUT", "/users/sa3/deactivate")).status, 400); // self
  const demote = await call(tok("sa1"), "PUT", "/users/sa3", { roleKey: R.OWNER_ADMIN });
  assert.equal(demote.status, 401, "a deactivated Super Admin is no longer authenticated at all (inactive account)");
});
