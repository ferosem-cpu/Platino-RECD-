// Order creation (Requirement 9): duplicate-PO policy on every creation path, race safety, reference checks, order-number retry
// and rollback. No real database: Prisma is replaced by a small in-memory store whose $transaction stages writes and only
// commits them on success (so rollback is observable) and whose $executeRaw advisory lock really serialises transactions
// that use the same key (so the concurrency tests are meaningful). The real-database counterpart is test/db/orderCreation.db.test.ts.
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
const p2002 = (modelName: string, ...target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName, target } });
const p2003 = () => new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0", meta: { modelName: "Order" } });

const users: Record<string, { id: string; role: string; perms: string[] }> = {
  admin: { id: "admin", role: ROLE_KEY.MANAGEMENT, perms: [P.VIEW_SITE_STATUS, P.MANAGE_ORDERS] },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.VIEW_SITE_STATUS, P.MANAGE_ORDERS] },
};

// --- in-memory store ---------------------------------------------------------------------------------------------------
interface Store { orders: any[]; units: any[]; locks: Map<string, Promise<void>>; lockingEnabled: boolean; duplicateCheckBarrier: Barrier | null; orderCreateFailures: Array<() => never>; unitFailure: (() => never) | null; orderCreateCalls: number; orderFindFirstCalls: number }
let store: Store;
function freshStore(): Store {
  return { orders: [], units: [], locks: new Map(), lockingEnabled: true, duplicateCheckBarrier: null, orderCreateFailures: [], unitFailure: null, orderCreateCalls: 0, orderFindFirstCalls: 0 };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Releases its `parties` callers together once ALL of them have arrived. Used by the control test so that both requests have finished
 * their duplicate check before either may create or commit: the interleaving no longer depends on wall-clock timing or CPU load. The
 * timeout is only a fail-safe so a broken test fails with a clear message instead of hanging; it never sequences the requests.
 */
interface Barrier { arrive(): Promise<void> }
function makeBarrier(parties: number, failSafeMs = 5000): Barrier {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return {
    arrive() {
      if (++arrived >= parties) release();
      return Promise.race([open, sleep(failSafeMs).then(() => { throw new Error(`barrier: only ${arrived} of ${parties} requests reached the duplicate check`); })]);
    },
  };
}

function seedOrder(customerId: string, poNumber: string, extra: Record<string, unknown> = {}) {
  const o = { id: `seed${store.orders.length}`, orderNumber: `ORD-2026-${String(store.orders.length).padStart(4, "0")}`, customerId, poNumber, poDuplicateFlag: false, ...extra };
  store.orders.push(o);
  return o;
}

/** Order/unit delegates over `store`, writing to `sink` (the transaction's staging area, or the committed store). */
function delegates(sink: { orders: any[]; units: any[] }) {
  return {
    customer: { findUnique: async ({ where }: any) => (["cA", "cB"].includes(where.id) ? { id: where.id, name: `Customer ${where.id}` } : null), findMany: async () => [] },
    product: { findUnique: async ({ where }: any) => (["p1", "p2"].includes(where.id) ? { id: where.id } : null), findMany: async () => [] },
    stageDefinition: { findUniqueOrThrow: async () => ({ id: "stage1" }) },
    order: {
      findFirst: async ({ where }: any) => {
        store.orderFindFirstCalls++;
        const want = String(where.poNumber.equals).toLowerCase();
        const found = [...store.orders, ...sink.orders].find((o) => o.customerId === where.customerId && String(o.poNumber ?? "").toLowerCase() === want) ?? null;
        // the answer is fixed BEFORE waiting, so with a barrier no request can see another's order (nothing commits until all have checked)
        if (store.duplicateCheckBarrier) await store.duplicateCheckBarrier.arrive();
        return found;
      },
      create: async ({ data }: any) => {
        store.orderCreateCalls++;
        await sleep(2); // widen the window in which an unlocked second request could slip past its own check
        const fail = store.orderCreateFailures.shift();
        if (fail) fail();
        const row = { id: `o${store.orders.length + sink.orders.length + 1}`, ...data, site: { id: `s${store.orders.length + sink.orders.length + 1}` } };
        delete row.site.create;
        sink.orders.push(row);
        return row;
      },
    },
    recdUnit: {
      findMany: async ({ where }: any) => store.units.filter((u) => where.serialNo.in.includes(u.serialNo)).map((u) => ({ serialNo: u.serialNo })),
      createMany: async ({ data }: any) => {
        if (store.unitFailure) store.unitFailure();
        sink.units.push(...data);
        return { count: data.length };
      },
    },
  };
}

let server: Server;
let base: string;
let tokenFor: (u: string) => string;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { ordersRouter } = await import("../src/routes/orders");
  const { sitesRouter } = await import("../src/routes/sites");

  const committed = { get orders() { return store.orders; }, get units() { return store.units; } };
  const top = delegates(committed);
  for (const model of ["customer", "product", "stageDefinition", "order", "recdUnit"] as const) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => (top as any)[model] });
  }
  Object.defineProperty(prisma, "user", {
    configurable: true,
    get: () => ({
      findUnique: async ({ where }: any) => {
        const u = Object.values(users).find((x) => x.id === where.id);
        return u ? { id: u.id, isActive: true, customerId: null, vendorId: null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } } : null;
      },
    }),
  });
  Object.defineProperty(prisma, "site", {
    configurable: true,
    get: () => ({ findUnique: async () => ({ id: "sA", address: "x", companyName: "Site A", vendorId: null, regionId: null, order: { customerId: "cA", poNumber: "PO-CLONE", poDate: null } }) }),
  });

  (prisma as any).$transaction = async (fn: any) => {
    const staged = { orders: [] as any[], units: [] as any[] };
    const held: Array<() => void> = [];
    const tx = {
      ...delegates(staged),
      // Same semantics as pg_advisory_xact_lock: blocks while another open transaction holds the same key.
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!store.lockingEnabled) return 0;
        const key = String(values[0]) + "|" + String(values[1]).toLowerCase();
        while (store.locks.has(key)) await store.locks.get(key);
        let release!: () => void;
        store.locks.set(key, new Promise<void>((r) => (release = r)));
        held.push(() => { store.locks.delete(key); release(); });
        return 0;
      },
    };
    try {
      const result = await fn(tx);
      store.orders.push(...staged.orders);
      store.units.push(...staged.units);
      return result;
    } finally {
      held.forEach((h) => h());
    }
  };

  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: undefined });
  const app = express();
  app.use(express.json());
  app.use("/orders", ordersRouter);
  app.use("/sites", sitesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });
