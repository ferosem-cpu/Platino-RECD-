// Route-level tests for the RECD serial / AMC / service-history requirements.
// No database: the Prisma client's model delegates are replaced with in-memory stubs, and the
// real routers (auth, permission and scoping middleware included) are mounted on a throwaway
// Express app and exercised over HTTP.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { ROLE_KEY, PERMISSION_KEY, RECD_UNIT_STATUS } from "@recd/shared";
import { shape } from "./helpers/prismaShape";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Stub = Record<string, (...args: any[]) => any>;

/** A unique-constraint error shaped exactly like the ones Prisma 5.22 raises from this project's Postgres. */
const p2002 = (modelName: string, ...target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName, target } });
const db: Record<string, Stub> = {};
const calls: Record<string, any[][]> = {};

function stubModel(model: string, impl: Stub) {
  db[model] = Object.fromEntries(
    Object.entries(impl).map(([name, fn]) => [
      name,
      (...args: any[]) => {
        (calls[`${model}.${name}`] ??= []).push(args);
        return fn(...args);
      },
    ]),
  );
}
const called = (key: string) => calls[key] ?? [];

// --- users the stub "database" knows about -------------------------------------------------
interface TestUser { id: string; role: string; perms: string[]; customerId?: string; vendorId?: string }
const P = PERMISSION_KEY;
const users: Record<string, TestUser> = {
  admin: { id: "admin", role: ROLE_KEY.MANAGEMENT, perms: [P.VIEW_SITE_STATUS, P.MANAGE_ORDERS, P.MANAGE_AMC_ORDERS, P.MANAGE_COMPLAINTS] },
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [P.VIEW_SITE_STATUS, P.RAISE_COMPLAINT], customerId: "cA" },
  service: { id: "service", role: ROLE_KEY.SERVICE_MANAGER, perms: [P.VIEW_SITE_STATUS, P.MANAGE_COMPLAINTS] },
  engineer: { id: "engineer", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.VIEW_SITE_STATUS, P.ACT_ASSIGNED_COMPLAINTS] },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.VIEW_SITE_STATUS, P.MANAGE_ORDERS] },
  custB: { id: "custB", role: ROLE_KEY.CUSTOMER, perms: [P.VIEW_SITE_STATUS, P.RAISE_COMPLAINT], customerId: "cB" },
  vendor1: { id: "vendor1", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.VIEW_SITE_STATUS], vendorId: "v1" },
  rmNorth: { id: "rmNorth", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.VIEW_SITE_STATUS] },
};

// --- fixtures ---------------------------------------------------------------------------------
const unitA1 = {
  id: "uA1", serialNo: "SN-A1", status: "active", orderId: "oA", siteId: "sA", productId: "p1",
  product: { id: "p1", name: "RECD", model: "R-500", warrantyMonths: 12 },
  order: { id: "oA", orderNumber: "ORD-1", poNumber: "PO-1", customer: { id: "cA", name: "Customer A" } },
  site: {
    id: "sA", companyName: "Site A", address: "Addr", regionId: "north", vendorId: "v1",
    dgModel: "Cummins C500", dgCapacityKva: "500", region: { id: "north", name: "North" },
  },
};
const unitA2 = { ...unitA1, id: "uA2", serialNo: "SN-A2" };
const unitB1 = {
  ...unitA1, id: "uB1", serialNo: "SN-B1", siteId: "sB", orderId: "oB",
  order: { ...unitA1.order, id: "oB", customer: { id: "cB", name: "Customer B" } },
  site: { ...unitA1.site, id: "sB", vendorId: "v2", regionId: "south", region: { id: "south", name: "South" } },
};
const unitsById: Record<string, any> = { uA1: unitA1, uA2: unitA2, uB1: unitB1 };

let server: Server;
let base: string;
let tokenFor: (u: string) => string;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { recdUnitsRouter } = await import("../src/routes/recdUnits");
  const { amcOrdersRouter } = await import("../src/routes/amcOrders");
  const { complaintsRouter } = await import("../src/routes/complaints");
  const { ordersRouter } = await import("../src/routes/orders");
  const { sitesRouter } = await import("../src/routes/sites");
  const { agentConversationsRouter } = await import("../src/routes/agentConversations");

  // Swap every model delegate the routes touch for a stub that reads from `db`.
  for (const model of ["user", "recdUnit", "complaint", "complaintEvent", "amcOrder", "amcOrderUnit", "site", "order", "regionManager", "stageDefinition", "orderLineItem", "customer", "product", "agentPendingAction", "agentConversation", "serviceReport", "companySettings", "recdUnitSerialHistory", "serviceReminder", "amcVisit", "warrantyHistory"]) {
    Object.defineProperty(prisma, model, {
      configurable: true,
      get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }),
    });
  }
  (prisma as any).$executeRaw = async () => 0; // the per-customer+PO advisory lock taken when an order is created
  (prisma as any).$transaction = async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg));

  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: users[u].customerId });

  const app = express();
  app.use(express.json());
  app.use("/recd-units", recdUnitsRouter);
  app.use("/amc-orders", amcOrdersRouter);
  app.use("/complaints", complaintsRouter);
  app.use("/orders", ordersRouter);
  app.use("/sites", sitesRouter);
  app.use("/agent", agentConversationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server?.close(); });

function reset() {
  for (const k of Object.keys(calls)) delete calls[k];
  stubModel("user", {
    findUnique: ({ where }: any) => {
      const u = Object.values(users).find((x) => x.id === where.id);
      if (!u) return null;
      return {
        id: u.id, isActive: true, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null,
        role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) },
      };
    },
  });
  stubModel("customer", { findUnique: ({ where }: any) => (["cA", "cB"].includes(where.id) ? { id: where.id } : null) });
  stubModel("product", { findUnique: ({ where }: any) => (["p1", "p2"].includes(where.id) ? { id: where.id } : null) });
  stubModel("regionManager", { findMany: ({ where }: any) => (where.userId === "rmNorth" ? [{ regionId: "north" }] : []) });
  stubModel("recdUnit", {
    findUnique: ({ where }: any) => (where.id ? unitsById[where.id] ?? null : Object.values(unitsById).find((u) => u.serialNo === where.serialNo) ?? null),
    findMany: ({ where }: any) => {
      if (where?.id?.in) return where.id.in.map((id: string) => unitsById[id]).filter(Boolean).map((u: any) => ({ ...u, order: { customerId: u.order.customer.id } }));
      if (where?.serialNo?.in) return Object.values(unitsById).filter((u: any) => where.serialNo.in.includes(u.serialNo)).map((u: any) => ({ serialNo: u.serialNo }));
      return [];
    },
    update: ({ where, data }: any) => ({ ...unitsById[where.id], ...data }),
  });
  stubModel("complaint", { findMany: () => [], findFirst: () => null });
  stubModel("amcOrderUnit", { findMany: () => [], count: () => 0 });
  stubModel("amcOrder", {});
  stubModel("complaintEvent", { create: () => ({}) });
  stubModel("serviceReport", { findMany: () => [] });
}

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

// ============================================================================================
// B. mandatory + unique serials
// ============================================================================================

