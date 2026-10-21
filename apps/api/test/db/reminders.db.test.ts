/**
 * Real-database tests for Requirement 6: the new tables and CHECK constraints, region mapping with its audit trail, the reminder
 * job (creation, delivery records, closing, escalation) and its safety when runs overlap, acknowledgement, and the dashboard scope -
 * through the real routers, real authentication, the real notification service and the real Prisma client.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker
 * database (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; removed in `after`).
 * The company-settings singleton row is changed for the duration of the run and restored afterwards. SMTP is forced off and the e-mail provider is replaced by a stub that accepts every message except for ids in `emailFail` (so nothing is sent anywhere), so no
 * e-mail can leave this process (the e-mail attempt is recorded as failed); WhatsApp/SMS are stubs. All names are synthetic.
 * Run with:  npm run test:db --workspace=apps/api   (database migrated through 20261019090000_service_reminders)
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
describe("service reminders against the real test database", { skip }, () => {
  const PREFIX = `ZM${Date.now().toString(36).toUpperCase()}`;
  const DAY = 24 * 3600 * 1000;
  const T0 = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const off = (n: number) => new Date(T0.getTime() + n * DAY);
  const iso = (n: number) => off(n).toISOString().slice(0, 10);
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), regionIds: new Set<string>(), unitIds: new Set<string>(), complaintIds: new Set<string>(), amcIds: new Set<string>() };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };
  const savedEnv: Record<string, string | undefined> = {};

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let runReminderJob: (now?: Date) => Promise<any>;
  let productId = "";
  let stageId = "";
  const roleIds: Record<string, string> = {};
  let savedSettings: any = null;
  const W: Record<string, any> = {};
  const emailFail = new Set<string>(); // recipients whose e-mail the stub does not accept
  const emailSent: string[] = []; // `${recipientId}:${templateKey}` for every e-mail the stub accepted
  let realEmailProvider: any = null;
  let providers: any = null;
  let startedAt = new Date();

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, email: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(u.id);
    return u;
  }
  async function makeRegion(tag: string) {
    const r = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-${tag}`, name: `${PREFIX} ${tag}` } });
    tracked.regionIds.add(r.id);
    return r;
  }

  /** A customer with one order and site in `region`, and a helper that gives every open ticket its own unit (one open ticket per unit). */
  async function makeCustomer(tag: string, region: any) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag} Ltd` } });
    tracked.customerIds.add(customer.id);
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 1, site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, address: `${tag} Estate`, regionId: region?.id ?? null } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const newUnit = async (serial: string | null = `${PREFIX}-${tag}-SN${++seq}`) => {
      const unit = await prisma.recdUnit.create({ data: { serialNo: serial, orderId: order.id, siteId: order.site.id, productId } });
      tracked.unitIds.add(unit.id);
      return unit;
    };
    return { customer, order, site: order.site, newUnit };
  }
  async function makeTicket(w: any, dueDate: Date | null, status = "open", serial: string | null | undefined = undefined) {
    const unit = await w.newUnit(serial === undefined ? undefined : serial);
    const t = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.customer.id, siteId: w.site.id, unitId: unit.id, category: "non_performance", description: `${PREFIX} ticket`, severity: "medium", status, dueDate } });
    tracked.complaintIds.add(t.id);
    return { ticket: t, unit };
  }

  const tokenOf = (u: any) => signToken({ userId: u.id, roleKey: "x", customerId: u.customerId ?? null });
  async function call(as: any, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json };
  }
  const setPolicy = (lead: number | null, hours: number | null) =>
    prisma.companySettings.upsert({ where: { id: "singleton" }, update: { reminderLeadDays: lead, reminderEscalationHours: hours }, create: { id: "singleton", reminderLeadDays: lead, reminderEscalationHours: hours } });
  const reminderOf = (complaintId: string) => prisma.serviceReminder.findUnique({ where: { complaintId } });
  const mine = (ids: string[]) => ({ complaintId: { in: ids } });
  const eventsOf = (reminderId: string, type?: string) => prisma.serviceReminderEvent.findMany({ where: { reminderId, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });

  before(async () => {
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "NODE_ENV"]) { savedEnv[k] = process.env[k]; }
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) delete process.env[k];
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ runReminderJob } = await import("../../src/lib/reminders"));
    ({ providersByChannel: providers } = await import("../../src/services/notifications/providers"));
    realEmailProvider = providers.email;
    providers.email = { channel: "email", send: async ({ recipientId, templateKey }: any) => { if (emailFail.has(recipientId)) return false; emailSent.push(`${recipientId}:${templateKey}`); return true; } };
    startedAt = new Date();
    const { remindersRouter } = await import("../../src/routes/reminders");
    const { regionsRouter } = await import("../../src/routes/regions");
    const { amcVisitsRouter } = await import("../../src/routes/amcVisits");
    const app = express();
    app.use(express.json());
    app.use("/reminders", remindersRouter);
    app.use("/regions", regionsRouter);
    app.use("/amc-visits", amcVisitsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    savedSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["service_manager", "regional_manager", "management", "service_engineer", "customer", "owner_admin"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;

    W.north = await makeRegion("North");
    W.south = await makeRegion("South");
    W.sm1 = await makeUser("sm-north", "service_manager");
    W.sm1off = await makeUser("sm-north-off", "service_manager");
    W.sm2 = await makeUser("sm-south", "service_manager");
    W.rm1 = await makeUser("rm-north", "regional_manager");
    W.mgmt = await makeUser("management", "management");
    W.eng = await makeUser("engineer", "service_engineer");
    W.admin = await prisma.user.findUniqueOrThrow({ where: { email: "superadmin@platino.example" } });
    // Region mapping goes through the real route (so its validation and audit are exercised).
    await call(W.admin, "PUT", `/regions/${W.north.id}/managers`, { userIds: [W.sm1.id, W.rm1.id] });
    await call(W.admin, "PUT", `/regions/${W.south.id}/managers`, { userIds: [W.sm2.id] });
    await prisma.user.update({ where: { id: W.sm1off.id }, data: { isActive: true } });
    W.northCo = await makeCustomer("N", W.north);
    W.southCo = await makeCustomer("S", W.south);
    W.noRegionCo = await makeCustomer("X", null);
  });

  after(async () => {
    server?.close();
    if (providers && realEmailProvider) providers.email = realEmailProvider;
    try {
      if (prisma) {
        await prisma.notificationLog.deleteMany({ where: { templateKey: { startsWith: "service_reminder" }, createdAt: { gte: startedAt } } }); // level-2 escalations also reach the seeded Management users
        if (savedSettings) await prisma.companySettings.update({ where: { id: "singleton" }, data: { reminderLeadDays: savedSettings.reminderLeadDays, reminderEscalationHours: savedSettings.reminderEscalationHours } });
        else await prisma.companySettings.deleteMany({ where: { id: "singleton", legalName: null, logoDataUrl: null } }).catch(() => {});
        const complaintIds = [...tracked.complaintIds];
        const amcIds = [...tracked.amcIds];
        const userIds = [...tracked.userIds];
        await prisma.serviceReminder.deleteMany({ where: { OR: [{ complaintId: { in: complaintIds } }, { amcVisit: { amcOrderId: { in: amcIds } } }, { customerId: { in: [...tracked.customerIds] } }] } });
        await prisma.amcVisit.deleteMany({ where: { amcOrderId: { in: amcIds } } });
        await prisma.complaint.deleteMany({ where: { id: { in: complaintIds } } });
        await prisma.amcOrder.deleteMany({ where: { id: { in: amcIds } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.notificationLog.deleteMany({ where: { recipientId: { in: userIds } } });
        await prisma.region.deleteMany({ where: { id: { in: [...tracked.regionIds] } } }); // mappings and audit rows cascade
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
      for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    }
  });

  // ------------------------------------------------------------------------------------------
  // The migration
  // ------------------------------------------------------------------------------------------

  test("migration objects exist: tables, columns, the unique-per-activity indexes and every CHECK constraint", async () => {
    const tables = await prisma.$queryRaw`select table_name from information_schema.tables where table_name in ('ServiceReminder','ServiceReminderEvent','AmcVisit','RegionManagerAudit') order by table_name`;
    assert.deepEqual(tables.map((t: any) => t.table_name), ["AmcVisit", "RegionManagerAudit", "ServiceReminder", "ServiceReminderEvent"]);
    const cols = await prisma.$queryRaw`select table_name, column_name, is_nullable from information_schema.columns where (table_name = 'Complaint' and column_name = 'dueDate') or (table_name = 'CompanySettings' and column_name in ('reminderLeadDays','reminderEscalationHours'))`;
    assert.equal(cols.length, 3);
    assert.ok(cols.every((c: any) => c.is_nullable === "YES"), "all new columns are nullable: nothing changes for existing rows");
    const esc = await prisma.$queryRaw`select column_name, is_nullable, column_default from information_schema.columns where table_name = 'ServiceReminder' and column_name in ('escalationAttempts','escalationClaimedAt') order by column_name`;
    assert.deepEqual(esc.map((c: any) => [c.column_name, c.is_nullable]), [["escalationAttempts", "NO"], ["escalationClaimedAt", "YES"]], "escalation retry state: a counter (default 0) and a nullable lease");
    assert.equal(esc[0].column_default, "0");
    const idx = await prisma.$queryRaw`select indexname from pg_indexes where indexname in ('ServiceReminder_complaintId_key','ServiceReminder_amcVisitId_key','AmcVisit_status_dueDate_idx','Complaint_dueDate_idx') order by indexname`;
    assert.equal(idx.length, 4);
    const checks = await prisma.$queryRaw`select conname from pg_constraint where contype = 'c' and conname like any (array['ServiceReminder_%','AmcVisit_%','CompanySettings_reminder%']) order by conname`;
    assert.deepEqual(checks.map((c: any) => c.conname), ["AmcVisit_completed_check", "AmcVisit_status_check", "CompanySettings_reminder_policy_check", "ServiceReminder_ack_check", "ServiceReminder_activity_check", "ServiceReminder_closed_check", "ServiceReminder_escalation_attempts_check", "ServiceReminder_escalation_level_check", "ServiceReminder_status_check"]);
  });

  test("database rules: a reminder belongs to exactly one activity, once; statuses, levels, closing and acknowledgement are constrained", async () => {
    const { ticket, unit } = await makeTicket(W.northCo, off(-1));
    const base = { activityType: "ticket", customerId: W.northCo.customer.id, customerName: "x", activityRef: ticket.ticketNumber, dueDate: off(-1) };
    const visit = await prisma.amcVisit.create({ data: { amcOrderId: (await makeAmc(W.northCo, unit)).id, unitId: unit.id, dueDate: off(-1) } });
    await assert.rejects(prisma.serviceReminder.create({ data: { ...base } }), /activity_check|check constraint/i, "no activity");
    await assert.rejects(prisma.serviceReminder.create({ data: { ...base, complaintId: ticket.id, amcVisitId: visit.id } }), /activity_check|check constraint/i, "two activities");
    await assert.rejects(prisma.serviceReminder.create({ data: { ...base, activityType: "amc_visit", complaintId: ticket.id } }), /activity_check|check constraint/i, "type does not match the activity");
    const ok = await prisma.serviceReminder.create({ data: { ...base, complaintId: ticket.id } });
    await assert.rejects(prisma.serviceReminder.create({ data: { ...base, complaintId: ticket.id } }), (e: any) => e.code === "P2002", "one reminder per activity");
    const asVisit = await prisma.serviceReminder.create({ data: { ...base, activityType: "amc_visit", amcVisitId: visit.id } });
    await assert.rejects(prisma.serviceReminder.create({ data: { ...base, activityType: "amc_visit", amcVisitId: visit.id } }), (e: any) => e.code === "P2002");
    for (const [label, data, re] of [
      ["unknown status", { status: "done" }, /status_check/],
      ["level out of range", { escalationLevel: 3 }, /escalation_level_check/],
      ["closed without a time", { status: "closed" }, /closed_check/],
      ["acknowledged without a time", { status: "acknowledged" }, /ack_check/],
    ] as const) {
      await assert.rejects(prisma.serviceReminder.update({ where: { id: ok.id }, data }), re, label);
    }
    await assert.rejects(prisma.amcVisit.update({ where: { id: visit.id }, data: { status: "done" } }), /AmcVisit_status_check|check constraint/i);
    await assert.rejects(prisma.amcVisit.update({ where: { id: visit.id }, data: { status: "completed" } }), /AmcVisit_completed_check|check constraint/i, "completed needs its time");
    await assert.rejects(prisma.companySettings.upsert({ where: { id: "singleton" }, update: { reminderLeadDays: 999 }, create: { id: "singleton", reminderLeadDays: 999 } }), /reminder_policy_check|check constraint/i);
    await prisma.serviceReminder.deleteMany({ where: { id: { in: [ok.id, asVisit.id] } } });
  });

  async function makeAmc(w: any, unit: any) {
    const amc = await prisma.amcOrder.create({ data: { poNo: `${PREFIX}-PO${++seq}`, poDate: new Date("2026-04-01"), customerId: w.customer.id, location: "x", item: "RECD", qty: 1, amcFrequencyPerYear: 4, units: { create: [{ unitId: unit.id }] } } });
    tracked.amcIds.add(amc.id);
    return amc;
  }

  // ------------------------------------------------------------------------------------------
  // Region mapping
  // ------------------------------------------------------------------------------------------

  test("region mapping: Service Managers and Regional Managers can be mapped; engineers and inactive users cannot; every save is audited in the database", async () => {
    const r = await makeRegion("Map");
    const sm = await makeUser("sm-map", "service_manager");
    const off1 = await makeUser("sm-off", "service_manager", { isActive: false });
    assert.equal((await call(W.admin, "PUT", `/regions/${r.id}/managers`, { userIds: [sm.id, W.rm1.id] })).status, 200);
    assert.equal((await call(W.admin, "PUT", `/regions/${r.id}/managers`, { userIds: [W.eng.id] })).status, 400, "an engineer");
    assert.equal((await call(W.admin, "PUT", `/regions/${r.id}/managers`, { userIds: [off1.id] })).status, 400, "an inactive user");
    assert.equal((await call(W.admin, "PUT", `/regions/${r.id}/managers`, { userIds: ["nope"] })).status, 400);
    assert.deepEqual((await prisma.regionManager.findMany({ where: { regionId: r.id } })).map((m: any) => m.userId).sort(), [sm.id, W.rm1.id].sort(), "refused saves changed nothing");
    assert.equal((await call(W.sm1, "PUT", `/regions/${r.id}/managers`, { userIds: [] })).status, 403, "a Service Manager cannot change region mapping");
    await call(W.admin, "PUT", `/regions/${r.id}/managers`, { userIds: [sm.id] });
    const audit = await prisma.regionManagerAudit.findMany({ where: { regionId: r.id }, orderBy: { createdAt: "asc" } });
    assert.equal(audit.length, 2, "only the two successful saves");
    assert.deepEqual([audit[0].userIdsBefore, audit[0].userIdsAfter.sort(), audit[1].userIdsAfter], [[], [sm.id, W.rm1.id].sort(), [sm.id]]);
    assert.equal(audit[1].actorId, W.admin.id);
    const api = await call(W.admin, "GET", `/regions/${r.id}/audit`);
    assert.equal(api.body.length, 2);
    // one manager, several regions
    await call(W.admin, "PUT", `/regions/${W.south.id}/managers`, { userIds: [W.sm2.id, sm.id] });
    assert.equal(await prisma.regionManager.count({ where: { userId: sm.id } }), 2);
    await call(W.admin, "PUT", `/regions/${W.south.id}/managers`, { userIds: [W.sm2.id] });
    // deleting a region removes its mappings and audit rows
    await prisma.region.delete({ where: { id: r.id } });
    assert.equal(await prisma.regionManager.count({ where: { regionId: r.id } }) + (await prisma.regionManagerAudit.count({ where: { regionId: r.id } })), 0);
    tracked.regionIds.delete(r.id);
  });

  // ------------------------------------------------------------------------------------------
  // The job
  // ------------------------------------------------------------------------------------------

  test("job (policy off): nothing is created or sent", async () => {
    await setPolicy(null, null);
    await makeTicket(W.northCo, off(-3));
    const before = await prisma.notificationLog.count({ where: { recipientId: { in: [W.sm1.id, W.sm2.id, W.rm1.id] } } });
    const out = await runReminderJob(new Date());
    assert.equal(out.enabled, false);
    assert.equal(await prisma.serviceReminder.count({ where: { customerId: W.northCo.customer.id } }), 0);
    assert.equal(await prisma.notificationLog.count({ where: { recipientId: { in: [W.sm1.id, W.sm2.id, W.rm1.id] } } }), before);
  });

  test("job: reminders carry customer, site, serial and due date, go to the region's active Service Manager only, and record honest delivery per channel", async () => {
    await setPolicy(3, null);
    const north = await makeTicket(W.northCo, off(-2));
    const south = await makeTicket(W.southCo, off(1));
    const nodate = await makeTicket(W.northCo, null);
    const far = await makeTicket(W.northCo, off(60));
    const noSerial = await makeTicket(W.northCo, off(-1), "open", null);
    const finished = await makeTicket(W.northCo, off(-4), "closed");
    await runReminderJob(new Date());
    const ids = [north, south, nodate, far, noSerial, finished].map((x) => x.ticket.id);
    const created = await prisma.serviceReminder.findMany({ where: mine(ids) });
    assert.deepEqual(created.map((r: any) => r.activityRef).sort(), [north, south, noSerial].map((x) => x.ticket.ticketNumber).sort(), "undated, far-off and finished tickets are not reminded");

    const r = await reminderOf(north.ticket.id);
    assert.deepEqual([r.status, r.regionId, r.customerName, r.siteName, r.unitSerialNo, r.dueDate.toISOString().slice(0, 10)], ["sent", W.north.id, `${PREFIX} N Ltd`, `${PREFIX} N Plant`, north.unit.serialNo, iso(-2)]);
    const logs = await prisma.notificationLog.findMany({ where: { templateKey: "service_reminder", payload: { path: ["activityRef"], equals: north.ticket.ticketNumber } } });
    assert.deepEqual([...new Set(logs.map((l: any) => l.recipientId))], [W.sm1.id], "the active Service Manager of North - not the Regional Manager, not South's manager, not the engineer");
    assert.deepEqual(logs.map((l: any) => [l.channel, l.status]).sort(), [["email", "sent"], ["in_app", "sent"]], "e-mail accepted (stub), in-app row written");
    const p = logs.find((l: any) => l.channel === "in_app").payload;
    assert.deepEqual([p.customerName, p.siteName, p.serialNo, p.dueDate, p.activityRef], [`${PREFIX} N Ltd`, `${PREFIX} N Plant`, north.unit.serialNo, iso(-2), north.ticket.ticketNumber]);
    const southLogs = await prisma.notificationLog.findMany({ where: { templateKey: "service_reminder", payload: { path: ["activityRef"], equals: south.ticket.ticketNumber } } });
    assert.deepEqual([...new Set(southLogs.map((l: any) => l.recipientId))], [W.sm2.id]);
    const missing = await prisma.notificationLog.findFirst({ where: { templateKey: "service_reminder", channel: "in_app", payload: { path: ["activityRef"], equals: noSerial.ticket.ticketNumber } } });
    assert.equal(missing.payload.serialNo, null, "a missing serial is stated as missing, not borrowed");
    assert.equal((await reminderOf(noSerial.ticket.id)).unitSerialNo, null);
    const evs = await eventsOf(r.id);
    assert.deepEqual(evs.map((e: any) => e.type), ["created", "sent", "in_app_recorded"], "the e-mail is the delivery; the in-app row is a separate, labelled record");
    assert.ok(evs.every((e: any) => e.type === "created" || e.recipientId === W.sm1.id));
  });

  test("job: a region without an active manager, and an activity without a region, are 'no recipient' - sent to no one - and retried when a manager appears", async () => {
    await setPolicy(3, null);
    const empty = await makeRegion("Empty");
    const emptyCo = await makeCustomer("E", empty);
    const a = await makeTicket(emptyCo, off(-1));
    const b = await makeTicket(W.noRegionCo, off(-1));
    await call(W.admin, "PUT", `/regions/${empty.id}/managers`, { userIds: [] });
    await runReminderJob(new Date());
    const ra = await reminderOf(a.ticket.id);
    const rb = await reminderOf(b.ticket.id);
    assert.deepEqual([ra.status, ra.statusReason, rb.status, rb.statusReason], ["no_recipient", "no_active_manager", "no_recipient", "no_region"]);
    assert.equal(await prisma.notificationLog.count({ where: { payload: { path: ["activityRef"], equals: a.ticket.ticketNumber } } }), 0);
    await call(W.admin, "PUT", `/regions/${empty.id}/managers`, { userIds: [W.sm2.id] });
    await runReminderJob(new Date());
    assert.equal((await reminderOf(a.ticket.id)).status, "sent", "retried on the next run");
    assert.equal((await reminderOf(b.ticket.id)).status, "no_recipient");
    await call(W.admin, "PUT", `/regions/${empty.id}/managers`, { userIds: [] });
  });

  test("job: overlapping runs create one reminder per activity and notify each person once", async () => {
    await setPolicy(3, null);
    const t = await makeTicket(W.northCo, off(-5));
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date()), runReminderJob(new Date()), runReminderJob(new Date())]);
    await runReminderJob(new Date());
    assert.equal(await prisma.serviceReminder.count({ where: { complaintId: t.ticket.id } }), 1);
    const inApp = await prisma.notificationLog.count({ where: { templateKey: "service_reminder", channel: "in_app", recipientId: W.sm1.id, payload: { path: ["activityRef"], equals: t.ticket.ticketNumber } } });
    assert.equal(inApp, 1, "one in-app reminder for the manager, however many runs");
    assert.equal((await eventsOf((await reminderOf(t.ticket.id)).id, "created")).length, 1);
  });

  test("job: finishing the activity closes the reminder (and satisfies the closing CHECK); a later run sends and escalates nothing for it", async () => {
    await setPolicy(3, 1);
    const t = await makeTicket(W.northCo, off(-6));
    await runReminderJob(new Date());
    await prisma.complaint.update({ where: { id: t.ticket.id }, data: { status: "resolved" } });
    const out = await runReminderJob(new Date(Date.now() + 10 * 3600 * 1000));
    assert.ok(out.closed >= 1);
    const r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.status, r.escalationLevel], ["closed", 0]);
    assert.ok(r.closedAt);
    assert.equal(await prisma.notificationLog.count({ where: { templateKey: "service_reminder_escalated", payload: { path: ["activityRef"], equals: t.ticket.ticketNumber } } }), 0);
  });

  test("AMC visits: a scheduled visit is reminded with its unit's serial and site; a completed one closes; the contract expiry is not a visit", async () => {
    await setPolicy(3, null);
    const unit = await W.northCo.newUnit();
    const amc = await makeAmc(W.northCo, unit);
    await prisma.amcOrder.update({ where: { id: amc.id }, data: { poDate: new Date("2020-01-01") } }); // long expired contract, but no visit
    await runReminderJob(new Date());
    assert.equal(await prisma.serviceReminder.count({ where: { activityType: "amc_visit", customerId: W.northCo.customer.id, unitId: unit.id } }), 0, "no visit, no reminder - whatever the expiry");

    const v = await call(W.admin, "POST", "/amc-visits", { amcOrderId: amc.id, unitId: unit.id, dueDate: iso(-1) });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    await runReminderJob(new Date());
    const r = await prisma.serviceReminder.findUniqueOrThrow({ where: { amcVisitId: v.body.id } });
    assert.deepEqual([r.activityType, r.status, r.unitSerialNo, r.siteName, r.regionId], ["amc_visit", "sent", unit.serialNo, `${PREFIX} N Plant`, W.north.id]);
    assert.equal((await call(W.admin, "PATCH", `/amc-visits/${v.body.id}`, { status: "completed" })).status, 200);
    await runReminderJob(new Date());
    assert.equal((await prisma.serviceReminder.findUniqueOrThrow({ where: { id: r.id } })).status, "closed");
    // visits for units the order does not cover, or of another customer, are refused
    const other = await W.southCo.newUnit();
    assert.equal((await call(W.admin, "POST", "/amc-visits", { amcOrderId: amc.id, unitId: other.id, dueDate: iso(5) })).body.code, "UNIT_NOT_IN_AMC");
    assert.equal(await prisma.amcVisit.count({ where: { amcOrderId: amc.id } }), 1);
    // a covered unit cannot be removed while visits exist
    await assert.rejects(prisma.recdUnit.delete({ where: { id: unit.id } }), (e: any) => e.code === "P2003");
  });

  // ------------------------------------------------------------------------------------------
  // Acknowledgement and escalation
  // ------------------------------------------------------------------------------------------

  test("escalation: unacknowledged reminders go to the Regional Manager, then Management, each level once - even with overlapping runs", async () => {
    await setPolicy(3, 24);
    const t = await makeTicket(W.northCo, off(-2));
    await runReminderJob(new Date());
    const rem = await reminderOf(t.ticket.id);
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { sentAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date()), runReminderJob(new Date())]);
    let r = await reminderOf(t.ticket.id);
    assert.equal(r.escalationLevel, 1);
    const l1 = await prisma.notificationLog.findMany({ where: { templateKey: "service_reminder_escalated", channel: "in_app", payload: { path: ["activityRef"], equals: t.ticket.ticketNumber } } });
    assert.deepEqual(l1.map((l: any) => l.recipientId), [W.rm1.id], "level 1: exactly one message to North's Regional Manager");
    assert.deepEqual([l1[0].payload.customerName, l1[0].payload.siteName, l1[0].payload.serialNo, l1[0].payload.dueDate], [`${PREFIX} N Ltd`, `${PREFIX} N Plant`, t.unit.serialNo, iso(-2)]);
    assert.equal((await eventsOf(r.id, "escalated")).length, 1);

    await prisma.serviceReminder.update({ where: { id: r.id }, data: { lastEscalatedAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date())]);
    r = await reminderOf(t.ticket.id);
    assert.equal(r.escalationLevel, 2);
    const l2 = await prisma.notificationLog.findMany({ where: { templateKey: "service_reminder_escalated", channel: "in_app", payload: { path: ["activityRef"], equals: t.ticket.ticketNumber } } });
    assert.ok(l2.some((l: any) => l.recipientId === W.mgmt.id), "level 2 reaches Management");
    assert.deepEqual((await eventsOf(r.id, "escalated")).map((e: any) => e.level), [1, 2]);
    await prisma.serviceReminder.update({ where: { id: r.id }, data: { lastEscalatedAt: new Date(Date.now() - 500 * 3600 * 1000) } });
    await runReminderJob(new Date());
    assert.equal((await reminderOf(t.ticket.id)).escalationLevel, 2, "never beyond level 2");
  });

  test("acknowledgement: recorded with who and when; simultaneous acknowledgements record one; an acknowledged reminder is not escalated", async () => {
    await setPolicy(3, 24);
    const t = await makeTicket(W.northCo, off(-2));
    await runReminderJob(new Date());
    const rem = await reminderOf(t.ticket.id);
    const results = await Promise.all([W.sm1, W.rm1, W.admin, W.sm1].map((u) => call(u, "POST", `/reminders/${rem.id}/acknowledge`)));
    assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
    assert.equal((await eventsOf(rem.id, "acknowledged")).length, 1);
    const r = await reminderOf(t.ticket.id);
    assert.equal(r.status, "acknowledged");
    assert.ok(r.acknowledgedAt && r.acknowledgedById);
    await prisma.serviceReminder.update({ where: { id: r.id }, data: { sentAt: new Date(Date.now() - 100 * 3600 * 1000) } });
    await runReminderJob(new Date());
    assert.equal((await reminderOf(t.ticket.id)).escalationLevel, 0);
    // outside the region / wrong roles
    const southT = await makeTicket(W.southCo, off(-2));
    await runReminderJob(new Date());
    const southRem = await reminderOf(southT.ticket.id);
    assert.equal((await call(W.sm1, "POST", `/reminders/${southRem.id}/acknowledge`)).status, 403, "North manager, South reminder");
    assert.equal((await call(W.eng, "POST", `/reminders/${southRem.id}/acknowledge`)).status, 403);
  });


  // ------------------------------------------------------------------------------------------
  // Delivery status, per-recipient retries, retryable escalation, acknowledgement gating (real database)
  // ------------------------------------------------------------------------------------------

  const addNorthManager = async (tag: string) => {
    const u = await makeUser(tag, "service_manager");
    await prisma.regionManager.create({ data: { regionId: W.north.id, userId: u.id } });
    return u;
  };

  test("delivery status: with the REAL e-mail provider and no SMTP nothing is delivered - the reminder is 'failed' and cannot be acknowledged; the in-app row is only a record", async () => {
    await setPolicy(3, null);
    providers.email = realEmailProvider; // no SMTP in this process
    let t: any;
    try {
      t = await makeTicket(W.northCo, off(-2));
      await runReminderJob(new Date());
    } finally {
      providers.email = { channel: "email", send: async ({ recipientId, templateKey }: any) => { if (emailFail.has(recipientId)) return false; emailSent.push(`${recipientId}:${templateKey}`); return true; } };
    }
    const r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.status, r.statusReason, r.sentAt], ["failed", "delivery_failed", null]);
    const evs = await eventsOf(r.id);
    assert.ok(evs.some((e: any) => e.type === "in_app_recorded" && e.channel === "in_app"));
    assert.ok(evs.some((e: any) => e.type === "delivery_failed" && e.channel === "email"));
    assert.ok(!evs.some((e: any) => e.type === "sent"));
    const ack = await call(W.sm1, "POST", `/reminders/${r.id}/acknowledge`);
    assert.deepEqual([ack.status, ack.body.code], [409, "REMINDER_NOT_DELIVERED"]);
    assert.equal((await reminderOf(t.ticket.id)).acknowledgedAt, null);
    // once a mail server accepts it, the next run delivers it and it can be acknowledged
    await runReminderJob(new Date());
    assert.equal((await reminderOf(t.ticket.id)).status, "sent");
    assert.equal((await call(W.sm1, "POST", `/reminders/${r.id}/acknowledge`)).status, 200);
  });

  test("first reminder: partial failure keeps the delivered recipient, retries only the failed one, and never e-mails anyone twice - even with overlapping runs", async () => {
    await setPolicy(3, null);
    const smB = await addNorthManager("sm-north-b");
    emailFail.add(smB.id);
    const t = await makeTicket(W.northCo, off(-2));
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date())]);
    let r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.status, r.statusReason, r.sentAt], ["failed", "partial_delivery", null]);
    const mailed = (id: string) => emailSent.filter((x) => x === `${id}:service_reminder`).length;
    const sm1Before = mailed(W.sm1.id);
    assert.ok(sm1Before >= 1);
    const evA = await eventsOf(r.id, "sent");
    assert.deepEqual(evA.map((e: any) => e.recipientId), [W.sm1.id], "one delivery event, for the recipient that was reached");

    emailFail.delete(smB.id);
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date())]);
    r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.status, r.statusReason], ["sent", null]);
    assert.ok(r.sentAt);
    assert.equal(mailed(W.sm1.id), sm1Before, "the recipient who already had it was not e-mailed again");
    const sent = await eventsOf(r.id, "sent");
    assert.deepEqual(sent.map((e: any) => e.recipientId).sort(), [W.sm1.id, smB.id].sort(), "exactly one successful delivery per recipient");
    const failed = await eventsOf(r.id, "delivery_failed");
    assert.ok(failed.length >= 1 && failed.every((e: any) => e.recipientId === smB.id && e.channel === "email" && typeof e.detail.attempt === "number"), "each failed attempt is recorded with its attempt number");
    assert.ok(r.attempts <= 5, "the retry limit still applies");
    await prisma.regionManager.deleteMany({ where: { regionId: W.north.id, userId: smB.id } });
  });

  test("escalation: a failed delivery does not consume the level; it is retried, delivered once (even with overlapping runs), and recorded per attempt", async () => {
    await setPolicy(3, 24);
    const t = await makeTicket(W.northCo, off(-2));
    await runReminderJob(new Date());
    const rem = await reminderOf(t.ticket.id);
    assert.equal(rem.status, "sent");
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { sentAt: new Date(Date.now() - 25 * 3600 * 1000) } });

    emailFail.add(W.rm1.id); // level 1 goes to North's Regional Manager
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date())]);
    let r = await reminderOf(t.ticket.id);
    assert.equal(r.escalationLevel, 0, "the level is not claimed while nobody was reached");
    assert.equal(r.escalationAttempts, 1, "one attempt, even though two runs overlapped");
    assert.equal(r.escalationClaimedAt, null, "the lease is released so the next run can retry");
    assert.equal((await eventsOf(r.id, "escalated")).length, 0);
    const failedAttempt = (await eventsOf(r.id, "delivery_failed")).filter((e: any) => e.level === 1 && e.recipientId === W.rm1.id);
    assert.deepEqual(failedAttempt.map((e: any) => e.detail.attempt), [1]);

    emailFail.delete(W.rm1.id);
    await Promise.all([runReminderJob(new Date()), runReminderJob(new Date()), runReminderJob(new Date())]);
    r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.escalationLevel, r.escalationAttempts], [1, 0]);
    assert.ok(r.lastEscalatedAt);
    const delivered = (await eventsOf(r.id, "sent")).filter((e: any) => e.level === 1 && e.recipientId === W.rm1.id);
    assert.equal(delivered.length, 1, "delivered exactly once");
    assert.equal(emailSent.filter((x) => x === `${W.rm1.id}:service_reminder_escalated`).length >= 1, true);
    assert.equal((await eventsOf(r.id, "escalated")).filter((e: any) => e.level === 1).length, 1);
  });

  test("escalation: retries stop after the attempt limit, and a stale lease (a dead run) can be taken over while a fresh one cannot", async () => {
    await setPolicy(3, 24);
    const t = await makeTicket(W.northCo, off(-2));
    await runReminderJob(new Date());
    const rem = await reminderOf(t.ticket.id);
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { sentAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    emailFail.add(W.rm1.id);
    for (let i = 0; i < 8; i++) await runReminderJob(new Date());
    let r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.escalationLevel, r.escalationAttempts], [0, 5], "the existing limit of five attempts");
    emailFail.delete(W.rm1.id);

    // fresh lease (a run is working on it) blocks; a lease older than the timeout is taken over
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { escalationAttempts: 0, escalationClaimedAt: new Date(Date.now() - 2 * 60_000) } });
    await runReminderJob(new Date());
    r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.escalationLevel, r.escalationAttempts], [0, 0], "fresh lease: skipped");
    await prisma.serviceReminder.update({ where: { id: rem.id }, data: { escalationClaimedAt: new Date(Date.now() - 20 * 60_000) } });
    await runReminderJob(new Date());
    r = await reminderOf(t.ticket.id);
    assert.equal(r.escalationLevel, 1, "stale lease: taken over and delivered");
  });

  test("acknowledgement: only a delivered reminder can be acknowledged - waiting, failed, partly delivered and no-recipient reminders are refused by the server, and a race on a delivered one records one", async () => {
    await setPolicy(3, null);
    const smB = await addNorthManager("sm-north-c");
    emailFail.add(smB.id);
    const t = await makeTicket(W.northCo, off(-2));
    await runReminderJob(new Date());
    const r = await reminderOf(t.ticket.id);
    assert.deepEqual([r.status, r.statusReason], ["failed", "partial_delivery"]);
    for (const status of ["pending", "sending", "failed", "no_recipient"]) {
      await prisma.serviceReminder.update({ where: { id: r.id }, data: { status, statusReason: status === "no_recipient" ? "no_active_manager" : null } });
      const x = await call(W.sm1, "POST", `/reminders/${r.id}/acknowledge`);
      assert.deepEqual([x.status, x.body.code], [409, "REMINDER_NOT_DELIVERED"], status);
    }
    assert.equal((await reminderOf(t.ticket.id)).acknowledgedAt, null);
    assert.equal((await eventsOf(r.id, "acknowledged")).length, 0);
    assert.equal((await call(W.eng, "POST", `/reminders/${r.id}/acknowledge`)).status, 403, "permissions still come first");

    emailFail.delete(smB.id);
    await prisma.serviceReminder.update({ where: { id: r.id }, data: { status: "failed", statusReason: "partial_delivery" } });
    await runReminderJob(new Date());
    assert.equal((await reminderOf(t.ticket.id)).status, "sent");
    const results = await Promise.all([W.sm1, W.rm1, W.admin, smB].map((u) => call(u, "POST", `/reminders/${r.id}/acknowledge`)));
    assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
    assert.equal((await eventsOf(r.id, "acknowledged")).length, 1);
    await prisma.regionManager.deleteMany({ where: { regionId: W.north.id, userId: smB.id } });
  });

  test("approved workflow (3 days, 24 h per stage) in a real database: first reminder at the lead time, Regional Manager 24 h after delivery, Management 24 h after that, timed from the delivery events", async () => {
    await setPolicy(3, 24); // the proposed values; restored to the original (empty) policy when the run ends
    const HOUR = 3600 * 1000;
    const base = new Date();
    const at = (h: number) => new Date(base.getTime() + h * HOUR);
    const inWindow = await makeTicket(W.northCo, off(3)); // due in 3 calendar days: eligible
    const early = await makeTicket(W.northCo, off(5)); // due in 5 days: too early
    await runReminderJob(base);
    const rem = await reminderOf(inWindow.ticket.id);
    assert.ok(rem, "a reminder exists at the 3-day lead time");
    assert.equal(await reminderOf(early.ticket.id), null, "none before the lead time");
    assert.deepEqual([rem.status, rem.regionId], ["sent", W.north.id]);
    const firstTo = (await eventsOf(rem.id, "sent")).filter((e: any) => e.level === 0).map((e: any) => e.recipientId);
    assert.deepEqual(firstTo, [W.sm1.id], "the region's active Service Manager");
    const sentAt = rem.sentAt as Date;

    await runReminderJob(at(23));
    assert.equal((await reminderOf(inWindow.ticket.id)).escalationLevel, 0, "23 h after delivery: too early");
    await runReminderJob(at(30)); // delivered late, at 30 h
    let r = await reminderOf(inWindow.ticket.id);
    assert.equal(r.escalationLevel, 1);
    assert.equal(r.lastEscalatedAt.getTime(), at(30).getTime(), "the next clock starts when this stage was delivered");
    const stage2 = (await eventsOf(r.id, "sent")).filter((e: any) => e.level === 1).map((e: any) => e.recipientId);
    assert.deepEqual(stage2, [W.rm1.id], "stage 2: the region's Regional Manager");

    await runReminderJob(at(53));
    assert.equal((await reminderOf(inWindow.ticket.id)).escalationLevel, 1, "23 h after the escalation: too early (48 h after delivery does not count)");
    await Promise.all([runReminderJob(at(54)), runReminderJob(at(54)), runReminderJob(at(54))]);
    r = await reminderOf(inWindow.ticket.id);
    assert.equal(r.escalationLevel, 2);
    const stage3 = (await eventsOf(r.id, "sent")).filter((e: any) => e.level === 2).map((e: any) => e.recipientId);
    assert.ok(stage3.includes(W.mgmt.id), "stage 3: Management");
    assert.equal(new Set(stage3).size, stage3.length, "one successful delivery per recipient despite three overlapping runs");
    assert.deepEqual((await eventsOf(r.id, "escalated")).map((e: any) => [e.level, e.detail.attempt]), [[1, 1], [2, 1]], "each stage is recorded with its attempt");
    assert.ok(sentAt.getTime() <= at(1).getTime());
    await runReminderJob(at(500));
    assert.equal((await reminderOf(inWindow.ticket.id)).escalationLevel, 2, "never beyond stage 3");
  });

  // ------------------------------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------------------------------

  test("dashboard: the real scope rules - a mapped Service Manager sees only their region; Management sees all; roles without access are refused", async () => {
    await setPolicy(3, null);
    const a = await makeTicket(W.northCo, off(-1));
    const b = await makeTicket(W.southCo, off(-1));
    await runReminderJob(new Date());
    const refsFor = async (u: any, q = "") => (await call(u, "GET", `/reminders${q}`)).body.rows.map((x: any) => x.activityRef);
    const north = await refsFor(W.sm1);
    assert.ok(north.includes(a.ticket.ticketNumber) && !north.includes(b.ticket.ticketNumber));
    const south = await refsFor(W.sm2);
    assert.ok(south.includes(b.ticket.ticketNumber) && !south.includes(a.ticket.ticketNumber));
    assert.ok(!(await refsFor(W.sm2, `?regionId=${W.north.id}`)).includes(a.ticket.ticketNumber), "asking for another region does not widen the scope");
    const all = await refsFor(W.mgmt);
    assert.ok(all.includes(a.ticket.ticketNumber) && all.includes(b.ticket.ticketNumber));
    const row = (await call(W.mgmt, "GET", `/reminders?regionId=${W.north.id}`)).body.rows.find((x: any) => x.activityRef === a.ticket.ticketNumber);
    assert.deepEqual([row.customerName, row.siteName, row.serialNo, row.dueDate, row.state, row.regionName, row.reminder.status], [`${PREFIX} N Ltd`, `${PREFIX} N Plant`, a.unit.serialNo, iso(-1), "overdue", `${PREFIX} North`, "sent"]);
    assert.ok(row.managers.some((m: any) => m.id === W.sm1.id));
    assert.equal((await call(W.eng, "GET", "/reminders")).status, 403);
    const cust = await makeUser("customer", "customer", { customerId: W.northCo.customer.id });
    assert.equal((await call(cust, "GET", "/reminders")).status, 403);
    assert.equal((await call(null, "GET", "/reminders")).status, 401);
  });

  test("ticket due date: set by a manager within their region and audited; the job then reminds; other regions are refused", async () => {
    await setPolicy(3, null);
    const t = await makeTicket(W.northCo, null);
    assert.equal((await call(W.sm2, "PUT", `/reminders/tickets/${t.ticket.id}/due-date`, { dueDate: iso(-1) })).status, 403, "South manager, North ticket");
    assert.equal((await call(W.sm1, "PUT", `/reminders/tickets/${t.ticket.id}/due-date`, { dueDate: iso(-1) })).status, 200);
    assert.equal((await prisma.complaint.findUniqueOrThrow({ where: { id: t.ticket.id } })).dueDate.toISOString().slice(0, 10), iso(-1));
    const ev = await prisma.complaintEvent.findFirstOrThrow({ where: { complaintId: t.ticket.id, type: "due_date_set" } });
    assert.deepEqual([ev.actorId, ev.toValue], [W.sm1.id, iso(-1)]);
    await runReminderJob(new Date());
    assert.equal((await reminderOf(t.ticket.id)).status, "sent");
  });
});

test("the reminder database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  for (const bad of ["postgresql://u:p@localhost:5432/platino_test", "postgresql://u:p@localhost:5434/postgres", "postgresql://u:p@db.example.com:5434/platino_test", "", undefined]) {
    assert.equal(pointsAtIsolatedDb(bad), false);
  }
});
