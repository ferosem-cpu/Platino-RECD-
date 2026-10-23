// Security regression tests: API responses must not leak credentials or staff / vendor contact details through nested Prisma relations,
// and a record id taken from the URL must not open another customer's, vendor's or region's record.
//
// How this proves it: the Prisma delegates are replaced by an in-memory graph whose staff and vendor rows carry SECRET values (a password hash,
// token version, private phone / e-mail). test/helpers/prismaShape.ts applies each route's actual `select` / `include` to that graph exactly
// like the real client would, so a route that asks for `assignedEngineer: true` really receives the whole secret-bearing row and the assertion
// on the HTTP response fails. The real routers, authentication middleware and permission checks run over HTTP. No database is touched.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { allKeys, shape } from "./helpers/prismaShape";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = PERMISSION_KEY;

// ---- values that must never reach a customer or vendor (and, for credentials, nobody) ----------------------------------------------------
const SECRET_HASH = "$2a$10$SECRETHASHVALUEnotforanyone";
const ENGINEER_EMAIL = "engineer-private@example.test";
const ENGINEER_PHONE = "9111111111";
const VENDOR_EMAIL = "vendor-private@example.test";
const VENDOR_PHONE = "9222222222";
const SALES_OWNER_ID = "owner-internal-user-id";
const ORDER_VALUE = 850000;

const engineer = { id: "eng", name: "Vikram Singh", email: ENGINEER_EMAIL, phone: ENGINEER_PHONE, passwordHash: SECRET_HASH, tokenVersion: 9, isActive: true, mustChangePassword: false, notificationChannels: ["email"], roleId: "r-eng", title: "Engineer" };
const salesPerson = { id: "sales1", name: "Rahul Verma", email: "sales-private@example.test", phone: "9333333333", passwordHash: SECRET_HASH, tokenVersion: 3, roleId: "r-sales" };
const mkVendor = (id: string, name: string) => ({ id, name, status: "approved", contactName: "Contact Person", contactEmail: VENDOR_EMAIL, contactPhone: VENDOR_PHONE, address: "Somewhere", approvedById: "x", archivedById: null, createdAt: new Date("2026-01-01") });
const product = { id: "p1", name: "Platino RECD", model: "RECD-250", ratingSpec: "250 kVA", warrantyMonths: 24 };
const stage = { id: "st1", key: "order_received", label: "Order received", sequenceOrder: 1 };
const mkCustomer = (id: string, name: string) => ({ id, name, address: "Customer address", salesOwnerId: SALES_OWNER_ID, createdAt: new Date("2026-01-01") });

function mkWorld() {
  const customers: Record<string, any> = { cA: mkCustomer("cA", "Customer A"), cB: mkCustomer("cB", "Customer B") };
  const vendors: Record<string, any> = { vA: mkVendor("vA", "Vendor A"), vB: mkVendor("vB", "Vendor B") };
  const build = (key: "A" | "B", regionId: string) => {
    const order: any = {
      id: `o${key}`, orderNumber: `ORD-${key}`, customerId: `c${key}`, productId: "p1", quantity: 1, value: ORDER_VALUE, orderDate: new Date("2026-02-01"), promisedDeliveryDate: null,
      actualDispatchDate: null, plannedExhaustHookupType: null, salesEngineerId: "sales1", createdAt: new Date("2026-02-01"), poNumber: `PO-${key}`, poDate: null, poDuplicateFlag: false,
      customer: { ...customers[`c${key}`], contacts: [{ id: `k${key}`, name: "Desk", phone: "9000000000", email: "desk@example.test" }] },
      product, salesEngineer: salesPerson, lineItems: [], units: [{ id: `u${key}`, serialNo: `SER-${key}`, orderId: `o${key}`, productId: "p1", product }],
    };
    const site: any = {
      id: `s${key}`, orderId: `o${key}`, address: `Plot ${key}`, vendorId: `v${key}`, regionId, assignedEngineerId: "eng", companyName: `Site ${key}`, currentStageId: "st1", sitePocName: "POC", sitePocNumber: "9444444444",
      order, assignedEngineer: engineer, vendor: vendors[`v${key}`], currentStage: stage,
      stageEvents: [{ id: `e${key}`, siteId: `s${key}`, comment: "Started", createdById: "eng", createdBy: engineer, stageDefinition: stage, statusOption: { id: "so1", label: "In progress" } }],
      photos: [{ id: `ph${key}`, siteId: `s${key}`, photoUrl: "data:image/png;base64,AA==", uploadedById: "eng", uploadedBy: engineer, checkpoint: { id: "cp1", label: "Before" }, uploadedAt: new Date("2026-02-02") }],
      pendingActions: [], contacts: [{ id: `sc${key}`, siteId: `s${key}`, name: "Security desk", phone: "9555555555", email: null, role: "Security" }],
      documentRequirements: [], recdDelivery: null, region: { id: regionId, name: `Region ${regionId}` }, units: order.units,
    };
    order.site = site;
    return { order, site };
  };
  const A = build("A", "r1");
  const B = build("B", "r2");
  const actions: Record<string, any> = {
    paA: { id: "paA", siteId: "sA", category: "material_shortage", description: "A thing", status: "open", site: A.site },
    paB: { id: "paB", siteId: "sB", category: "material_shortage", description: "B thing", status: "open", site: B.site },
  };
  return { customers, vendors, sites: { sA: A.site, sB: B.site }, orders: { oA: A.order, oB: B.order }, actions, regionMap: { rm1: ["r1"], rm2: ["r2"], rmNone: [] as string[] } };
}

