// Route-level tests for RECD unit warranty (Requirement 8). No database: the Prisma delegates are replaced with small in-memory stores
// (with a transaction that rolls back on error) and the REAL routers - auth, permission and unit-scoping middleware included - are
// exercised over HTTP. The e-mail provider is a stub: nothing is sent anywhere. The real-database counterparts are in
// test/db/warranty.db.test.ts.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { ROLE_KEY, PERMISSION_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = PERMISSION_KEY;
const users: Record<string, { id: string; role: string; perms: string[]; customerId?: string; vendorId?: string }> = {
  mgmt: { id: "mgmt", role: ROLE_KEY.MANAGEMENT, perms: [P.VIEW_SITE_STATUS, P.MANAGE_WARRANTY, P.MANAGE_ORDERS] },
  admin: { id: "admin", role: ROLE_KEY.SUPER_ADMIN, perms: [P.VIEW_SITE_STATUS, P.MANAGE_WARRANTY, P.MANAGE_SETTINGS] },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.VIEW_SITE_STATUS, P.MANAGE_ORDERS] },
  rmNorth: { id: "rmNorth", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.VIEW_SITE_STATUS] },
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [P.VIEW_SITE_STATUS, P.RAISE_COMPLAINT], customerId: "cA" },
  custB: { id: "custB", role: ROLE_KEY.CUSTOMER, perms: [P.VIEW_SITE_STATUS, P.RAISE_COMPLAINT], customerId: "cB" },
  vend1: { id: "vend1", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.VIEW_SITE_STATUS], vendorId: "v1" },
  vend2: { id: "vend2", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.VIEW_SITE_STATUS], vendorId: "v2" },
  noView: { id: "noView", role: ROLE_KEY.FINANCE, perms: [] },
};
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const day = (n: number) => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);

// --- in-memory stores -----------------------------------------------------------------------------
let units: any[] = [];
let history: any[] = [];
let deliveries: any[] = [];
let settings: any = null;
let productMonths: Record<string, number | null> = {};
let nextId = 1;
let failHistoryCreate = false;
const emailSent: string[] = [];
const emailFail = new Set<string>();
let emailThrows = false;
const notificationLogs: any[] = [];

/** A small where-matcher: equality, null, Date, gte/lte/lt/in, AND/OR, and nested relation objects. */
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((w: any) => matches(row, w));
    if (k === "AND") return v.every((w: any) => matches(row, w));
    const val = row?.[k];
    if (v === null) return val == null;
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    if (v && typeof v === "object" && ("gte" in v || "lte" in v || "lt" in v || "in" in v)) {
      if ("in" in v) return v.in.includes(val);
      if (val == null) return false;
      const t = val instanceof Date ? val.getTime() : val;
      if ("gte" in v && !(t >= (v.gte instanceof Date ? v.gte.getTime() : v.gte))) return false;
      if ("lte" in v && !(t <= (v.lte instanceof Date ? v.lte.getTime() : v.lte))) return false;
      if ("lt" in v && !(t < (v.lt instanceof Date ? v.lt.getTime() : v.lt))) return false;
      return true;
    }
    if (v && typeof v === "object") return val != null && matches(val, v);
    return val === v;
  });
}

const unitRow = (over: Record<string, unknown> = {}) => ({
  id: `u${nextId++}`, serialNo: `SN-${nextId}`, status: "active", orderId: "o1", siteId: "s1", productId: "p24",
  product: { id: "p24", name: "RECD", model: "R-250", warrantyMonths: 24 },
  order: { id: "o1", orderNumber: "ORD-1", poNumber: "PO-1", customerId: "cA", customer: { id: "cA", name: "Customer A" } },
  site: { id: "s1", companyName: "Site A", address: "Addr", regionId: "north", vendorId: "v1", dgModel: "C500", dgCapacityKva: "500", region: { id: "north", name: "North" } },
  warrantyStartDate: null, warrantyEndDate: null, warrantyMonths: null, warrantySource: null,
  ...over,
});
const seedUnit = (over: Record<string, unknown> = {}) => { const u = unitRow(over); units.push(u); return u; };
const withWarranty = (start: string, end: string, months: number | null = 12, source = "calculated") => ({ warrantyStartDate: D(start), warrantyEndDate: D(end), warrantyMonths: months, warrantySource: source });

