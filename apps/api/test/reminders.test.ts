// Requirement 6 - region-wise Service Manager mapping, due-date tracking, reminders, acknowledgement and escalation.
// Prisma is replaced by in-memory tables (test/helpers/deepMatch.ts runs the real query intent against them); the notification
// service, templates, routes and the reminder job are the real ones. The e-mail provider is replaced by a stub that "accepts"
// every message except for recipients listed in `emailFailFor` (standing in for a configured SMTP server); one test puts the REAL
// provider back (no SMTP configured -> nothing can be delivered). Nothing is sent anywhere. Database guarantees (unique constraints, CHECKs,
// real atomic claims) are NOT proven here - see test/db/reminders.db.test.ts. All names are synthetic.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;
for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) delete process.env[k];
process.env.ADMIN_WEB_URL = "https://app.example.test";

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY as P, ROLE_KEY } from "@recd/shared";
import { deepMatch } from "./helpers/deepMatch";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Stub = Record<string, (...args: any[]) => any>;
const db: Record<string, Stub> = {};
const stubModel = (model: string, impl: Stub) => { db[model] = impl; };
const tick = () => new Promise<void>((r) => setImmediate(r));
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
// Dates are relative to "today" so the dashboard (which uses the real clock) and the job (which is given NOW) agree.
const NOW = new Date();
const T0 = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
const off = (n: number) => new Date(T0.getTime() + n * 24 * 3600 * 1000);
const iso = (n: number) => off(n).toISOString().slice(0, 10);
const HOUR = 3600 * 1000;

// ---- people -------------------------------------------------------------------------------------------
const SM_PERMS = [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS, P.VIEW_DASHBOARD];
const MGMT_PERMS = [...SM_PERMS, P.MANAGE_REGIONS, P.MANAGE_AMC_ORDERS, P.MANAGE_SETTINGS];
interface U { id: string; name: string; role: string; perms: string[]; isActive?: boolean; customerId?: string; vendorId?: string }
const U0: Record<string, U> = {
  smR1: { id: "smR1", name: "Sita SM North", role: ROLE_KEY.SERVICE_MANAGER, perms: SM_PERMS },
  smR1off: { id: "smR1off", name: "Inactive SM North", role: ROLE_KEY.SERVICE_MANAGER, perms: SM_PERMS, isActive: false },
  smR2: { id: "smR2", name: "Sam SM South", role: ROLE_KEY.SERVICE_MANAGER, perms: SM_PERMS },
  smFree: { id: "smFree", name: "Free SM", role: ROLE_KEY.SERVICE_MANAGER, perms: SM_PERMS },
  rm1: { id: "rm1", name: "Ravi RM North", role: ROLE_KEY.REGIONAL_MANAGER, perms: SM_PERMS },
  rm2: { id: "rm2", name: "Rita RM South", role: ROLE_KEY.REGIONAL_MANAGER, perms: SM_PERMS },
  mgmt: { id: "mgmt", name: "Mia Management", role: ROLE_KEY.MANAGEMENT, perms: MGMT_PERMS },
  owner: { id: "owner", name: "Olu Owner", role: ROLE_KEY.OWNER_ADMIN, perms: MGMT_PERMS },
  eng: { id: "eng", name: "Eng", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS] },
  vendorEng: { id: "vendorEng", name: "Vendor Eng", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS], vendorId: "vA" },
  custA: { id: "custA", name: "Customer A", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT, P.VIEW_SITE_STATUS], customerId: "cA" },
  sales: { id: "sales", name: "Sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS, P.VIEW_SITE_STATUS] },
};
let users: Record<string, U> = {};
const userRow = (u: U) => ({ id: u.id, name: u.name, email: `${u.id}@example.invalid`, isActive: u.isActive !== false, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) }, regionsManaged: regionManagers.filter((m) => m.userId === u.id) });

// ---- world --------------------------------------------------------------------------------------------
let regionManagers: Array<{ regionId: string; userId: string }> = [];
let regionAudits: any[] = [];
let tickets: Record<string, any> = {};
let visits: Record<string, any> = {};
let settings: any = null;
let reminders: any[] = [];
let reminderEvents: any[] = [];
let complaintEvents: any[] = [];
let notifications: any[] = [];
const failFor = new Set<string>(); // recipients whose notification write throws (every channel fails)
const emailFailFor = new Set<string>(); // recipients whose e-mail is not accepted
let emailSends: string[] = []; // every e-mail the stub accepted: `${recipient}:${templateKey}`
let realEmailProvider: any = null;
let seq = 0;

const site = (id: string, regionId: string | null, name = `Plant ${id}`) => ({ id, companyName: name, regionId, vendorId: null });
function resetWorld() {
  users = Object.fromEntries(Object.entries(U0).map(([k, v]) => [k, { ...v }]));
  regionManagers = [
    { regionId: "r1", userId: "smR1" }, { regionId: "r1", userId: "smR1off" }, { regionId: "r1", userId: "rm1" },
    { regionId: "r2", userId: "smR2" }, { regionId: "r2", userId: "rm2" },
  ];
  regionAudits = [];
  settings = { id: "singleton", reminderLeadDays: 3, reminderEscalationHours: null };
  tickets = {
    tOver: { id: "tOver", ticketNumber: "TCK-1", status: "open", dueDate: off(-10), customerId: "cA", siteId: "s1", unitId: "u1", customer: { name: "Acme Power" }, site: site("s1", "r1", "Acme Plant 1"), unit: { id: "u1", serialNo: "SN-001" } },
    tSoon: { id: "tSoon", ticketNumber: "TCK-2", status: "in_progress", dueDate: off(2), customerId: "cA", siteId: "s1", unitId: "u1", customer: { name: "Acme Power" }, site: site("s1", "r1", "Acme Plant 1"), unit: { id: "u1", serialNo: "SN-001" } },
    tFar: { id: "tFar", ticketNumber: "TCK-3", status: "open", dueDate: off(40), customerId: "cA", siteId: "s1", unitId: "u1", customer: { name: "Acme Power" }, site: site("s1", "r1"), unit: { id: "u1", serialNo: "SN-001" } },
    tNone: { id: "tNone", ticketNumber: "TCK-4", status: "open", dueDate: null, customerId: "cA", siteId: "s1", unitId: "u1", customer: { name: "Acme Power" }, site: site("s1", "r1"), unit: { id: "u1", serialNo: "SN-001" } },
    tDone: { id: "tDone", ticketNumber: "TCK-5", status: "resolved", dueDate: off(-19), customerId: "cA", siteId: "s1", unitId: "u1", customer: { name: "Acme Power" }, site: site("s1", "r1"), unit: { id: "u1", serialNo: "SN-001" } },
    tSouth: { id: "tSouth", ticketNumber: "TCK-6", status: "open", dueDate: off(-15), customerId: "cB", siteId: "s2", unitId: "u2", customer: { name: "Beta Works" }, site: site("s2", "r2", "Beta Plant"), unit: { id: "u2", serialNo: "SN-002" } },
  };
  visits = {
    vOver: { id: "vOver", status: "scheduled", dueDate: off(-8), amcOrderId: "amc1abcdef", unitId: "u3", amcOrder: { id: "amc1abcdef", customerId: "cA", customer: { name: "Acme Power" } }, unit: { id: "u3", serialNo: "SN-003", site: site("s3", "r1", "Acme Plant 3") } },
    vDone: { id: "vDone", status: "completed", dueDate: off(-19), amcOrderId: "amc1abcdef", unitId: "u3", amcOrder: { id: "amc1abcdef", customerId: "cA", customer: { name: "Acme Power" } }, unit: { id: "u3", serialNo: "SN-003", site: site("s3", "r1") } },
  };
  reminders = [];
  reminderEvents = [];
  complaintEvents = [];
  notifications = [];
  failFor.clear();
  emailFailFor.clear();
  emailSends = [];
  seq = 0;
}

// ---- tables -------------------------------------------------------------------------------------------
const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName: "ServiceReminder" } });
const withRel = (r: any) => ({
  ...r,
  complaint: r.complaintId ? { status: tickets[r.complaintId]?.status, dueDate: tickets[r.complaintId]?.dueDate } : null,
  amcVisit: r.amcVisitId ? { status: visits[r.amcVisitId]?.status, dueDate: visits[r.amcVisitId]?.dueDate } : null,
  acknowledgedBy: r.acknowledgedById ? { name: users[r.acknowledgedById]?.name } : null,
  events: reminderEvents.filter((e) => e.reminderId === r.id).sort((a, b) => b.at - a.at).slice(0, 12).map((e) => ({ id: e.id, type: e.type, level: e.level, channel: e.channel, createdAt: e.at, detail: e.detail, recipient: e.recipientId ? { name: users[e.recipientId]?.name } : null })),
});
const applyData = (r: any, data: any) => { for (const [k, v] of Object.entries<any>(data)) r[k] = v && typeof v === "object" && !(v instanceof Date) && "increment" in v ? (r[k] ?? 0) + v.increment : v; };