beforeEach(() => { store = freshStore(); });

async function call(as: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
let serialCounter = 0;
const newBody = (extra: Record<string, unknown> = {}) => ({ customerId: "cA", productId: "p1", quantity: 1, poNumber: "PO-100", recdSerials: [`T-${++serialCounter}`], ...extra });

// --- 1-6: the existing policy, preserved ---------------------------------------------------------------------------------
test("a unique PO creates the order, trimmed and unflagged, with its site and units", async () => {
  const r = await call("sales", "POST", "/orders", newBody({ poNumber: "  PO-100  " }));
  assert.equal(r.status, 201);
  assert.equal(store.orders.length, 1);
  assert.equal(store.orders[0].poNumber, "PO-100", "stored trimmed");
  assert.equal(store.orders[0].poDuplicateFlag, false);
  assert.equal(store.orders[0].customerId, "cA");
  assert.equal(store.units.length, 1);
  assert.equal(store.units[0].orderId, r.body.id);
});

test("a duplicate PO for the same customer is a 409 DUPLICATE_PO and nothing is created", async () => {
  seedOrder("cA", "PO-100");
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "DUPLICATE_PO");
  assert.match(r.body.error, /already exists for this customer \(order ORD-2026-0000\)/);
  assert.equal(store.orders.length, 1);
  assert.equal(store.units.length, 0);
});