let server: Server;
let base: string;
let signToken: (p: any) => string;
let lib: any;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  ({ signToken } = await import("../src/lib/jwt"));
  lib = await import("../src/lib/warranty");
  const { providersByChannel } = await import("../src/services/notifications/providers");
  const { recdUnitsRouter } = await import("../src/routes/recdUnits");
  const { warrantyAlertsRouter, warrantyCronRouter } = await import("../src/routes/warrantyAlerts");
  const { settingsRouter } = await import("../src/routes/settings");

  (providersByChannel as any).email = {
    channel: "email",
    send: async ({ recipientId }: any) => {
      if (emailThrows) throw new Error("smtp down");
      if (emailFail.has(recipientId)) return false;
      emailSent.push(recipientId);
      return true;
    },
  };

  const withRel = (u: any) => ({ ...u, product: { ...u.product, warrantyMonths: productMonths[u.productId] ?? null } });
  const delegates: Record<string, any> = {
    user: {
      findUnique: ({ where }: any) => {
        const u = Object.values(users).find((x) => x.id === where.id);
        return u ? { id: u.id, isActive: true, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } } : null;
      },
      findMany: () => Object.values(users).filter((u) => u.perms.includes(P.MANAGE_WARRANTY)).map((u) => ({ id: u.id })),
    },
    regionManager: { findMany: ({ where }: any) => (where.userId === "rmNorth" ? [{ regionId: "north" }] : []) },
    companySettings: {
      findUnique: () => (settings ? { ...settings } : null),
      upsert: ({ update, create }: any) => { settings = settings ? { ...settings, ...update } : { ...create }; return { ...settings }; },
    },
    recdUnit: {
      findUnique: ({ where }: any) => { const u = units.find((x) => x.id === where.id); return u ? withRel(u) : null; },
      findMany: ({ where }: any = {}) => units.filter((u) => matches(u, where)).map(withRel),
      updateMany: ({ where, data }: any) => { const hit = units.filter((u) => matches(u, where)); hit.forEach((u) => Object.assign(u, data)); return { count: hit.length }; },
    },
    warrantyHistory: {
      create: ({ data }: any) => {
        if (failHistoryCreate) throw new Error("disk full");
        const row = { id: `h${nextId++}`, createdAt: new Date(Date.now() + nextId), ...data };
        history.push(row);
        return row;
      },
      findMany: ({ where }: any) => history.filter((h) => matches(h, where)).sort((a, b) => b.createdAt - a.createdAt).map((h) => ({ ...h, actor: h.actorId ? { id: h.actorId, name: `User ${h.actorId}` } : null })),
    },
    warrantyReminderDelivery: {
      createMany: ({ data }: any) => {
        for (const d of data) {
          if (!deliveries.some((x) => x.unitId === d.unitId && x.recipientId === d.recipientId && x.warrantyEndDate.getTime() === d.warrantyEndDate.getTime())) {
            deliveries.push({ id: `d${nextId++}`, attempts: 0, lastAttemptAt: null, deliveredAt: null, ...d });
          }
        }
        return { count: data.length };
      },
      updateMany: ({ where, data }: any) => {
        const hit = deliveries.filter((d) => matches(d, where));
        for (const d of hit) {
          for (const [k, v] of Object.entries<any>(data)) d[k] = v && typeof v === "object" && "increment" in v ? d[k] + v.increment : v;
        }
        return { count: hit.length };
      },
    },
    notificationLog: { create: ({ data }: any) => { const row = { id: `n${nextId++}`, ...data }; notificationLogs.push(row); return row; } },
  };
  for (const [model, impl] of Object.entries(delegates)) Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  (prisma as any).$transaction = async (fn: any) => {
    const snap = { u: units.map((x) => ({ ...x })), h: history.map((x) => ({ ...x })) };
    try {
      return await fn(prisma);
    } catch (err) {
      units = snap.u; history = snap.h;
      throw err;
    }
  };

  const app = express();
  app.use(express.json());
  app.use("/recd-units", recdUnitsRouter);
  app.use("/warranty-alerts", warrantyAlertsRouter);
  app.use("/warranty/cron", warrantyCronRouter);
  app.use("/settings", settingsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

beforeEach(() => {
  units = []; history = []; deliveries = []; settings = null; nextId = 1; failHistoryCreate = false; productMonths = { p24: 24, pNone: null };
  emailSent.length = 0; emailFail.clear(); emailThrows = false; notificationLogs.length = 0;
});

async function call(as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${signToken({ userId: users[as].id, roleKey: users[as].role })}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------------------------------------------------
// Setting a warranty
// ---------------------------------------------------------------------------------------------------------------------

test("a legacy unit with no recorded dates is UNKNOWN (never active), with no countdown", async () => {
  const u = seedUnit();
  const r = await call("mgmt", "GET", `/recd-units/${u.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.warranty, { startDate: null, endDate: null, durationMonths: null, source: null, status: "unknown", daysRemaining: null, daysUntilStart: null, daysSinceExpiry: null });
  assert.equal(r.body.product.warrantyMonths, 24, "the product's default duration is still shown");
  const list = await call("mgmt", "GET", "/recd-units");
  assert.equal(list.body[0].warranty.status, "unknown");
  assert.equal(history.length, 0, "reading never invents history or dates");
});

test("start date only: the PRODUCT duration is used as the default and STORED on the unit; history row 'established'", async () => {
  const u = seedUnit();
  const r = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.warranty.startDate, r.body.warranty.endDate, r.body.warranty.durationMonths, r.body.warranty.source], ["2026-02-01", "2028-01-31", 24, "product_default"]);
  assert.deepEqual([units[0].warrantyMonths, units[0].warrantySource, iso(units[0].warrantyEndDate)], [24, "product_default", "2028-01-31"]);
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].kind, history[0].previousStartDate, history[0].newMonths, history[0].newSource, history[0].actorId, iso(history[0].newEndDate)], ["established", null, 24, "product_default", "mgmt", "2028-01-31"]);
});

test("a later change to Product.warrantyMonths does NOT recalculate an existing unit's warranty", async () => {
  const u = seedUnit();
  await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null });
  productMonths.p24 = 36; // the product default changes afterwards
  const r = await call("mgmt", "GET", `/recd-units/${u.id}`);
  assert.deepEqual([r.body.warranty.endDate, r.body.warranty.durationMonths, r.body.product.warrantyMonths], ["2028-01-31", 24, 36]);
  assert.equal(history.length, 1);
  const another = seedUnit();
  const r2 = await call("mgmt", "PUT", `/recd-units/${another.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null });
  assert.equal(r2.body.warranty.endDate, "2029-01-31", "a NEW warranty uses the new product default");
});

test("a product with no valid duration: dates are accepted only when they can be validated (expiry or duration given)", async () => {
  const u = seedUnit({ productId: "pNone", product: { id: "pNone", name: "RECD", model: "R-X", warrantyMonths: null } });
  const refused = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /no warranty duration configured/);
  assert.equal(units[0].warrantyStartDate, null);
  assert.equal(history.length, 0);
  const ok = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", durationMonths: 18, expectedEndDate: null });
  assert.deepEqual([ok.status, ok.body.warranty.endDate, ok.body.warranty.source], [200, "2027-07-31", "calculated"]);
});

test("manual dates are stored as typed (custom period, no duration); month-end and leap years are calculated correctly", async () => {
  const a = seedUnit();
  const r = await call("mgmt", "PUT", `/recd-units/${a.id}/warranty`, { startDate: "2026-02-01", endDate: "2027-03-15", expectedEndDate: null });
  assert.deepEqual([r.body.warranty.endDate, r.body.warranty.durationMonths, r.body.warranty.source], ["2027-03-15", null, "manual"]);
  const b = seedUnit();
  assert.equal((await call("mgmt", "PUT", `/recd-units/${b.id}/warranty`, { startDate: "2027-03-01", durationMonths: 12, expectedEndDate: null })).body.warranty.endDate, "2028-02-29");
  const c = seedUnit();
  assert.equal((await call("mgmt", "PUT", `/recd-units/${c.id}/warranty`, { startDate: "2026-01-31", durationMonths: 1, expectedEndDate: null })).body.warranty.endDate, "2026-02-27");
});

test("invalid or inconsistent input is rejected and changes nothing", async () => {
  const u = seedUnit();
  const bad: Array<[Record<string, unknown>, RegExp | null]> = [
    [{ startDate: "2026-02-30", expectedEndDate: null }, null],
    [{ startDate: "2026-02-01", endDate: "2026-01-31", expectedEndDate: null }, /cannot be before the start/],
    [{ startDate: "2026-02-01", endDate: "2027-02-01", durationMonths: 12, expectedEndDate: null }, /do not agree/],
    [{ startDate: "2026-02-01", durationMonths: 0, expectedEndDate: null }, null],
    [{ startDate: "2026-02-01", durationMonths: -5, expectedEndDate: null }, null],
    [{ startDate: "2026-02-01", durationMonths: 2.5, expectedEndDate: null }, null],
    [{ startDate: "2026-02-01", durationMonths: 500, expectedEndDate: null }, null],
    [{ startDate: "02/01/2026", expectedEndDate: null }, null],
    [{ startDate: "2026-02-01" }, null],
    [{}, null],
  ];
  for (const [body, re] of bad) {
    const r = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    if (re) assert.match(JSON.stringify(r.body.error), re);
  }
  assert.equal(units[0].warrantyStartDate, null);
  assert.equal(history.length, 0);
  assert.equal((await call("mgmt", "PUT", `/recd-units/missing/warranty`, { startDate: "2026-02-01", expectedEndDate: null })).status, 404);
});

test("correcting an existing period needs a reason, must change something, and is recorded with previous and new values", async () => {
  const u = seedUnit(withWarranty("2026-01-01", "2026-12-31", 12, "product_default"));
  const put = (b: Record<string, unknown>) => call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { expectedEndDate: "2026-12-31", ...b });
  assert.equal((await put({ startDate: "2026-02-01" })).status, 400, "no reason");
  assert.match((await put({ startDate: "2026-02-01" })).body.error, /reason/);
  assert.equal((await put({ startDate: "2026-02-01", reason: "x" })).status, 400, "reason too short");
  assert.equal(history.length, 0);
  const same = seedUnit(withWarranty("2026-01-01", "2026-12-31", 12, "calculated"));
  const unchanged = await call("mgmt", "PUT", `/recd-units/${same.id}/warranty`, { startDate: "2026-01-01", durationMonths: 12, expectedEndDate: "2026-12-31", reason: "no change" });
  assert.deepEqual([unchanged.status, unchanged.body.error], [400, "The warranty is unchanged"]);
  assert.equal(history.length, 0);
  const ok = await put({ startDate: "2026-02-01", durationMonths: 12, reason: "commissioning certificate dated 1 Feb" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.warranty.startDate, ok.body.warranty.endDate, ok.body.warranty.source], ["2026-02-01", "2027-01-31", "calculated"]);
  const h = history[0];
  assert.deepEqual([h.kind, iso(h.previousStartDate), iso(h.previousEndDate), h.previousMonths, h.previousSource, iso(h.newStartDate), iso(h.newEndDate), h.reason, h.actorId], ["correction", "2026-01-01", "2026-12-31", 12, "product_default", "2026-02-01", "2027-01-31", "commissioning certificate dated 1 Feb", "mgmt"]);
});