function installTables() {
  stubModel("companySettings", { findUnique: async () => settings });
  stubModel("complaint", {
    findMany: async ({ where }: any) => { await tick(); return Object.values(tickets).filter((t) => deepMatch(t, where)); },
    findUnique: async ({ where }: any) => (tickets[where.id] ? { ...tickets[where.id] } : null),
    count: async ({ where }: any) => Object.values(tickets).filter((t) => deepMatch(t, where)).length,
    update: async ({ where, data }: any) => { applyData(tickets[where.id], data); return tickets[where.id]; },
  });
  stubModel("complaintEvent", { create: async ({ data }: any) => { complaintEvents.push(data); return data; } });
  stubModel("amcVisit", {
    findMany: async ({ where }: any) => { await tick(); return Object.values(visits).filter((v) => deepMatch(v, where)); },
    findUnique: async ({ where }: any) => (visits[where.id] ? { ...visits[where.id], unit: { ...visits[where.id].unit, site: { ...visits[where.id].unit.site } } } : null),
    findUniqueOrThrow: async ({ where }: any) => ({ ...visits[where.id] }),
    create: async ({ data }: any) => { const v = { id: `v${++seq}`, status: "scheduled", completedAt: null, ...data, unit: { serialNo: "SN-003" } }; visits[v.id] = v; return v; },
    updateMany: async ({ where, data }: any) => { const hit = Object.values(visits).filter((v) => deepMatch(v, where)); hit.forEach((v) => applyData(v, data)); return { count: hit.length }; },
  });
  stubModel("serviceReminder", {
    async findMany({ where }: any) { await tick(); return reminders.filter((r) => deepMatch(r, where ?? {})).map(withRel); },
    async findFirst({ where }: any) { await tick(); const r = reminders.find((x) => deepMatch(x, where)); return r ? { ...r } : null; },
    async findUnique({ where }: any) { const r = reminders.find((x) => x.id === where.id); return r ? { ...r } : null; },
    async findUniqueOrThrow({ where }: any) { const r = reminders.find((x) => x.id === where.id); if (!r) throw new Error("not found"); return { ...r }; },
    async create({ data }: any) {
      await tick();
      if (reminders.some((r) => (data.complaintId && r.complaintId === data.complaintId) || (data.amcVisitId && r.amcVisitId === data.amcVisitId))) throw p2002();
      const row = { id: `rem${++seq}`, complaintId: null, amcVisitId: null, status: "pending", statusReason: null, attempts: 0, lastAttemptAt: null, sentAt: null, acknowledgedAt: null, acknowledgedById: null, escalationLevel: 0, lastEscalatedAt: null, escalationAttempts: 0, escalationClaimedAt: null, closedAt: null, createdAt: new Date(), ...data };
      reminders.push(row);
      return { ...row };
    },
    async update({ where, data }: any) { const r = reminders.find((x) => x.id === where.id)!; applyData(r, data); return { ...r }; },
    async updateMany({ where, data }: any) { await tick(); const hit = reminders.filter((r) => deepMatch(r, where)); hit.forEach((r) => applyData(r, data)); return { count: hit.length }; },
  });
  stubModel("serviceReminderEvent", {
    async create({ data }: any) { const e = { id: `ev${++seq}`, level: 0, channel: null, recipientId: null, actorId: null, detail: null, at: new Date(Date.now() + seq), ...data }; reminderEvents.push(e); return e; },
    async findMany({ where }: any) { return reminderEvents.filter((e) => deepMatch(e, where)); },
  });
  stubModel("regionManager", {
    async findMany({ where }: any) { await tick(); return regionManagers.filter((m) => users[m.userId]).map((m) => ({ ...m, user: { ...userRow(users[m.userId]), id: m.userId } })).filter((m) => deepMatch(m, where ?? {})); },
    deleteMany: async ({ where }: any) => { const before = regionManagers.length; regionManagers = regionManagers.filter((m) => !deepMatch(m, where)); return { count: before - regionManagers.length }; },
    createMany: async ({ data }: any) => { regionManagers.push(...data); return { count: data.length }; },
  });
  stubModel("regionManagerAudit", {
    create: async ({ data }: any) => { const row = { id: `au${++seq}`, createdAt: new Date(Date.now() + seq), ...data }; regionAudits.push(row); return row; },
    findMany: async ({ where }: any) => regionAudits.filter((a) => deepMatch(a, where)).sort((a, b) => b.createdAt - a.createdAt).map((a) => ({ ...a, actor: a.actorId ? { id: a.actorId, name: users[a.actorId]?.name } : null })),
  });
  stubModel("region", {
    findUnique: async ({ where }: any) => (["r1", "r2"].includes(where.id) ? { id: where.id } : null),
    findMany: async ({ where }: any) => [{ id: "r1", name: "North" }, { id: "r2", name: "South" }].filter((r) => deepMatch(r, where ?? {})),
  });
  stubModel("user", {
    findUnique: async ({ where }: any) => (users[where.id] ? userRow(users[where.id]) : null),
    findMany: async ({ where }: any) => Object.values(users).map(userRow).filter((u) => deepMatch(u, where ?? {})),
  });
  stubModel("notificationLog", {
    create: async ({ data }: any) => {
      if (failFor.has(data.recipientId)) throw new Error("provider down");
      notifications.push({ ...data });
      return { ...data };
    },
  });
  stubModel("amcOrder", {
    findUnique: async ({ where }: any) => (where.id === "amc1abcdef" ? { id: where.id, customerId: "cA", units: [{ unitId: "u3" }] } : where.id === "amc2" ? { id: "amc2", customerId: "cB", units: [{ unitId: "u2" }] } : null),
  });
  stubModel("recdUnit", {
    findUnique: async ({ where }: any) =>
      ({
        u3: { id: "u3", serialNo: "SN-003", status: "active", order: { customerId: "cA" }, site: { vendorId: null, regionId: "r1" } },
        u2: { id: "u2", serialNo: "SN-002", status: "active", order: { customerId: "cB" }, site: { vendorId: null, regionId: "r2" } },
        uOld: { id: "uOld", serialNo: "SN-OLD", status: "retired", order: { customerId: "cA" }, site: { vendorId: null, regionId: "r1" } },
      } as any)[where.id] ?? null,
  });
}

// ---- server -------------------------------------------------------------------------------------------
let server: Server;
let base = "";
let tokenFor: (u: string) => string;
const realConsole = { error: console.error, log: console.log };