type U = { id: string; role: string; perms: string[]; customerId?: string; vendorId?: string };
const users: Record<string, U> = {
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [P.VIEW_SITE_STATUS, P.RAISE_COMPLAINT, P.RESOLVE_PENDING_ACTION], customerId: "cA" },
  custB: { id: "custB", role: ROLE_KEY.CUSTOMER, perms: [P.VIEW_SITE_STATUS, P.RAISE_COMPLAINT, P.RESOLVE_PENDING_ACTION], customerId: "cB" },
  vendorA: { id: "vendorA", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.VIEW_SITE_STATUS, P.CHANGE_SITE_STATUS, P.RESOLVE_PENDING_ACTION], vendorId: "vA" },
  mgmt: { id: "mgmt", role: ROLE_KEY.MANAGEMENT, perms: [P.VIEW_SITE_STATUS, P.MANAGE_ORDERS, P.RESOLVE_PENDING_ACTION, P.MANAGE_COMPLAINTS] },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS, P.VIEW_SITE_STATUS] },
  rm1: { id: "rm1", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.VIEW_SITE_STATUS, P.MANAGE_COMPLAINTS] },
  rmNone: { id: "rmNone", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.VIEW_SITE_STATUS, P.MANAGE_COMPLAINTS] },
};

let W = mkWorld();
const writes: string[] = [];
let server: Server;
let base = "";
let tokenFor: (u: string) => string;

