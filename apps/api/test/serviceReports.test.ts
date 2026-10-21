// Digital service reports through the real router: draft -> submit -> customer signature -> signed PDF, plus who may
// do what. Prisma is replaced by in-memory models and the file storage by an in-memory provider with failure
// injection; the PDF generator and signature checks are the real ones. Database-level guarantees (foreign keys, the
// unique index, the CHECK and the immutability trigger, real atomic claims) are NOT proven here - see
// test/db/serviceReports.db.test.ts. All names and numbers are synthetic.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import PDFDocument from "pdfkit";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY as P, ROLE_KEY, SERVICE_REPORT_LIMITS } from "@recd/shared";
import { matchesCondition } from "./helpers/fakeOtpStore";
import { makePng, pngDataUrl } from "./helpers/png";
import { setReportStorageForTests, sha256Hex, type ReportStorage } from "../src/lib/reportStorage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Stub = Record<string, (...args: any[]) => any>;
const db: Record<string, Stub> = {};
function stubModel(model: string, impl: Stub) {
  db[model] = impl;
}

// ---- people, tickets -------------------------------------------------------------------------------
interface U { id: string; name: string; role: string; perms: string[]; customerId?: string; vendorId?: string }
const users: Record<string, U> = {
  mgmt: { id: "mgmt", name: "Mia Manager", role: ROLE_KEY.MANAGEMENT, perms: [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  engA: { id: "engA", name: "Ravi Engineer", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS] },
  engB: { id: "engB", name: "Other Engineer", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS] },
  vendorEng: { id: "vendorEng", name: "Vendor Engineer", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS, P.VIEW_SITE_STATUS], vendorId: "vA" },
  overview: { id: "overview", name: "Viewer", role: ROLE_KEY.SERVICE_MANAGER, perms: [P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  rm: { id: "rm", name: "Regional Manager", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW, P.VIEW_SITE_STATUS] },
  sales: { id: "sales", name: "Sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS, P.VIEW_SITE_STATUS] },
  custA: { id: "custA", name: "Asha Rao", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT, P.VIEW_SITE_STATUS], customerId: "cA" },
  custB: { id: "custB", name: "Bala Customer", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT, P.VIEW_SITE_STATUS], customerId: "cB" },
};

const tickets: Record<string, any> = {};
function resetTickets() {
  for (const k of Object.keys(tickets)) delete tickets[k];
  Object.assign(tickets, {
    // customer A's ticket: site sA (vendor vA, region r1), unit uA, assigned to engA
    t1: { id: "t1", ticketNumber: "TCK-1", status: "open", customerId: "cA", siteId: "sA", unitId: "uA", assignedToId: "engA", serviceReportUrl: "data:application/pdf;base64,AAAA", site: { id: "sA", regionId: "r1", vendorId: "vA" } },
    // customer B's ticket
    t2: { id: "t2", ticketNumber: "TCK-2", status: "open", customerId: "cB", siteId: "sB", unitId: "uB", assignedToId: "engA", site: { id: "sB", regionId: "r1", vendorId: "vB" } },
    // customer A, but a site of ANOTHER vendor, assigned to the vendor engineer
    t3: { id: "t3", ticketNumber: "TCK-3", status: "open", customerId: "cA", siteId: "sC", unitId: "uC", assignedToId: "vendorEng", site: { id: "sC", regionId: "r1", vendorId: "vB" } },
    // customer A, vendor A, assigned to the vendor engineer
    t4: { id: "t4", ticketNumber: "TCK-4", status: "open", customerId: "cA", siteId: "sA", unitId: "uA", assignedToId: "vendorEng", site: { id: "sA", regionId: "r1", vendorId: "vA" } },
    // region r2 (the regional manager only has r1)
    t5: { id: "t5", ticketNumber: "TCK-5", status: "open", customerId: "cA", siteId: "sD", unitId: null, assignedToId: null, site: { id: "sD", regionId: "r2", vendorId: null } },
    // a legacy ticket with no site or unit at all
    t6: { id: "t6", ticketNumber: "TCK-6", status: "closed", customerId: "cA", siteId: null, unitId: null, assignedToId: "engA", site: null },
  });
}

// ---- the ServiceReport table ---------------------------------------------------------------------
let rows: any[] = [];
let seq = 0;
const events: any[] = [];
const tick = () => new Promise<void>((r) => setImmediate(r));
const match = (r: any, where: any = {}) => Object.entries(where).every(([k, c]) => matchesCondition(r[k], c));
const withIncludes = (r: any) => ({ ...r, complaint: r.complaintId ? tickets[r.complaintId] : null, amcOrder: null, site: r.complaintId ? tickets[r.complaintId]?.site ?? null : null, createdBy: { id: r.createdById, name: users[r.createdById]?.name ?? "?" } });
const dbFlags = { failUpdateMany: false };
const p2002 = (target: string[]) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName: "ServiceReport", target } });

