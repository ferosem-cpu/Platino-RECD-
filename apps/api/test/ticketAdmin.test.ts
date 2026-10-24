// Route-level tests for ticket management (Requirement 11). No database: the Prisma delegates are replaced with an in-memory store whose
// transaction undoes everything if the callback throws, and whose complaint table enforces the one-open-ticket-per-unit rule like the real
// partial unique index. The REAL routers, authentication middleware, access rules and ticket library run over HTTP. The real-database
// counterparts are in test/db/ticketAdmin.db.test.ts.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = PERMISSION_KEY;
const users: Record<string, { id: string; role: string; perms: string[]; vendorId?: string; isActive?: boolean }> = {
  svc: { id: "svc", role: ROLE_KEY.SERVICE_TEAM, perms: [P.MANAGE_COMPLAINTS] },
  rmN: { id: "rmN", role: ROLE_KEY.REGIONAL_MANAGER, perms: [P.MANAGE_COMPLAINTS, P.VIEW_COMPLAINTS_OVERVIEW] },
  eng: { id: "eng", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS] },
  engOff: { id: "engOff", role: ROLE_KEY.SERVICE_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS], isActive: false },
  v1: { id: "v1", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS], vendorId: "V1" },
  v2: { id: "v2", role: ROLE_KEY.ERECTION_ENGINEER, perms: [P.ACT_ASSIGNED_COMPLAINTS], vendorId: "V2" },
  sales: { id: "sales", role: ROLE_KEY.SALES, perms: [P.MANAGE_ORDERS] },
  custA: { id: "custA", role: ROLE_KEY.CUSTOMER, perms: [P.RAISE_COMPLAINT] },
};
const CLOSED = ["resolved", "closed"];

interface Row { id: string; ticketNumber: string; status: string; closedAt: Date | null; closedById: string | null; archivedAt: Date | null; archivedById: string | null; archiveReason: string | null; assignedToId: string | null; unitId: string | null; siteId: string | null; customerId: string; rootCause: string | null; resolutionNotes: string | null; remarks: string | null; serviceReportUrl: string | null; slaEscalationLevel: number; createdAt: Date; site: { regionId: string | null; vendorId: string | null } | null }
let tickets: Row[] = [];
let events: any[] = [];
let reports = 0;
let failEvent = false;
let nextId = 1;
let sentNotes: any[] = [];
let providerMode: "ok" | "reject" | "throw" = "ok";
let attempted: any[] = [];
let staleView: Row | null = null; // what findUnique returns for one ticket while set (simulates another request winning the race)
const txUndo = new AsyncLocalStorage<Array<() => void>>();
const onRollback = (fn: () => void) => txUndo.getStore()?.push(fn);
const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "5.22.0", meta: { modelName: "Complaint", target: ["unitId"] } });

const ticket = (over: Partial<Row> = {}): Row => {
  const id = over.id ?? `t${nextId++}`;
  const r: Row = { id, ticketNumber: `TCK-${id}`, status: "open", closedAt: null, closedById: null, archivedAt: null, archivedById: null, archiveReason: null, assignedToId: null, unitId: `u-${id}`, siteId: `s-${id}`, customerId: "cA", rootCause: null, resolutionNotes: null, remarks: null, serviceReportUrl: null, slaEscalationLevel: 0, createdAt: new Date(), site: { regionId: "north", vendorId: null }, ...over };
  tickets.push(r);
  return r;
};

let server: Server;
let base: string;
let signToken: (p: any) => string;
const tok = (id: string) => signToken({ userId: id, roleKey: users[id].role });

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  ({ signToken } = await import("../src/lib/jwt"));
  const { providersByChannel } = await import("../src/services/notifications/providers");
  const { complaintsRouter } = await import("../src/routes/complaints");

  for (const k of Object.keys(providersByChannel)) (providersByChannel as any)[k] = { channel: k, send: async (m: any) => { attempted.push({ channel: k, to: m.recipientId, template: m.templateKey }); if (providerMode === "throw") throw new Error("smtp down"); return providerMode === "ok"; } };
  const define = (model: string, impl: any) => Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  const view = (r: Row) => ({ ...r });
  define("user", {
    findUnique: ({ where }: any) => {
      const u = Object.values(users).find((x) => x.id === where.id);
      if (!u) return null;
      return { id: u.id, isActive: u.isActive ?? true, vendorId: u.vendorId ?? null, customerId: u.role === ROLE_KEY.CUSTOMER ? "cA" : null, tokenVersion: 0, role: { key: u.role, permissions: u.perms.map((k) => ({ permission: { key: k } })) } };
    },
    findFirst: () => ({ id: "contact" }),
    findMany: ({ where }: any) => Object.values(users).filter((u) => (u.isActive ?? true) && where.role.key.in.includes(u.role) && (where.vendorId !== undefined ? where.vendorId === (u.vendorId ?? null) : (where.OR ?? []).some((o: any) => o.vendorId === (u.vendorId ?? null)))).map((u) => ({ id: u.id, name: u.id, role: { name: u.role } })),
  });
  define("regionManager", { findMany: ({ where }: any) => (where.userId === "rmN" ? [{ regionId: "north" }] : []) });
  define("serviceReport", { count: async () => reports });
  define("notificationLog", { create: ({ data }: any) => { sentNotes.push(data); return { ...data, channel: data.channel, status: data.status }; } });
  define("complaintEvent", {
    create: async ({ data }: any) => { if (failEvent) throw new Error("history disk full"); const e = { id: `e${nextId++}`, ...data }; events.push(e); onRollback(() => { events = events.filter((x) => x !== e); }); return e; },
    findMany: ({ where }: any) => events.filter((e) => e.complaintId === where.complaintId).map((e) => ({ ...e, actor: null })),
  });
  define("complaint", {
    findUnique: ({ where }: any) => { const r = staleView && staleView.id === where.id ? staleView : tickets.find((x) => x.id === where.id); return r ? { ...view(r), customer: { contacts: [] } } : null; },
    findFirst: ({ where }: any) => {
      const r = tickets.find((x) => (where.unitId === undefined || x.unitId === where.unitId) && (where.siteId === undefined || x.siteId === where.siteId) && x.id !== where.id?.not && !CLOSED.includes(x.status) && (where.archivedAt !== null || x.archivedAt === null));
      return r ? view(r) : null;
    },
    findMany: ({ where }: any = {}) => tickets.filter((t) => !JSON.stringify(where ?? {}).includes('"archivedAt":null') || t.archivedAt === null).map(view),
    count: async () => tickets.length,
    updateMany: async ({ where, data }: any) => {
      const r = tickets.find((x) => x.id === where.id && (where.status === undefined || x.status === where.status) && (where.assignedToId === undefined || x.assignedToId === where.assignedToId) && (where.archivedAt === undefined ? true : where.archivedAt === null ? x.archivedAt === null : x.archivedAt !== null));
      if (!r) return { count: 0 };
      // the partial unique indexes: restoring an ACTIVE ticket next to another active one for the same unit
      if (data.archivedAt === null && !CLOSED.includes(r.status) && r.unitId && tickets.some((x) => x !== r && x.unitId === r.unitId && x.archivedAt === null && !CLOSED.includes(x.status))) throw p2002();
      if (data.status && !CLOSED.includes(data.status) && r.unitId && tickets.some((x) => x !== r && x.unitId === r.unitId && !CLOSED.includes(x.status)) && CLOSED.includes(r.status)) throw p2002();
      const prev = { ...r };
      Object.assign(r, data);
      onRollback(() => Object.assign(r, prev));
      return { count: 1 };
    },
    delete: async ({ where }: any) => { tickets = tickets.filter((x) => x.id !== where.id); }, // only used to prove the route never calls it
  });
  (prisma as any).$transaction = async (fn: any) => {
    const undo: Array<() => void> = [];
    try {
      return await txUndo.run(undo, () => fn(prisma));
    } catch (err) {
      for (const u of undo.reverse()) u();
      throw err;
    }
  };
  const app = express();
  app.use(express.json());
  app.use("/complaints", complaintsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });
beforeEach(() => { providerMode = "ok"; attempted = []; staleView = null; tickets = []; events = []; reports = 0; failEvent = false; nextId = 1; sentNotes = []; });

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tok(as)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}
const row = (id: string) => tickets.find((t) => t.id === id)!;
const types = (id: string) => events.filter((e) => e.complaintId === id).map((e) => e.type);

test("status: the nine existing values are accepted, anything else is a 400 that stores and records nothing", async () => {
  const t = ticket();
  for (const bad of ["banana", "OPEN", "closed ", "", 5, null, undefined]) assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: bad })).status, 400, JSON.stringify(bad));
  assert.equal(row(t.id).status, "open");
  assert.equal(events.length, 0);
  // walk the whole proposed workflow: every one of the nine statuses is reachable in turn
  for (const ok of ["open", "acknowledged", "assigned", "in_progress", "waiting_for_customer", "waiting_for_part", "escalated", "resolved", "closed"]) {
    assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: ok, ...(ok === "resolved" ? { resolutionNotes: "belt replaced and tested" } : {}) })).status, 200, ok);
  }
});

test("closure: set once, never overwritten by a repeat; reopening clears it; the history says which; a repeat writes and notifies nothing", async () => {
  const t = ticket({ status: "resolved", resolutionNotes: "belt replaced and tested" });
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed" });
  const first = row(t.id).closedAt!;
  assert.ok(first);
  await new Promise((r) => setTimeout(r, 15));
  sentNotes = [];
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed" })).status, 200);
  assert.equal(row(t.id).closedAt!.getTime(), first.getTime());
  assert.deepEqual(types(t.id), ["status_changed"]);
  assert.equal(sentNotes.length, 0);
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "in_progress", reopenReason: "customer reports the fault is back" });
  assert.equal(row(t.id).closedAt, null);
  assert.deepEqual(events.map((e) => e.detail?.transition), ["closed", "reopened"]);
  assert.deepEqual(events.map((e) => [e.fromValue, e.toValue]), [["resolved", "closed"], ["closed", "in_progress"]]);
});

test("reopen versus an open ticket for the same RECD: 409 OPEN_TICKET_EXISTS naming it; nothing changes and no event is kept", async () => {
  const closed = ticket({ id: "old", status: "closed", closedAt: new Date(), unitId: "U" });
  ticket({ id: "new", unitId: "U" });
  const r = await call("svc", "PATCH", `/complaints/${closed.id}`, { status: "open", reopenReason: "customer reports the fault is back" });
  assert.deepEqual([r.status, r.body.code], [409, "OPEN_TICKET_EXISTS"]);
  assert.match(r.body.error, /TCK-new/);
  assert.deepEqual([row("old").status, row("old").closedAt !== null], ["closed", true]);
  assert.equal(events.length, 0);
});

test("atomic: when the history row fails the whole change - status, closedAt, notes, assignee - is rolled back and the answer is an error", async () => {
  const t = ticket({ assignedToId: "eng", status: "resolved", resolutionNotes: "belt replaced and tested" });
  failEvent = true;
  const r = await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed", remarks: "x", assignedToId: null });
  assert.equal(r.status, 500);
  assert.deepEqual([row(t.id).status, row(t.id).closedAt, row(t.id).remarks, row(t.id).assignedToId], ["resolved", null, null, "eng"]);
  assert.equal(events.length, 0);
  failEvent = false;
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed" })).status, 200);
});

