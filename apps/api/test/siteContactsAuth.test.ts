// Site-contact routes (POST/PATCH/DELETE /sites/:id/contacts): a vendor or customer user may only change contacts
// of sites that belong to them; unscoped staff (management etc.) keep working. Prisma is replaced by in-memory stubs.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = PERMISSION_KEY;
type U = { id: string; role: string; perms: string[]; customerId?: string; vendorId?: string };
const users: Record<string, U> = {
  mgmt: { id: "mgmt", role: ROLE_KEY.MANAGEMENT, perms: [P.CHANGE_SITE_STATUS, P.VIEW_SITE_STATUS] },
  vendorA: { id: "vendorA", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.CHANGE_SITE_STATUS, P.VIEW_SITE_STATUS], vendorId: "vA" },
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [P.CHANGE_SITE_STATUS, P.VIEW_SITE_STATUS], customerId: "cA" },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS, P.VIEW_SITE_STATUS] },
};
// siteA belongs to customer cA / vendor vA; siteB to customer cB / vendor vB.
const sites: Record<string, any> = {
  sA: { id: "sA", vendorId: "vA", order: { customerId: "cA" } },
  sB: { id: "sB", vendorId: "vB", order: { customerId: "cB" } },
};
const contacts: Record<string, any> = {
  cA1: { id: "cA1", siteId: "sA", name: "A desk" },
  cB1: { id: "cB1", siteId: "sB", name: "B desk" },
};
const writes: string[] = [];

let server: Server;
let base = "";
let tokenFor: (u: string) => string;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { sitesRouter } = await import("../src/routes/sites");
  const define = (model: string, impl: Record<string, (...a: any[]) => any>) =>
    Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  define("user", {
    findUnique: ({ where }: any) => {
      const u = Object.values(users).find((x) => x.id === where.id);
      if (!u) return null;
      return { id: u.id, isActive: true, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } };
    },
  });
  define("site", { findUnique: ({ where }: any) => sites[where.id] ?? null });
  define("siteContact", {
    findUnique: ({ where }: any) => contacts[where.id] ?? null,
    create: ({ data }: any) => { writes.push(`create:${data.siteId}`); return { id: "new", ...data }; },
    update: ({ where, data }: any) => { writes.push(`update:${where.id}`); return { ...contacts[where.id], ...data }; },
    delete: ({ where }: any) => { writes.push(`delete:${where.id}`); return contacts[where.id]; },
  });
  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: users[u].customerId ?? null });
  const app = express();
  app.use(express.json());
  app.use("/sites", sitesRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

async function call(as: string, method: string, path: string, body?: unknown) {
  writes.length = 0;
  const res = await fetch(`${base}/sites${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(as)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}
const NEW = { name: "New contact", phone: "9000000001" };

test("unscoped management staff can add, edit and delete contacts on any site", async () => {
  assert.equal(await call("mgmt", "POST", "/sA/contacts", NEW), 201);
  assert.equal(await call("mgmt", "POST", "/sB/contacts", NEW), 201);
  assert.equal(await call("mgmt", "PATCH", "/sB/contacts/cB1", { name: "Renamed" }), 200);
  assert.equal(await call("mgmt", "DELETE", "/sB/contacts/cB1"), 204);
  assert.deepEqual(writes, ["delete:cB1"]);
});

test("a vendor user can manage contacts on a site assigned to their vendor", async () => {
  assert.equal(await call("vendorA", "POST", "/sA/contacts", NEW), 201);
  assert.equal(await call("vendorA", "PATCH", "/sA/contacts/cA1", { name: "Renamed" }), 200);
  assert.equal(await call("vendorA", "DELETE", "/sA/contacts/cA1"), 204);
});

test("a vendor user is forbidden from another vendor's site, and nothing is written", async () => {
  assert.equal(await call("vendorA", "POST", "/sB/contacts", NEW), 403);
  assert.deepEqual(writes, []);
  assert.equal(await call("vendorA", "PATCH", "/sB/contacts/cB1", { name: "Hacked" }), 403);
  assert.deepEqual(writes, []);
  assert.equal(await call("vendorA", "DELETE", "/sB/contacts/cB1"), 403);
  assert.deepEqual(writes, []);
});

test("a customer user is limited to their own site", async () => {
  assert.equal(await call("custA", "POST", "/sA/contacts", NEW), 201);
  assert.equal(await call("custA", "POST", "/sB/contacts", NEW), 403);
  assert.equal(await call("custA", "PATCH", "/sB/contacts/cB1", { name: "Hacked" }), 403);
  assert.equal(await call("custA", "DELETE", "/sB/contacts/cB1"), 403);
  assert.deepEqual(writes, []);
});

test("a contact belonging to an unrelated site cannot be reached through an authorised site's URL", async () => {
  // vendorA owns sA, but cB1 belongs to sB: the contact must not be edited or deleted via /sA/...
  assert.equal(await call("vendorA", "PATCH", "/sA/contacts/cB1", { name: "Hacked" }), 404);
  assert.deepEqual(writes, []);
  assert.equal(await call("vendorA", "DELETE", "/sA/contacts/cB1"), 404);
  assert.deepEqual(writes, []);
  assert.equal(await call("mgmt", "PATCH", "/sA/contacts/cB1", { name: "Hacked" }), 404);
});

test("unknown site or contact gives 404; missing permission gives 403", async () => {
  assert.equal(await call("mgmt", "POST", "/nope/contacts", NEW), 404);
  assert.equal(await call("mgmt", "PATCH", "/sA/contacts/nope", { name: "x" }), 404);
  assert.equal(await call("sales", "POST", "/sA/contacts", NEW), 403);
  assert.equal(await call("sales", "DELETE", "/sA/contacts/cA1"), 403);
  assert.deepEqual(writes, []);
});
