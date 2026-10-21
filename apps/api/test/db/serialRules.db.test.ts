/**
 * Real-database tests for the RECD serial / complaint / AMC rules: unique-constraint races,
 * transactions, foreign keys and the role permission matrix, against actual Postgres.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL
 * point at the disposable Docker database (localhost:5434/platino_test), and they only ever
 * touch rows they created themselves (every serial and PO starts with a unique run prefix;
 * everything is removed in the `after` hook). Run with:  npm run test:db --workspace=apps/api
 * (the database must already be migrated and seeded).
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
describe("RECD serial rules against the real test database", { skip }, () => {
  const PREFIX = `ZT${Date.now().toString(36).toUpperCase()}`;
  const tracked = { orderIds: new Set<string>(), unitIds: new Set<string>(), customerIds: new Set<string>(), userIds: new Set<string>(), amcIds: new Set<string>(), conversationIds: new Set<string>() };
  // While true, the open-complaint pre-check is skipped, so the request reaches the REAL database index
  // exactly as the loser of a genuine race would (the race window itself is too narrow to hit reliably).
  let skipOpenComplaintCheck = false;
  let uv: typeof import("../../src/lib/uniqueViolations");
  let seq = 0;
  const serial = (tag: string) => `${PREFIX}-${tag}-${++seq}`;
  const po = () => `${PREFIX}-PO${++seq}`;

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let executeConfirmedAction: (tool: string, input: Record<string, unknown>, userId: string) => Promise<string>;
  let safeActionMessage = "";
  let productId = "";
  let custA = "";
  let custB = "";
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};

  async function call(as: string | null, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  async function makeOrder(customerId: string, serials: string[], as = "admin") {
    const r = await call(as, "POST", "/orders", { customerId, productId, quantity: serials.length, poNumber: po(), recdSerials: serials });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.orderIds.add(r.body.id);
    const units = await prisma.recdUnit.findMany({ where: { orderId: r.body.id }, orderBy: { createdAt: "asc" } });
    return { order: r.body, siteId: r.body.site.id as string, units };
  }

  async function makeUser(tag: string, roleKey: string, customerId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const user = await prisma.user.create({
      data: { name: `${PREFIX} ${tag}`, email: `${PREFIX.toLowerCase()}-${tag}@example.invalid`, roleId: role.id, customerId: customerId ?? null, isActive: true, mustChangePassword: false },
    });
    tracked.userIds.add(user.id);
    userIds[tag] = user.id;
    tokens[tag] = signToken({ userId: user.id, roleKey, customerId: customerId ?? null });
    return user;
  }

  async function seededToken(tag: string, email: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
    userIds[tag] = u.id;
    tokens[tag] = signToken({ userId: u.id, roleKey: u.role.key, customerId: u.customerId });
    return u;
  }

  async function cleanup() {
    if (!prisma) return;
    const customerIds = [...tracked.customerIds];
    const units = await prisma.recdUnit.findMany({
      where: { OR: [{ serialNo: { startsWith: PREFIX } }, { id: { in: [...tracked.unitIds] } }, { orderId: { in: [...tracked.orderIds] } }] },
      select: { id: true, orderId: true },
    });
    const poOrders = await prisma.order.findMany({ where: { poNumber: { startsWith: PREFIX } }, select: { id: true } });
    const orderIds = [...new Set([...tracked.orderIds, ...units.map((u: any) => u.orderId), ...poOrders.map((o: any) => o.id)])];
    const sites = await prisma.site.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    const siteIds = sites.map((s: any) => s.id);
    const complaints = await prisma.complaint.findMany({
      where: { OR: [{ siteId: { in: siteIds } }, { customerId: { in: ["seed-customer-1", ...customerIds] }, description: { startsWith: PREFIX } }] },
      select: { id: true, ticketNumber: true },
    });
    for (const c of complaints) {
      await prisma.notificationLog.deleteMany({ where: { payload: { path: ["ticketNumber"], equals: c.ticketNumber } } });
    }
    await prisma.complaint.deleteMany({ where: { id: { in: complaints.map((c: any) => c.id) } } });
    await prisma.agentConversation.deleteMany({ where: { OR: [{ id: { in: [...tracked.conversationIds] } }, { title: { startsWith: PREFIX } }] } });
    await prisma.amcOrder.deleteMany({ where: { OR: [{ id: { in: [...tracked.amcIds] } }, { poNo: { startsWith: PREFIX } }] } });
    await prisma.recdUnit.deleteMany({ where: { id: { in: [...units.map((u: any) => u.id), ...tracked.unitIds] } } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }

  before(async () => {
    ({ prisma } = await import("../../src/lib/prisma"));
    // Second, independent check straight from the server: we really are on the disposable database.
    const [{ db, port }] = await prisma.$queryRaw`select current_database() as db, inet_server_port() as port`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    assert.ok(Number(port) > 0);

    ({ signToken } = await import("../../src/lib/jwt"));
    ({ executeConfirmedAction, SAFE_ACTION_FAILED_MESSAGE: safeActionMessage } = await import("../../src/routes/agentConversations"));
    uv = await import("../../src/lib/uniqueViolations");
    prisma.$use(async (params: any, next: any) => {
      if (skipOpenComplaintCheck && params.model === "Complaint" && params.action === "findFirst") return null;
      return next(params);
    });
    const { ordersRouter } = await import("../../src/routes/orders");
    const { sitesRouter } = await import("../../src/routes/sites");
    const { recdUnitsRouter } = await import("../../src/routes/recdUnits");
    const { amcOrdersRouter } = await import("../../src/routes/amcOrders");
    const { complaintsRouter } = await import("../../src/routes/complaints");
    const { agentConversationsRouter } = await import("../../src/routes/agentConversations");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/orders", ordersRouter);
    app.use("/sites", sitesRouter);
    app.use("/recd-units", recdUnitsRouter);
    app.use("/amc-orders", amcOrdersRouter);
    app.use("/complaints", complaintsRouter);
    app.use("/agent", agentConversationsRouter);
    // Unexpected errors must surface as 500s (quietly, as JSON) - the tests assert on exactly that.
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    custA = "seed-customer-1";
    const b = await prisma.customer.create({ data: { name: `${PREFIX} Customer B` } });
    tracked.customerIds.add(b.id);
    custB = b.id;

    await seededToken("admin", "superadmin@platino.example");
    await seededToken("sales", "sales@platino.example");
    await seededToken("service", "service@platino.example");
    await seededToken("custA", "customer@sundaram.example");
    await seededToken("vendorEng", "erection@platino.example");
    await makeUser("custB", "customer", custB);
    await makeUser("fieldEng", "service_engineer");
  });

  after(async () => {
    server?.close();
    try { await cleanup(); } finally { await prisma?.$disconnect(); }
  });

  // ------------------------------------------------------------------------------------------
  // DB-level constraints
  // ------------------------------------------------------------------------------------------

  test("the database itself refuses a duplicate serial but allows any number of legacy (null) serials", async () => {
    const { order, siteId } = await makeOrder(custA, [serial("DB")]);
    const unit = (await prisma.recdUnit.findMany({ where: { orderId: order.id } }))[0];
    await assert.rejects(
      prisma.recdUnit.create({ data: { serialNo: unit.serialNo, orderId: order.id, siteId, productId } }),
      (e: any) => e.code === "P2002",
    );
    const a = await prisma.recdUnit.create({ data: { orderId: order.id, siteId, productId } });
    const b = await prisma.recdUnit.create({ data: { orderId: order.id, siteId, productId } });
    tracked.unitIds.add(a.id); tracked.unitIds.add(b.id);
    assert.equal(a.serialNo, null);
    assert.equal(b.serialNo, null);
  });

  test("serials are matched case-insensitively by the API even though the column is exact", async () => {
    const s = serial("CASE");
    await makeOrder(custA, [s]);
    const dup = await call("admin", "POST", "/orders", { customerId: custA, productId, quantity: 1, poNumber: po(), recdSerials: [s.toLowerCase()] });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
  });

  // ------------------------------------------------------------------------------------------
  // Subtask 1: duplicates, including simultaneous requests
  // ------------------------------------------------------------------------------------------

  test("POST /orders: a sequential duplicate is a 409 and creates nothing", async () => {
    const s = serial("SEQ");
    await makeOrder(custA, [s]);
    const p = po();
    const r = await call("admin", "POST", "/orders", { customerId: custA, productId, quantity: 1, poNumber: p, recdSerials: [s] });
    assert.equal(r.status, 409);
    assert.equal(await prisma.order.count({ where: { poNumber: p } }), 0);
  });

  test("POST /orders: two simultaneous requests for one serial - exactly one wins, nothing is left behind", async () => {
    for (let round = 0; round < 6; round++) {
      const s = serial("RACE");
      const [p1, p2] = [po(), po()];
      const body = (p: string) => ({ customerId: custA, productId, quantity: 1, poNumber: p, recdSerials: [s] });
      const [r1, r2] = await Promise.all([call("admin", "POST", "/orders", body(p1)), call("admin", "POST", "/orders", body(p2))]);
      for (const r of [r1, r2]) if (r.status === 201) tracked.orderIds.add(r.body.id);
      assert.deepEqual([r1.status, r2.status].sort(), [201, 409], `round ${round}: ${JSON.stringify([r1.body, r2.body])}`);
      assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 1, `round ${round}: one unit`);
      assert.equal(await prisma.order.count({ where: { poNumber: { in: [p1, p2] } } }), 1, `round ${round}: the losing order must not be left behind`);
      const orphanSites = await prisma.site.count({ where: { order: { poNumber: { in: [p1, p2] }, units: { none: {} } } } });
      assert.equal(orphanSites, 0, `round ${round}: no order/site without units`);
    }
  });

  test("line items: two simultaneous requests for one serial - one wins, no orphan line item", async () => {
    const { order } = await makeOrder(custA, [serial("LI-BASE")]);
    for (let round = 0; round < 4; round++) {
      const s = serial("LI");
      const body = { productId, quantity: 1, recdSerials: [s] };
      const before = await prisma.orderLineItem.count({ where: { orderId: order.id } });
      const [r1, r2] = await Promise.all([call("admin", "POST", `/orders/${order.id}/line-items`, body), call("admin", "POST", `/orders/${order.id}/line-items`, body)]);
      assert.deepEqual([r1.status, r2.status].sort(), [201, 409], JSON.stringify([r1.body, r2.body]));
      assert.equal(await prisma.orderLineItem.count({ where: { orderId: order.id } }), before + 1, "exactly one line item added");
      assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 1);
    }
  });

  test("clone-order: two simultaneous requests for one serial - one wins, no orphan order", async () => {
    const { order, siteId } = await makeOrder(custA, [serial("CL-BASE")]);
    const basePo = order.poNumber as string;
    for (let round = 0; round < 4; round++) {
      const s = serial("CL");
      const body = { productId, quantity: 1, recdSerials: [s] };
      const before = await prisma.order.count({ where: { poNumber: basePo } });
      const [r1, r2] = await Promise.all([call("admin", "POST", `/sites/${siteId}/clone-order`, body), call("admin", "POST", `/sites/${siteId}/clone-order`, body)]);
      for (const r of [r1, r2]) if (r.status === 201) tracked.orderIds.add(r.body.id);
      assert.deepEqual([r1.status, r2.status].sort(), [201, 409], JSON.stringify([r1.body, r2.body]));
      assert.equal(await prisma.order.count({ where: { poNumber: basePo } }), before + 1, "exactly one sibling order added");
      assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 1);
    }
  });

  test("PUT /recd-units/:id/serial: two simultaneous requests giving two legacy units the same serial", async () => {
    const { order, siteId } = await makeOrder(custA, [serial("PUT-BASE")]);
    for (let round = 0; round < 4; round++) {
      const [u1, u2] = await Promise.all([1, 2].map(() => prisma.recdUnit.create({ data: { orderId: order.id, siteId, productId } })));
      tracked.unitIds.add(u1.id); tracked.unitIds.add(u2.id);
      const s = serial("PUT");
      const [r1, r2] = await Promise.all([
        call("admin", "PUT", `/recd-units/${u1.id}/serial`, { serialNo: s }),
        call("admin", "PUT", `/recd-units/${u2.id}/serial`, { serialNo: s }),
      ]);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.body, r2.body]));
      assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 1);
    }
  });

  test("AI order confirmation: simultaneous cards with one serial - one order, the other refused, nothing orphaned", async () => {
    for (let round = 0; round < 4; round++) {
      const s = serial("AI");
      const input = { customerId: custA, productId, quantity: 1, recdSerials: [s] };
      // distinct POs: this test races the SERIAL; the same-PO race is covered in orderCreation.db.test.ts
      const results = await Promise.allSettled([executeConfirmedAction("create_order", { ...input, poNumber: po() }, userIds.admin), executeConfirmedAction("create_order", { ...input, poNumber: po() }, userIds.admin)]);
      for (const r of results) if (r.status === "fulfilled") tracked.orderIds.add(r.value);
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"], JSON.stringify(results));
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.match(String(rejected.reason.message), /already registered|just registered/);
      assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 1);
      const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>;
      assert.equal(await prisma.recdUnit.count({ where: { orderId: winner.value } }), 1, "the order has its unit");
    }
  });

  test("AI order confirmation without serials creates nothing", async () => {
    const before = await prisma.order.count();
    await assert.rejects(executeConfirmedAction("create_order", { customerId: custA, productId, quantity: 2 }, userIds.admin), /recdSerials is required/);
    assert.equal(await prisma.order.count(), before);
  });

  // ------------------------------------------------------------------------------------------
  // Requirement: serial <-> customer / site / DG
  // ------------------------------------------------------------------------------------------

  test("the serial is returned with the right customer, site and DG details", async () => {
    const s = serial("ASSOC");
    const { order, siteId } = await makeOrder(custA, [s]);
    await prisma.site.update({ where: { id: siteId }, data: { companyName: `${PREFIX} Plant`, dgModel: "Cummins C500", dgCapacityKva: 500 } });
    const unit = await prisma.recdUnit.findFirstOrThrow({ where: { serialNo: s } });

    const r = await call("admin", "GET", `/recd-units/${unit.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.serialNo, s);
    assert.equal(r.body.order.id, order.id);
    assert.equal(r.body.order.customer.id, custA);
    assert.equal(r.body.site.id, siteId);
    assert.equal(r.body.site.companyName, `${PREFIX} Plant`);
    assert.equal(r.body.site.dgModel, "Cummins C500");
    assert.equal(Number(r.body.site.dgCapacityKva), 500);

    const list = await call("admin", "GET", `/recd-units?search=${encodeURIComponent(s)}`);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, unit.id);
  });

  // ------------------------------------------------------------------------------------------
  // Subtask 2: complaints go to the right unit
  // ------------------------------------------------------------------------------------------

  const photo = "data:image/png;base64,iVBORw0KGgo=";
  const complaint = (siteId: string, extra: Record<string, unknown> = {}) => ({
    siteId, category: "non_performance", description: `${PREFIX} noisy`, severity: "low", attachmentUrl: photo, ...extra,
  });

  test("complaints: a multi-unit site needs a choice; the chosen unit is stored and appears in only that unit's history", async () => {
    const { siteId, units } = await makeOrder(custA, [serial("C1"), serial("C2")]);
    const [u1, u2] = units;

    const none = await call("custA", "POST", "/complaints", complaint(siteId));
    assert.equal(none.status, 400);
    assert.match(none.body.error, /select the RECD serial number/);

    const ok = await call("custA", "POST", "/complaints", complaint(siteId, { unitId: u2.id }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.unitId, u2.id);
    assert.equal(ok.body.siteId, siteId);
    assert.equal(ok.body.customerId, custA);

    const h2 = await call("admin", "GET", `/recd-units/${u2.id}/history`);
    const h1 = await call("admin", "GET", `/recd-units/${u1.id}/history`);
    assert.deepEqual(h2.body.complaints.map((c: any) => c.ticketNumber), [ok.body.ticketNumber]);
    assert.deepEqual(h1.body.complaints, [], "the sibling unit's history is untouched");

    const again = await call("custA", "POST", "/complaints", complaint(siteId, { unitId: u2.id }));
    assert.equal(again.status, 400, "one open complaint per RECD");
    const other = await call("custA", "POST", "/complaints", complaint(siteId, { unitId: u1.id }));
    assert.equal(other.status, 201, "but a different RECD at the same site is independent");
  });

  test("complaints: a single-unit site links automatically; the photo is mandatory", async () => {
    const { siteId, units } = await makeOrder(custA, [serial("C3")]);
    const noPhoto = await call("custA", "POST", "/complaints", { ...complaint(siteId), attachmentUrl: "" });
    assert.equal(noPhoto.status, 400);
    const ok = await call("custA", "POST", "/complaints", complaint(siteId));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.unitId, units[0].id);
  });

  test("complaints: units and sites of other customers are rejected", async () => {
    const a = await makeOrder(custA, [serial("X1")]);
    const b = await makeOrder(custB, [serial("X2")]);
    const asBOnA = await call("custB", "POST", "/complaints", complaint(a.siteId, { unitId: a.units[0].id }));
    assert.equal(asBOnA.status, 403, "B cannot use A's site");
    const aWithBUnit = await call("custA", "POST", "/complaints", complaint(a.siteId, { unitId: b.units[0].id }));
    assert.equal(aWithBUnit.status, 400, "B's unit is not part of A's site");
    assert.equal(await prisma.complaint.count({ where: { OR: [{ unitId: b.units[0].id }, { siteId: { in: [a.siteId, b.siteId] } }] } }), 0);
  });

  test("complaints: the database allows only one open ticket per unit even if the API check is bypassed", async () => {
    const { siteId, units } = await makeOrder(custA, [serial("OPEN")]);
    const base = { customerId: custA, siteId, unitId: units[0].id, category: "x", description: `${PREFIX} d`, severity: "low", status: "open" };
    await prisma.complaint.create({ data: { ...base, ticketNumber: `${PREFIX}-T1` } });
    await assert.rejects(prisma.complaint.create({ data: { ...base, ticketNumber: `${PREFIX}-T2` } }), (e: any) => e.code === "P2002");
    await prisma.complaint.updateMany({ where: { unitId: units[0].id }, data: { status: "closed" } });
    await prisma.complaint.create({ data: { ...base, ticketNumber: `${PREFIX}-T3` } });
  });

  // ------------------------------------------------------------------------------------------
  // AMC <-> units
  // ------------------------------------------------------------------------------------------

  const amc = (customerId: string, unitIds: string[]) => ({
    poNo: `${PREFIX}-AMC${++seq}`, poDate: "2026-01-01T00:00:00.000Z", customerId, location: "Plant", item: "RECD", qty: Math.max(unitIds.length, 1), amcFrequencyPerYear: 4, amcType: "camc", unitIds,
  });

  test("AMC: one contract covers several units; they show in the list and in each unit's history", async () => {
    const { units } = await makeOrder(custA, [serial("AMC1"), serial("AMC2")]);
    const r = await call("admin", "POST", "/amc-orders", amc(custA, units.map((u: any) => u.id)));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.amcIds.add(r.body.id);
    assert.deepEqual(r.body.units.map((l: any) => l.unit.serialNo).sort(), units.map((u: any) => u.serialNo).sort());

    const list = await call("admin", "GET", "/amc-orders");
    const mine = list.body.orders.find((o: any) => o.id === r.body.id);
    assert.equal(mine.units.length, 2);
    for (const u of units) {
      const h = await call("admin", "GET", `/recd-units/${u.id}/history`);
      assert.deepEqual(h.body.amcOrders.map((a: any) => a.id), [r.body.id]);
    }
  });

  test("AMC: units of another customer, unknown, serial-less or repeated units are rejected and nothing is saved", async () => {
    const a = await makeOrder(custA, [serial("AMC3")]);
    const b = await makeOrder(custB, [serial("AMC4")]);
    const legacy = await prisma.recdUnit.create({ data: { orderId: a.order.id, siteId: a.siteId, productId } });
    tracked.unitIds.add(legacy.id);
    const before = await prisma.amcOrder.count({ where: { poNo: { startsWith: PREFIX } } });

    for (const [label, ids] of [
      ["other customer's unit", [a.units[0].id, b.units[0].id]],
      ["unknown id", ["no-such-unit"]],
      ["legacy unit without serial", [legacy.id]],
      ["same unit twice", [a.units[0].id, a.units[0].id]],
    ] as const) {
      const r = await call("admin", "POST", "/amc-orders", amc(custA, [...ids]));
      assert.equal(r.status, 400, label);
    }
    assert.equal(await prisma.amcOrder.count({ where: { poNo: { startsWith: PREFIX } } }), before, "no AMC was created by any rejected request");
  });

  test("AMC: existing AMC orders without units still list fine", async () => {
    const legacy = await prisma.amcOrder.create({
      data: { poNo: `${PREFIX}-LEGACY`, poDate: new Date("2023-01-01"), customerId: custA, location: "Old", item: "RECD", qty: 1, amcFrequencyPerYear: 1, amcType: "camc" },
    });
    tracked.amcIds.add(legacy.id);
    const list = await call("admin", "GET", "/amc-orders");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.orders.find((o: any) => o.id === legacy.id).units, []);
  });

  test("AMC: a covered unit cannot be deleted from under it; deleting the AMC frees the links", async () => {
    const { order, units } = await makeOrder(custA, [serial("AMC5")]);
    const r = await call("admin", "POST", "/amc-orders", amc(custA, [units[0].id]));
    assert.equal(r.status, 201);
    tracked.amcIds.add(r.body.id);

    await assert.rejects(prisma.recdUnit.delete({ where: { id: units[0].id } }), (e: any) => e.code === "P2003", "foreign key blocks it");
    const del = await call("admin", "DELETE", `/orders/${order.id}`);
    assert.equal(del.status, 400, "the order route refuses first, with a clear message");
    assert.match(del.body.error, /covered by an AMC/);

    await prisma.amcOrder.delete({ where: { id: r.body.id } });
    assert.equal(await prisma.amcOrderUnit.count({ where: { unitId: units[0].id } }), 0, "links cascade away with the AMC");
    assert.equal(await prisma.recdUnit.count({ where: { id: units[0].id } }), 1, "the unit itself is untouched");
  });

  // ------------------------------------------------------------------------------------------
  // Subtask 4: permissions with the real seeded roles
  // ------------------------------------------------------------------------------------------

  test("service history is limited by role, using the real seeded permissions", async () => {
    const { siteId, units } = await makeOrder(custA, [serial("P1"), serial("P2")]);
    const [mine, theirs] = units;
    const t1 = await call("custA", "POST", "/complaints", complaint(siteId, { unitId: mine.id, attachmentUrl: photo }));
    const t2 = await call("custA", "POST", "/complaints", complaint(siteId, { unitId: theirs.id }));
    assert.equal(t1.status, 201); assert.equal(t2.status, 201);
    await prisma.complaint.update({ where: { id: t1.body.id }, data: { assignedToId: userIds.fieldEng, serviceReportUrl: "data:application/pdf;base64,AAAA" } });
    const amcRes = await call("admin", "POST", "/amc-orders", amc(custA, [mine.id]));
    tracked.amcIds.add(amcRes.body.id);

    const hist = (as: string | null, unit = mine) => call(as, "GET", `/recd-units/${unit.id}/history`);

    assert.equal((await hist(null)).status, 401, "no login");

    const admin = await hist("admin");
    assert.equal(admin.status, 200);
    assert.equal(admin.body.complaints.length, 1);
    assert.ok(admin.body.complaints[0].events.length >= 1, "management sees the ticket timeline");
    assert.equal(admin.body.complaints[0].serviceReportUrl, "data:application/pdf;base64,AAAA");
    assert.equal(admin.body.amcOrders.length, 1);

    const service = await hist("service");
    assert.equal(service.status, 200);
    assert.equal(service.body.complaints.length, 1);
    assert.equal(service.body.amcVisible, false, "service desk has no AMC permission");

    const own = await hist("custA");
    assert.equal(own.status, 200);
    assert.equal(own.body.complaints.length, 1);
    assert.deepEqual(own.body.complaints[0].events, [], "customers never get internal ticket events");
    assert.equal(own.body.amcOrders.length, 1, "their own AMC");

    const stranger = await hist("custB");
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.complaints, undefined);
    assert.equal((await call("custB", "GET", `/recd-units/${mine.id}`)).status, 403);

    const sales = await hist("sales");
    assert.equal(sales.status, 200);
    assert.equal(sales.body.unit.serialNo, mine.serialNo, "basic unit info is visible");
    assert.equal(sales.body.complaintsVisible, false);
    assert.equal(sales.body.amcVisible, false);
    assert.deepEqual(sales.body.complaints, []);
    assert.deepEqual(sales.body.amcOrders, []);
    assert.equal(JSON.stringify(sales.body).includes("serviceReportUrl"), false);

    // Field engineer: only the ticket assigned to them, on whichever unit.
    const eng1 = await hist("fieldEng", mine);
    assert.deepEqual(eng1.body.complaints.map((c: any) => c.id), [t1.body.id]);
    const eng2 = await hist("fieldEng", theirs);
    assert.equal(eng2.status, 200);
    assert.deepEqual(eng2.body.complaints, [], "a ticket assigned to someone else stays hidden");
    assert.equal(eng2.body.amcVisible, false);

    // A vendor-scoped engineer only sees units at their own vendor's sites (this site has no vendor).
    assert.equal((await hist("vendorEng")).status, 403);
  });

  test("AMC and serial-writing endpoints enforce permissions on the server", async () => {
    const { units } = await makeOrder(custA, [serial("P3")]);
    for (const who of ["custA", "custB", "sales", "service", "fieldEng", "vendorEng"]) {
      assert.equal((await call(who, "GET", "/amc-orders")).status, 403, `${who} GET /amc-orders`);
      assert.equal((await call(who, "POST", "/amc-orders", amc(custA, [units[0].id]))).status, 403, `${who} POST /amc-orders`);
    }
    const pending = await prisma.recdUnit.create({ data: { orderId: units[0].orderId, siteId: units[0].siteId, productId } });
    tracked.unitIds.add(pending.id);
    for (const who of ["custA", "custB", "service", "fieldEng", "vendorEng"]) {
      assert.equal((await call(who, "PUT", `/recd-units/${pending.id}/serial`, { serialNo: serial("NOPE") })).status, 403, `${who} PUT serial`);
    }
    assert.equal((await prisma.recdUnit.findUniqueOrThrow({ where: { id: pending.id } })).serialNo, null);
    const ok = await call("sales", "PUT", `/recd-units/${pending.id}/serial`, { serialNo: serial("OK") });
    assert.equal(ok.status, 200, "sales manages orders and may enter a legacy serial");
  });

  test("a legacy unit with no serial shows its history without errors", async () => {
    const { order, siteId } = await makeOrder(custA, [serial("LEG")]);
    const legacy = await prisma.recdUnit.create({ data: { orderId: order.id, siteId, productId } });
    tracked.unitIds.add(legacy.id);
    const h = await call("admin", "GET", `/recd-units/${legacy.id}/history`);
    assert.equal(h.status, 200);
    assert.equal(h.body.unit.serialNo, null);
    const pendingList = await call("admin", "GET", "/recd-units?pending=1");
    assert.ok(pendingList.body.some((u: any) => u.id === legacy.id));
  });

  // ------------------------------------------------------------------------------------------
  // Which unique constraint fired? Real Postgres errors, real HTTP responses, real final state.
  // ------------------------------------------------------------------------------------------

  async function caught(fn: () => Promise<unknown>): Promise<unknown> {
    try { await fn(); } catch (e) { return e; }
    assert.fail("expected the database to reject this");
  }

  test("the classifier recognises the errors the real database produces - and only the right one each time", async () => {
    const { order, siteId, units } = await makeOrder(custA, [serial("CLS")]);
    const stage = await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } });
    const cdata = (ticketNumber: string, status = "open") => ({ ticketNumber, customerId: custA, siteId, unitId: units[0].id, category: "x", description: PREFIX, severity: "low", status });
    await prisma.complaint.create({ data: cdata(`${PREFIX}-CT1`) });

    const errors = {
      serial: await caught(() => prisma.recdUnit.create({ data: { serialNo: units[0].serialNo, orderId: order.id, siteId, productId } })),
      orderNumber: await caught(() => prisma.order.create({ data: { orderNumber: order.orderNumber, customerId: custA, productId, quantity: 1, site: { create: { currentStageId: stage.id } } } })),
      openComplaint: await caught(() => prisma.complaint.create({ data: cdata(`${PREFIX}-CT2`) })),
      ticketNumber: await caught(() => prisma.complaint.create({ data: { ...cdata(`${PREFIX}-CT1`), unitId: null, status: "closed" } })),
      foreignKey: await caught(() => prisma.complaint.create({ data: { ...cdata(`${PREFIX}-CT3`), unitId: null, siteId: "no-such-site" } })),
    };
    const checks: Record<string, (e: unknown) => boolean> = { serial: uv.isSerialConflict, orderNumber: uv.isOrderNumberConflict, openComplaint: uv.isOpenComplaintConflict };
    const expected: Record<string, string | null> = { serial: "serial", orderNumber: "orderNumber", openComplaint: "openComplaint", ticketNumber: null, foreignKey: null };
    for (const [label, e] of Object.entries(errors)) {
      for (const [name, fn] of Object.entries(checks)) {
        assert.equal(fn(e), expected[label] === name, `${label} error vs ${name} check: ${JSON.stringify((e as any).meta)}`);
      }
    }
    assert.equal((errors.foreignKey as any).code, "P2003");
    assert.deepEqual(uv.uniqueViolationTarget(errors.openComplaint)?.fields, ["unitId"], "the partial index reports its column");
  });

  /** Makes only the FIRST Math.random() call return `value` (then the real generator), to force one collision. */
  async function withRandomOnce<T>(value: number, fn: () => Promise<T>): Promise<T> {
    const real = Math.random;
    let used = false;
    Math.random = () => { if (!used) { used = true; return value; } return real(); };
    try { return await fn(); } finally { Math.random = real; }
  }

  /** Pins the server's random order/ticket number so a collision with an existing row is certain. */
  async function withRandom<T>(value: number, fn: () => Promise<T>): Promise<T> {
    const real = Math.random;
    Math.random = () => value;
    try { return await fn(); } finally { Math.random = real; }
  }
  const year = new Date().getFullYear();

  async function occupyOrderNumber(): Promise<string> {
    const number = `ORD-${year}-9999`; // what Math.random() = 0.9999999 produces
    const existing = await prisma.order.findUnique({ where: { orderNumber: number }, select: { id: true } });
    if (existing) {
      // Reuse our own blocker from an earlier test in this run; anything else means real data is in the way.
      assert.ok(tracked.orderIds.has(existing.id), "test precondition: that order number belongs to someone else's data");
      return number;
    }
    const blocker = await prisma.order.create({ data: { orderNumber: number, customerId: custA, productId, quantity: 1 } });
    tracked.orderIds.add(blocker.id);
    return number;
  }

  test("POST /orders: a real order-number collision is a 409 about the order number, and nothing is saved", async () => {
    const number = await occupyOrderNumber();
    const s = serial("ONUM");
    const p = po();
    const r = await withRandom(0.9999999, () => call("admin", "POST", "/orders", { customerId: custA, productId, quantity: 1, poNumber: p, recdSerials: [s] }));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    // Every attempt is pinned to the same taken number, so the bounded retry is exhausted (it never reuses the number).
    assert.equal(r.body.code, "ORDER_NUMBER_EXHAUSTED");
    assert.match(r.body.error, /order number/i);
    assert.doesNotMatch(r.body.error, /serial/i, "must not be blamed on the serial number");
    assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 0, "no unit saved");
    assert.equal(await prisma.order.count({ where: { poNumber: p } }), 0, "no order saved");
    assert.equal(await prisma.order.count({ where: { orderNumber: number } }), 1, "the existing order is untouched");
    const retry = await call("admin", "POST", "/orders", { customerId: custA, productId, quantity: 1, poNumber: p, recdSerials: [s] });
    assert.equal(retry.status, 201, "submitting again works - the serial was never consumed");
    tracked.orderIds.add(retry.body.id);
  });

  test("clone-order: a real order-number collision is a 409 about the order number, and nothing is saved", async () => {
    const { siteId, order } = await makeOrder(custA, [serial("CLN-BASE")]);
    await occupyOrderNumber();
    const s = serial("CLN");
    const r = await withRandom(0.9999999, () => call("admin", "POST", `/sites/${siteId}/clone-order`, { productId, quantity: 1, recdSerials: [s] }));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "ORDER_NUMBER_EXHAUSTED");
    assert.doesNotMatch(r.body.error, /serial/i);
    assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 0);
    assert.equal(await prisma.order.count({ where: { poNumber: order.poNumber } }), 1, "no sibling order saved");
  });

  test("POST /orders: ONE order-number collision is retried with a new number and the order is saved once", async () => {
    await occupyOrderNumber();
    const s = serial("ONUM1");
    const p = po();
    const r = await withRandomOnce(0.9999999, () => call("admin", "POST", "/orders", { customerId: custA, productId, quantity: 1, poNumber: p, recdSerials: [s] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.orderIds.add(r.body.id);
    assert.notEqual(r.body.orderNumber, `ORD-${year}-9999`);
    assert.equal(await prisma.order.count({ where: { poNumber: p } }), 1);
    assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 1);
  });

  // ------------------------------------------------------------------------------------------
  // Racing complaints against the real partial unique index
  // ------------------------------------------------------------------------------------------

  const openCount = (unitId: string) => prisma.complaint.count({ where: { unitId, status: { notIn: ["resolved", "closed"] } } });

  test("complaints: the loser of a real race gets a 400 from the database index, and only one ticket is open", async () => {
    const { siteId, units } = await makeOrder(custA, [serial("RACE-C")]);
    const first = await call("custA", "POST", "/complaints", complaint(siteId));
    assert.equal(first.status, 201);

    skipOpenComplaintCheck = true; // the second request "passed the check" before the first one committed
    let second;
    try { second = await call("custA", "POST", "/complaints", complaint(siteId, { unitId: units[0].id })); } finally { skipOpenComplaintCheck = false; }

    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.match(second.body.error, /open complaint already exists/);
    assert.doesNotMatch(second.body.error, /TCK-/, "this is the database-index path, not the pre-check path");
    assert.equal(await openCount(units[0].id), 1, "exactly one open ticket remains");
    assert.equal(await prisma.complaint.count({ where: { unitId: units[0].id } }), 1, "the loser saved nothing");
  });

  test("complaints: simultaneous requests for one unit - exactly one ticket is created", async () => {
    for (let round = 0; round < 6; round++) {
      const { siteId, units } = await makeOrder(custA, [serial(`RC${round}`)]);
      const [r1, r2] = await Promise.all([call("custA", "POST", "/complaints", complaint(siteId)), call("custA", "POST", "/complaints", complaint(siteId))]);
      assert.deepEqual([r1.status, r2.status].sort(), [201, 400], `round ${round}: ${JSON.stringify([r1.body, r2.body])}`);
      assert.equal(await openCount(units[0].id), 1, `round ${round}`);
    }
  });

  test("complaints: a ticket-number collision is NOT reported as 'open complaint already exists'", async () => {
    const a = await makeOrder(custA, [serial("TN-A")]);
    const b = await makeOrder(custA, [serial("TN-B")]);
    const ticket = `TCK-${year}-55000`; // what Math.random() = 0.5 produces
    assert.equal(await prisma.complaint.count({ where: { ticketNumber: ticket } }), 0, "precondition");
    await prisma.complaint.create({ data: { ticketNumber: ticket, customerId: custA, siteId: a.siteId, unitId: a.units[0].id, category: "x", description: PREFIX, severity: "low", status: "closed" } });

    // Every attempt generates the same (already used) number: bounded retries, then a clear 409.
    const r = await withRandom(0.5, () => call("custA", "POST", "/complaints", complaint(b.siteId)));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "TICKET_NUMBER_CONFLICT");
    assert.doesNotMatch(JSON.stringify(r.body), /open complaint/);
    assert.equal(await prisma.complaint.count({ where: { unitId: b.units[0].id } }), 0, "nothing was saved");
    const ok = await call("custA", "POST", "/complaints", complaint(b.siteId));
    assert.equal(ok.status, 201, "and a normal retry works");
  });

  test("complaints: a ticket-number collision is retried with a new number and the complaint is saved", async () => {
    const a = await makeOrder(custA, [serial("TR-A")]);
    const b = await makeOrder(custA, [serial("TR-B")]);
    const ticket = `TCK-${year}-55000`;
    const existing = await prisma.complaint.findUnique({ where: { ticketNumber: ticket } });
    if (!existing) {
      await prisma.complaint.create({ data: { ticketNumber: ticket, customerId: custA, siteId: a.siteId, unitId: a.units[0].id, category: "x", description: PREFIX, severity: "low", status: "closed" } });
    }
    // The first number the server generates collides with the existing ticket; the next ones are real.
    const r = await withRandomOnce(0.5, () => call("custA", "POST", "/complaints", complaint(b.siteId)));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(r.body.ticketNumber, ticket, "a new number was generated");
    assert.equal(r.body.unitId, b.units[0].id);
    assert.equal(await prisma.complaint.count({ where: { unitId: b.units[0].id } }), 1, "exactly one ticket saved");
    assert.equal(await prisma.complaint.count({ where: { ticketNumber: ticket } }), 1, "the existing ticket is untouched");
  });

  // ------------------------------------------------------------------------------------------
  // AI order confirmation through the real route
  // ------------------------------------------------------------------------------------------

  async function proposeAiOrder(input: Record<string, unknown>) {
    const conversation = await prisma.agentConversation.create({ data: { userId: userIds.admin, title: `${PREFIX} chat` } });
    tracked.conversationIds.add(conversation.id);
    const action = await prisma.agentPendingAction.create({
      data: { conversationId: conversation.id, toolName: "create_order", input: { customerId: custA, productId, quantity: 1, poNumber: po(), ...input } as any, preview: {} as any, createdById: userIds.admin },
    });
    const confirm = () => call("admin", "POST", `/agent/conversations/${conversation.id}/actions/${action.id}/confirm`);
    const reject = () => call("admin", "POST", `/agent/conversations/${conversation.id}/actions/${action.id}/reject`);
    const status = async () => (await prisma.agentPendingAction.findUniqueOrThrow({ where: { id: action.id } })).status as string;
    return { confirm, reject, status };
  }

  test("AI confirmation route: invalid input is a 400 and the card stays pending, then can be rejected", async () => {
    const ordersBefore = await prisma.order.count();
    const repeated = serial("AIY");
    for (const [label, input] of [
      ["card with no serials (proposed before the rule)", {}],
      ["wrong number of serials", { quantity: 2, recdSerials: [serial("AIX")] }],
      ["repeated serial", { quantity: 2, recdSerials: [repeated, repeated.toLowerCase()] }],
      ["malformed serial", { recdSerials: ["has space"] }],
    ] as const) {
      const card = await proposeAiOrder(input);
      const r = await card.confirm();
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
      assert.ok(typeof r.body.error === "string" && r.body.error.length > 10, label);
      assert.equal(await card.status(), "pending", `${label}: the card is still pending`);
      assert.equal(await prisma.order.count(), ordersBefore, `${label}: nothing was created`);
      const rejected = await card.reject();
      assert.equal(rejected.status, 200, `${label}: the user can still reject it`);
      assert.equal(await card.status(), "rejected");
    }
  });

  test("AI confirmation route: a taken serial is a 409; a valid card succeeds; a racing pair gives one of each", async () => {
    const existing = await makeOrder(custA, [serial("AI-TAKEN")]);
    const taken = await proposeAiOrder({ recdSerials: [existing.units[0].serialNo] });
    const conflict = await taken.confirm();
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.match(conflict.body.error, /already registered/);
    assert.equal(await taken.status(), "pending");

    const s = serial("AI-OK");
    const good = await proposeAiOrder({ recdSerials: [s.toLowerCase()] });
    const ok = await good.confirm();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    tracked.orderIds.add(ok.body.resultId);
    assert.equal(await good.status(), "confirmed");
    const unit = await prisma.recdUnit.findFirstOrThrow({ where: { serialNo: s } });
    assert.equal(unit.orderId, ok.body.resultId);

    for (let round = 0; round < 3; round++) {
      const shared = serial(`AI-RACE${round}`);
      const [c1, c2] = await Promise.all([proposeAiOrder({ recdSerials: [shared] }), proposeAiOrder({ recdSerials: [shared] })]);
      const [r1, r2] = await Promise.all([c1.confirm(), c2.confirm()]);
      for (const r of [r1, r2]) if (r.status === 200) tracked.orderIds.add(r.body.resultId);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 409], `round ${round}: ${JSON.stringify([r1.body, r2.body])}`);
      assert.equal(await prisma.recdUnit.count({ where: { serialNo: shared } }), 1);
      const loser = r1.status === 409 ? c1 : c2;
      assert.equal(await loser.status(), "pending", "the losing card stays pending");
    }
  });

  test("AI confirmation route: an order-number collision is a 409 about the order number", async () => {
    await occupyOrderNumber();
    const s = serial("AI-ONUM");
    const card = await proposeAiOrder({ recdSerials: [s] });
    const r = await withRandom(0.9999999, () => card.confirm());
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /order number/i);
    assert.doesNotMatch(r.body.error, /serial/i);
    assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 0);
    assert.equal(await card.status(), "pending");
  });

  test("AI confirmation route: an unknown customer is a clean 400 (not a foreign-key 500) and nothing is left behind", async () => {
    const s = serial("AI-FK");
    const card = await proposeAiOrder({ customerId: "no-such-customer", recdSerials: [s] });
    const before = await prisma.order.count();
    const r = await card.confirm();
    assert.equal(r.status, 400, "a bad customer reference is a client error");
    assert.equal(r.body.error, "Customer not found");
    assert.doesNotMatch(JSON.stringify(r.body), /foreign key|invocation|customerId|Order_|prisma|constraint/i, "no database details in the response");
    assert.equal(await prisma.recdUnit.count({ where: { serialNo: s } }), 0, "no unit left behind");
    assert.equal(await prisma.order.count(), before, "no order left behind");
    assert.equal(await card.status(), "pending");
  });

  // ------------------------------------------------------------------------------------------
  // AMC: invalid customer
  // ------------------------------------------------------------------------------------------

  test("AMC: an unknown customer is a 400, not a 500, and saves nothing", async () => {
    const before = await prisma.amcOrder.count();
    for (const unitIds of [[], ["no-such-unit"]]) {
      const r = await call("admin", "POST", "/amc-orders", amc("no-such-customer", unitIds));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, "Customer not found");
    }
    assert.equal(await prisma.amcOrder.count(), before);
  });

  test("AMC: quantity is independent of the number of linked units (current rule, awaiting mentor decision)", async () => {
    const { units } = await makeOrder(custA, [serial("QTY1"), serial("QTY2")]);
    const more = await call("admin", "POST", "/amc-orders", { ...amc(custA, [units[0].id]), qty: 5 });
    const fewer = await call("admin", "POST", "/amc-orders", { ...amc(custA, units.map((u: any) => u.id)), qty: 1 });
    for (const r of [more, fewer]) { assert.equal(r.status, 201, JSON.stringify(r.body)); tracked.amcIds.add(r.body.id); }
  });
});

// Runs even when the guard skips everything above, so a skipped run is never silently empty.
test("the isolated-database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@127.0.0.1:5434/platino_test"), true);
  for (const bad of [
    "postgresql://u:p@localhost:5432/platino_test",
    "postgresql://u:p@localhost:5434/postgres",
    "postgresql://u:p@db.example.com:5434/platino_test",
    "postgresql://u:p@aws-1-ap-south-1.pooler.supabase.com:6543/postgres",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(pointsAtIsolatedDb(bad), false);
  }
});