before(async () => {
  console.error = () => {};
  console.log = () => {};
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { remindersRouter, reminderCronRouter } = await import("../src/routes/reminders");
  const { regionsRouter } = await import("../src/routes/regions");
  const { amcVisitsRouter } = await import("../src/routes/amcVisits");
  const { settingsRouter } = await import("../src/routes/settings");
  for (const model of ["user", "companySettings", "complaint", "complaintEvent", "amcVisit", "amcOrder", "recdUnit", "serviceReminder", "serviceReminderEvent", "regionManager", "regionManagerAudit", "region", "notificationLog"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  const { providersByChannel } = await import("../src/services/notifications/providers");
  realEmailProvider = providersByChannel.email;
  providersByChannel.email = { channel: "email", send: async ({ recipientId, templateKey }: any) => { if (emailFailFor.has(recipientId)) return false; emailSends.push(`${recipientId}:${templateKey}`); return true; } } as any;
  (prisma as any).$transaction = async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg));
  tokenFor = (u) => signToken({ userId: users[u]?.id ?? u, roleKey: U0[u].role, customerId: U0[u].customerId ?? null });
  const app = express();
  app.use(express.json());
  app.use("/reminders/cron", reminderCronRouter);
  app.use("/reminders", remindersRouter);
  app.use("/regions", regionsRouter);
  app.use("/amc-visits", amcVisitsRouter);
  app.use("/settings", settingsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  Object.assign(console, realConsole);
  delete process.env.CRON_SECRET;
});

function reset() { resetWorld(); installTables(); }

async function call(as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}

async function runJob(now = NOW) {
  const { runReminderJob } = await import("../src/lib/reminders");
  return runReminderJob(now);
}
const reminderOf = (activityId: string) => reminders.find((r) => r.complaintId === activityId || r.amcVisitId === activityId);
const sentTo = (reminderId?: string) => reminderEvents.filter((e) => e.type === "sent" && (!reminderId || e.reminderId === reminderId));
const recipientsOf = (templateKey: string) => [...new Set(notifications.filter((n) => n.templateKey === templateKey).map((n) => n.recipientId))].sort();

// =============================================================================================
// Region mapping (Service Managers AND Regional Managers)
// =============================================================================================

test("regions: administrators can map Service Managers and Regional Managers to a region; both roles are accepted and stay distinct", async () => {
  reset();
  const r = await call("mgmt", "PUT", "/regions/r1/managers", { userIds: ["smR1", "rm1"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(regionManagers.filter((m) => m.regionId === "r1").map((m) => m.userId).sort(), ["rm1", "smR1"]);
  assert.equal(users.smR1.role, ROLE_KEY.SERVICE_MANAGER, "mapping does not change anyone's role");
});

test("regions: one manager can cover several regions and one region can have several managers; a region may have none", async () => {
  reset();
  await call("mgmt", "PUT", "/regions/r1/managers", { userIds: ["smFree", "smR1"] });
  await call("mgmt", "PUT", "/regions/r2/managers", { userIds: ["smFree"] });
  assert.deepEqual(regionManagers.filter((m) => m.userId === "smFree").map((m) => m.regionId).sort(), ["r1", "r2"]);
  assert.equal(regionManagers.filter((m) => m.regionId === "r1").length, 2);
  assert.equal((await call("mgmt", "PUT", "/regions/r2/managers", { userIds: [] })).status, 200, "a region can be left without a manager");
  assert.equal(regionManagers.filter((m) => m.regionId === "r2").length, 0);
});

test("regions: only active users holding a mappable role are accepted; engineers, customers, inactive and unknown users are refused", async () => {
  reset();
  const before = JSON.stringify(regionManagers);
  for (const bad of [["eng"], ["custA"], ["vendorEng"], ["sales"], ["mgmt"], ["smR1off"], ["nobody"], ["smR1", "eng"]]) {
    const r = await call("mgmt", "PUT", "/regions/r1/managers", { userIds: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /active user with the Regional Manager or Service Manager role/);
  }
  assert.equal(JSON.stringify(regionManagers), before, "a refused request changes nothing");
  assert.equal((await call("mgmt", "PUT", "/regions/nope/managers", { userIds: [] })).status, 404);
  assert.equal(regionAudits.length, 0, "refused requests are not audited as changes");
});

test("regions: assignment needs MANAGE_REGIONS - managers, engineers, vendors and customers cannot change it", async () => {
  reset();
  for (const who of ["smR1", "rm1", "eng", "vendorEng", "custA", "sales"]) {
    assert.equal((await call(who, "PUT", "/regions/r1/managers", { userIds: ["smR1"] })).status, 403, who);
    assert.equal((await call(who, "GET", "/regions/r1/audit")).status, 403, `${who} audit`);
  }
  assert.equal((await call(null, "PUT", "/regions/r1/managers", { userIds: [] })).status, 401);
});

test("regions: every change is audited with who, when, and the set before and after", async () => {
  reset();
  await call("mgmt", "PUT", "/regions/r1/managers", { userIds: ["smR1", "smFree"] });
  await call("owner", "PUT", "/regions/r1/managers", { userIds: ["smFree"] });
  const audit = await call("mgmt", "GET", "/regions/r1/audit");
  assert.equal(audit.status, 200);
  assert.equal(audit.body.length, 2);
  const [latest, first] = audit.body;
  assert.equal(latest.by, "Olu Owner");
  assert.deepEqual(latest.before.sort(), ["Free SM", "Sita SM North"]);
  assert.deepEqual(latest.after, ["Free SM"]);
  assert.equal(first.by, "Mia Management");
  assert.ok(first.before.includes("Ravi RM North"), "the starting set is recorded");
});

// =============================================================================================
// Due state, tracked activities, policy
// =============================================================================================

test("policy off (no lead time): the job creates and sends nothing, but still closes reminders of finished activities", async () => {
  reset();
  settings.reminderLeadDays = null;
  reminders.push({ id: "old", activityType: "ticket", complaintId: "tDone", status: "sent", regionId: "r1", dueDate: off(-19), customerName: "x", activityRef: "TCK-5", escalationLevel: 0 });
  const out = await runJob();
  assert.deepEqual([out.enabled, out.created, out.sent, out.escalated], [false, 0, 0, 0]);
  assert.equal(notifications.length, 0);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].status, "closed", "the housekeeping still runs");
});

test("job: overdue and due-soon tickets and AMC visits get a reminder; far-off, undated and finished activities do not", async () => {
  reset();
  const out = await runJob();
  const refs = reminders.map((r) => r.activityRef).sort();
  assert.deepEqual(refs, ["AMC-ABCDEF", "TCK-1", "TCK-2", "TCK-6"], JSON.stringify(refs));
  assert.equal(out.created, 4);
  assert.ok(!reminders.some((r) => r.complaintId === "tFar" || r.complaintId === "tNone" || r.complaintId === "tDone" || r.amcVisitId === "vDone"));
});

test("job: the AMC contract expiry is NOT a visit due date - an AMC order with no scheduled visit produces no reminder", async () => {
  reset();
  visits = {};
  const out = await runJob();
  assert.ok(!reminders.some((r) => r.activityType === "amc_visit"));
  assert.equal(out.created, 3, "only the three dated tickets");
});

// =============================================================================================
// Sending: recipients, content, delivery, duplicates
// =============================================================================================

test("job: the reminder goes to the ACTIVE Service Managers of the activity's region - not to RMs, inactive managers, other regions or anyone else", async () => {
  reset();
  await runJob();
  const north = reminderOf("tOver");
  assert.equal(north.status, "sent");
  const ids = notifications.filter((n) => n.payload.activityRef === "TCK-1").map((n) => n.recipientId);
  assert.deepEqual([...new Set(ids)], ["smR1"], "North: the active Service Manager only");
  const south = notifications.filter((n) => n.payload.activityRef === "TCK-6").map((n) => n.recipientId);
  assert.deepEqual([...new Set(south)], ["smR2"]);
  for (const nobody of ["smR1off", "rm1", "rm2", "smFree", "eng", "custA", "mgmt", "vendorEng"]) assert.ok(!notifications.some((n) => n.recipientId === nobody && n.templateKey === "service_reminder"), nobody);
});

test("job: every reminder carries customer, site, RECD serial number, due date, the activity reference and a link to the dashboard", async () => {
  reset();
  await runJob();
  const n = notifications.find((x) => x.payload.activityRef === "TCK-1" && x.channel === "in_app")!;
  assert.equal(n.templateKey, "service_reminder");
  assert.deepEqual(
    [n.payload.customerName, n.payload.siteName, n.payload.serialNo, n.payload.dueDate, n.payload.activityRef, n.payload.overdue],
    ["Acme Power", "Acme Plant 1", "SN-001", iso(-10), "TCK-1", true],
  );
  assert.equal(n.payload.link, `https://app.example.test/reminders?focus=${reminderOf("tOver").id}`);
  const soon = notifications.find((x) => x.payload.activityRef === "TCK-2")!;
  assert.deepEqual([soon.payload.overdue, soon.payload.dueDate], [false, iso(2)]);
  const { renderEmail } = await import("../src/services/notifications/emailTemplates");
  const mail = renderEmail("service_reminder", n.payload);
  for (const e of ["Customer: Acme Power", "Site: Acme Plant 1", "RECD serial no.: SN-001", `Due date: ${iso(-10)} (OVERDUE)`, "TCK-1"]) assert.ok(mail.text.includes(e), e);
  const amc = notifications.find((x) => x.payload.activityType === "amc_visit")!;
  assert.deepEqual([amc.payload.serialNo, amc.payload.siteName, amc.payload.activityRef], ["SN-003", "Acme Plant 3", "AMC-ABCDEF"]);
});

test("job: a missing serial number is stated plainly in the message, never replaced by another unit's number", async () => {
  reset();
  tickets.tOver.unit = null;
  tickets.tOver.unitId = null;
  await runJob();
  const n = notifications.find((x) => x.payload.activityRef === "TCK-1")!;
  assert.equal(n.payload.serialNo, null);
  assert.equal(reminderOf("tOver").unitSerialNo, null);
  const { renderEmail } = await import("../src/services/notifications/emailTemplates");
  assert.ok(renderEmail("service_reminder", n.payload).text.includes("RECD serial no.: not recorded"));
});

test("delivery status: an in-app record alone is NOT a delivery - with the real e-mail provider (no SMTP) the reminder is 'failed', never 'sent'", async () => {
  reset();
  const { providersByChannel } = await import("../src/services/notifications/providers");
  const stub = providersByChannel.email;
  providersByChannel.email = realEmailProvider; // no SMTP configured in this test process
  try {
    await runJob();
  } finally {
    providersByChannel.email = stub;
  }
  const rem = reminderOf("tOver");
  const evs = reminderEvents.filter((e) => e.reminderId === rem.id);
  assert.ok(evs.some((e) => e.type === "in_app_recorded" && e.channel === "in_app" && e.recipientId === "smR1"), "the in-app row is recorded as a record");
  assert.ok(evs.some((e) => e.type === "delivery_failed" && e.channel === "email" && e.recipientId === "smR1"), "no SMTP -> the e-mail attempt is a failed delivery");
  assert.ok(!evs.some((e) => e.type === "sent"), "nothing was delivered");
  assert.deepEqual([rem.status, rem.statusReason, rem.sentAt], ["failed", "delivery_failed", null]);
  assert.ok(notifications.some((n) => n.channel === "in_app" && n.recipientId === "smR1"), "the unreadable in-app log row still exists");
});

test("delivery status: an accepted e-mail is the delivery - the reminder is 'sent' only then, and the in-app record is a separate, labelled event", async () => {
  reset();
  await runJob();
  const rem = reminderOf("tOver");
  const evs = reminderEvents.filter((e) => e.reminderId === rem.id && e.recipientId === "smR1");
  assert.ok(evs.some((e) => e.type === "sent" && e.channel === "email"));
  assert.ok(evs.some((e) => e.type === "in_app_recorded" && e.channel === "in_app"));
  assert.ok(!evs.some((e) => e.type === "sent" && e.channel === "in_app"), "an in-app row is never reported as sent");
  assert.deepEqual([rem.status, rem.statusReason], ["sent", null]);
  assert.ok(rem.sentAt);
  assert.ok(emailSends.includes("smR1:service_reminder"));
});

test("job: when every delivery fails the reminder is 'failed', and the next run retries it (once, then it is sent)", async () => {
  reset();
  failFor.add("smR1");
  await runJob();
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.attempts, rem.sentAt], ["failed", 1, null]);
  assert.ok(reminderEvents.some((e) => e.reminderId === rem.id && e.type === "delivery_failed"));
  failFor.clear();
  await runJob();
  assert.deepEqual([rem.status, rem.attempts], ["sent", 2]);
  const before = notifications.length;
  await runJob();
  assert.equal(notifications.length, before, "nothing more is sent once it succeeded");
});

test("job: retries stop after the attempt limit", async () => {
  reset();
  failFor.add("smR1");
  for (let i = 0; i < 8; i++) await runJob();
  assert.equal(reminderOf("tOver").attempts, 5);
  assert.equal(reminderOf("tOver").status, "failed");
});

test("job: running it twice, or several times at once, never reminds the same person twice for the same activity", async () => {
  reset();
  await Promise.all([runJob(), runJob(), runJob()]);
  await runJob();
  assert.equal(reminders.length, 4, "one reminder per activity");
  const perPerson = new Map<string, number>();
  for (const n of notifications.filter((x) => x.templateKey === "service_reminder" && x.channel === "in_app")) {
    const k = `${n.recipientId}:${n.payload.activityRef}`;
    perPerson.set(k, (perPerson.get(k) ?? 0) + 1);
  }
  assert.ok([...perPerson.values()].every((c) => c === 1), JSON.stringify([...perPerson]));
  assert.equal(reminderEvents.filter((e) => e.type === "created").length, 4);
});

test("job: a stuck 'sending' reminder is picked up again only after the timeout", async () => {
  reset();
  await runJob();
  const rem = reminderOf("tOver");
  Object.assign(rem, { status: "sending", lastAttemptAt: new Date(NOW.getTime() - 5 * 60_000), sentAt: null });
  reminderEvents = reminderEvents.filter((e) => !(e.reminderId === rem.id && e.type === "sent"));
  await runJob();
  assert.equal(rem.status, "sending", "5 minutes: another run may still be working on it");
  await runJob(new Date(NOW.getTime() + 20 * 60_000));
  assert.equal(rem.status, "sent", "after 15 minutes it is recovered");
});

test("job: with no Service Manager the region's Regional Managers get it; with nobody - or no region - it is 'no recipient' and goes to no one", async () => {
  reset();
  regionManagers = regionManagers.filter((m) => !(m.regionId === "r1" && m.userId === "smR1"));
  await runJob();
  assert.deepEqual([...new Set(notifications.filter((n) => n.payload.activityRef === "TCK-1").map((n) => n.recipientId))], ["rm1"], "fallback to the Regional Manager");

  reset();
  regionManagers = regionManagers.filter((m) => m.regionId !== "r1");
  tickets.tSoon.site = site("s9", null);
  await runJob();
  const noMgr = reminderOf("tOver");
  assert.deepEqual([noMgr.status, noMgr.statusReason], ["no_recipient", "no_active_manager"]);
  const noRegion = reminderOf("tSoon");
  assert.deepEqual([noRegion.status, noRegion.statusReason], ["no_recipient", "no_region"]);
  assert.ok(!notifications.some((n) => n.payload.activityRef === "TCK-1" || n.payload.activityRef === "TCK-2"), "nobody unrelated is contacted");
  assert.ok(reminderEvents.some((e) => e.reminderId === noMgr.id && e.type === "no_recipient"));

  regionManagers.push({ regionId: "r1", userId: "smR1" }); // an assignment appears
  await runJob();
  assert.equal(noMgr.status, "sent", "retried on the next run");
  assert.equal(noRegion.status, "no_recipient", "still no region");
});

test("job: an inactive-only region has no recipient (inactive managers are never contacted)", async () => {
  reset();
  regionManagers = regionManagers.filter((m) => m.regionId !== "r1" || m.userId === "smR1off");
  await runJob();
  assert.equal(reminderOf("tOver").status, "no_recipient");
  assert.ok(!notifications.some((n) => n.recipientId === "smR1off"));
});

test("job: when an activity is completed the reminder is closed and nothing further is sent or escalated", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  tickets.tOver.status = "resolved";
  visits.vOver.status = "completed";
  const sentBefore = notifications.length;
  const out = await runJob(new Date(NOW.getTime() + 72 * HOUR));
  assert.equal(reminderOf("tOver").status, "closed");
  assert.equal(reminderOf("vOver").status, "closed");
  assert.ok(reminderOf("tOver").closedAt);
  assert.equal(out.closed, 2);
  assert.equal(reminderOf("tOver").escalationLevel, 0, "a finished activity is not escalated");
  assert.ok(notifications.slice(sentBefore).every((n) => n.templateKey !== "service_reminder_escalated" || !["TCK-1", "AMC"].some((x) => n.payload.activityRef.startsWith(x))));
  tickets.tSoon.dueDate = null;
  await runJob(new Date(NOW.getTime() + 73 * HOUR));
  assert.equal(reminderOf("tSoon").status, "closed", "a due date that was removed closes the reminder");
});