// a minimal `where` interpreter for the filters these routes use
function siteMatches(site: any, where: any = {}): boolean {
  if (where.assignedEngineerId && site.assignedEngineerId !== where.assignedEngineerId) return false;
  if (where.vendorId && site.vendorId !== where.vendorId) return false;
  if (where.order?.customerId && site.order.customerId !== where.order.customerId) return false;
  if (where.regionId?.in && !where.regionId.in.includes(site.regionId)) return false;
  if (where.NOT?.id && site.id === where.NOT.id) return false;
  return true;
}

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { sitesRouter } = await import("../src/routes/sites");
  const { ordersRouter } = await import("../src/routes/orders");
  const { customersRouter } = await import("../src/routes/customers");
  const { pendingActionsRouter } = await import("../src/routes/pendingActions");
  const { complaintsRouter } = await import("../src/routes/complaints");
  const { scrubSecretKeysFromJson } = await import("../src/lib/httpSecurity");
  const define = (model: string, impl: Record<string, (...a: any[]) => any>) => Object.defineProperty(prisma, model, { configurable: true, get: () => impl });

  define("user", {
    findUnique: ({ where }: any) => {
      const u = Object.values(users).find((x) => x.id === where.id);
      if (!u) return null;
      return { id: u.id, isActive: true, tokenVersion: 0, mustChangePassword: false, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } };
    },
    findMany: () => [],
  });
  define("regionManager", { findMany: ({ where }: any) => ((W.regionMap as any)[where.userId] ?? []).map((regionId: string) => ({ regionId })) });
  define("site", {
    findMany: ({ where, include, select }: any) => shape(Object.values(W.sites).filter((s) => siteMatches(s, where)), { include, select }),
    findUnique: ({ where, include, select }: any) => shape((W.sites as any)[where.id] ?? null, { include, select }),
  });
  define("order", {
    findMany: ({ where, include }: any) => shape(Object.values(W.orders).filter((o: any) => !where?.customerId || o.customerId === where.customerId), { include }),
    findUnique: ({ where, include }: any) => shape((W.orders as any)[where.id] ?? null, { include }),
  });
  define("customer", {
    findMany: ({ include }: any) => shape(Object.values(W.customers), { include }),
    findUnique: ({ where, include }: any) => {
      const c = W.customers[where.id];
      if (!c) return null;
      const withOrders = { ...c, contacts: [{ id: "k", name: "Desk", phone: "9000000000", email: "desk@example.test" }], orders: Object.values(W.orders).filter((o: any) => o.customerId === c.id) };
      return shape(withOrders, { include });
    },
  });
  define("pendingAction", {
    findMany: ({ where, include }: any) => {
      const rows = Object.values(W.actions).filter((a: any) => a.status === where.status && siteMatches(a.site, where.site ? { ...(where.site.vendorId ? { vendorId: where.site.vendorId } : {}), ...(where.site.order ? { order: where.site.order } : {}) } : {}));
      return shape(rows, { include });
    },
    findUnique: ({ where, include }: any) => shape(W.actions[where.id] ?? null, { include }),
    update: ({ where, data }: any) => { writes.push(`pendingAction.update:${where.id}`); return { id: where.id, ...data }; },
  });
  define("complaint", {
    findMany: ({ include }: any) =>
      shape([{ id: "t1", customerId: "cA", siteId: "sA", ticketNumber: "TCK-1", status: "open", reporterPhone: "9666666666", remarks: "internal staff remark", rootCause: "secret internal root cause", serviceReportUrl: "data:staff-only-report", slaEscalationLevel: 1, resolutionNotes: "internal resolution detail", assignedToId: "eng", site: W.sites.sA, assignedTo: { id: "eng", name: "Vikram Singh" }, unit: { id: "uA", serialNo: "SER-A" } }], { include }),
    count: () => 1,
  });
  define("siteContact", { findUnique: () => null });

  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: users[u].customerId ?? null });
  const app = express();
  app.use(express.json());
  app.use(scrubSecretKeysFromJson()); // production wiring (src/index.ts): a last line of defence behind the explicit selects
  app.use("/sites", sitesRouter);
  app.use("/orders", ordersRouter);
  app.use("/customers", customersRouter);
  app.use("/pending-actions", pendingActionsRouter);
  app.use("/complaints", complaintsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

async function get(as: string, path: string, method = "GET", body?: unknown) {
  writes.length = 0;
  W = W; // eslint-disable-line no-self-assign
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tokenFor(as)}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

/** What may NEVER appear anywhere in a response read by a customer or a vendor. */
const FORBIDDEN_FOR_EXTERNAL = [SECRET_HASH, "passwordHash", "tokenVersion", ENGINEER_EMAIL, ENGINEER_PHONE, VENDOR_EMAIL, VENDOR_PHONE, SALES_OWNER_ID, "sales-private@example.test", "salesOwnerId", "contactEmail", "contactPhone", "notificationChannels"];
function assertNoLeak(text: string, forbidden: string[], label: string) {
  for (const f of forbidden) assert.equal(text.includes(f), false, `${label}: response contains "${f}"`);
}

// =====================================================================================================================================
// 1. Customers
// =====================================================================================================================================

test("customer: GET /sites and GET /sites/:id carry no password hash, token version or staff / vendor contact detail - and still show what the portal needs", async () => {
  W = mkWorld();
  const list = await get("custA", "/sites");
  assert.equal(list.status, 200);
  assertNoLeak(list.text, [...FORBIDDEN_FOR_EXTERNAL, "850000", "salesEngineerId"], "customer GET /sites");
  assert.equal(list.json.length, 1, "only the customer's own site");
  const s = list.json[0];
  assert.equal(s.id, "sA");
  assert.equal(s.assignedEngineer.name, "Vikram Singh", "engineer name is still shown");
  assert.deepEqual(Object.keys(s.assignedEngineer).sort(), ["id", "name"]);
  assert.equal(s.vendor.name, "Vendor A");
  assert.deepEqual(Object.keys(s.vendor).sort(), ["id", "name"]);
  assert.equal(s.order.orderNumber, "ORD-A");
  assert.equal(s.order.poNumber, "PO-A");
  assert.equal(s.order.customer.name, "Customer A");
  assert.equal(s.order.product.model, "RECD-250");
  assert.equal(s.currentStage.label, "Order received");
  assert.equal(s.address, "Plot A");
  // The list now carries each site's RECD serial for the mobile list screens: only id / serial / status, only this customer's units.
  assert.deepEqual(s.units.map((u: any) => u.serialNo), ["SER-A"]);
  for (const u of s.units) assert.deepEqual(Object.keys(u).sort(), ["id", "serialNo", "status"].filter((k) => k in u).sort());
  assert.ok(!list.text.includes("SER-B"), "another customer's serial is never in the list");

  const detail = await get("custA", "/sites/sA");
  assert.equal(detail.status, 200);
  assertNoLeak(detail.text, [...FORBIDDEN_FOR_EXTERNAL, "850000", "salesEngineerId"], "customer GET /sites/:id");
  assert.equal(detail.json.stageEvents[0].createdBy.name, "Vikram Singh", "event author still shown by name");
  assert.deepEqual(Object.keys(detail.json.stageEvents[0].createdBy).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(detail.json.photos[0].uploadedBy).sort(), ["id", "name"]);
  assert.equal(detail.json.contacts[0].name, "Security desk", "the site's own contact list is still there");
  assert.equal(detail.json.units[0].serialNo, "SER-A");
  assert.equal(detail.json.region.name, "Region r1");
  // no key anywhere in the payload is a credential field
  const keys = allKeys(detail.json);
  for (const k of ["passwordHash", "tokenVersion", "notificationChannels", "contactEmail", "contactPhone", "salesOwnerId", "value"]) assert.equal(keys.has(k), false, `key ${k}`);
});

test("customer: tickets embed the order without its commercial value or sales-engineer id, and carry NONE of the internal fields (assignee, remarks, root cause, SLA level) - the customer's own tickets still carry what they need", async () => {
  W = mkWorld();
  const r = await get("custA", "/complaints");
  assert.equal(r.status, 200);
  assertNoLeak(r.text, [...FORBIDDEN_FOR_EXTERNAL, "850000", "salesEngineerId", "9666666666", "internal staff remark", "secret internal root cause", "staff-only-report", "internal resolution detail", "Vikram Singh"], "customer GET /complaints");
  assert.equal(r.json[0].ticketNumber, "TCK-1");
  assert.equal(r.json[0].site.order.orderNumber, "ORD-A");
  assert.equal(r.json[0].site.order.customer.name, "Customer A");
  // R11.A: a customer never sees who it is assigned to, internal remarks / root cause, the staff report, or SLA / escalation progress.
  assert.equal(r.json[0].assignedTo, undefined, "assignee details are internal");
  assert.equal(r.json[0].assignedToId, undefined, "assignee id is internal");
  assert.equal(r.json[0].remarks, undefined);
  assert.equal(r.json[0].rootCause, undefined);
  assert.equal(r.json[0].serviceReportUrl, undefined);
  assert.equal(r.json[0].slaEscalationLevel, undefined);
  assert.equal(r.json[0].resolutionNotes, undefined);
});

test("customer: pending actions are limited to their own sites and embed no commercial value", async () => {
  W = mkWorld();
  const r = await get("custA", "/pending-actions");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((a: any) => a.id), ["paA"], "the other customer's action is not listed");
  assertNoLeak(r.text, [...FORBIDDEN_FOR_EXTERNAL, "850000", "salesEngineerId"], "customer GET /pending-actions");
  assert.equal(r.json[0].site.order.customer.name, "Customer A");
});