test("PUT /recd-units/:id/serial rejects a serial that is already registered", async () => {
  reset();
  const pending = { ...unitA1, id: "uP", serialNo: null };
  unitsById.uP = pending;
  const r = await call("admin", "PUT", "/recd-units/uP/serial", { serialNo: "sn-b1" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already registered: SN-B1/);
  assert.equal(called("recdUnit.update").length, 0);
  delete unitsById.uP;
});

test("PUT /recd-units/:id/serial turns a database uniqueness conflict into a clean 409", async () => {
  reset();
  unitsById.uP = { ...unitA1, id: "uP", serialNo: null };
  // The pre-check passes but a concurrent request wins the race at the unique index.
  const findUnique = db.recdUnit.findUnique;
  stubModel("recdUnit", {
    findUnique: (a: any) => (a.where.serialNo ? null : findUnique(a)),
    updateMany: () => { throw p2002("RecdUnit", "serialNo"); },
  });
  const r = await call("admin", "PUT", "/recd-units/uP/serial", { serialNo: "NEW-1" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already registered: NEW-1/);
  delete unitsById.uP;
});

test("PUT /recd-units/:id/serial requires a valid serial and never overwrites an existing one", async () => {
  reset();
  assert.equal((await call("admin", "PUT", "/recd-units/uA1/serial", {})).status, 400, "missing serial");
  assert.equal((await call("admin", "PUT", "/recd-units/uA1/serial", { serialNo: "  " })).status, 400, "blank serial");
  const r = await call("admin", "PUT", "/recd-units/uA1/serial", { serialNo: "BRAND-NEW" });
  assert.equal(r.status, 409, "write-once");
  assert.match(r.body.error, /already has a serial/);
});

test("POST /orders without serials is a validation error; a taken serial is a 409", async () => {
  reset();
  const base_ = { customerId: "cA", productId: "p1", quantity: 1, poNumber: "PO-9" };
  const missing = await call("admin", "POST", "/orders", base_);
  assert.equal(missing.status, 400);
  assert.ok(missing.body.error.fieldErrors.recdSerials, "recdSerials is reported");

  const dup = await call("admin", "POST", "/orders", { ...base_, recdSerials: ["sn-a1"] });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already registered: SN-A1/);
});

test("POST /orders returns 409 for a racing serial; order and units are saved in one transaction", async () => {
  reset();
  stubModel("order", {
    findFirst: () => null,
    create: () => ({ id: "oNew", site: { id: "sNew" } }),
    delete: () => Promise.resolve({}),
  });
  stubModel("stageDefinition", { findUniqueOrThrow: () => ({ id: "stage1" }) });
  stubModel("recdUnit", {
    findMany: () => [],
    createMany: () => { throw p2002("RecdUnit", "serialNo"); },
  });
  const r = await call("admin", "POST", "/orders", { customerId: "cA", productId: "p1", quantity: 1, poNumber: "PO-9", recdSerials: ["RACE-1"] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /just registered by someone else/);
  assert.equal(called("order.delete").length, 0, "no after-the-fact delete: the transaction rolls everything back");
});

// ============================================================================================
// A. DG / customer / site alongside the serial
// ============================================================================================

test("GET /recd-units/:id returns the serial with its customer, site and DG details", async () => {
  reset();
  const r = await call("admin", "GET", "/recd-units/uA1");
  assert.equal(r.status, 200);
  assert.equal(r.body.serialNo, "SN-A1");
  assert.equal(r.body.order.customer.name, "Customer A");
  assert.equal(r.body.site.companyName, "Site A");
  assert.equal(r.body.site.dgModel, "Cummins C500");
  assert.equal(r.body.site.dgCapacityKva, "500");
  // the query itself must select the DG columns, not just happen to receive them
  const include = called("recdUnit.findUnique")[0][0].include;
  assert.equal(include.site.select.dgModel, true);
  assert.equal(include.site.select.dgCapacityKva, true);
});

// ============================================================================================
// C. AMC <-> unit
// ============================================================================================

const amcBody = { poNo: "PO-AMC", poDate: "2026-01-01T00:00:00.000Z", customerId: "cA", location: "Plant", item: "RECD", qty: 2, amcFrequencyPerYear: 4, amcType: "camc" };

function stubAmcCreate() {
  stubModel("amcOrder", { create: ({ data }: any) => ({ id: "amc1", ...data, units: [] }) });
}

test("POST /amc-orders links several units of the same customer", async () => {
  reset(); stubAmcCreate();
  const r = await call("admin", "POST", "/amc-orders", { ...amcBody, unitIds: ["uA1", "uA2"] });
  assert.equal(r.status, 201);
  const data = called("amcOrder.create")[0][0].data;
  assert.deepEqual(data.units.create, [{ unitId: "uA1" }, { unitId: "uA2" }]);
});

test("POST /amc-orders still works with no units (existing clients)", async () => {
  reset(); stubAmcCreate();
  const r = await call("admin", "POST", "/amc-orders", amcBody);
  assert.equal(r.status, 201);
  assert.deepEqual(called("amcOrder.create")[0][0].data.units.create, []);
});

test("POST /amc-orders rejects units that belong to another customer", async () => {
  reset(); stubAmcCreate();
  const r = await call("admin", "POST", "/amc-orders", { ...amcBody, unitIds: ["uA1", "uB1"] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /do not belong to the selected customer: SN-B1/);
  assert.equal(called("amcOrder.create").length, 0);
});

test("POST /amc-orders rejects unknown, serial-less, retired and duplicated units", async () => {
  reset(); stubAmcCreate();
  assert.match((await call("admin", "POST", "/amc-orders", { ...amcBody, unitIds: ["nope"] })).body.error, /Unknown RECD unit/);

  unitsById.uN = { ...unitA1, id: "uN", serialNo: null };
  assert.match((await call("admin", "POST", "/amc-orders", { ...amcBody, unitIds: ["uN"] })).body.error, /serial number/);
  delete unitsById.uN;

  unitsById.uR = { ...unitA1, id: "uR", serialNo: "SN-R", status: RECD_UNIT_STATUS.RETIRED };
  assert.match((await call("admin", "POST", "/amc-orders", { ...amcBody, unitIds: ["uR"] })).body.error, /Retired/);
  delete unitsById.uR;

  assert.equal((await call("admin", "POST", "/amc-orders", { ...amcBody, unitIds: ["uA1", "uA1"] })).status, 400, "same unit twice");
  assert.equal(called("amcOrder.create").length, 0);
});

test("AMC routes stay behind manage_amc_orders", async () => {
  reset();
  assert.equal((await call("custA", "POST", "/amc-orders", { ...amcBody, unitIds: ["uA1"] })).status, 403);
});

// ============================================================================================
// C. service history / reports on a unit
// ============================================================================================

const ticket = {
  id: "t1", ticketNumber: "TCK-1", status: "closed", serviceReportUrl: "data:application/pdf;base64,AAAA",
  events: [{ id: "e1", type: "created" }],
};
const amcLink = { amcOrder: { id: "amc1", poNo: "PO-AMC", poDate: new Date("2026-01-01T00:00:00Z"), amcType: "camc", status: "yet_to_start", amcFrequencyPerYear: 4, expiryReminderClearedAt: null } };

function stubHistory() {
  stubModel("complaint", { findMany: () => [ticket] });
  stubModel("amcOrderUnit", { findMany: () => [amcLink], count: () => 0 });
}

test("GET /recd-units/:id/history returns tickets, service reports and AMC for that serial", async () => {
  reset(); stubHistory();
  const r = await call("admin", "GET", "/recd-units/uA1/history");
  assert.equal(r.status, 200);
  assert.equal(r.body.unit.serialNo, "SN-A1");
  assert.equal(r.body.complaints[0].ticketNumber, "TCK-1");
  assert.equal(r.body.complaints[0].serviceReportUrl, ticket.serviceReportUrl);
  assert.equal(r.body.complaints[0].events.length, 1, "management sees the ticket timeline");
  assert.equal(r.body.complaintsVisible, true);
  assert.equal(r.body.amcOrders[0].poNo, "PO-AMC");
  assert.equal(r.body.amcOrders[0].expiresOn, "2027-01-01T00:00:00.000Z");
  // both lookups are keyed by this unit, not the site or customer
  assert.deepEqual(called("complaint.findMany")[0][0].where, { unitId: "uA1", archivedAt: null }, "archived tickets are out of the unit history");
  assert.deepEqual(called("amcOrderUnit.findMany")[0][0].where, { unitId: "uA1" });
});

test("GET /recd-units/:id/history: unknown unit is 404", async () => {
  reset(); stubHistory();
  assert.equal((await call("admin", "GET", "/recd-units/nope/history")).status, 404);
});

test("history/detail respect customer isolation", async () => {
  reset(); stubHistory();
  assert.equal((await call("custA", "GET", "/recd-units/uA1/history")).status, 200, "own unit");
  assert.equal((await call("custB", "GET", "/recd-units/uA1/history")).status, 403, "someone else's unit");
  assert.equal((await call("custB", "GET", "/recd-units/uA1")).status, 403, "detail too");
  assert.equal(called("complaint.findMany").length, 1, "no ticket data is even queried for the forbidden call");
});

test("history/detail respect vendor and regional-manager scoping", async () => {
  reset(); stubHistory();
  assert.equal((await call("vendor1", "GET", "/recd-units/uA1/history")).status, 200, "vendor's own site");
  assert.equal((await call("vendor1", "GET", "/recd-units/uB1/history")).status, 403, "another vendor's site");
  assert.equal((await call("rmNorth", "GET", "/recd-units/uA1/history")).status, 200, "managed region");
  assert.equal((await call("rmNorth", "GET", "/recd-units/uB1/history")).status, 403, "other region");
});

test("GET /recd-units list is scoped for customers and regional managers", async () => {
  reset();
  await call("custA", "GET", "/recd-units");
  assert.deepEqual(called("recdUnit.findMany")[0][0].where.order, { customerId: "cA" });
  await call("rmNorth", "GET", "/recd-units");
  assert.deepEqual(called("recdUnit.findMany")[1][0].where.site, { regionId: { in: ["north"] } });
});

// ============================================================================================
// C. tickets are tied to the right serial
// ============================================================================================

const complaintBody = { siteId: "sA", category: "non_performance", description: "Noise", severity: "low", attachmentUrl: "data:image/png;base64,AA" };

function stubComplaintCreate(siteUnits: any[]) {
  stubModel("site", { findUnique: () => ({ id: "sA", regionId: null, order: { customerId: "cA" } }) });
  stubModel("recdUnit", {
    findUnique: ({ where }: any) => unitsById[where.id] ?? null,
    findMany: () => siteUnits,
  });
  stubModel("complaint", { findFirst: () => null, create: ({ data }: any) => ({ id: "t9", status: "open", ...data }) });
}

test("a ticket for a single-RECD site is tied to that RECD's serial automatically", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]);
  const r = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(r.status, 201);
  assert.equal(called("complaint.create")[0][0].data.unitId, "uA1");
});

