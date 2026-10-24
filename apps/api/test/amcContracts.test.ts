// Route-level tests for AMC dates, vendor AMC and renewals (Requirement 7). No database: the Prisma delegates are replaced with
// small in-memory stores (with a transaction that rolls back on error) and the REAL routers - auth, permission and scoping
// middleware included - are exercised over HTTP. The real-database counterparts are in test/db/amcContracts.db.test.ts.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { ROLE_KEY, PERMISSION_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = PERMISSION_KEY;
const users: Record<string, { id: string; role: string; perms: string[]; customerId?: string; vendorId?: string }> = {
  mgmt: { id: "mgmt", role: ROLE_KEY.MANAGEMENT, perms: [P.MANAGE_AMC_ORDERS] },
  admin: { id: "admin", role: ROLE_KEY.SUPER_ADMIN, perms: [P.MANAGE_AMC_ORDERS, P.MANAGE_SETTINGS] },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS] },
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [], customerId: "cA" },
  custB: { id: "custB", role: ROLE_KEY.CUSTOMER, perms: [], customerId: "cB" },
  vend1: { id: "vend1", role: ROLE_KEY.ERECTION_ENGINEER, perms: [], vendorId: "v1" },
  vend2: { id: "vend2", role: ROLE_KEY.ERECTION_ENGINEER, perms: [], vendorId: "v2" },
};
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const day = (n: number) => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + n)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);

// --- in-memory stores ---------------------------------------------------------------------------
let amcOrders: any[] = [];
let vendorAmcs: any[] = [];
let renewals: any[] = [];
let settings: any = null;
let nextId = 1;
let failRenewalCreate = false;
let recipients: Array<{ id: string }> = [];
let notificationLog: any[] = [];
// customers cA / cB, and sites that belong to them (a site is reached through its order's customer)
const SITES: Record<string, { customerId: string; name: string | null }> = { sA1: { customerId: "cA", name: "Site A" }, sA2: { customerId: "cA", name: null }, sB1: { customerId: "cB", name: "Site B" } };

