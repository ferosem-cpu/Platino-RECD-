// Who may see which contact number on a service ticket, and that each number comes from the right record.
// Route logic only (Prisma is replaced by in-memory stubs); the same scenarios run against the real
// isolated database in test/db/mobileNumbers.db.test.ts. All numbers are synthetic.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { buildTicketContactInfo, contactAudience } from "../src/lib/ticketContacts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Stub = Record<string, (...args: any[]) => any>;
const db: Record<string, Stub> = {};
const calls: Record<string, any[][]> = {};
function stubModel(model: string, impl: Stub) {
  db[model] = Object.fromEntries(
    Object.entries(impl).map(([name, fn]) => [name, (...args: any[]) => { (calls[`${model}.${name}`] ??= []).push(args); return fn(...args); }]),
  );
}
const called = (key: string) => calls[key] ?? [];
const P = PERMISSION_KEY;

// =============================================================================================
// Who gets contact numbers at all
// =============================================================================================

test("contact audience follows the role's existing complaint permissions", () => {
  const set = (...p: string[]) => new Set(p);
  assert.equal(contactAudience({ customerId: "cA", permissions: set(P.RAISE_COMPLAINT, P.MANAGE_COMPLAINTS) }), "none", "customers never get other people's numbers");
  assert.equal(contactAudience({ permissions: set(P.MANAGE_COMPLAINTS) }), "desk");
  assert.equal(contactAudience({ permissions: set(P.VIEW_COMPLAINTS_OVERVIEW) }), "desk");
  assert.equal(contactAudience({ permissions: set(P.ACT_ASSIGNED_COMPLAINTS) }), "field");
  assert.equal(contactAudience({ permissions: set(P.VIEW_SITE_STATUS, P.MANAGE_ORDERS) }), "none", "sales");
  assert.equal(contactAudience({ permissions: set() }), "none");
});

// =============================================================================================
// Where each number comes from (pure)
// =============================================================================================

const SITE = {
  sitePocName: "Ravi (site POC)",
  sitePocNumber: "9000000001",
  contacts: [
    { id: "sc1", name: "Security desk", role: "Security head", phone: "9000000002" },
    { id: "sc2", name: "Facility manager", role: null, phone: null },
  ],
};
const CUSTOMER = { name: "Asha (customer)", phone: "9000000003" };

test("a public ticket shows the verified reporter, kept separate from the site and customer contacts", () => {
  const info = buildTicketContactInfo(
    { ticket: { source: "public", reporterName: "Mani", reporterType: "reseller", reporterPhone: "9000000004" }, site: SITE, customerContact: CUSTOMER },
    "desk",
  )!;
  assert.deepEqual(info.reporter, { name: "Mani", type: "reseller", phone: "9000000004" });
  assert.deepEqual(info.sitePoc, { name: "Ravi (site POC)", phone: "9000000001" });
  assert.deepEqual(info.customerContact, { name: "Asha (customer)", phone: "9000000003" });
  const phones = [info.reporter?.phone, info.sitePoc?.phone, info.customerContact?.phone, ...info.siteContacts.map((c) => c.phone)];
  assert.equal(new Set(phones.filter(Boolean)).size, 4, "four different people, four different numbers - nothing substituted");
});

test("a portal ticket has no reporter - the reporter slot is never filled from the customer", () => {
  const info = buildTicketContactInfo({ ticket: { source: "portal", reporterName: null, reporterPhone: null }, site: SITE, customerContact: CUSTOMER }, "desk")!;
  assert.equal(info.reporter, null);
  assert.equal(info.customerContact?.name, "Asha (customer)");
});

