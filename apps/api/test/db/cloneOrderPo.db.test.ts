/**
 * Real-database tests for POST /sites/:id/clone-order and the duplicate-PO rule (Requirement 9): a cloned order is checked like any new order -
 * per customer, case-insensitive, under the customer + PO advisory lock - with the administrator override flagged on the order, and a refused
 * or failed clone leaves nothing behind.
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
describe("clone-order and the duplicate-PO rule against the real test database", { skip }, () => {
  const PREFIX = `ZC${Date.now().toString(36).toUpperCase()}`;
  let seq = 0;
  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let productId = "";
  let stageId = "";
  const customerIds: string[] = [];
  const userIds: string[] = [];
  const W: Record<string, any> = {};
  const realConsole = { log: console.log, error: console.error };

  async function user(tag: string, roleKey: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: role.id, isActive: true, mustChangePassword: false } });
    userIds.push(u.id);
    return u;
  }
  /** A customer with a source order (carrying `po`) and its site. */
  async function source(tag: string, po: string) {
    const c = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    customerIds.push(c.id);
    const o = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-${tag}-S${++seq}`, customerId: c.id, productId, quantity: 1, poNumber: po, site: { create: { currentStageId: stageId } } },
      include: { site: true },
    });
    return { customer: c, order: o, site: o.site };
  }
  const call = async (as: any, siteId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/sites/${siteId}/clone-order`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signToken({ userId: as.id, roleKey: "x", customerId: null })}` },
      body: JSON.stringify({ productId, quantity: 1, recdSerials: [`${PREFIX}-SN${++seq}`], ...body }),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const ordersOf = (customerId: string) => prisma.order.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } });

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    const { sitesRouter } = await import("../../src/routes/sites");
    const app = express();
    app.use(express.json());
    app.use("/sites", sitesRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    W.admin = await user("admin", "management");
    W.sales = await user("sales", "sales");
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
        const ids = orders.map((o: any) => o.id);
        await prisma.recdUnit.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.site.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.order.deleteMany({ where: { id: { in: ids } } });
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  test("a clone with a NEW unique PO is created, unflagged, with its own site and unit", async () => {
    const s = await source("uniq", `${PREFIX}-PO-A`);
    const r = await call(W.sales, s.site.id, { poNumber: `  ${PREFIX}-PO-NEW ` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.id }, include: { site: true, units: true } });
    assert.deepEqual([row.poNumber, row.poDuplicateFlag, row.customerId], [`${PREFIX}-PO-NEW`, false, s.customer.id]);
    assert.ok(row.site);
    assert.equal(row.units.length, 1);
  });

  test("a clone that copies the source PO (or repeats it in any case / padding) is refused 409 DUPLICATE_PO and creates nothing", async () => {
    const s = await source("dup", `${PREFIX}-PO-B`);
    for (const body of [{}, { poNumber: `${PREFIX}-po-b` }, { poNumber: `  ${PREFIX}-Po-B  ` }]) {
      const r = await call(W.sales, s.site.id, body);
      assert.deepEqual([r.status, r.body.code], [409, "DUPLICATE_PO"], JSON.stringify(body));
      assert.equal(r.body.existingOrderNumber, s.order.orderNumber);
    }
    assert.equal((await ordersOf(s.customer.id)).length, 1, "no order was left behind");
    assert.equal(await prisma.site.count({ where: { order: { customerId: s.customer.id } } }), 1, "and no site");
  });

  test("the same PO for a DIFFERENT customer is not a duplicate (the rule is per customer)", async () => {
    const a = await source("custA", `${PREFIX}-PO-C`);
    const b = await source("custB", `${PREFIX}-PO-D`);
    const r = await call(W.sales, b.site.id, { poNumber: `${PREFIX}-PO-C` }); // customer A's PO, used on customer B's site
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.poDuplicateFlag, false);
    assert.equal((await ordersOf(a.customer.id)).length, 1);
  });

  test("override: only an administrator role that ticks it; the clone is created and flagged, a non-admin's tick is ignored", async () => {
    const s = await source("ovr", `${PREFIX}-PO-E`);
    assert.equal((await call(W.sales, s.site.id, { allowDuplicatePo: true })).status, 409, "sales cannot override");
    assert.equal((await call(W.admin, s.site.id, {})).status, 409, "an administrator must tick it");
    const ok = await call(W.admin, s.site.id, { allowDuplicatePo: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.poDuplicateFlag, true);
    assert.deepEqual((await ordersOf(s.customer.id)).map((o: any) => o.poDuplicateFlag), [false, true], "the original stays unflagged");
  });

  test("simultaneous clones with the same new PO: exactly one is created (real advisory lock); approved duplicates all succeed and are flagged", async () => {
    const s = await source("race", `${PREFIX}-PO-F`);
    const po = `${PREFIX}-PO-RACE`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(W.sales, s.site.id, { poNumber: po })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.code === "DUPLICATE_PO"));
    assert.equal(await prisma.order.count({ where: { customerId: s.customer.id, poNumber: po } }), 1);

    const approved = await Promise.all(Array.from({ length: 4 }, () => call(W.admin, s.site.id, { poNumber: po, allowDuplicatePo: true })));
    assert.ok(approved.every((r) => r.status === 201), approved.map((r) => r.status).join());
    assert.equal(await prisma.order.count({ where: { customerId: s.customer.id, poNumber: po, poDuplicateFlag: true } }), 4);
  });

  test("a clone that fails after the PO check (serial already registered) rolls everything back", async () => {
    const s = await source("rb", `${PREFIX}-PO-G`);
    const taken = `${PREFIX}-TAKEN`;
    await prisma.recdUnit.create({ data: { serialNo: taken, orderId: s.order.id, siteId: s.site.id, productId } });
    const r = await call(W.sales, s.site.id, { poNumber: `${PREFIX}-PO-G2`, recdSerials: [taken] });
    assert.equal(r.status, 409);
    assert.deepEqual((await ordersOf(s.customer.id)).map((o: any) => o.poNumber), [`${PREFIX}-PO-G`], "no order left behind");
    assert.equal(await prisma.order.count({ where: { poNumber: `${PREFIX}-PO-G2` } }), 0);
  });

  test("a legacy source order without a PO can be cloned (nothing to check)", async () => {
    const s = await source("legacy", `${PREFIX}-PO-H`);
    await prisma.order.update({ where: { id: s.order.id }, data: { poNumber: null } });
    const r = await call(W.sales, s.site.id, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.poNumber, null);
  });
});
