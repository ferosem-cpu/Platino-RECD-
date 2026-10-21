// Audit trail and session revocation for the account changes that do NOT go through the Users page: customer-contact create / edit / delete
// (routes/customers.ts) and vendor login creation / archive (routes/vendors.ts). The real routers, authentication middleware and audit
// helpers run over HTTP against an in-memory store that behaves like Postgres where it matters: a transaction undoes everything when anything in
// it fails, and deleting a user clears (ON DELETE SET NULL) - not deletes - the audit rows that point at it.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = PERMISSION_KEY;
interface U { id: string; name: string; email: string | null; phone: string | null; roleKey: string; customerId: string | null; vendorId: string | null; isActive: boolean; tokenVersion: number; passwordHash: string | null }
interface A { id: string; actorId: string | null; targetUserId: string | null; targetIdRecorded: string | null; targetName: string | null; action: string; changes: any }

let users: U[] = [];
let audit: A[] = [];
let customers: any[] = [];
let vendors: any[] = [];
let sites: any[] = [];
let failAudit = false;
let seq = 1;
const txUndo = new AsyncLocalStorage<Array<() => void>>();
const onRollback = (fn: () => void) => txUndo.getStore()?.push(fn);

const ACTOR = { id: "mgr", perms: [P.MANAGE_ORDERS, P.MANAGE_VENDORS, P.MANAGE_USERS, P.VIEW_SITE_STATUS] };
let server: Server;
let base = "";
let token = "";