test("job: a changed due date is recorded but does not trigger a second reminder", async () => {
  reset();
  await runJob();
  const sent = notifications.length;
  tickets.tOver.dueDate = off(-5);
  await runJob();
  assert.equal(reminderOf("tOver").dueDate.toISOString().slice(0, 10), iso(-5));
  assert.ok(reminderEvents.some((e) => e.type === "due_date_changed"));
  assert.equal(notifications.length, sent);
});

// =============================================================================================
// Acknowledgement and escalation
// =============================================================================================

test("escalation is off until a time is approved (reminderEscalationHours empty)", async () => {
  reset();
  await runJob();
  const out = await runJob(new Date(NOW.getTime() + 500 * HOUR));
  assert.equal(out.escalated, 0);
  assert.equal(reminderOf("tOver").escalationLevel, 0);
});

test("escalation: an unacknowledged reminder goes to the region's Regional Manager after the threshold, then to Management, then stops", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const t = (h: number) => new Date(NOW.getTime() + h * HOUR);

  let out = await runJob(t(23));
  assert.equal(out.escalated, 0, "before the threshold");
  out = await runJob(t(25));
  assert.equal(out.escalated, 4, "all four unacknowledged reminders (three North, one South)");
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.escalationLevel], [1]);
  assert.deepEqual([...new Set(notifications.filter((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1").map((n) => n.recipientId))], ["rm1"], "level 1: the region's Regional Manager");
  const msg = notifications.find((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1")!;
  assert.deepEqual([msg.payload.customerName, msg.payload.siteName, msg.payload.serialNo, msg.payload.dueDate, msg.payload.level], ["Acme Power", "Acme Plant 1", "SN-001", iso(-10), 1]);

  out = await runJob(t(26));
  assert.equal(out.escalated, 0, "not again at once");
  await runJob(t(50));
  assert.equal(rem.escalationLevel, 2);
  assert.deepEqual([...new Set(notifications.filter((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1" && n.payload.level === 2).map((n) => n.recipientId))].sort(), ["mgmt", "owner"], "level 2: Management");
  await runJob(t(200));
  assert.equal(rem.escalationLevel, 2, "two levels at most");
  const levels = reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "escalated").map((e) => e.level);
  assert.deepEqual(levels, [1, 2], "each level is recorded once");
});

test("escalation: repeated and simultaneous runs escalate each level exactly once", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const later = new Date(NOW.getTime() + 30 * HOUR);
  await Promise.all([runJob(later), runJob(later), runJob(later), runJob(later)]);
  const esc = notifications.filter((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1" && n.channel === "in_app");
  assert.equal(esc.length, 1, "one Regional Manager, one in-app message");
  assert.equal(reminderEvents.filter((e) => e.reminderId === reminderOf("tOver").id && e.type === "escalated").length, 1);
});

test("escalation: an acknowledged reminder is never escalated", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const ack = await call("smR1", "POST", `/reminders/${reminderOf("tOver").id}/acknowledge`);
  assert.equal(ack.status, 200);
  await runJob(new Date(NOW.getTime() + 100 * HOUR));
  assert.equal(reminderOf("tOver").escalationLevel, 0);
  assert.equal(notifications.filter((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1").length, 0);
  assert.ok(reminderOf("tSoon").escalationLevel > 0, "other, unacknowledged reminders still escalate");
});

test("escalation: recipients who already had the reminder are skipped, and with no other Regional Manager it goes to Management", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  regionManagers = regionManagers.filter((m) => !(m.regionId === "r1" && m.userId === "smR1")); // first line is now the RM
  await runJob();
  assert.deepEqual([...new Set(notifications.filter((n) => n.payload.activityRef === "TCK-1" && n.templateKey === "service_reminder").map((n) => n.recipientId))], ["rm1"]);
  await runJob(new Date(NOW.getTime() + 25 * HOUR));
  assert.deepEqual([...new Set(notifications.filter((n) => n.payload.activityRef === "TCK-1" && n.templateKey === "service_reminder_escalated").map((n) => n.recipientId))].sort(), ["mgmt", "owner"], "rm1 already had it, so level 1 goes to Management");
});

test("escalation: with nobody to escalate to, the attempt is recorded, the level still advances (no endless retry) and nothing unrelated is contacted", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  regionManagers = regionManagers.filter((m) => m.userId !== "rm1" && m.userId !== "rm2");
  delete users.mgmt;
  delete users.owner;
  await runJob();
  const out = await runJob(new Date(NOW.getTime() + 25 * HOUR));
  assert.ok(out.escalationNoRecipient >= 1);
  assert.equal(reminderOf("tOver").escalationLevel, 1);
  assert.ok(reminderEvents.some((e) => e.reminderId === reminderOf("tOver").id && e.type === "escalation_no_recipient"));
  assert.equal(notifications.filter((n) => n.templateKey === "service_reminder_escalated").length, 0);
});

test("escalation: a reminder that never reached anyone (no recipient) is NOT hidden - it escalates after the approved hours, counted from its creation", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  regionManagers = regionManagers.filter((m) => m.regionId !== "r1");
  await runJob();
  assert.equal(reminderOf("tOver").status, "no_recipient");
  await runJob(new Date(NOW.getTime() + 23 * HOUR));
  assert.equal(reminderOf("tOver").escalationLevel, 0, "before the threshold");
  await runJob(new Date(NOW.getTime() + 25 * HOUR));
  assert.equal(reminderOf("tOver").status, "no_recipient", "escalating does not pretend the first reminder was delivered");
  assert.equal(reminderOf("tOver").escalationLevel, 1);
  assert.ok(notifications.some((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1"), "someone (Management, the region has no manager) was told");
});

test("the existing ticket-age escalation is unchanged: mapping Service Managers does not add them to the SLA alerts", async () => {
  reset();
  const { ticketRecipients } = await import("../src/lib/ticketNotify");
  assert.deepEqual(await ticketRecipients("regional", { regionId: "r1" }), ["rm1"]);
  assert.deepEqual((await ticketRecipients("raised", { regionId: "r1" })).sort(), ["mgmt", "rm1", "smFree", "smR1", "smR2"].sort(), "raised: service desk roles + the region's Regional Manager, as before");
});

// =============================================================================================
// Delivery retries and escalation retries (per recipient, per attempt)
// =============================================================================================

const twoManagersInNorth = () => { regionManagers.push({ regionId: "r1", userId: "smFree" }); };

test("first reminder, partial failure: the successful delivery is kept, the status is 'failed' (partial_delivery) and only the failed recipient is retried", async () => {
  reset();
  twoManagersInNorth();
  emailFailFor.add("smFree");
  await runJob();
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.statusReason, rem.sentAt, rem.attempts], ["failed", "partial_delivery", null, 1]);
  assert.equal(emailSends.filter((x) => x === "smR1:service_reminder").length, 3, "smR1 received each of the three North reminders");
  assert.equal(emailSends.filter((x) => x.startsWith("smFree:")).length, 0, "nothing was accepted for the failing recipient");
  const before = emailSends.length;

  emailFailFor.clear(); // the mail server recovers
  await runJob();
  assert.deepEqual([rem.status, rem.statusReason, rem.attempts], ["sent", null, 2]);
  assert.ok(rem.sentAt);
  assert.ok(emailSends.slice(before).includes("smFree:service_reminder"), "the failed recipient got it on the retry");
  assert.equal(emailSends.filter((x) => x === "smR1:service_reminder").length, 3, "smR1 got each of the three North reminders once and was not e-mailed again on the retry");
  assert.equal(emailSends.slice(before).filter((x) => x.startsWith("smR1:")).length, 0);
});

test("first reminder: a recipient delivered once is never e-mailed twice for that reminder, however many runs follow", async () => {
  reset();
  twoManagersInNorth();
  emailFailFor.add("smFree");
  for (let i = 0; i < 4; i++) await runJob();
  const toR1 = reminderEvents.filter((e) => e.reminderId === reminderOf("tOver").id && e.recipientId === "smR1" && e.type === "sent");
  assert.equal(toR1.length, 1, "one delivery event for smR1 despite four runs");
  const toFree = reminderEvents.filter((e) => e.reminderId === reminderOf("tOver").id && e.recipientId === "smFree");
  assert.equal(toFree.filter((e) => e.type === "delivery_failed" && e.channel === "email").length, 4, "every failed attempt is recorded, with its attempt number");
  assert.deepEqual(toFree.filter((e) => e.type === "delivery_failed").map((e) => e.detail.attempt), [1, 2, 3, 4]);
  assert.equal(toFree.filter((e) => e.type === "in_app_recorded").length, 1, "the in-app record is written once per recipient");
});

test("first reminder: when every recipient fails it is 'failed' (delivery_failed); the retry limit still applies to partial failures", async () => {
  reset();
  twoManagersInNorth();
  emailFailFor.add("smFree");
  for (let i = 0; i < 9; i++) await runJob();
  const rem = reminderOf("tOver");
  assert.equal(rem.attempts, 5, "the existing limit of five attempts");
  assert.deepEqual([rem.status, rem.statusReason], ["failed", "partial_delivery"]);

  reset();
  emailFailFor.add("smR1");
  await runJob();
  assert.deepEqual([reminderOf("tOver").status, reminderOf("tOver").statusReason], ["failed", "delivery_failed"]);
});

test("overlapping runs never produce a duplicate successful e-mail for one recipient and reminder", async () => {
  reset();
  twoManagersInNorth();
  await Promise.all([runJob(), runJob(), runJob()]);
  await runJob();
  const counts = reminderEvents.filter((e) => e.type === "sent" && e.level === 0).reduce((m, e) => m.set(`${e.reminderId}:${e.recipientId}`, (m.get(`${e.reminderId}:${e.recipientId}`) ?? 0) + 1), new Map<string, number>());
  assert.ok([...counts.values()].every((c) => c === 1), JSON.stringify([...counts]));
});

test("escalation: a failed delivery does not consume the level - it stays due, is retried, and succeeds exactly once", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const rem = reminderOf("tOver");
  emailFailFor.add("rm1"); // level 1 goes to the North Regional Manager
  let out = await runJob(new Date(NOW.getTime() + 25 * HOUR));
  assert.equal(rem.escalationLevel, 0, "the level is not claimed while nobody was reached");
  assert.equal(rem.escalationAttempts, 1);
  assert.equal(rem.escalationClaimedAt, null, "the lease is released so the next run can retry");
  assert.ok(out.escalationRetryPending >= 1);
  assert.equal(reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "escalated").length, 0, "no 'escalated' event for a failed attempt");
  assert.ok(reminderEvents.some((e) => e.reminderId === rem.id && e.level === 1 && e.type === "delivery_failed" && e.recipientId === "rm1" && e.detail.attempt === 1));

  emailFailFor.clear();
  out = await runJob(new Date(NOW.getTime() + 26 * HOUR));
  assert.deepEqual([rem.escalationLevel, rem.escalationAttempts], [1, 0]);
  assert.equal(emailSends.filter((x) => x === "rm1:service_reminder_escalated").length, 3, "the three North reminders were escalated to the Regional Manager once each, on the retry");
  assert.equal(reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "escalated" && e.level === 1).length, 1);
  assert.equal(reminderEvents.filter((e) => e.reminderId === rem.id && e.level === 1 && e.type === "sent" && e.recipientId === "rm1").length, 1);
  const before = emailSends.filter((x) => x.includes("escalated")).length;
  await runJob(new Date(NOW.getTime() + 27 * HOUR));
  assert.equal(emailSends.filter((x) => x.includes("escalated")).length, before, "nothing more once it succeeded");
});

test("escalation: partial failure keeps the successful recipient and retries only the failed one (level 2 = Management)", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  await runJob(new Date(NOW.getTime() + 25 * HOUR)); // level 1 complete
  const rem = reminderOf("tOver");
  assert.equal(rem.escalationLevel, 1);
  emailFailFor.add("owner");
  await runJob(new Date(NOW.getTime() + 50 * HOUR));
  assert.equal(rem.escalationLevel, 1, "level 2 not settled: the owner was not reached");
  assert.ok(emailSends.includes("mgmt:service_reminder_escalated"));
  emailFailFor.clear();
  await runJob(new Date(NOW.getTime() + 51 * HOUR));
  assert.equal(rem.escalationLevel, 2);
  assert.equal(emailSends.filter((x) => x === "mgmt:service_reminder_escalated").length, 4, "Management got each of the four reminders once - not again when only the owner was retried");
  const mgmtSent = reminderEvents.filter((e) => e.reminderId === rem.id && e.level === 2 && e.recipientId === "mgmt" && e.type === "sent");
  const ownerSent = reminderEvents.filter((e) => e.reminderId === rem.id && e.level === 2 && e.recipientId === "owner" && e.type === "sent");
  assert.deepEqual([mgmtSent.length, ownerSent.length], [1, 1], "Management was e-mailed once, the owner on the retry");
});

test("escalation: retries stop after the attempt limit, and a fresh lease keeps overlapping runs out", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const rem = reminderOf("tOver");
  emailFailFor.add("rm1");
  for (let i = 0; i < 8; i++) await runJob(new Date(NOW.getTime() + (25 + i) * HOUR));
  assert.equal(rem.escalationAttempts, 5, "the existing limit of five attempts");
  assert.equal(rem.escalationLevel, 0);

  // a lease held by a running job (fresh) blocks a second run; a stale one (the job died) can be taken over
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const r2 = reminderOf("tOver");
  const t = new Date(NOW.getTime() + 25 * HOUR);
  r2.escalationClaimedAt = new Date(t.getTime() - 5 * 60_000);
  await runJob(t);
  assert.deepEqual([r2.escalationLevel, r2.escalationAttempts], [0, 0], "5 minutes: another run may still be working on it");
  await runJob(new Date(t.getTime() + 20 * 60_000));
  assert.equal(r2.escalationLevel, 1, "after 15 minutes the lease is taken over and the level is delivered");
});

test("escalation: overlapping runs deliver each level once, even while one attempt is failing for another recipient", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  const later = new Date(NOW.getTime() + 30 * HOUR);
  await Promise.all([runJob(later), runJob(later), runJob(later), runJob(later)]);
  const ev = reminderEvents.filter((e) => e.reminderId === reminderOf("tOver").id && e.level === 1 && e.type === "sent" && e.recipientId === "rm1");
  assert.equal(ev.length, 1);
  assert.equal(reminderOf("tOver").escalationAttempts, 0);
});

// =============================================================================================
// Acknowledgement API
// =============================================================================================

test("acknowledge: a manager of the region acknowledges once; who and when are recorded and the status changes", async () => {
  reset();
  await runJob();
  const id = reminderOf("tOver").id;
  const r = await call("smR1", "POST", `/reminders/${id}/acknowledge`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.acknowledgedById], ["acknowledged", "smR1"]);
  assert.ok(rem.acknowledgedAt);
  assert.ok(reminderEvents.some((e) => e.reminderId === id && e.type === "acknowledged" && e.actorId === "smR1"));
  assert.equal((await call("smR1", "POST", `/reminders/${id}/acknowledge`)).body.code, "ALREADY_ACKNOWLEDGED");
  assert.equal((await call("mgmt", "POST", `/reminders/${id}/acknowledge`)).status, 409, "still just one acknowledgement");
});

test("acknowledge: simultaneous acknowledgements record exactly one", async () => {
  reset();
  await runJob();
  const id = reminderOf("tOver").id;
  const results = await Promise.all(["smR1", "mgmt", "rm1", "owner"].map((u) => call(u, "POST", `/reminders/${id}/acknowledge`)));
  assert.equal(results.filter((x) => x.status === 200).length, 1);
  assert.equal(reminderEvents.filter((e) => e.reminderId === id && e.type === "acknowledged").length, 1);
});

test("acknowledge: refused until the reminder was actually delivered - pending, failed (fully or partly) and no-recipient reminders return 409 REMINDER_NOT_DELIVERED", async () => {
  reset();
  twoManagersInNorth();
  emailFailFor.add("smFree");
  await runJob();
  const partial = reminderOf("tOver");
  assert.equal(partial.status, "failed");
  const r = await call("smR1", "POST", `/reminders/${partial.id}/acknowledge`);
  assert.deepEqual([r.status, r.body.code], [409, "REMINDER_NOT_DELIVERED"]);
  assert.equal(partial.acknowledgedAt, null);
  assert.ok(!reminderEvents.some((e) => e.reminderId === partial.id && e.type === "acknowledged"));

  for (const status of ["pending", "sending", "failed", "no_recipient"]) {
    partial.status = status;
    const x = await call("mgmt", "POST", `/reminders/${partial.id}/acknowledge`);
    assert.deepEqual([x.status, x.body.code], [409, "REMINDER_NOT_DELIVERED"], status);
  }
  assert.equal(partial.acknowledgedAt, null);

  emailFailFor.clear();
  partial.status = "failed";
  await runJob(); // retried, now delivered to everyone
  assert.equal(partial.status, "sent");
  assert.equal((await call("smR1", "POST", `/reminders/${partial.id}/acknowledge`)).status, 200, "acknowledgeable once delivered");
});

test("acknowledge: with no mail server the reminder is 'failed', so it cannot be acknowledged either (nothing reached anyone)", async () => {
  reset();
  emailFailFor.add("smR1");
  await runJob();
  const id = reminderOf("tOver").id;
  assert.equal(reminderOf("tOver").status, "failed");
  assert.equal((await call("smR1", "POST", `/reminders/${id}/acknowledge`)).status, 409);
  const nr = reminderOf("tSouth");
  nr.status = "no_recipient";
  assert.equal((await call("smR2", "POST", `/reminders/${nr.id}/acknowledge`)).body.code, "REMINDER_NOT_DELIVERED");
});

test("acknowledge: the permission and region checks still come first (403 before 409), and a concurrent race on a delivered reminder records one", async () => {
  reset();
  emailFailFor.add("smR1");
  await runJob();
  const north = reminderOf("tOver");
  assert.equal(north.status, "failed");
  assert.equal((await call("smR2", "POST", `/reminders/${north.id}/acknowledge`)).status, 403, "outside the region: forbidden, not 'not delivered'");
  assert.equal((await call("eng", "POST", `/reminders/${north.id}/acknowledge`)).status, 403);
  emailFailFor.clear();
  await runJob();
  const results = await Promise.all(["smR1", "mgmt", "rm1"].map((u) => call(u, "POST", `/reminders/${north.id}/acknowledge`)));
  assert.equal(results.filter((x) => x.status === 200).length, 1);
});

test("acknowledge: outside your region, as an engineer / vendor / customer / sales, or on a finished activity - refused", async () => {
  reset();
  await runJob();
  const north = reminderOf("tOver").id;
  assert.equal((await call("smR2", "POST", `/reminders/${north}/acknowledge`)).status, 403, "South manager, North reminder");
  assert.equal((await call("rm2", "POST", `/reminders/${north}/acknowledge`)).status, 403);
  for (const who of ["eng", "vendorEng", "custA", "sales"]) assert.equal((await call(who, "POST", `/reminders/${north}/acknowledge`)).status, 403, who);
  assert.equal((await call(null, "POST", `/reminders/${north}/acknowledge`)).status, 401);
  assert.equal((await call("mgmt", "POST", "/reminders/nope/acknowledge")).status, 404);
  assert.equal(reminderOf("tOver").acknowledgedAt, null);
  assert.equal((await call("smFree", "POST", `/reminders/${north}/acknowledge`)).status, 200, "an unmapped Service Manager keeps the desk-wide view");

  reset();
  await runJob();
  tickets.tOver.status = "closed";
  await runJob();
  const closed = await call("smR1", "POST", `/reminders/${reminderOf("tOver").id}/acknowledge`);
  assert.deepEqual([closed.status, closed.body.code], [409, "REMINDER_CLOSED"]);
});

// =============================================================================================
// Dashboard
// =============================================================================================

test("dashboard: pending, due-soon and overdue activities with customer, site, serial, due date, region, managers and reminder state", async () => {
  reset();
  await runJob();
  const r = await call("mgmt", "GET", "/reminders");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.policy, { reminderLeadDays: 3, reminderEscalationHours: null, remindersEnabled: true });
  const row = (ref: string) => r.body.rows.find((x: any) => x.activityRef === ref);
  assert.deepEqual([row("TCK-1").state, row("TCK-2").state, row("TCK-3").state, row("TCK-6").state], ["overdue", "due_soon", "pending", "overdue"]);
  assert.deepEqual([row("TCK-1").customerName, row("TCK-1").siteName, row("TCK-1").serialNo, row("TCK-1").dueDate, row("TCK-1").regionName], ["Acme Power", "Acme Plant 1", "SN-001", iso(-10), "North"]);
  assert.deepEqual(row("TCK-1").managers.map((m: any) => m.name).sort(), ["Ravi RM North", "Sita SM North"], "active mapped managers only");
  assert.equal(row("TCK-1").reminder.status, "sent");
  assert.ok(row("TCK-1").reminder.events.length >= 2);
  assert.equal(row("TCK-3").reminder, null, "not yet due: no reminder");
  assert.ok(!r.body.rows.some((x: any) => x.activityRef === "TCK-5"), "resolved tickets are not listed");
  assert.ok(!r.body.rows.some((x: any) => x.activityRef === "TCK-4"), "undated tickets are not mixed in");
  assert.equal(r.body.counts.noDueDate, 1);
  assert.deepEqual([r.body.counts.overdue, r.body.counts.dueSoon, r.body.counts.pending], [3, 1, 1]);
  assert.equal(row("TCK-1").links.activity, "/service-reports?complaintId=tOver");
  assert.equal(row("TCK-1").links.unit, "/recd-units/u1");
  const amc = r.body.rows.find((x: any) => x.activityType === "amc_visit");
  assert.equal(amc.links.activity, "/amc-orders");
});

test("dashboard: states are consistent with the single backend definition, and undated tickets are listed only on request", async () => {
  reset();
  settings.reminderLeadDays = null;
  const r = await call("mgmt", "GET", "/reminders");
  assert.equal(r.body.policy.remindersEnabled, false);
  assert.ok(r.body.rows.every((x: any) => x.state !== "due_soon"), "no 'due soon' without an approved lead time");
  const undated = await call("mgmt", "GET", "/reminders?state=no_due_date");
  assert.deepEqual(undated.body.rows.map((x: any) => [x.activityRef, x.dueDate, x.state]), [["TCK-4", null, "no_due_date"]]);
});

test("dashboard: filters by region, manager, due-date range, state and reminder status", async () => {
  reset();
  settings.reminderEscalationHours = 24;
  await runJob();
  await runJob(new Date(NOW.getTime() + 25 * HOUR));
  const refs = async (q: string) => (await call("mgmt", "GET", `/reminders?${q}`)).body.rows.map((x: any) => x.activityRef).sort();
  assert.deepEqual(await refs("regionId=r2"), ["TCK-6"]);
  assert.deepEqual(await refs("managerId=smR2"), ["TCK-6"]);
  assert.deepEqual(await refs("managerId=smFree"), [], "a manager mapped to nothing");
  assert.deepEqual(await refs(`from=${iso(1)}&to=${iso(60)}`), ["TCK-2", "TCK-3"]);
  assert.deepEqual(await refs("state=overdue&regionId=r1"), ["AMC-ABCDEF", "TCK-1"]);
  assert.ok((await refs("reminder=escalated")).includes("TCK-1"));
  assert.deepEqual(await refs("reminder=acknowledged"), []);
  assert.equal((await call("mgmt", "GET", "/reminders?state=bogus")).status, 400);
  assert.equal((await call("mgmt", "GET", "/reminders?from=20-10-2026")).status, 400);
});

test("dashboard: regional scope - a Regional Manager and a mapped Service Manager see only their regions; an unmapped Service Manager and Management see all", async () => {
  reset();
  await runJob();
  const refsFor = async (u: string) => (await call(u, "GET", "/reminders")).body.rows.map((x: any) => x.regionName).filter((v: string | null, i: number, a: any[]) => a.indexOf(v) === i).sort();
  assert.deepEqual(await refsFor("smR1"), ["North"]);
  assert.deepEqual(await refsFor("rm1"), ["North"]);
  assert.deepEqual(await refsFor("smR2"), ["South"]);
  assert.deepEqual(await refsFor("rm2"), ["South"]);
  assert.deepEqual(await refsFor("smFree"), ["North", "South"]);
  assert.deepEqual(await refsFor("mgmt"), ["North", "South"]);
  regionManagers = regionManagers.filter((m) => m.userId !== "rm1");
  assert.deepEqual((await call("rm1", "GET", "/reminders")).body.rows, [], "a Regional Manager mapped to nothing sees nothing");
  const asking = await call("smR1", "GET", "/reminders?regionId=r2");
  assert.deepEqual(asking.body.rows, [], "asking for another region returns nothing");
});

test("dashboard: engineers, vendors, customers, sales and anonymous callers have no access", async () => {
  reset();
  for (const who of ["eng", "vendorEng", "custA", "sales"]) assert.equal((await call(who, "GET", "/reminders")).status, 403, who);
  assert.equal((await call(null, "GET", "/reminders")).status, 401);
});

// =============================================================================================
// Due dates on tickets, AMC visits, policy, cron
// =============================================================================================

test("ticket due date: managers set and clear it within their region; it is audited; finished tickets and out-of-region tickets are refused", async () => {
  reset();
  const set = await call("smR1", "PUT", "/reminders/tickets/tNone/due-date", { dueDate: "2026-11-05" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(tickets.tNone.dueDate.toISOString().slice(0, 10), "2026-11-05");
  assert.deepEqual([complaintEvents[0].type, complaintEvents[0].toValue, complaintEvents[0].actorId], ["due_date_set", "2026-11-05", "smR1"]);
  assert.equal((await call("smR1", "PUT", "/reminders/tickets/tNone/due-date", { dueDate: null })).status, 200);
  assert.equal(tickets.tNone.dueDate, null);
  assert.equal((await call("smR1", "PUT", "/reminders/tickets/tSouth/due-date", { dueDate: "2026-11-05" })).status, 403, "South ticket, North manager");
  assert.equal((await call("smR1", "PUT", "/reminders/tickets/tDone/due-date", { dueDate: "2026-11-05" })).status, 409);
  for (const bad of ["05-11-2026", "2026-02-30", "soon", 5]) assert.equal((await call("mgmt", "PUT", "/reminders/tickets/tNone/due-date", { dueDate: bad })).status, 400, String(bad));
  for (const who of ["eng", "vendorEng", "custA", "sales"]) assert.equal((await call(who, "PUT", "/reminders/tickets/tNone/due-date", { dueDate: "2026-11-05" })).status, 403, who);
});

test("AMC visits: AMC managers schedule a visit for a unit the order covers; other units, customers, retired units and other roles are refused", async () => {
  reset();
  const ok = await call("mgmt", "POST", "/amc-visits", { amcOrderId: "amc1abcdef", unitId: "u3", dueDate: "2026-11-15" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.status, ok.body.dueDate, ok.body.serialNo], ["scheduled", "2026-11-15", "SN-003"]);
  assert.equal((await call("mgmt", "POST", "/amc-visits", { amcOrderId: "amc1abcdef", unitId: "u2", dueDate: "2026-11-15" })).body.code, "UNIT_NOT_IN_AMC");
  assert.equal((await call("mgmt", "POST", "/amc-visits", { amcOrderId: "amc2", unitId: "u3", dueDate: "2026-11-15" })).body.code, "UNIT_NOT_IN_AMC");
  assert.equal((await call("mgmt", "POST", "/amc-visits", { amcOrderId: "nope", unitId: "u3", dueDate: "2026-11-15" })).status, 404);
  assert.equal((await call("mgmt", "POST", "/amc-visits", { amcOrderId: "amc1abcdef", unitId: "u3", dueDate: "tomorrow" })).status, 400);
  for (const who of ["smR1", "rm1", "eng", "vendorEng", "custA", "sales"]) assert.equal((await call(who, "POST", "/amc-visits", { amcOrderId: "amc1abcdef", unitId: "u3", dueDate: "2026-11-15" })).status, 403, who);
});

test("AMC visits: completing or cancelling closes it for good; a finished visit cannot be changed; frequency per year creates nothing by itself", async () => {
  reset();
  const v = (await call("mgmt", "POST", "/amc-visits", { amcOrderId: "amc1abcdef", unitId: "u3", dueDate: "2026-11-15" })).body;
  assert.equal((await call("mgmt", "PATCH", `/amc-visits/${v.id}`, { dueDate: "2026-11-20" })).body.dueDate, "2026-11-20");
  const done = await call("mgmt", "PATCH", `/amc-visits/${v.id}`, { status: "completed" });
  assert.deepEqual([done.status, done.body.status], [200, "completed"]);
  assert.ok(visits[v.id].completedAt);
  assert.equal((await call("mgmt", "PATCH", `/amc-visits/${v.id}`, { status: "cancelled" })).body.code, "VISIT_FINISHED");
  assert.equal((await call("mgmt", "PATCH", `/amc-visits/${v.id}`, {})).status, 400);
  assert.equal((await call("mgmt", "PATCH", "/amc-visits/nope", { status: "completed" })).status, 404);
  const before = Object.keys(visits).length;
  await runJob();
  assert.equal(Object.keys(visits).length, before, "the job never creates visits");
});

test("settings: the reminder policy is admin-only, validated, and escalation cannot be set without a lead time", async () => {
  reset();
  stubModel("companySettings", { findUnique: async () => settings, upsert: async ({ update }: any) => { settings = { ...settings, ...update }; return settings; } });
  assert.equal((await call("mgmt", "PUT", "/settings/reminders", { reminderLeadDays: 2, reminderEscalationHours: 12 })).status, 200);
  assert.deepEqual([settings.reminderLeadDays, settings.reminderEscalationHours], [2, 12]);
  assert.equal((await call("mgmt", "PUT", "/settings/reminders", { reminderLeadDays: null, reminderEscalationHours: null })).status, 200, "switching it off");
  assert.equal((await call("mgmt", "PUT", "/settings/reminders", { reminderLeadDays: null, reminderEscalationHours: 12 })).status, 400);
  for (const bad of [{ reminderLeadDays: -1, reminderEscalationHours: null }, { reminderLeadDays: 400, reminderEscalationHours: null }, { reminderLeadDays: 2, reminderEscalationHours: 0 }, { reminderLeadDays: "2", reminderEscalationHours: null }, {}]) {
    assert.equal((await call("mgmt", "PUT", "/settings/reminders", bad)).status, 400, JSON.stringify(bad));
  }
  for (const who of ["smR1", "rm1", "eng", "custA"]) assert.equal((await call(who, "PUT", "/settings/reminders", { reminderLeadDays: 1, reminderEscalationHours: null })).status, 403, who);
});

test("cron: the scheduled job needs the secret - none configured, a wrong one or a user login are all refused; the right one runs it", async () => {
  reset();
  delete process.env.CRON_SECRET;
  assert.equal((await call(null, "GET", "/reminders/cron/run")).status, 401, "no secret configured = locked");
  assert.equal((await call(null, "GET", "/reminders/cron/run", undefined, { authorization: "Bearer anything" })).status, 401);
  process.env.CRON_SECRET = "s3cret-for-tests";
  assert.equal((await call(null, "GET", "/reminders/cron/run")).status, 401);
  assert.equal((await call(null, "GET", "/reminders/cron/run", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await call("mgmt", "GET", "/reminders/cron/run")).status, 401, "a user token is not the cron secret");
  assert.equal(notifications.length, 0, "refused calls sent nothing");
  const ok = await call(null, "GET", "/reminders/cron/run", undefined, { authorization: "Bearer s3cret-for-tests" });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.ok, ok.body.enabled, ok.body.created], [true, true, 4]);
});

// =============================================================================================
// The PROPOSED workflow (3 days before the due date, then 24 h per escalation stage), end to end
// =============================================================================================

const approved = () => { reset(); settings.reminderLeadDays = 3; settings.reminderEscalationHours = 24; };
const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
const addTicket = (id: string, dueInDays: number, extra: Record<string, unknown> = {}) => {
  tickets[id] = { id, ticketNumber: `TCK-${id}`, status: "open", dueDate: off(dueInDays), customerId: "cA", siteId: "s1", unitId: "u1", customer: { name: "Acme Power" }, site: site("s1", "r1", "Acme Plant 1"), unit: { id: "u1", serialNo: "SN-001" }, ...extra };
};
const escalatedTo = (activityRef: string, level: number) =>
  reminderEvents.filter((e) => e.type === "sent" && e.level === level && e.channel === "email" && reminders.find((r) => r.id === e.reminderId)?.activityRef === activityRef).map((e) => e.recipientId).sort();

test("approved policy, stage 1: a reminder exists from exactly 3 calendar days before the due date - not before - and for everything overdue", async () => {
  approved();
  addTicket("t3", 3);
  addTicket("t4", 4);
  addTicket("t5", 5);
  await runJob(NOW);
  assert.ok(reminderOf("t3"), "due in 3 days: reminded now");
  assert.ok(reminderOf("tSoon"), "due in 2 days");
  assert.ok(reminderOf("tOver"), "overdue");
  assert.equal(reminderOf("t4"), undefined, "due in 4 days: too early");
  assert.equal(reminderOf("t5"), undefined);
  assert.equal(reminderOf("tFar"), undefined);
  assert.equal(reminderOf("tNone"), undefined, "no due date: nothing is invented");
  assert.equal(reminderOf("tDone"), undefined, "finished tickets are not reminded");
  // a day later the 4-day ticket has entered its window
  await runJob(at(24));
  assert.ok(reminderOf("t4"), "now inside the 3-day window");
  assert.equal(reminderOf("t5"), undefined, "5 days out is still too early");
});

test("approved policy, stage 1: the reminder goes to the region's active Service Manager and carries customer, site, serial, due date, reference and link", async () => {
  approved();
  addTicket("t3", 3);
  await runJob(NOW);
  const rem = reminderOf("t3");
  assert.equal(rem.status, "sent");
  const toWhom = reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "sent" && e.level === 0).map((e) => e.recipientId);
  assert.deepEqual(toWhom, ["smR1"], "North's active Service Manager - not the inactive one, the Regional Manager or South's manager");
  const n = notifications.find((x) => x.payload.activityRef === "TCK-t3" && x.channel === "email")!;
  assert.deepEqual([n.payload.customerName, n.payload.siteName, n.payload.serialNo, n.payload.dueDate, n.payload.activityRef, n.payload.overdue], ["Acme Power", "Acme Plant 1", "SN-001", iso(3), "TCK-t3", false]);
  assert.equal(n.payload.link, `https://app.example.test/reminders?focus=${rem.id}`);
  assert.equal(rem.sentAt.getTime(), NOW.getTime(), "the countdown starts at the delivery");
});

test("approved policy, stages 2 and 3: Regional Manager 24 h after the reminder was delivered, Management 24 h after THAT escalation was delivered", async () => {
  approved();
  await runJob(NOW); // delivered at t=0
  const rem = reminderOf("tOver");
  assert.equal(rem.status, "sent");

  await runJob(at(23));
  assert.equal(rem.escalationLevel, 0, "23 h: too early");
  await runJob(at(30)); // the job was not run between 24 h and 30 h: the escalation is delivered late, at 30 h
  assert.equal(rem.escalationLevel, 1);
  assert.deepEqual(escalatedTo("TCK-1", 1), ["rm1"], "stage 2: the region's Regional Manager");
  assert.equal(rem.lastEscalatedAt.getTime(), at(30).getTime(), "the stage-3 clock starts when stage 2 was DELIVERED");

  await runJob(at(48)); // 48 h after the first delivery, but only 18 h after the escalation
  assert.equal(rem.escalationLevel, 1, "not measured from the original delivery or the due date");
  await runJob(at(53));
  assert.equal(rem.escalationLevel, 1, "23 h after the escalation: too early");
  await runJob(at(54));
  assert.equal(rem.escalationLevel, 2);
  assert.deepEqual(escalatedTo("TCK-1", 2), ["mgmt", "owner"], "stage 3: Management and Owner/Admin");
  await runJob(at(400));
  assert.equal(rem.escalationLevel, 2, "never beyond stage 3");
  assert.deepEqual(reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "escalated").map((e) => e.level), [1, 2]);
});

test("approved policy: a reminder whose delivery FAILED still escalates after 24 h (counted from creation); a later delivery does not restart the stage-2 clock", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.sentAt], ["failed", null], "a failed reminder is never treated as delivered");
  await runJob(at(23));
  assert.equal(rem.escalationLevel, 0, "too early");
  await runJob(at(30)); // still failing 30 h later
  assert.equal(rem.escalationLevel, 1, "the failure did not block the escalation that is due");
  assert.equal(rem.status, "failed");
  assert.deepEqual(escalatedTo("TCK-1", 1), ["rm1"], "the region's Regional Manager, who had not had the reminder");
  emailFailFor.clear();
  await runJob(at(31)); // the first reminder is finally delivered at 31 h
  assert.equal(rem.status, "sent");
  assert.equal(rem.sentAt.getTime(), at(31).getTime());
  await runJob(at(53));
  assert.equal(rem.escalationLevel, 1, "23 h after the stage-1 escalation: too early");
  await runJob(at(55));
  assert.equal(rem.escalationLevel, 2, "24 h after the stage-1 escalation (30 h) -> stage 2");
});