test("a ticket for a multi-RECD site must say which serial", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }, { id: "uA2", status: "active" }]);
  const r = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /select the RECD serial number/);
  assert.equal(called("complaint.create").length, 0);

  const ok = await call("custA", "POST", "/complaints", { ...complaintBody, unitId: "uA2" });
  assert.equal(ok.status, 201);
  assert.equal(called("complaint.create")[0][0].data.unitId, "uA2");
});

test("a ticket cannot be attached to a RECD from another site", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]);
  const r = await call("custA", "POST", "/complaints", { ...complaintBody, unitId: "uB1" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not belong to this site/);
});

test("history: customers get their tickets and AMC but never the internal ticket events", async () => {
  reset(); stubHistory();
  const r = await call("custA", "GET", "/recd-units/uA1/history");
  assert.equal(r.status, 200);
  assert.equal(r.body.complaints.length, 1);
  assert.deepEqual(r.body.complaints[0].events, []);
  assert.equal(called("complaint.findMany")[0][0].select.events, undefined, "events are not even queried");
  assert.equal(r.body.amcOrders.length, 1);
});

// A full staff row as the database holds it. The stub applies the route's `select` the way Prisma would, so a field the route does not ask for
// can never reach the response - and one it does ask for (the old behaviour) fails the assertions below.
const INTERNAL = { rootCause: "SECRET-ROOT-CAUSE", resolutionNotes: "SECRET-RESOLUTION", remarks: "SECRET-REMARK", serviceReportUrl: "data:application/pdf;base64,SECRETPDF" };
const fullTicket = {
  id: "t1", ticketNumber: "TCK-1", customerId: "cA", siteId: "sA", unitId: "uA1", category: "breakdown", issueCategory: "engine", description: "Will not start",
  severity: "high", status: "closed", source: "portal", reporterName: "Asha", reporterType: "customer", reporterPhone: "9999900000", attachmentUrl: "data:image/png;base64,AA==",
  createdAt: new Date("2026-02-01"), closedAt: new Date("2026-02-03"), dueDate: new Date("2026-02-02"), slaEscalationLevel: 1, closedById: "staff1",
  ...INTERNAL,
  assignedTo: { id: "eng-secret", name: "Vikram Singh", email: "eng@example.test" },
  events: [{ id: "e1", type: "assigned", actorLabel: "Staff", actor: { id: "staff1", name: "Staff One" } }],
};
function stubShapedHistory() {
  stubModel("complaint", { findMany: (args: any) => [shape(fullTicket, args)] });
  stubModel("amcOrderUnit", { findMany: () => [amcLink], count: () => 0 });
}
const FORBIDDEN_FOR_CUSTOMERS = ["rootCause", "resolutionNotes", "remarks", "serviceReportUrl", "assignedTo", "assignedToId", "reporterPhone", "dueDate", "slaEscalationLevel", "closedById", "events"];

test("history: a customer never receives the internal ticket fields - enforced in the API response, not the screen", async () => {
  reset(); stubShapedHistory();
  const r = await call("custA", "GET", "/recd-units/uA1/history");
  assert.equal(r.status, 200);
  assert.equal(r.body.complaints.length, 1);
  const text = JSON.stringify(r.body);
  for (const secret of [...Object.values(INTERNAL), "Vikram Singh", "eng-secret", "eng@example.test", "9999900000", "Staff One"]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
  const ticketKeys = Object.keys(r.body.complaints[0]);
  for (const k of FORBIDDEN_FOR_CUSTOMERS.filter((f) => f !== "events")) assert.ok(!ticketKeys.includes(k), `customer response has ${k}`);
  assert.deepEqual(r.body.complaints[0].events, []);
  // what the customer is entitled to still arrives
  assert.deepEqual(
    [r.body.complaints[0].ticketNumber, r.body.complaints[0].description, r.body.complaints[0].status, r.body.complaints[0].severity],
    ["TCK-1", "Will not start", "closed", "high"],
  );
  // and the staff columns were never even queried for a customer
  const select = called("complaint.findMany")[0][0].select;
  for (const k of ["rootCause", "resolutionNotes", "remarks", "serviceReportUrl", "assignedTo", "events"]) assert.equal(select[k], undefined, `${k} must not be selected`);
});

test("history: staff who work the ticket keep the full row (root cause, notes, report link, assignee, timeline)", async () => {
  for (const who of ["admin", "service"]) {
    reset(); stubShapedHistory();
    const r = await call(who, "GET", "/recd-units/uA1/history");
    assert.equal(r.status, 200, who);
    const c = r.body.complaints[0];
    assert.deepEqual([c.rootCause, c.resolutionNotes, c.remarks, c.serviceReportUrl], [INTERNAL.rootCause, INTERNAL.resolutionNotes, INTERNAL.remarks, INTERNAL.serviceReportUrl], who);
    assert.equal(c.assignedTo.name, "Vikram Singh", who);
    assert.equal(c.events.length, 1, `${who} sees the timeline`);
  }
  reset(); stubShapedHistory();
  const eng = (await call("engineer", "GET", "/recd-units/uA1/history")).body.complaints[0];
  assert.equal(eng.rootCause, INTERNAL.rootCause, "an assigned field engineer keeps what they need");
});

test("history: users with only view_site_status see the unit but no tickets or AMC", async () => {
  reset(); stubHistory();
  const r = await call("sales", "GET", "/recd-units/uA1/history");
  assert.equal(r.status, 200);
  assert.equal(r.body.unit.serialNo, "SN-A1");
  assert.equal(r.body.complaintsVisible, false);
  assert.equal(r.body.amcVisible, false);
  assert.deepEqual(r.body.complaints, []);
  assert.deepEqual(r.body.amcOrders, []);
  assert.equal(called("complaint.findMany").length, 0);
  assert.equal(called("amcOrderUnit.findMany").length, 0);
});

test("history: field engineers only see tickets assigned to them", async () => {
  reset(); stubHistory();
  await call("engineer", "GET", "/recd-units/uA1/history");
  assert.deepEqual(called("complaint.findMany")[0][0].where, { unitId: "uA1", archivedAt: null, assignedToId: "engineer" });
  reset(); stubHistory();
  await call("service", "GET", "/recd-units/uA1/history");
  assert.deepEqual(called("complaint.findMany")[0][0].where, { unitId: "uA1", archivedAt: null });
});

test("a racing duplicate open ticket for one RECD is a clean 400, not a 500", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]);
  stubModel("complaint", {
    findFirst: () => null,
    create: () => { throw p2002("Complaint", "unitId"); },
  });
  const r = await call("custA", "POST", "/complaints", { ...complaintBody, unitId: "uA1" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /open complaint already exists/);
});

// ============================================================================================
// B. AI agent order creation carries the same mandatory-serial rule
// ============================================================================================