function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((w: any) => matches(row, w));
    if (v === null) return row[k] == null;
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    if (v && typeof v === "object" && "lte" in v) return row[k] != null && row[k].getTime() <= v.lte.getTime();
    return row[k] === v;
  });
}
const clone = (r: any) => ({ ...r });
/** What the real query's `include` adds to a vendor contract: the vendor and, when recorded, its customer and site. */
const vendorLinks = (r: any) => ({
  vendor: { id: r.vendorId, name: `Vendor ${r.vendorId}` },
  customer: r.customerId ? { id: r.customerId, name: `Customer ${r.customerId}` } : null,
  site: r.siteId ? { id: r.siteId, companyName: SITES[r.siteId]?.name ?? null } : null,
});
function store(rows: () => any[], extra: (r: any) => any = (r) => r) {
  return {
    findUnique: ({ where }: any) => { const r = rows().find((x) => x.id === where.id); return r ? extra(clone(r)) : null; },
    findFirst: ({ where }: any) => { const r = rows().find((x) => matches(x, where)); return r ? extra(clone(r)) : null; },
    findMany: ({ where }: any = {}) => rows().filter((x) => matches(x, where)).map((r) => extra(clone(r))),
    updateMany: ({ where, data }: any) => { const hit = rows().filter((x) => matches(x, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
    update: ({ where, data }: any) => { const r = rows().find((x) => x.id === where.id)!; Object.assign(r, data); return extra(clone(r)); },
  };
}

let server: Server;
let base: string;
let signToken: (p: any) => string;
let lib: any;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  ({ signToken } = await import("../src/lib/jwt"));
  lib = await import("../src/lib/amcContracts");
  const { amcOrdersRouter } = await import("../src/routes/amcOrders");
  const { vendorAmcsRouter } = await import("../src/routes/vendorAmcs");
  const { amcAlertsRouter } = await import("../src/routes/amcAlerts");
  const { settingsRouter } = await import("../src/routes/settings");

  const delegates: Record<string, any> = {
    user: {
      findUnique: ({ where }: any) => {
        const u = Object.values(users).find((x) => x.id === where.id);
        return u ? { id: u.id, isActive: true, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } } : null;
      },
      findMany: () => recipients.map((r) => ({ ...r })), // none by default: the stamps are still taken, nothing is sent
    },
    customer: { findUnique: ({ where }: any) => (["cA", "cB"].includes(where.id) ? { id: where.id, name: `Customer ${where.id}` } : null) },
    site: { findUnique: ({ where }: any) => (SITES[where.id] ? { id: where.id, companyName: SITES[where.id].name, order: { customerId: SITES[where.id].customerId } } : null) },
    notificationLog: { create: ({ data }: any) => { notificationLog.push(data); return data; } },
    vendor: { findUnique: ({ where }: any) => ({ v1: { id: "v1", status: "approved" }, v2: { id: "v2", status: "approved" }, vp: { id: "vp", status: "pending" } } as any)[where.id] ?? null },
    recdUnit: { findMany: () => [] },
    companySettings: {
      findUnique: () => (settings ? { ...settings } : null),
      upsert: ({ update, create }: any) => { settings = settings ? { ...settings, ...update } : { ...create }; return { ...settings }; },
    },
    amcOrder: {
      ...store(() => amcOrders, (r) => ({ ...r, customer: { id: r.customerId, name: `Customer ${r.customerId}` }, units: [], _count: { renewals: renewals.filter((x) => x.amcOrderId === r.id).length }, renewals: renewals.filter((x) => x.amcOrderId === r.id && x.kind === "renewal").sort((p, q) => q.createdAt - p.createdAt).slice(0, 1) })),
      create: ({ data }: any) => { const r = { id: `amc${nextId++}`, lastExpiryReminderAt: null, expiryReminderClearedAt: null, ...data }; delete r.units; amcOrders.push(r); return { ...r, customer: { id: r.customerId, name: "C" }, units: [], _count: { renewals: 0 } }; },
    },
    vendorAmc: {
      ...store(() => vendorAmcs, (r) => ({ ...r, ...vendorLinks(r), _count: { renewals: renewals.filter((x) => x.vendorAmcId === r.id).length } })),
      create: ({ data }: any) => { const r = { id: `vamc${nextId++}`, lastExpiryReminderAt: null, expiryReminderClearedAt: null, notes: null, customerId: null, siteId: null, ...data }; vendorAmcs.push(r); return { ...r, ...vendorLinks(r), _count: { renewals: 0 } }; },
    },
    amcRenewal: {
      create: ({ data }: any) => {
        if (failRenewalCreate) throw new Error("disk full");
        const dup = data.kind === "renewal" && renewals.some((r) => r.kind === "renewal" && (r.amcOrderId ?? r.vendorAmcId) === (data.amcOrderId ?? data.vendorAmcId) && r.previousEndDate.getTime() === data.previousEndDate.getTime());
        if (dup) throw new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "5.22.0" });
        const row = { id: `r${nextId++}`, createdAt: new Date(Date.now() + nextId), amcOrderId: null, vendorAmcId: null, note: null, ...data };
        renewals.push(row);
        return row;
      },
      findMany: ({ where }: any) => renewals.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r, renewedBy: r.renewedById ? { id: r.renewedById, name: `User ${r.renewedById}` } : null })),
    },
  };
  for (const [model, impl] of Object.entries(delegates)) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  }
  // A transaction that undoes every in-memory change if the callback throws.
  (prisma as any).$transaction = async (fn: any) => {
    const snap = { a: amcOrders.map(clone), v: vendorAmcs.map(clone), r: renewals.map(clone) };
    try {
      return await fn(prisma);
    } catch (err) {
      amcOrders = snap.a; vendorAmcs = snap.v; renewals = snap.r;
      throw err;
    }
  };

  const app = express();
  app.use(express.json());
  app.use("/amc-orders", amcOrdersRouter);
  app.use("/vendor-amcs", vendorAmcsRouter);
  app.use("/amc-alerts", amcAlertsRouter);
  app.use("/settings", settingsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

beforeEach(() => {
  amcOrders = []; vendorAmcs = []; renewals = []; settings = null; nextId = 1; failRenewalCreate = false; recipients = []; notificationLog = [];
});

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${signToken({ userId: users[as].id, roleKey: users[as].role })}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const seedAmc = (over: Record<string, unknown> = {}) => { const r = { id: `amc${nextId++}`, poNo: "PO", poDate: D("2026-01-01"), customerId: "cA", amcType: "camc", location: "L", item: "I", qty: 1, amcFrequencyPerYear: 1, startDate: D("2026-01-01"), endDate: D("2026-12-31"), datesSource: "explicit", lastExpiryReminderAt: null, expiryReminderClearedAt: null, ...over }; amcOrders.push(r); return r; };
const seedVendorAmc = (over: Record<string, unknown> = {}) => { const r = { id: `vamc${nextId++}`, vendorId: "v1", title: "T", contractRef: null, notes: null, startDate: D("2026-01-01"), endDate: D("2026-12-31"), lastExpiryReminderAt: null, expiryReminderClearedAt: null, ...over }; vendorAmcs.push(r); return r; };
const orderBody = (over: Record<string, unknown> = {}) => ({ poNo: "PO-1", poDate: "2026-05-10T00:00:00.000Z", customerId: "cA", location: "L", item: "I", qty: 1, amcFrequencyPerYear: 4, amcType: "camc", unitIds: [], ...over });

test("create customer AMC: explicit dates / start+duration / defaults, stored as dates and returned with status", async () => {
  let r = await call("mgmt", "POST", "/amc-orders", orderBody({ startDate: "2026-06-01", endDate: "2027-05-31" }));
  assert.deepEqual([r.status, r.body.startDate, r.body.endDate, r.body.datesSource], [201, "2026-06-01", "2027-05-31", "explicit"]);
  r = await call("mgmt", "POST", "/amc-orders", orderBody({ startDate: "2026-06-01", durationMonths: 6 }));
  assert.deepEqual([r.body.startDate, r.body.endDate], ["2026-06-01", "2026-11-30"]);
  r = await call("mgmt", "POST", "/amc-orders", orderBody());
  assert.deepEqual([r.status, r.body.startDate, r.body.endDate], [201, "2026-05-10", "2027-05-09"], "start = PO date, 12 months by default");
  assert.ok(["upcoming", "active", "expiring_soon", "expired"].includes(r.body.contractStatus));
  settings = { amcDefaultDurationMonths: 24 };
  r = await call("mgmt", "POST", "/amc-orders", orderBody());
  assert.equal(r.body.endDate, "2028-05-09", "the configured duration is used");
});

test("create customer AMC: invalid periods and unknown customers are refused and nothing is stored", async () => {
  for (const bad of [{ startDate: "2026-06-01", endDate: "2026-06-01" }, { startDate: "2026-06-01", endDate: "2026-01-01" }, { endDate: "2027-01-01", durationMonths: 3 }, { startDate: "2026-02-30" }, { durationMonths: 500 }, { customerId: "nope" }]) {
    assert.equal((await call("mgmt", "POST", "/amc-orders", orderBody(bad))).status, 400, JSON.stringify(bad));
  }
  assert.equal(amcOrders.length, 0);
});

test("list: legacy rows without explicit dates show the PO date + 1 year and say so; counts by contract status", async () => {
  seedAmc({ id: "legacy", poDate: D("2025-03-15"), startDate: null, endDate: null, datesSource: "explicit" });
  seedAmc({ id: "soon", startDate: day(-300), endDate: day(10) });
  seedAmc({ id: "expired", startDate: day(-500), endDate: day(-1) });
  seedAmc({ id: "active", startDate: day(-5), endDate: day(200) });
  seedAmc({ id: "upcoming", startDate: day(5), endDate: day(300) });
  const r = await call("mgmt", "GET", "/amc-orders");
  const by = (id: string) => r.body.orders.find((o: any) => o.id === id);
  assert.deepEqual([by("legacy").startDate, by("legacy").endDate, by("legacy").datesSource], ["2025-03-15", "2026-03-15", "legacy_po_date"]);
  assert.deepEqual(["soon", "expired", "active", "upcoming"].map((id) => by(id).contractStatus), ["expiring_soon", "expired", "active", "upcoming"]);
  assert.deepEqual(r.body.contractCounts, { upcoming: 1, renewed: 0, active: 1, expiringSoon: 1, expired: 2 }, "the legacy 2025 row is long expired");
});

test("renew: old period kept in history, new period current, actor recorded; stale and overlapping requests are refused", async () => {
  const a = seedAmc();
  const ok = await call("mgmt", "POST", `/amc-orders/${a.id}/renew`, { expectedEndDate: "2026-12-31", note: "PO 77" });
  assert.deepEqual([ok.status, ok.body.newStartDate, ok.body.newEndDate], [201, "2027-01-01", "2027-12-31"]);
  assert.deepEqual([iso(amcOrders[0].startDate), iso(amcOrders[0].endDate)], ["2027-01-01", "2027-12-31"]);
  assert.deepEqual([renewals.length, renewals[0].kind, iso(renewals[0].previousEndDate), renewals[0].renewedById, renewals[0].note], [1, "renewal", "2026-12-31", "mgmt", "PO 77"]);
  const dup = await call("mgmt", "POST", `/amc-orders/${a.id}/renew`, { expectedEndDate: "2026-12-31" });
  assert.deepEqual([dup.status, dup.body.code], [409, "STALE_PERIOD"], "a double submit renews once");
  assert.equal((await call("mgmt", "POST", `/amc-orders/${a.id}/renew`, { expectedEndDate: "2027-12-31", newStartDate: "2027-06-01" })).status, 400, "overlap");
  assert.equal(renewals.length, 1);
  const h = await call("mgmt", "GET", `/amc-orders/${a.id}/renewals`);
  assert.deepEqual([h.status, h.body.length, h.body[0].previousStartDate, h.body[0].newEndDate, h.body[0].by], [200, 1, "2026-01-01", "2027-12-31", "User mgmt"]);
  assert.equal((await call("mgmt", "POST", `/amc-orders/missing/renew`, { expectedEndDate: "2026-12-31" })).status, 404);
});

test("renewing before the end makes the status 'renewed' until the new period starts; renewing after the end makes it active", async () => {
  const early = seedAmc({ id: "early", startDate: day(-345), endDate: day(20) });
  assert.equal((await call("mgmt", "POST", `/amc-orders/${early.id}/renew`, { expectedEndDate: iso(day(20)) })).status, 201);
  let got = (await call("mgmt", "GET", `/amc-orders/${early.id}`)).body;
  assert.deepEqual([got.contractStatus, got.startDate, got.renewalCount], ["renewed", iso(day(21)), 1]);
  assert.equal((await call("mgmt", "GET", "/amc-orders")).body.contractCounts.renewed, 1);
  assert.equal((await call("mgmt", "GET", "/amc-alerts")).body.alerts.some((x: any) => x.id === early.id), false, "a renewed contract no longer alerts");
  const late = seedAmc({ id: "late", startDate: day(-400), endDate: day(-10) });
  assert.equal((await call("mgmt", "POST", `/amc-orders/${late.id}/renew`, { expectedEndDate: iso(day(-10)) })).status, 201);
  got = (await call("mgmt", "GET", `/amc-orders/${late.id}`)).body;
  assert.equal(got.contractStatus, "active", "renewed after it ended: the new period has already started");
  assert.equal(got.startDate, iso(day(-9)));
});

test("renew resets the reminder state so the new period is reminded afresh", async () => {
  const a = seedAmc({ lastExpiryReminderAt: new Date(), expiryReminderClearedAt: new Date(), expiryReminderClearedById: "mgmt" });
  await call("mgmt", "POST", `/amc-orders/${a.id}/renew`, { expectedEndDate: "2026-12-31" });
  assert.deepEqual([amcOrders[0].lastExpiryReminderAt, amcOrders[0].expiryReminderClearedAt, amcOrders[0].expiryReminderClearedById], [null, null, null]);
});

test("a failure while writing the history rolls the renewal back (dates unchanged, no history)", async () => {
  const a = seedAmc();
  failRenewalCreate = true;
  const r = await call("mgmt", "POST", `/amc-orders/${a.id}/renew`, { expectedEndDate: "2026-12-31" });
  assert.equal(r.status, 500);
  assert.equal(iso(amcOrders[0].endDate), "2026-12-31");
  assert.equal(renewals.length, 0);
});

test("edit: a date change needs a reason, is validated, and is kept as a correction; plain edits leave no history", async () => {
  const a = seedAmc();
  assert.equal((await call("mgmt", "PATCH", `/amc-orders/${a.id}`, { endDate: "2027-01-31" })).status, 400);
  assert.equal((await call("mgmt", "PATCH", `/amc-orders/${a.id}`, { endDate: "2025-01-31", reason: "typo" })).status, 400);
  assert.equal((await call("mgmt", "PATCH", `/amc-orders/${a.id}`, { startDate: "2026-01-01", reason: "same" })).status, 400, "unchanged dates");
  assert.equal((await call("mgmt", "PATCH", `/amc-orders/${a.id}`, {})).status, 400);
  assert.equal(renewals.length, 0);
  assert.equal((await call("mgmt", "PATCH", `/amc-orders/${a.id}`, { location: "New" })).body.location, "New");
  assert.equal(renewals.length, 0);
  const fix = await call("mgmt", "PATCH", `/amc-orders/${a.id}`, { endDate: "2027-01-31", reason: "per signed PO" });
  assert.deepEqual([fix.status, fix.body.endDate], [200, "2027-01-31"]);
  assert.deepEqual([renewals.length, renewals[0].kind, iso(renewals[0].previousEndDate), iso(renewals[0].newEndDate), renewals[0].note], [1, "correction", "2026-12-31", "2027-01-31", "per signed PO"]);
});

test("customer-AMC routes need manage_amc_orders; vendor/customer/sales users are refused and nothing changes", async () => {
  const a = seedAmc();
  for (const who of ["custA", "vend1", "sales"]) {
    assert.equal((await call(who, "GET", "/amc-orders")).status, 403, who);
    assert.equal((await call(who, "GET", `/amc-orders/${a.id}`)).status, 403);
    assert.equal((await call(who, "PATCH", `/amc-orders/${a.id}`, { location: "x" })).status, 403);
    assert.equal((await call(who, "POST", `/amc-orders/${a.id}/renew`, { expectedEndDate: "2026-12-31" })).status, 403);
    assert.equal((await call(who, "GET", `/amc-orders/${a.id}/renewals`)).status, 403);
  }
  assert.equal((await call(null, "GET", "/amc-orders")).status, 401);
  assert.equal(renewals.length, 0);
});

test("cron route: refuses without the secret", async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await call(null, "GET", "/amc-orders/send-expiry-reminders")).status, 401);
  process.env.CRON_SECRET = "s3";
  const bad = await fetch(`${base}/amc-orders/send-expiry-reminders`, { headers: { authorization: "Bearer wrong" } });
  assert.equal(bad.status, 401);
  delete process.env.CRON_SECRET;
});