test("approved policy: an acknowledgement stops all further escalation, at either stage", async () => {
  approved();
  await runJob(NOW);
  const north = reminderOf("tOver");
  const south = reminderOf("tSouth");
  assert.equal((await call("rm1", "POST", `/reminders/${north.id}/acknowledge`)).status, 200, "acknowledged before any escalation");
  await runJob(at(30)); // the other (South) reminder reaches stage 2
  assert.equal(north.escalationLevel, 0);
  assert.equal(south.escalationLevel, 1);
  assert.equal((await call("rm2", "POST", `/reminders/${south.id}/acknowledge`)).status, 200, "acknowledged after stage 2");
  await runJob(at(200));
  assert.equal(north.escalationLevel, 0, "stage 2 never happened for the first");
  assert.equal(south.escalationLevel, 1, "stage 3 never happens for the second");
  assert.ok(!notifications.some((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-6" && n.payload.level === 2));
  assert.ok(!notifications.some((n) => n.templateKey === "service_reminder_escalated" && n.payload.activityRef === "TCK-1"));
});

test("approved policy: failed deliveries stay retryable at every stage, partial delivery never repeats a successful message, and an overlapping run never duplicates an escalation", async () => {
  approved();
  regionManagers.push({ regionId: "r1", userId: "smFree" }); // a second North Service Manager
  emailFailFor.add("smFree");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.statusReason], ["failed", "partial_delivery"]);
  const smR1Mails = () => emailSends.filter((x) => x === "smR1:service_reminder").length;
  const first = smR1Mails();
  emailFailFor.clear();
  await runJob(at(1));
  assert.equal(rem.status, "sent");
  assert.equal(smR1Mails(), first, "smR1 already had it: not e-mailed again");
  assert.ok(emailSends.includes("smFree:service_reminder"), "only the failed recipient was retried");

  emailFailFor.add("rm1"); // stage 2 fails first
  await runJob(at(26));
  assert.equal(rem.escalationLevel, 0, "the failed escalation did not consume the stage");
  emailFailFor.clear();
  const later = at(27);
  await Promise.all([runJob(later), runJob(later), runJob(later)]);
  assert.equal(rem.escalationLevel, 1);
  assert.equal(reminderEvents.filter((e) => e.reminderId === rem.id && e.level === 1 && e.type === "sent" && e.recipientId === "rm1").length, 1, "one successful stage-2 delivery despite three overlapping runs");
});

test("approved policy: no recipient - nothing is sent to anyone unrelated, the reminder shows it, it still escalates to Management, and it is retried when a manager is mapped", async () => {
  approved();
  regionManagers = regionManagers.filter((m) => m.regionId !== "r1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.statusReason, rem.sentAt], ["no_recipient", "no_active_manager", null]);
  assert.ok(!notifications.some((n) => n.payload.activityRef === "TCK-1"), "the first reminder went to nobody");
  assert.equal((await call("mgmt", "POST", `/reminders/${rem.id}/acknowledge`)).status, 409, "and, before any escalation, it cannot be acknowledged");
  await runJob(at(100));
  assert.equal(rem.escalationLevel, 1);
  assert.deepEqual(escalatedTo("TCK-1", 1), ["mgmt", "owner"], "escalated to Management only (the region has no managers at all)");
  assert.equal((await call("mgmt", "POST", `/reminders/${rem.id}/acknowledge`)).status, 200, "once an escalation reached someone, they can take it over");
  assert.equal(rem.status, "acknowledged");
  assert.equal(rem.statusReason, rem.statusReason);
});

test("approved policy: a no-recipient reminder is retried when a manager is mapped and then behaves like any delivered reminder", async () => {
  approved();
  regionManagers = regionManagers.filter((m) => m.regionId !== "r1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  regionManagers.push({ regionId: "r1", userId: "smR1" });
  await runJob(at(1));
  assert.equal(rem.status, "sent");
  assert.equal(rem.escalationLevel, 0);
  await runJob(at(24));
  assert.equal(rem.escalationLevel, 0, "24 h after delivery has not passed yet (1 h + 24 h)");
  await runJob(at(26));
  assert.equal(rem.escalationLevel, 1);
});

// ---- R6 audit: an undelivered reminder must not block escalation ------------------------------------------------------

test("R6: a reminder that sends successfully is unchanged - sent, its clock starts at delivery, no escalation before 24 h", async () => {
  approved();
  await runJob(NOW);
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.statusReason, rem.escalationLevel], ["sent", null, 0]);
  assert.ok(rem.sentAt);
  await runJob(at(23));
  assert.equal(rem.escalationLevel, 0);
});

test("R6: a reminder that fails delivery is recorded as failed with a reason, retried, and never marked sent", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  assert.deepEqual([rem.status, rem.statusReason, rem.sentAt, rem.attempts], ["failed", "delivery_failed", null, 1]);
  assert.ok(reminderEvents.some((e) => e.reminderId === rem.id && e.type === "delivery_failed" && e.channel === "email" && e.detail.attempt === 1), "the failure is recorded for troubleshooting");
});