test("missing numbers stay null (the screen says 'No mobile number on file') - no other number is borrowed", () => {
  const info = buildTicketContactInfo(
    {
      ticket: { source: "public", reporterName: "Mani", reporterType: "other", reporterPhone: "   " },
      site: { sitePocName: "Ravi", sitePocNumber: null, contacts: [{ id: "sc", name: "Desk", role: null, phone: "" }] },
      customerContact: { name: "Asha", phone: null },
    },
    "desk",
  )!;
  assert.equal(info.reporter?.phone, null);
  assert.deepEqual(info.sitePoc, { name: "Ravi", phone: null });
  assert.equal(info.siteContacts[0].phone, null);
  assert.equal(info.customerContact?.phone, null);

  const noPoc = buildTicketContactInfo({ ticket: { source: "portal" }, site: { sitePocName: null, sitePocNumber: null, contacts: [] }, customerContact: null }, "desk")!;
  assert.deepEqual(noPoc.sitePoc, { name: null, phone: null });
  assert.deepEqual(noPoc.siteContacts, []);
  assert.equal(noPoc.customerContact, null);
  assert.equal(buildTicketContactInfo({ ticket: { source: "portal" }, site: null, customerContact: null }, "desk")!.sitePoc, null, "a ticket without a site has no site POC");
});

test("field roles get the site people but not the customer company's contact; 'none' gets nothing", () => {
  const src = { ticket: { source: "portal" }, site: SITE, customerContact: CUSTOMER };
  const field = buildTicketContactInfo(src, "field")!;
  assert.equal(field.customerContact, null);
  assert.equal(field.sitePoc?.phone, "9000000001");
  assert.equal(field.siteContacts.length, 2);
  assert.equal(buildTicketContactInfo(src, "none"), undefined);
});

// =============================================================================================
// GET /complaints (route level)
// =============================================================================================

const users: Record<string, { id: string; role: string; perms: string[]; customerId?: string }> = {
  desk: { id: "desk", role: ROLE_KEY.SERVICE_MANAGER, perms: [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  engineer: { id: "engineer", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS] },
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT, P.VIEW_SITE_STATUS], customerId: "cA" },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS, P.VIEW_SITE_STATUS] },
};

/** Two tickets for two different customers/sites; the ids on each must never cross over. */
const ticketA = {
  id: "tA", ticketNumber: "TCK-A", customerId: "cA", siteId: "sA", source: "public", reporterName: "Mani", reporterType: "reseller", reporterPhone: "9000000004",
  status: "open", assignedToId: "engineer",
  site: { id: "sA", sitePocName: "Ravi A", sitePocNumber: "9000000001", order: { customer: { id: "cA", name: "Customer A" } },
    contacts: [{ id: "a1", name: "Desk A", role: "Security", phone: "9000000002" }] },
  assignedTo: null, unit: null,
};
const ticketB = {
  id: "tB", ticketNumber: "TCK-B", customerId: "cB", siteId: "sB", source: "portal", reporterName: null, reporterType: null, reporterPhone: null,
  status: "open", assignedToId: null,
  site: { id: "sB", sitePocName: "Priya B", sitePocNumber: null, order: { customer: { id: "cB", name: "Customer B" } },
    contacts: [{ id: "b1", name: "Desk B", role: null, phone: null }] },
  assignedTo: null, unit: null,
};
const primaryContacts = [
  { customerId: "cA", name: "Owner A", phone: "9000000010" },
  { customerId: "cA", name: "Second A (not primary)", phone: "9000000011" },
  { customerId: "cB", name: "Owner B", phone: "9000000020" },
];

