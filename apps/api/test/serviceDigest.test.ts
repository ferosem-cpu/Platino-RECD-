// Region-wise Service Manager daily digest. No database, no SMTP: Prisma delegates are in-memory stubs and the e-mail provider is a stub.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = new Date("2026-10-21T04:00:00.000Z");
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

let regions: any[] = [];
let tickets: any[] = [];
let mapped: any[] = [];
let logs: any[] = [];
let sends: Array<{ to: string; templateKey: string; data: any }> = [];
let emailFails = new Set<string>();
const db: Record<string, Record<string, (...a: any[]) => any>> = {};
const realEnv = process.env.SERVICE_DIGEST_ENABLED;

const ticket = (n: string, regionId: string, over: any = {}) => ({
  ticketNumber: n, status: "open", createdAt: day("2026-10-10"), dueDate: null, archivedAt: null, regionId, customer: { name: "Acme <b>" }, ...over,
});

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  for (const model of ["region", "complaint", "regionManager", "notificationLog"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  const { providersByChannel } = await import("../src/services/notifications/providers");
  providersByChannel.email = { channel: "email", send: async ({ recipientId, templateKey, data }: any) => { if (emailFails.has(recipientId)) return false; sends.push({ to: recipientId, templateKey, data }); return true; } } as any;
  db.region = { findMany: async () => regions };
  db.complaint = {
    findMany: async ({ where }: any) =>
      tickets.filter((t) => !where.status.notIn.includes(t.status) && t.archivedAt === null && t.regionId === where.site.regionId),
  };
  db.regionManager = {
    findMany: async ({ where }: any) => mapped.filter((m) => m.regionId === where.regionId && m.active).map((m) => ({ userId: m.userId, user: { role: { key: m.role } } })),
  };
  db.notificationLog = {
    findFirst: async ({ where }: any) =>
      logs.find((l) => l.recipientId === where.recipientId && l.templateKey === where.templateKey && l.status === "sent" && l.createdAt >= where.createdAt.gte && l.payload.regionId === where.payload.equals) ?? null,
    create: async ({ data }: any) => { const row = { ...data, createdAt: new Date() }; logs.push(row); return row; },
  };
});
after(() => { if (realEnv === undefined) delete process.env.SERVICE_DIGEST_ENABLED; else process.env.SERVICE_DIGEST_ENABLED = realEnv; });

beforeEach(() => {
  process.env.SERVICE_DIGEST_ENABLED = "1";
  regions = [{ id: "r1", name: "North" }, { id: "r2", name: "South" }];
  mapped = [
    { regionId: "r1", userId: "sm1", role: "service_manager", active: true },
    { regionId: "r1", userId: "rm1", role: "regional_manager", active: true },
    { regionId: "r2", userId: "rm2", role: "regional_manager", active: true },
  ];
  tickets = [
    ticket("T-1", "r1", { dueDate: day("2026-10-15") }),
    ticket("T-2", "r1"),
    ticket("T-3", "r1", { status: "resolved" }),
    ticket("T-4", "r1", { archivedAt: new Date() }),
    ticket("T-5", "r2"),
  ];
  logs = []; sends = []; emailFails = new Set();
});

const run = async (now = NOW) => (await import("../src/lib/serviceDigest")).runServiceDigest(now);

test("off by default: nothing is sent unless SERVICE_DIGEST_ENABLED=1", async () => {
  delete process.env.SERVICE_DIGEST_ENABLED;
  const r = await run();
  assert.equal(r.enabled, false);
  assert.equal(sends.length, 0);
});

test("one digest per region to its Service Manager (not the Regional Manager), counting only open, non-archived tickets", async () => {
  const r = await run();
  const north = sends.filter((s) => s.data.regionName === "North");
  assert.deepEqual(north.map((s) => s.to), ["sm1"]);
  assert.equal(north[0].data.openCount, 2);
  assert.equal(north[0].data.overdueCount, 1);
  assert.equal(north[0].data.tickets[0].ticketNumber, "T-1", "overdue tickets are listed first");
  // South has no Service Manager mapped: falls back to its Regional Manager, like the first reminder.
  assert.deepEqual(sends.filter((s) => s.data.regionName === "South").map((s) => s.to), ["rm2"]);
  assert.equal(r.sent, 2);
});

test("a region with nobody mapped, or with no open tickets, gets no digest", async () => {
  mapped = mapped.filter((m) => m.regionId !== "r2");
  tickets = tickets.filter((t) => t.regionId !== "r2");
  regions.push({ id: "r3", name: "East" });
  mapped.push({ regionId: "r3", userId: "sm3", role: "service_manager", active: true });
  await run();
  assert.deepEqual(sends.map((s) => s.to), ["sm1"]);
});

test("a second run the same day does not repeat the digest; the next day it is sent again", async () => {
  await run();
  const first = sends.length;
  const again = await run(new Date("2026-10-21T16:00:00.000Z"));
  assert.equal(sends.length, first);
  assert.equal(again.skippedAlreadySent, 2);
  await run(new Date(Date.now() + 2 * 86_400_000));
  assert.ok(sends.length > first);
});

test("a failed e-mail is counted as failed, not delivered, and is retried by the next run", async () => {
  emailFails.add("sm1");
  const r = await run();
  assert.equal(r.failed, 1);
  assert.equal(sends.filter((s) => s.to === "sm1").length, 0);
  emailFails.clear();
  await run();
  assert.equal(sends.filter((s) => s.to === "sm1").length, 1);
});

test("template: digest content is escaped", async () => {
  const { renderEmail } = await import("../src/services/notifications/emailTemplates");
  const m = renderEmail("service_digest", { regionName: "<i>N</i>", openCount: 2, overdueCount: 1, tickets: [{ ticketNumber: "T-1", customerName: "<script>x</script>", status: "in_progress", openDays: 3, dueDate: "2026-10-15", overdue: true }] });
  assert.ok(!m.html.includes("<script>") && !m.html.includes("<i>N</i>"));
  assert.ok(m.html.includes("&lt;script&gt;"));
  assert.ok(m.text.includes("OVERDUE") && m.text.includes("in progress"));
  assert.match(m.subject, /daily service digest/);
});

test("each listed ticket carries customer, site and serial (\"not recorded\" when missing)", async () => {
  tickets = [
    ticket("T-1", "r1", { site: { companyName: "Plant <1>" }, unit: { serialNo: "SN-001" } }),
    ticket("T-2", "r1"),
  ];
  await run();
  const north = sends.find((s) => s.data.regionName === "North")!;
  assert.deepEqual(north.data.tickets.map((t: any) => [t.siteName, t.serialNo]), [["Plant <1>", "SN-001"], [null, null]]);
  const { renderEmail } = await import("../src/services/notifications/emailTemplates");
  const m = renderEmail("service_digest", north.data);
  assert.ok(m.text.includes("serial SN-001") && m.text.includes("serial not recorded"));
  assert.ok(m.html.includes("Plant &lt;1&gt;") && !m.html.includes("Plant <1>"));
});
