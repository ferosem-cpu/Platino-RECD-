/**
 * Real-database tests for order creation (Requirement 9): the duplicate-PO policy under real concurrency (the
 * transaction-scoped advisory lock), the administrator override, atomic rollback, reference checks and the order-number retry.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable
 * Docker database (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; everything
 * is removed in `after`). Nothing is sent. Run with:  npm run test:db --workspace=apps/api   (database already migrated and seeded)
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";

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

const isolated = pointsAtIsolatedDb(process.env.DATABASE_URL) && pointsAtIsolatedDb(process.env.DIRECT_URL);
const skip = isolated ? false : "DATABASE_URL / DIRECT_URL are not both the isolated local test database (localhost:5434/platino_test) - refusing to touch any database";

/* eslint-disable @typescript-eslint/no-explicit-any */
describe("order creation against the real test database", { skip }, () => {
  const PREFIX = `ZO${Date.now().toString(36).toUpperCase()}`;
  const year = new Date().getFullYear();
  let seq = 0;
  let prisma: any;
  let create: typeof import("../../src/lib/orderCreation");
  let productId = "";
  let adminId = "";
  const customerIds: string[] = [];
  const realRandom = Math.random;

  const newCustomer = async (tag: string) => {
    const c = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    customerIds.push(c.id);
    return c.id as string;
  };
  const input = (customerId: string, poNumber: string, extra: Record<string, unknown> = {}) => ({
    customerId, productId, quantity: 1, poNumber, serials: [`${PREFIX}-S${++seq}`], salesEngineerId: adminId, roleKey: "management", ...extra,
  });
  const ordersWithPo = (customerId: string) => prisma.order.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } });
  const settle = (ps: Promise<any>[]) => Promise.allSettled(ps);
  const codeOf = (r: PromiseSettledResult<any>) => (r.status === "rejected" ? (r.reason as any).code ?? "other:" + (r.reason as Error).message : "ok");

  before(async () => {
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    assert.notEqual(process.env.NODE_ENV, "production");
    create = await import("../../src/lib/orderCreation");
    productId = (await prisma.product.findFirstOrThrow({ select: { id: true } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { isActive: true }, select: { id: true } })).id;
  });

  after(async () => {
    Math.random = realRandom;
    if (!prisma) return;
    const orders = await prisma.order.findMany({ where: { OR: [{ customerId: { in: customerIds } }, { orderNumber: { startsWith: PREFIX } }] }, select: { id: true } });
    const ids = orders.map((o: any) => o.id);
    await prisma.recdUnit.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.site.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.$disconnect();
  });

  test("a unique PO is saved trimmed with its site and unit, unflagged", async () => {
    const c = await newCustomer("unique");
    const o = await create.createNewOrder(input(c, `  ${PREFIX}-PO1  `));
    const row = await prisma.order.findUnique({ where: { id: o.id }, include: { site: true, units: true } });
    assert.equal(row.poNumber, `${PREFIX}-PO1`);
    assert.equal(row.poDuplicateFlag, false);
    assert.ok(row.site);
    assert.equal(row.units.length, 1);
  });

  test("a duplicate (same customer, any case, padded) is refused with DUPLICATE_PO; a different customer may reuse the PO", async () => {
    const a = await newCustomer("dupA");
    const b = await newCustomer("dupB");
    await create.createNewOrder(input(a, `${PREFIX}-PO2`));
    for (const variant of [`${PREFIX}-po2`, `  ${PREFIX}-Po2 `]) {
      await assert.rejects(create.createNewOrder(input(a, variant)), (e: any) => e.code === "DUPLICATE_PO" && e.status === 409);
    }
    await create.createNewOrder(input(b, `${PREFIX}-PO2`));
    assert.equal((await ordersWithPo(a)).length, 1);
    assert.equal((await ordersWithPo(b)).length, 1);
  });

  test("simultaneous requests for one customer + PO: exactly one order is created (real advisory lock)", async () => {
    const c = await newCustomer("race");
    const variants = [`${PREFIX}-PO3`, `${PREFIX}-po3`, ` ${PREFIX}-PO3`, `${PREFIX}-Po3 `, `${PREFIX}-PO3`, `${PREFIX}-PO3`];
    const results = await settle(variants.map((v) => create.createNewOrder(input(c, v))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, results.map(codeOf).join(","));
    assert.deepEqual(results.filter((r) => r.status === "rejected").map(codeOf), Array(variants.length - 1).fill("DUPLICATE_PO"));
    const rows = await ordersWithPo(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].poDuplicateFlag, false);
    assert.equal(await prisma.recdUnit.count({ where: { orderId: rows[0].id } }), 1, "losers left no units");
    assert.equal(await prisma.site.count({ where: { orderId: { not: rows[0].id }, order: { customerId: c } } }), 0, "losers left no sites");
  });

  test("simultaneous approved duplicates: all are created and exactly one (the original) is unflagged", async () => {
    const c = await newCustomer("override");
    const results = await settle([1, 2, 3, 4].map(() => create.createNewOrder(input(c, `${PREFIX}-PO4`, { allowDuplicatePo: true }))));
    assert.deepEqual(results.map(codeOf), ["ok", "ok", "ok", "ok"]);
    const rows = await ordersWithPo(c);
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((r: any) => !r.poDuplicateFlag).length, 1);
    // Sales cannot override
    await assert.rejects(create.createNewOrder(input(c, `${PREFIX}-PO4`, { allowDuplicatePo: true, roleKey: "sales" })), (e: any) => e.code === "DUPLICATE_PO");
  });

  test("simultaneous requests for different customers / POs do not block or reject each other", async () => {
    const a = await newCustomer("indA");
    const b = await newCustomer("indB");
    const results = await settle([
      create.createNewOrder(input(a, `${PREFIX}-PO5`)),
      create.createNewOrder(input(a, `${PREFIX}-PO6`)),
      create.createNewOrder(input(b, `${PREFIX}-PO5`)),
    ]);
    assert.deepEqual(results.map(codeOf), ["ok", "ok", "ok"]);
  });

  test("unknown customer or product: a clean 400-type error and nothing is written", async () => {
    const c = await newCustomer("refs");
    await assert.rejects(create.createNewOrder(input("no-such-customer", `${PREFIX}-PO7`)), (e: any) => e.status === 400 && e.message === "Customer not found");
    await assert.rejects(create.createNewOrder({ ...input(c, `${PREFIX}-PO7`), productId: "no-such-product" }), (e: any) => e.status === 400 && e.message === "Product not found");
    assert.equal((await ordersWithPo(c)).length, 0);
  });

  test("a serial that is already registered rolls the whole order back (no order, site or unit left)", async () => {
    const c = await newCustomer("rollback");
    const first = input(c, `${PREFIX}-PO8`);
    await create.createNewOrder(first);
    const clash = { ...input(c, `${PREFIX}-PO9`), serials: first.serials };
    await assert.rejects(create.createNewOrder(clash), (e: any) => e.code === "P2002");
    const rows = await ordersWithPo(c);
    assert.deepEqual(rows.map((r: any) => r.poNumber), [`${PREFIX}-PO8`], "the failed order was not left behind");
    assert.equal(await prisma.site.count({ where: { order: { customerId: c } } }), 1);
  });

  test("an order-number collision is retried and the order is saved once; exhausted retries save nothing", async () => {
    const c = await newCustomer("onum");
    // Force the generator to produce one fixed number, taken by an existing order.
    const taken = `ORD-${year}-4999`;
    const existing = await prisma.order.findUnique({ where: { orderNumber: taken } });
    if (!existing) await prisma.order.create({ data: { orderNumber: taken, customerId: c, productId, quantity: 1, poNumber: `${PREFIX}-TAKEN` } });
    const fixed = 0.4444; // floor(1000 + 0.4444 * 9000) = 4999
    assert.equal(Math.floor(1000 + fixed * 9000), 4999);
    let calls = 0;
    Math.random = () => (calls++ < 2 ? fixed : realRandom());
    let saved;
    try {
      saved = await create.createNewOrder(input(c, `${PREFIX}-PO10`));
    } finally {
      Math.random = realRandom;
    }
    assert.notEqual(saved.orderNumber, taken, "never reuses an existing number");
    assert.equal((await prisma.order.findMany({ where: { poNumber: `${PREFIX}-PO10` } })).length, 1);

    Math.random = () => fixed;
    const before = await prisma.order.count({ where: { customerId: c } });
    try {
      await assert.rejects(create.createNewOrder(input(c, `${PREFIX}-PO11`)), (e: any) => e.code === "ORDER_NUMBER_EXHAUSTED" && e.status === 409);
    } finally {
      Math.random = realRandom;
    }
    assert.equal(await prisma.order.count({ where: { customerId: c } }), before, "no partial order");
    assert.equal(await prisma.site.count({ where: { order: { poNumber: `${PREFIX}-PO11` } } }), 0);
    assert.equal(await prisma.recdUnit.count({ where: { serialNo: { startsWith: PREFIX }, order: { poNumber: `${PREFIX}-PO11` } } }), 0);
  });
});
