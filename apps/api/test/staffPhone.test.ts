// Staff-user phone numbers (POST /users, PUT /users/:id): duplicates are found in EVERY stored format, a user keeps their own
// number, and a unique-index conflict (two requests racing past the check) is a clean 409. Prisma is replaced by an in-memory
// store whose `phone` column is unique on its exact value, like the real index (which does not normalise).
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const p2002 = (modelName: string, target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName, target } });

interface Row { id: string; name: string; email: string | null; phone: string | null; title: string | null; role: { id: string; key: string }; isActive: boolean }
let rows: Row[] = [];
let blindToExisting = false; // true = the pre-check sees nothing (both racing requests passed it)
let nextId = 1;
let writeFailure: unknown = null;
let server: Server;
let base = "";
let token = "";

const MGR = { id: "mgr", isActive: true, customerId: null, vendorId: null, role: { key: ROLE_KEY.MANAGEMENT, permissions: [{ permission: { key: PERMISSION_KEY.MANAGE_USERS } }] } };
const SALES = { id: "sales-role", key: ROLE_KEY.SALES };
const seed = (id: string, phone: string | null, roleKey: string = ROLE_KEY.SALES): Row => {
  const r: Row = { id, name: id, email: `${id}@example.test`, phone, title: null, role: { id: `${roleKey}-role`, key: roleKey }, isActive: true };
  rows.push(r);
  return r;
};

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { usersRouter } = await import("../src/routes/users");
  const define = (model: string, impl: Record<string, (...a: any[]) => any>) => Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  const phoneUnique = (phone: string | null, exceptId?: string) => {
    if (phone && rows.some((r) => r.phone === phone && r.id !== exceptId)) throw p2002("User", ["phone"]);
  };
  define("user", {
    findUnique: ({ where }: any) => (where.id === "mgr" ? MGR : rows.find((r) => r.id === where.id) ?? null),
    findFirst: ({ where }: any) => {
      if (blindToExisting) return null;
      const list: string[] = where.phone.in;
      return rows.find((r) => r.phone && list.includes(r.phone) && r.id !== where.id?.not) ?? null;
    },
    count: () => 2,
    create: async ({ data }: any) => {
      await Promise.resolve(); // let a racing request run its pre-check first
      if (writeFailure) throw writeFailure;
      phoneUnique(data.phone);
      const row: Row = { id: `new${nextId++}`, name: data.name, email: data.email, phone: data.phone, title: null, role: SALES, isActive: true };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id)!;
      if (writeFailure) throw writeFailure;
      if (data.phone !== undefined) phoneUnique(data.phone, row.id);
      Object.assign(row, data);
      return { ...row, passwordHash: null };
    },
  });
  define("role", { findUnique: ({ where }: any) => ({ id: `${where.key}-role`, key: where.key }) });
  define("vendor", { findUnique: () => null });
  define("userAuditLog", { create: async () => ({}) });
  // The routes now write the change and its audit row in one transaction (R10): run it against the same in-memory stubs.
  (prisma as any).$transaction = async (fn: any) => fn(prisma);
  (prisma as any).$executeRaw = async () => 0; // the administrator-guard advisory lock
  token = signToken({ userId: "mgr", roleKey: ROLE_KEY.MANAGEMENT, customerId: null });
  const app = express();
  app.use(express.json());
  app.use("/users", usersRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });
beforeEach(() => { rows = []; blindToExisting = false; writeFailure = null; nextId = 1; });