const serviceReportTable: Stub = {
  async findUnique({ where }: any) { await tick(); const r = rows.find((x) => x.id === where.id); return r ? withIncludes(r) : null; },
  async findUniqueOrThrow({ where }: any) { await tick(); const r = rows.find((x) => x.id === where.id); if (!r) throw new Error("not found"); return withIncludes(r); },
  async findFirst({ where }: any) { await tick(); const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
  async findMany({ where, orderBy }: any) {
    await tick();
    const list = rows.filter((r) => match(r, where));
    if (orderBy?.createdAt === "asc") list.sort((a, b) => a.createdAt - b.createdAt);
    return list.map(withIncludes);
  },
  async count({ where }: any) { await tick(); return rows.filter((r) => match(r, where)).length; },
  async create({ data }: any) {
    await tick();
    if (rows.some((r) => r.reportNumber === data.reportNumber)) throw p2002(["reportNumber"]);
    if (rows.some((r) => r.complaintId === data.complaintId && ["draft", "awaiting_signature"].includes(r.status))) throw p2002(["complaintId"]);
    const row = {
      id: `sr${++seq}`, kind: "ticket", amcOrderId: null, acknowledgementRequired: true, unitSerialNo: null, status: "draft", version: 1, partsUsed: null, remarks: null, contentHash: null, submittedAt: null, submittedById: null, signedAt: null,
      signedVersion: null, signerName: null, signedById: null, signatureFileId: null, pdfFileId: null, pdfSha256: null, createdAt: new Date(Date.now() + seq), ...data,
    };
    rows.push(row);
    return withIncludes(row);
  },
  async updateMany({ where, data }: any) {
    await tick();
    if (dbFlags.failUpdateMany) throw new Error("database unavailable");
    const hit = rows.filter((r) => match(r, where));
    for (const r of hit) for (const [k, v] of Object.entries<any>(data)) r[k] = v && typeof v === "object" && !(v instanceof Date) && "increment" in v ? r[k] + v.increment : v;
    return { count: hit.length };
  },
};

// ---- in-memory storage with failure injection ----------------------------------------------------
const files = new Map<string, { bytes: Buffer; contentType: string }>();
const storageFlags = { failPutNumber: 0, puts: 0, corrupt: false, getThrows: false };
let fileSeq = 0;
const memStorage: ReportStorage = {
  name: "memory",
  async put(bytes, contentType) {
    await tick();
    storageFlags.puts++;
    if (storageFlags.failPutNumber && storageFlags.puts === storageFlags.failPutNumber) throw new Error("disk full");
    const ref = `f${++fileSeq}`;
    files.set(ref, { bytes, contentType });
    return { ref, sha256: sha256Hex(bytes), size: bytes.length };
  },
  async get(ref) {
    await tick();
    if (storageFlags.getThrows) throw new Error("storage down");
    const f = files.get(ref);
    if (!f) return null;
    const bytes = storageFlags.corrupt ? Buffer.concat([f.bytes, Buffer.from("tamper")]) : f.bytes;
    return { bytes, contentType: f.contentType, sha256: sha256Hex(f.bytes) };
  },
  async delete(ref) { files.delete(ref); },
};

let server: Server;
let base = "";
let tokenFor: (u: string) => string;
const realConsole = { error: console.error, log: console.log };

before(async () => {
  console.error = () => {};
  console.log = () => {};
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { serviceReportsRouter } = await import("../src/routes/serviceReports");
  const { complaintsRouter } = await import("../src/routes/complaints");
  for (const model of ["user", "complaint", "complaintEvent", "serviceReport", "serviceReportEvent", "customer", "site", "recdUnit", "regionManager"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: users[u].customerId ?? null });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/service-reports", serviceReportsRouter);
  app.use("/complaints", complaintsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  setReportStorageForTests(undefined);
  Object.assign(console, realConsole);
});

function reset() {
  rows = [];
  events.length = 0;
  files.clear();
  seq = 0;
  fileSeq = 0;
  Object.assign(dbFlags, { failUpdateMany: false });
  Object.assign(storageFlags, { failPutNumber: 0, puts: 0, corrupt: false, getThrows: false });
  setReportStorageForTests(memStorage);
  resetTickets();
  stubModel("user", {
    findUnique: ({ where }: any) => {
      const u = users[where.id];
      if (!u) return null;
      return { id: u.id, name: u.name, isActive: true, customerId: u.customerId ?? null, vendorId: u.vendorId ?? null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } };
    },
  });
  stubModel("complaint", { findUnique: ({ where }: any) => (tickets[where.id] ? { ...tickets[where.id] } : null) });
  stubModel("complaintEvent", { create: ({ data }: any) => { events.push(data); return data; } });
  stubModel("serviceReportEvent", { create: ({ data }: any) => data });
  stubModel("serviceReport", serviceReportTable);
  stubModel("customer", { findUnique: ({ where }: any) => ({ name: where.id === "cA" ? "Acme Power Pvt Ltd" : "Beta Industries" }) });
  stubModel("site", { findUnique: ({ where }: any) => ({ companyName: `Plant ${where.id}`, address: `${where.id} Industrial Estate`, dgModel: "KG1-250", dgCapacityKva: 250 }) });
  stubModel("recdUnit", { findUnique: ({ where }: any) => ({ serialNo: `SN-${where.id}`, product: { name: "RECD", model: "RECD-250" } }) });
  stubModel("regionManager", { findMany: () => [{ regionId: "r1" }] });
}

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { json = null; }
  return { status: res.status, body: json, buf, headers: res.headers };
}