test("a stale simultaneous change is a 409 TICKET_CHANGED (the conditional update matched nothing) and records nothing", async () => {
  const t = ticket();
  staleView = { ...row(t.id) }; // the route reads 'open' ...
  row(t.id).status = "closed"; // ... while another request has already closed it
  const r = await call("svc", "PATCH", `/complaints/${t.id}`, { status: "in_progress", remarks: "x" });
  assert.deepEqual([r.status, r.body.code], [409, "TICKET_CHANGED"]);
  assert.equal(events.length, 0);
});

test("Regional Manager: write, history and delete only inside their region; a ticket without a site is outside every region", async () => {
  const north = ticket({ site: { regionId: "north", vendorId: null } });
  const south = ticket({ site: { regionId: "south", vendorId: null } });
  const none = ticket({ site: null, siteId: null });
  assert.equal((await call("rmN", "PATCH", `/complaints/${north.id}`, { status: "acknowledged" })).status, 200);
  for (const t of [south, none]) {
    assert.equal((await call("rmN", "PATCH", `/complaints/${t.id}`, { status: "acknowledged" })).status, 403);
    assert.equal((await call("rmN", "GET", `/complaints/${t.id}/history`)).status, 403);
    assert.equal((await call("rmN", "DELETE", `/complaints/${t.id}`)).status, 403);
    assert.equal(row(t.id).status, "open");
  }
  assert.equal((await call("rmN", "GET", `/complaints/${north.id}/history`)).status, 200);
  assert.equal((await call("rmN", "DELETE", `/complaints/${north.id}`)).status, 204);
  assert.ok(row(north.id).archivedAt, "archived, not deleted");
});

test("engineers: only their own assigned tickets, a vendor engineer only on their vendor's sites; they can never reassign; customers and sales reach nothing", async () => {
  const mine = ticket({ assignedToId: "eng" });
  const other = ticket({ assignedToId: "someone" });
  assert.equal((await call("eng", "PATCH", `/complaints/${mine.id}`, { status: "in_progress", assignedToId: "someone" })).status, 200);
  assert.equal(row(mine.id).assignedToId, "eng", "an engineer's assignedToId is ignored");
  assert.equal((await call("eng", "PATCH", `/complaints/${other.id}`, { status: "in_progress" })).status, 403);
  const v1Own = ticket({ assignedToId: "v1", site: { regionId: null, vendorId: "V1" } });
  const v1Foreign = ticket({ assignedToId: "v1", site: { regionId: null, vendorId: "V2" } });
  assert.equal((await call("v1", "PATCH", `/complaints/${v1Own.id}`, { status: "in_progress" })).status, 200);
  const r = await call("v1", "PATCH", `/complaints/${v1Foreign.id}`, { status: "in_progress" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /vendor's sites/);
  assert.equal((await call("v1", "GET", `/complaints/${v1Foreign.id}/history`)).status, 403);
  for (const who of ["custA", "sales"]) {
    assert.equal((await call(who, "PATCH", `/complaints/${mine.id}`, { status: "closed" })).status, 403, who);
    assert.equal((await call(who, "DELETE", `/complaints/${mine.id}`)).status, 403, who);
  }
  assert.equal((await call(null, "PATCH", `/complaints/${mine.id}`, { status: "closed" })).status, 401);
});

test("assignment: unknown / inactive / unsuitable role / cross-vendor are clear 400s; valid and unassign work; a refusal changes nothing", async () => {
  const t = ticket({ site: { regionId: "north", vendorId: "V1" } });
  const go = (assignedToId: string | null) => call("svc", "PATCH", `/complaints/${t.id}`, { status: "assigned", assignedToId });
  assert.deepEqual([(await go("ghost")).status, (await go("ghost")).body.code], [400, "ASSIGNEE_NOT_FOUND"]);
  assert.equal((await go("engOff")).body.code, "ASSIGNEE_INACTIVE");
  assert.equal((await go("sales")).body.code, "ASSIGNEE_ROLE");
  assert.equal((await go("custA")).body.code, "ASSIGNEE_ROLE");
  assert.equal((await go("v2")).body.code, "ASSIGNEE_VENDOR_SCOPE");
  assert.deepEqual([row(t.id).assignedToId, row(t.id).status], [null, "open"]);
  assert.equal(events.length, 0);
  assert.equal((await go("v1")).status, 200);
  assert.equal((await go("eng")).status, 200);
  assert.equal((await go(null)).status, 200);
  assert.deepEqual(events.filter((e) => e.type === "assigned").map((e) => [e.fromValue, e.toValue]), [[null, "v1"], ["v1", "eng"], ["eng", null]]);
});

test("notes: a changed closure field is recorded with its BEFORE and AFTER text (so nothing is silently overwritten); an identical resend is a no-op", async () => {
  const t = ticket();
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open", resolutionNotes: "replaced belt", rootCause: "worn belt" });
  assert.deepEqual(types(t.id), ["notes_updated"]);
  assert.deepEqual(events[0].detail, { fields: ["rootCause", "resolutionNotes"], values: { rootCause: { from: null, to: "worn belt" }, resolutionNotes: { from: null, to: "replaced belt" } } });
  assert.equal(events[0].actorId, "svc");
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open", resolutionNotes: "replaced belt", rootCause: "worn belt" })).status, 200);
  assert.equal(events.length, 1, "an identical resend records nothing");
  // a later correction keeps the earlier text in the history
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open", resolutionNotes: "replaced belt and tensioner" });
  assert.deepEqual(events[1].detail, { fields: ["resolutionNotes"], values: { resolutionNotes: { from: "replaced belt", to: "replaced belt and tensioner" } } });
  assert.deepEqual(events.map((e) => e.detail.values.resolutionNotes?.to), ["replaced belt", "replaced belt and tensioner"], "both versions are still in the history");
});

test("delete ARCHIVES: nothing is deleted, the archive is recorded (who, when, status, reason), a second attempt is a 409, service reports still block it", async () => {
  const t = ticket({ assignedToId: "eng" });
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "in_progress", remarks: "on site" });
  const before = events.length;
  reports = 1;
  const blocked = await call("svc", "DELETE", `/complaints/${t.id}`);
  assert.deepEqual([blocked.status, blocked.body.code], [409, "HAS_SERVICE_REPORTS"]);
  assert.equal(row(t.id).archivedAt, null);
  reports = 0;
  assert.equal((await call("svc", "DELETE", `/complaints/${t.id}`, { reason: "wrong serial" })).status, 204);
  assert.equal(tickets.length, 1, "the ticket row is still there");
  assert.equal(events.length, before + 1, "every earlier history row is kept and one is added");
  const r = row(t.id);
  assert.ok(r.archivedAt);
  assert.deepEqual([r.archivedById, r.archiveReason, r.status], ["svc", "wrong serial", "in_progress"], "status is left as it was");
  const e = events.at(-1);
  assert.deepEqual([e.type, e.actorId, e.fromValue, e.detail], ["archived", "svc", "in_progress", { statusAtArchive: "in_progress", reason: "wrong serial" }]);
  const again = await call("svc", "DELETE", `/complaints/${t.id}`);
  assert.deepEqual([again.status, again.body.code], [409, "TICKET_ARCHIVED"]);
  assert.equal(events.length, before + 1, "a refused repeat records nothing");
  assert.equal((await call("svc", "DELETE", "/complaints/nope")).status, 404);
});