test("matching is case-insensitive and ignores surrounding whitespace, but not punctuation", async () => {
  seedOrder("cA", "PO-100");
  assert.equal((await call("sales", "POST", "/orders", newBody({ poNumber: "po-100" }))).status, 409);
  assert.equal((await call("sales", "POST", "/orders", newBody({ poNumber: "   Po-100 " }))).status, 409);
  // current policy (no approved business rule for fuzzier matching): different punctuation is a different PO
  assert.equal((await call("sales", "POST", "/orders", newBody({ poNumber: "PO 100" }))).status, 201);
  assert.equal((await call("sales", "POST", "/orders", newBody({ poNumber: "PO100" }))).status, 201);
});

test("only an administrator role can override a duplicate, and the override flags the order", async () => {
  seedOrder("cA", "PO-100");
  const refused = await call("sales", "POST", "/orders", newBody({ allowDuplicatePo: true }));
  assert.equal(refused.status, 409, "Sales cannot override");
  assert.match(refused.body.error, /Ask an admin to override/);
  assert.equal(store.orders.length, 1);

  const notTicked = await call("admin", "POST", "/orders", newBody());
  assert.equal(notTicked.status, 409);
  assert.match(notTicked.body.error, /Tick 'allow duplicate PO'/);

  const ok = await call("admin", "POST", "/orders", newBody({ allowDuplicatePo: true }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.poDuplicateFlag, true);
  assert.equal(store.orders.filter((o) => o.poDuplicateFlag).length, 1, "exactly the approved duplicate is flagged");
});

test("an allowDuplicatePo flag on a request that is NOT a duplicate does not flag the order", async () => {
  const r = await call("admin", "POST", "/orders", newBody({ allowDuplicatePo: true }));
  assert.equal(r.status, 201);
  assert.equal(r.body.poDuplicateFlag, false);
});

test("the same PO number for a different customer is not a duplicate", async () => {
  seedOrder("cB", "PO-100");
  const r = await call("sales", "POST", "/orders", newBody({ customerId: "cA" }));
  assert.equal(r.status, 201);
  assert.equal(r.body.poDuplicateFlag, false);
});

// --- 7: simultaneous requests -------------------------------------------------------------------------------------------
test("two simultaneous requests for the same customer + PO: exactly one is created, the other is DUPLICATE_PO", async () => {
  const [a, b] = await Promise.all([call("sales", "POST", "/orders", newBody()), call("sales", "POST", "/orders", newBody())]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal([a, b].find((r) => r.status === 409)!.body.code, "DUPLICATE_PO");
  assert.equal(store.orders.length, 1);
  assert.equal(store.units.length, 1, "the loser left no units behind");
});

test("case/whitespace variants racing each other are also serialised", async () => {
  const rs = await Promise.all(["PO-7", " po-7", "Po-7 ", "PO-7"].map((poNumber) => call("sales", "POST", "/orders", newBody({ poNumber }))));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 3);
  assert.equal(store.orders.length, 1);
});

test("simultaneous requests for DIFFERENT POs or customers do not block or reject each other", async () => {
  const rs = await Promise.all([
    call("sales", "POST", "/orders", newBody({ poNumber: "PO-1" })),
    call("sales", "POST", "/orders", newBody({ poNumber: "PO-2" })),
    call("sales", "POST", "/orders", newBody({ poNumber: "PO-1", customerId: "cB" })),
  ]);
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
});

test("simultaneous approved duplicates: the override keeps working and exactly one of them is unflagged", async () => {
  const rs = await Promise.all([1, 2, 3].map(() => call("admin", "POST", "/orders", newBody({ allowDuplicatePo: true }))));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
  assert.equal(store.orders.length, 3);
  assert.equal(store.orders.filter((o) => !o.poDuplicateFlag).length, 1, "the first is the original");
  assert.equal(store.orders.filter((o) => o.poDuplicateFlag).length, 2);
});

test("control: without the lock the same race DOES create two unflagged orders (the test is sensitive to the fix)", async () => {
  store.lockingEnabled = false;
  store.duplicateCheckBarrier = makeBarrier(2); // both requests pass their duplicate check before either creates (deterministic, not timing-based)
  const [a, b] = await Promise.all([call("sales", "POST", "/orders", newBody()), call("sales", "POST", "/orders", newBody())]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(store.orders.filter((o) => !o.poDuplicateFlag).length, 2);
});

// --- 8: AI order creation -----------------------------------------------------------------------------------------------
async function agentPropose(input: Record<string, unknown>, roleKey: string = ROLE_KEY.MANAGEMENT) {
  const { appWriteTools } = await import("../src/agent/tools/appWriteTools");
  const { prisma } = await import("../src/lib/prisma");
  const created: any[] = [];
  Object.defineProperty(prisma, "agentPendingAction", { configurable: true, get: () => ({ create: async ({ data }: any) => { created.push(data); return { id: "act1", ...data }; } }) });
  const tool = appWriteTools.find((t) => t.name === "create_order")!;
  const result = (await tool.handler(
    { customerId: "cA", productId: "p1", quantity: 1, recdSerials: [`AI-${++serialCounter}`], ...input },
    { userId: "admin", roleKey, permissions: new Set([P.MANAGE_ORDERS]), conversationId: "conv1" },
  )) as any;
  return { result, created };
}
async function agentConfirm(input: Record<string, unknown>, roleKey?: string) {
  const { executeConfirmedAction } = await import("../src/routes/agentConversations");
  return executeConfirmedAction("create_order", { customerId: "cA", productId: "p1", quantity: 1, poNumber: "PO-AI", recdSerials: [`AC-${++serialCounter}`], ...input }, "admin", roleKey);
}
const agentError = async (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ status: e.status, message: e.message, name: e.name }));