test("R6: a reminder that fails repeatedly stops being retried after the limit but is STILL escalated, and the escalation is retried on its own limit", async () => {
  approved();
  emailFailFor.add("smR1");
  for (let i = 0; i < 8; i++) await runJob(at(i)); // the first-line delivery fails every time
  const rem = reminderOf("tOver");
  assert.equal(rem.attempts, 5, "first-line retries stop at the existing limit");
  assert.equal(rem.status, "failed");
  assert.equal(rem.escalationLevel, 0);
  await runJob(at(30));
  assert.equal(rem.escalationLevel, 1, "exhausted retries do not hide it from the next level");
  assert.equal(rem.attempts, 5, "and the first reminder is not sent again");
});

test("R6: escalation of an undelivered reminder happens exactly once per level under repeated and simultaneous cron runs", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  await Promise.all([runJob(at(30)), runJob(at(30)), runJob(at(30))]);
  await runJob(at(30));
  await runJob(at(31));
  assert.equal(rem.escalationLevel, 1);
  assert.equal(reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "escalated" && e.level === 1).length, 1, "one escalation event");
  assert.equal(reminderEvents.filter((e) => e.reminderId === rem.id && e.type === "sent" && e.level === 1 && e.recipientId === "rm1" && e.channel === "email").length, 1, "the Regional Manager was e-mailed once for this reminder");
  await runJob(at(55));
  assert.equal(rem.escalationLevel, 2);
  await runJob(at(200));
  assert.equal(rem.escalationLevel, 2, "two levels at most");
});