test("an archived ticket cannot be changed or reassigned, but its history stays readable to those who may read it", async () => {
  const t = ticket({ assignedToId: "eng" });
  const live = ticket();
  await call("svc", "DELETE", `/complaints/${t.id}`);
  for (const who of ["svc", "eng"]) {
    const r = await call(who, "PATCH", `/complaints/${t.id}`, { status: "closed" });
    assert.deepEqual([r.status, r.body.code], [409, "TICKET_ARCHIVED"], who);
  }
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open", assignedToId: "eng" })).status, 409);
  assert.equal(row(t.id).status, "open");
  const hist = await call("svc", "GET", `/complaints/${t.id}/history`);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.events.map((e: any) => e.type), ["archived"]);
  assert.equal((await call("rmN", "GET", `/complaints/${t.id}/history`)).status, 200, "in-region manager can still read it");
  assert.equal((await call("v1", "GET", `/complaints/${t.id}/history`)).status, 403, "scope rules still apply");
  // (the list itself is covered against the real database: test/db/ticketAdmin.db.test.ts)
});

test("closure details: who closed is recorded with closedAt, kept by a repeat closure by someone else, cleared on reopening - the history keeps every closure", async () => {
  const t = ticket({ assignedToId: "eng", status: "resolved", resolutionNotes: "belt replaced and tested", site: { regionId: "north", vendorId: null } });
  assert.equal((await call("rmN", "PATCH", `/complaints/${t.id}`, { status: "closed" })).status, 200);
  assert.equal(row(t.id).closedById, "rmN");
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed", remarks: "checked" });
  assert.equal(row(t.id).closedById, "rmN", "the original closer is not overwritten");
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "in_progress", reopenReason: "customer reports the fault is back" })).status, 200);
  assert.deepEqual([row(t.id).closedAt, row(t.id).closedById], [null, null]);
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "resolved" })).status, 200, "the notes already on the ticket satisfy the resolution rule");
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed" });
  assert.equal(row(t.id).closedById, "svc", "a new closure records its own closer");
  const closures = events.filter((e) => e.type === "status_changed" && e.toValue === "closed");
  assert.deepEqual(closures.map((e) => e.actorId), ["rmN", "svc"], "both closures stay in the history with their actors");
});

test("direct API calls: customers, sales, unauthenticated users and engineers outside their scope can neither close, reopen, reassign, archive nor read history", async () => {
  const mine = ticket({ assignedToId: "eng", status: "closed", closedAt: new Date() });
  const other = ticket({ assignedToId: "someone" });
  const snapshot = () => JSON.stringify([tickets, events]);
  const before = snapshot();
  for (const who of ["custA", "sales"]) {
    for (const t of [mine, other]) {
      assert.equal((await call(who, "PATCH", `/complaints/${t.id}`, { status: "closed" })).status, 403, `${who} close`);
      assert.equal((await call(who, "PATCH", `/complaints/${t.id}`, { status: "open" })).status, 403, `${who} reopen`);
      assert.equal((await call(who, "PATCH", `/complaints/${t.id}`, { status: "open", assignedToId: "eng" })).status, 403, `${who} assign`);
      assert.equal((await call(who, "DELETE", `/complaints/${t.id}`)).status, 403, `${who} archive`);
      assert.equal((await call(who, "GET", `/complaints/${t.id}/history`)).status, 403, `${who} history`);
    }
  }
  assert.equal((await call(null, "PATCH", `/complaints/${mine.id}`, { status: "open" })).status, 401);
  assert.equal((await call(null, "DELETE", `/complaints/${mine.id}`)).status, 401);
  // an engineer: not another engineer's ticket (close / reopen / history), never archive, never reassign their own
  assert.equal((await call("eng", "PATCH", `/complaints/${other.id}`, { status: "closed" })).status, 403);
  assert.equal((await call("eng", "PATCH", `/complaints/${other.id}`, { status: "open" })).status, 403);
  assert.equal((await call("eng", "GET", `/complaints/${other.id}/history`)).status, 403);
  assert.equal((await call("eng", "DELETE", `/complaints/${mine.id}`)).status, 403);
  const ro = await call("eng", "PATCH", `/complaints/${mine.id}`, { status: "closed", assignedToId: "svc" });
  assert.deepEqual([ro.status, ro.body.code], [403, "CLOSED_TICKET_READ_ONLY"], "a closed ticket is read-only for non-managers");
  assert.equal(row(mine.id).assignedToId, "eng", "an engineer cannot hand the ticket to someone else");
  assert.equal(events.some((e) => e.type === "assigned"), false);
  assert.equal(snapshot().includes('"archivedAt":"'), false, "nothing was archived by any refused call");
  void before;
});