async function agentCreateOrder(input: Record<string, unknown>, existingPo = false) {
  const { appWriteTools } = await import("../src/agent/tools/appWriteTools");
  const tool = appWriteTools.find((t) => t.name === "create_order")!;
  stubModel("customer", { findUnique: () => ({ id: "cA", name: "Customer A" }), findMany: () => [] });
  stubModel("product", { findUnique: () => ({ id: "p1", name: "RECD", model: "R-500" }), findMany: () => [] });
  stubModel("agentPendingAction", { create: ({ data }: any) => ({ id: "act1", ...data }) });
  stubModel("order", { findFirst: () => (existingPo ? { orderNumber: "ORD-2026-1111" } : null) });
  return (await tool.handler(
    { customerId: "cA", productId: "p1", poNumber: "PO-AI-1", ...input },
    { userId: "admin", roleKey: ROLE_KEY.MANAGEMENT, permissions: new Set([P.MANAGE_ORDERS]), conversationId: "conv1" },
  )) as any;
}

test("agent create_order requires one valid, distinct, unregistered serial per unit", async () => {
  reset();
  assert.match((await agentCreateOrder({ quantity: 2 })).error, /recdSerials is required/);
  assert.match((await agentCreateOrder({ quantity: 2, recdSerials: ["NEW-1"] })).error, /2 RECD serial number/);
  assert.match((await agentCreateOrder({ quantity: 2, recdSerials: ["NEW-1", "new-1"] })).error, /Duplicate/);
  assert.match((await agentCreateOrder({ quantity: 1, recdSerials: ["has space"] })).error, /Invalid serial/);
  assert.match((await agentCreateOrder({ quantity: 1, recdSerials: ["sn-a1"] })).error, /already registered: SN-A1/);
  assert.equal(called("agentPendingAction.create").length, 0, "nothing is proposed for any of the above");
});

test("agent create_order stores normalised serials on the pending action", async () => {
  reset();
  const r = await agentCreateOrder({ quantity: 2, recdSerials: ["new-1", "NEW-2"] });
  assert.equal(r.status, "pending_confirmation");
  assert.deepEqual(called("agentPendingAction.create")[0][0].data.input.recdSerials, ["NEW-1", "NEW-2"]);
  assert.deepEqual(r.preview.recdSerials, ["NEW-1", "NEW-2"]);
});

// ============================================================================================
// REQUIREMENT 1 / SUBTASK 1 - serial rules on every creation path
// ============================================================================================

const racing = () => p2002("RecdUnit", "serialNo");

test("POST /orders rejects a malformed serial and a repeated serial inside one request", async () => {
  reset();
  const ok = { customerId: "cA", productId: "p1", quantity: 2, poNumber: "PO-9" };
  const bad = await call("admin", "POST", "/orders", { ...ok, recdSerials: ["has space", "GOOD-1"] });
  assert.equal(bad.status, 400);
  const dup = await call("admin", "POST", "/orders", { ...ok, recdSerials: ["SAME-1", "same-1"] });
  assert.equal(dup.status, 400);
  assert.equal(called("order.create").length, 0, "nothing is created for an invalid request");
});

function stubLineItemOrder(createMany: () => unknown) {
  stubModel("order", { findUnique: () => ({ id: "oA", customerId: "cA" }) });
  stubModel("site", { findUnique: () => ({ id: "sA" }) });
  stubModel("orderLineItem", { create: () => ({ id: "li1" }) });
  stubModel("recdUnit", { findMany: () => [], createMany });
}

test("POST /orders/:id/line-items: missing, taken and racing serials are all refused cleanly", async () => {
  reset();
  stubLineItemOrder(() => ({ count: 1 }));
  assert.equal((await call("admin", "POST", "/orders/oA/line-items", { productId: "p1", quantity: 1 })).status, 400, "missing serials");
  assert.equal((await call("admin", "POST", "/orders/oA/line-items", { productId: "p1", quantity: 2, recdSerials: ["ONLY-1"] })).status, 400, "too few");

  stubModel("recdUnit", { findMany: () => [{ serialNo: "SN-A1" }], createMany: () => ({ count: 1 }) });
  const taken = await call("admin", "POST", "/orders/oA/line-items", { productId: "p1", quantity: 1, recdSerials: ["sn-a1"] });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already registered: SN-A1/);

  stubLineItemOrder(() => { throw racing(); });
  const race = await call("admin", "POST", "/orders/oA/line-items", { productId: "p1", quantity: 1, recdSerials: ["RACE-2"] });
  assert.equal(race.status, 409);
  assert.match(race.body.error, /just registered by someone else/);
});

function stubCloneSite(createMany: () => unknown, taken: string[] = []) {
  stubModel("site", { findUnique: () => ({ id: "sA", address: "x", companyName: "Site A", vendorId: null, regionId: null, order: { customerId: "cA", poNumber: "PO-1", poDate: null } }) });
  stubModel("stageDefinition", { findUniqueOrThrow: () => ({ id: "stage1" }) });
  stubModel("order", { create: () => ({ id: "oNew", site: { id: "sNew" } }) });
  stubModel("recdUnit", { findMany: () => taken.map((serialNo) => ({ serialNo })), createMany });
}

test("POST /sites/:id/clone-order: missing, taken and racing serials are refused and create nothing", async () => {
  reset();
  stubCloneSite(() => ({ count: 1 }));
  assert.equal((await call("admin", "POST", "/sites/sA/clone-order", { productId: "p1", quantity: 1 })).status, 400, "missing serials");
  assert.equal(called("order.create").length, 0);

  stubCloneSite(() => ({ count: 1 }), ["SN-A1"]);
  const taken = await call("admin", "POST", "/sites/sA/clone-order", { productId: "p1", quantity: 1, recdSerials: ["SN-A1"] });
  assert.equal(taken.status, 409);
  assert.equal(called("order.create").length, 0);

  stubCloneSite(() => { throw racing(); });
  const race = await call("admin", "POST", "/sites/sA/clone-order", { productId: "p1", quantity: 1, recdSerials: ["RACE-3"] });
  assert.equal(race.status, 409);
  assert.match(race.body.error, /just registered by someone else/);

  stubCloneSite(() => ({ count: 1 }));
  const ok = await call("admin", "POST", "/sites/sA/clone-order", { productId: "p1", quantity: 1, recdSerials: ["new-9"] });
  assert.equal(ok.status, 201);
  assert.deepEqual(called("recdUnit.createMany").at(-1)![0].data.map((d: any) => d.serialNo), ["NEW-9"]);
});

test("legacy units without a serial stay manageable: list them, then give them a serial once", async () => {
  reset();
  const pending = { ...unitA1, id: "uP", serialNo: null };
  unitsById.uP = pending;
  const list = await call("admin", "GET", "/recd-units?pending=1");
  assert.equal(list.status, 200);
  assert.equal(called("recdUnit.findMany")[0][0].where.serialNo, null, "pending=1 asks for serial-less units");

  const detail = await call("admin", "GET", "/recd-units/uP");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.serialNo, null);
  assert.equal((await call("admin", "GET", "/recd-units/uP/history")).status, 200, "history works without a serial");

  const findUnique = db.recdUnit.findUnique;
  stubModel("recdUnit", {
    findUnique: (a: any) => (a.where.serialNo ? null : findUnique(a)),
    updateMany: ({ where, data }: any) => {
      if (unitsById[where.id]?.serialNo !== where.serialNo) return { count: 0 }; // the real write is conditional on the unit still being serial-less
      unitsById[where.id] = { ...unitsById[where.id], ...data };
      return { count: 1 };
    },
  });
  const set = await call("admin", "PUT", "/recd-units/uP/serial", { serialNo: " legacy-7 " });
  assert.equal(set.status, 200);
  assert.equal(set.body.serialNo, "LEGACY-7");
  delete unitsById.uP;
});

test("the only places that create RECD units are the ones covered by serial tests", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts") && /recdUnit\.(create|createMany|upsert)\(/.test(fs.readFileSync(p, "utf8"))) found.push(path.relative(path.join(__dirname, "..", "src"), p).replace(/\\/g, "/"));
    }
  };
  walk(path.join(__dirname, "..", "src"));
  // A new creation path must be added here AND given a missing/duplicate serial test above.
  assert.deepEqual(found.sort(), ["lib/orderCreation.ts", "routes/orders.ts", "routes/sites.ts"]);
});