test("reminder job timing with the default policy: stamps at 30 days, not again within 3 days, again after, never when acquired", async () => {
  const early = seedAmc({ id: "early", startDate: day(-325), endDate: day(40) });
  const due = seedAmc({ id: "due", startDate: day(-335), endDate: day(30) });
  const acquired = seedAmc({ id: "acq", startDate: day(-335), endDate: day(5), expiryReminderClearedAt: new Date() });
  const v = seedVendorAmc({ id: "v", startDate: day(-340), endDate: day(25) });
  const NOW = new Date();
  const r1 = await lib.runAmcExpiryReminders(NOW);
  assert.deepEqual([r1.remindersSent, r1.vendorRemindersSent], [1, 1]);
  assert.deepEqual([early.lastExpiryReminderAt, !!due.lastExpiryReminderAt, acquired.lastExpiryReminderAt, !!v.lastExpiryReminderAt], [null, true, null, true]);
  const r2 = await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 2 * 24 * 3600 * 1000));
  assert.deepEqual([r2.remindersSent, r2.vendorRemindersSent], [0, 0]);
  const r3 = await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 3.01 * 24 * 3600 * 1000));
  assert.deepEqual([r3.remindersSent, r3.vendorRemindersSent], [1, 1]);
  // overlapping runs claim each reminder once
  due.lastExpiryReminderAt = null;
  const both = await Promise.all([lib.runAmcExpiryReminders(NOW), lib.runAmcExpiryReminders(NOW)]);
  assert.equal(both[0].remindersSent + both[1].remindersSent, 1);
});