test("the assignee list: vendor engineers only for that ticket's vendor; none without a ticket; a Regional Manager cannot probe another region's ticket", async () => {
  const t = ticket({ site: { regionId: "north", vendorId: "V1" } });
  const south = ticket({ site: { regionId: "south", vendorId: null } });
  const ids = async (qs = "", as = "svc") => (await call(as, "GET", `/complaints/assignees${qs}`)).body.map((x: any) => x.id).sort();
  assert.deepEqual(await ids(), ["eng", "svc"], "internal (unscoped) engineers only");
  assert.deepEqual(await ids(`?ticketId=${t.id}`), ["eng", "svc", "v1"], "plus that ticket's vendor, never V2");
  assert.equal((await call("svc", "GET", "/complaints/assignees?ticketId=nope")).status, 404);
  assert.equal((await call("rmN", "GET", `/complaints/assignees?ticketId=${south.id}`)).status, 403);
  assert.equal((await call("sales", "GET", "/complaints/assignees")).status, 403);
});

test("notifications: only a REAL change notifies; a failing or refusing provider never undoes the change, and is recorded as failed, not delivered", async () => {
  const t = ticket();
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open" });
  await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open", remarks: "note only" });
  assert.equal(attempted.length, 0, "no-op and notes-only updates notify nobody");
  providerMode = "reject"; // the provider refuses the message
  sentNotes = [];
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "in_progress", assignedToId: "eng" })).status, 200);
  assert.deepEqual([row(t.id).status, row(t.id).assignedToId], ["in_progress", "eng"], "the change stands");
  assert.ok(sentNotes.length >= 2 && sentNotes.every((n) => n.status !== "sent"), "a refused message is never recorded as sent");
  assert.ok(sentNotes.some((n) => n.status === "failed"));
  providerMode = "throw"; // the provider blows up
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "waiting_for_part" })).status, 200);
  assert.equal(row(t.id).status, "waiting_for_part");
  assert.equal(attempted.filter((a) => a.template === "complaint_status_updated").length >= 1, true);
});

test("final closure is for managers: an engineer (assigned, vendor-scoped or not) can resolve but not close; a manager can close; nothing is written by a refused attempt", async () => {
  const mine = ticket({ assignedToId: "eng" });
  const vend = ticket({ assignedToId: "v1", site: { regionId: null, vendorId: "V1" } });
  for (const [who, t] of [["eng", mine], ["v1", vend]] as const) {
    const refused = await call(who, "PATCH", `/complaints/${t.id}`, { status: "closed", resolutionNotes: "done" });
    assert.deepEqual([refused.status, refused.body.code], [403, "CLOSE_REQUIRES_MANAGER"], who);
    assert.match(refused.body.error, /manager/i);
    assert.deepEqual([row(t.id).status, row(t.id).closedAt, row(t.id).closedById, row(t.id).resolutionNotes], ["open", null, null, null], "status, closure and notes untouched");
    assert.equal(events.some((e) => e.complaintId === t.id), false, "no history row");
    const resolved = await call(who, "PATCH", `/complaints/${t.id}`, { status: "resolved", resolutionNotes: "belt replaced and tested" });
    assert.equal(resolved.status, 200, `${who} resolves`);
    assert.deepEqual([row(t.id).status, row(t.id).closedAt, row(t.id).closedById], ["resolved", null, null], "resolving is not closing");
  }
  assert.equal((await call("svc", "PATCH", `/complaints/${mine.id}`, { status: "closed" })).status, 200, "a ticket manager closes the resolved ticket");
  assert.deepEqual([row(mine.id).status, row(mine.id).closedById], ["closed", "svc"]);
  assert.equal((await call("rmN", "PATCH", `/complaints/${vend.id}`, { status: "closed" })).status, 403, "scope still applies to managers: out of region / vendor");
  const northResolved = ticket({ status: "resolved", resolutionNotes: "belt replaced and tested", site: { regionId: "north", vendorId: null } });
  assert.equal((await call("rmN", "PATCH", `/complaints/${northResolved.id}`, { status: "closed" })).status, 200, "a Regional Manager closes within their region");
});