// --- AI order: confirmation step (the proposal step is tested earlier) ----------------------

async function confirmAiOrder(input: Record<string, unknown>) {
  const { executeConfirmedAction } = await import("../src/routes/agentConversations");
  return executeConfirmedAction("create_order", { customerId: "cA", productId: "p1", quantity: 2, poNumber: "PO-AI-1", ...input }, "admin");
}

function stubAiOrder(createMany: () => unknown, taken: string[] = []) {
  stubModel("stageDefinition", { findUniqueOrThrow: () => ({ id: "stage1" }) });
  stubModel("order", { findFirst: () => null, create: () => ({ id: "oAI", site: { id: "sAI" } }) });
  stubModel("recdUnit", { findMany: () => taken.map((serialNo) => ({ serialNo })), createMany });
}

test("AI order confirmation refuses a card with no, bad, duplicate or taken serials", async () => {
  reset(); stubAiOrder(() => ({ count: 2 }), ["SN-A1"]);
  await assert.rejects(confirmAiOrder({}), /recdSerials is required/, "card proposed before serials were required");
  await assert.rejects(confirmAiOrder({ recdSerials: ["ONE-1"] }), /2 RECD serial number/);
  await assert.rejects(confirmAiOrder({ recdSerials: ["bad serial", "OK-2"] }), /Invalid serial/);
  await assert.rejects(confirmAiOrder({ recdSerials: ["DUP-1", "dup-1"] }), /Duplicate/);
  await assert.rejects(confirmAiOrder({ recdSerials: ["SN-A1", "NEW-2"] }), /already registered: SN-A1/);
  assert.equal(called("order.create").length, 0, "nothing was created by any refused card");
});

test("AI order confirmation creates order and units together, and maps a racing serial to a clear error", async () => {
  reset(); stubAiOrder(() => ({ count: 2 }));
  assert.equal(await confirmAiOrder({ recdSerials: ["ai-1", "AI-2"] }), "oAI");
  assert.deepEqual(called("recdUnit.createMany")[0][0].data.map((d: any) => d.serialNo), ["AI-1", "AI-2"]);

  reset(); stubAiOrder(() => { throw racing(); });
  await assert.rejects(confirmAiOrder({ recdSerials: ["AI-3", "AI-4"] }), /just registered by someone else/);
});

// ============================================================================================
// REQUIREMENT 1 / SUBTASK 2 - complaints belong to the right RECD
// ============================================================================================

test("a complaint without the mandatory photo is rejected before anything is looked up", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]);
  const { attachmentUrl: _drop, ...noPhoto } = complaintBody;
  assert.equal((await call("custA", "POST", "/complaints", noPhoto)).status, 400);
  assert.equal((await call("custA", "POST", "/complaints", { ...complaintBody, attachmentUrl: "" })).status, 400);
  assert.equal(called("complaint.create").length, 0);
});

test("a customer cannot raise a complaint on another customer's site, or on a retired RECD", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]);
  const other = await call("custB", "POST", "/complaints", complaintBody);
  assert.equal(other.status, 403, "site belongs to customer A");

  const retired = await call("custA", "POST", "/complaints", { ...complaintBody, unitId: "uR" });
  assert.equal(retired.status, 400, "unit is not part of the site's units at all");

  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }, { id: "uOld", status: "retired" }]);
  const gone = await call("custA", "POST", "/complaints", { ...complaintBody, unitId: "uOld" });
  assert.equal(gone.status, 400);
  assert.match(gone.body.error, /no longer in service/);
  assert.equal(called("complaint.create").length, 0);
});

test("a retired unit does not count when deciding whether the customer must choose", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }, { id: "uOld", status: "retired" }]);
  const r = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(r.status, 201);
  assert.equal(called("complaint.create")[0][0].data.unitId, "uA1");
});

test("a legacy site with no units still accepts a complaint (unlinked), and staff cannot raise one", async () => {
  reset(); stubComplaintCreate([]);
  const r = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(r.status, 201);
  assert.equal(called("complaint.create")[0][0].data.unitId, undefined);
  stubModel("user", { findUnique: db.user.findUnique });
  assert.equal((await call("service", "POST", "/complaints", complaintBody)).status, 403, "staff lack raise_complaint");
});

test("the complaint unit chosen by the customer is what is stored and what the history is keyed on", async () => {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }, { id: "uA2", status: "active" }]);
  const created = await call("custA", "POST", "/complaints", { ...complaintBody, unitId: "uA2" });
  assert.equal(created.status, 201);
  assert.equal(called("complaint.create")[0][0].data.unitId, "uA2");
  assert.equal(called("complaint.create")[0][0].data.siteId, "sA");
  assert.equal(called("complaint.create")[0][0].data.customerId, "cA");

  stubHistory();
  await call("admin", "GET", "/recd-units/uA2/history");
  assert.deepEqual(called("complaint.findMany")[0][0].where, { unitId: "uA2", archivedAt: null });
});

// ============================================================================================
// REQUIREMENT 1 / SUBTASK 4 - permission boundaries
// ============================================================================================

test("serials can only be written by roles that manage orders (customers and service staff cannot)", async () => {
  reset();
  unitsById.uP = { ...unitA1, id: "uP", serialNo: null };
  for (const who of ["custA", "service", "engineer", "vendor1"]) {
    const r = await call(who, "PUT", "/recd-units/uP/serial", { serialNo: "TRY-1" });
    assert.equal(r.status, 403, who);
  }
  assert.equal(called("recdUnit.update").length, 0);
  delete unitsById.uP;
});

test("AMC data is closed to customers, service staff, engineers and unit-viewers", async () => {
  reset();
  for (const who of ["custA", "service", "engineer", "sales", "vendor1", "rmNorth"]) {
    assert.equal((await call(who, "GET", "/amc-orders")).status, 403, who);
    assert.equal((await call(who, "POST", "/amc-orders", { ...amcBody, unitIds: [] })).status, 403, who);
    assert.equal((await call(who, "PATCH", "/amc-orders/amc1/clear-reminder")).status, 403, who);
  }
});

test("unit endpoints need a valid login", async () => {
  reset();
  for (const path of ["/recd-units", "/recd-units/uA1", "/recd-units/uA1/history"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, path);
  }
  const bad = await fetch(base + "/recd-units/uA1/history", { headers: { authorization: "Bearer not-a-token" } });
  assert.equal(bad.status, 401);
});

test("changing the id in the URL never reveals another customer's unit, tickets or AMC", async () => {
  reset(); stubHistory();
  for (const path of ["/recd-units/uA1", "/recd-units/uA1/history"]) {
    const r = await call("custB", "GET", path);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.complaints, undefined);
    assert.equal(r.body.amcOrders, undefined);
  }
  assert.equal(called("complaint.findMany").length, 0);
  assert.equal(called("amcOrderUnit.findMany").length, 0);
  assert.equal((await call("custA", "GET", "/recd-units/uB1/history")).status, 403, "and the other way round");
});

test("a customer filtering the unit list by someone else's customerId still only gets their own", async () => {
  reset();
  await call("custA", "GET", "/recd-units?customerId=cB");
  assert.deepEqual(called("recdUnit.findMany")[0][0].where.order, { customerId: "cA" });
});

test("roles that only view basic unit/site status get no service data from any unit endpoint", async () => {
  reset(); stubHistory();
  for (const who of ["sales", "vendor1"]) {
    const h = await call(who, "GET", "/recd-units/uA1/history");
    assert.equal(h.status, 200, who);
    assert.deepEqual(h.body.complaints, [], who);
    assert.deepEqual(h.body.amcOrders, [], who);
    assert.equal(JSON.stringify(h.body).includes("serviceReportUrl"), false, who + " never receives report data");
  }
  const detail = await call("sales", "GET", "/recd-units/uA1");
  assert.equal(detail.body.complaints, undefined);
});

// ============================================================================================
// REQUIREMENT 1 / FIX 1 - which unique constraint fired?
// ============================================================================================

function stubOrderCreateThrowing(err: () => never) {
  stubModel("order", { findFirst: () => null, create: () => err() });
  stubModel("stageDefinition", { findUniqueOrThrow: () => ({ id: "stage1" }) });
  stubModel("recdUnit", { findMany: () => [], createMany: () => ({ count: 1 }) });
}
const newOrder = { customerId: "cA", productId: "p1", quantity: 1, poNumber: "PO-1", recdSerials: ["SER-1"] };