test("AI proposal: a PO number is required, and a PO already used by that customer is refused before a card is made", async () => {
  const none = await agentPropose({ poNumber: undefined });
  assert.match(none.result.error, /poNumber is required/);
  const long = await agentPropose({ poNumber: "x".repeat(61) });
  assert.match(long.result.error, /at most 60/);
  seedOrder("cA", "PO-AI");
  const dupe = await agentPropose({ poNumber: " po-ai " });
  assert.match(dupe.result.error, /already exists for Customer cA/);
  assert.equal(dupe.created.length, 0, "no confirm card for a duplicate");
  const ok = await agentPropose({ poNumber: "PO-AI-NEW" });
  assert.equal(ok.result.status, "pending_confirmation");
  assert.equal(ok.created[0].input.poNumber, "PO-AI-NEW");
  assert.equal(ok.result.preview.poNumber, "PO-AI-NEW");
});

test("AI confirmation: stores the PO, flags nothing, and refuses a card that has no PO", async () => {
  const id = await agentConfirm({ poNumber: "  PO-AI  " });
  assert.ok(id);
  assert.equal(store.orders[0].poNumber, "PO-AI");
  assert.equal(store.orders[0].poDuplicateFlag, false);
  const noPo = await agentError(agentConfirm({ poNumber: undefined }));
  assert.equal(noPo!.status, 400);
  assert.match(noPo!.message, /no valid customer PO number/);
  assert.equal(store.orders.length, 1, "the card without a PO created nothing");
});

test("AI confirmation: a duplicate PO is refused (409) - the assistant cannot override - even if it appeared after the card was made", async () => {
  seedOrder("cA", "PO-AI");
  const e = await agentError(agentConfirm({ poNumber: "po-ai" }));
  assert.equal(e!.status, 409);
  assert.match(e!.message, /already exists for this customer/);
  assert.match(e!.message, /cannot approve or create a duplicate PO itself/);
  assert.match(e!.message, /an administrator has to enter the order on the Orders page/);
  assert.doesNotMatch(e!.message, /Ask an admin/);
  const withFlag = await agentError(agentConfirm({ poNumber: "PO-AI", allowDuplicatePo: true } as any));
  assert.equal(withFlag!.status, 409, "an allowDuplicatePo field on a card is ignored");
  assert.equal(store.orders.length, 1);
});

test("AI confirmation: simultaneous confirmations of the same PO create one order; the other is refused", async () => {
  const rs = await Promise.all([agentError(agentConfirm({ poNumber: "PO-RACE" })), agentError(agentConfirm({ poNumber: "PO-RACE" }))]);
  assert.equal(rs.filter((r) => r === null).length, 1);
  assert.equal(rs.filter((r) => r?.status === 409).length, 1);
  assert.equal(store.orders.length, 1);
});

