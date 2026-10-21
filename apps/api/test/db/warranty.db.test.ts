/**
 * Real-database tests for RECD unit warranty (Requirement 8): the migration's columns, CHECK constraints, indexes and permission grant;
 * nothing backfilled for legacy units; recording / correcting a warranty with its history in ONE transaction (rollback, stale and concurrent
 * writers); history that survives edits and blocks deleting its unit; unit-scoped access for customers and vendors through the real routers;
 * the login-time alerts; and the reminder job's atomic claims (overlapping runs, failure and retry, no duplicate delivery).
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test). They only touch rows they create (unique run prefix; removed in `after`). The company-settings singleton is
 * changed for the run and restored. Every notification channel is replaced by a stub that records the message, so nothing is sent anywhere.
 * Run with: npm run test:db --workspace=apps/api (database migrated through 20261022090000_unit_warranty).
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
describe("RECD unit warranty against the real test database", { skip }, () => {
  const PREFIX = `ZW${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), unitIds: new Set<string>(), vendorIds: new Set<string>(), productIds: new Set<string>() };
  const realConsole = { log: console.log, error: console.error };
  const day = (n: number, from = new Date()) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + n));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  let seq = 0;

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let lib: any;
  let providers: any;
  const realProviders: Record<string, any> = {};
  const sent: any[] = [];
  const emailFail = new Set<string>();
  let savedSettings: any = null;
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const world: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }
  async function makeProduct(tag: string, warrantyMonths: number | null) {
    const p = await prisma.product.create({ data: { name: `${PREFIX} ${tag}`, model: `${PREFIX}-${tag}`, warrantyMonths } });
    tracked.productIds.add(p.id);
    return p;
  }
  /** A unit with its own order and site. `vendorId` puts the site under a vendor; warranty columns can be given directly (like older or hand-made rows). */
  async function makeUnit(customerId: string, productId: string, over: Record<string, unknown> = {}, vendorId: string | null = null) {
    const n = ++seq;
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-O${n}`, customerId, productId, quantity: 1, site: { create: { currentStageId: stageId, companyName: `${PREFIX} Plant ${n}`, address: "Synthetic Estate", vendorId } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${n}`, orderId: order.id, siteId: order.site.id, productId, ...over } });
    tracked.unitIds.add(unit.id);
    return unit;
  }

  const tokenOf = (user: any) => signToken({ userId: user.id, roleKey: "x", customerId: user.customerId ?? null });
  async function call(as: any, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  }
  const put = (as: any, unit: any, body: Record<string, unknown>) => call(as, "PUT", `/recd-units/${unit.id}/warranty`, body);
  const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const historyOf = (unitId: string) => prisma.warrantyHistory.findMany({ where: { unitId }, orderBy: { createdAt: "asc" } });
  const rawUnit = (id: string) => prisma.recdUnit.findUniqueOrThrow({ where: { id } });
  const sentFor = (needle: string) => sent.filter((m) => JSON.stringify(m).includes(needle));
  const resetSettings = () => prisma.companySettings.upsert({ where: { id: "singleton" }, update: { warrantyReminderLeadDays: null, warrantyReminderRepeatDays: null }, create: { id: "singleton" } });

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    lib = await import("../../src/lib/warranty");
    ({ providersByChannel: providers } = await import("../../src/services/notifications/providers"));
    for (const k of Object.keys(providers)) {
      realProviders[k] = providers[k];
      providers[k] = { channel: k, send: async (m: any) => { if (k === "email" && emailFail.has(m.recipientId)) return false; sent.push({ channel: k, ...m }); return true; } };
    }
    savedSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

    const { recdUnitsRouter } = await import("../../src/routes/recdUnits");
    const { warrantyAlertsRouter, warrantyCronRouter } = await import("../../src/routes/warrantyAlerts");
    const { settingsRouter } = await import("../../src/routes/settings");
    const app = express();
    app.use(express.json());
    app.use("/recd-units", recdUnitsRouter);
    app.use("/warranty-alerts", warrantyAlertsRouter);
    app.use("/warranty/cron", warrantyCronRouter);
    app.use("/settings", settingsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_engineer", "management", "sales", "super_admin", "erection_engineer"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    world.A = await prisma.customer.create({ data: { name: `${PREFIX} Customer A` } });
    world.B = await prisma.customer.create({ data: { name: `${PREFIX} Customer B` } });
    tracked.customerIds.add(world.A.id); tracked.customerIds.add(world.B.id);
    for (const [k, t] of [["V1", "V1"], ["V2", "V2"]]) {
      world[k] = await prisma.vendor.create({ data: { name: `${PREFIX} ${t}`, status: "approved", contactName: "Synthetic", contactEmail: `${PREFIX.toLowerCase()}-${t}@example.invalid` } });
      tracked.vendorIds.add(world[k].id);
    }
    world.P24 = await makeProduct("P24", 24);
    world.PNONE = await makeProduct("PNONE", null);
    world.mgmt = await makeUser("manager", "management");
    world.admin = await makeUser("admin", "super_admin");
    world.sales = await makeUser("sales", "sales");
    world.eng = await makeUser("engineer", "service_engineer");
    world.custA = await makeUser("custA", "customer", { customerId: world.A.id });
    world.custB = await makeUser("custB", "customer", { customerId: world.B.id });
    world.vend1 = await makeUser("vendor1", "erection_engineer", { vendorId: world.V1.id });
    world.vend2 = await makeUser("vendor2", "erection_engineer", { vendorId: world.V2.id });
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        const unitIds = [...tracked.unitIds];
        await prisma.warrantyReminderDelivery.deleteMany({ where: { unitId: { in: unitIds } } });
        await prisma.warrantyHistory.deleteMany({ where: { unitId: { in: unitIds } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: unitIds } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.notificationLog.deleteMany({ where: { recipientId: { in: [...tracked.userIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
        await prisma.vendor.deleteMany({ where: { id: { in: [...tracked.vendorIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
        await prisma.product.deleteMany({ where: { id: { in: [...tracked.productIds] } } });
        const keep = savedSettings ?? { warrantyReminderLeadDays: null, warrantyReminderRepeatDays: null };
        await prisma.companySettings.updateMany({ where: { id: "singleton" }, data: { warrantyReminderLeadDays: keep.warrantyReminderLeadDays, warrantyReminderRepeatDays: keep.warrantyReminderRepeatDays } });
      }
    } finally {
      for (const k of Object.keys(realProviders)) providers[k] = realProviders[k];
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // The migration
  // ------------------------------------------------------------------------------------------

  test("migration objects: nullable columns, history / delivery tables, CHECK constraints, indexes, RLS", async () => {
    const cols = await prisma.$queryRaw`select column_name, is_nullable from information_schema.columns where table_name = 'RecdUnit' and column_name in ('warrantyStartDate','warrantyEndDate','warrantyMonths','warrantySource')`;
    assert.deepEqual(cols.map((c: any) => c.column_name).sort(), ["warrantyEndDate", "warrantyMonths", "warrantySource", "warrantyStartDate"]);
    assert.ok(cols.every((c: any) => c.is_nullable === "YES"), "additive: legacy units need no warranty");
    const checks = (await prisma.$queryRaw`select conname from pg_constraint where contype = 'c' and conname in ('RecdUnit_warranty_check','WarrantyHistory_kind_check','WarrantyHistory_periods_check','WarrantyHistory_previous_check','WarrantyHistory_source_check','WarrantyReminderDelivery_attempts_check','CompanySettings_warranty_settings_check')`).map((r: any) => r.conname);
    assert.equal(checks.length, 7, checks.join(","));
    const idx = (await prisma.$queryRaw`select indexname from pg_indexes where indexname in ('WarrantyReminderDelivery_unitId_warrantyEndDate_recipientId_key','WarrantyHistory_unitId_createdAt_idx','RecdUnit_warrantyEndDate_idx')`).map((r: any) => r.indexname);
    assert.equal(idx.length, 3);
    const rls = await prisma.$queryRaw`select relname, relrowsecurity from pg_class where relname in ('WarrantyHistory','WarrantyReminderDelivery')`;
    assert.ok(rls.length === 2 && rls.every((r: any) => r.relrowsecurity));
    const fk = await prisma.$queryRaw`select confdeltype from pg_constraint where conname = 'WarrantyHistory_unitId_fkey'`;
    assert.equal(fk[0].confdeltype, "r", "history blocks deleting its unit (RESTRICT)");
  });

  test("migration: nothing was backfilled - every unit that this run did not record has no warranty; the migration SQL contains no UPDATE of RecdUnit", async () => {
    const stray = await prisma.$queryRaw`select count(*)::int as n from "RecdUnit" where ("warrantyStartDate" is not null or "warrantyEndDate" is not null or "warrantyMonths" is not null or "warrantySource" is not null) and id <> all(${[...tracked.unitIds]}::text[])`;
    assert.equal(stray[0].n, 0, "legacy units are all 'not recorded'");
    const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261022090000_unit_warranty/migration.sql"), "utf8");
    assert.doesNotMatch(sql, /UPDATE\s+"RecdUnit"/i);
    assert.doesNotMatch(sql, /DROP\s|TRUNCATE|DELETE\s+FROM/i, "additive only");
  });

  test("migration: manage_warranty exists and is granted to super_admin, owner_admin and management ONLY", async () => {
    const rows = await prisma.$queryRaw`select r.key from "Role" r join "RolePermission" rp on rp."roleId" = r.id join "Permission" p on p.id = rp."permissionId" where p.key = 'manage_warranty' order by r.key`;
    assert.deepEqual(rows.map((r: any) => r.key), ["management", "owner_admin", "super_admin"]);
  });

  test("CHECK constraints: a unit's warranty is all-or-nothing and consistent", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    const bad = (data: Record<string, unknown>, re: RegExp = /RecdUnit_warranty_check|violates check/i) => assert.rejects(prisma.recdUnit.update({ where: { id: u.id }, data }), re, JSON.stringify(data));
    await bad({ warrantyStartDate: day(0) });
    await bad({ warrantyStartDate: day(0), warrantyEndDate: day(30) });
    await bad({ warrantyStartDate: day(0), warrantyEndDate: day(30), warrantySource: "manual", warrantyMonths: 0 });
    await bad({ warrantyStartDate: day(10), warrantyEndDate: day(1), warrantySource: "manual" });
    await bad({ warrantyStartDate: day(0), warrantyEndDate: day(30), warrantySource: "guessed" });
    await bad({ warrantyStartDate: day(0), warrantyEndDate: day(30), warrantySource: "calculated" });
    await bad({ warrantyStartDate: day(0), warrantyEndDate: day(30), warrantySource: "product_default", warrantyMonths: 121 });
    await bad({ warrantyMonths: 12 });
    await prisma.recdUnit.update({ where: { id: u.id }, data: { warrantyStartDate: day(0), warrantyEndDate: day(30), warrantySource: "manual" } });
    await prisma.recdUnit.update({ where: { id: u.id }, data: { warrantyStartDate: null, warrantyEndDate: null, warrantySource: null, warrantyMonths: null } });
    await assert.rejects(prisma.companySettings.update({ where: { id: "singleton" }, data: { warrantyReminderLeadDays: 400 } }), /warranty_settings_check|violates check/i);
    await assert.rejects(prisma.companySettings.update({ where: { id: "singleton" }, data: { warrantyReminderRepeatDays: 0 } }), /warranty_settings_check|violates check/i);
  });

  test("history constraints: kind, previous values, reason for a correction, valid periods; the unit cannot be deleted while it has history", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    const row = { unitId: u.id, newStartDate: day(0), newEndDate: day(365), newSource: "manual" };
    const rej = (data: Record<string, unknown>) => assert.rejects(prisma.warrantyHistory.create({ data: { ...row, ...data } as any }), /WarrantyHistory_|violates check/i, JSON.stringify(data));
    await rej({ kind: "other" });
    await rej({ kind: "established", previousStartDate: day(-5), previousEndDate: day(5) });
    await rej({ kind: "correction" });
    await rej({ kind: "correction", previousStartDate: day(-5), previousEndDate: day(5) });
    await rej({ kind: "correction", previousStartDate: day(-5), previousEndDate: day(5), reason: "  " });
    await rej({ kind: "correction", previousStartDate: day(-5), reason: "only one previous date" });
    await rej({ kind: "established", newEndDate: day(-1) });
    await rej({ kind: "established", newSource: "guessed" });
    await prisma.warrantyHistory.create({ data: { ...row, kind: "established" } });
    await assert.rejects(prisma.recdUnit.delete({ where: { id: u.id } }), /foreign key|Foreign key|constraint/i);
    assert.equal(await prisma.recdUnit.count({ where: { id: u.id } }), 1, "the unit and its history are still there");
  });

  // ------------------------------------------------------------------------------------------
  // Recording / correcting through the real routes
  // ------------------------------------------------------------------------------------------

  test("a new unit is 'not recorded' (unknown) and is not treated as active; the product's duration is only a default", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    const r = await call(world.mgmt, "GET", `/recd-units/${u.id}`);
    assert.deepEqual([r.status, r.body.warranty.status, r.body.warranty.startDate, r.body.warranty.endDate, r.body.warranty.daysRemaining], [200, "unknown", null, null, null]);
    assert.equal(r.body.product.warrantyMonths, 24);
    const alerts = (await call(world.mgmt, "GET", "/warranty-alerts")).body.alerts.map((a: any) => a.unitId);
    assert.ok(!alerts.includes(u.id), "unknown dates never appear in the expiry list");
  });

  test("record with the product default, then change the PRODUCT duration: the unit keeps its stored duration and dates", async () => {
    const product = await makeProduct("P12", 12);
    const u = await makeUnit(world.A.id, product.id);
    const r = await put(world.mgmt, u, { startDate: "2026-02-01", expectedEndDate: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.warranty.endDate, r.body.warranty.durationMonths, r.body.warranty.source], ["2027-01-31", 12, "product_default"]);
    await prisma.product.update({ where: { id: product.id }, data: { warrantyMonths: 36 } });
    const after = await call(world.mgmt, "GET", `/recd-units/${u.id}`);
    assert.deepEqual([after.body.warranty.endDate, after.body.warranty.durationMonths, after.body.product.warrantyMonths], ["2027-01-31", 12, 36], "not silently recalculated");
    const raw = await rawUnit(u.id);
    assert.deepEqual([dayOf(raw.warrantyStartDate), dayOf(raw.warrantyEndDate), raw.warrantyMonths, raw.warrantySource], ["2026-02-01", "2027-01-31", 12, "product_default"]);
    const h = await historyOf(u.id);
    assert.equal(h.length, 1, "a product edit writes no unit history");
    assert.deepEqual([h[0].kind, h[0].newMonths, h[0].newSource, h[0].actorId], ["established", 12, "product_default", world.mgmt.id]);
  });

  test("a product without a duration: refused unless the expiry or a duration is entered; nothing is written by the refusal", async () => {
    const u = await makeUnit(world.A.id, world.PNONE.id);
    const refused = await put(world.mgmt, u, { startDate: "2026-02-01", expectedEndDate: null });
    assert.equal(refused.status, 400);
    assert.equal((await rawUnit(u.id)).warrantyStartDate, null);
    assert.equal((await historyOf(u.id)).length, 0);
    const ok = await put(world.mgmt, u, { startDate: "2026-02-01", endDate: "2027-03-15", expectedEndDate: null });
    assert.deepEqual([ok.status, ok.body.warranty.endDate, ok.body.warranty.durationMonths, ok.body.warranty.source], [200, "2027-03-15", null, "manual"]);
  });

  test("invalid dates / durations / combinations are rejected with no database change", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    for (const body of [
      { startDate: "2026-02-30", expectedEndDate: null },
      { startDate: "2026-02-01", endDate: "2026-01-31", expectedEndDate: null },
      { startDate: "2026-02-01", endDate: "2027-02-01", durationMonths: 12, expectedEndDate: null },
      { startDate: "2026-02-01", durationMonths: 0, expectedEndDate: null },
      { startDate: "2026-02-01", durationMonths: 12.5, expectedEndDate: null },
      { startDate: "2026-02-01", durationMonths: 999, expectedEndDate: null },
      { startDate: "2026-02-01" },
    ]) assert.equal((await put(world.mgmt, u, body)).status, 400, JSON.stringify(body));
    assert.equal((await rawUnit(u.id)).warrantyStartDate, null);
    assert.equal((await historyOf(u.id)).length, 0);
  });

  test("correction: reason required, previous + new values and the actor are kept, and the history survives later edits", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    await put(world.mgmt, u, { startDate: "2026-02-01", expectedEndDate: null });
    assert.equal((await put(world.mgmt, u, { startDate: "2026-03-01", expectedEndDate: "2028-01-31" })).status, 400, "no reason");
    const fix = await put(world.admin, u, { startDate: "2026-03-01", endDate: "2028-06-30", expectedEndDate: "2028-01-31", reason: "certificate shows 1 March" });
    assert.equal(fix.status, 200, JSON.stringify(fix.body));
    await put(world.mgmt, u, { startDate: "2026-03-01", durationMonths: 24, expectedEndDate: "2028-06-30", reason: "back to 24 months" });
    const h = await historyOf(u.id);
    assert.deepEqual(h.map((x: any) => x.kind), ["established", "correction", "correction"]);
    assert.deepEqual([dayOf(h[1].previousStartDate), dayOf(h[1].previousEndDate), h[1].previousMonths, h[1].previousSource, dayOf(h[1].newEndDate), h[1].newSource, h[1].reason, h[1].actorId], ["2026-02-01", "2028-01-31", 24, "product_default", "2028-06-30", "manual", "certificate shows 1 March", world.admin.id]);
    const api = await call(world.mgmt, "GET", `/recd-units/${u.id}/warranty-history`);
    assert.deepEqual(api.body.map((x: any) => x.kind), ["correction", "correction", "established"]);
    assert.equal((await call(world.custA, "GET", `/recd-units/${u.id}/warranty-history`)).body[0].reason, undefined, "customers never get the reason");
    assert.equal((await historyOf(u.id)).length, 3);
  });

  test("exactly-once: eight simultaneous first-time submissions record one warranty and one history row", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => put(world.mgmt, u, { startDate: "2026-02-01", expectedEndDate: null })));
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409, 409, 409, 409, 409, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.code === "STALE_WARRANTY"));
    assert.equal((await historyOf(u.id)).length, 1);
  });

  test("transactional: if the history row cannot be written the warranty is NOT changed (first-time and correction)", async () => {
    const u = await makeUnit(world.A.id, world.P24.id);
    await assert.rejects(lib.setUnitWarranty(u.id, { startDate: "2026-02-01", expectedEndDate: null }, "no-such-user"), /foreign key|Foreign key/i);
    assert.equal((await rawUnit(u.id)).warrantyStartDate, null, "rolled back");
    assert.equal((await historyOf(u.id)).length, 0);
    await put(world.mgmt, u, { startDate: "2026-02-01", expectedEndDate: null });
    await assert.rejects(lib.setUnitWarranty(u.id, { startDate: "2026-04-01", expectedEndDate: "2028-01-31", reason: "will fail" }, "no-such-user"), /foreign key|Foreign key/i);
    const raw = await rawUnit(u.id);
    assert.deepEqual([dayOf(raw.warrantyStartDate), dayOf(raw.warrantyEndDate)], ["2026-02-01", "2028-01-31"]);
    assert.equal((await historyOf(u.id)).length, 1);
  });

  // ------------------------------------------------------------------------------------------
  // Access control
  // ------------------------------------------------------------------------------------------

  test("only manage_warranty writes; customers and vendors are read-only; unit scope applies to every read", async () => {
    const mine = await makeUnit(world.A.id, world.P24.id, { warrantyStartDate: new Date("2026-01-01"), warrantyEndDate: new Date("2027-12-31"), warrantyMonths: 24, warrantySource: "calculated" }, world.V1.id);
    const theirs = await makeUnit(world.B.id, world.P24.id, { warrantyStartDate: new Date("2026-01-01"), warrantyEndDate: new Date("2027-12-31"), warrantyMonths: 24, warrantySource: "calculated" }, world.V2.id);
    for (const who of [world.sales, world.eng, world.custA, world.vend1, null]) {
      assert.equal((await put(who, mine, { startDate: "2026-02-01", expectedEndDate: "2027-12-31", durationMonths: 12, reason: "hack" })).status, who ? 403 : 401);
    }
    assert.equal(dayOf((await rawUnit(mine.id)).warrantyEndDate), "2027-12-31");
    assert.equal((await historyOf(mine.id)).length, 0);
    // reads
    assert.equal((await call(world.custA, "GET", `/recd-units/${mine.id}`)).body.warranty.endDate, "2027-12-31");
    assert.equal((await call(world.custA, "GET", `/recd-units/${theirs.id}`)).status, 403);
    assert.equal((await call(world.custA, "GET", `/recd-units/${theirs.id}/warranty-history`)).status, 403);
    assert.ok(!(await call(world.custA, "GET", "/recd-units")).body.some((x: any) => x.id === theirs.id));
    assert.equal((await call(world.vend1, "GET", `/recd-units/${mine.id}`)).status, 200);
    assert.equal((await call(world.vend1, "GET", `/recd-units/${theirs.id}`)).status, 403);
    assert.equal((await call(world.vend2, "GET", `/recd-units/${mine.id}/warranty-history`)).status, 403);
    assert.ok(!(await call(world.vend2, "GET", "/recd-units")).body.some((x: any) => x.id === mine.id));
    assert.equal((await call(world.mgmt, "GET", `/recd-units/${theirs.id}`)).status, 200, "staff see all");
  });

  test("settings: only manage_settings may change the warranty reminder values; invalid values change nothing", async () => {
    await resetSettings();
    const ok = { warrantyReminderLeadDays: 45, warrantyReminderRepeatDays: 7 };
    for (const who of [world.mgmt, world.sales, world.custA, world.vend1]) assert.equal((await call(who, "PUT", "/settings/warranty", ok)).status, 403);
    for (const bad of [{ ...ok, warrantyReminderLeadDays: -1 }, { ...ok, warrantyReminderRepeatDays: 0 }, { ...ok, warrantyReminderLeadDays: 400 }]) assert.equal((await call(world.admin, "PUT", "/settings/warranty", bad)).status, 400);
    assert.deepEqual(await lib.loadWarrantyPolicy(), { reminderLeadDays: 30, reminderRepeatDays: 3 });
    assert.deepEqual((await call(world.admin, "PUT", "/settings/warranty", ok)).body, ok);
    assert.deepEqual(await lib.loadWarrantyPolicy(), { reminderLeadDays: 45, reminderRepeatDays: 7 });
    await resetSettings();
  });

  // ------------------------------------------------------------------------------------------
  // Status and alerts
  // ------------------------------------------------------------------------------------------

  const withDates = (s: number, e: number) => ({ warrantyStartDate: day(s), warrantyEndDate: day(e), warrantyMonths: 12, warrantySource: "calculated" });

  test("status for every state, with the inclusive expiry day", async () => {
    await resetSettings();
    const mk = (s: number, e: number) => makeUnit(world.A.id, world.P24.id, withDates(s, e));
    const upcoming = await mk(10, 375), active = await mk(-100, 200), soon = await mk(-300, 20), today = await mk(-364, 0), expired = await mk(-400, -1), unknown = await makeUnit(world.A.id, world.P24.id);
    const list = (await call(world.mgmt, "GET", "/recd-units?customerId=" + world.A.id)).body;
    const st = (u: any) => list.find((x: any) => x.id === u.id).warranty;
    assert.deepEqual([upcoming, active, soon, today, expired, unknown].map((u) => st(u).status), ["upcoming", "active", "expiring_soon", "expiring_soon", "expired", "unknown"]);
    assert.deepEqual([st(upcoming).daysUntilStart, st(soon).daysRemaining, st(today).daysRemaining, st(expired).daysSinceExpiry, st(expired).daysRemaining, st(unknown).daysRemaining], [10, 20, 0, 1, null, null]);
  });

  test("alerts: scoped to the caller, expiring soon or recently expired only, unknown excluded, one query", async () => {
    await resetSettings();
    const cA = await prisma.customer.create({ data: { name: `${PREFIX} alertA` } }); tracked.customerIds.add(cA.id);
    const cB = await prisma.customer.create({ data: { name: `${PREFIX} alertB` } }); tracked.customerIds.add(cB.id);
    const uA = await makeUser("alertCustA", "customer", { customerId: cA.id });
    const vA = await prisma.vendor.create({ data: { name: `${PREFIX} alertV`, status: "approved", contactName: "S", contactEmail: `${PREFIX.toLowerCase()}-av@example.invalid` } }); tracked.vendorIds.add(vA.id);
    const wA = await makeUser("alertVend", "erection_engineer", { vendorId: vA.id });
    const soon = await makeUnit(cA.id, world.P24.id, withDates(-300, 20), vA.id);
    const expired = await makeUnit(cA.id, world.P24.id, withDates(-400, -5));
    const old = await makeUnit(cA.id, world.P24.id, withDates(-900, -200));
    const fine = await makeUnit(cA.id, world.P24.id, withDates(-10, 300));
    const unknown = await makeUnit(cA.id, world.P24.id);
    const retired = await makeUnit(cA.id, world.P24.id, { ...withDates(-300, 9), status: "retired" });
    const other = await makeUnit(cB.id, world.P24.id, withDates(-300, 7));
    const ids = async (who: any) => (await call(who, "GET", "/warranty-alerts")).body.alerts.map((a: any) => a.unitId).sort();
    assert.deepEqual(await ids(uA), [soon.id, expired.id].sort(), "a customer sees only its own units' alerts");
    assert.deepEqual(await ids(wA), [soon.id], "a vendor sees only units at its sites");
    const staff = await ids(world.mgmt);
    for (const x of [soon, expired, other]) assert.ok(staff.includes(x.id));
    for (const x of [old, fine, unknown, retired]) assert.ok(!staff.includes(x.id));
    assert.deepEqual(await ids(world.custB), [], "another customer sees none of them");
    assert.equal((await call(null, "GET", "/warranty-alerts")).status, 401);
    const a = (await call(uA, "GET", "/warranty-alerts")).body.alerts.find((x: any) => x.unitId === expired.id);
    assert.deepEqual([a.status, a.daysSinceExpiry, a.endDate, a.serialNo, a.customerName], ["expired", 5, iso(day(-5)), expired.serialNo, `${PREFIX} alertA`]);
    await call(world.admin, "PUT", "/settings/warranty", { warrantyReminderLeadDays: 350, warrantyReminderRepeatDays: null });
    assert.ok((await ids(uA)).includes(fine.id), "a wider configured window includes it");
    await resetSettings();
  });

  // ------------------------------------------------------------------------------------------
  // Reminders
  // ------------------------------------------------------------------------------------------

  /** Reminder state for one unit (rows for every manage_warranty holder in this database, including seed users). */
  const deliveriesOf = (unitId: string) => prisma.warrantyReminderDelivery.findMany({ where: { unitId } });
  const mailsFor = (unit: any) => sent.filter((m) => m.channel === "email" && m.templateKey === "warranty_expiry_reminder" && m.data?.unitId === unit.id);
  const staffIds = async () => (await prisma.user.findMany({ where: { isActive: true, role: { permissions: { some: { permission: { key: "manage_warranty" } } } } }, select: { id: true } })).map((u: any) => u.id).sort();

  test("reminders: window, expiry, unknown and retired units; recipients are exactly the active manage_warranty holders; details are in the message", async () => {
    await resetSettings();
    sent.length = 0;
    const inWin = await makeUnit(world.A.id, world.P24.id, withDates(-335, 30), world.V1.id);
    const outside = await makeUnit(world.A.id, world.P24.id, withDates(-334, 31));
    const expired = await makeUnit(world.A.id, world.P24.id, withDates(-400, -1));
    const upcoming = await makeUnit(world.A.id, world.P24.id, withDates(5, 370));
    const unknown = await makeUnit(world.A.id, world.P24.id);
    const retired = await makeUnit(world.A.id, world.P24.id, { ...withDates(-300, 10), status: "retired" });
    const r = await lib.runWarrantyReminders(new Date());
    assert.ok(r.delivered >= 2);
    const staff = await staffIds();
    assert.ok(staff.includes(world.mgmt.id) && staff.includes(world.admin.id));
    assert.deepEqual((await deliveriesOf(inWin.id)).map((d: any) => d.recipientId).sort(), staff);
    assert.ok((await deliveriesOf(inWin.id)).every((d: any) => d.deliveredAt && d.attempts === 0));
    assert.deepEqual(mailsFor(inWin).map((m) => m.recipientId).sort(), staff);
    for (const bad of [world.sales.id, world.custA.id, world.vend1.id, world.eng.id]) assert.ok(!mailsFor(inWin).some((m) => m.recipientId === bad), "never to sales, customers, vendors or engineers");
    for (const x of [outside, expired, upcoming, unknown, retired]) assert.equal((await deliveriesOf(x.id)).length, 0, `no reminder for ${x.serialNo}`);
    const m = mailsFor(inWin)[0].data;
    assert.deepEqual([m.serialNo, m.customerName, m.siteName, m.expiryDate, m.status, m.daysRemaining, m.productName], [inWin.serialNo, `${PREFIX} Customer A`, `${PREFIX} Plant ${seq - 5}`, iso(day(30)), "expiring_soon", 30, `${PREFIX} P24 (${PREFIX}-P24)`]);
  });

  test("reminders: the repeat interval, a corrected expiry (fresh cycle) and the configured lead / repeat values", async () => {
    await resetSettings();
    sent.length = 0;
    const u = await makeUnit(world.A.id, world.P24.id, withDates(-340, 25));
    const t0 = new Date();
    await lib.runWarrantyReminders(t0);
    const n1 = mailsFor(u).length;
    assert.ok(n1 >= 2);
    await lib.runWarrantyReminders(new Date(t0.getTime() + 2.9 * 24 * 3600_000));
    assert.equal(mailsFor(u).length, n1, "not again within 3 days");
    await lib.runWarrantyReminders(new Date(t0.getTime() + 3.1 * 24 * 3600_000));
    assert.equal(mailsFor(u).length, n1 * 2, "again after 3 days");
    // a correction moves the expiry: a new (unit, expiry date) cycle starts straight away
    assert.equal((await put(world.mgmt, u, { startDate: iso(day(-340)), endDate: iso(day(20)), expectedEndDate: iso(day(25)), reason: "expiry was 20 days out" })).status, 200);
    await lib.runWarrantyReminders(new Date(t0.getTime() + 3.2 * 24 * 3600_000));
    assert.equal(mailsFor(u).length, n1 * 3);
    assert.equal(new Set((await deliveriesOf(u.id)).map((d: any) => dayOf(d.warrantyEndDate))).size, 2, "one state row per expiry date");
    // configured values
    await call(world.admin, "PUT", "/settings/warranty", { warrantyReminderLeadDays: 60, warrantyReminderRepeatDays: 1 });
    const late = await makeUnit(world.A.id, world.P24.id, withDates(-300, 50));
    await lib.runWarrantyReminders(new Date());
    assert.ok(mailsFor(late).length >= 2, "50 days out is inside the configured 60-day window");
    await resetSettings();
  });

  test("reminders: overlapping runs claim atomically - each recipient is e-mailed once", async () => {
    await resetSettings();
    sent.length = 0;
    const u = await makeUnit(world.A.id, world.P24.id, withDates(-340, 25));
    const t0 = new Date();
    await Promise.all([1, 2, 3, 4, 5].map(() => lib.runWarrantyReminders(t0)));
    const per = new Map<string, number>();
    for (const m of mailsFor(u)) per.set(m.recipientId, (per.get(m.recipientId) ?? 0) + 1);
    assert.deepEqual([...per.values()].every((n) => n === 1), true);
    assert.equal(per.size, (await staffIds()).length);
    const rows = await deliveriesOf(u.id);
    assert.equal(rows.length, per.size, "one state row per recipient (unique index)");
    await assert.rejects(prisma.warrantyReminderDelivery.create({ data: { unitId: u.id, warrantyEndDate: rows[0].warrantyEndDate, recipientId: rows[0].recipientId } }), /Unique constraint/i);
  });

  test("reminders: a refused e-mail is a failed attempt (not delivered), retried after an hour for that recipient only, and a delivered recipient is never repeated", async () => {
    await resetSettings();
    sent.length = 0;
    const u = await makeUnit(world.A.id, world.P24.id, withDates(-340, 25));
    emailFail.add(world.mgmt.id);
    const t0 = new Date();
    const r1 = await lib.runWarrantyReminders(t0);
    assert.ok(r1.failed >= 1);
    const mgmtRow = async () => (await deliveriesOf(u.id)).find((d: any) => d.recipientId === world.mgmt.id);
    assert.deepEqual([(await mgmtRow()).deliveredAt, (await mgmtRow()).attempts], [null, 1]);
    const log = await prisma.notificationLog.findFirst({ where: { recipientId: world.mgmt.id, templateKey: "warranty_expiry_reminder" }, orderBy: { createdAt: "desc" } });
    assert.equal(log?.status, "failed", "the log says failed, never sent");
    await lib.runWarrantyReminders(new Date(t0.getTime() + 600_000));
    assert.equal((await mgmtRow()).attempts, 1, "not retried within the hour");
    emailFail.clear();
    const adminMailsBefore = mailsFor(u).filter((m) => m.recipientId === world.admin.id).length;
    await lib.runWarrantyReminders(new Date(t0.getTime() + 2 * 3600_000));
    assert.ok((await mgmtRow()).deliveredAt);
    assert.equal((await mgmtRow()).attempts, 0);
    assert.equal(mailsFor(u).filter((m) => m.recipientId === world.admin.id).length, adminMailsBefore, "the recipient that already got it is not e-mailed again");
    assert.equal(mailsFor(u).filter((m) => m.recipientId === world.mgmt.id).length, 1, "exactly one successful delivery to the retried recipient");
  });

  test("the cron route demands the shared secret and sends nothing without it", async () => {
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-secret";
    try {
      sent.length = 0;
      assert.equal((await call(null, "GET", "/warranty/cron/send-reminders")).status, 401);
      assert.equal((await call(null, "GET", "/warranty/cron/send-reminders", undefined, { authorization: "Bearer wrong" })).status, 401);
      assert.equal(sent.length, 0);
      const good = await call(null, "GET", "/warranty/cron/send-reminders", undefined, { authorization: "Bearer cron-test-secret" });
      assert.deepEqual([good.status, good.body.ok], [200, true]);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
  });
});