const VISIT = "2026-10-14";
const fields = (over: Record<string, unknown> = {}) => ({
  visitDate: VISIT,
  workPerformed: "Replaced the gasket and re-torqued the flange.",
  findings: "Exhaust leak at the inlet flange.",
  resolution: "Leak sealed; back-pressure within limits.",
  ...over,
});
const createDraft = (as = "mgmt", complaintId = "t1", over: Record<string, unknown> = {}) => call(as, "POST", "/service-reports", { complaintId, ...fields(over) });
async function awaiting(complaintId = "t1", as = "mgmt") {
  const c = await createDraft(as, complaintId);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const s = await call(as, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: c.body.version });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body;
}
const goodSignature = () => pngDataUrl(makePng());
const signBody = (r: any, over: Record<string, unknown> = {}) => ({ signerName: "Asha Rao", signatureImage: goodSignature(), version: r.version, confirm: true, ...over });
const sign = (as: string, r: any, over: Record<string, unknown> = {}) => call(as, "POST", `/service-reports/${r.id}/sign`, signBody(r, over));
async function signed(complaintId = "t1") {
  const r = await awaiting(complaintId);
  const s = await sign("custA", r);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body;
}
const rowOf = (id: string) => rows.find((r) => r.id === id);

// =============================================================================================
// Draft creation, validation, ticket links
// =============================================================================================

test("draft: created from the ticket - customer, site and unit are DERIVED, never taken from the request", async () => {
  reset();
  const r = await call("mgmt", "POST", "/service-reports", { complaintId: "t1", ...fields({ partsUsed: "Gasket x1", remarks: "Follow up in 30 days" }), customerId: "cB", siteId: "sB", unitId: "uB", status: "signed", signerName: "Evil" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "draft");
  assert.equal(r.body.version, 1);
  assert.equal(r.body.reportNumber, "TCK-1-R1");
  assert.equal(r.body.customerId, "cA");
  assert.equal(r.body.siteId, "sA");
  assert.equal(r.body.unitId, "uA");
  assert.equal(r.body.signerName, null);
  assert.equal(r.body.engineer.id, "mgmt");
  assert.equal(r.body.visitDate, VISIT);
  assert.equal(r.body.partsUsed, "Gasket x1");
  assert.equal(r.body.pdfAvailable, false);
  const row = rowOf(r.body.id);
  assert.deepEqual([row.customerId, row.siteId, row.unitId, row.createdById], ["cA", "sA", "uA", "mgmt"]);
  assert.equal(JSON.stringify(r.body).includes("pdfFileId"), false, "file ids are not exposed");
});

test("draft: a legacy ticket with no site or unit still gets a report; an unknown ticket is a 404", async () => {
  reset();
  const r = await createDraft("mgmt", "t6");
  assert.equal(r.status, 201);
  assert.equal(r.body.siteId, null);
  assert.equal(r.body.unitId, null);
  assert.equal((await createDraft("mgmt", "nope")).status, 404);
});

test("draft: validation - visit date required and real, not in the future; text limits; extra fields ignored", async () => {
  reset();
  assert.equal((await call("mgmt", "POST", "/service-reports", { complaintId: "t1" })).status, 400, "no visit date");
  assert.equal((await call("mgmt", "POST", "/service-reports", fields())).status, 400, "no ticket");
  for (const bad of ["14-10-2026", "2026-13-40", "2026-02-30", "yesterday", "", "2999-01-01"]) {
    assert.equal((await createDraft("mgmt", "t1", { visitDate: bad })).status, 400, `visitDate ${bad}`);
  }
  assert.equal((await createDraft("mgmt", "t1", { workPerformed: "x".repeat(SERVICE_REPORT_LIMITS.TEXT_MAX + 1) })).status, 400);
  assert.equal(rows.length, 0, "nothing saved by the rejected requests");
  const minimal = await call("mgmt", "POST", "/service-reports", { complaintId: "t1", visitDate: VISIT });
  assert.equal(minimal.status, 201, "only the visit date is needed to start a draft");
});

test("draft: who may create - the assigned engineer, management and an in-scope regional manager; nobody else", async () => {
  const allowed: Array<[string, string]> = [["mgmt", "t1"], ["engA", "t1"], ["rm", "t1"], ["vendorEng", "t4"]];
  for (const [who, ticket] of allowed) {
    reset();
    assert.equal((await createDraft(who, ticket)).status, 201, `${who} on ${ticket}`);
  }
  const refused: Array<[string, string]> = [
    ["engB", "t1"], // not assigned
    ["vendorEng", "t3"], // assigned, but the site belongs to another vendor
    ["rm", "t5"], // other region
    ["overview", "t1"], // read-only role
    ["sales", "t1"],
    ["custA", "t1"], // the customer never writes
    ["custB", "t1"],
  ];
  for (const [who, ticket] of refused) {
    reset();
    const r = await createDraft(who, ticket);
    assert.equal(r.status, 403, `${who} on ${ticket}`);
    assert.equal(rows.length, 0);
  }
  reset();
  assert.equal((await createDraft(null as any)).status, 401);
});

test("draft: one report in progress per ticket; a signed report does not block the next visit", async () => {
  reset();
  const first = await createDraft();
  const second = await createDraft();
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "REPORT_IN_PROGRESS");
  assert.equal(second.body.reportId, first.body.id);
  assert.equal(rows.length, 1);

  reset();
  const s = await signed();
  assert.equal(s.status, "signed");
  const next = await createDraft();
  assert.equal(next.status, 201);
  assert.equal(next.body.reportNumber, "TCK-1-R2", "a second visit is a second report on the same ticket");
});

