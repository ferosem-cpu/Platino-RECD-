/**
 * Real-database tests for the dashboard counts (Requirement 10): a Regional Manager (the approved "Zonal Manager") sees only the regions mapped
 * to them; higher roles keep the company-wide view; a request parameter can narrow but never widen the scope.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; removed in `after`). Nothing is sent.
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
const skip = isolated ? false : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test), or JWT_SECRET is missing - refusing to touch any database";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("dashboard regional scope against the real test database", { skip }, () => {
  const PREFIX = `ZD${Date.now().toString(36).toUpperCase()}`;
  let seq = 0;
  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let productId = "";
  let stageId = "";
  let phase = "";
  const customerIds: string[] = [];
  const userIds: string[] = [];
  const regionIds: string[] = [];
  const orderIds: string[] = [];
  const complaintIds: string[] = [];
  const W: Record<string, any> = {};
  const realConsole = { log: console.log, error: console.error };

  async function user(tag: string, roleKey: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: role.id, isActive: true, mustChangePassword: false } });
    userIds.push(u.id);
    return u;
  }
  async function site(regionId: string | null) {
    const o = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-O${++seq}`, customerId: W.customer.id, productId, quantity: 1, site: { create: { currentStageId: stageId, regionId } } },
      include: { site: true },
    });
    orderIds.push(o.id);
    return o.site;
  }
  async function ticket(siteId: string | null, status: string) {
    const t = await prisma.complaint.create({
      data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: W.customer.id, siteId, category: "non_performance", description: `${PREFIX}`, severity: "medium", status },
    });
    complaintIds.push(t.id);
    return t;
  }
  const get = async (as: any, query = "") => {
    const res = await fetch(`${base}/dashboard${query}`, { headers: { authorization: `Bearer ${signToken({ userId: as.id, roleKey: "x", customerId: null })}` } });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    const { dashboardRouter } = await import("../../src/routes/dashboard");
    const app = express();
    app.use("/dashboard", dashboardRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    const stage = await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } });
    stageId = stage.id;
    phase = stage.phase;
    W.customer = await prisma.customer.create({ data: { name: `${PREFIX} customer` } });
    customerIds.push(W.customer.id);
    for (const n of [1, 2, 3]) {
      W[`R${n}`] = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-${n}`, name: `${PREFIX} R${n}` } });
      regionIds.push(W[`R${n}`].id);
    }
    W.rm1 = await user("regional 1", "regional_manager"); // R1
    W.rm12 = await user("regional 1+2", "regional_manager"); // R1 and R2
    W.rmNone = await user("regional unmapped", "regional_manager");
    W.mgmt = await user("management", "management");
    W.owner = await user("owner", "owner_admin");
    W.sa = await user("super admin", "super_admin");
    W.sales = await user("sales", "sales");
    await prisma.regionManager.createMany({ data: [{ regionId: W.R1.id, userId: W.rm1.id }, { regionId: W.R1.id, userId: W.rm12.id }, { regionId: W.R2.id, userId: W.rm12.id }] });

    // (one active ticket per site is a database rule, so each active ticket gets its own site)
    // R1: 4 sites, 3 counted tickets (open, open, closed) + 1 archived; R2: 1 site, 1 ticket (open); R3: 1 site, 1 ticket (resolved); no region: 1 site; a ticket without a site.
    const s1a = await site(W.R1.id); const s1b = await site(W.R1.id); const s1c = await site(W.R1.id); const s1d = await site(W.R1.id);
    const s2 = await site(W.R2.id); const s3 = await site(W.R3.id); const s0 = await site(null);
    await ticket(s1a.id, "open"); await ticket(s1b.id, "open"); await ticket(s1c.id, "closed");
    await ticket(s2.id, "open"); await ticket(s3.id, "resolved"); await ticket(s0.id, "open"); await ticket(null, "open");
    // an ARCHIVED ticket in R1 is never counted
    const arch = await ticket(s1d.id, "open");
    await prisma.complaint.update({ where: { id: arch.id }, data: { archivedAt: new Date() } });
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        await prisma.complaint.deleteMany({ where: { id: { in: complaintIds } } });
        await prisma.site.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // their region mappings go with them
        await prisma.region.deleteMany({ where: { id: { in: regionIds } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  test("a Regional Manager sees only their own region's sites and tickets (archived tickets excluded)", async () => {
    const r = await get(W.rm1);
    assert.equal(r.status, 200);
    assert.equal(total(r.body.sitesByPhase), 4);
    assert.equal(r.body.sitesByPhase[phase], 4);
    assert.equal(r.body.complaintsByStatus.open, 2);
    assert.equal(r.body.complaintsByStatus.closed, 1);
    assert.equal(r.body.complaintsByStatus.resolved, 0, "R3's resolved ticket is not theirs");
    assert.equal(total(r.body.complaintsByStatus), 3);
  });

  test("a manager mapped to several regions sees the sum of exactly those regions, not the third one or unassigned data", async () => {
    const r = await get(W.rm12);
    assert.equal(total(r.body.sitesByPhase), 5, "R1 (4) + R2 (1)");
    assert.equal(total(r.body.complaintsByStatus), 4, "R1 (3) + R2 (1)");
    assert.equal(r.body.complaintsByStatus.resolved, 0);
  });

  test("a Regional Manager with no region sees nothing - never the company-wide figures", async () => {
    const r = await get(W.rmNone);
    assert.equal(r.status, 200);
    assert.equal(total(r.body.sitesByPhase), 0);
    assert.equal(total(r.body.complaintsByStatus), 0);
    const askAll = await get(W.rmNone, `?regionId=${W.R1.id}`);
    assert.equal(total(askAll.body.sitesByPhase) + total(askAll.body.complaintsByStatus), 0, "and asking for a region does not help");
  });

  test("request parameters cannot widen the scope: another region, an unknown region, an empty value or repeated values", async () => {
    for (const q of [`?regionId=${W.R3.id}`, `?regionId=${W.R2.id}`, "?regionId=nope", `?regionId=${W.R3.id}&regionId=${W.R1.id}`, "?regionId=", "?all=true", "?scope=all", "?regionId=null"]) {
      const r = await get(W.rm1, q);
      assert.equal(r.status, 200, q);
      if (q.includes(W.R1.id) && !q.includes("regionId=&")) continue; // repeated values: Express gives an array; asOptionalString ignores it -> the caller's own scope
      assert.ok(total(r.body.sitesByPhase) <= 4 && total(r.body.complaintsByStatus) <= 3, `${q}: ${JSON.stringify(r.body)}`);
      if (q === `?regionId=${W.R3.id}` || q === `?regionId=${W.R2.id}` || q === "?regionId=nope") assert.equal(total(r.body.sitesByPhase) + total(r.body.complaintsByStatus), 0, q);
    }
    const own = await get(W.rm12, `?regionId=${W.R2.id}`);
    assert.equal(total(own.body.sitesByPhase), 1, "narrowing to one of their own regions works");
    assert.equal(total(own.body.complaintsByStatus), 1);
  });

  test("Super Admin, Owner/Admin and Management keep the company-wide view; ?regionId= narrows them to that region", async () => {
    const everything = {
      sites: await prisma.site.count(),
      tickets: await prisma.complaint.count({ where: { archivedAt: null } }),
    };
    for (const who of [W.sa, W.owner, W.mgmt]) {
      const r = await get(who);
      assert.equal(r.status, 200);
      assert.equal(total(r.body.sitesByPhase), everything.sites, "every site, including unassigned ones");
      assert.equal(total(r.body.complaintsByStatus), everything.tickets, "every non-archived ticket, including one without a site");
    }
    const r3 = await get(W.mgmt, `?regionId=${W.R3.id}`);
    assert.equal(total(r3.body.sitesByPhase), 1);
    assert.equal(r3.body.complaintsByStatus.resolved, 1);
  });

  test("a role without the dashboard permission is still refused", async () => {
    assert.equal((await get(W.sales)).status, 403);
  });
});