test("POST /orders: an order-number collision is reported as such, not as a serial conflict", async () => {
  reset(); stubOrderCreateThrowing(() => { throw p2002("Order", "orderNumber"); });
  const r = await call("admin", "POST", "/orders", newOrder);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ORDER_NUMBER_EXHAUSTED");
  assert.match(r.body.error, /Could not allocate a free order number/);
  assert.doesNotMatch(r.body.error, /serial/i);
});

test("POST /orders: a serial collision is still reported as a serial conflict", async () => {
  reset();
  stubModel("order", { findFirst: () => null, create: () => ({ id: "o1", site: { id: "s1" } }) });
  stubModel("stageDefinition", { findUniqueOrThrow: () => ({ id: "stage1" }) });
  stubModel("recdUnit", { findMany: () => [], createMany: () => { throw p2002("RecdUnit", "serialNo"); } });
  const r = await call("admin", "POST", "/orders", newOrder);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /serial numbers was just registered/);
  assert.equal(r.body.code, undefined);
});

test("POST /orders: other database errors are NOT turned into validation errors", async () => {
  for (const err of [
    () => { throw p2002("User", "email"); },
    () => { throw p2002("Order"); }, // unique violation with no usable target
    () => { throw new Error("connection reset"); },
  ]) {
    reset(); stubOrderCreateThrowing(err);
    const r = await call("admin", "POST", "/orders", newOrder);
    assert.equal(r.status, 500);
  }
});

test("clone-order: order-number collision, serial collision and unrelated errors are told apart", async () => {
  const body = { productId: "p1", quantity: 1, recdSerials: ["CL-1"] };
  reset(); stubCloneSite(() => ({ count: 1 }));
  stubModel("order", { create: () => { throw p2002("Order", "orderNumber"); } });
  const num = await call("admin", "POST", "/sites/sA/clone-order", body);
  assert.equal(num.status, 409);
  assert.equal(num.body.code, "ORDER_NUMBER_EXHAUSTED");
  assert.doesNotMatch(num.body.error, /serial/i);

  reset(); stubCloneSite(() => { throw p2002("RecdUnit", "serialNo"); });
  const ser = await call("admin", "POST", "/sites/sA/clone-order", body);
  assert.equal(ser.status, 409);
  assert.match(ser.body.error, /serial numbers was just registered/);

  reset(); stubCloneSite(() => ({ count: 1 }));
  stubModel("order", { create: () => { throw new Error("disk full"); } });
  assert.equal((await call("admin", "POST", "/sites/sA/clone-order", body)).status, 500);
});

test("line items and PUT serial: only a serial collision becomes a 409", async () => {
  reset(); stubLineItemOrder(() => { throw p2002("RecdUnit", "serialNo"); });
  assert.equal((await call("admin", "POST", "/orders/oA/line-items", { productId: "p1", quantity: 1, recdSerials: ["LI-1"] })).status, 409);
  reset(); stubLineItemOrder(() => { throw p2002("OrderLineItem", "id"); });
  assert.equal((await call("admin", "POST", "/orders/oA/line-items", { productId: "p1", quantity: 1, recdSerials: ["LI-1"] })).status, 500);

  reset();
  unitsById.uP = { ...unitA1, id: "uP", serialNo: null };
  const findUnique = db.recdUnit.findUnique;
  stubModel("recdUnit", { findUnique: (a: any) => (a.where.serialNo ? null : findUnique(a)), update: () => { throw p2002("RecdUnit", "id"); } });
  assert.equal((await call("admin", "PUT", "/recd-units/uP/serial", { serialNo: "PUT-1" })).status, 500);
  delete unitsById.uP;
});

// ============================================================================================
// REQUIREMENT 1 / FIX 2 - racing complaints
// ============================================================================================

test("complaint create: only the one-open-ticket index becomes a 400; other failures stay failures", async () => {
  const create = (err: () => never) => { reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]); stubModel("complaint", { findFirst: () => null, create: () => err() }); };

  create(() => { throw p2002("Complaint", "unitId"); });
  const open = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(open.status, 400);
  assert.match(open.body.error, /open complaint already exists/);

  for (const [label, err] of [
    ["unrelated unique index", () => { throw p2002("User", "email"); }],
    ["foreign key failure", () => { throw new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0", meta: { modelName: "Complaint" } }); }],
    ["plain error", () => { throw new Error("db down"); }],
  ] as const) {
    create(err);
    assert.equal((await call("custA", "POST", "/complaints", complaintBody)).status, 500, label);
  }
});

// ============================================================================================
// REQUIREMENT 1 / FIX 3 - AI confirmation returns client errors, not 500s
// ============================================================================================

test("AI confirmation: invalid input is a 400 and a real conflict is a 409 (typed errors)", async () => {
  const { AgentActionError } = await import("../src/routes/agentConversations");
  const status = async (input: Record<string, unknown>) => {
    try { await confirmAiOrder(input); return "ok"; } catch (e) { return e instanceof AgentActionError ? e.status : "unexpected:" + (e as Error).message; }
  };
  reset(); stubAiOrder(() => ({ count: 2 }), ["SN-A1"]);
  assert.equal(await status({}), 400, "no serials");
  assert.equal(await status({ recdSerials: ["ONE-1"] }), 400, "wrong count");
  assert.equal(await status({ recdSerials: ["bad serial", "OK-2"] }), 400, "bad format");
  assert.equal(await status({ recdSerials: ["DUP-1", "dup-1"] }), 400, "repeated in the card");
  assert.equal(await status({ recdSerials: ["SN-A1", "NEW-2"] }), 409, "already registered");

  reset(); stubAiOrder(() => { throw p2002("RecdUnit", "serialNo"); });
  assert.equal(await status({ recdSerials: ["AI-3", "AI-4"] }), 409, "lost a race");

  reset(); stubAiOrder(() => ({ count: 2 }));
  stubModel("order", { findFirst: () => null, create: () => { throw p2002("Order", "orderNumber"); } });
  assert.equal(await status({ recdSerials: ["AI-5", "AI-6"] }), 409, "order number collision");
});

test("AI confirmation: unexpected failures are not typed as client errors", async () => {
  const { AgentActionError } = await import("../src/routes/agentConversations");
  for (const err of [() => { throw new Error("db down"); }, () => { throw p2002("User", "email"); }]) {
    reset(); stubAiOrder(() => ({ count: 2 }));
    stubModel("order", { findFirst: () => null, create: () => err() });
    await assert.rejects(confirmAiOrder({ recdSerials: ["AI-7", "AI-8"] }), (e: any) => !(e instanceof AgentActionError));
  }
});

// ============================================================================================
// REQUIREMENT 1 / FIX 4 - AMC customer validation
// ============================================================================================

