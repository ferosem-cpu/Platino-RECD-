/**
 * Real-database tests for user administration (Requirement 10): the migration (tokenVersion, the case-insensitive e-mail identity index),
 * the privileged-role hierarchy, the last-active-Super-Admin guard under concurrency, customer / vendor link rules and the resulting data
 * scope, session revocation through the real authentication middleware and login, and atomic audit logging - through the real routers.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test). They only create rows of their own (unique run prefix; removed in `after`). The one exception is the
 * last-Super-Admin test: the baseline Super Admin(s) are switched inactive for the duration of that test (a single UPDATE of isActive) and
 * ALWAYS switched back (try/finally and again in `after`); nothing else about them is touched. Nothing is e-mailed.
 * Run with: npm run test:db --workspace=apps/api (database migrated through 20261023090000_user_admin_hardening).
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import express from "express";

const ISOLATED = { hosts: ["localhost", "127.0.0.1"], port: "5434", database: "platino_test" };

function pointsAtIsolatedDb(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return ISOLATED.hosts.includes(u.hostname) && u.port === ISOLATED.port && u.pathname === `/${ISOLATED.database}`;
  } catch {
    return false;
  }
}

const isolated = pointsAtIsolatedDb(process.env.DATABASE_URL) && pointsAtIsolatedDb(process.env.DIRECT_URL) && !!process.env.JWT_SECRET;
const skip = isolated
  ? false
  : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("user administration against the real test database", { skip }, () => {
  const PREFIX = `ZU${Date.now().toString(36).toUpperCase()}`;
  const PASSWORD = "Zz-test-pass-1";
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), vendorIds: new Set<string>(), orderIds: new Set<string>(), unitIds: new Set<string>(), productIds: new Set<string>() };
  const realConsole = { log: console.log, error: console.error };
  let seq = 0;

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let lib: any;
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const w: Record<string, any> = {};
  let suspendedSuperAdmins: string[] = [];

  const phoneSeq = () => `98${String(70000000 + ++seq * 7).slice(0, 8)}`;
  const email = (tag: string) => `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`;
  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({
      data: { name: `${PREFIX} ${tag}`, email: email(tag), phone: phoneSeq(), roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, passwordHash: bcrypt.hashSync(PASSWORD, 4), ...extra },
    });
    tracked.userIds.add(user.id);
    return user;
  }
  /** A signed token carrying the user's CURRENT tokenVersion (what a fresh sign-in would produce). */
  async function tokenOf(user: any) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { role: true } });
    return signToken({ userId: u.id, roleKey: u.role.key, customerId: u.customerId, tokenVersion: u.tokenVersion });
  }
  async function call(as: string | null, method: string, p: string, body?: unknown) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${as}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  }
  const tv = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).tokenVersion;
  const auditOf = (targetUserId: string) => prisma.userAuditLog.findMany({ where: { targetUserId }, orderBy: { createdAt: "asc" } });
  const newUserBody = (over: Record<string, unknown> = {}) => ({ name: `${PREFIX} New`, email: email("new"), roleKey: "sales", phone: phoneSeq(), ...over });
  const makeUnit = async (customerId: string, vendorId: string | null) => {
    const n = ++seq;
    const order = await prisma.order.create({ data: { orderNumber: `${PREFIX}-O${n}`, customerId, productId: w.product.id, quantity: 1, site: { create: { currentStageId: stageId, companyName: `${PREFIX} Plant ${n}`, address: "Synthetic", vendorId } } }, include: { site: true } });
    tracked.orderIds.add(order.id);
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${n}`, orderId: order.id, siteId: order.site.id, productId: w.product.id } });
    tracked.unitIds.add(unit.id);
    return unit;
  };
  /** Switches every active Super Admin except `keepIds` to inactive (one UPDATE of isActive), remembering them so they are ALWAYS switched back. */
  async function suspendSuperAdminsExcept(keepIds: string[]) {
    const rows = await prisma.user.findMany({ where: { role: { key: "super_admin" }, isActive: true, id: { notIn: keepIds } }, select: { id: true } });
    suspendedSuperAdmins = [...new Set([...suspendedSuperAdmins, ...rows.map((r: any) => r.id)])];
    if (rows.length) await prisma.user.updateMany({ where: { id: { in: rows.map((r: any) => r.id) } }, data: { isActive: false } });
  }
  async function restoreSuperAdmins() {
    if (suspendedSuperAdmins.length) await prisma.user.updateMany({ where: { id: { in: suspendedSuperAdmins } }, data: { isActive: true } });
    suspendedSuperAdmins = [];
  }

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    await prisma.ipRateLimit.deleteMany({}); // disposable DB only: sign-in attempts counted by earlier runs in the same 15-minute window would otherwise answer 429
    ({ signToken } = await import("../../src/lib/jwt"));
    lib = await import("../../src/lib/userAdmin");
    const { usersRouter } = await import("../../src/routes/users");
    const { authRouter } = await import("../../src/routes/auth");
    const { recdUnitsRouter } = await import("../../src/routes/recdUnits");
    const app = express();
    app.use(express.json());
    app.use("/users", usersRouter);
    app.use("/auth", authRouter);
    app.use("/recd-units", recdUnitsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["super_admin", "owner_admin", "management", "sales", "erection_engineer", "customer", "service_engineer", "regional_manager"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    w.product = await prisma.product.create({ data: { name: `${PREFIX} P`, model: `${PREFIX}-P`, warrantyMonths: 12 } });
    tracked.productIds.add(w.product.id);
    for (const t of ["A", "B"]) { w["C" + t] = await prisma.customer.create({ data: { name: `${PREFIX} Customer ${t}` } }); tracked.customerIds.add(w["C" + t].id); }
    for (const t of ["1", "2"]) { w["V" + t] = await prisma.vendor.create({ data: { name: `${PREFIX} V${t}`, status: "approved", contactName: "S", contactEmail: email("vc") } }); tracked.vendorIds.add(w["V" + t].id); }
    w.pendingVendor = await prisma.vendor.create({ data: { name: `${PREFIX} Pending`, status: "pending", contactName: "S", contactEmail: email("vp") } });
    tracked.vendorIds.add(w.pendingVendor.id);
    w.sa1 = await makeUser("sa1", "super_admin");
    w.sa2 = await makeUser("sa2", "super_admin");
    w.owner = await makeUser("owner", "owner_admin");
    w.mgmt = await makeUser("mgmt", "management");
    w.sales = await makeUser("sales", "sales");
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        await restoreSuperAdmins();
        const ids = [...tracked.userIds];
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.userAuditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
        await prisma.vendor.deleteMany({ where: { id: { in: [...tracked.vendorIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
        await prisma.product.deleteMany({ where: { id: { in: [...tracked.productIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // Migration
  // ------------------------------------------------------------------------------------------

  test("migration: tokenVersion column (default 0), the normalised e-mail index next to the original exact one", async () => {
    const cols = await prisma.$queryRaw`select column_name, is_nullable, column_default from information_schema.columns where table_name = 'User' and column_name = 'tokenVersion'`;
    assert.equal(cols.length, 1);
    assert.equal(cols[0].is_nullable, "NO");
    assert.match(String(cols[0].column_default), /0/);
    const idx = (await prisma.$queryRaw`select indexname, indexdef from pg_indexes where tablename = 'User' and indexname like 'User_email%'`);
    const names = idx.map((i: any) => i.indexname).sort();
    assert.deepEqual(names, ["User_email_key", "User_email_normalized_key"], "the original unique index is kept");
    assert.match(idx.find((i: any) => i.indexname === "User_email_normalized_key").indexdef, /lower\(btrim\(/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: w.sales.id } })).tokenVersion, 0, "existing users start at version 0");
  });

  // ------------------------------------------------------------------------------------------
  // E-mail identity
  // ------------------------------------------------------------------------------------------

  test("database level: the same address differing only by case or surrounding spaces cannot be inserted by any path", async () => {
    const base0 = email("dbdup");
    await makeUser("dbdup", "sales", { email: base0 });
    for (const variant of [base0.toUpperCase(), ` ${base0} `, base0.replace("@", "@").replace(/^./, (c) => c.toUpperCase())]) {
      await assert.rejects(prisma.user.create({ data: { name: "x", email: variant, roleId: roleIds.sales } }), /Unique constraint/i, JSON.stringify(variant));
    }
    await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO "User"(id, name, email, "roleId", "isActive", "mustChangePassword") VALUES ('${PREFIX}-raw', 'raw', '${base0.toUpperCase()}', '${roleIds.sales}', true, false)`), /already exists|User_email_normalized_key|23505/i, "raw SQL is stopped too");
  });

  test("create: exact, case and whitespace duplicates are a clear 409 (not a 500); the stored address is normalised", async () => {
    const sa = await tokenOf(w.sa1);
    const addr = email("Dup");
    const first = await call(sa, "POST", "/users", newUserBody({ email: `  ${addr.toUpperCase()}  ` }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    tracked.userIds.add(first.body.id);
    assert.equal(first.body.email, addr.toLowerCase(), "stored lower-case, trimmed");
    for (const v of [addr.toLowerCase(), addr.toUpperCase(), `  ${addr}  `, addr.replace(/^./, (c) => c.toUpperCase())]) {
      const r = await call(sa, "POST", "/users", newUserBody({ email: v }));
      assert.equal(r.status, 409, JSON.stringify(v));
      assert.match(r.body.error, /email address is already used/i);
      assert.equal(r.body.code, "EMAIL_IN_USE");
    }
    assert.equal(await prisma.user.count({ where: { email: { equals: addr, mode: "insensitive" } } }), 1);
  });

  test("create: eight simultaneous requests for one address in different spellings - exactly one user, the rest clean 409s", async () => {
    const sa = await tokenOf(w.sa1);
    const addr = email("race");
    const spellings = [addr, addr.toUpperCase(), ` ${addr}`, `${addr} `, addr.replace(/^./, (c) => c.toUpperCase()), addr.toUpperCase(), addr, ` ${addr.toUpperCase()} `];
    const rs = await Promise.all(spellings.map((e) => call(sa, "POST", "/users", newUserBody({ email: e }))));
    for (const r of rs) if (r.status === 201) tracked.userIds.add(r.body.id);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409]);
    assert.ok(rs.filter((r) => r.status === 409).every((r) => r.body.code === "EMAIL_IN_USE"));
  });

  test("update: changing to an address another user has is 409 (any case); re-saving your own address in another spelling changes and records nothing", async () => {
    const sa = await tokenOf(w.sa1);
    const a = await makeUser("ea", "sales");
    const b = await makeUser("eb", "sales", { email: `Mixed.${PREFIX}@Example.Invalid` }); // legacy-style mixed case, stored as typed
    const clash = await call(sa, "PUT", `/users/${a.id}`, { email: `  MIXED.${PREFIX}@example.invalid ` });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /email address is already used/i);
    const before = (await auditOf(b.id)).length;
    const same = await call(sa, "PUT", `/users/${b.id}`, { email: `mixed.${PREFIX}@EXAMPLE.invalid` });
    assert.equal(same.status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).email, `Mixed.${PREFIX}@Example.Invalid`, "the stored form is preserved");
    assert.equal((await auditOf(b.id)).length, before, "no audit row for a no-op");
    const moved = await call(sa, "PUT", `/users/${a.id}`, { email: `  New.${PREFIX}@Example.Invalid ` });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.email, `new.${PREFIX}@example.invalid`.toLowerCase());
    const log = (await auditOf(a.id)).find((x: any) => x.action === "updated");
    assert.equal(log.changes.email.to, `new.${PREFIX}@example.invalid`.toLowerCase());
  });

  test("sign-in is not case-sensitive: a legacy mixed-case account signs in with any spelling, and nothing about its password changes", async () => {
    const mixed = await makeUser("login", "sales", { email: `Legacy.${PREFIX}@Example.Invalid` });
    for (const typed of [`legacy.${PREFIX}@example.invalid`, ` LEGACY.${PREFIX}@EXAMPLE.INVALID `]) {
      const r = await call(null, "POST", "/auth/login", { email: typed, password: PASSWORD });
      assert.equal(r.status, 200, typed);
      assert.equal(r.body.user.id, mixed.id);
    }
    assert.equal(await tv(mixed.id), 0, "normalising an address never revokes anything");
  });

  // ------------------------------------------------------------------------------------------
  // Privileged roles
  // ------------------------------------------------------------------------------------------

  test("Owner/Admin and Management cannot grant Super Admin (create or update); a Super Admin can; refusals change nothing", async () => {
    for (const actor of [w.owner, w.mgmt]) {
      const t = await tokenOf(actor);
      const c = await call(t, "POST", "/users", newUserBody({ roleKey: "super_admin" }));
      assert.equal(c.status, 403, actor.name);
      assert.match(c.body.error, /Only a Super Admin/);
      const target = await makeUser("promote", "sales");
      const u = await call(t, "PUT", `/users/${target.id}`, { roleKey: "super_admin" });
      assert.equal(u.status, 403);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id }, include: { role: true } })).role.key, "sales");
      assert.equal(await tv(target.id), 0);
      const acts = (await auditOf(target.id)).map((x: any) => x.action);
      assert.deepEqual(acts, ["action_denied"], "a refusal is recorded as a refusal, never as a change");
    }
    const sa = await tokenOf(w.sa1);
    const ok = await call(sa, "POST", "/users", newUserBody({ roleKey: "super_admin" }));
    assert.equal(ok.status, 201);
    tracked.userIds.add(ok.body.id);
    const target = await makeUser("promote2", "sales");
    assert.equal((await call(sa, "PUT", `/users/${target.id}`, { roleKey: "super_admin" })).status, 200);
    assert.equal(await tv(target.id), 1, "the promoted account's old sessions are revoked");
  });

  test("a Super Admin account cannot be edited, reset, deactivated or reactivated by anyone else; a Super Admin can", async () => {
    const victim = await makeUser("victim", "super_admin");
    for (const actor of [w.owner, w.mgmt]) {
      const t = await tokenOf(actor);
      assert.equal((await call(t, "PUT", `/users/${victim.id}`, { name: "hijack" })).status, 403);
      assert.equal((await call(t, "PUT", `/users/${victim.id}`, { roleKey: "sales" })).status, 403);
      assert.equal((await call(t, "POST", `/users/${victim.id}/reset-password`)).status, 403);
      assert.equal((await call(t, "PUT", `/users/${victim.id}/deactivate`)).status, 403);
      assert.equal((await call(t, "PUT", `/users/${victim.id}/activate`)).status, 403);
    }
    const raw = await prisma.user.findUniqueOrThrow({ where: { id: victim.id }, include: { role: true } });
    assert.deepEqual([raw.name, raw.role.key, raw.isActive, raw.tokenVersion, raw.passwordHash === victim.passwordHash], [victim.name, "super_admin", true, 0, true]);
    assert.ok((await auditOf(victim.id)).every((x: any) => x.action === "action_denied"), "only refusals were recorded");
    const sa = await tokenOf(w.sa1);
    assert.equal((await call(sa, "PUT", `/users/${victim.id}`, { name: `${PREFIX} renamed` })).status, 200);
    assert.equal((await call(sa, "PUT", `/users/${victim.id}/deactivate`)).status, 200);
    assert.equal((await call(sa, "PUT", `/users/${victim.id}/activate`)).status, 200);
    assert.equal((await call(sa, "POST", `/users/${victim.id}/reset-password`)).status, 200);
  });

  test("nobody elevates themselves or changes their own links / activation / password through the admin routes", async () => {
    const t = await tokenOf(w.mgmt);
    const me = w.mgmt.id;
    assert.equal((await call(t, "PUT", `/users/${me}`, { roleKey: "super_admin" })).status, 403, "self-promotion is refused by the hierarchy");
    assert.equal((await call(t, "PUT", `/users/${me}`, { roleKey: "sales" })).status, 400, "and any other self role change by the self rule");
    assert.equal((await call(t, "PUT", `/users/${me}/deactivate`)).status, 400);
    assert.equal((await call(t, "POST", `/users/${me}/reset-password`)).status, 400);
    assert.equal((await call(t, "PUT", `/users/${me}`, { vendorId: w.V1.id })).status, 400, "a link on a role that cannot take it");
    const raw = await prisma.user.findUniqueOrThrow({ where: { id: me }, include: { role: true } });
    assert.deepEqual([raw.role.key, raw.isActive, raw.tokenVersion, raw.vendorId], ["management", true, 0, null]);
    assert.equal((await call(t, "PUT", `/users/${me}`, { title: "Head of Ops" })).status, 200, "ordinary self-edits still work");
  });

  // ------------------------------------------------------------------------------------------
  // Last active Super Admin
  // ------------------------------------------------------------------------------------------

  test("the last active Super Admin cannot be demoted or deactivated (guard inside the transaction); with another active one it is allowed", async () => {
    try {
      const only = await makeUser("only", "super_admin");
      const spare = await makeUser("spare", "super_admin");
      const actor = { userId: w.sa1.id, roleKey: "super_admin" };
      // with other active Super Admins around, a demotion is fine
      await lib.updateUser(actor, spare.id, { roleKey: "management" });
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: spare.id }, include: { role: true } })).role.key, "management");
      // leave `only` as the single active Super Admin (every other one is switched back in finally)
      await suspendSuperAdminsExcept([only.id]);
      const demote = await lib.updateUser(actor, only.id, { roleKey: "management" }).then(() => null, (e: any) => e);
      const deactivate = await lib.setUserActive(actor, only.id, false).then(() => null, (e: any) => e);
      for (const e of [demote, deactivate]) {
        assert.equal(e?.status, 400);
        assert.equal(e?.code, "LAST_SUPER_ADMIN");
        assert.match(e.message, /last active Super Admin/);
      }
      const raw = await prisma.user.findUniqueOrThrow({ where: { id: only.id }, include: { role: true } });
      assert.deepEqual([raw.role.key, raw.isActive, raw.tokenVersion], ["super_admin", true, 0], "nothing changed, nothing revoked");
      assert.equal((await auditOf(only.id)).length, 0);
    } finally {
      await restoreSuperAdmins();
    }
  });

  test("two simultaneous requests that would each remove the OTHER Super Admin cannot both succeed - one active Super Admin always remains", async () => {
    try {
      const a = await makeUser("raceA", "super_admin");
      const b = await makeUser("raceB", "super_admin");
      for (const [op, run] of [
        ["deactivate", (actor: any, target: any) => lib.setUserActive({ userId: actor.id, roleKey: "super_admin" }, target.id, false)],
        ["demote", (actor: any, target: any) => lib.updateUser({ userId: actor.id, roleKey: "super_admin" }, target.id, { roleKey: "management" })],
      ] as const) {
        await prisma.user.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { isActive: true, roleId: roleIds.super_admin } });
        await suspendSuperAdminsExcept([a.id, b.id]); // exactly a and b are the active Super Admins
        // Called directly (not over HTTP) so both are certainly in flight together: both real transactions race for the advisory lock.
        const settle = (p: Promise<unknown>) => p.then(() => ({ status: 200, body: null as any }), (e: any) => ({ status: e.status ?? 500, body: { error: e.message, code: e.code } }));
        const [r1, r2] = await Promise.all([settle(run(a, b)), settle(run(b, a))]);
        assert.deepEqual([r1.status, r2.status].sort(), [200, 400], `${op}: exactly one succeeds`);
        const refused = [r1, r2].find((r) => r.status === 400)!;
        assert.match(refused.body.error, /last active Super Admin/);
        assert.equal(refused.body.code, "LAST_SUPER_ADMIN");
        const left = await prisma.user.count({ where: { id: { in: [a.id, b.id] }, isActive: true, role: { key: "super_admin" } } });
        assert.equal(left, 1, `${op}: one active Super Admin remains`);
      }
    } finally {
      await restoreSuperAdmins();
    }
  });

  // ------------------------------------------------------------------------------------------
  // Customer / vendor links
  // ------------------------------------------------------------------------------------------

  test("create: customer needs an existing customer; erection engineer needs an approved vendor; wrong links are refused", async () => {
    const t = await tokenOf(w.mgmt);
    const r = (over: Record<string, unknown>) => call(t, "POST", "/users", newUserBody(over));
    assert.equal((await r({ roleKey: "customer" })).status, 400, "no customer");
    assert.equal((await r({ roleKey: "customer", customerId: "nope" })).status, 400, "unknown customer");
    assert.equal((await r({ roleKey: "customer", customerId: w.CA.id, vendorId: w.V1.id })).status, 400, "customer + vendor");
    assert.equal((await r({ roleKey: "sales", customerId: w.CA.id })).status, 400, "staff with a customer");
    assert.equal((await r({ roleKey: "erection_engineer" })).status, 400, "no vendor");
    assert.equal((await r({ roleKey: "erection_engineer", vendorId: "nope" })).status, 400, "unknown vendor");
    assert.equal((await r({ roleKey: "erection_engineer", vendorId: w.pendingVendor.id })).status, 400, "unapproved vendor");
    const cust = await r({ roleKey: "customer", customerId: w.CA.id });
    assert.equal(cust.status, 201, JSON.stringify(cust.body));
    tracked.userIds.add(cust.body.id);
    const eng = await r({ roleKey: "erection_engineer", vendorId: w.V1.id });
    assert.equal(eng.status, 201);
    tracked.userIds.add(eng.body.id);
    const rows = await prisma.user.findMany({ where: { id: { in: [cust.body.id, eng.body.id] } } });
    const byId = Object.fromEntries(rows.map((x: any) => [x.id, x]));
    assert.deepEqual([byId[cust.body.id].customerId, byId[cust.body.id].vendorId], [w.CA.id, null]);
    assert.deepEqual([byId[eng.body.id].customerId, byId[eng.body.id].vendorId], [null, w.V1.id]);
    const creates = (await auditOf(eng.body.id)).filter((x: any) => x.action === "created");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].changes.vendorId, w.V1.id);
  });

  test("role changes clear only the stale link, preserve the legitimate one, record it, revoke old sessions - and the data scope follows", async () => {
    const t = await tokenOf(w.mgmt);
    const u1 = await makeUnit(w.CA.id, w.V1.id);
    const u2 = await makeUnit(w.CA.id, w.V2.id);
    const eng = await makeUser("scope", "erection_engineer", { vendorId: w.V1.id });
    const oldToken = await tokenOf(eng);
    const seesList = async (tok: string) => (await call(tok, "GET", `/recd-units?search=${PREFIX}`)).body.map((x: any) => x.id).sort();
    assert.deepEqual(await seesList(oldToken), [u1.id], "a vendor-scoped engineer sees only its own vendor's units");
    // reassigning to another vendor: scope flips, old token revoked, association row written
    const re = await call(t, "PUT", `/users/${eng.id}`, { vendorId: w.V2.id });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal((await call(oldToken, "GET", "/auth/me")).status, 401, "the pre-change token is dead");
    assert.deepEqual(await seesList(await tokenOf(eng)), [u2.id]);
    let log = await auditOf(eng.id);
    const assoc = log.find((x: any) => x.action === "association_changed");
    assert.deepEqual(assoc.changes.vendorId, { from: w.V1.id, to: w.V2.id });
    // an invalid vendor is refused and nothing changes
    assert.equal((await call(t, "PUT", `/users/${eng.id}`, { vendorId: w.pendingVendor.id })).status, 400);
    assert.equal((await call(t, "PUT", `/users/${eng.id}`, { vendorId: "nope" })).status, 400);
    assert.equal((await call(t, "PUT", `/users/${eng.id}`, { vendorId: null })).status, 400, "an erection engineer cannot lose the vendor");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: eng.id } })).vendorId, w.V2.id);
    // leaving the erection-engineer role drops the vendor link that role needed
    const tok2 = await tokenOf(eng);
    const move = await call(t, "PUT", `/users/${eng.id}`, { roleKey: "service_engineer" });
    assert.equal(move.status, 200);
    assert.equal(move.body.vendorId, null);
    assert.equal((await call(tok2, "GET", "/auth/me")).status, 401, "a role change revokes the old token");
    assert.deepEqual(await seesList(await tokenOf(eng)), [u1.id, u2.id], "no stale vendor restriction is left");
    log = await auditOf(eng.id);
    assert.ok(log.some((x: any) => x.action === "role_changed" && x.changes.role.to === "service_engineer"));
    assert.deepEqual(log.filter((x: any) => x.action === "association_changed").length, 2);
  });

  test("a role change that keeps the same vendor-scoped role, or involves a role with a legitimate vendor link, does not erase it", async () => {
    const t = await tokenOf(w.mgmt);
    const eng = await makeUser("keep", "erection_engineer", { vendorId: w.V1.id });
    const v0 = await tv(eng.id);
    assert.equal((await call(t, "PUT", `/users/${eng.id}`, { title: "Fitter", roleKey: "erection_engineer" })).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: eng.id } })).vendorId, w.V1.id);
    assert.equal(await tv(eng.id), v0, "a plain edit never revokes sessions");
    const staff = await makeUser("staffvendor", "sales", { vendorId: w.V1.id }); // existing data: a staff user that carries a vendor link
    assert.equal((await call(t, "PUT", `/users/${staff.id}`, { roleKey: "management" })).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).vendorId, w.V1.id, "not erased merely because the role is not erection engineer");
  });

  test("converting a customer contact to staff clears its customer link; converting to customer needs one", async () => {
    const t = await tokenOf(w.mgmt);
    const contact = await makeUser("contact", "customer", { customerId: w.CA.id });
    assert.equal((await call(t, "PUT", `/users/${contact.id}`, { roleKey: "sales" })).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: contact.id } })).customerId, null);
    assert.equal((await call(t, "PUT", `/users/${contact.id}`, { roleKey: "customer" })).status, 400);
    assert.equal((await call(t, "PUT", `/users/${contact.id}`, { roleKey: "customer", customerId: "nope" })).status, 400);
    assert.equal((await call(t, "PUT", `/users/${contact.id}`, { roleKey: "customer", customerId: w.CB.id })).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: contact.id } })).customerId, w.CB.id);
    const other = await makeUser("nocust", "sales");
    assert.equal((await call(t, "PUT", `/users/${other.id}`, { customerId: w.CA.id })).status, 400, "a link the role cannot have is refused, not ignored");
  });

  // ------------------------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------------------------

  test("administrative password reset: old tokens are rejected at once, the account must change its password, and a fresh sign-in works", async () => {
    const victim = await makeUser("resetme", "sales");
    const old = await tokenOf(victim);
    assert.equal((await call(old, "GET", "/auth/me")).status, 200);
    const sa = await tokenOf(w.sa1);
    const r = await call(sa, "POST", `/users/${victim.id}/reset-password`);
    assert.equal(r.status, 200);
    assert.ok(r.body.tempPassword.length >= 12);
    assert.equal((await call(old, "GET", "/auth/me")).status, 401, "the old token is revoked");
    assert.equal(await tv(victim.id), 1);
    const login = await call(null, "POST", "/auth/login", { email: victim.email, password: r.body.tempPassword });
    assert.equal(login.status, 200, "the temp password works");
    const me = await call(login.body.token, "GET", "/auth/me");
    assert.equal(me.status, 200, "the new token works");
    assert.equal(me.body.mustChangePassword, true, "forced password change is preserved");
    assert.equal((await call(null, "POST", "/auth/login", { email: victim.email, password: PASSWORD })).status, 401, "the old password no longer works");
  });

  test("a failed reset (unknown user, refused actor) changes nothing and revokes nothing", async () => {
    const victim = await makeUser("noreset", "sales");
    const tok = await tokenOf(victim);
    const t = await tokenOf(w.sales); // lacks manage_users
    assert.equal((await call(t, "POST", `/users/${victim.id}/reset-password`)).status, 403);
    const sa = await tokenOf(w.sa1);
    assert.equal((await call(sa, "POST", `/users/does-not-exist/reset-password`)).status, 404);
    assert.equal((await call(tok, "GET", "/auth/me")).status, 200);
    assert.equal(await tv(victim.id), 0);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).passwordHash, victim.passwordHash);
  });

  test("own password change: old tokens die, the answer carries a fresh token, a weak or wrong password changes nothing", async () => {
    const u = await makeUser("selfpw", "sales", { mustChangePassword: true });
    const old = await tokenOf(u);
    assert.equal((await call(old, "POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: "short" })).status, 400, "below the sign-in minimum");
    assert.equal((await call(old, "POST", "/auth/change-password", { currentPassword: "wrong-password", newPassword: "A-new-pass-1" })).status, 400);
    assert.equal(await tv(u.id), 0, "failed attempts revoke nothing");
    assert.equal((await call(old, "GET", "/auth/me")).status, 200);
    const ok = await call(old, "POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: "A-new-pass-1" });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await call(old, "GET", "/auth/me")).status, 401, "the pre-change token is revoked");
    const me = await call(ok.body.token, "GET", "/auth/me");
    assert.deepEqual([me.status, me.body.mustChangePassword], [200, false], "this session continues on the fresh token; the forced change is cleared");
    assert.equal((await call(null, "POST", "/auth/login", { email: u.email, password: "A-new-pass-1" })).status, 200);
  });

  test("deactivation: tokens stop working, sign-in is refused, and reactivation does NOT resurrect old tokens", async () => {
    const u = await makeUser("deact", "sales");
    const old = await tokenOf(u);
    const sa = await tokenOf(w.sa1);
    assert.equal((await call(sa, "PUT", `/users/${u.id}/deactivate`)).status, 200);
    const afterOff = await call(old, "GET", "/auth/me");
    assert.equal(afterOff.status, 401);
    assert.equal((await call(null, "POST", "/auth/login", { email: u.email, password: PASSWORD })).status, 401, "an inactive account cannot sign in");
    assert.equal((await call(sa, "PUT", `/users/${u.id}/activate`)).status, 200);
    assert.equal((await call(old, "GET", "/auth/me")).status, 401, "tokens issued before the deactivation stay dead");
    assert.equal((await call(await tokenOf(u), "GET", "/auth/me")).status, 200, "a fresh token works");
    assert.deepEqual((await auditOf(u.id)).map((x: any) => x.action), ["deactivated", "activated"]);
    // idempotent calls record nothing new
    await call(sa, "PUT", `/users/${u.id}/activate`);
    assert.equal((await auditOf(u.id)).length, 2);
  });

  test("tokens issued before this release (no version) keep working until a revoking change", async () => {
    const u = await makeUser("legacy-token", "sales");
    const jwt = await import("jsonwebtoken");
    const legacy = jwt.default.sign({ userId: u.id, roleKey: "sales", customerId: null }, process.env.JWT_SECRET!, { expiresIn: "1h" });
    assert.equal((await call(legacy, "GET", "/auth/me")).status, 200);
    await call(await tokenOf(w.sa1), "POST", `/users/${u.id}/reset-password`);
    assert.equal((await call(legacy, "GET", "/auth/me")).status, 401);
  });

  // ------------------------------------------------------------------------------------------
  // Audit
  // ------------------------------------------------------------------------------------------

  test("every administrative change writes its audit row in the same transaction; a failed audit write rolls the change back", async () => {
    const sa = await tokenOf(w.sa1);
    const created = await call(sa, "POST", "/users", newUserBody());
    assert.equal(created.status, 201);
    tracked.userIds.add(created.body.id);
    const id = created.body.id;
    await call(sa, "PUT", `/users/${id}`, { name: `${PREFIX} Renamed`, title: "Lead" });
    await call(sa, "PUT", `/users/${id}`, { roleKey: "management" });
    await call(sa, "PUT", `/users/${id}/deactivate`);
    await call(sa, "PUT", `/users/${id}/activate`);
    await call(sa, "POST", `/users/${id}/reset-password`);
    const rows = await auditOf(id);
    assert.deepEqual(rows.map((x: any) => x.action), ["created", "updated", "role_changed", "deactivated", "activated", "password_reset"]);
    assert.ok(rows.every((x: any) => x.actorId === w.sa1.id));
    assert.deepEqual(rows[1].changes, { name: { from: `${PREFIX} New`, to: `${PREFIX} Renamed` }, title: { from: null, to: "Lead" } });
    assert.deepEqual(rows[2].changes, { role: { from: "sales", to: "management" } });

    // A ghost actor makes the audit INSERT fail (actor foreign key): the change must not survive it.
    const ghost = { userId: "no-such-actor", roleKey: "super_admin" };
    const t0 = await tv(id);
    const raw0 = await prisma.user.findUniqueOrThrow({ where: { id } });
    await assert.rejects(lib.setUserActive(ghost, id, false), /foreign key|Foreign key/i);
    await assert.rejects(lib.resetUserPassword(ghost, id), /foreign key|Foreign key/i);
    await assert.rejects(lib.updateUser(ghost, id, { roleKey: "sales" }), /foreign key|Foreign key/i);
    const raw1 = await prisma.user.findUniqueOrThrow({ where: { id }, include: { role: true } });
    assert.deepEqual([raw1.isActive, raw1.role.key, raw1.passwordHash === raw0.passwordHash, raw1.tokenVersion], [true, "management", true, t0], "nothing changed, nothing revoked");
    const beforeCreate = await prisma.user.count({ where: { name: { startsWith: `${PREFIX} Ghost` } } });
    await assert.rejects(lib.createUser(ghost, { name: `${PREFIX} Ghost`, email: email("ghost"), phone: phoneSeq(), roleKey: "sales" }), /foreign key|Foreign key/i);
    assert.equal(await prisma.user.count({ where: { name: { startsWith: `${PREFIX} Ghost` } } }), beforeCreate, "a user is not created without its audit row");
    assert.equal((await auditOf(id)).length, rows.length, "no audit rows for the failed attempts");
  });

  test("refused attempts are recorded as refusals (operation + reason only), failed validations record nothing, and no secret ever reaches the audit log", async () => {
    const t = await tokenOf(w.owner);
    const victim = await makeUser("audit-victim", "super_admin");
    await call(t, "POST", `/users/${victim.id}/reset-password`);
    await call(t, "PUT", `/users/${victim.id}/deactivate`);
    const denied = await auditOf(victim.id);
    assert.deepEqual(denied.map((x: any) => x.action), ["action_denied", "action_denied"]);
    assert.deepEqual(denied.map((x: any) => x.changes.operation), ["reset_password", "deactivate_user"]);
    assert.equal(denied[0].actorId, w.owner.id);
    const target = await makeUser("audit-valid", "sales");
    await call(await tokenOf(w.mgmt), "PUT", `/users/${target.id}`, { phone: "123" }); // invalid phone
    assert.equal((await auditOf(target.id)).length, 0, "a rejected request is not an event");
    // secrets: reset a password, change a password, create a user - then scan every audit payload of this run
    const sa = await tokenOf(w.sa1);
    const r = await call(sa, "POST", `/users/${target.id}/reset-password`);
    const created = await call(sa, "POST", "/users", newUserBody());
    tracked.userIds.add(created.body.id);
    const all = await prisma.userAuditLog.findMany({ where: { OR: [{ targetUserId: { in: [...tracked.userIds] } }, { actorId: { in: [...tracked.userIds] } }] } });
    const blob = JSON.stringify(all);
    for (const secret of [r.body.tempPassword, created.body.tempPassword, PASSWORD, "$2a$", "$2b$", "passwordHash", "tokenVersion", "Bearer", "eyJ"]) assert.ok(!blob.includes(secret), `audit payloads must not contain ${secret.slice(0, 6)}…`);
  });

  test("the users list never returns the password hash or the session counter", async () => {
    const list = await call(await tokenOf(w.mgmt), "GET", "/users");
    assert.equal(list.status, 200);
    assert.ok(list.body.length > 0);
    assert.ok(list.body.every((u: any) => !("passwordHash" in u) && !("tokenVersion" in u)));
    assert.equal((await call(await tokenOf(w.sales), "GET", "/users")).status, 403);
  });

  test("R10 roles: Add User can create a Service Engineer, Service Manager, Regional Manager (the approved Zonal Manager) and Admin; each is audited; the Regional Manager holds ticket / site permissions only - nothing administrative", async () => {
    const sa = await tokenOf(w.sa1);
    for (const roleKey of ["service_engineer", "service_manager", "regional_manager", "owner_admin"]) {
      const r = await call(sa, "POST", "/users", newUserBody({ roleKey, email: email(`r10-${roleKey}`) }));
      assert.equal(r.status, 201, `${roleKey}: ${JSON.stringify(r.body)}`);
      tracked.userIds.add(r.body.id);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: r.body.id }, include: { role: true } });
      assert.equal(row.role.key, roleKey);
      assert.ok((await auditOf(r.body.id)).some((a: any) => a.action === "created"), `${roleKey}: creation is recorded`);
    }
    const perms = async (key: string) => (await prisma.rolePermission.findMany({ where: { role: { key } }, include: { permission: true } })).map((x: any) => x.permission.key).sort();
    const rm = await perms("regional_manager");
    for (const needed of ["manage_complaints", "view_complaints_overview", "view_site_status"]) assert.ok(rm.includes(needed), `regional_manager has ${needed}`);
    for (const forbidden of ["manage_users", "manage_settings", "manage_regions", "manage_orders", "manage_amc_orders", "manage_warranty", "manage_vendors"]) assert.ok(!rm.includes(forbidden), `regional_manager must not have ${forbidden}`);
    // a Regional Manager can neither add users nor reach the audit log or the region setup (backend, not just the menu)
    const rmUser = await makeUser("rm-gate", "regional_manager");
    const t = await tokenOf(rmUser);
    assert.equal((await call(t, "POST", "/users", newUserBody({ email: email("by-rm") }))).status, 403);
    assert.equal((await call(t, "GET", "/users")).status, 403);
  });
});