// =============================================================================================
// Edit / submit / reopen state machine
// =============================================================================================

test("edit: a draft can be edited (version moves on); a stale edit, a non-draft and an unauthorised editor are refused", async () => {
  reset();
  const d = await createDraft();
  const ok = await call("engA", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "Updated findings", remarks: "" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.version, 2);
  assert.equal(ok.body.findings, "Updated findings");
  assert.equal(ok.body.remarks, null);
  const stale = await call("mgmt", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 1, findings: "Overwrite" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_VERSION");
  assert.equal(rowOf(d.body.id).findings, "Updated findings", "the stale edit overwrote nothing");
  assert.equal((await call("engB", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 2, findings: "x" })).status, 403);
  assert.equal((await call("custA", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 2, findings: "x" })).status, 404, "customers cannot even see a draft");
  assert.equal((await call("mgmt", "PATCH", `/service-reports/${d.body.id}`, { findings: "no version" })).status, 400);
  assert.equal((await call("mgmt", "PATCH", `/service-reports/${d.body.id}`, { expectedVersion: 2, visitDate: "2999-01-01" })).status, 400);
});

test("submit: incomplete reports are refused with the list of missing sections; a complete one awaits signature", async () => {
  reset();
  const d = await call("mgmt", "POST", "/service-reports", { complaintId: "t1", visitDate: VISIT, workPerformed: "ok done" });
  const refused = await call("mgmt", "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 1 });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.missing, ["Findings", "Resolution"]);
  assert.equal(rowOf(d.body.id).status, "draft");

  reset();
  const r = await awaiting();
  assert.equal(r.status, "awaiting_signature");
  assert.ok(r.submittedAt);
  assert.match(rowOf(r.id).contentHash, /^[0-9a-f]{64}$/);
  assert.equal(rowOf(r.id).submittedById, "mgmt");
  const again = await call("mgmt", "POST", `/service-reports/${r.id}/submit`, { expectedVersion: r.version });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "BAD_TRANSITION");
});