test("reopening a closed ticket is for managers: engineers (assigned or vendor-scoped) are refused with REOPEN_REQUIRES_MANAGER and NOTHING changes; managers inside their scope reopen; managers outside it are refused by the scope rule", async () => {
  const closedAt = new Date("2026-01-01T00:00:00Z");
  const mk = (over: Record<string, unknown> = {}) => ticket({ status: "closed", closedAt, closedById: "svc", resolutionNotes: "belt replaced", ...over });
  const eng = mk({ assignedToId: "eng" });
  const vend = mk({ assignedToId: "v1", site: { regionId: null, vendorId: "V1" } });
  const snapshot = (t: Row) => JSON.stringify({ ...t });
  for (const [who, t] of [["eng", eng], ["v1", vend]] as const) {
    const before = snapshot(t);
    const eventsBefore = events.length;
    for (const body of [{ status: "open" }, { status: "in_progress", remarks: "trying again" }, { status: "resolved", assignedToId: "svc" }]) {
      const r = await call(who, "PATCH", `/complaints/${t.id}`, body);
      assert.deepEqual([r.status, r.body.code], [403, "REOPEN_REQUIRES_MANAGER"], `${who} ${JSON.stringify(body)}`);
      assert.match(r.body.error, /manager/i);
    }
    assert.equal(snapshot(t), before, `${who}: status, closedAt, closedById, notes, assignee all untouched`);
    assert.equal(events.length, eventsBefore, "no history row");
    // a closed ticket is read-only for a non-manager: not even a note (nothing changes)
    const ro = await call(who, "PATCH", `/complaints/${t.id}`, { status: "closed", remarks: "late note" });
    assert.deepEqual([ro.status, ro.body.code], [403, "CLOSED_TICKET_READ_ONLY"]);
    assert.equal(snapshot(t), before);
  }
  // other people who must not reopen
  for (const who of ["custA", "sales"]) assert.equal((await call(who, "PATCH", `/complaints/${eng.id}`, { status: "open" })).status, 403, who);
  assert.equal((await call(null, "PATCH", `/complaints/${eng.id}`, { status: "open" })).status, 401);
  // a manager: scope still applies
  const north = mk({ site: { regionId: "north", vendorId: null } });
  const south = mk({ site: { regionId: "south", vendorId: null } });
  const southBefore = snapshot(south);
  const out = await call("rmN", "PATCH", `/complaints/${south.id}`, { status: "open", reopenReason: "customer reports the fault is back" });
  assert.equal(out.status, 403);
  assert.notEqual(out.body.code, "REOPEN_REQUIRES_MANAGER", "refused by the region rule, not the permission rule");
  assert.match(out.body.error, /regions assigned to you/);
  assert.equal(snapshot(south), southBefore);
  assert.equal((await call("rmN", "PATCH", `/complaints/${north.id}`, { status: "open", reopenReason: "customer reports the fault is back" })).status, 200, "a Regional Manager reopens inside their region");
  assert.deepEqual([north.status, north.closedAt, north.closedById], ["open", null, null]);
  assert.equal((await call("svc", "PATCH", `/complaints/${eng.id}`, { status: "in_progress", reopenReason: "customer reports the fault is back" })).status, 200, "the service desk reopens");
  assert.deepEqual(events.filter((e) => e.complaintId === eng.id && e.type === "status_changed").map((e) => [e.fromValue, e.toValue, e.actorId, e.detail?.transition]), [["closed", "in_progress", "svc", "reopened"]]);
  // the same engineer can still resolve an ordinary (not closed) ticket
  const live = ticket({ assignedToId: "eng", status: "in_progress" });
  assert.equal((await call("eng", "PATCH", `/complaints/${live.id}`, { status: "resolved", resolutionNotes: "belt replaced and tested" })).status, 200);
  // an out-of-vendor engineer is stopped by the scope rule first
  const v1Foreign = mk({ assignedToId: "v1", site: { regionId: null, vendorId: "V2" } });
  const rv = await call("v1", "PATCH", `/complaints/${v1Foreign.id}`, { status: "open" });
  assert.deepEqual([rv.status, rv.body.code], [403, undefined]);
});

test("notes on a CLOSED ticket: a manager in scope may add them and the ticket stays closed (closedAt / closedById untouched, before/after kept); a non-manager may not edit it at all", async () => {
  const closedAt = new Date("2026-01-01T00:00:00Z");
  const t = ticket({ status: "closed", closedAt, closedById: "svc", assignedToId: "eng", resolutionNotes: "belt replaced and tested", site: { regionId: "north", vendorId: null } });
  const south = ticket({ status: "closed", closedAt, closedById: "svc", resolutionNotes: "belt replaced and tested", site: { regionId: "south", vendorId: null } });
  for (const who of ["svc", "rmN"]) {
    const r = await call(who, "PATCH", `/complaints/${t.id}`, { status: "closed", resolutionNotes: `belt replaced and tested (${who} addendum)` });
    assert.equal(r.status, 200, who);
    assert.deepEqual([t.status, t.closedAt, t.closedById], ["closed", closedAt, "svc"], `${who}: still closed, same closer and time`);
  }
  assert.deepEqual(types(t.id), ["notes_updated", "notes_updated"], "no status_changed row: nothing was reopened");
  assert.deepEqual(events.map((e) => [e.actorId, e.detail.values.resolutionNotes.from, e.detail.values.resolutionNotes.to]), [
    ["svc", "belt replaced and tested", "belt replaced and tested (svc addendum)"],
    ["rmN", "belt replaced and tested (svc addendum)", "belt replaced and tested (rmN addendum)"],
  ]);
  // the notes cannot be blanked or trivialised on a resolved / closed ticket
  for (const bad of ["", "   ", "done", "ok ok"]) assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "closed", resolutionNotes: bad })).status, 400, JSON.stringify(bad));
  assert.equal(events.length, 2);
  // a manager outside their scope still gets the scope refusal; a non-manager cannot touch a closed ticket (not even a note, not even a repeat)
  const before = JSON.stringify([tickets, events]);
  assert.equal((await call("rmN", "PATCH", `/complaints/${south.id}`, { status: "closed", remarks: "x" })).status, 403);
  for (const body of [{ status: "closed", remarks: "late note" }, { status: "closed" }, { status: "closed", assignedToId: "svc" }]) {
    const r = await call("eng", "PATCH", `/complaints/${t.id}`, body);
    assert.deepEqual([r.status, r.body.code], [403, "CLOSED_TICKET_READ_ONLY"], JSON.stringify(body));
  }
  assert.equal(JSON.stringify([tickets, events]), before, "refused attempts changed nothing");
});