// =====================================================================================================================================
// 2. Vendors
// =====================================================================================================================================

test("vendor: GET /sites and /sites/:id expose neither staff credentials nor customer / commercial internals; the vendor still sees its own site", async () => {
  W = mkWorld();
  const list = await get("vendorA", "/sites");
  assert.equal(list.status, 200);
  assertNoLeak(list.text, [...FORBIDDEN_FOR_EXTERNAL, "850000", "salesEngineerId"], "vendor GET /sites");
  assert.deepEqual(list.json.map((s: any) => s.id), ["sA"], "only the vendor's own site");
  assert.equal(list.json[0].order.customer.name, "Customer A", "the vendor still needs the customer name to do the work");
  assert.deepEqual(Object.keys(list.json[0].order.customer).sort(), ["address", "createdAt", "id", "name"]);
  assert.equal(list.json[0].assignedEngineer.name, "Vikram Singh");
  assert.equal(list.json[0].vendor.name, "Vendor A");

  const detail = await get("vendorA", "/sites/sA");
  assert.equal(detail.status, 200);
  assertNoLeak(detail.text, [...FORBIDDEN_FOR_EXTERNAL, "850000", "salesEngineerId"], "vendor GET /sites/:id");
});

// =====================================================================================================================================
// 3. Orders and customers (staff screens) - the nested relations
// =====================================================================================================================================