const roleIdOf = (key: string) => `role-${key}`;
const keyOfRole = (id: string) => id.replace(/^role-/, "");

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { customersRouter } = await import("../src/routes/customers");
  const { vendorsRouter } = await import("../src/routes/vendors");
  const { usersRouter } = await import("../src/routes/users");

  const define = (model: string, impl: Record<string, (...a: any[]) => any>) => Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  const view = (u: U) => ({ ...u, roleId: roleIdOf(u.roleKey), role: { key: u.roleKey, name: u.roleKey } });

  const userModel = {
    findUnique: ({ where }: any) => {
      if (where.id === ACTOR.id) return { id: ACTOR.id, isActive: true, tokenVersion: 0, mustChangePassword: false, customerId: null, vendorId: null, role: { key: ROLE_KEY.MANAGEMENT, permissions: ACTOR.perms.map((key) => ({ permission: { key } })) } };
      const u = users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      return u ? view(u) : null;
    },
    findFirst: ({ where }: any) => users.find((u) => u.phone && where.phone.in.includes(u.phone) && u.id !== where.id?.not) ?? null,
    findMany: ({ where }: any) => users.filter((u) => (where.vendorId === undefined || u.vendorId === where.vendorId) && (where.isActive === undefined || u.isActive === where.isActive)).map(view),
    create: ({ data }: any) => {
      const row: U = { id: `u${seq++}`, name: data.name, email: data.email ?? null, phone: data.phone ?? null, roleKey: keyOfRole(data.roleId), customerId: data.customerId ?? null, vendorId: data.vendorId ?? null, isActive: true, tokenVersion: 0, passwordHash: data.passwordHash ?? null };
      users.push(row);
      onRollback(() => { users = users.filter((u) => u !== row); });
      return row;
    },
    update: ({ where, data }: any) => {
      const row = users.find((u) => u.id === where.id)!;
      const prev = { ...row };
      for (const [k, v] of Object.entries<any>(data).filter(([, x]) => x !== undefined)) (row as any)[k] = v && typeof v === "object" && "increment" in v ? (row as any)[k] + v.increment : v;
      onRollback(() => Object.assign(row, prev));
      return row;
    },
    updateMany: ({ where, data }: any) => {
      const hit = users.filter((u) => u.vendorId === where.vendorId);
      for (const row of hit) {
        const prev = { ...row };
        for (const [k, v] of Object.entries<any>(data).filter(([, x]) => x !== undefined)) (row as any)[k] = v && typeof v === "object" && "increment" in v ? (row as any)[k] + v.increment : v;
        onRollback(() => Object.assign(row, prev));
      }
      return { count: hit.length };
    },
    deleteMany: ({ where }: any) => {
      const gone = users.filter((u) => where.id.in.includes(u.id));
      users = users.filter((u) => !gone.includes(u));
      // ON DELETE SET NULL for the audit rows that point at a deleted user (the rows themselves stay)
      const touched = audit.filter((a) => a.targetUserId && gone.some((g) => g.id === a.targetUserId));
      const prevTargets = touched.map((a) => a.targetUserId);
      for (const a of touched) a.targetUserId = null;
      onRollback(() => { users.push(...gone); touched.forEach((a, i) => { a.targetUserId = prevTargets[i]; }); });
      return { count: gone.length };
    },
  };
  define("user", userModel);
  define("role", { findUniqueOrThrow: ({ where }: any) => ({ id: roleIdOf(where.key), key: where.key }) });
  define("userAuditLog", {
    create: ({ data }: any) => {
      if (failAudit) throw new Error("audit disk full");
      const row: A = { id: `a${seq++}`, actorId: data.actorId ?? null, targetUserId: data.targetUserId ?? null, targetIdRecorded: data.targetIdRecorded ?? null, targetName: data.targetName ?? null, action: data.action, changes: data.changes ?? null };
      audit.push(row);
      onRollback(() => { audit = audit.filter((a) => a !== row); });
      return row;
    },
    updateMany: ({ where, data }: any) => {
      const ids: string[] = where.OR.map((c: any) => c.targetUserId ?? c.targetIdRecorded);
      const hit = audit.filter((a) => ids.includes(a.targetUserId as string) || ids.includes(a.targetIdRecorded as string));
      const prev = hit.map((a) => a.targetName);
      for (const a of hit) a.targetName = data.targetName;
      onRollback(() => hit.forEach((a, i) => { a.targetName = prev[i]; }));
      return { count: hit.length };
    },
    findMany: ({ where }: any) => {
      const id = where?.OR?.[0]?.targetUserId;
      const rows = id ? audit.filter((a) => a.targetUserId === id || a.targetIdRecorded === id) : audit;
      return rows.map((a) => ({ ...a, createdAt: new Date(), actor: { id: a.actorId, name: "Manager" }, target: a.targetUserId ? { id: a.targetUserId, name: users.find((u) => u.id === a.targetUserId)?.name ?? "?", email: null } : null }));
    },
  });
  define("customer", {
    findUnique: ({ where }: any) => {
      const c = customers.find((x) => x.id === where.id);
      return c ? { ...c, contacts: users.filter((u) => u.customerId === c.id) } : null;
    },
  });
  define("order", { count: () => 0 });
  define("complaint", { count: () => 0 });
  define("amcOrder", { count: () => 0 });
  define("vendor", {
    findUnique: ({ where }: any) => vendors.find((v) => v.id === where.id || v.contactEmail === where.contactEmail) ?? null,
    update: ({ where, data }: any) => { const v = vendors.find((x) => x.id === where.id)!; Object.assign(v, data); return v; },
  });
  define("site", { updateMany: () => ({ count: 0 }) });

  (prisma as any).$transaction = async (fn: any) => {
    const undo: Array<() => void> = [];
    const tx = Object.create(prisma);
    // prisma.<model> are getter-only accessors in these tests, so the transaction client defines its own properties
    const own = (name: string, value: unknown) => Object.defineProperty(tx, name, { value, configurable: true });
    own("customer", {
      create: ({ data }: any) => {
        const c = { id: `c${seq++}`, name: data.name, address: data.address };
        customers.push(c);
        const contact = userModel.create({ data: { ...data.contacts.create, customerId: c.id } });
        onRollback(() => { customers = customers.filter((x) => x !== c); });
        return { ...c, contacts: [{ id: contact.id, name: contact.name, phone: contact.phone, email: contact.email }] };
      },
      update: ({ where }: any) => ({ ...customers.find((c) => c.id === where.id), contacts: users.filter((u) => u.customerId === where.id) }),
      delete: ({ where }: any) => { const c = customers.find((x) => x.id === where.id)!; customers = customers.filter((x) => x !== c); onRollback(() => customers.push(c)); return c; },
    });
    try {
      return await txUndo.run(undo, () => fn(tx));
    } catch (err) {
      for (const u of undo.reverse()) u();
      throw err;
    }
  };

  token = signToken({ userId: ACTOR.id, roleKey: ROLE_KEY.MANAGEMENT, customerId: null });
  const app = express();
  app.use(express.json());
  app.use("/customers", customersRouter);
  app.use("/vendors", vendorsRouter);
  app.use("/users", usersRouter);
  app.use((e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { if (process.env.TEST_DEBUG) console.error(e); res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

beforeEach(() => {
  users = []; audit = []; customers = []; vendors = []; sites = []; failAudit = false; seq = 1;
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}
const NEW_CUSTOMER = { name: "Acme Textiles", contactName: "Asha Rao", contactPhone: "9876500001", contactEmail: "asha@acme.example" };
const SECRETISH = ["9876500001", "asha@acme.example", "passwordHash", "9876500002", "new@acme.example"];
const noPersonalDetails = (rows: A[]) => { const t = JSON.stringify(rows); for (const s of SECRETISH) assert.equal(t.includes(s), false, `audit contains ${s}`); };

// ---------------------------------------------------------------------------------------------------------------------------------------
// customer contacts
// ---------------------------------------------------------------------------------------------------------------------------------------

test("creating a customer records who created the contact account - and no phone number or e-mail goes into the trail", async () => {
  const r = await call("POST", "/customers", NEW_CUSTOMER);
  assert.equal(r.status, 201);
  const contact = users[0];
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].actorId, audit[0].targetUserId, audit[0].targetIdRecorded], ["created", "mgr", contact.id, contact.id]);
  assert.equal(audit[0].changes.via, "customer_created");
  noPersonalDetails(audit);
});

test("the customer, its contact account and the audit record are one unit: a failed audit write creates none of them", async () => {
  failAudit = true;
  const r = await call("POST", "/customers", NEW_CUSTOMER);
  assert.equal(r.status, 500);
  assert.equal(users.length, 0, "no contact account");
  assert.equal(customers.length, 0, "no customer");
  assert.equal(audit.length, 0);
});

test("editing a contact's phone or e-mail is audited (field names only) and ends that contact's existing sessions; a name-only edit is audited but keeps sessions", async () => {
  await call("POST", "/customers", NEW_CUSTOMER);
  const contact = users[0];
  const customerId = customers[0].id;
  audit = [];

  const nameOnly = await call("PUT", `/customers/${customerId}`, { contactName: "Asha R. Rao" });
  assert.equal(nameOnly.status, 200);
  assert.deepEqual(audit.map((a) => [a.action, a.changes.fieldsChanged]), [["updated", ["name"]]]);
  assert.equal(contact.tokenVersion, 0, "a name change does not sign anyone out");

  const phone = await call("PUT", `/customers/${customerId}`, { contactPhone: "9876500002" });
  assert.equal(phone.status, 200);
  assert.deepEqual(audit.at(-1)!.changes.fieldsChanged, ["phone"]);
  assert.equal(contact.tokenVersion, 1, "sessions issued before the sign-in detail changed are revoked");

  const email = await call("PUT", `/customers/${customerId}`, { contactEmail: "new@acme.example" });
  assert.equal(email.status, 200);
  assert.deepEqual(audit.at(-1)!.changes.fieldsChanged, ["email"]);
  assert.equal(contact.tokenVersion, 2);
  noPersonalDetails(audit);

  // re-saving the same values is not a change: nothing recorded, nobody signed out
  const before = audit.length;
  await call("PUT", `/customers/${customerId}`, { contactPhone: "9876500002", contactEmail: "new@acme.example", contactName: "Asha R. Rao" });
  assert.equal(audit.length, before);
  assert.equal(contact.tokenVersion, 2);
});

test("deleting a customer deletes its contact accounts but NOT the audit trail: the rows stay, point to nothing, and keep the id and name", async () => {
  await call("POST", "/customers", NEW_CUSTOMER);
  const contact = users[0];
  const customerId = customers[0].id;
  await call("PUT", `/customers/${customerId}`, { contactPhone: "9876500002" });
  const rowsBefore = audit.length;
  assert.equal(rowsBefore, 2);

  const del = await call("DELETE", `/customers/${customerId}`);
  assert.equal(del.status, 204);
  assert.equal(users.length, 0, "the account is gone");
  assert.equal(customers.length, 0);

  assert.equal(audit.length, rowsBefore + 1, "no audit row was deleted, and the deletion itself is recorded");
  for (const a of audit) {
    assert.equal(a.targetUserId, null, "the live link is cleared (ON DELETE SET NULL), not the row");
    assert.equal(a.targetIdRecorded, contact.id, "the recorded id survives");
    assert.equal(a.targetName, "Asha Rao", "the name is recorded so the trail stays readable");
  }
  const last = audit.at(-1)!;
  assert.deepEqual([last.action, last.actorId], ["deleted", "mgr"]);
  assert.equal(last.changes.via, "customer_deleted");
  noPersonalDetails(audit);

  // the history of the deleted account is still reachable by its id through the admin audit view
  const view = await call("GET", `/users/audit-log?userId=${contact.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.json.length, 3);
  assert.equal(view.json[0].target.name, "Asha Rao");
});

test("if the deletion's audit write fails, nothing is deleted", async () => {
  await call("POST", "/customers", NEW_CUSTOMER);
  const customerId = customers[0].id;
  failAudit = true;
  const del = await call("DELETE", `/customers/${customerId}`);
  assert.equal(del.status, 500);
  assert.equal(users.length, 1);
  assert.equal(customers.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// vendor logins
// ---------------------------------------------------------------------------------------------------------------------------------------

const VENDOR = { name: "Coimbatore Erectors", contactName: "Ramesh Kumar", contactEmail: "ramesh@erectors.example", contactPhone: "9812345678", address: "Coimbatore" };

test("approving a vendor creates its contact login together with an audit record (and no contact details in it); a failed audit write creates no login", async () => {
  vendors.push({ id: "v1", status: "pending", ...VENDOR }, { id: "v2", status: "pending", ...VENDOR, contactEmail: "second@erectors.example", contactPhone: "9812345679" });
  failAudit = true;
  const failed = await call("POST", "/vendors/v1/approve");
  assert.equal(failed.status, 500);
  assert.equal(users.length, 0, "no login without its audit record");
  assert.equal(audit.length, 0);

  failAudit = false;
  const ok = await call("POST", "/vendors/v2/approve");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.contactLoginCreated, true);
  assert.equal(users.length, 1);
  assert.deepEqual([audit[0].action, audit[0].actorId, audit[0].targetUserId, audit[0].changes.via, audit[0].changes.vendorId], ["created", "mgr", users[0].id, "vendor_login_created", "v2"]);
  const text = JSON.stringify(audit);
  for (const s of ["second@erectors.example", "9812345679", "tempPassword", ok.json.tempPassword]) assert.equal(text.includes(s), false, s);
});

test("archiving a vendor deactivates every active member login, revokes their sessions and records one audit row per account that was active", async () => {
  vendors.push({ id: "v1", status: "approved", ...VENDOR });
  users.push(
    { id: "m1", name: "Member 1", email: "m1@x.example", phone: null, roleKey: ROLE_KEY.ERECTION_ENGINEER, customerId: null, vendorId: "v1", isActive: true, tokenVersion: 0, passwordHash: "h" },
    { id: "m2", name: "Member 2", email: "m2@x.example", phone: null, roleKey: ROLE_KEY.ERECTION_ENGINEER, customerId: null, vendorId: "v1", isActive: true, tokenVersion: 4, passwordHash: "h" },
    { id: "m3", name: "Already off", email: "m3@x.example", phone: null, roleKey: ROLE_KEY.ERECTION_ENGINEER, customerId: null, vendorId: "v1", isActive: false, tokenVersion: 1, passwordHash: "h" },
    { id: "other", name: "Other vendor", email: "o@x.example", phone: null, roleKey: ROLE_KEY.ERECTION_ENGINEER, customerId: null, vendorId: "v2", isActive: true, tokenVersion: 0, passwordHash: "h" },
  );
  const r = await call("POST", "/vendors/v1/archive", {});
  assert.equal(r.status, 200);
  assert.deepEqual(users.filter((u) => u.vendorId === "v1").map((u) => [u.id, u.isActive, u.tokenVersion]), [["m1", false, 1], ["m2", false, 5], ["m3", false, 2]]);
  assert.deepEqual(users.find((u) => u.id === "other"), { id: "other", name: "Other vendor", email: "o@x.example", phone: null, roleKey: ROLE_KEY.ERECTION_ENGINEER, customerId: null, vendorId: "v2", isActive: true, tokenVersion: 0, passwordHash: "h" }, "another vendor's members are untouched");
  assert.deepEqual(audit.map((a) => [a.action, a.targetUserId, a.changes.via]).sort(), [["deactivated", "m1", "vendor_archived"], ["deactivated", "m2", "vendor_archived"]]);
  assert.equal(vendors[0].status, "archived");
});

test("archiving is all-or-nothing: if an audit record cannot be written, no login is deactivated and the vendor stays approved", async () => {
  vendors.push({ id: "v1", status: "approved", ...VENDOR });
  users.push({ id: "m1", name: "Member 1", email: "m1@x.example", phone: null, roleKey: ROLE_KEY.ERECTION_ENGINEER, customerId: null, vendorId: "v1", isActive: true, tokenVersion: 0, passwordHash: "h" });
  failAudit = true;
  const r = await call("POST", "/vendors/v1/archive", {});
  assert.equal(r.status, 500);
  assert.deepEqual([users[0].isActive, users[0].tokenVersion], [true, 0]);
  assert.equal(vendors[0].status, "approved");
});