test("POST /amc-orders: an unknown customer is a 400 with a clear message, not a 500", async () => {
  reset(); stubAmcCreate();
  const r = await call("admin", "POST", "/amc-orders", { ...amcBody, customerId: "no-such-customer", unitIds: [] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Customer not found");
  assert.equal(called("amcOrder.create").length, 0);
  assert.equal(called("recdUnit.findMany").length, 0, "units are not even looked up for an unknown customer");
  const withUnits = await call("admin", "POST", "/amc-orders", { ...amcBody, customerId: "no-such-customer", unitIds: ["uA1"] });
  assert.equal(withUnits.status, 400);
});

test("POST /amc-orders: quantity is deliberately not tied to the number of units", async () => {
  // Existing business rule (see HANDOVER): qty is the contracted quantity as typed on the PO; the units
  // link is additional detail. Changing that needs the mentor's decision, so it must keep working both ways.
  reset(); stubAmcCreate();
  assert.equal((await call("admin", "POST", "/amc-orders", { ...amcBody, qty: 5, unitIds: ["uA1"] })).status, 201);
  assert.equal((await call("admin", "POST", "/amc-orders", { ...amcBody, qty: 1, unitIds: ["uA1", "uA2"] })).status, 201);
});

// ============================================================================================
// FIX A - ticket-number collisions when a customer raises a complaint
// ============================================================================================

function stubTicketCreate(outcomes: Array<() => unknown>) {
  reset(); stubComplaintCreate([{ id: "uA1", status: "active" }]);
  let i = 0;
  stubModel("complaint", {
    findFirst: () => null,
    create: ({ data }: any) => {
      const outcome = outcomes[Math.min(i++, outcomes.length - 1)];
      const result = outcome();
      return result === undefined ? { id: "t9", status: "open", ...data } : result;
    },
  });
}
const ticketCollision = () => { throw p2002("Complaint", "ticketNumber"); };
const ok = () => undefined;

test("complaint create: a ticket-number collision is retried with a new number and succeeds", async () => {
  stubTicketCreate([ticketCollision, ok]);
  const r = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(called("complaint.create").length, 2, "one retry");
  assert.match(r.body.ticketNumber, /^TCK-\d{4}-\d{5}$/);
});

test("complaint create: if every attempt collides the answer is a clear 409, not a 500, and nothing is saved", async () => {
  stubTicketCreate([ticketCollision]);
  const r = await call("custA", "POST", "/complaints", complaintBody);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "TICKET_NUMBER_CONFLICT");
  assert.match(r.body.error, /Nothing was saved - please submit the complaint again/);
  assert.equal(called("complaint.create").length, 3, "bounded: three attempts, no endless loop");
  assert.equal(called("complaintEvent.create").length, 0, "no history row for a complaint that was never created");
});

test("complaint create: only ticket-number collisions are retried; everything else is not hidden", async () => {
  // the one-open-ticket index: a 400, immediately
  stubTicketCreate([() => { throw p2002("Complaint", "unitId"); }]);
  assert.equal((await call("custA", "POST", "/complaints", complaintBody)).status, 400);
  assert.equal(called("complaint.create").length, 1, "an open-ticket conflict is not retried");

  // a collision first, then the open-ticket index: still the 400
  stubTicketCreate([ticketCollision, () => { throw p2002("Complaint", "unitId"); }]);
  assert.equal((await call("custA", "POST", "/complaints", complaintBody)).status, 400);
  assert.equal(called("complaint.create").length, 2);

  for (const [label, err] of [
    ["another unique index", () => { throw p2002("User", "email"); }],
    ["unique violation with no usable target", () => { throw p2002("Complaint"); }],
    ["foreign key failure", () => { throw new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0", meta: { modelName: "Complaint" } }); }],
    ["plain error", () => { throw new Error("db down"); }],
  ] as const) {
    stubTicketCreate([err]);
    assert.equal((await call("custA", "POST", "/complaints", complaintBody)).status, 500, label);
    assert.equal(called("complaint.create").length, 1, `${label}: not retried`);
  }
});

// ============================================================================================
// FIX B - AI order confirmation never shows internal error details
// ============================================================================================

async function agentMessages() {
  return await import("../src/routes/agentConversations");
}

function stubAgentCard(input: Record<string, unknown>, opts: { actionUpdate?: () => unknown } = {}) {
  stubModel("agentConversation", {
    findUnique: () => ({ id: "conv1", userId: "admin", messages: [] }),
    update: () => ({ messages: [] }),
  });
  stubModel("agentPendingAction", {
    findUnique: () => ({ id: "act1", conversationId: "conv1", status: "pending", toolName: "create_order", input: { customerId: "cA", productId: "p1", quantity: 1, poNumber: "PO-AI-1", ...input } }),
    update: opts.actionUpdate ?? (() => ({})),
  });
}
const confirmCard = () => call("admin", "POST", "/agent/conversations/conv1/actions/act1/confirm");
const rejectCard = () => call("admin", "POST", "/agent/conversations/conv1/actions/act1/reject");

/** Runs fn while capturing console.error, so tests can check details went to the log and not the response. */
async function withCapturedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  try { return { result: await fn(), logged: lines.join("\n") }; } finally { console.error = original; }
}

const SECRET = "duplicate key value violates unique constraint \"internal_table_pkey\" (password=hunter2, host=db.internal)";

test("AI confirmation: an unexpected failure returns a safe message - the details go to the log only", async () => {
  const { SAFE_ACTION_FAILED_MESSAGE } = await agentMessages();
  for (const err of [
    () => { throw new Error(SECRET); },
    () => { throw p2002("User", "email"); },
  ]) {
    reset(); stubAiOrder(() => ({ count: 1 })); stubAgentCard({ recdSerials: ["SAFE-1"] });
    stubModel("order", { findFirst: () => null, create: () => err() });
    const { result, logged } = await withCapturedErrors(confirmCard);
    assert.equal(result.status, 500);
    assert.equal(result.body.error, SAFE_ACTION_FAILED_MESSAGE);
    assert.doesNotMatch(JSON.stringify(result.body), /hunter2|constraint|internal_table|invocation|Order_customerId|prisma|P200\d|db\.internal/i);
    assert.match(logged, /confirming action failed/, "the failure is still logged for developers");
    assert.equal(called("agentPendingAction.update").length, 0, "the card stays pending");
  }
  // and the original detail really is in the log (not lost)
  reset(); stubAiOrder(() => ({ count: 1 })); stubAgentCard({ recdSerials: ["SAFE-2"] });
  stubModel("order", { findFirst: () => null, create: () => { throw new Error(SECRET); } });
  const { logged } = await withCapturedErrors(confirmCard);
  assert.match(logged, /hunter2/);
});

test("AI confirmation: validation errors (400) and conflicts (409) keep their status and their own helpful message", async () => {
  reset(); stubAiOrder(() => ({ count: 2 }), ["SN-A1"]); stubAgentCard({ quantity: 2 });
  const none = await confirmCard();
  assert.equal(none.status, 400);
  assert.match(none.body.error, /recdSerials is required/);

  stubAgentCard({ quantity: 2, recdSerials: ["SN-A1", "NEW-2"] });
  const taken = await confirmCard();
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already registered: SN-A1/);

  reset(); stubAiOrder(() => { throw p2002("RecdUnit", "serialNo"); }); stubAgentCard({ recdSerials: ["RACE-9"] });
  const race = await confirmCard();
  assert.equal(race.status, 409);
  assert.match(race.body.error, /just registered by someone else/);

  reset(); stubAiOrder(() => ({ count: 1 })); stubAgentCard({ recdSerials: ["ONUM-9"] });
  stubModel("order", { findFirst: () => null, create: () => { throw p2002("Order", "orderNumber"); } });
  const num = await confirmCard();
  assert.equal(num.status, 409);
  assert.match(num.body.error, /Could not allocate a free order number/);
  assert.equal(called("agentPendingAction.update").length, 0, "cards stay pending after 400 and 409");
});

test("AI confirmation: if the order was created but the chat could not be updated, say so safely", async () => {
  const { SAFE_ACTION_DONE_BUT_NOT_SAVED_MESSAGE } = await agentMessages();
  reset(); stubAiOrder(() => ({ count: 1 }));
  stubAgentCard({ recdSerials: ["BOOK-1"] }, { actionUpdate: () => { throw new Error(SECRET); } });
  const { result, logged } = await withCapturedErrors(confirmCard);
  assert.equal(called("recdUnit.createMany").length, 1, "the order really was created");
  assert.equal(result.status, 500);
  assert.equal(result.body.error, SAFE_ACTION_DONE_BUT_NOT_SAVED_MESSAGE);
  assert.match(result.body.error, /do not confirm it again/);
  assert.doesNotMatch(JSON.stringify(result.body), /hunter2|constraint/i);
  assert.match(logged, /hunter2/);
});

test("AI rejection: an internal failure is also reported safely", async () => {
  const { SAFE_ACTION_FAILED_MESSAGE } = await agentMessages();
  reset(); stubAgentCard({ recdSerials: ["REJ-1"] }, { actionUpdate: () => { throw new Error(SECRET); } });
  const { result } = await withCapturedErrors(rejectCard);
  assert.equal(result.status, 500);
  assert.equal(result.body.error, SAFE_ACTION_FAILED_MESSAGE);
  assert.doesNotMatch(JSON.stringify(result.body), /hunter2|constraint/i);
});

// ============================================================================================
// R1 defects D1-D3 (route logic only - the database behaviour is proven in test/db/serialRules.db.test.ts)
// ============================================================================================

test("D1: PUT /recd-units/:id/serial loses cleanly when the unit got a serial between the read and the write", async () => {
  reset();
  unitsById.uP = { ...unitA1, id: "uP", serialNo: null };
  const findUnique = db.recdUnit.findUnique;
  // The read still sees a serial-less unit, but the conditional write matches nothing (another request won).
  stubModel("recdUnit", {
    findUnique: (a: any) => (a.where.serialNo ? null : findUnique(a)),
    updateMany: () => ({ count: 0 }),
    update: () => { throw new Error("must not be an unconditional write"); },
  });
  const r = await call("admin", "PUT", "/recd-units/uP/serial", { serialNo: "LATE-1" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already has a serial/);
  const [arg] = called("recdUnit.updateMany")[0];
  assert.deepEqual(arg.where, { id: "uP", serialNo: null }, "the write is conditioned on the serial still being empty");
  delete unitsById.uP;
});

function stubCorrectionDb(opts: { updateCount?: number } = {}) {
  reset();
  unitsById.uC = { ...unitA1, id: "uC", serialNo: "OLD-1" };
  const read = db.recdUnit.findUnique;
  stubModel("recdUnit", {
    findUnique: (a: any) => read(a),
    updateMany: () => ({ count: opts.updateCount ?? 1 }),
  });
  stubModel("recdUnitSerialHistory", { create: ({ data }: any) => ({ id: "h1", ...data }) });
}
const correction = (as: string, body: unknown) => call(as, "PATCH", "/recd-units/uC/serial", body);

test("D3: only an administrative role can correct a serial (manage_orders alone is not enough)", async () => {
  stubCorrectionDb();
  const body = { expectedSerialNo: "OLD-1", serialNo: "NEW-1", reason: "typo at entry" };
  assert.equal((await correction("sales", body)).status, 403);
  assert.equal((await correction("custA", body)).status, 403, "customers are refused");
  assert.equal(called("recdUnit.updateMany").length, 0);
  assert.equal(called("recdUnitSerialHistory.create").length, 0);
  delete unitsById.uC;
});

test("D3: invalid input is a 400 and nothing is written", async () => {
  stubCorrectionDb();
  for (const body of [
    {}, { expectedSerialNo: "OLD-1", serialNo: "NEW-1" }, { expectedSerialNo: "OLD-1", serialNo: "NEW-1", reason: "  x " },
    { expectedSerialNo: "OLD-1", serialNo: "bad serial!", reason: "typo at entry" }, { expectedSerialNo: "OLD-1", serialNo: "  ", reason: "typo at entry" },
    { expectedSerialNo: "OLD-1", serialNo: "old-1", reason: "same value, other case" },
  ]) assert.equal((await correction("admin", body)).status, 400, JSON.stringify(body));
  assert.equal(called("recdUnit.updateMany").length, 0);
  delete unitsById.uC;
});

test("D3: a duplicate, a stale expected serial, a serial-less and a retired unit are refused with 409 and change nothing", async () => {
  stubCorrectionDb();
  const dup = await correction("admin", { expectedSerialNo: "OLD-1", serialNo: "sn-b1", reason: "typo at entry" });
  assert.equal(dup.status, 409); assert.match(dup.body.error, /already registered: SN-B1/);
  const stale = await correction("admin", { expectedSerialNo: "WRONG-0", serialNo: "NEW-1", reason: "typo at entry" });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed meanwhile/);
  unitsById.uC.serialNo = null;
  assert.equal((await correction("admin", { expectedSerialNo: "OLD-1", serialNo: "NEW-1", reason: "typo at entry" })).status, 409, "serial-less unit");
  unitsById.uC.serialNo = "OLD-1"; unitsById.uC.status = RECD_UNIT_STATUS.RETIRED;
  assert.equal((await correction("admin", { expectedSerialNo: "OLD-1", serialNo: "NEW-1", reason: "typo at entry" })).status, 409, "retired unit");
  assert.equal((await call("admin", "PATCH", "/recd-units/nope/serial", { expectedSerialNo: "OLD-1", serialNo: "NEW-1", reason: "typo at entry" })).status, 404);
  assert.equal(called("recdUnit.updateMany").length, 0);
  assert.equal(called("recdUnitSerialHistory.create").length, 0);
  delete unitsById.uC;
});

test("D3: an authorised correction is conditional on the current serial and records previous, new, reason and actor", async () => {
  stubCorrectionDb();
  const r = await correction("admin", { expectedSerialNo: "old-1", serialNo: " new-1 ", reason: " Typed the wrong digit at order entry " });
  assert.equal(r.status, 200);
  const [arg] = called("recdUnit.updateMany")[0];
  assert.deepEqual(arg.where, { id: "uC", serialNo: "OLD-1", status: "active" });
  assert.deepEqual(arg.data, { serialNo: "NEW-1" });
  assert.deepEqual(called("recdUnitSerialHistory.create")[0][0].data, { unitId: "uC", previousSerialNo: "OLD-1", newSerialNo: "NEW-1", reason: "Typed the wrong digit at order entry", actorId: "admin" });
  delete unitsById.uC;
});

test("D3: when the conditional write matches nothing (a concurrent correction won) the result is 409 and no history row is written", async () => {
  stubCorrectionDb({ updateCount: 0 });
  const r = await correction("admin", { expectedSerialNo: "OLD-1", serialNo: "NEW-1", reason: "typo at entry" });
  assert.equal(r.status, 409);
  assert.equal(called("recdUnitSerialHistory.create").length, 0);
  delete unitsById.uC;
});

type History = { complaint?: number; report?: number; reminder?: number; visit?: number; amc?: number; warranty?: number; correction?: number };
function stubLineItemDelete(history: History, txError?: unknown) {
  reset();
  stubModel("orderLineItem", {
    findUnique: () => ({ id: "li1", orderId: "oA" }),
    delete: () => { if (txError) throw txError; return {}; },
  });
  stubModel("amcOrderUnit", { count: () => history.amc ?? 0 });
  stubModel("warrantyHistory", { count: () => history.warranty ?? 0 });
  stubModel("complaint", { count: () => history.complaint ?? 0, findMany: () => [], findFirst: () => null });
  stubModel("serviceReport", { count: () => history.report ?? 0, findMany: () => [] });
  stubModel("serviceReminder", { count: () => history.reminder ?? 0 });
  stubModel("amcVisit", { count: () => history.visit ?? 0 });
  stubModel("recdUnitSerialHistory", { count: () => history.correction ?? 0 });
  stubModel("recdUnit", { deleteMany: () => ({ count: 1 }) });
}

test("D2: removing an order line item is refused (409, nothing deleted) while its unit has tickets, reports, reminders, visits or a correction history", async () => {
  const cases: [string, History, RegExp][] = [
    ["ticket", { complaint: 1 }, /1 service ticket/], ["service report", { report: 2 }, /2 service report/], ["reminder", { reminder: 1 }, /service reminder/],
    ["AMC visit", { visit: 1 }, /AMC visit/], ["serial correction", { correction: 1 }, /correction history/],
  ];
  for (const [name, history, text] of cases) {
    stubLineItemDelete(history);
    const r = await call("admin", "DELETE", "/orders/oA/line-items/li1");
    assert.equal(r.status, 409, name);
    assert.match(r.body.error, text, name);
    assert.match(r.body.error, /kept as service history/, name);
    assert.equal(called("recdUnit.deleteMany").length, 0, `${name}: the unit is not deleted`);
    assert.equal(called("orderLineItem.delete").length, 0, `${name}: the line item is not deleted`);
  }
});

test("D2: AMC and warranty protection keep their existing refusal, and a unit without history can still be removed", async () => {
  stubLineItemDelete({ amc: 1 });
  const amc = await call("admin", "DELETE", "/orders/oA/line-items/li1");
  assert.equal(amc.status, 409); assert.match(amc.body.error, /covered by an AMC order/);
  stubLineItemDelete({ warranty: 1 });
  const w = await call("admin", "DELETE", "/orders/oA/line-items/li1");
  assert.equal(w.status, 409); assert.match(w.body.error, /warranty history/);
  stubLineItemDelete({});
  const ok = await call("admin", "DELETE", "/orders/oA/line-items/li1");
  assert.equal(ok.status, 204);
  assert.equal(called("recdUnit.deleteMany").length, 1);
});

test("D2: a ticket attached between the check and the delete is stopped by the database (foreign-key RESTRICT) and reported as 409", async () => {
  const fk = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "5.22.0", meta: { field_name: "Complaint_unitId_fkey" } });
  stubLineItemDelete({}, fk);
  const r = await call("admin", "DELETE", "/orders/oA/line-items/li1");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /service history/);
});