test("transitions: outside the proposed table is a 409 TRANSITION_NOT_ALLOWED that changes and records nothing (active -> closed directly, closed -> resolved)", async () => {
  const open = ticket({ assignedToId: "eng", resolutionNotes: "belt replaced and tested" });
  const closed = ticket({ status: "closed", closedAt: new Date(), closedById: "svc", resolutionNotes: "belt replaced and tested" });
  const before = JSON.stringify([tickets, events]);
  for (const [t, to, extra] of [[open, "closed", {}], [closed, "resolved", { reopenReason: "customer reports the fault is back" }]] as const) {
    const r = await call("svc", "PATCH", `/complaints/${t.id}`, { status: to, ...extra });
    assert.deepEqual([r.status, r.body.code], [409, "TRANSITION_NOT_ALLOWED"], `${t.status} -> ${to}`);
  }
  assert.equal(JSON.stringify([tickets, events]), before);
  // the permission rules still come first: an engineer closing an active ticket is told it needs a manager, not that the move is invalid
  assert.equal((await call("eng", "PATCH", `/complaints/${open.id}`, { status: "closed" })).body.code, "CLOSE_REQUIRES_MANAGER");
});

test("resolution notes: required (meaningful, checked by the API) before a ticket enters resolved; a refusal changes and records nothing; later edits keep before/after", async () => {
  const t = ticket({ status: "in_progress", assignedToId: "eng" });
  const before = JSON.stringify([tickets, events]);
  for (const body of [{ status: "resolved" }, { status: "resolved", resolutionNotes: "" }, { status: "resolved", resolutionNotes: "   " }, { status: "resolved", resolutionNotes: "done" }, { status: "resolved", resolutionNotes: "aaaaaaaaaaaa" }, { status: "resolved", remarks: "long remark but no resolution notes" }]) {
    for (const who of ["eng", "svc"]) {
      const r = await call(who, "PATCH", `/complaints/${t.id}`, body);
      assert.deepEqual([r.status, r.body.code], [400, "RESOLUTION_NOTES_REQUIRED"], `${who} ${JSON.stringify(body)}`);
    }
  }
  assert.equal(JSON.stringify([tickets, events]), before, "ticket and history unchanged by every refusal");
  assert.equal((await call("eng", "PATCH", `/complaints/${t.id}`, { status: "resolved", resolutionNotes: "  Replaced the belt and re-tested  " })).status, 200);
  assert.equal(row(t.id).resolutionNotes, "  Replaced the belt and re-tested  ");
  // a later correction keeps the old text in the history
  assert.equal((await call("eng", "PATCH", `/complaints/${t.id}`, { status: "resolved", resolutionNotes: "Replaced belt and tensioner, re-tested" })).status, 200);
  assert.deepEqual(events.filter((e) => e.type === "notes_updated").map((e) => [e.detail.values.resolutionNotes.from, e.detail.values.resolutionNotes.to]), [
    [null, "  Replaced the belt and re-tested  "],
    ["  Replaced the belt and re-tested  ", "Replaced belt and tensioner, re-tested"],
  ]);
  // while resolved, the notes cannot be blanked
  assert.equal((await call("eng", "PATCH", `/complaints/${t.id}`, { status: "resolved", resolutionNotes: "" })).body.code, "RESOLUTION_NOTES_REQUIRED");
  assert.equal(row(t.id).resolutionNotes, "Replaced belt and tensioner, re-tested");
  // a LEGACY resolved ticket without notes can still be closed / get other edits (the rule applies when entering resolved or editing the notes)
  const legacy = ticket({ status: "resolved" });
  assert.equal((await call("svc", "PATCH", `/complaints/${legacy.id}`, { status: "closed", remarks: "legacy" })).status, 200);
  // an already-noted ticket can be re-resolved after being reopened without retyping the notes
  const re = ticket({ status: "in_progress", resolutionNotes: "Replaced the belt and re-tested" });
  assert.equal((await call("svc", "PATCH", `/complaints/${re.id}`, { status: "resolved" })).status, 200);
});

test("reopen reason: a closed ticket needs a reason (10+ characters); an empty / short one is a 400 that changes nothing; the reason, actor and transition go into the history; permission and scope come first", async () => {
  const closedAt = new Date("2026-01-01T00:00:00Z");
  const t = ticket({ status: "closed", closedAt, closedById: "svc", resolutionNotes: "belt replaced and tested", site: { regionId: "north", vendorId: null } });
  const before = JSON.stringify([tickets, events]);
  for (const body of [{ status: "open" }, { status: "open", reopenReason: "" }, { status: "open", reopenReason: "     " }, { status: "open", reopenReason: "too short" }, { status: "open", reopenReason: "x".repeat(1001) }]) {
    const r = await call("svc", "PATCH", `/complaints/${t.id}`, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await call("svc", "PATCH", `/complaints/${t.id}`, { status: "open" })).body.code, "REOPEN_REASON_REQUIRED");
  assert.equal(JSON.stringify([tickets, events]), before, "ticket and history unchanged");
  // a non-manager is refused by the permission rule even with a perfect reason
  assert.equal((await call("eng", "PATCH", `/complaints/${t.id}`, { status: "open", reopenReason: "customer reports the fault is back" })).status, 403);
  const ok = await call("rmN", "PATCH", `/complaints/${t.id}`, { status: "in_progress", reopenReason: "  customer reports the fault is back  " });
  assert.equal(ok.status, 200);
  assert.deepEqual([row(t.id).status, row(t.id).closedAt, row(t.id).closedById], ["in_progress", null, null]);
  const ev = events.filter((e) => e.type === "status_changed");
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].fromValue, ev[0].toValue, ev[0].actorId, ev[0].detail.transition, ev[0].detail.reason], ["closed", "in_progress", "rmN", "reopened", "customer reports the fault is back"]);
  // reopening a merely RESOLVED ticket needs no reason (only closure is final)
  const resolved = ticket({ status: "resolved", resolutionNotes: "belt replaced and tested" });
  assert.equal((await call("svc", "PATCH", `/complaints/${resolved.id}`, { status: "in_progress" })).status, 200);
});