test("AI confirmation: unknown customer or product ids are 400s, not foreign-key failures", async () => {
  const c = await agentError(agentConfirm({ customerId: "nope" }));
  assert.deepEqual([c!.status, c!.message], [400, "Customer not found"]);
  const p = await agentError(agentConfirm({ productId: "nope" }));
  assert.deepEqual([p!.status, p!.message], [400, "Product not found"]);
  assert.equal(store.orders.length, 0);
});

// --- 9: clone-order -------------------------------------------------------------------------------------------------------
test("clone-order intentionally reuses the source PO: no duplicate check, no flag", async () => {
  seedOrder("cA", "PO-CLONE"); // the source order already carries this PO
  const r = await call("sales", "POST", "/sites/sA/clone-order", { productId: "p1", quantity: 1, recdSerials: ["CLONE-1"] });
  assert.equal(r.status, 201);
  assert.equal(r.body.poNumber, "PO-CLONE");
  assert.notEqual(r.body.poDuplicateFlag, true, "a sibling order is not flagged");
  assert.equal(store.orderFindFirstCalls, 0, "the duplicate-PO lookup is never run for clone-order");
  assert.equal(store.orders.filter((o) => o.poNumber === "PO-CLONE").length, 2);
  // ...while a normal order with that PO is still a duplicate afterwards
  assert.equal((await call("sales", "POST", "/orders", newBody({ poNumber: "PO-CLONE" }))).status, 409);
});

// --- 10: references ---------------------------------------------------------------------------------------------------------
test("unknown customer or product on POST /orders are clean 400s and write nothing", async () => {
  const c = await call("sales", "POST", "/orders", newBody({ customerId: "nope" }));
  assert.deepEqual([c.status, c.body.error], [400, "Customer not found"]);
  const p = await call("sales", "POST", "/orders", newBody({ productId: "nope" }));
  assert.deepEqual([p.status, p.body.error], [400, "Product not found"]);
  assert.equal(store.orderCreateCalls, 0);
  assert.equal(store.orders.length + store.units.length, 0);
});

test("clone-order with an unknown product is a clean 400", async () => {
  const r = await call("sales", "POST", "/sites/sA/clone-order", { productId: "nope", quantity: 1, recdSerials: ["CLONE-9"] });
  assert.deepEqual([r.status, r.body.error], [400, "Product not found"]);
  assert.equal(store.orderCreateCalls, 0);
});

test("a customer/product deleted between the check and the insert (foreign key) is a safe, retryable 409 without internal details", async () => {
  store.orderCreateFailures.push(() => { throw p2003(); });
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "REFERENCE_CHANGED");
  assert.doesNotMatch(JSON.stringify(r.body), /P2003|foreign|prisma|constraint/i);
  assert.equal(store.orders.length, 0);
});

// --- 11: order-number collisions ------------------------------------------------------------------------------------------
test("an order-number collision is retried with a new number and then succeeds, leaving exactly one order", async () => {
  store.orderCreateFailures.push(() => { throw p2002("Order", "orderNumber"); });
  store.orderCreateFailures.push(() => { throw p2002("Order", "orderNumber"); });
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 201);
  assert.equal(store.orderCreateCalls, 3, "two collisions, then success");
  assert.equal(store.orders.length, 1);
  assert.equal(store.units.length, 1);
  assert.match(r.body.orderNumber, /^ORD-\d{4}-\d{4}$/);
});

test("if every attempt collides the answer is a clear 409 after a bounded number of attempts, and nothing is saved", async () => {
  const { ORDER_NUMBER_MAX_ATTEMPTS } = await import("../src/lib/orderCreation");
  for (let i = 0; i < 50; i++) store.orderCreateFailures.push(() => { throw p2002("Order", "orderNumber"); });
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ORDER_NUMBER_EXHAUSTED");
  assert.match(r.body.error, /Nothing was saved - please submit again/);
  assert.equal(store.orderCreateCalls, ORDER_NUMBER_MAX_ATTEMPTS);
  assert.equal(store.orders.length + store.units.length, 0);
});