let server: Server;
let base = "";
let tokenFor: (u: string) => string;

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { complaintsRouter } = await import("../src/routes/complaints");
  for (const model of ["user", "complaint", "regionManager"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: users[u].customerId ?? null });
  const app = express();
  app.use(express.json());
  app.use("/complaints", complaintsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

function reset(tickets: any[] = [ticketA, ticketB]) {
  for (const k of Object.keys(calls)) delete calls[k];
  stubModel("user", {
    findUnique: ({ where }: any) => {
      const u = Object.values(users).find((x) => x.id === where.id);
      if (!u) return null;
      return { id: u.id, isActive: true, customerId: u.customerId ?? null, vendorId: null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } };
    },
    findMany: () => primaryContacts,
  });
  stubModel("complaint", { findMany: () => JSON.parse(JSON.stringify(tickets)) });
  stubModel("regionManager", { findMany: () => [] });
}
async function list(as: string) {
  const res = await fetch(`${base}/complaints`, { headers: { authorization: `Bearer ${tokenFor(as)}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

test("desk roles get every ticket's OWN site contacts and OWN customer's primary (oldest) contact - never mixed", async () => {
  reset();
  const r = await list("desk");
  assert.equal(r.status, 200);
  const a = r.body.find((t: any) => t.id === "tA").contactInfo;
  const b = r.body.find((t: any) => t.id === "tB").contactInfo;

  assert.deepEqual(a.reporter, { name: "Mani", type: "reseller", phone: "9000000004" });
  assert.deepEqual(a.sitePoc, { name: "Ravi A", phone: "9000000001" });
  assert.deepEqual(a.siteContacts, [{ id: "a1", name: "Desk A", role: "Security", phone: "9000000002" }]);
  assert.deepEqual(a.customerContact, { name: "Owner A", phone: "9000000010" }, "the OLDEST contact of customer A, not the second one");

  assert.equal(b.reporter, null, "a portal ticket has no reporter");
  assert.deepEqual(b.sitePoc, { name: "Priya B", phone: null });
  assert.deepEqual(b.siteContacts, [{ id: "b1", name: "Desk B", role: null, phone: null }]);
  assert.deepEqual(b.customerContact, { name: "Owner B", phone: "9000000020" });

  const everythingA = JSON.stringify(a);
  for (const foreign of ["Priya B", "Desk B", "Owner B", "9000000020"]) assert.ok(!everythingA.includes(foreign), `A's contacts must not contain ${foreign}`);
  const everythingB = JSON.stringify(b);
  for (const foreign of ["Ravi A", "Desk A", "Owner A", "Mani", "9000000004", "9000000001"]) assert.ok(!everythingB.includes(foreign), `B's contacts must not contain ${foreign}`);
});

test("the contact data is loaded through the tickets' own relations, not through any client-supplied id", async () => {
  reset();
  const res = await fetch(`${base}/complaints?customerId=cB&siteId=sB`, { headers: { authorization: `Bearer ${tokenFor("desk")}` } });
  assert.equal(res.status, 200);
  const q = called("complaint.findMany")[0][0];
  assert.deepEqual(q.where, { archivedAt: null }, "query-string ids are ignored; only live tickets are listed");
  assert.deepEqual(q.include.site.include.contacts.orderBy, { createdAt: "asc" });
  const ids = called("user.findMany")[0][0].where.customerId.in;
  assert.deepEqual([...ids].sort(), ["cA", "cB"], "customer contacts are fetched only for the listed tickets' customers");
});

test("the raw site-contact list is not duplicated at the top level of the site object", async () => {
  reset();
  const r = await list("desk");
  for (const t of r.body) assert.equal("contacts" in t.site, false);
});

test("a field engineer gets the site people for THEIR tickets but not the customer's contact", async () => {
  reset([ticketA]);
  const r = await list("engineer");
  assert.equal(r.status, 200);
  assert.deepEqual(called("complaint.findMany")[0][0].where, { assignedToId: "engineer", archivedAt: null }, "only tickets assigned to them (unchanged rule), live ones");
  const info = r.body[0].contactInfo;
  assert.deepEqual(info.sitePoc, { name: "Ravi A", phone: "9000000001" });
  assert.equal(info.customerContact, null);
  assert.equal(called("user.findMany").length, 0, "the customer's contacts were not even loaded");
});

test("a customer gets no contact information and never sees a reseller's number on their own tickets", async () => {
  reset([ticketA]);
  const r = await list("custA");
  assert.equal(r.status, 200);
  assert.deepEqual(called("complaint.findMany")[0][0].where, { customerId: "cA", archivedAt: null }, "only their own live tickets");
  assert.equal(r.body[0].contactInfo, undefined);
  assert.equal("reporterPhone" in r.body[0], false);
  assert.ok(!r.raw.includes("9000000004"), "the reporter's number is not in the response at all");
  assert.equal(r.body[0].reporterName, "Mani", "the reporter's name and type are still shown, as before");
  assert.equal(called("user.findMany").length, 0);
  assert.equal(called("complaint.findMany")[0][0].include.site.include.contacts, undefined, "site contacts are not even loaded for customers");
});

test("roles without complaint access still cannot list tickets (or their contacts)", async () => {
  reset();
  assert.equal((await list("sales")).status, 403);
  const anon = await fetch(`${base}/complaints`);
  assert.equal(anon.status, 401);
  assert.equal(called("complaint.findMany").length, 0);
});