const send = async (method: string, path: string, body: unknown) => {
  const res = await fetch(`${base}/users${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
let emailSeq = 0;
const create = (phone: string) => send("POST", "/", { name: "New Person", email: `n${++emailSeq}@example.test`, roleKey: ROLE_KEY.SALES, phone });
const MSG = /already used by another user/;

test("a number held by a customer contact in the legacy +91 form is a duplicate for a staff user (409, nothing created)", async () => {
  seed("cust-contact", "+919900011122", ROLE_KEY.CUSTOMER);
  const r = await create("9900011122");
  assert.equal(r.status, 409);
  assert.match(r.body.error, MSG);
  assert.equal(rows.length, 1);
});

test("every accepted spelling of that number is found: spaces, hyphens, +91, 91 and 0 prefixes", async () => {
  seed("legacy-plus", "+919900011122", ROLE_KEY.CUSTOMER);
  for (const spelling of ["99000 11122", "99000-11122", "+91 99000-11122", "919900011122", "09900011122", "(99000) 11122"]) {
    const r = await create(spelling);
    assert.equal(r.status, 409, spelling);
    assert.match(r.body.error, MSG);
  }
  assert.equal(rows.length, 1);
  // other legacy storage forms
  rows = [];
  seed("legacy-91", "919900011123", ROLE_KEY.CUSTOMER);
  seed("legacy-0", "09900011124");
  assert.equal((await create("9900011123")).status, 409);
  assert.equal((await create("9900011124")).status, 409);
});

test("a number held by another staff user is a duplicate on create and on update", async () => {
  seed("a", "9876500001");
  const b = seed("b", "9876500002");
  assert.equal((await create("98765 00001")).status, 409);
  const upd = await send("PUT", `/${b.id}`, { phone: "+91 98765-00001" });
  assert.equal(upd.status, 409);
  assert.match(upd.body.error, MSG);
  assert.equal(b.phone, "9876500002", "a refused update changes nothing");
});

test("a legacy-format number of another user blocks an update too", async () => {
  seed("cust-contact", "+919900011122", ROLE_KEY.CUSTOMER);
  const staff = seed("staff", "9876500003");
  const r = await send("PUT", `/${staff.id}`, { phone: "9900011122" });
  assert.equal(r.status, 409);
  assert.equal(staff.phone, "9876500003");
});

test("a user can keep their own number when editing, in any spelling, with no false duplicate", async () => {
  const me = seed("me", "+919876500004"); // stored in the legacy form
  const same = await send("PUT", `/${me.id}`, { name: "Renamed", phone: "9876500004" });
  assert.equal(same.status, 200);
  assert.equal(me.phone, "9876500004", "the number is tidied to the 10-digit form");
  const respaced = await send("PUT", `/${me.id}`, { phone: "98765 00004" });
  assert.equal(respaced.status, 200);
  const changed = await send("PUT", `/${me.id}`, { phone: "+91 98765-00005" });
  assert.equal(changed.status, 200);
  assert.equal(me.phone, "9876500005");
});

test("a free number is accepted in every supported spelling and stored as 10 digits", async () => {
  for (const spelling of ["98765 43270", "+91 98765-43271", "09876543272", "919876543273"]) {
    const r = await create(spelling);
    assert.equal(r.status, 201, spelling);
  }
  assert.deepEqual(rows.map((r) => r.phone), ["9876543270", "9876543271", "9876543272", "9876543273"]);
});

test("invalid numbers are still a 400 with the standard message (the duplicate check never runs for them)", async () => {
  seed("a", "9876500001");
  for (const bad of ["12345", "5876543210", "98765abcde", "+14155552671", ""]) {
    const r = await create(bad);
    assert.equal(r.status, 400, bad);
    assert.match(JSON.stringify(r.body), /Enter a valid 10-digit Indian mobile number/);
  }
});

test("simultaneous requests for one number (all pass the check): exactly one is created, the others get a clean 409", async () => {
  blindToExisting = true; // every request gets past the lookup, as in a real race
  const results = await Promise.all([create("98765 43299"), create("+91 98765-43299"), create("09876543299")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  for (const r of results.filter((x) => x.status === 409)) {
    assert.match(r.body.error, MSG);
    assert.doesNotMatch(JSON.stringify(r.body), /Prisma|P2002|constraint|unique/i, "no database internals in the response");
  }
  assert.equal(rows.filter((r) => r.phone === "9876543299").length, 1);
});

test("a unique-index conflict on update is a clean 409 as well", async () => {
  seed("a", "9876500010");
  const b = seed("b", "9876500011");
  blindToExisting = true;
  const r = await send("PUT", `/${b.id}`, { phone: "9876500010" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, MSG);
  assert.equal(b.phone, "9876500011");
});

test("only a PHONE conflict is translated: other database errors stay errors", async () => {
  for (const e of [new Error("connection lost"), p2002("Order", ["orderNumber"])]) {
    writeFailure = e;
    assert.equal((await create("9876543288")).status, 500);
  }
  // an E-MAIL conflict is translated too since R10 (a clear 409, see test/userAdmin.test.ts) - it is not a phone message
  writeFailure = p2002("User", ["email"]);
  const emailClash = await create("9876543288");
  assert.equal(emailClash.status, 409);
  assert.doesNotMatch(emailClash.body.error, /mobile/);
  writeFailure = null;
  assert.equal((await create("9876543288")).status, 201);
});