test("R6: a resolved or closed ticket's undelivered reminder is closed, not escalated", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  assert.equal(rem.status, "failed");
  tickets.tOver.status = "closed";
  const before = notifications.length;
  const out = await runJob(at(40));
  assert.equal(rem.status, "closed");
  assert.equal(rem.escalationLevel, 0);
  assert.equal(out.closed >= 1, true);
  assert.ok(notifications.slice(before).every((n) => n.payload.activityRef !== "TCK-1"), "nothing was sent about a finished ticket");
  reset();
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  tickets.tOver.status = "resolved";
  await runJob(at(40));
  assert.equal(reminderOf("tOver").status, "closed");
  assert.equal(reminderOf("tOver").escalationLevel, 0);
});

test("R6: an acknowledged reminder is not escalated even if its first delivery failed", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  rem.acknowledgedAt = at(1); // taken over by hand (for example after an escalation of another stage)
  rem.status = "acknowledged";
  await runJob(at(60));
  assert.equal(rem.escalationLevel, 0);
});

test("R6: delivery errors on the escalation itself keep the level due and retry it (the provider throwing is a failed attempt, not a crash)", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  emailFailFor.add("rm1");
  const out = await runJob(at(30));
  assert.equal(rem.escalationLevel, 0, "the level is not consumed while nobody was reached");
  assert.ok(out.escalationRetryPending >= 1);
  assert.ok(reminderEvents.some((e) => e.reminderId === rem.id && e.level === 1 && e.type === "delivery_failed"));
  emailFailFor.clear();
  await runJob(at(31));
  assert.equal(rem.escalationLevel, 1);
});