test("history is append-only through the API: it survives later edits and is listed newest first", async () => {
  const u = seedUnit();
  await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null });
  await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-03-01", expectedEndDate: "2028-01-31", reason: "start was a month later" });
  await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-03-01", endDate: "2028-06-30", expectedEndDate: "2028-02-29", reason: "extended by goodwill" });
  const h = await call("mgmt", "GET", `/recd-units/${u.id}/warranty-history`);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.map((x: any) => x.kind), ["correction", "correction", "established"]);
  assert.deepEqual(h.body.map((x: any) => x.newEndDate), ["2028-06-30", "2028-02-29", "2028-01-31"]);
  assert.deepEqual([h.body[0].by, h.body[0].reason], ["User mgmt", "extended by goodwill"]);
  assert.equal(history.length, 3);
  for (const method of ["DELETE", "PATCH", "POST"]) assert.ok([404, 405].includes((await call("mgmt", method, `/recd-units/${u.id}/warranty-history`, {})).status), `${method} has no route`);
});

test("the warranty change and its history are one transaction: if the history cannot be written, the unit is NOT changed", async () => {
  const u = seedUnit(withWarranty("2026-01-01", "2026-12-31", 12, "calculated"));
  failHistoryCreate = true;
  const r = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", durationMonths: 12, expectedEndDate: "2026-12-31", reason: "typo in the start date" });
  assert.equal(r.status, 500);
  assert.deepEqual([iso(units[0].warrantyStartDate), iso(units[0].warrantyEndDate)], ["2026-01-01", "2026-12-31"], "rolled back");
  assert.equal(history.length, 0);
  failHistoryCreate = false;
  const fresh = seedUnit();
  failHistoryCreate = true;
  assert.equal((await call("mgmt", "PUT", `/recd-units/${fresh.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null })).status, 500);
  assert.equal(units.find((x) => x.id === fresh.id).warrantyStartDate, null, "a first-time warranty is not recorded without its history either");
});

test("a stale editor is refused (409): the expected expiry no longer matches", async () => {
  const u = seedUnit(withWarranty("2026-01-01", "2026-12-31", 12, "calculated"));
  const r = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", durationMonths: 12, expectedEndDate: "2026-06-30", reason: "stale" });
  assert.deepEqual([r.status, r.body.code], [409, "STALE_WARRANTY"]);
  const blank = await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", durationMonths: 12, expectedEndDate: null, reason: "thought it was blank" });
  assert.equal(blank.status, 409);
  assert.equal(history.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Authorization and unit scope
// ---------------------------------------------------------------------------------------------------------------------

test("only manage_warranty may write: sales (manage_orders), the regional manager, customers, vendors and users without view access are refused", async () => {
  const u = seedUnit();
  for (const who of ["sales", "rmNorth", "custA", "vend1", "noView"]) {
    assert.equal((await call(who, "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null })).status, 403, who);
  }
  assert.equal((await call(null, "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null })).status, 401);
  assert.equal(units[0].warrantyStartDate, null);
  assert.equal(history.length, 0);
  assert.equal((await call("admin", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null })).status, 200);
});

test("customers see the warranty of their OWN units only; another customer's unit is 403 and absent from the list", async () => {
  const mine = seedUnit(withWarranty("2026-01-01", "2027-12-31", 24, "product_default"));
  const theirs = seedUnit({ order: { id: "o2", orderNumber: "ORD-2", poNumber: null, customerId: "cB", customer: { id: "cB", name: "Customer B" } }, ...withWarranty("2026-01-01", "2027-12-31", 24, "manual") });
  const own = await call("custA", "GET", `/recd-units/${mine.id}`);
  assert.deepEqual([own.status, own.body.warranty.status !== "unknown", own.body.warranty.endDate], [200, true, "2027-12-31"]);
  assert.equal((await call("custA", "GET", `/recd-units/${theirs.id}`)).status, 403);
  assert.equal((await call("custA", "GET", `/recd-units/${theirs.id}/warranty-history`)).status, 403);
  const list = await call("custA", "GET", "/recd-units");
  assert.deepEqual(list.body.map((x: any) => x.id), [mine.id]);
  assert.equal((await call("custB", "GET", `/recd-units/${mine.id}`)).status, 403);
});

test("vendors see only units at the sites they erect; the regional manager only their regions", async () => {
  const atV1 = seedUnit(withWarranty("2026-01-01", "2027-12-31", 24, "calculated"));
  const atV2 = seedUnit({ site: { id: "s2", companyName: "Site B", address: "B", regionId: "south", vendorId: "v2", dgModel: null, dgCapacityKva: null, region: { id: "south", name: "South" } }, ...withWarranty("2026-01-01", "2027-12-31", 24, "calculated") });
  assert.equal((await call("vend1", "GET", `/recd-units/${atV1.id}`)).status, 200);
  assert.equal((await call("vend1", "GET", `/recd-units/${atV2.id}`)).status, 403);
  assert.equal((await call("vend1", "GET", `/recd-units/${atV2.id}/warranty-history`)).status, 403);
  assert.deepEqual((await call("vend1", "GET", "/recd-units")).body.map((x: any) => x.id), [atV1.id]);
  assert.deepEqual((await call("rmNorth", "GET", "/recd-units")).body.map((x: any) => x.id), [atV1.id], "north only");
  assert.equal((await call("rmNorth", "GET", `/recd-units/${atV2.id}`)).status, 403);
});

test("history: staff see who and why; customers and vendors (read-only) see the periods only", async () => {
  const u = seedUnit();
  await call("mgmt", "PUT", `/recd-units/${u.id}/warranty`, { startDate: "2026-02-01", expectedEndDate: null, reason: "internal note about the customer" });
  const staff = await call("mgmt", "GET", `/recd-units/${u.id}/warranty-history`);
  assert.deepEqual([staff.body[0].by, staff.body[0].reason], ["User mgmt", "internal note about the customer"]);
  for (const who of ["custA", "vend1"]) {
    const r = await call(who, "GET", `/recd-units/${u.id}/warranty-history`);
    assert.equal(r.status, 200, who);
    assert.equal("by" in r.body[0] || "reason" in r.body[0], false, `${who} must not receive the actor or the reason`);
    assert.equal(r.body[0].newEndDate, "2028-01-31");
  }
  assert.equal((await call("noView", "GET", `/recd-units/${u.id}/warranty-history`)).status, 403);
});

test("a status is computed per unit for every state the list can show", async () => {
  seedUnit(withWarranty("2026-01-01", "2026-12-31", 12, "calculated")); // placeholder, replaced below with relative dates
  units = [];
  const mk = (s: number, e: number) => seedUnit(withWarranty(iso(day(s)), iso(day(e)), 12, "calculated"));
  const upcoming = mk(10, 375), active = mk(-100, 200), soon = mk(-300, 20), today = mk(-364, 0), expired = mk(-400, -1);
  const unknown = seedUnit();
  const list = await call("mgmt", "GET", "/recd-units");
  const st = (u: any) => list.body.find((x: any) => x.id === u.id).warranty;
  assert.deepEqual([upcoming, active, soon, today, expired, unknown].map((u) => st(u).status), ["upcoming", "active", "expiring_soon", "expiring_soon", "expired", "unknown"]);
  assert.deepEqual([st(upcoming).daysUntilStart, st(upcoming).daysRemaining], [10, null]);
  assert.deepEqual([st(soon).daysRemaining, st(today).daysRemaining], [20, 0]);
  assert.deepEqual([st(expired).daysSinceExpiry, st(expired).daysRemaining], [1, null], "expired the day after the inclusive expiry date, no countdown");
  settings = { warrantyReminderLeadDays: 250 };
  const wide = await call("mgmt", "GET", "/recd-units");
  assert.equal(wide.body.find((x: any) => x.id === active.id).warranty.status, "expiring_soon", "the window is the configured one");
});

// ---------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------

test("warranty reminder settings: only manage_settings; validated; separate from the AMC settings; null restores defaults", async () => {
  for (const who of ["mgmt", "sales", "custA", "vend1"]) assert.equal((await call(who, "PUT", "/settings/warranty", { warrantyReminderLeadDays: 45, warrantyReminderRepeatDays: 7 })).status, 403, who);
  assert.equal((await call(null, "PUT", "/settings/warranty", { warrantyReminderLeadDays: 45, warrantyReminderRepeatDays: 7 })).status, 401);
  for (const bad of [{ warrantyReminderLeadDays: -1, warrantyReminderRepeatDays: 3 }, { warrantyReminderLeadDays: 366, warrantyReminderRepeatDays: 3 }, { warrantyReminderLeadDays: 30, warrantyReminderRepeatDays: 0 }, { warrantyReminderLeadDays: 30 }, { warrantyReminderLeadDays: "10", warrantyReminderRepeatDays: 3 }]) {
    assert.equal((await call("admin", "PUT", "/settings/warranty", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(settings, null, "refused requests changed nothing");
  assert.deepEqual((await call("admin", "PUT", "/settings/warranty", { warrantyReminderLeadDays: 45, warrantyReminderRepeatDays: 7 })).body, { warrantyReminderLeadDays: 45, warrantyReminderRepeatDays: 7 });
  assert.deepEqual(await lib.loadWarrantyPolicy(), { reminderLeadDays: 45, reminderRepeatDays: 7 });
  settings = { ...settings, amcReminderLeadDays: 99 };
  assert.deepEqual(await lib.loadWarrantyPolicy(), { reminderLeadDays: 45, reminderRepeatDays: 7 }, "AMC settings do not affect the warranty ones");
  await call("admin", "PUT", "/settings/warranty", { warrantyReminderLeadDays: null, warrantyReminderRepeatDays: null });
  assert.deepEqual(await lib.loadWarrantyPolicy(), { reminderLeadDays: 30, reminderRepeatDays: 3 });
});

// ---------------------------------------------------------------------------------------------------------------------
// Login-time alerts
// ---------------------------------------------------------------------------------------------------------------------

test("alerts: expiring soon and recently expired only, never unknown / upcoming / healthy / old-expired; scoped to the caller", async () => {
  const mk = (s: number, e: number, over: Record<string, unknown> = {}) => seedUnit({ ...withWarranty(iso(day(s)), iso(day(e)), 12, "calculated"), ...over });
  const soon = mk(-300, 20);
  const expiredRecently = mk(-400, -5);
  const expiredLongAgo = mk(-900, -200);
  const fine = mk(-10, 300);
  const upcoming = mk(5, 370);
  const unknown = seedUnit();
  const retired = mk(-300, 10, { status: "retired" });
  const other = mk(-300, 7, { order: { id: "o2", orderNumber: "O2", poNumber: null, customerId: "cB", customer: { id: "cB", name: "Customer B" } }, site: { id: "s2", companyName: "Site B", address: "B", regionId: "south", vendorId: "v2", dgModel: null, dgCapacityKva: null, region: { id: "south", name: "South" } } });
  const ids = async (who: string) => (await call(who, "GET", "/warranty-alerts")).body.alerts.map((a: any) => a.unitId).sort();
  assert.deepEqual(await ids("mgmt"), [soon.id, expiredRecently.id, other.id].sort());
  assert.deepEqual(await ids("custA"), [soon.id, expiredRecently.id].sort(), "a customer sees only its own units");
  assert.deepEqual(await ids("custB"), [other.id]);
  assert.deepEqual(await ids("vend1"), [soon.id, expiredRecently.id].sort(), "a vendor sees only units at its sites");
  assert.deepEqual(await ids("vend2"), [other.id]);
  assert.deepEqual(await ids("rmNorth"), [soon.id, expiredRecently.id].sort(), "the regional manager sees only the north");
  assert.deepEqual(await ids("noView"), [], "no unit access = no alerts");
  assert.equal((await call(null, "GET", "/warranty-alerts")).status, 401);
  for (const x of [expiredLongAgo, fine, upcoming, unknown, retired]) assert.ok(!(await ids("mgmt")).includes(x.id), `not alerting: ${x.id}`);
  const a = (await call("mgmt", "GET", "/warranty-alerts")).body.alerts.find((x: any) => x.unitId === expiredRecently.id);
  assert.deepEqual([a.status, a.daysSinceExpiry, a.daysRemaining, a.endDate, a.key], ["expired", 5, null, iso(day(-5)), `warranty:${expiredRecently.id}:${iso(day(-5))}:expired`]);
  assert.deepEqual([a.customerName, a.productName, a.siteName].every(Boolean), true);
});

test("alert keys change with the expiry date and status, so a dismissed notice reappears only for a new situation", async () => {
  const u = seedUnit(withWarranty(iso(day(-300)), iso(day(10)), 12, "calculated"));
  const first = (await call("mgmt", "GET", "/warranty-alerts")).body.alerts[0].key;
  assert.equal((await call("mgmt", "GET", "/warranty-alerts")).body.alerts[0].key, first);
  u.warrantyEndDate = day(-1);
  assert.notEqual((await call("mgmt", "GET", "/warranty-alerts")).body.alerts[0].key, first);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------------------------------

const NOW = () => new Date();
const deliveredTo = () => deliveries.filter((d) => d.deliveredAt).map((d) => `${d.unitId}:${d.recipientId}`).sort();

test("reminders: a warranty entering the window is reminded once, to staff holding manage_warranty only, with the unit details", async () => {
  const inWindow = seedUnit(withWarranty(iso(day(-335)), iso(day(30)), 12, "calculated"));
  const outside = seedUnit(withWarranty(iso(day(-334)), iso(day(31)), 12, "calculated"));
  const r = await lib.runWarrantyReminders(NOW());
  assert.deepEqual([r.unitsInWindow, r.delivered, r.failed], [1, 2, 0], "one unit x two recipients (mgmt, admin)");
  assert.deepEqual(deliveredTo(), [`${inWindow.id}:admin`, `${inWindow.id}:mgmt`]);
  assert.ok(!deliveries.some((d) => d.unitId === outside.id), "outside the window: nothing");
  assert.deepEqual([...new Set(emailSent)].sort(), ["admin", "mgmt"], "never to sales, customers or vendors");
  const log = notificationLogs.find((l) => l.templateKey === "warranty_expiry_reminder")!;
  assert.deepEqual(log.channel, "email");
  assert.deepEqual([log.payload.serialNo, log.payload.productName, log.payload.customerName, log.payload.siteName, log.payload.expiryDate, log.payload.status, log.payload.daysRemaining], [inWindow.serialNo, "RECD (R-250)", "Customer A", "Site A", iso(day(30)), "expiring_soon", 30]);
});

test("reminders: expired, upcoming, retired and UNKNOWN-date units are never reminded", async () => {
  seedUnit(withWarranty(iso(day(-400)), iso(day(-1)), 12, "calculated"));
  seedUnit(withWarranty(iso(day(5)), iso(day(370)), 12, "calculated"));
  seedUnit(withWarranty(iso(day(-300)), iso(day(10)), 12, "calculated", ) && { ...withWarranty(iso(day(-300)), iso(day(10)), 12, "calculated"), status: "retired" });
  seedUnit();
  seedUnit({ warrantyStartDate: D("2026-01-01") }); // half-recorded: no expiry date
  const r = await lib.runWarrantyReminders(NOW());
  assert.deepEqual([r.unitsInWindow, r.delivered, deliveries.length, emailSent.length], [0, 0, 0, 0]);
});

test("reminders: the lead time and repeat interval are the configured ones; a corrected expiry starts a fresh cycle", async () => {
  settings = { warrantyReminderLeadDays: 60, warrantyReminderRepeatDays: 1 };
  const u = seedUnit(withWarranty(iso(day(-300)), iso(day(50)), 12, "calculated"));
  const t0 = NOW();
  assert.equal((await lib.runWarrantyReminders(t0)).delivered, 2, "50 days out is inside a 60-day window");
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 3600_000))).delivered, 0);
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 1.01 * 24 * 3600_000))).delivered, 2, "repeats daily");
  u.warrantyEndDate = day(45); // a correction moved the expiry
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 1.02 * 24 * 3600_000))).delivered, 2, "the corrected expiry date is a new cycle");
});

test("reminders with the defaults: not again within 3 days, again after 3 days", async () => {
  seedUnit(withWarranty(iso(day(-340)), iso(day(25)), 12, "calculated"));
  const t0 = NOW();
  assert.equal((await lib.runWarrantyReminders(t0)).delivered, 2);
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 2.9 * 24 * 3600_000))).delivered, 0);
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 3.1 * 24 * 3600_000))).delivered, 2);
});

test("overlapping scheduler runs send each reminder once", async () => {
  seedUnit(withWarranty(iso(day(-340)), iso(day(25)), 12, "calculated"));
  const t0 = NOW();
  const runs = await Promise.all([lib.runWarrantyReminders(t0), lib.runWarrantyReminders(t0), lib.runWarrantyReminders(t0), lib.runWarrantyReminders(t0)]);
  assert.equal(runs.reduce((n, r) => n + r.delivered, 0), 2, "one delivery per recipient in total");
  assert.deepEqual(emailSent.slice().sort(), ["admin", "mgmt"]);
});

test("delivery failure is recorded as a failure (not delivered), retried later, and a successful recipient is never e-mailed twice", async () => {
  const u = seedUnit(withWarranty(iso(day(-340)), iso(day(25)), 12, "calculated"));
  emailFail.add("mgmt"); // the provider refuses mgmt (e.g. no SMTP / no address)
  const t0 = NOW();
  const r1 = await lib.runWarrantyReminders(t0);
  assert.deepEqual([r1.delivered, r1.failed], [1, 1]);
  const mgmtRow = () => deliveries.find((d) => d.recipientId === "mgmt")!;
  assert.deepEqual([mgmtRow().deliveredAt, mgmtRow().attempts], [null, 1], "an in-app/log row is not delivery");
  assert.ok(notificationLogs.some((l) => l.status === "failed" && l.recipientId === "mgmt"));
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 600_000))).failed, 0, "not retried within the hour");
  emailFail.clear();
  const r2 = await lib.runWarrantyReminders(new Date(t0.getTime() + 2 * 3600_000));
  assert.deepEqual([r2.delivered, r2.failed], [1, 0], "only the failed recipient is retried");
  assert.equal(emailSent.filter((x) => x === "admin").length, 1, "admin was not e-mailed again");
  assert.equal(emailSent.filter((x) => x === "mgmt").length, 1);
  assert.deepEqual([mgmtRow().attempts, !!mgmtRow().deliveredAt], [0, true]);
  assert.equal(deliveredTo().length, 2);
  assert.ok(u);
});

test("a provider that throws is a failed attempt, not a crash; after 5 failures the recipient waits a full repeat interval", async () => {
  seedUnit(withWarranty(iso(day(-340)), iso(day(25)), 12, "calculated"));
  emailThrows = true;
  const t0 = NOW();
  for (let i = 0; i < 6; i++) await lib.runWarrantyReminders(new Date(t0.getTime() + i * 2 * 3600_000));
  assert.ok(deliveries.every((d) => d.attempts === 5 && !d.deliveredAt), "capped at 5 attempts, never delivered");
  emailThrows = false;
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 2 * 24 * 3600_000))).delivered, 0, "still waiting inside the repeat interval");
  assert.equal((await lib.runWarrantyReminders(new Date(t0.getTime() + 4 * 24 * 3600_000))).delivered, 2, "after the interval it tries again and succeeds");
});

test("cron route: refuses without the shared secret and sends nothing", async () => {
  seedUnit(withWarranty(iso(day(-340)), iso(day(25)), 12, "calculated"));
  delete process.env.CRON_SECRET;
  assert.equal((await call(null, "GET", "/warranty/cron/send-reminders")).status, 401);
  process.env.CRON_SECRET = "s3";
  assert.equal((await call(null, "GET", "/warranty/cron/send-reminders", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal(emailSent.length, 0);
  const ok = await call(null, "GET", "/warranty/cron/send-reminders", undefined, { authorization: "Bearer s3" });
  assert.deepEqual([ok.status, ok.body.ok, ok.body.delivered], [200, true, 2]);
  delete process.env.CRON_SECRET;
});

test("every cron route the API mounts is scheduled in vercel.json (requirements 6, 7, 8 and 11 send their reminders by themselves)", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const cfg = JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8"));
  const paths = (cfg.crons as Array<{ path: string; schedule: string }>).map((c) => c.path).sort();
  assert.deepEqual(paths, ["/amc-orders/send-expiry-reminders", "/complaints/cron/escalate", "/reminders/cron/run", "/warranty/cron/send-reminders"]);
  for (const c of cfg.crons) assert.match(c.schedule, /^\d+ \d+ \* \* \*$/, "daily");
});
