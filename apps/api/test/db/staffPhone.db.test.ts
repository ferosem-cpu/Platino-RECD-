/**
 * Real-database tests for staff-user phone numbers: a number stored in any accepted format by ANOTHER record (customer
 * contact, vendor login, staff user) is a duplicate, a user keeps their own number, and simultaneous requests for one
 * number end in exactly one saved user and clean 409s (the unique index on User.phone is the backstop).
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable
 * Docker database (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix,
 * synthetic numbers; everything is removed in `after`). Nothing is sent. Run with: npm run test:db --workspace=apps/api
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
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
describe("staff-user phone numbers against the real test database", { skip }, () => {
  const PREFIX = `zsp${Date.now().toString(36)}`;
  const MSG = /already used by another user/;
  const tracked = { phones: new Set<string>() };
  let seq = 0;
  let prisma: any;
  let server: Server;
  let base = "";
  let adminToken = "";
  let customerRoleId = "";
  const realConsole = { log: console.log, error: console.error };

  const newPhone = () => {
    const n = `9${String((Date.now() % 10_000_000) * 100 + ++seq).padStart(9, "0")}`.slice(0, 10);
    tracked.phones.add(n);
    return n;
  };
  const variants = (n: string) => [n, `+91${n}`, `91${n}`, `0${n}`];

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  const createStaff = (tag: string, phone: string) => call("POST", "/users", { name: `${PREFIX} ${tag}`, email: `${PREFIX}-${tag}@example.test`, roleKey: "sales", phone });
  const staffCount = (tag: string) => prisma.user.count({ where: { email: `${PREFIX}-${tag}@example.test` } });

  async function cleanup() {
    if (!prisma) return;
    const phoneVariants = [...tracked.phones].flatMap(variants);
    const users = await prisma.user.findMany({ where: { OR: [{ email: { startsWith: PREFIX } }, { phone: { in: phoneVariants } }] }, select: { id: true } });
    const ids = users.map((u: any) => u.id);
    await prisma.userAuditLog.deleteMany({ where: { targetUserId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    const { signToken } = await import("../../src/lib/jwt");
    const { usersRouter } = await import("../../src/routes/users");
    const app = express();
    app.use(express.json());
    app.use("/users", usersRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "superadmin@platino.example" }, include: { role: true } });
    adminToken = signToken({ userId: admin.id, roleKey: admin.role.key, customerId: null });
    customerRoleId = (await prisma.role.findUniqueOrThrow({ where: { key: "customer" } })).id;
  });

  after(async () => {
    server?.close();
    try { await cleanup(); } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  test("a customer contact stored with the legacy +91 prefix blocks a staff user with the same number (any spelling)", async () => {
    const n = newPhone();
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} legacy`, contacts: { create: { name: "Legacy contact", phone: `+91${n}`, roleId: customerRoleId } } } });
    assert.ok(customer.id);
    for (const [i, typed] of [n, `${n.slice(0, 5)} ${n.slice(5)}`, `${n.slice(0, 5)}-${n.slice(5)}`, `+91 ${n.slice(0, 5)}-${n.slice(5)}`, `0${n}`].entries()) {
      const r = await createStaff(`legacy${i}`, typed);
      assert.equal(r.status, 409, `${typed}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, MSG);
      assert.equal(await staffCount(`legacy${i}`), 0, "nothing was created");
    }
  });

  test("other legacy storage forms (91 and 0 prefixed) are found as well", async () => {
    for (const [i, stored] of [(n: string) => `91${n}`, (n: string) => `0${n}`].entries()) {
      const n = newPhone();
      await prisma.customer.create({ data: { name: `${PREFIX} legacy-b${i}`, contacts: { create: { name: "Legacy", phone: stored(n), roleId: customerRoleId } } } });
      assert.equal((await createStaff(`legacyb${i}`, n)).status, 409);
    }
  });

  test("another staff user's number is a duplicate on create and on update; a user keeps their own number", async () => {
    const a = newPhone();
    const b = newPhone();
    const ra = await createStaff("a", `${a.slice(0, 5)} ${a.slice(5)}`);
    assert.equal(ra.status, 201, JSON.stringify(ra.body));
    const rb = await createStaff("b", b);
    assert.equal(rb.status, 201);
    assert.equal((await prisma.user.findUnique({ where: { id: ra.body.id } })).phone, a, "stored as 10 digits");

    assert.equal((await createStaff("dup", `+91 ${a}`)).status, 409);
    const upd = await call("PUT", `/users/${rb.body.id}`, { phone: `+91-${a}` });
    assert.equal(upd.status, 409);
    assert.match(upd.body.error, MSG);
    assert.equal((await prisma.user.findUnique({ where: { id: rb.body.id } })).phone, b, "the refused update changed nothing");

    const own = await call("PUT", `/users/${rb.body.id}`, { name: `${PREFIX} b renamed`, phone: `${b.slice(0, 5)} ${b.slice(5)}` });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await prisma.user.findUnique({ where: { id: rb.body.id } })).phone, b);
  });

  test("a user whose own number is stored in the legacy form can re-save it without a false duplicate", async () => {
    const n = newPhone();
    const created = await createStaff("own-legacy", n);
    assert.equal(created.status, 201);
    await prisma.user.update({ where: { id: created.body.id }, data: { phone: `+91${n}` } }); // simulate an older row
    const r = await call("PUT", `/users/${created.body.id}`, { phone: n });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await prisma.user.findUnique({ where: { id: created.body.id } })).phone, n, "tidied to the 10-digit form");
  });

  test("simultaneous creations of one number in different spellings: exactly one user, the rest clean 409s", async () => {
    const n = newPhone();
    const spell = [n, `+91${n}`, `0${n}`, `${n.slice(0, 5)} ${n.slice(5)}`, `+91 ${n.slice(0, 5)}-${n.slice(5)}`, `91${n}`];
    const results = await Promise.all(spell.map((typed, i) => createStaff(`race${i}`, typed)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409], JSON.stringify(results.map((r) => [r.status, r.body?.error])));
    for (const r of results.filter((x) => x.status === 409)) {
      assert.match(r.body.error, MSG);
      assert.doesNotMatch(JSON.stringify(r.body), /Prisma|P2002|constraint|unique/i);
    }
    assert.equal(await prisma.user.count({ where: { phone: n } }), 1);
  });

  test("simultaneous updates of two users to one number: exactly one wins, the other is a clean 409", async () => {
    const x = await createStaff("ux", newPhone());
    const y = await createStaff("uy", newPhone());
    assert.equal(x.status, 201);
    assert.equal(y.status, 201);
    const target = newPhone();
    const [rx, ry] = await Promise.all([call("PUT", `/users/${x.body.id}`, { phone: target }), call("PUT", `/users/${y.body.id}`, { phone: `+91 ${target}` })]);
    assert.deepEqual([rx.status, ry.status].sort(), [200, 409], JSON.stringify([rx.body, ry.body]));
    assert.equal(await prisma.user.count({ where: { phone: target } }), 1);
  });

  test("invalid numbers are still refused before any duplicate check", async () => {
    for (const bad of ["12345", "5876543210", "98765abcde", "+14155552671"]) {
      const r = await createStaff("bad", bad);
      assert.equal(r.status, 400, bad);
      assert.match(JSON.stringify(r.body), /Enter a valid 10-digit Indian mobile number/);
    }
    assert.equal(await staffCount("bad"), 0);
  });
});