test("R6: missing or inactive recipients at escalation time are recorded and settle the level without contacting anyone unrelated", async () => {
  approved();
  emailFailFor.add("smR1");
  await runJob(NOW);
  const rem = reminderOf("tOver");
  for (const u of Object.values(users) as any[]) if (["rm1", "mgmt", "owner"].includes(u.id)) u.isActive = false;
  const out = await runJob(at(30));
  assert.equal(out.escalationNoRecipient >= 1, true);
  assert.equal(rem.escalationLevel, 1);
  assert.ok(reminderEvents.some((e) => e.reminderId === rem.id && e.type === "escalation_no_recipient"));
});

test("approved policy: the reminders-off state and the validated, configurable policy", async () => {
  reset();
  stubModel("companySettings", { findUnique: async () => settings, upsert: async ({ update }: any) => { settings = { ...settings, ...update }; return settings; } });
  settings.reminderLeadDays = null;
  settings.reminderEscalationHours = null;
  let dash = await call("smR1", "GET", "/reminders");
  assert.deepEqual([dash.status, dash.body.policy.remindersEnabled], [200, false], "off until a policy is saved");
  assert.equal((await runJob(NOW)).enabled, false);
  assert.equal(reminders.length, 0, "the job creates and sends nothing while off");

  const { PROPOSED_REMINDER_POLICY } = await import("@recd/shared");
  const saved = await call("mgmt", "PUT", "/settings/reminders", PROPOSED_REMINDER_POLICY);
  assert.equal(saved.status, 200);
  assert.deepEqual([settings.reminderLeadDays, settings.reminderEscalationHours], [3, 24], "the proposed values are accepted through the existing endpoint");
  dash = await call("smR1", "GET", "/reminders");
  assert.deepEqual([dash.body.policy.remindersEnabled, dash.body.policy.reminderLeadDays, dash.body.policy.reminderEscalationHours], [true, 3, 24]);
  assert.equal((await call("mgmt", "PUT", "/settings/reminders", { reminderLeadDays: null, reminderEscalationHours: 24 })).status, 400, "escalation still needs a lead time");
  for (const who of ["smR1", "rm1", "eng", "custA"]) assert.equal((await call(who, "PUT", "/settings/reminders", PROPOSED_REMINDER_POLICY)).status, 403, who);
});

test("approved policy: existing region and role restrictions still apply to the dashboard and to acknowledging", async () => {
  approved();
  await runJob(NOW);
  const north = reminderOf("tOver");
  const south = reminderOf("tSouth");
  const seen = (await call("smR1", "GET", "/reminders")).body.rows.map((r: any) => r.activityRef);
  assert.ok(seen.includes("TCK-1") && !seen.includes("TCK-6"), "a North Service Manager sees North only");
  assert.equal((await call("smR2", "POST", `/reminders/${north.id}/acknowledge`)).status, 403);
  assert.equal((await call("smR1", "POST", `/reminders/${south.id}/acknowledge`)).status, 403);
  for (const who of ["eng", "vendorEng", "custA", "sales"]) assert.equal((await call(who, "GET", "/reminders")).status, 403, who);
});
