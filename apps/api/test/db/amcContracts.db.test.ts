/**
 * Real-database tests for AMC dates, vendor AMC and renewals (Requirement 7): the migration's CHECK constraints and unique
 * indexes, the legacy backfill (the migration's own UPDATE statement, run on legacy-shaped rows), transactional renewal
 * (rollback, double submit, concurrent renewals), the date-correction history, scoped access through the real routers, the
 * login-time alerts and the scheduled reminder timing.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker
 * database (localhost:5434/platino_test). They only touch rows they create (unique run prefix; removed in `after`). The
 * company-settings singleton is changed for the run and restored. Every notification channel is replaced by a stub that records
 * the message, so nothing is sent anywhere. Run with: npm run test:db --workspace=apps/api (database migrated through
 * 20261026090000_vendor_amc_customer_site).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
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
describe("AMC dates, vendor AMC and renewals against the real test database", { skip }, () => {
  const PREFIX = `ZR${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), amcIds: new Set<string>(), vendorIds: new Set<string>(), vendorAmcIds: new Set<string>(), orderIds: new Set<string>(), siteIds: new Set<string>(), unitIds: new Set<string>() };
  const realConsole = { log: console.log, error: console.error };
  const day = (n: number, from = new Date()) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + n)).toISOString().slice(0, 10);
  let seq = 0;

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let lib: any;
  let providers: any;
  const realProviders: Record<string, any> = {};
  const sent: any[] = [];
  let savedSettings: any = null;
  const roleIds: Record<string, string> = {};
  const world: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }
  async function makeCustomer(tag: string) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    tracked.customerIds.add(customer.id);
    return customer;
  }
  async function makeVendor(tag: string, status = "approved") {
    const vendor = await prisma.vendor.create({ data: { name: `${PREFIX} ${tag}`, status, contactName: "Synthetic Contact", contactEmail: `${PREFIX.toLowerCase()}-${tag}@example.invalid` } });
    tracked.vendorIds.add(vendor.id);
    return vendor;
  }
  /** A customer AMC row created directly (like older code did: optionally with NO explicit dates). */
  async function makeAmc(customerId: string, over: Record<string, unknown> = {}) {
    const amc = await prisma.amcOrder.create({
      data: { poNo: `${PREFIX}-PO${++seq}`, poDate: new Date("2026-04-01"), customerId, location: "Synthetic city", item: "RECD", qty: 1, amcFrequencyPerYear: 4, amcType: "camc", ...over },
    });
    tracked.amcIds.add(amc.id);
    return amc;
  }
  async function makeVendorAmc(vendorId: string, startDate: string, endDate: string, title = `${PREFIX} V${++seq}`) {
    const v = await prisma.vendorAmc.create({ data: { vendorId, title, startDate: new Date(startDate), endDate: new Date(endDate) } });
    tracked.vendorAmcIds.add(v.id);
    return v;
  }

  const tokenOf = (user: any) => signToken({ userId: user.id, roleKey: "x", customerId: user.customerId ?? null });
  async function call(as: any, method: string, p: string, body?: unknown) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  }
  const sentFor = (needle: string) => sent.filter((m) => JSON.stringify(m).includes(needle));
  const historyOf = (where: Record<string, unknown>) => prisma.amcRenewal.findMany({ where, orderBy: { createdAt: "asc" } });
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    lib = await import("../../src/lib/amcContracts");
    ({ providersByChannel: providers } = await import("../../src/services/notifications/providers"));
    for (const k of Object.keys(providers)) {
      realProviders[k] = providers[k];
      providers[k] = { channel: k, send: async (m: any) => { sent.push({ channel: k, ...m }); return true; } };
    }
    savedSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

    const { amcOrdersRouter } = await import("../../src/routes/amcOrders");
    const { vendorAmcsRouter } = await import("../../src/routes/vendorAmcs");
    const { amcAlertsRouter } = await import("../../src/routes/amcAlerts");
    const { settingsRouter } = await import("../../src/routes/settings");
    const app = express();
    app.use(express.json());
    app.use("/amc-orders", amcOrdersRouter);
    app.use("/vendor-amcs", vendorAmcsRouter);
    app.use("/amc-alerts", amcAlertsRouter);
    app.use("/settings", settingsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const key of ["customer", "service_engineer", "management", "sales", "super_admin", "erection_engineer"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    world.A = await makeCustomer("A");
    world.B = await makeCustomer("B");
    world.V1 = await makeVendor("V1");
    world.V2 = await makeVendor("V2");
    world.mgmt = await makeUser("manager", "management");
    world.admin = await makeUser("admin", "super_admin");
    world.eng = await makeUser("engineer", "service_engineer");
    world.sales = await makeUser("sales", "sales");
    world.custA = await makeUser("custA", "customer", { customerId: world.A.id });
    world.custB = await makeUser("custB", "customer", { customerId: world.B.id });
    world.vend1 = await makeUser("vendor1", "erection_engineer", { vendorId: world.V1.id });
    world.vend2 = await makeUser("vendor2", "erection_engineer", { vendorId: world.V2.id });
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        const amcIds = [...tracked.amcIds];
        const vIds = [...tracked.vendorAmcIds];
        await prisma.amcRenewal.deleteMany({ where: { OR: [{ amcOrderId: { in: amcIds } }, { vendorAmcId: { in: vIds } }] } });
        await prisma.amcOrder.deleteMany({ where: { id: { in: amcIds } } });
        await prisma.vendorAmc.deleteMany({ where: { id: { in: vIds } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { id: { in: [...tracked.siteIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
        await prisma.vendor.deleteMany({ where: { id: { in: [...tracked.vendorIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
        const keep = savedSettings ?? { amcDefaultDurationMonths: null, amcReminderLeadDays: null, amcReminderRepeatDays: null };
        await prisma.companySettings.updateMany({ where: { id: "singleton" }, data: { amcDefaultDurationMonths: keep.amcDefaultDurationMonths, amcReminderLeadDays: keep.amcReminderLeadDays, amcReminderRepeatDays: keep.amcReminderRepeatDays } });
      }
    } finally {
      for (const k of Object.keys(realProviders)) providers[k] = realProviders[k];
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  const resetSettings = () => prisma.companySettings.upsert({ where: { id: "singleton" }, update: { amcDefaultDurationMonths: null, amcReminderLeadDays: null, amcReminderRepeatDays: null }, create: { id: "singleton" } });

  // ------------------------------------------------------------------------------------------
  // The migration's guarantees
  // ------------------------------------------------------------------------------------------

  test("migration objects exist: columns, tables, CHECK constraints, both partial unique indexes, RLS", async () => {
    const cols = await prisma.$queryRaw`select column_name, is_nullable from information_schema.columns where table_name = 'AmcOrder' and column_name in ('startDate','endDate','datesSource')`;
    assert.deepEqual(cols.map((c: any) => c.column_name).sort(), ["datesSource", "endDate", "startDate"]);
    assert.equal(cols.find((c: any) => c.column_name === "startDate").is_nullable, "YES", "additive: legacy rows may have no explicit dates");
    const checks = (await prisma.$queryRaw`select conname from pg_constraint where contype = 'c' and conname in ('AmcOrder_period_check','AmcOrder_dates_source_check','VendorAmc_period_check','AmcRenewal_kind_check','AmcRenewal_parent_check','AmcRenewal_periods_check','AmcRenewal_renewal_order_check','CompanySettings_amc_settings_check')`).map((r: any) => r.conname);
    assert.equal(checks.length, 8, checks.join(","));
    const idx = (await prisma.$queryRaw`select indexname from pg_indexes where indexname in ('AmcRenewal_one_renewal_per_period_order','AmcRenewal_one_renewal_per_period_vendor')`).map((r: any) => r.indexname);
    assert.equal(idx.length, 2);
    const rls = await prisma.$queryRaw`select relname, relrowsecurity from pg_class where relname in ('VendorAmc','AmcRenewal')`;
    assert.ok(rls.every((r: any) => r.relrowsecurity), "RLS is enabled on both new tables");
  });

  test("constraints: an end date on or before the start is refused for customer and vendor contracts", async () => {
    await assert.rejects(makeAmc(world.A.id, { startDate: new Date("2026-05-01"), endDate: new Date("2026-05-01") }), /AmcOrder_period_check|violates check/i);
    await assert.rejects(makeAmc(world.A.id, { startDate: new Date("2026-05-01"), endDate: new Date("2026-04-01") }), /AmcOrder_period_check|violates check/i);
    await assert.rejects(makeVendorAmc(world.V1.id, "2026-05-01", "2026-05-01"), /VendorAmc_period_check|violates check/i);
    await assert.rejects(makeAmc(world.A.id, { startDate: new Date("2026-05-01") }), /AmcOrder_period_check|violates check/i, "one date without the other");
    await assert.rejects(makeAmc(world.A.id, { datesSource: "bogus" }), /dates_source|violates check/i);
  });

  test("history constraints: exactly one parent, a valid kind, and no second renewal for the same period", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") });
    const vamc = await makeVendorAmc(world.V1.id, "2026-01-01", "2026-12-31");
    const row = { previousStartDate: new Date("2026-01-01"), previousEndDate: new Date("2026-12-31"), newStartDate: new Date("2027-01-01"), newEndDate: new Date("2027-12-31") };
    await assert.rejects(prisma.amcRenewal.create({ data: { ...row } }), /parent_check|violates check/i, "no parent");
    await assert.rejects(prisma.amcRenewal.create({ data: { ...row, amcOrderId: amc.id, vendorAmcId: vamc.id } }), /parent_check|violates check/i, "two parents");
    await assert.rejects(prisma.amcRenewal.create({ data: { ...row, amcOrderId: amc.id, kind: "other" } }), /kind_check|violates check/i);
    await assert.rejects(prisma.amcRenewal.create({ data: { ...row, amcOrderId: amc.id, newStartDate: new Date("2026-12-31") } }), /renewal_order_check|periods_check|violates check/i, "a renewal must start after the old end");
    await prisma.amcRenewal.create({ data: { ...row, amcOrderId: amc.id } });
    await assert.rejects(prisma.amcRenewal.create({ data: { ...row, amcOrderId: amc.id, newEndDate: new Date("2028-06-30") } }), /one_renewal_per_period|Unique constraint/i, "the same period cannot be renewed twice");
    await prisma.amcRenewal.create({ data: { ...row, amcOrderId: amc.id, kind: "correction", newStartDate: new Date("2026-02-01"), newEndDate: new Date("2027-01-31") } }); // corrections are not limited
    await prisma.amcRenewal.create({ data: { ...row, vendorAmcId: vamc.id } });
    await assert.rejects(prisma.amcRenewal.create({ data: { ...row, vendorAmcId: vamc.id } }), /one_renewal_per_period|Unique constraint/i);
  });

  test("history is never deleted with its contract (Restrict)", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") });
    await prisma.amcRenewal.create({ data: { amcOrderId: amc.id, previousStartDate: new Date("2026-01-01"), previousEndDate: new Date("2026-12-31"), newStartDate: new Date("2027-01-01"), newEndDate: new Date("2027-12-31") } });
    await assert.rejects(prisma.amcOrder.delete({ where: { id: amc.id } }), /foreign key|Foreign key|constraint/i);
  });

  // ------------------------------------------------------------------------------------------
  // The legacy backfill
  // ------------------------------------------------------------------------------------------

  test("backfill: the migration's own UPDATE gives legacy rows PO date .. PO date + 1 year, marks them legacy, and leaves explicit rows alone", async () => {
    const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261021090000_amc_contract_dates_renewals_vendor/migration.sql"), "utf8");
    const m = sql.match(/UPDATE "AmcOrder"[\s\S]*?WHERE "startDate" IS NULL AND "endDate" IS NULL;/);
    assert.ok(m, "the backfill statement is in the migration");
    const legacy1 = await makeAmc(world.A.id, { poDate: new Date("2025-03-15T00:00:00Z") });
    const legacy2 = await makeAmc(world.A.id, { poDate: new Date("2024-02-29T00:00:00Z") });
    const legacy3 = await makeAmc(world.A.id, { poDate: new Date("2026-06-30T23:30:00Z") });
    const explicit = await makeAmc(world.A.id, { poDate: new Date("2025-01-01"), startDate: new Date("2025-02-01"), endDate: new Date("2026-01-31"), datesSource: "explicit" });
    const scoped = m![0].replace(/;\s*$/, ` AND "poNo" LIKE '${PREFIX}%';`); // only this run's rows
    await prisma.$executeRawUnsafe(scoped);
    const rows = Object.fromEntries((await prisma.amcOrder.findMany({ where: { id: { in: [legacy1.id, legacy2.id, legacy3.id, explicit.id] } } })).map((r: any) => [r.id, r]));
    const shape = (r: any) => [dayOf(r.startDate), dayOf(r.endDate), r.datesSource];
    assert.deepEqual(shape(rows[legacy1.id]), ["2025-03-15", "2026-03-15", "legacy_po_date"]);
    assert.deepEqual(shape(rows[legacy2.id]), ["2024-02-29", "2025-02-28", "legacy_po_date"], "Feb 29 + 1 year = Feb 28, as the shared TypeScript rule does");
    assert.deepEqual(shape(rows[legacy3.id]), ["2026-06-30", "2027-06-30", "legacy_po_date"]);
    assert.deepEqual(shape(rows[explicit.id]), ["2025-02-01", "2026-01-31", "explicit"]);
    const { legacyExpiryDate, isoDay } = await import("@recd/shared");
    for (const r of [rows[legacy1.id], rows[legacy2.id], rows[legacy3.id]]) assert.equal(dayOf(r.endDate), isoDay(legacyExpiryDate(r.poDate)), "SQL and TypeScript agree");
    // the API presents a legacy row with the same dates (and says they were derived)
    const got = await call(world.mgmt, "GET", `/amc-orders/${legacy1.id}`);
    assert.deepEqual([got.status, got.body.startDate, got.body.endDate, got.body.datesSource], [200, "2025-03-15", "2026-03-15", "legacy_po_date"]);
    // a row that never ran the backfill (no explicit dates) falls back to the same rule instead of failing
    const unmigrated = await makeAmc(world.A.id, { poDate: new Date("2025-03-15T00:00:00Z") });
    const g2 = await call(world.mgmt, "GET", `/amc-orders/${unmigrated.id}`);
    assert.deepEqual([g2.body.startDate, g2.body.endDate, g2.body.datesSource], ["2025-03-15", "2026-03-15", "legacy_po_date"]);
  });

  // ------------------------------------------------------------------------------------------
  // Customer AMC through the real routes
  // ------------------------------------------------------------------------------------------

  const orderBody = (over: Record<string, unknown> = {}) => ({ poNo: `${PREFIX}-API${++seq}`, poDate: new Date("2026-05-10").toISOString(), customerId: world.A.id, location: "Synthetic city", item: "RECD", qty: 1, amcFrequencyPerYear: 4, amcType: "camc", unitIds: [], ...over });

  test("create: explicit dates, a duration, or neither (start = PO date, 12 months) - and bad input is refused", async () => {
    await resetSettings();
    const explicit = await call(world.mgmt, "POST", "/amc-orders", orderBody({ startDate: "2026-06-01", endDate: "2027-05-31" }));
    assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
    tracked.amcIds.add(explicit.body.id);
    assert.deepEqual([explicit.body.startDate, explicit.body.endDate, explicit.body.datesSource], ["2026-06-01", "2027-05-31", "explicit"]);

    const dur = await call(world.mgmt, "POST", "/amc-orders", orderBody({ startDate: "2026-06-01", durationMonths: 6 }));
    tracked.amcIds.add(dur.body.id);
    assert.deepEqual([dur.body.startDate, dur.body.endDate], ["2026-06-01", "2026-11-30"]);

    const plain = await call(world.mgmt, "POST", "/amc-orders", orderBody());
    tracked.amcIds.add(plain.body.id);
    assert.deepEqual([plain.status, plain.body.startDate, plain.body.endDate, plain.body.datesSource], [201, "2026-05-10", "2027-05-09", "explicit"], "an old client that sends no dates still works; the dates are stored explicitly");

    const before = await prisma.amcOrder.count({ where: { poNo: { startsWith: PREFIX } } });
    for (const bad of [{ startDate: "2026-06-01", endDate: "2026-06-01" }, { startDate: "2026-06-01", endDate: "2026-05-01" }, { endDate: "2026-06-01", durationMonths: 3 }, { startDate: "2026-02-30" }, { durationMonths: 0 }]) {
      const r = await call(world.mgmt, "POST", "/amc-orders", orderBody(bad));
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(await prisma.amcOrder.count({ where: { poNo: { startsWith: PREFIX } } }), before, "nothing was created by the refused requests");
  });

  test("the configured default duration applies to new contracts (and an empty setting keeps 12 months)", async () => {
    const put = await call(world.admin, "PUT", "/settings/amc", { amcDefaultDurationMonths: 24, amcReminderLeadDays: null, amcReminderRepeatDays: null });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const r = await call(world.mgmt, "POST", "/amc-orders", orderBody({ startDate: "2026-06-01" }));
    tracked.amcIds.add(r.body.id);
    assert.equal(r.body.endDate, "2028-05-31");
    await resetSettings();
    const r2 = await call(world.mgmt, "POST", "/amc-orders", orderBody({ startDate: "2026-06-01" }));
    tracked.amcIds.add(r2.body.id);
    assert.equal(r2.body.endDate, "2027-05-31");
  });

  test("status in the list follows the dates and the configured window", async () => {
    await resetSettings();
    const mk = async (start: string, end: string) => { const a = await makeAmc(world.A.id, { startDate: new Date(start), endDate: new Date(end), datesSource: "explicit" }); return a.id; };
    const ids = { upcoming: await mk(day(5), day(370)), active: await mk(day(-100), day(100)), soon: await mk(day(-300), day(20)), today: await mk(day(-300), day(0)), expired: await mk(day(-400), day(-1)) };
    const list = await call(world.mgmt, "GET", "/amc-orders");
    const by = (id: string) => list.body.orders.find((o: any) => o.id === id);
    assert.deepEqual([by(ids.upcoming).contractStatus, by(ids.active).contractStatus, by(ids.soon).contractStatus, by(ids.today).contractStatus, by(ids.expired).contractStatus], ["upcoming", "active", "expiring_soon", "expiring_soon", "expired"]);
    assert.equal(by(ids.soon).daysRemaining, 20);
    assert.equal(by(ids.expired).daysRemaining, -1);
    await call(world.admin, "PUT", "/settings/amc", { amcDefaultDurationMonths: null, amcReminderLeadDays: 120, amcReminderRepeatDays: null });
    const wide = await call(world.mgmt, "GET", "/amc-orders");
    assert.equal(wide.body.orders.find((o: any) => o.id === ids.active).contractStatus, "expiring_soon", "a wider window changes the status");
    await resetSettings();
  });

  test("renew: the old period goes to the history, the new one is current, who/when is recorded, reminder state resets", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), datesSource: "explicit", lastExpiryReminderAt: new Date("2026-12-01"), expiryReminderClearedAt: new Date("2026-12-02") });
    const r = await call(world.mgmt, "POST", `/amc-orders/${amc.id}/renew`, { expectedEndDate: "2026-12-31", note: "PO 5551" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.previousEndDate, r.body.newStartDate, r.body.newEndDate], ["2026-12-31", "2027-01-01", "2027-12-31"]);
    const fresh = await prisma.amcOrder.findUnique({ where: { id: amc.id } });
    assert.deepEqual([dayOf(fresh.startDate), dayOf(fresh.endDate), fresh.lastExpiryReminderAt, fresh.expiryReminderClearedAt], ["2027-01-01", "2027-12-31", null, null]);
    const h = await call(world.mgmt, "GET", `/amc-orders/${amc.id}/renewals`);
    assert.equal(h.body.length, 1);
    assert.deepEqual([h.body[0].kind, h.body[0].previousStartDate, h.body[0].previousEndDate, h.body[0].newStartDate, h.body[0].newEndDate, h.body[0].by, h.body[0].note], ["renewal", "2026-01-01", "2026-12-31", "2027-01-01", "2027-12-31", `${PREFIX} manager`, "PO 5551"]);
    // renewing again continues from the new end; the first entry is preserved
    const r2 = await call(world.mgmt, "POST", `/amc-orders/${amc.id}/renew`, { expectedEndDate: "2027-12-31", durationMonths: 6 });
    assert.equal(r2.status, 201);
    assert.equal(r2.body.newEndDate, "2028-06-30");
    assert.equal((await historyOf({ amcOrderId: amc.id })).length, 2);
    const list = await call(world.mgmt, "GET", "/amc-orders");
    assert.equal(list.body.orders.find((o: any) => o.id === amc.id).renewalCount, 2);
  });

  test("renewed in advance shows 'renewed' until the new period starts, then 'active'; counts and alerts follow", async () => {
    await resetSettings();
    const amc = await makeAmc(world.A.id, { startDate: new Date(day(-345)), endDate: new Date(day(20)), datesSource: "explicit" });
    assert.equal((await call(world.mgmt, "GET", `/amc-orders/${amc.id}`)).body.contractStatus, "expiring_soon");
    assert.equal((await call(world.mgmt, "POST", `/amc-orders/${amc.id}/renew`, { expectedEndDate: day(20) })).status, 201);
    const got = (await call(world.mgmt, "GET", `/amc-orders/${amc.id}`)).body;
    assert.deepEqual([got.contractStatus, got.startDate, got.renewalCount], ["renewed", day(21), 1]);
    const list = await call(world.mgmt, "GET", "/amc-orders");
    assert.equal(list.body.orders.find((o: any) => o.id === amc.id).contractStatus, "renewed");
    assert.ok(list.body.contractCounts.renewed >= 1);
    // a date correction after the renewal does not turn it back into something else
    const fix = await call(world.mgmt, "PATCH", `/amc-orders/${amc.id}`, { endDate: day(400), reason: "contract is 14 months" });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.contractStatus, "renewed");
    // vendor contracts too
    const v = await makeVendorAmc(world.V1.id, day(-345), day(15));
    assert.equal((await call(world.mgmt, "POST", `/vendor-amcs/${v.id}/renew`, { expectedEndDate: day(15) })).status, 201);
    assert.equal((await call(world.mgmt, "GET", `/vendor-amcs/${v.id}`)).body.contractStatus, "renewed");
  });

  test("renew validation: stale end date, overlap, bad dates and unknown ids are refused and change nothing", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), datesSource: "explicit" });
    const attempts: Array<[Record<string, unknown>, number]> = [
      [{ expectedEndDate: "2026-11-30" }, 409],
      [{ expectedEndDate: "2026-12-31", newStartDate: "2026-12-31" }, 400],
      [{ expectedEndDate: "2026-12-31", newStartDate: "2026-06-01" }, 400],
      [{ expectedEndDate: "2026-12-31", newStartDate: "2027-02-01", newEndDate: "2027-01-01" }, 400],
      [{ expectedEndDate: "2026-12-31", newEndDate: "2028-01-01", durationMonths: 3 }, 400],
      [{ expectedEndDate: "2026-12-32" }, 400],
      [{}, 400],
    ];
    for (const [body, status] of attempts) assert.equal((await call(world.mgmt, "POST", `/amc-orders/${amc.id}/renew`, body)).status, status, JSON.stringify(body));
    assert.equal((await call(world.mgmt, "POST", `/amc-orders/does-not-exist/renew`, { expectedEndDate: "2026-12-31" })).status, 404);
    const fresh = await prisma.amcOrder.findUnique({ where: { id: amc.id } });
    assert.equal(dayOf(fresh.endDate), "2026-12-31");
    assert.equal((await historyOf({ amcOrderId: amc.id })).length, 0, "no history from refused renewals");
  });

  test("renew is exactly-once: ten simultaneous submissions record one renewal; the rest get 409", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), datesSource: "explicit" });
    const results = await Promise.all(Array.from({ length: 10 }, () => call(world.mgmt, "POST", `/amc-orders/${amc.id}/renew`, { expectedEndDate: "2026-12-31" })));
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => ["STALE_PERIOD", "DUPLICATE_RENEWAL"].includes(r.body.code)));
    const fresh = await prisma.amcOrder.findUnique({ where: { id: amc.id } });
    assert.equal(dayOf(fresh.endDate), "2027-12-31", "renewed once, not ten times");
    assert.equal((await historyOf({ amcOrderId: amc.id })).length, 1);
  });

  test("renew is transactional: if the history row cannot be written, the contract dates are NOT changed", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), datesSource: "explicit" });
    await assert.rejects(lib.renewContract("customer", amc.id, { expectedEndDate: "2026-12-31" }, "no-such-user"), /foreign key|Foreign key/i);
    const fresh = await prisma.amcOrder.findUnique({ where: { id: amc.id } });
    assert.equal(dayOf(fresh.endDate), "2026-12-31", "rolled back");
    assert.equal((await historyOf({ amcOrderId: amc.id })).length, 0);
  });

  test("edit: plain details change directly; changing a date needs a reason and is recorded as a correction", async () => {
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), datesSource: "explicit" });
    const plain = await call(world.mgmt, "PATCH", `/amc-orders/${amc.id}`, { location: "New city", qty: 3 });
    assert.deepEqual([plain.status, plain.body.location, plain.body.qty], [200, "New city", 3]);
    assert.equal((await historyOf({ amcOrderId: amc.id })).length, 0, "no history for a plain edit");
    assert.equal((await call(world.mgmt, "PATCH", `/amc-orders/${amc.id}`, { endDate: "2027-01-31" })).status, 400, "reason required");
    assert.equal((await call(world.mgmt, "PATCH", `/amc-orders/${amc.id}`, { endDate: "2025-01-31", reason: "typo" })).status, 400, "end before start");
    assert.equal((await call(world.mgmt, "PATCH", `/amc-orders/${amc.id}`, {})).status, 400);
    const fix = await call(world.mgmt, "PATCH", `/amc-orders/${amc.id}`, { endDate: "2027-01-31", reason: "PO said Jan 2027" });
    assert.deepEqual([fix.status, fix.body.endDate], [200, "2027-01-31"]);
    const h = await historyOf({ amcOrderId: amc.id });
    assert.equal(h.length, 1);
    assert.deepEqual([h[0].kind, dayOf(h[0].previousEndDate), dayOf(h[0].newEndDate), h[0].note, h[0].renewedById], ["correction", "2026-12-31", "2027-01-31", "PO said Jan 2027", world.mgmt.id]);
    assert.equal((await call(world.mgmt, "PATCH", `/amc-orders/does-not-exist`, { location: "x" })).status, 404);
  });

  test("a legacy row can be given explicit dates: the correction keeps the derived period in the history", async () => {
    const legacy = await makeAmc(world.A.id, { poDate: new Date("2025-03-15T00:00:00Z") });
    const r = await call(world.mgmt, "PATCH", `/amc-orders/${legacy.id}`, { startDate: "2025-04-01", endDate: "2026-03-31", reason: "contract starts 1 April" });
    assert.deepEqual([r.status, r.body.datesSource, r.body.startDate, r.body.endDate], [200, "explicit", "2025-04-01", "2026-03-31"]);
    const h = await historyOf({ amcOrderId: legacy.id });
    assert.deepEqual([dayOf(h[0].previousStartDate), dayOf(h[0].previousEndDate)], ["2025-03-15", "2026-03-15"]);
  });

  // ------------------------------------------------------------------------------------------
  // Vendor AMC
  // ------------------------------------------------------------------------------------------

  test("vendor AMC: create / read / edit / renew / history, tied to an approved vendor, separate from customer AMC", async () => {
    const created = await call(world.mgmt, "POST", "/vendor-amcs", { vendorId: world.V1.id, title: `${PREFIX} Cooling AMC`, contractRef: "VR-1", startDate: "2026-02-01", durationMonths: 12 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    tracked.vendorAmcIds.add(created.body.id);
    assert.deepEqual([created.body.startDate, created.body.endDate, created.body.vendor.name], ["2026-02-01", "2027-01-31", `${PREFIX} V1`]);
    assert.equal((await call(world.mgmt, "POST", "/vendor-amcs", { vendorId: "nope", title: "x", startDate: "2026-02-01" })).status, 400);
    const pending = await makeVendor("Pending", "pending");
    assert.equal((await call(world.mgmt, "POST", "/vendor-amcs", { vendorId: pending.id, title: "x", startDate: "2026-02-01" })).status, 400, "only an approved vendor");
    assert.equal((await call(world.mgmt, "POST", "/vendor-amcs", { vendorId: world.V1.id, title: "x", startDate: "2026-02-01", endDate: "2026-01-01" })).status, 400);

    const edit = await call(world.mgmt, "PATCH", `/vendor-amcs/${created.body.id}`, { title: `${PREFIX} Cooling AMC v2` });
    assert.deepEqual([edit.status, edit.body.title], [200, `${PREFIX} Cooling AMC v2`]);
    const renewed = await call(world.mgmt, "POST", `/vendor-amcs/${created.body.id}/renew`, { expectedEndDate: "2027-01-31" });
    assert.deepEqual([renewed.status, renewed.body.newStartDate, renewed.body.newEndDate], [201, "2027-02-01", "2028-01-31"]);
    assert.equal((await call(world.mgmt, "POST", `/vendor-amcs/${created.body.id}/renew`, { expectedEndDate: "2027-01-31" })).status, 409, "double submit");
    const h = await call(world.mgmt, "GET", `/vendor-amcs/${created.body.id}/renewals`);
    assert.deepEqual([h.status, h.body.length, h.body[0].by], [200, 1, `${PREFIX} manager`]);
    const customerSide = await call(world.mgmt, "GET", "/amc-orders");
    assert.ok(!customerSide.body.orders.some((o: any) => o.id === created.body.id), "never mixed with customer AMC");
    assert.equal((await call(world.mgmt, "GET", `/amc-orders/${created.body.id}`)).status, 404);
  });

  test("access control: vendor users read only their own vendor's contracts; customers/engineers/sales get nothing; writes are staff-only", async () => {
    const own = await makeVendorAmc(world.V1.id, day(-100), day(100));
    const other = await makeVendorAmc(world.V2.id, day(-100), day(100));
    const mine = await call(world.vend1, "GET", "/vendor-amcs");
    assert.equal(mine.status, 200);
    assert.ok(mine.body.contracts.some((c: any) => c.id === own.id));
    assert.ok(!mine.body.contracts.some((c: any) => c.id === other.id), "another vendor's contract is not listed");
    assert.equal(mine.body.canManage, false);
    assert.equal((await call(world.vend1, "GET", `/vendor-amcs/${other.id}`)).status, 404, "no existence leak");
    assert.equal((await call(world.vend1, "GET", `/vendor-amcs/${other.id}/renewals`)).status, 404);
    assert.equal((await call(world.vend1, "GET", `/vendor-amcs/${own.id}`)).status, 200);
    for (const who of [world.vend1, world.custA, world.eng, world.sales]) {
      assert.equal((await call(who, "POST", "/vendor-amcs", { vendorId: world.V1.id, title: "x", startDate: "2026-02-01" })).status, 403, "create");
      assert.equal((await call(who, "PATCH", `/vendor-amcs/${own.id}`, { title: "hack" })).status, 403, "edit");
      assert.equal((await call(who, "POST", `/vendor-amcs/${own.id}/renew`, { expectedEndDate: day(100) })).status, 403, "renew");
      assert.equal((await call(who, "PATCH", `/vendor-amcs/${own.id}/clear-reminder`)).status, 403, "clear");
    }
    for (const who of [world.custA, world.eng, world.sales]) assert.equal((await call(who, "GET", "/vendor-amcs")).status, 403, "list");
    assert.equal((await call(null, "GET", "/vendor-amcs")).status, 401);
    assert.equal((await historyOf({ vendorAmcId: own.id })).length, 0);
    // customer AMC routes keep their permission
    const amc = await makeAmc(world.A.id, { startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), datesSource: "explicit" });
    for (const who of [world.custA, world.vend1, world.eng, world.sales]) {
      for (const [m, p, b] of [["GET", `/amc-orders/${amc.id}`], ["PATCH", `/amc-orders/${amc.id}`, { location: "x" }], ["POST", `/amc-orders/${amc.id}/renew`, { expectedEndDate: "2026-12-31" }], ["GET", `/amc-orders/${amc.id}/renewals`]] as any) {
        assert.equal((await call(who, m, p, b)).status, 403, `${m} ${p}`);
      }
    }
  });

  test("settings: only an authorised user can change them; values are validated; empty restores the defaults", async () => {
    await resetSettings();
    const ok = { amcDefaultDurationMonths: 18, amcReminderLeadDays: 45, amcReminderRepeatDays: 7 };
    for (const who of [world.mgmt, world.eng, world.sales, world.custA, world.vend1]) assert.equal((await call(who, "PUT", "/settings/amc", ok)).status, 403);
    assert.equal((await call(null, "PUT", "/settings/amc", ok)).status, 401);
    for (const bad of [{ ...ok, amcDefaultDurationMonths: 0 }, { ...ok, amcReminderLeadDays: -1 }, { ...ok, amcReminderRepeatDays: 0 }, { ...ok, amcReminderRepeatDays: 91 }, { ...ok, amcDefaultDurationMonths: 1.5 }, { amcDefaultDurationMonths: 12 }]) {
      assert.equal((await call(world.admin, "PUT", "/settings/amc", bad)).status, 400, JSON.stringify(bad));
    }
    const saved = await call(world.admin, "PUT", "/settings/amc", ok);
    assert.deepEqual([saved.status, saved.body], [200, ok]);
    const read = await call(world.mgmt, "GET", "/settings");
    assert.deepEqual([read.body.amcDefaultDurationMonths, read.body.amcReminderLeadDays, read.body.amcReminderRepeatDays], [18, 45, 7]);
    const cleared = await call(world.admin, "PUT", "/settings/amc", { amcDefaultDurationMonths: null, amcReminderLeadDays: null, amcReminderRepeatDays: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await lib.loadAmcPolicy()), { durationMonths: 12, reminderLeadDays: 30, reminderRepeatDays: 3 });
  });

  // ------------------------------------------------------------------------------------------
  // Login-time alerts
  // ------------------------------------------------------------------------------------------

  test("alerts: staff see customer + vendor contracts that are expiring soon or expired; others see only their own; none when nothing qualifies", async () => {
    await resetSettings();
    // fresh parties, so "only their own" can be asserted exactly
    const cA = await makeCustomer("alertA"); const cB = await makeCustomer("alertB");
    const uA = await makeUser("alertCustA", "customer", { customerId: cA.id }); const uB = await makeUser("alertCustB", "customer", { customerId: cB.id });
    const vA = await makeVendor("alertV1"); const vB = await makeVendor("alertV2");
    const wA = await makeUser("alertVend1", "erection_engineer", { vendorId: vA.id }); const wB = await makeUser("alertVend2", "erection_engineer", { vendorId: vB.id });
    const aSoon = await makeAmc(cA.id, { startDate: new Date(day(-300)), endDate: new Date(day(10)), datesSource: "explicit" });
    const aExpired = await makeAmc(cA.id, { startDate: new Date(day(-500)), endDate: new Date(day(-5)), datesSource: "explicit" });
    const aFine = await makeAmc(cA.id, { startDate: new Date(day(-10)), endDate: new Date(day(300)), datesSource: "explicit" });
    const aAcquired = await makeAmc(cA.id, { startDate: new Date(day(-300)), endDate: new Date(day(5)), datesSource: "explicit", expiryReminderClearedAt: new Date() });
    const bSoon = await makeAmc(cB.id, { startDate: new Date(day(-300)), endDate: new Date(day(7)), datesSource: "explicit" });
    const v1Soon = await makeVendorAmc(vA.id, day(-300), day(12));
    const v2Expired = await makeVendorAmc(vB.id, day(-500), day(-2));
    Object.assign(world, { custA: uA, custB: uB, vend1: wA, vend2: wB });

    const ids = (r: any) => r.body.alerts.map((a: any) => a.id);
    const staff = await call(world.mgmt, "GET", "/amc-alerts");
    assert.equal(staff.status, 200);
    for (const id of [aSoon.id, aExpired.id, bSoon.id, v1Soon.id, v2Expired.id]) assert.ok(ids(staff).includes(id), id);
    for (const id of [aFine.id, aAcquired.id]) assert.ok(!ids(staff).includes(id), "not alerting: " + id);
    assert.deepEqual(staff.body.alerts.find((a: any) => a.id === aExpired.id).status, "expired");
    assert.deepEqual(staff.body.alerts.find((a: any) => a.id === aSoon.id).daysRemaining, 10);

    const ca = await call(world.custA, "GET", "/amc-alerts");
    assert.deepEqual(ids(ca).sort(), [aSoon.id, aExpired.id].sort(), "a customer sees only its own contracts");
    const cb = await call(world.custB, "GET", "/amc-alerts");
    assert.deepEqual(ids(cb), [bSoon.id]);
    const va = await call(world.vend1, "GET", "/amc-alerts");
    assert.deepEqual(ids(va), [v1Soon.id], "a vendor sees only its own vendor contracts, no customer contracts");
    assert.deepEqual(ids(await call(world.vend2, "GET", "/amc-alerts")), [v2Expired.id]);
    assert.deepEqual((await call(world.eng, "GET", "/amc-alerts")).body.alerts, [], "a user with no AMC access sees nothing");
    assert.deepEqual((await call(world.sales, "GET", "/amc-alerts")).body.alerts, []);
    assert.equal((await call(null, "GET", "/amc-alerts")).status, 401);

    // a renewal changes the key (so a dismissed notice shows again for the new situation) and removes the alert
    const keyBefore = staff.body.alerts.find((a: any) => a.id === aSoon.id).key;
    assert.equal((await call(world.mgmt, "POST", `/amc-orders/${aSoon.id}/renew`, { expectedEndDate: day(10) })).status, 201);
    const after = await call(world.mgmt, "GET", "/amc-alerts");
    assert.ok(!ids(after).includes(aSoon.id), "renewed: no longer expiring");
    // "expiring soon" -> "expired" is a new key
    assert.notEqual(keyBefore, `customer:${aSoon.id}:${day(10)}:expired`);
    // the configured window controls what alerts
    await call(world.admin, "PUT", "/settings/amc", { amcDefaultDurationMonths: null, amcReminderLeadDays: 350, amcReminderRepeatDays: null });
    assert.ok(ids(await call(uA, "GET", "/amc-alerts")).includes(aFine.id), "a 350-day window includes it");
    await resetSettings();
  });

  test("alerts are capped and say so", async () => {
    const now = new Date();
    const out = await lib.buildAmcAlerts({ permissions: new Set(["manage_amc_orders"]) }, now);
    assert.ok(out.alerts.length <= 50);
    assert.equal(typeof out.truncated, "boolean");
  });

  // ------------------------------------------------------------------------------------------
  // Scheduled reminders (default timing preserved, configurable, no duplicates)
  // ------------------------------------------------------------------------------------------

  test("reminders: not before the window, once at the start, not again within 3 days, again after 3 days, never after 'AMC Acquired'; renewal resets", async () => {
    await resetSettings();
    sent.length = 0;
    const NOW = new Date();
    const mk = async (endIn: number, over: Record<string, unknown> = {}) => makeAmc(world.A.id, { startDate: new Date(day(endIn - 365)), endDate: new Date(day(endIn)), datesSource: "explicit", ...over });
    const early = await mk(31);
    const due = await mk(30);
    const overdue = await mk(-3);
    const acquired = await mk(5, { expiryReminderClearedAt: new Date() });
    const vendor = await makeVendorAmc(world.V1.id, day(-335), day(20));

    const r1 = await lib.runAmcExpiryReminders(NOW);
    assert.ok(r1.remindersSent >= 3 && r1.vendorRemindersSent >= 1);
    const stamped = async (id: string) => (await prisma.amcOrder.findUnique({ where: { id } })).lastExpiryReminderAt;
    assert.equal(await stamped(early.id), null, "31 days out: too early");
    assert.ok(await stamped(due.id), "30 days out: first reminder");
    assert.ok(await stamped(overdue.id), "already expired and not acquired: still reminded");
    assert.equal(await stamped(acquired.id), null, "acquired: never");
    assert.ok((await prisma.vendorAmc.findUnique({ where: { id: vendor.id } })).lastExpiryReminderAt);
    const firstCount = sentFor(due.poNo).length;
    assert.ok(firstCount > 0, "the reminder was handed to the (stub) channels");
    assert.ok(sentFor(due.poNo).some((m) => m.templateKey === "amc_expiry_reminder"));

    await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 60 * 60 * 1000));
    assert.equal(sentFor(due.poNo).length, firstCount, "an hour later: nothing repeats");
    await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 2.9 * 24 * 3600 * 1000));
    assert.equal(sentFor(due.poNo).length, firstCount, "2.9 days later: still not");
    await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 3.1 * 24 * 3600 * 1000));
    assert.equal(sentFor(due.poNo).length, firstCount * 2, "after 3 days: sent again");

    // renewing resets the reminder state for the new period
    assert.equal((await call(world.mgmt, "POST", `/amc-orders/${due.id}/renew`, { expectedEndDate: day(30) })).status, 201);
    assert.equal(await stamped(due.id), null);
  });

  test("reminders: overlapping scheduler runs send each reminder once", async () => {
    await resetSettings();
    sent.length = 0;
    const amc = await makeAmc(world.A.id, { startDate: new Date(day(-340)), endDate: new Date(day(25)), datesSource: "explicit" });
    const NOW = new Date();
    await Promise.all([lib.runAmcExpiryReminders(NOW), lib.runAmcExpiryReminders(NOW), lib.runAmcExpiryReminders(NOW), lib.runAmcExpiryReminders(NOW)]);
    const perRecipient = new Map<string, number>();
    for (const m of sentFor(amc.poNo).filter((x) => x.channel === "email")) perRecipient.set(m.recipientId, (perRecipient.get(m.recipientId) ?? 0) + 1);
    assert.ok(perRecipient.size > 0);
    assert.ok([...perRecipient.values()].every((n) => n === 1), "one e-mail per recipient despite four overlapping runs");
  });

  test("reminders: the lead time and repeat interval come from the settings", async () => {
    sent.length = 0;
    await call(world.admin, "PUT", "/settings/amc", { amcDefaultDurationMonths: null, amcReminderLeadDays: 60, amcReminderRepeatDays: 1 });
    const amc = await makeAmc(world.A.id, { startDate: new Date(day(-300)), endDate: new Date(day(50)), datesSource: "explicit" });
    const NOW = new Date();
    await lib.runAmcExpiryReminders(NOW);
    const n1 = sentFor(amc.poNo).length;
    assert.ok(n1 > 0, "50 days out is inside a 60-day window (it would be too early with the default 30)");
    await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 1.1 * 24 * 3600 * 1000));
    assert.equal(sentFor(amc.poNo).length, n1 * 2, "repeats after 1 day");
    await resetSettings();
  });

  test("the cron route still demands the shared secret (and sends nothing without it)", async () => {
    const { amcOrdersRouter } = await import("../../src/routes/amcOrders");
    assert.ok(amcOrdersRouter);
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-secret";
    try {
      sent.length = 0;
      assert.equal((await call(null, "GET", "/amc-orders/send-expiry-reminders")).status, 401);
      const bad = await fetch(`${base}/amc-orders/send-expiry-reminders`, { headers: { authorization: "Bearer wrong" } });
      assert.equal(bad.status, 401);
      assert.equal(sent.length, 0);
      const good = await fetch(`${base}/amc-orders/send-expiry-reminders`, { headers: { authorization: "Bearer cron-test-secret" } });
      assert.equal(good.status, 200);
      assert.equal((await good.json()).ok, true);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
  });

  // ------------------------------------------------------------------------------------------
  // Vendor AMC: the customer and site it applies to (migration 20261026090000_vendor_amc_customer_site)
  // ------------------------------------------------------------------------------------------
  /** An order with its site (a site is only ever created through an order), for `customerId`. */
  async function makeSite(customerId: string, tag: string, companyName: string | null = `${PREFIX} ${tag} Plant`) {
    const stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    const productId = (await prisma.product.findFirstOrThrow()).id;
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId, productId, quantity: 1, site: { create: { currentStageId: stageId, companyName } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    tracked.siteIds.add(order.site.id);
    return { order, site: order.site };
  }

  test("vendor AMC customer / site: nullable columns with real foreign keys (SET NULL) and indexes, from the migration", async () => {
    const cols = await prisma.$queryRaw`select column_name, is_nullable from information_schema.columns where table_name = 'VendorAmc' and column_name in ('customerId','siteId') order by column_name`;
    assert.deepEqual(cols.map((c: any) => [c.column_name, c.is_nullable]), [["customerId", "YES"], ["siteId", "YES"]]);
    const fks = await prisma.$queryRaw`select conname, confdeltype::text as del from pg_constraint where conname in ('VendorAmc_customerId_fkey','VendorAmc_siteId_fkey') order by conname`;
    assert.deepEqual(fks.map((f: any) => [f.conname, f.del]), [["VendorAmc_customerId_fkey", "n"], ["VendorAmc_siteId_fkey", "n"]], "n = ON DELETE SET NULL");
    const idx = await prisma.$queryRaw`select indexname from pg_indexes where tablename = 'VendorAmc' and indexname in ('VendorAmc_customerId_idx','VendorAmc_siteId_idx')`;
    assert.equal(idx.length, 2);
  });

  test("vendor AMC customer / site: stored and read back through the real routes; invalid combinations are refused and store nothing", async () => {
    const siteA = (await makeSite(world.A.id, "L1")).site;
    const siteB = (await makeSite(world.B.id, "L2")).site;
    const make = (extra: Record<string, unknown>) => call(world.mgmt, "POST", "/vendor-amcs", { vendorId: world.V1.id, title: `${PREFIX} LINK${++seq}`, startDate: day(-10), durationMonths: 12, ...extra });
    const ok = await make({ customerId: world.A.id, siteId: siteA.id });
    assert.equal(ok.status, 201);
    tracked.vendorAmcIds.add(ok.body.id);
    assert.deepEqual([ok.body.customer.id, ok.body.site.id, ok.body.site.companyName], [world.A.id, siteA.id, siteA.companyName]);
    const row = await prisma.vendorAmc.findUnique({ where: { id: ok.body.id } });
    assert.deepEqual([row.customerId, row.siteId], [world.A.id, siteA.id]);

    const before = await prisma.vendorAmc.count({ where: { title: { startsWith: `${PREFIX} LINK` } } });
    assert.equal((await make({ siteId: siteA.id })).status, 400, "a site needs its customer");
    assert.equal((await make({ customerId: world.A.id, siteId: siteB.id })).status, 400, "another customer's site");
    assert.equal((await make({ customerId: "nonexistent-customer" })).status, 400);
    assert.equal((await make({ customerId: world.A.id, siteId: "nonexistent-site" })).status, 400);
    assert.equal(await prisma.vendorAmc.count({ where: { title: { startsWith: `${PREFIX} LINK` } } }), before, "nothing stored by the refused requests");

    // change / clear; a customer change drops the old site; a vendor reads its own contract's links
    const url = `/vendor-amcs/${ok.body.id}`;
    const toB = await call(world.mgmt, "PATCH", url, { customerId: world.B.id });
    assert.deepEqual([toB.status, toB.body.customer.id, toB.body.site], [200, world.B.id, null]);
    assert.equal((await call(world.mgmt, "PATCH", url, { siteId: siteA.id })).status, 400);
    assert.equal((await call(world.mgmt, "PATCH", url, { siteId: siteB.id })).body.site.id, siteB.id);
    // vendor users made here (earlier tests reassign world.vend1 / world.vend2 to their own fresh vendors)
    const ownVendorUser = await makeUser("linkVend1", "erection_engineer", { vendorId: world.V1.id });
    const otherVendorUser = await makeUser("linkVend2", "erection_engineer", { vendorId: world.V2.id });
    const asVendor = await call(ownVendorUser, "GET", url);
    assert.equal(asVendor.status, 200, JSON.stringify(asVendor.body));
    assert.equal(asVendor.body.site.id, siteB.id);
    assert.equal((await call(otherVendorUser, "GET", url)).status, 404, "another vendor cannot see it");
    assert.equal((await call(ownVendorUser, "PATCH", url, { siteId: null })).status, 403);
    assert.equal((await call(world.mgmt, "PATCH", url, { customerId: null })).body.customer, null);
  });

  test("vendor AMC customer / site: deleting the customer or the site keeps the contract and its renewal history (SET NULL)", async () => {
    const temp = await makeCustomer("T");
    const { order, site } = await makeSite(temp.id, "L3");
    const c = await prisma.vendorAmc.create({ data: { vendorId: world.V1.id, customerId: temp.id, siteId: site.id, title: `${PREFIX} KEEP`, startDate: new Date(day(-300)), endDate: new Date(day(60)) } });
    tracked.vendorAmcIds.add(c.id);
    assert.equal((await call(world.mgmt, "POST", `/vendor-amcs/${c.id}/renew`, { expectedEndDate: day(60) })).status, 201);
    await prisma.site.delete({ where: { id: site.id } });
    assert.equal((await prisma.vendorAmc.findUnique({ where: { id: c.id } })).siteId, null, "the site is gone, the contract is not");
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.customer.delete({ where: { id: temp.id } });
    const after = await prisma.vendorAmc.findUnique({ where: { id: c.id } });
    assert.deepEqual([after.customerId, after.siteId, dayOf(after.endDate)], [null, null, day(425)], "renewed period kept");
    assert.equal((await historyOf({ vendorAmcId: c.id })).length, 1, "history kept");
    tracked.customerIds.delete(temp.id);
  });

  test("reminders: both kinds carry type, customer, site, vendor, expiry date and days remaining; a second run sends nothing more", async () => {
    await resetSettings();
    sent.length = 0;
    const { order, site } = await makeSite(world.A.id, "R", `${PREFIX} Pune Plant`);
    const productId = (await prisma.product.findFirstOrThrow()).id;
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-RU${++seq}`, orderId: order.id, siteId: site.id, productId } });
    tracked.unitIds.add(unit.id);
    const viaUnits = await makeAmc(world.A.id, { amcType: "namc", location: `${PREFIX} free-text location`, startDate: new Date(day(-335)), endDate: new Date(day(10)), datesSource: "explicit" });
    await prisma.amcOrderUnit.create({ data: { amcOrderId: viaUnits.id, unitId: unit.id } });
    const byLocation = await makeAmc(world.A.id, { location: `${PREFIX} Chennai works`, startDate: new Date(day(-335)), endDate: new Date(day(9)), datesSource: "explicit" });
    const vend = await prisma.vendorAmc.create({
      data: { vendorId: world.V1.id, customerId: world.A.id, siteId: site.id, title: `${PREFIX} VENDOR-R`, contractRef: `${PREFIX}-VREF`, startDate: new Date(day(-340)), endDate: new Date(day(12)) },
    });
    tracked.vendorAmcIds.add(vend.id);
    const general = await makeVendorAmc(world.V2.id, day(-340), day(20), `${PREFIX} GENERAL-R`);

    const NOW = new Date();
    await lib.runAmcExpiryReminders(NOW);
    const notice = (needle: string) => sentFor(needle).filter((m) => m.templateKey === "amc_expiry_reminder" && m.channel === "in_app");
    const one = (needle: string) => { const m = notice(needle); assert.ok(m.length >= 1, `no reminder for ${needle}`); return m[0].data; };

    const a = one(viaUnits.poNo);
    assert.deepEqual([a.kind, a.amcTypeLabel, a.amcType, a.customerName, a.siteName, a.vendorName, a.daysRemaining, a.expiryDate.slice(0, 10), a.actionPath],
      ["customer", "Customer AMC", "namc", world.A.name, `${PREFIX} Pune Plant`, null, 10, day(10), "/amc-orders"], "customer AMC: the site comes from its covered units");
    const b = one(byLocation.poNo);
    assert.deepEqual([b.siteName, b.daysRemaining], [`${PREFIX} Chennai works`, 9], "without units the contract's own location is shown");
    const v = one(`${PREFIX}-VREF`);
    assert.deepEqual([v.kind, v.amcTypeLabel, v.customerName, v.siteName, v.vendorName, v.daysRemaining, v.expiryDate.slice(0, 10), v.actionPath],
      ["vendor", "Vendor AMC", world.A.name, `${PREFIX} Pune Plant`, world.V1.name, 12, day(12), "/vendor-amcs"]);
    const g = one(`${PREFIX} GENERAL-R`);
    assert.deepEqual([g.customerName, g.siteName, g.vendorName], [null, null, world.V2.name]);

    const counts = [viaUnits.poNo, byLocation.poNo, `${PREFIX}-VREF`, `${PREFIX} GENERAL-R`].map((n) => notice(n).length);
    await lib.runAmcExpiryReminders(NOW);
    await lib.runAmcExpiryReminders(new Date(NOW.getTime() + 60 * 60 * 1000));
    assert.deepEqual([viaUnits.poNo, byLocation.poNo, `${PREFIX}-VREF`, `${PREFIX} GENERAL-R`].map((n) => notice(n).length), counts, "repeat runs send nothing more");
    void general;
  });
});