test("orders: nested site / engineer / vendor on GET /orders/:id carry no credentials or private contact details; order screens keep the commercial fields they need", async () => {
  W = mkWorld();
  const r = await get("sales", "/orders/oA");
  assert.equal(r.status, 200);
  assertNoLeak(r.text, [SECRET_HASH, "passwordHash", "tokenVersion", ENGINEER_EMAIL, ENGINEER_PHONE, VENDOR_EMAIL, VENDOR_PHONE, "notificationChannels", "contactEmail", "contactPhone"], "sales GET /orders/:id");
  assert.equal(r.json.value, ORDER_VALUE, "the order page still shows the order value to staff who manage orders");
  assert.equal(r.json.poNumber, "PO-A");
  assert.equal(r.json.site.assignedEngineer.name, "Vikram Singh");
  assert.equal(r.json.site.vendor.name, "Vendor A");
  assert.deepEqual(Object.keys(r.json.salesEngineer).sort(), ["id", "name"]);
  assert.equal(r.json.customer.contacts[0].phone, "9000000000", "the customer's own contacts are still listed for order managers");
  assert.equal(r.json.units[0].serialNo, "SER-A");
  assert.equal(r.json.otherCustomerSites.length, 0);
});

test("orders and customers: list / detail endpoints never serialise a credential key, whatever the nesting", async () => {
  W = mkWorld();
  for (const path of ["/orders", "/orders/oA", "/customers", "/customers/cA"]) {
    const r = await get("mgmt", path);
    assert.equal(r.status, 200, path);
    const keys = allKeys(r.json);
    for (const k of ["passwordHash", "tokenVersion", "notificationChannels", "contactEmail", "contactPhone"]) assert.equal(keys.has(k), false, `${path}: key ${k}`);
    assertNoLeak(r.text, [SECRET_HASH, ENGINEER_EMAIL, ENGINEER_PHONE, VENDOR_EMAIL, VENDOR_PHONE], path);
  }
  const customer = await get("mgmt", "/customers/cA");
  assert.equal(customer.json.orders[0].site.assignedEngineer.name, "Vikram Singh");
  assert.equal(customer.json.orders[0].site.vendor.name, "Vendor A");
});