test("reminder job timing follows the configured lead and repeat days", async () => {
  settings = { amcReminderLeadDays: 60, amcReminderRepeatDays: 1 };
  const a = seedAmc({ startDate: day(-300), endDate: day(50) });
  const NOW = new Date();
  assert.equal((await lib.runAmcExpiryReminders(NOW)).remindersSent, 1, "inside the 60-day window");
  assert.equal((await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 3600_000))).remindersSent, 0);
  assert.equal((await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 1.01 * 24 * 3600 * 1000))).remindersSent, 1, "repeats daily");
  assert.ok(a.lastExpiryReminderAt);
});

test("vendor AMC: create / list / edit / renew / history; only approved vendors; dates validated", async () => {
  const c = await call("mgmt", "POST", "/vendor-amcs", { vendorId: "v1", title: "Cooling", contractRef: "R1", startDate: "2026-02-01", durationMonths: 12 });
  assert.deepEqual([c.status, c.body.startDate, c.body.endDate], [201, "2026-02-01", "2027-01-31"]);
  assert.equal((await call("mgmt", "POST", "/vendor-amcs", { vendorId: "vp", title: "x", startDate: "2026-02-01" })).status, 400, "pending vendor");
  assert.equal((await call("mgmt", "POST", "/vendor-amcs", { vendorId: "ghost", title: "x", startDate: "2026-02-01" })).status, 400);
  assert.equal((await call("mgmt", "POST", "/vendor-amcs", { vendorId: "v1", title: "x", startDate: "2026-02-01", endDate: "2026-02-01" })).status, 400);
  assert.equal((await call("mgmt", "PATCH", `/vendor-amcs/${c.body.id}`, { endDate: "2027-03-01" })).status, 400, "reason required");
  assert.equal((await call("mgmt", "PATCH", `/vendor-amcs/${c.body.id}`, { title: "Cooling v2" })).body.title, "Cooling v2");
  const r = await call("mgmt", "POST", `/vendor-amcs/${c.body.id}/renew`, { expectedEndDate: "2027-01-31" });
  assert.deepEqual([r.status, r.body.newEndDate], [201, "2028-01-31"]);
  assert.equal((await call("mgmt", "POST", `/vendor-amcs/${c.body.id}/renew`, { expectedEndDate: "2027-01-31" })).status, 409);
  const h = await call("mgmt", "GET", `/vendor-amcs/${c.body.id}/renewals`);
  assert.deepEqual([h.body.length, h.body[0].kind], [1, "renewal"]);
  assert.equal(amcOrders.length, 0, "customer AMC untouched");
});