test("a collision on clone-order is retried the same way", async () => {
  store.orderCreateFailures.push(() => { throw p2002("Order", "orderNumber"); });
  const r = await call("sales", "POST", "/sites/sA/clone-order", { productId: "p1", quantity: 1, recdSerials: ["CLONE-2"] });
  assert.equal(r.status, 201);
  assert.equal(store.orderCreateCalls, 2);
});

test("only an order-number collision is retried: other failures are not", async () => {
  store.orderCreateFailures.push(() => { throw p2002("User", "email"); });
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 500);
  assert.equal(store.orderCreateCalls, 1);
});

// --- 12: atomic rollback ----------------------------------------------------------------------------------------------------
test("a serial that is registered by a racing request rolls the whole order back: no order, site or unit remains", async () => {
  store.unitFailure = () => { throw p2002("RecdUnit", "serialNo"); };
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 409);
  assert.match(r.body.error, /just registered by someone else/);
  assert.equal(store.orders.length, 0, "order staged inside the transaction was discarded");
  assert.equal(store.units.length, 0);
});

test("an unexpected failure while saving the units also leaves nothing behind", async () => {
  store.unitFailure = () => { throw new Error("disk full"); };
  const r = await call("sales", "POST", "/orders", newBody());
  assert.equal(r.status, 500);
  assert.equal(store.orders.length + store.units.length, 0);
});

test("a taken serial is refused before anything is written", async () => {
  store.units.push({ serialNo: "TAKEN-1" });
  const r = await call("sales", "POST", "/orders", newBody({ recdSerials: ["TAKEN-1"] }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already registered: TAKEN-1/);
  assert.equal(store.orderCreateCalls, 0);
});

test("AI confirmation: an authorized role is not told to ask an administrator, and the assistant still cannot override", async () => {
  seedOrder("cA", "PO-AI");
  for (const role of [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT]) {
    const e = await agentError(agentConfirm({ poNumber: "PO-AI", allowDuplicatePo: true } as any, role));
    assert.equal(e!.status, 409, `${role}: still refused - the backend policy is unchanged`);
    assert.match(e!.message, /cannot approve or create a duplicate PO itself/);
    assert.match(e!.message, /Orders page, ticking 'Allow a duplicate PO'/);
    assert.doesNotMatch(e!.message, /ask an admin|administrator has to/i);
  }
  const sales = await agentError(agentConfirm({ poNumber: "PO-AI" }, ROLE_KEY.SALES));
  assert.match(sales!.message, /an administrator has to enter the order on the Orders page/);
  assert.equal(store.orders.length, 1, "no duplicate was created for any role");
});

test("AI proposal: the duplicate message follows the user's role, and no card is made for anyone", async () => {
  seedOrder("cA", "PO-AI");
  const asAdmin = await agentPropose({ poNumber: "PO-AI" }, ROLE_KEY.OWNER_ADMIN);
  assert.match(asAdmin.result.error, /cannot approve or create a duplicate PO itself/);
  assert.match(asAdmin.result.error, /Orders page, ticking 'Allow a duplicate PO'/);
  assert.doesNotMatch(asAdmin.result.error, /administrator has to/);
  assert.equal(asAdmin.created.length, 0);
  const asSales = await agentPropose({ poNumber: "PO-AI" }, ROLE_KEY.SALES);
  assert.match(asSales.result.error, /an administrator has to enter the order on the Orders page/);
  assert.equal(asSales.created.length, 0);
});

test("POST /orders: every non-administrator role is refused an override (the checkbox is only a convenience)", async () => {
  seedOrder("cA", "PO-100");
  const { canOverrideDuplicatePo } = await import("@recd/shared");
  assert.deepEqual(
    Object.values(ROLE_KEY).filter(canOverrideDuplicatePo).sort(),
    [ROLE_KEY.MANAGEMENT, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.SUPER_ADMIN].sort(),
  );
  const r = await call("sales", "POST", "/orders", newBody({ allowDuplicatePo: true }));
  assert.equal(r.status, 409);
  assert.equal(store.orders.length, 1);
});