const okSite = (regionId: string | null = null, vendorId: string | null = null, customerId = "cA") => ({ regionId, vendorId, order: { customerId } });

test("restore: a manager in scope restores an archived ticket in the status it had; the archive event stays, a `restored` event records who / when / why; nothing else changes", async () => {
  const t = ticket({ status: "in_progress", assignedToId: "eng", site: okSite("north") as any });
  assert.equal((await call("rmN", "DELETE", `/complaints/${t.id}`, { reason: "raised by mistake" })).status, 204);
  assert.ok(row(t.id).archivedAt);
  const r = await call("rmN", "POST", `/complaints/${t.id}/restore`, { reason: "it was a real fault" });
  assert.equal(r.status, 204);
  assert.deepEqual([row(t.id).archivedAt, row(t.id).archivedById, row(t.id).archiveReason], [null, null, null]);
  assert.deepEqual([row(t.id).status, row(t.id).assignedToId], ["in_progress", "eng"]);
  assert.deepEqual(types(t.id), ["archived", "restored"], "the archive stays in the history");
  const e = events.find((x) => x.type === "restored");
  assert.deepEqual([e.actorId, e.toValue, e.detail.statusAtRestore, e.detail.reason], ["rmN", "in_progress", "in_progress", "it was a real fault"]);
  assert.ok(e.detail.archivedAt);
  // it can be archived again, and restored again - each step is one more history row
  assert.equal((await call("svc", "DELETE", `/complaints/${t.id}`)).status, 204);
  assert.equal((await call("svc", "POST", `/complaints/${t.id}/restore`)).status, 204);
  assert.deepEqual(types(t.id), ["archived", "restored", "archived", "restored"]);
});

test("restore: refused for a live ticket, for everyone who is not a manager in scope, and when the history write fails - each leaves the ticket untouched", async () => {
  const live = ticket({ site: okSite("north") as any });
  const south = ticket({ archivedAt: new Date(), archivedById: "svc", archiveReason: "spam", site: okSite("south") as any });
  const mine = ticket({ archivedAt: new Date(), archivedById: "svc", assignedToId: "eng", site: okSite("north") as any });
  const before = JSON.stringify([tickets, events]);
  assert.deepEqual([(await call("svc", "POST", `/complaints/${live.id}/restore`)).body.code], ["NOT_ARCHIVED"]);
  assert.equal((await call("svc", "POST", `/complaints/nope/restore`)).status, 404);
  assert.equal((await call("rmN", "POST", `/complaints/${south.id}/restore`)).status, 403, "outside the region");
  for (const who of ["eng", "v1", "custA", "sales"]) assert.equal((await call(who, "POST", `/complaints/${mine.id}/restore`)).status, 403, who);
  assert.equal((await call(null, "POST", `/complaints/${mine.id}/restore`)).status, 401);
  failEvent = true;
  assert.equal((await call("svc", "POST", `/complaints/${mine.id}/restore`)).status, 500);
  failEvent = false;
  assert.equal(JSON.stringify([tickets, events]), before, "nothing changed, nothing recorded (the failed history write rolled the restore back)");
  assert.equal((await call("svc", "POST", `/complaints/${mine.id}/restore`)).status, 204);
});

test("restore: the one-active-ticket-per-unit rule is re-checked - an active duplicate is a clear 409 naming the other ticket; a finished ticket restores; a changed site / customer link is refused", async () => {
  const archivedOpen = ticket({ id: "arch", unitId: "U", archivedAt: new Date(), archivedById: "svc", site: okSite() as any });
  const blocker = ticket({ id: "live", unitId: "U", site: okSite() as any });
  const before = JSON.stringify([tickets, events]);
  const r = await call("svc", "POST", `/complaints/${archivedOpen.id}/restore`);
  assert.deepEqual([r.status, r.body.code], [409, "OPEN_TICKET_EXISTS"]);
  assert.match(r.body.error, /TCK-live/);
  assert.equal(JSON.stringify([tickets, events]), before, "no duplicate was created and nothing was recorded");
  // a RESOLVED archived ticket is not active, so it may come back next to the live one
  const archivedDone = ticket({ id: "done", unitId: "U", status: "resolved", archivedAt: new Date(), archivedById: "svc", site: okSite() as any });
  assert.equal((await call("svc", "POST", `/complaints/${archivedDone.id}/restore`)).status, 204);
  // once the blocker is finished the first one restores
  blocker.status = "resolved";
  assert.equal((await call("svc", "POST", `/complaints/${archivedOpen.id}/restore`)).status, 204);
  // the site now belongs to another customer than the ticket's: refused, unchanged
  const moved = ticket({ archivedAt: new Date(), archivedById: "svc", site: okSite(null, null, "someone-else") as any });
  const r2 = await call("svc", "POST", `/complaints/${moved.id}/restore`);
  assert.deepEqual([r2.status, r2.body.code, row(moved.id).archivedAt !== null], [409, "RESTORE_LINK_INVALID", true]);
});

test("there is NO purge: no route removes a ticket, a repeated delete is a 409 and the archived ticket and its history stay", async () => {
  const t = ticket();
  await call("svc", "DELETE", `/complaints/${t.id}`);
  const count = tickets.length;
  for (const [m, path] of [["DELETE", `/complaints/${t.id}?purge=1`], ["DELETE", `/complaints/${t.id}/purge`], ["POST", `/complaints/${t.id}/purge`], ["DELETE", `/complaints/${t.id}/permanent`]] as const) {
    const r = await call("svc", m, path, { purge: true, force: true });
    assert.notEqual(r.status, 204, `${m} ${path}`);
  }
  assert.equal(tickets.length, count);
  assert.ok(row(t.id).archivedAt);
  assert.deepEqual(types(t.id), ["archived"]);
});