test("vendor AMC access: a vendor user sees only its own vendor's contracts (404, not 403, for others); all writes are staff-only", async () => {
  const own = seedVendorAmc({ vendorId: "v1" });
  const other = seedVendorAmc({ vendorId: "v2" });
  const list = await call("vend1", "GET", "/vendor-amcs");
  assert.deepEqual(list.body.contracts.map((x: any) => x.id), [own.id]);
  assert.equal(list.body.canManage, false);
  assert.equal((await call("vend1", "GET", `/vendor-amcs/${other.id}`)).status, 404);
  assert.equal((await call("vend1", "GET", `/vendor-amcs/${other.id}/renewals`)).status, 404);
  assert.equal((await call("vend1", "GET", `/vendor-amcs/${own.id}`)).status, 200);
  assert.equal((await call("mgmt", "GET", "/vendor-amcs")).body.contracts.length, 2);
  for (const who of ["vend1", "custA", "sales"]) {
    assert.equal((await call(who, "POST", "/vendor-amcs", { vendorId: "v1", title: "x", startDate: "2026-02-01" })).status, 403, who);
    assert.equal((await call(who, "PATCH", `/vendor-amcs/${own.id}`, { title: "x" })).status, 403);
    assert.equal((await call(who, "POST", `/vendor-amcs/${own.id}/renew`, { expectedEndDate: "2026-12-31" })).status, 403);
    assert.equal((await call(who, "PATCH", `/vendor-amcs/${own.id}/clear-reminder`)).status, 403);
  }
  for (const who of ["custA", "sales"]) assert.equal((await call(who, "GET", "/vendor-amcs")).status, 403);
  assert.equal(vendorAmcs.length, 2);
  assert.equal(renewals.length, 0);
});

test("login-time alerts are scoped to what the caller may see and exclude acquired / healthy contracts", async () => {
  const aSoon = seedAmc({ id: "aSoon", customerId: "cA", startDate: day(-300), endDate: day(10) });
  const aExp = seedAmc({ id: "aExp", customerId: "cA", startDate: day(-500), endDate: day(-5) });
  seedAmc({ id: "aFine", customerId: "cA", startDate: day(-10), endDate: day(300) });
  seedAmc({ id: "aAcq", customerId: "cA", startDate: day(-300), endDate: day(5), expiryReminderClearedAt: new Date() });
  const bSoon = seedAmc({ id: "bSoon", customerId: "cB", startDate: day(-300), endDate: day(7) });
  const v1 = seedVendorAmc({ id: "v1soon", vendorId: "v1", startDate: day(-300), endDate: day(12) });
  const v2 = seedVendorAmc({ id: "v2exp", vendorId: "v2", startDate: day(-400), endDate: day(-2) });
  const ids = async (who: string) => (await call(who, "GET", "/amc-alerts")).body.alerts.map((a: any) => a.id).sort();
  assert.deepEqual(await ids("mgmt"), [aSoon.id, aExp.id, bSoon.id, v1.id, v2.id].sort());
  assert.deepEqual(await ids("custA"), [aSoon.id, aExp.id].sort());
  assert.deepEqual(await ids("custB"), [bSoon.id]);
  assert.deepEqual(await ids("vend1"), [v1.id]);
  assert.deepEqual(await ids("vend2"), [v2.id]);
  assert.deepEqual(await ids("sales"), []);
  assert.equal((await call(null, "GET", "/amc-alerts")).status, 401);
  const a = (await call("mgmt", "GET", "/amc-alerts")).body.alerts.find((x: any) => x.id === aExp.id);
  assert.deepEqual([a.status, a.daysRemaining, a.kind, a.key], ["expired", -5, "customer", `customer:aExp:${iso(day(-5))}:expired`]);
});