test("defence in depth: even a route that selects a whole user row cannot serialise the password hash or token version", async () => {
  const { scrubSecretKeysFromJson } = await import("../src/lib/httpSecurity");
  const app = express();
  app.use(scrubSecretKeysFromJson());
  app.get("/leaky", (_q, res) => res.json({ ok: true, owner: { name: "x", passwordHash: SECRET_HASH, tokenVersion: 4, nested: [{ codeHash: "abc", keep: 1 }], when: new Date("2026-01-01") } }));
  const s: Server = await new Promise((resolve) => { const srv = app.listen(0, "127.0.0.1", () => resolve(srv)); });
  try {
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/leaky`);
    const j: any = await r.json();
    assert.deepEqual(j, { ok: true, owner: { name: "x", nested: [{ keep: 1 }], when: "2026-01-01T00:00:00.000Z" } });
  } finally { s.close(); }
});

// =====================================================================================================================================
// 4. Record-level access: changing an id in the URL must not open someone else's record
// =====================================================================================================================================

test("ID tampering: a customer cannot open another customer's site or order by id; a vendor cannot open another vendor's site", async () => {
  W = mkWorld();
  assert.equal((await get("custA", "/sites/sB")).status, 403);
  assert.equal((await get("custB", "/sites/sA")).status, 403);
  assert.equal((await get("vendorA", "/sites/sB")).status, 403);
  assert.equal((await get("custA", "/sites/does-not-exist")).status, 404);
  // the customer role holds no order-management permission at all
  assert.equal((await get("custA", "/orders/oB")).status, 403);
  assert.equal((await get("custA", "/customers/cB")).status, 403);
  // and the same customer still reads their own
  assert.equal((await get("custA", "/sites/sA")).status, 200);
  // a rejected request leaks nothing about the other record
  const denied = await get("custA", "/sites/sB");
  assertNoLeak(denied.text, ["Customer B", "ORD-B", "Plot B", "SER-B"], "403 body");
});

test("ID tampering: pending actions - a customer or vendor can only resolve actions on their own sites; a foreign id is a 404 and writes nothing", async () => {
  W = mkWorld();
  const foreign = await get("custA", "/pending-actions/paB/resolve", "POST", { resolution: "keep_existing" });
  assert.equal(foreign.status, 404);
  assert.deepEqual(writes, [], "nothing was written");
  const foreignVendor = await get("vendorA", "/pending-actions/paB/resolve", "POST", { resolution: "keep_existing" });
  assert.equal(foreignVendor.status, 404);
  assert.deepEqual(writes, []);
  const own = await get("custA", "/pending-actions/paA/resolve", "POST", { resolution: "keep_existing" });
  assert.equal(own.status, 200);
  assert.deepEqual(writes, ["pendingAction.update:paA"]);
  // unscoped staff keep working across sites
  const staff = await get("mgmt", "/pending-actions/paB/resolve", "POST", { resolution: "keep_existing" });
  assert.equal(staff.status, 200);
  assert.deepEqual(writes, ["pendingAction.update:paB"]);
});

test("pending actions list: a vendor sees only its own sites' actions; management sees all", async () => {
  W = mkWorld();
  assert.deepEqual((await get("vendorA", "/pending-actions")).json.map((a: any) => a.id), ["paA"]);
  assert.deepEqual((await get("mgmt", "/pending-actions")).json.map((a: any) => a.id).sort(), ["paA", "paB"]);
});

test("region scoping: a Regional Manager sees only the sites of the regions mapped to them (list and by id); one with no mapping sees none; Management is unrestricted", async () => {
  W = mkWorld();
  assert.deepEqual((await get("rm1", "/sites")).json.map((s: any) => s.id), ["sA"]);
  assert.equal((await get("rm1", "/sites/sA")).status, 200);
  assert.equal((await get("rm1", "/sites/sB")).status, 403, "a site in another region, requested by id");
  assert.deepEqual((await get("rmNone", "/sites")).json, [], "no mapped region = no sites");
  assert.equal((await get("rmNone", "/sites/sA")).status, 403);
  assert.deepEqual((await get("mgmt", "/sites")).json.map((s: any) => s.id).sort(), ["sA", "sB"], "management workflows are not restricted");
  assert.equal((await get("mgmt", "/sites/sB")).status, 200);
  // the region-scoped payload is also free of credentials
  assertNoLeak((await get("rm1", "/sites/sA")).text, [SECRET_HASH, "passwordHash", "tokenVersion", ENGINEER_EMAIL, VENDOR_EMAIL], "regional manager GET /sites/:id");
});

test("an unauthenticated or token-less request reaches no record", async () => {
  for (const path of ["/sites", "/sites/sA", "/orders", "/customers", "/pending-actions"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, path);
  }
});