test("submit/reopen: stale versions and unauthorised users are refused; reopening bumps the version and clears the fingerprint", async () => {
  reset();
  const d = await createDraft();
  assert.equal((await call("mgmt", "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 5 })).status, 409);
  assert.equal((await call("engB", "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 1 })).status, 403);
  assert.equal((await call("custA", "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 1 })).status, 404);
  const sub = await call("engA", "POST", `/service-reports/${d.body.id}/submit`, { expectedVersion: 1 });
  assert.equal(sub.status, 200);
  assert.equal((await call("custA", "POST", `/service-reports/${d.body.id}/reopen`, { expectedVersion: 1 })).status, 403, "the customer cannot pull a report back");
  const re = await call("engA", "POST", `/service-reports/${d.body.id}/reopen`, { expectedVersion: 1 });
  assert.equal(re.status, 200);
  assert.equal(re.body.status, "draft");
  assert.equal(re.body.version, 2);
  assert.equal(rowOf(d.body.id).contentHash, null);
  assert.equal((await call("engA", "POST", `/service-reports/${d.body.id}/reopen`, { expectedVersion: 2 })).status, 409, "a draft cannot be reopened");
});

test("a signed report is final: no edit, no reopen, no second submit - and the stored files do not change", async () => {
  reset();
  const s = await signed();
  const before = JSON.stringify(rowOf(s.id));
  const pdfBefore = (await call("mgmt", "GET", `/service-reports/${s.id}/pdf`)).buf;
  assert.equal((await call("mgmt", "PATCH", `/service-reports/${s.id}`, { expectedVersion: s.version, findings: "Rewrite history" })).status, 409);
  assert.equal((await call("mgmt", "POST", `/service-reports/${s.id}/reopen`, { expectedVersion: s.version })).status, 409);
  assert.equal((await call("mgmt", "POST", `/service-reports/${s.id}/submit`, { expectedVersion: s.version })).status, 409);
  assert.equal(JSON.stringify(rowOf(s.id)), before, "the row is untouched");
  assert.ok((await call("mgmt", "GET", `/service-reports/${s.id}/pdf`)).buf.equals(pdfBefore), "the PDF is byte-for-byte the same");
  // a later report on the same ticket (another visit) does not touch the signed one
  const next = await createDraft();
  assert.equal(next.status, 201);
  assert.ok((await call("mgmt", "GET", `/service-reports/${s.id}/pdf`)).buf.equals(pdfBefore));
});

// =============================================================================================
// Customer signature
// =============================================================================================

test("sign: the authenticated customer signs - signer, time, version, signature file and PDF are recorded against THIS report", async () => {
  reset();
  const r = await awaiting();
  const before = Date.now();
  const s = await sign("custA", r, { signerName: "  Asha Rao  " });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, "signed");
  assert.equal(s.body.signerName, "Asha Rao");
  assert.equal(s.body.signedVersion, 1);
  assert.equal(s.body.pdfAvailable, true);
  assert.ok(new Date(s.body.signedAt).getTime() >= before - 1000);

  const row = rowOf(r.id);
  assert.equal(row.signedById, "custA", "bound to the logged-in user, not to anything typed");
  assert.ok(row.signatureFileId && row.pdfFileId && row.pdfSha256);
  assert.equal(files.size, 2);
  assert.equal(files.get(row.signatureFileId)!.contentType, "image/png");
  assert.equal(files.get(row.pdfFileId)!.contentType, "application/pdf");
  assert.equal(sha256Hex(files.get(row.pdfFileId)!.bytes), row.pdfSha256);
  assert.ok(files.get(row.signatureFileId)!.bytes.equals(Buffer.from(goodSignature().split(",")[1], "base64")), "the stored signature is the one that was drawn");
  assert.equal(JSON.stringify(s.body).includes("signatureImage"), false);
});

test("sign: audit trail - created, submitted and signed are recorded on the ticket with who did it", async () => {
  reset();
  await signed();
  assert.deepEqual(events.map((e) => [e.type, e.actorId, e.toValue]), [
    ["service_report_created", "mgmt", "draft"],
    ["service_report_submitted", "mgmt", "awaiting_signature"],
    ["service_report_signed", "custA", "signed"],
  ]);
  assert.ok(events.every((e) => e.complaintId === "t1" && e.detail.reportNumber === "TCK-1-R1"));
  assert.equal(events[2].detail.version, 1);
});

test("sign: a missing, empty, malformed or oversized signature, a missing confirmation or a typed name alone are rejected; nothing is stored", async () => {
  reset();
  const r = await awaiting();
  const bad: Array<[string, Record<string, unknown>]> = [
    ["no signature", { signatureImage: undefined }],
    ["typed name instead of an image", { signatureImage: "Asha Rao" }],
    ["empty canvas", { signatureImage: pngDataUrl(makePng({ ink: false })) }],
    ["not a PNG", { signatureImage: `data:image/png;base64,${Buffer.from("this is definitely not a png image file").toString("base64")}` }],
    ["wrong media type", { signatureImage: goodSignature().replace("image/png", "image/jpeg") }],
    ["oversized", { signatureImage: `data:image/png;base64,${Buffer.alloc(SERVICE_REPORT_LIMITS.SIGNATURE_MAX_BYTES + 5000, 1).toString("base64")}` }],
    ["no confirmation", { confirm: undefined }],
    ["confirmation false", { confirm: false }],
    ["name missing", { signerName: undefined }],
    ["name too short", { signerName: "A" }],
    ["name too long", { signerName: "N".repeat(SERVICE_REPORT_LIMITS.SIGNER_NAME_MAX + 1) }],
    ["no version", { version: undefined }],
  ];
  for (const [label, over] of bad) {
    const res = await sign("custA", r, over);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.token, undefined);
  }
  assert.equal(rowOf(r.id).status, "awaiting_signature", "still awaiting");
  assert.equal(files.size, 0, "no files stored for rejected attempts");
  assert.equal(events.filter((e) => e.type === "service_report_signed").length, 0);
});

test("sign: only the report's own customer can sign - not another customer, staff, an unsubmitted report or an anonymous caller", async () => {
  reset();
  const r = await awaiting();
  assert.equal((await sign("custB", r)).status, 404, "another customer cannot even tell it exists");
  for (const who of ["mgmt", "engA", "overview", "sales", "rm"]) assert.equal((await sign(who, r)).status, 403, who);
  assert.equal((await call(null, "POST", `/service-reports/${r.id}/sign`, signBody(r))).status, 401);
  assert.equal(rowOf(r.id).status, "awaiting_signature");
  assert.equal(files.size, 0);

  reset();
  const draft = await createDraft();
  assert.equal((await sign("custA", draft.body)).status, 404, "a draft is not signable (and not visible)");
  assert.equal((await call("custA", "POST", "/service-reports/nope/sign", signBody({ version: 1 }))).status, 404);
});

test("sign: a swapped report id, ticket id or customer id in the request cannot attach the signature elsewhere", async () => {
  reset();
  const a = await awaiting("t1");
  const bReport = await awaiting("t2", "mgmt");
  // customer A tries to sign customer B's report, and to smuggle ids in the body
  const attempt = await call("custA", "POST", `/service-reports/${bReport.id}/sign`, { ...signBody(bReport), customerId: "cA", complaintId: "t1", reportId: a.id });
  assert.equal(attempt.status, 404);
  const own = await call("custA", "POST", `/service-reports/${a.id}/sign`, { ...signBody(a), customerId: "cB", complaintId: "t2", reportId: bReport.id });
  assert.equal(own.status, 200);
  assert.equal(rowOf(a.id).status, "signed");
  assert.equal(rowOf(bReport.id).status, "awaiting_signature", "the other report is untouched");
  assert.equal(rowOf(a.id).customerId, "cA");
});

test("sign: the version the customer reviewed is what gets signed - an edited (reopened) report cannot be signed on the old view", async () => {
  reset();
  const r = await awaiting();
  await call("mgmt", "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: r.version });
  const stale = await sign("custA", r); // customer still holds version 1
  assert.equal(stale.status, 404, "it is a draft again");
  await call("mgmt", "PATCH", `/service-reports/${r.id}`, { expectedVersion: 2, resolution: "Revised resolution text" });
  const v3 = await call("mgmt", "POST", `/service-reports/${r.id}/submit`, { expectedVersion: 3 });
  assert.equal(v3.status, 200);
  const old = await sign("custA", r);
  assert.equal(old.status, 409);
  assert.equal(old.body.code, "STALE_VERSION");
  const fresh = await sign("custA", v3.body);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.signedVersion, v3.body.version);
});

test("sign: if the stored content no longer matches what was submitted, signing is refused", async () => {
  reset();
  const r = await awaiting();
  rowOf(r.id).workPerformed = "Quietly changed after submission";
  const res = await sign("custA", r);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "REPORT_NOT_SIGNABLE");
  assert.equal(files.size, 0);
});

test("sign: a second signature on an already-signed report is refused and changes nothing", async () => {
  reset();
  const s = await signed();
  const snapshot = JSON.stringify(rowOf(s.id));
  const filesBefore = files.size;
  const again = await sign("custA", s, { signerName: "Someone Else", signatureImage: pngDataUrl(makePng({ width: 200, height: 100 })) });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "ALREADY_SIGNED");
  assert.equal(JSON.stringify(rowOf(s.id)), snapshot);
  assert.equal(files.size, filesBefore);
  assert.equal(events.filter((e) => e.type === "service_report_signed").length, 1);
});

test("sign: simultaneous signing produces exactly one signed report and leaves no surplus files", async () => {
  reset();
  const r = await awaiting();
  const results = await Promise.all(Array.from({ length: 5 }, () => sign("custA", r)));
  assert.equal(results.filter((x) => x.status === 200).length, 1);
  assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 409), results.map((x) => x.status).join());
  assert.equal(files.size, 2, "the losers removed the files they had stored");
  assert.equal(events.filter((e) => e.type === "service_report_signed").length, 1);
  const row = rowOf(r.id);
  assert.ok(files.has(row.signatureFileId) && files.has(row.pdfFileId), "the winning row points at files that exist");
});

// =============================================================================================
// Failures
// =============================================================================================

test("failed PDF generation: 500, nothing stored, the report stays awaiting signature and can be signed after a retry", async () => {
  reset();
  const r = await awaiting();
  const spy = mock.method(PDFDocument.prototype, "image", () => { throw new Error("boom"); });
  try {
    const res = await sign("custA", r);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, "PDF_GENERATION_FAILED");
    assert.match(res.body.error, /Nothing was saved/);
  } finally {
    spy.mock.restore();
  }
  assert.equal(rowOf(r.id).status, "awaiting_signature");
  assert.equal(files.size, 0);
  assert.equal((await sign("custA", r)).status, 200, "a retry works");
});

test("failed file storage: 502, no half-signed record and no orphaned file, whichever write fails", async () => {
  for (const failAt of [1, 2]) {
    reset();
    const r = await awaiting();
    storageFlags.failPutNumber = failAt;
    const res = await sign("custA", r);
    assert.equal(res.status, 502, `put #${failAt} fails`);
    assert.equal(res.body.code, "STORAGE_FAILED");
    assert.equal(rowOf(r.id).status, "awaiting_signature");
    assert.equal(rowOf(r.id).pdfFileId, null);
    assert.equal(rowOf(r.id).signedAt, null);
    assert.equal(files.size, 0, "the first file was removed again");
    storageFlags.failPutNumber = 0;
    storageFlags.puts = 0;
    assert.equal((await sign("custA", r)).status, 200, "retry succeeds");
  }
});

test("failed database update at the last step: the stored files are removed again and the error is not hidden", async () => {
  reset();
  const r = await awaiting();
  dbFlags.failUpdateMany = true;
  const res = await sign("custA", r);
  assert.equal(res.status, 500);
  assert.equal(files.size, 0);
  assert.equal(rowOf(r.id).status, "awaiting_signature");
});

test("storage not configured: signing and downloading answer 503 instead of pretending", async () => {
  reset();
  const r = await awaiting();
  setReportStorageForTests(null);
  const res = await sign("custA", r);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "STORAGE_NOT_CONFIGURED");
  assert.equal(rowOf(r.id).status, "awaiting_signature");
  setReportStorageForTests(memStorage);
  const s = await sign("custA", r);
  assert.equal(s.status, 200);
  setReportStorageForTests(null);
  assert.equal((await call("mgmt", "GET", `/service-reports/${r.id}/pdf`)).status, 503);
});

// =============================================================================================
// Viewing and downloading
// =============================================================================================

test("download: the signed PDF has the right headers, is a real PDF and contains the signer and the report data", async () => {
  reset();
  const s = await signed();
  const res = await call("custA", "GET", `/service-reports/${s.id}/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="service-report-TCK-1-R1.pdf"');
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(res.buf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(sha256Hex(res.buf), rowOf(s.id).pdfSha256, "exactly the bytes that were stored and hashed");
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(res.buf) });
  const text = (await parser.getText()).text;
  await parser.destroy();
  for (const expected of ["TCK-1-R1", "Acme Power Pvt Ltd", "Plant sA", "SN-uA", "Mia Manager", "Signed by: Asha Rao", "Replaced the gasket", "SIGNED - FINAL"]) {
    assert.ok(text.includes(expected), `PDF should contain ${expected}`);
  }
  assert.equal((res.buf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length >= 1, true, "the signature image is in the document");
  const inline = await call("custA", "GET", `/service-reports/${s.id}/pdf?disposition=inline`);
  assert.match(inline.headers.get("content-disposition") ?? "", /^inline;/);
  const sig = await call("custA", "GET", `/service-reports/${s.id}/signature`);
  assert.equal(sig.headers.get("content-type"), "image/png");
  assert.ok(sig.buf.equals(files.get(rowOf(s.id).signatureFileId)!.bytes));
});

test("download: who may fetch it - the ticket's staff and the owning customer; nobody else", async () => {
  reset();
  const s = await signed();
  for (const who of ["mgmt", "engA", "overview", "rm", "custA"]) assert.equal((await call(who, "GET", `/service-reports/${s.id}/pdf`)).status, 200, who);
  assert.equal((await call("custB", "GET", `/service-reports/${s.id}/pdf`)).status, 404, "another customer");
  assert.equal((await call("custB", "GET", `/service-reports/${s.id}/signature`)).status, 404);
  for (const who of ["engB", "sales", "vendorEng"]) assert.equal((await call(who, "GET", `/service-reports/${s.id}/pdf`)).status, 403, who);
  assert.equal((await call(null, "GET", `/service-reports/${s.id}/pdf`)).status, 401);
  assert.equal((await call("mgmt", "GET", "/service-reports/nope/pdf")).status, 404);
});

test("download: a vendor engineer only reaches reports of their own vendor's sites (and only for tickets they handle)", async () => {
  reset();
  const own = await signed("t4");
  assert.equal((await call("vendorEng", "GET", `/service-reports/${own.id}/pdf`)).status, 200);
  const other = await awaiting("t3", "mgmt");
  assert.equal((await call("vendorEng", "GET", `/service-reports/${other.id}`)).status, 403, "assigned to them, but another vendor's site");
});

test("download: not before signing; a missing or tampered file and a storage outage are handled without a crash", async () => {
  reset();
  const r = await awaiting();
  const early = await call("custA", "GET", `/service-reports/${r.id}/pdf`);
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "NOT_SIGNED");
  const s = await sign("custA", r);
  assert.equal(s.status, 200);

  storageFlags.corrupt = true;
  const bad = await call("custA", "GET", `/service-reports/${r.id}/pdf`);
  assert.equal(bad.status, 500);
  assert.equal(bad.body.code, "FILE_INTEGRITY");
  storageFlags.corrupt = false;

  storageFlags.getThrows = true;
  const down = await call("custA", "GET", `/service-reports/${r.id}/pdf`);
  assert.equal(down.status, 502);
  storageFlags.getThrows = false;

  files.delete(rowOf(r.id).pdfFileId);
  const gone = await call("custA", "GET", `/service-reports/${r.id}/pdf`);
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, "FILE_MISSING");
});

test("signed reports stay available after the ticket is closed", async () => {
  reset();
  const s = await signed();
  tickets.t1.status = "closed";
  assert.equal((await call("custA", "GET", `/service-reports/${s.id}/pdf`)).status, 200);
  assert.equal((await call("mgmt", "GET", `/service-reports/${s.id}`)).status, 200);
});

test("read: customers see reports that have left draft; staff see all; other customers see none", async () => {
  reset();
  const draft = await createDraft("mgmt", "t1");
  const asCustomer = await call("custA", "GET", "/service-reports?complaintId=t1");
  assert.equal(asCustomer.status, 200);
  assert.deepEqual(asCustomer.body.reports, [], "a draft is staff-only");
  assert.equal(asCustomer.body.canWrite, false);
  assert.equal((await call("custA", "GET", `/service-reports/${draft.body.id}`)).status, 404);
  const asStaff = await call("mgmt", "GET", "/service-reports?complaintId=t1");
  assert.equal(asStaff.body.reports.length, 1);
  assert.equal(asStaff.body.canWrite, true);
  await call("mgmt", "POST", `/service-reports/${draft.body.id}/submit`, { expectedVersion: 1 });
  assert.equal((await call("custA", "GET", "/service-reports?complaintId=t1")).body.reports.length, 1);
  const detail = await call("custA", "GET", `/service-reports/${draft.body.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.permissions, { canEdit: false, canSubmit: false, canReopen: false, canSign: true });
  assert.equal(detail.body.customerName, "Acme Power Pvt Ltd");
  assert.equal(detail.body.unit.serialNo, "SN-uA");
  assert.equal((await call("custB", "GET", "/service-reports?complaintId=t1")).status, 404, "another customer's ticket");
  assert.equal((await call("custB", "GET", `/service-reports/${draft.body.id}`)).status, 404);
  assert.equal((await call("sales", "GET", "/service-reports?complaintId=t1")).status, 403);
  assert.equal((await call("mgmt", "GET", "/service-reports")).status, 400);
  const staffDetail = await call("mgmt", "GET", `/service-reports/${draft.body.id}`);
  assert.deepEqual(staffDetail.body.permissions, { canEdit: false, canSubmit: false, canReopen: true, canSign: false });
});

// =============================================================================================
// Legacy attachment + ticket deletion
// =============================================================================================

test("the legacy service-report attachment on the ticket is left exactly as it was", async () => {
  reset();
  await signed();
  assert.equal(tickets.t1.serviceReportUrl, "data:application/pdf;base64,AAAA");
});

test("a ticket that has service reports cannot be archived; one without is archived, never deleted", async () => {
  reset();
  await createDraft();
  const { prisma } = await import("../src/lib/prisma");
  (prisma as any).$transaction = async (fn: any) => fn(prisma);
  let archived = false;
  const complaintStub = { findUnique: ({ where }: any) => (tickets[where.id] ? { ...tickets[where.id], archivedAt: null } : null), updateMany: () => { archived = true; return { count: 1 }; }, delete: () => { throw new Error("must not be called"); } };
  stubModel("complaint", complaintStub);
  stubModel("complaintEvent", { create: () => ({}) });
  const blocked = await call("mgmt", "DELETE", "/complaints/t1");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "HAS_SERVICE_REPORTS");
  assert.equal(archived, false);
  assert.equal((await call("mgmt", "DELETE", "/complaints/t2")).status, 204, "a ticket without reports is archived");
  assert.equal(archived, true);
});