test("alert keys change with the end date and status, so a dismissed notice reappears only for a new situation", async () => {
  const a = seedAmc({ id: "k", startDate: day(-300), endDate: day(10) });
  const first = (await call("mgmt", "GET", "/amc-alerts")).body.alerts[0].key;
  assert.equal((await call("mgmt", "GET", "/amc-alerts")).body.alerts[0].key, first, "stable between logins");
  a.endDate = day(-1); // it expired
  assert.notEqual((await call("mgmt", "GET", "/amc-alerts")).body.alerts[0].key, first);
});

test("settings: only manage_settings may change the AMC values; validated; GET exposes them; null restores defaults", async () => {
  const ok = { amcDefaultDurationMonths: 18, amcReminderLeadDays: 45, amcReminderRepeatDays: 7 };
  for (const who of ["mgmt", "sales", "custA", "vend1"]) assert.equal((await call(who, "PUT", "/settings/amc", ok)).status, 403, who);
  assert.equal((await call(null, "PUT", "/settings/amc", ok)).status, 401);
  for (const bad of [{ ...ok, amcDefaultDurationMonths: 0 }, { ...ok, amcReminderLeadDays: 366 }, { ...ok, amcReminderRepeatDays: 0 }, { amcReminderLeadDays: 3 }, { ...ok, amcReminderLeadDays: "10" }]) {
    assert.equal((await call("admin", "PUT", "/settings/amc", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(settings, null, "refused requests changed nothing");
  assert.deepEqual((await call("admin", "PUT", "/settings/amc", ok)).body, ok);
  assert.deepEqual(await lib.loadAmcPolicy(), { durationMonths: 18, reminderLeadDays: 45, reminderRepeatDays: 7 });
  await call("admin", "PUT", "/settings/amc", { amcDefaultDurationMonths: null, amcReminderLeadDays: null, amcReminderRepeatDays: null });
  assert.deepEqual(await lib.loadAmcPolicy(), { durationMonths: 12, reminderLeadDays: 30, reminderRepeatDays: 3 });
});

// --- Requirement 7 (business definition): Vendor AMC = our agreement WITH a vendor, optionally tied to a customer and site --------------
test("vendor AMC records an optional customer and site, stored apart from customer AMC and returned with their names", async () => {
  const withSite = await call("mgmt", "POST", "/vendor-amcs", { vendorId: "v1", title: "Cooling support", customerId: "cA", siteId: "sA1", startDate: "2026-02-01", durationMonths: 12 });
  assert.equal(withSite.status, 201);
  assert.deepEqual([withSite.body.customer, withSite.body.site], [{ id: "cA", name: "Customer cA" }, { id: "sA1", companyName: "Site A" }]);
  assert.deepEqual([vendorAmcs[0].customerId, vendorAmcs[0].siteId], ["cA", "sA1"]);
  const general = await call("mgmt", "POST", "/vendor-amcs", { vendorId: "v1", title: "General", startDate: "2026-02-01", durationMonths: 12 });
  assert.deepEqual([general.status, general.body.customer, general.body.site], [201, null, null], "customer and site are optional");
  const customerOnly = await call("mgmt", "POST", "/vendor-amcs", { vendorId: "v2", title: "All of A", customerId: "cA", startDate: "2026-02-01", durationMonths: 6 });
  assert.deepEqual([customerOnly.status, customerOnly.body.site], [201, null]);
  assert.equal(amcOrders.length, 0, "no customer AMC order was created by vendor contracts");
  assert.equal(vendorAmcs.length, 3);
  const list = await call("mgmt", "GET", "/vendor-amcs");
  assert.deepEqual(list.body.contracts.map((c: any) => c.customer?.name ?? null).sort(), ["Customer cA", "Customer cA", null]);
});

test("vendor AMC: a site needs its customer, both must exist, and the site must belong to that customer - nothing is stored otherwise", async () => {
  const bad = (extra: Record<string, unknown>) => call("mgmt", "POST", "/vendor-amcs", { vendorId: "v1", title: "x", startDate: "2026-02-01", durationMonths: 12, ...extra });
  assert.equal((await bad({ siteId: "sA1" })).status, 400, "site without a customer");
  assert.equal((await bad({ customerId: "ghost" })).status, 400, "unknown customer");
  assert.equal((await bad({ customerId: "cA", siteId: "ghost" })).status, 400, "unknown site");
  const other = await bad({ customerId: "cA", siteId: "sB1" });
  assert.deepEqual([other.status, other.body.error], [400, "That site does not belong to the selected customer"]);
  assert.equal(vendorAmcs.length, 0);
});

test("vendor AMC: customer and site can be changed or cleared; changing the customer drops the old site; renewals keep the links", async () => {
  const c = await call("mgmt", "POST", "/vendor-amcs", { vendorId: "v1", title: "T", customerId: "cA", siteId: "sA1", startDate: "2026-02-01", durationMonths: 12 });
  const url = `/vendor-amcs/${c.body.id}`;
  const toB = await call("mgmt", "PATCH", url, { customerId: "cB" });
  assert.deepEqual([toB.status, toB.body.customer.id, toB.body.site], [200, "cB", null], "the old customer's site is dropped");
  assert.equal((await call("mgmt", "PATCH", url, { siteId: "sA1" })).status, 400, "a site of another customer is refused");
  assert.equal((await call("mgmt", "PATCH", url, { siteId: "sB1" })).body.site.id, "sB1");
  assert.equal((await call("mgmt", "PATCH", url, { siteId: null })).body.site, null, "the site can be cleared on its own");
  assert.equal((await call("mgmt", "PATCH", url, { customerId: null })).body.customer, null, "and so can the customer");
  assert.equal((await call("mgmt", "PATCH", url, { siteId: "sA1" })).status, 400, "a site without a customer is refused");
  await call("mgmt", "PATCH", url, { customerId: "cA", siteId: "sA1" });
  const before = renewals.length;
  const r = await call("mgmt", "POST", `${url}/renew`, { expectedEndDate: "2027-01-31" });
  assert.equal(r.status, 201);
  assert.equal(renewals.length, before + 1);
  const after = await call("mgmt", "GET", url);
  assert.deepEqual([after.body.customer.id, after.body.site.id, after.body.endDate], ["cA", "sA1", "2028-01-31"]);
  // only staff with the AMC permission may change the links
  for (const who of ["vend1", "custA", "sales"]) assert.equal((await call(who, "PATCH", url, { customerId: "cB" })).status, 403, who);
  assert.equal(vendorAmcs[0].customerId, "cA");
});

test("Customer AMC and Vendor AMC stay distinct kinds; the CAMC / NAMC class of a customer order is untouched", async () => {
  seedAmc({ id: "o1", amcType: "camc" });
  seedAmc({ id: "o2", amcType: "namc" });
  const vend = seedVendorAmc({ id: "v1c" });
  const orders = await call("mgmt", "GET", "/amc-orders");
  assert.deepEqual(orders.body.orders.map((o: any) => [o.id, o.amcType]).sort(), [["o1", "camc"], ["o2", "namc"]]);
  const contracts = (await call("mgmt", "GET", "/vendor-amcs")).body.contracts;
  assert.deepEqual(contracts.map((c: any) => c.id), [vend.id]);
  assert.ok(contracts.every((c: any) => !("amcType" in c)), "a vendor contract has no CAMC / NAMC class");
  assert.equal(lib.amcReminderData({ kind: "customer", ref: "P", endDate: D("2026-12-01"), daysRemaining: 5 }).amcTypeLabel, "Customer AMC");
  assert.equal(lib.amcReminderData({ kind: "vendor", ref: "P", endDate: D("2026-12-01"), daysRemaining: 5 }).amcTypeLabel, "Vendor AMC");
});

test("renewing a customer contract and a vendor contract changes only that contract and its own history", async () => {
  const a = seedAmc({ id: "oa", startDate: D("2026-01-01"), endDate: D("2026-12-31") });
  const v = seedVendorAmc({ id: "va", startDate: D("2026-03-01"), endDate: D("2027-02-28") });
  const v2 = seedVendorAmc({ id: "vb", vendorId: "v2", startDate: D("2026-03-01"), endDate: D("2027-02-28") });
  assert.equal((await call("mgmt", "POST", "/amc-orders/oa/renew", { expectedEndDate: "2026-12-31" })).status, 201);
  assert.deepEqual([iso(v.endDate), iso(v2.endDate), renewals.map((r) => r.vendorAmcId).filter(Boolean).length], ["2027-02-28", "2027-02-28", 0], "vendor contracts untouched");
  assert.equal((await call("mgmt", "POST", "/vendor-amcs/va/renew", { expectedEndDate: "2027-02-28" })).status, 201);
  assert.deepEqual([iso(v2.endDate), iso(a.endDate)], ["2027-02-28", "2027-12-31"], "the other vendor contract and the customer order are unchanged");
  assert.equal(renewals.filter((r) => r.amcOrderId === "oa").length, 1);
  assert.equal(renewals.filter((r) => r.vendorAmcId === "va").length, 1);
  assert.equal(renewals.filter((r) => r.vendorAmcId === "vb").length, 0);
  assert.equal((await call("mgmt", "GET", "/amc-orders/oa/renewals")).body.length, 1);
  assert.equal((await call("mgmt", "GET", "/vendor-amcs/va/renewals")).body.length, 1);
});

test("expiry reminders carry the AMC type, customer, site, vendor, expiry date, days remaining and where to act - for both kinds", async () => {
  const prevUrl = process.env.ADMIN_WEB_URL;
  process.env.ADMIN_WEB_URL = "https://tracker.example/";
  const { providersByChannel } = await import("../src/services/notifications/providers");
  const realEmail = providersByChannel.email;
  (providersByChannel as any).email = { channel: "email", send: async () => true }; // the provider accepts the e-mail, so the reminder counts as delivered
  try {
    recipients = [{ id: "mgmt" }];
    seedAmc({ id: "oc", poNo: "PO-77", amcType: "namc", location: "Plant 1, Pune", startDate: day(-335), endDate: day(10) });
    seedVendorAmc({ id: "vc", vendorId: "v1", title: "Cooling support", contractRef: "VR-9", customerId: "cA", siteId: "sA1", startDate: day(-340), endDate: day(12) });
    seedVendorAmc({ id: "vg", vendorId: "v2", title: "General support", startDate: day(-340), endDate: day(20) });
    const NOW = new Date();
    const out = await lib.runAmcExpiryReminders(NOW);
    assert.deepEqual([out.remindersSent, out.vendorRemindersSent], [1, 2]);
    const inApp = () => notificationLog.filter((n) => n.templateKey === "amc_expiry_reminder" && n.channel === "in_app").map((n) => n.payload);
    const notices = inApp();
    assert.equal(notices.length, 3);
    const byRef = (ref: string) => notices.find((p) => p.ref === ref);
    const cust = byRef("PO-77");
    assert.deepEqual(
      [cust.kind, cust.amcTypeLabel, cust.amcType, cust.customerName, cust.siteName, cust.vendorName, cust.daysRemaining, cust.expiryDate.slice(0, 10), cust.actionPath, cust.actionUrl],
      ["customer", "Customer AMC", "namc", "Customer cA", "Plant 1, Pune", null, 10, iso(day(10)), "/amc-orders", "https://tracker.example/amc-orders"],
    );
    const vend = byRef("VR-9");
    assert.deepEqual(
      [vend.kind, vend.amcTypeLabel, vend.customerName, vend.siteName, vend.vendorName, vend.daysRemaining, vend.expiryDate.slice(0, 10), vend.actionUrl],
      ["vendor", "Vendor AMC", "Customer cA", "Site A", "Vendor v1", 12, iso(day(12)), "https://tracker.example/vendor-amcs"],
    );
    const general = byRef("General support");
    assert.deepEqual([general.customerName, general.siteName, general.vendorName], [null, null, "Vendor v2"], "a general vendor contract shows no customer / site, and the vendor is never put in the customer field");

    // what the recipient reads
    const { renderEmail } = await import("../src/services/notifications/emailTemplates");
    const text = (p: any) => (renderEmail("amc_expiry_reminder", p) as any).text as string;
    assert.match(text(vend), /AMC type: Vendor AMC/);
    assert.match(text(vend), /Customer: Customer cA/);
    assert.match(text(vend), /Site: Site A/);
    assert.match(text(vend), /Vendor: Vendor v1/);
    assert.match(text(vend), /Expiry date: /);
    assert.match(text(vend), /Remaining: 12 days/);
    assert.match(text(vend), /https:\/\/tracker\.example\/vendor-amcs/);
    assert.match(text(cust), /AMC type: Customer AMC \(NAMC\)/);
    assert.match(text(cust), /Site: Plant 1, Pune/);
    assert.doesNotMatch(text(general), /Customer:|Site:/);
    assert.match(text({ ...cust, daysRemaining: 0 }), /Remaining: expires today/);
    assert.match(text({ ...cust, daysRemaining: -3 }), /Remaining: expired 3 days ago/);

    // running the job again straight away sends nothing more (the reminder was stamped before it was sent)
    const again = await lib.runAmcExpiryReminders(NOW);
    assert.deepEqual([again.remindersSent, again.vendorRemindersSent], [0, 0]);
    assert.equal(inApp().length, 3, "no duplicate notices");
  } finally {
    (providersByChannel as any).email = realEmail;
    if (prevUrl === undefined) delete process.env.ADMIN_WEB_URL; else process.env.ADMIN_WEB_URL = prevUrl;
  }
});

test("login-time alerts name the customer and site; a renewed contract and an acquired contract do not alert", async () => {
  seedVendorAmc({ id: "va1", vendorId: "v1", title: "Support", customerId: "cA", siteId: "sA1", startDate: day(-340), endDate: day(10) });
  seedVendorAmc({ id: "va2", vendorId: "v1", title: "Acquired", customerId: "cA", startDate: day(-340), endDate: day(10), expiryReminderClearedAt: new Date() });
  seedAmc({ id: "oc1", poNo: "PO-5", location: "North plant", startDate: day(-335), endDate: day(5) });
  const alerts = (await call("mgmt", "GET", "/amc-alerts")).body.alerts;
  const vendor = alerts.find((a: any) => a.kind === "vendor");
  assert.deepEqual([vendor.partyName, vendor.customerName, vendor.siteName], ["Vendor v1", "Customer cA", "Site A"]);
  const customer = alerts.find((a: any) => a.kind === "customer");
  assert.deepEqual([customer.partyName, customer.customerName, customer.siteName], ["Customer cA", "Customer cA", "North plant"]);
  assert.equal(alerts.length, 2, "the acquired contract is not listed");
  await call("mgmt", "POST", "/vendor-amcs/va1/renew", { expectedEndDate: iso(day(10)) });
  assert.equal((await call("mgmt", "GET", "/amc-alerts")).body.alerts.filter((a: any) => a.kind === "vendor").length, 0, "renewed: no longer expiring");
});

test("a reminder nobody accepted is NOT lost: the claim is given back and the next run retries at once; once an e-mail is accepted it is stamped and not repeated before the interval", async () => {
  const { providersByChannel } = await import("../src/services/notifications/providers");
  const realEmail = providersByChannel.email;
  try {
    recipients = [{ id: "mgmt" }];
    const due = seedAmc({ id: "due", startDate: day(-335), endDate: day(30) });
    const v = seedVendorAmc({ id: "v", startDate: day(-340), endDate: day(25) });
    (providersByChannel as any).email = { channel: "email", send: async () => false }; // SMTP down
    const NOW = new Date();
    const r1 = await lib.runAmcExpiryReminders(NOW);
    assert.deepEqual([r1.remindersSent, r1.vendorRemindersSent], [0, 0], "nothing was delivered, nothing is counted");
    assert.deepEqual([due.lastExpiryReminderAt, v.lastExpiryReminderAt], [null, null], "the claims were given back");
    (providersByChannel as any).email = { channel: "email", send: async () => true };
    const r2 = await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 60_000)); // one minute later, not 3 days
    assert.deepEqual([r2.remindersSent, r2.vendorRemindersSent], [1, 1]);
    assert.ok(due.lastExpiryReminderAt && v.lastExpiryReminderAt);
    const r3 = await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 2 * 60_000));
    assert.deepEqual([r3.remindersSent, r3.vendorRemindersSent], [0, 0], "delivered once, not repeated before the interval");
  } finally {
    (providersByChannel as any).email = realEmail;
  }
});
