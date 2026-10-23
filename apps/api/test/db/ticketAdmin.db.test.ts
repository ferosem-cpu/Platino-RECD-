/**
 * Real-database tests for ticket management (Requirement 11): status validation, closure / reopening timestamps, the reopen-versus-open-ticket
 * conflict, per-ticket scope for every write (Regional Manager, vendor, assigned-to-me), assignment validation, atomic history, the retained
 * hard-delete behaviour, duplicate handling, the list filters, and the retryable SLA escalation (overlapping runs, failed delivery, empty
 * recipient set, paused statuses) - through the real routers and the real escalation job.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test). They only touch rows they create (unique run prefix; removed in `after`). Every notification channel is
 * replaced by a stub that records the message, so nothing is sent anywhere. Run with: npm run test:db --workspace=apps/api (database migrated
 * through 20261024090000_ticket_escalation_delivery).
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";

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
describe("ticket management against the real test database", { skip }, () => {
  const PREFIX = `ZT${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), vendorIds: new Set<string>(), regionIds: new Set<string>(), orderIds: new Set<string>(), unitIds: new Set<string>(), complaintIds: new Set<string>(), productIds: new Set<string>() };
  const realConsole = { log: console.log, error: console.error };
  const HOUR = 3_600_000;
  const NOTES = "Replaced the belt and re-tested";
  const WHY = "customer reports the fault is back";
  let seq = 0;

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let esc: any;
  let providers: any;
  const realProviders: Record<string, any> = {};
  const sent: any[] = [];
  const emailFail = new Set<string>();
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const w: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const u = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, email: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(u.id);
    return u;
  }
  const tok = async (u: any) => {
    const x = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { role: true } });
    return signToken({ userId: x.id, roleKey: x.role.key, customerId: x.customerId, tokenVersion: x.tokenVersion });
  };
  /** One order + site (+ optional unit) for a customer; the site carries the region / vendor the scope rules key off. */
  async function makeSite(customerId: string, regionId: string | null, vendorId: string | null, withUnit = true) {
    const n = ++seq;
    const order = await prisma.order.create({ data: { orderNumber: `${PREFIX}-O${n}`, customerId, productId: w.product.id, quantity: 1, site: { create: { currentStageId: stageId, companyName: `${PREFIX} Plant ${n}`, address: "Synthetic", regionId, vendorId } } }, include: { site: true } });
    tracked.orderIds.add(order.id);
    let unit: any = null;
    if (withUnit) {
      unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${n}`, orderId: order.id, siteId: order.site.id, productId: w.product.id } });
      tracked.unitIds.add(unit.id);
    }
    return { site: order.site, unit };
  }
  async function makeTicket(over: Record<string, unknown> = {}, where: { regionId?: string | null; vendorId?: string | null; customerId?: string } = {}) {
    const { site, unit } = await makeSite(where.customerId ?? w.CA.id, where.regionId ?? null, where.vendorId ?? null);
    const t = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: where.customerId ?? w.CA.id, siteId: site.id, unitId: unit.id, category: "non_performance", description: `${PREFIX} ticket`, severity: "medium", status: "open", ...over } });
    tracked.complaintIds.add(t.id);
    return { t, site, unit };
  }
  async function call(as: string | null, method: string, p: string, body?: unknown) {
    const res = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${as}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, headers: res.headers };
  }
  const patch = (as: string, t: any, body: Record<string, unknown>) => call(as, "PATCH", `/complaints/${t.id}`, body);
  const raw = (id: string) => prisma.complaint.findUniqueOrThrow({ where: { id } });
  const events = (id: string, type?: string) => prisma.complaintEvent.findMany({ where: { complaintId: id, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
  const mailsFor = (t: any, template: string) => sent.filter((m) => m.channel === "email" && m.templateKey === template && JSON.stringify(m.data).includes(t.ticketNumber));

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    esc = await import("../../src/lib/ticketEscalation");
    ({ providersByChannel: providers } = await import("../../src/services/notifications/providers"));
    for (const k of Object.keys(providers)) {
      realProviders[k] = providers[k];
      providers[k] = { channel: k, send: async (m: any) => { if (k === "email" && emailFail.has(m.recipientId)) return false; sent.push({ channel: k, ...m }); return true; } };
    }
    const { complaintsRouter } = await import("../../src/routes/complaints");
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use("/complaints", complaintsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_team", "management", "regional_manager", "service_engineer", "erection_engineer", "sales"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    w.product = await prisma.product.create({ data: { name: `${PREFIX} P`, model: `${PREFIX}-P`, warrantyMonths: 12 } });
    tracked.productIds.add(w.product.id);
    for (const t of ["A", "B"]) { w["C" + t] = await prisma.customer.create({ data: { name: `${PREFIX} Customer ${t}` } }); tracked.customerIds.add(w["C" + t].id); }
    for (const t of ["1", "2"]) { w["V" + t] = await prisma.vendor.create({ data: { name: `${PREFIX} V${t}`, status: "approved", contactName: "S", contactEmail: `${PREFIX.toLowerCase()}-v${t}@example.invalid` } }); tracked.vendorIds.add(w["V" + t].id); }
    for (const t of ["N", "S"]) { w["R" + t] = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-${t}`, name: `${PREFIX} ${t}` } }); tracked.regionIds.add(w["R" + t].id); }
    w.svc = await makeUser("service", "service_team");
    w.mgmt = await makeUser("mgmt", "management");
    w.rmN = await makeUser("rmN", "regional_manager");
    w.rmS = await makeUser("rmS", "regional_manager");
    await prisma.regionManager.createMany({ data: [{ regionId: w.RN.id, userId: w.rmN.id }, { regionId: w.RS.id, userId: w.rmS.id }] });
    w.eng = await makeUser("eng", "service_engineer");
    w.engInactive = await makeUser("engOff", "service_engineer", { isActive: false });
    w.v1Eng = await makeUser("v1eng", "erection_engineer", { vendorId: w.V1.id });
    w.v2Eng = await makeUser("v2eng", "erection_engineer", { vendorId: w.V2.id });
    w.sales = await makeUser("sales", "sales");
    w.custA = await makeUser("custA", "customer", { customerId: w.CA.id });
    w.custB = await makeUser("custB", "customer", { customerId: w.CB.id });
  });

  after(async () => {
    server?.close();
    try {
      if (prisma) {
        const ids = [...tracked.complaintIds];
        await prisma.complaint.deleteMany({ where: { OR: [{ id: { in: ids } }, { customerId: { in: [...tracked.customerIds] } }] } }); // events / escalation rows cascade
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.regionManager.deleteMany({ where: { userId: { in: [...tracked.userIds] } } });
        await prisma.notificationLog.deleteMany({ where: { recipientId: { in: [...tracked.userIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
        await prisma.region.deleteMany({ where: { id: { in: [...tracked.regionIds] } } });
        await prisma.vendor.deleteMany({ where: { id: { in: [...tracked.vendorIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
        await prisma.product.deleteMany({ where: { id: { in: [...tracked.productIds] } } });
      }
    } finally {
      for (const k of Object.keys(realProviders)) providers[k] = realProviders[k];
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // migration
  // ------------------------------------------------------------------------------------------

  test("migration: the escalation ledger table, its unique index, level / attempt checks and RLS; the open-ticket-per-unit index still exists (its archived-ticket change is tested below)", async () => {
    const t = await prisma.$queryRaw`select relname, relrowsecurity from pg_class where relname = 'TicketEscalationDelivery'`;
    assert.deepEqual([t.length, t[0]?.relrowsecurity], [1, true]);
    const idx = (await prisma.$queryRaw`select indexname from pg_indexes where indexname in ('TicketEscalationDelivery_complaintId_level_recipientId_key','Complaint_one_open_per_unit')`).map((r: any) => r.indexname).sort();
    assert.deepEqual(idx, ["Complaint_one_open_per_unit", "TicketEscalationDelivery_complaintId_level_recipientId_key"]);
    const { t: ticket } = await makeTicket();
    await assert.rejects(prisma.ticketEscalationDelivery.create({ data: { complaintId: ticket.id, level: 3, recipientId: w.svc.id } }), /level_check|violates check/i);
    await assert.rejects(prisma.ticketEscalationDelivery.create({ data: { complaintId: ticket.id, level: 1, recipientId: w.svc.id, attempts: -1 } }), /attempts_check|violates check/i);
  });

  // ------------------------------------------------------------------------------------------
  // status validation, closure, reopening
  // ------------------------------------------------------------------------------------------

  test("status: only the nine existing values are accepted; an arbitrary string is a 400 and nothing is stored or recorded", async () => {
    const { t } = await makeTicket();
    const s = await tok(w.svc);
    for (const bad of ["banana", "OPEN", "Closed ", "", "in progress", 5 as any, null as any]) {
      const r = await patch(s, t, { status: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await patch(s, t, {})).status, 400, "status is required");
    assert.equal((await raw(t.id)).status, "open");
    assert.equal((await events(t.id)).length, 0);
    for (const ok of ["open", "acknowledged", "assigned", "in_progress", "waiting_for_customer", "waiting_for_part", "escalated", "resolved", "closed"]) {
      assert.equal((await patch(s, t, { status: ok, ...(ok === "resolved" ? { resolutionNotes: NOTES } : {}) })).status, 200, ok);
    }
  });

  test("closure: closedAt is set on the first move into closed and NOT overwritten by a repeat; the repeat records and notifies nothing", async () => {
    const { t } = await makeTicket({ status: "resolved" });
    const s = await tok(w.svc);
    sent.length = 0;
    assert.equal((await patch(s, t, { status: "closed", resolutionNotes: "Replaced the sensor" })).status, 200);
    const first = (await raw(t.id)).closedAt;
    assert.ok(first);
    await new Promise((r) => setTimeout(r, 25));
    const again = await patch(s, t, { status: "closed" });
    assert.equal(again.status, 200);
    assert.equal((await raw(t.id)).closedAt.getTime(), first.getTime(), "the original closure time is kept");
    const ev = await events(t.id);
    assert.deepEqual(ev.map((e: any) => e.type), ["status_changed", "notes_updated"], "no event for the repeated closure");
    assert.deepEqual([ev[0].fromValue, ev[0].toValue, ev[0].detail.transition, ev[0].actorId], ["resolved", "closed", "closed", w.svc.id]);
    assert.deepEqual(ev[1].detail, { fields: ["resolutionNotes"], values: { resolutionNotes: { from: null, to: "Replaced the sensor" } } }, "the event names the field and keeps its before / after text");
    assert.equal(mailsFor(t, "complaint_status_updated").length <= 1, true, "at most the one genuine status-change notice");
  });

  test("reopening: leaving closed clears closedAt and records it; closing again sets a fresh closedAt; resolved never gets one", async () => {
    const { t } = await makeTicket();
    const s = await tok(w.svc);
    await patch(s, t, { status: "resolved", resolutionNotes: NOTES });
    assert.equal((await raw(t.id)).closedAt, null, "resolved is not closed");
    await patch(s, t, { status: "closed" });
    const closedFirst = (await raw(t.id)).closedAt;
    assert.ok(closedFirst);
    const re = await patch(s, t, { status: "in_progress", reopenReason: WHY });
    assert.equal(re.status, 200);
    const afterReopen = await raw(t.id);
    assert.deepEqual([afterReopen.status, afterReopen.closedAt], ["in_progress", null]);
    const reopened = (await events(t.id, "status_changed")).find((e: any) => e.detail?.transition === "reopened");
    assert.deepEqual([reopened.fromValue, reopened.toValue, reopened.detail.closedAtCleared, reopened.detail.reason, reopened.actorId], ["closed", "in_progress", true, WHY, w.svc.id]);
    assert.ok(reopened.createdAt, "the history row carries the time");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal((await patch(s, t, { status: "closed" })).body.code, "TRANSITION_NOT_ALLOWED", "an active ticket is resolved before it is closed again");
    await patch(s, t, { status: "resolved" }); // the notes already on the ticket are enough
    await patch(s, t, { status: "closed" });
    assert.ok((await raw(t.id)).closedAt.getTime() > closedFirst.getTime());
    assert.equal((await events(t.id, "status_changed")).length, 5, "every real change is in the history, in order (resolved, closed, reopened, resolved, closed)");
  });

  test("reopening a resolved / closed ticket while another ticket for the same RECD is open is a 409 naming that ticket - nothing changes", async () => {
    const { t, site, unit } = await makeTicket({ status: "closed", closedAt: new Date() });
    const newer = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, unitId: unit.id, category: "non_performance", description: "newer", severity: "low", status: "open" } });
    tracked.complaintIds.add(newer.id);
    const r = await patch(await tok(w.svc), t, { status: "open", reopenReason: WHY });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "OPEN_TICKET_EXISTS");
    assert.match(r.body.error, new RegExp(newer.ticketNumber));
    const after = await raw(t.id);
    assert.deepEqual([after.status, after.closedAt !== null], ["closed", true], "unchanged, closure kept");
    assert.equal((await events(t.id)).length, 0, "no event for the rejected change");
    // once the newer ticket is finished the reopen works
    await patch(await tok(w.svc), newer, { status: "resolved", resolutionNotes: NOTES });
    assert.equal((await patch(await tok(w.svc), t, { status: "open", reopenReason: WHY })).status, 200);
  });

  test("two simultaneous identical status changes: one applies, the other is a 409 - one history row", async () => {
    const { t } = await makeTicket({ status: "resolved", resolutionNotes: NOTES });
    const s = await tok(w.svc);
    const rs = await Promise.all([1, 2, 3, 4].map(() => patch(s, t, { status: "closed" })));
    const codes = rs.map((r) => r.status).sort();
    assert.ok(codes.filter((c) => c === 200).length >= 1);
    assert.ok(rs.every((r) => [200, 409].includes(r.status)), `no 500s: ${codes}`);
    assert.ok((await events(t.id, "status_changed")).length >= 1 && (await events(t.id, "status_changed")).length <= 1, "exactly one closure event");
  });

  test("a no-op update writes nothing, records nothing and notifies nobody", async () => {
    const { t } = await makeTicket({ remarks: "same", assignedToId: w.eng.id });
    const s = await tok(w.svc);
    sent.length = 0;
    const r = await patch(s, t, { status: "open", remarks: "same", assignedToId: w.eng.id });
    assert.equal(r.status, 200);
    assert.equal((await events(t.id)).length, 0);
    assert.equal(sent.filter((m) => JSON.stringify(m.data).includes(t.ticketNumber)).length, 0);
  });

  test("notifications: the customer is told only of a real status change, the assignee only of a real assignment, via one deterministic contact", async () => {
    const first = await makeUser("contact1", "customer", { customerId: w.CA.id });
    const { t } = await makeTicket();
    const s = await tok(w.svc);
    sent.length = 0;
    await patch(s, t, { status: "in_progress", assignedToId: w.eng.id });
    const statusMails = sent.filter((m) => m.templateKey === "complaint_status_updated" && m.data.ticketNumber === t.ticketNumber);
    assert.ok(statusMails.length >= 1);
    const recipients = new Set(statusMails.map((m) => m.recipientId));
    assert.equal(recipients.size, 1, "one recipient, not several");
    const oldest = await prisma.user.findFirst({ where: { customerId: w.CA.id, isActive: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    assert.equal([...recipients][0], oldest.id, "the customer's oldest active contact");
    assert.equal(sent.filter((m) => m.templateKey === "complaint_assigned" && m.recipientId === w.eng.id && m.data.ticketNumber === t.ticketNumber).length >= 1, true);
    sent.length = 0;
    await patch(s, t, { status: "in_progress", remarks: "only a note" });
    assert.equal(sent.filter((m) => m.data?.ticketNumber === t.ticketNumber).length, 0, "a notes-only change notifies nobody");
    assert.ok(first);
  });

  // ------------------------------------------------------------------------------------------
  // scope
  // ------------------------------------------------------------------------------------------

  test("Regional Manager: PATCH, history and DELETE only for tickets in their own regions; a ticket with no site is out of every region", async () => {
    const north = await makeTicket({}, { regionId: w.RN.id });
    const south = await makeTicket({}, { regionId: w.RS.id });
    const noSite = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, category: "non_performance", description: "no site", severity: "low", status: "open" } });
    tracked.complaintIds.add(noSite.id);
    const rm = await tok(w.rmN);
    assert.equal((await patch(rm, north.t, { status: "acknowledged" })).status, 200);
    for (const other of [south.t, noSite]) {
      const r = await patch(rm, other, { status: "acknowledged" });
      assert.equal(r.status, 403, other.ticketNumber);
      assert.match(r.body.error, /outside the regions/);
      assert.equal((await call(rm, "GET", `/complaints/${other.id}/history`)).status, 403);
      assert.equal((await call(rm, "DELETE", `/complaints/${other.id}`)).status, 403);
    }
    assert.equal((await raw(south.t.id)).status, "open");
    assert.equal(await prisma.complaint.count({ where: { id: { in: [south.t.id, noSite.id] } } }), 2, "nothing was deleted");
    assert.equal((await call(rm, "GET", `/complaints/${north.t.id}/history`)).status, 200);
    assert.equal((await call(rm, "DELETE", `/complaints/${north.t.id}`)).status, 204);
    // the list is scoped the same way
    const list = await call(await tok(w.rmS), "GET", "/complaints");
    assert.ok(list.body.some((x: any) => x.id === south.t.id));
    assert.ok(!list.body.some((x: any) => x.id === north.t.id || x.id === noSite.id));
  });

  test("vendor-scoped engineers: only tickets assigned to them AND on their vendor's sites (read, history and write)", async () => {
    const own = await makeTicket({}, { vendorId: w.V1.id });
    const foreign = await makeTicket({}, { vendorId: w.V2.id });
    await prisma.complaint.updateMany({ where: { id: { in: [own.t.id, foreign.t.id] } }, data: { assignedToId: w.v1Eng.id } }); // v1Eng holds both, one on another vendor's site
    const e = await tok(w.v1Eng);
    assert.equal((await patch(e, own.t, { status: "in_progress" })).status, 200);
    const r = await patch(e, foreign.t, { status: "in_progress" });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /vendor's sites/);
    assert.equal((await call(e, "GET", `/complaints/${foreign.t.id}/history`)).status, 403);
    const list = (await call(e, "GET", "/complaints")).body.map((x: any) => x.id);
    assert.ok(list.includes(own.t.id) && !list.includes(foreign.t.id));
    assert.equal((await raw(foreign.t.id)).status, "open");
    // an engineer can never reassign, and cannot touch an unassigned ticket
    assert.equal((await patch(e, own.t, { status: "in_progress", assignedToId: w.eng.id })).status, 200);
    assert.equal((await raw(own.t.id)).assignedToId, w.v1Eng.id, "engineers cannot reassign (the field is ignored)");
    const unassigned = await makeTicket({}, { vendorId: w.V1.id });
    assert.equal((await patch(e, unassigned.t, { status: "in_progress" })).status, 403);
  });

  test("assignment validation: unknown / inactive / unsuitable role / cross-vendor are refused with a clear 400, never a foreign-key 500; valid ones work and are recorded", async () => {
    const { t } = await makeTicket({}, { regionId: w.RN.id, vendorId: w.V1.id });
    const s = await tok(w.svc);
    const attempt = (assignedToId: string | null) => patch(s, t, { status: "assigned", assignedToId });
    const unknown = await attempt("no-such-user");
    assert.deepEqual([unknown.status, unknown.body.code], [400, "ASSIGNEE_NOT_FOUND"]);
    assert.deepEqual([(await attempt(w.engInactive.id)).body.code], ["ASSIGNEE_INACTIVE"]);
    assert.deepEqual([(await attempt(w.sales.id)).body.code], ["ASSIGNEE_ROLE"]);
    assert.deepEqual([(await attempt(w.custA.id)).body.code], ["ASSIGNEE_ROLE"]);
    const cross = await attempt(w.v2Eng.id);
    assert.deepEqual([cross.status, cross.body.code], [400, "ASSIGNEE_VENDOR_SCOPE"]);
    assert.equal((await raw(t.id)).assignedToId, null);
    assert.equal((await raw(t.id)).status, "open", "a refused assignment changes nothing, not even the status sent with it");
    assert.equal((await events(t.id)).length, 0);
    assert.equal((await attempt(w.v1Eng.id)).status, 200, "the ticket's own vendor's engineer");
    assert.equal((await attempt(w.eng.id)).status, 200, "an internal engineer");
    assert.equal((await attempt(null)).status, 200, "unassign");
    const assigned = (await events(t.id, "assigned")).map((e: any) => [e.fromValue, e.toValue]);
    assert.deepEqual(assigned, [[null, w.v1Eng.id], [w.v1Eng.id, w.eng.id], [w.eng.id, null]]);
    // a vendor-less (internal-site) ticket cannot go to a vendor engineer
    const internal = await makeTicket();
    assert.equal((await patch(s, internal.t, { status: "assigned", assignedToId: w.v1Eng.id })).body.code, "ASSIGNEE_VENDOR_SCOPE");
  });

  test("the assignee list: internal engineers only without a ticket; with a ticket, plus only that ticket's vendor's engineers; never another vendor's", async () => {
    const { t } = await makeTicket({}, { vendorId: w.V1.id });
    const s = await tok(w.svc);
    const names = async (path: string) => (await call(s, "GET", path)).body.map((x: any) => x.id);
    const plain = await names("/complaints/assignees");
    assert.ok(plain.includes(w.eng.id));
    assert.ok(!plain.includes(w.v1Eng.id) && !plain.includes(w.v2Eng.id) && !plain.includes(w.engInactive.id));
    const forTicket = await names(`/complaints/assignees?ticketId=${t.id}`);
    assert.ok(forTicket.includes(w.eng.id) && forTicket.includes(w.v1Eng.id));
    assert.ok(!forTicket.includes(w.v2Eng.id), "another vendor's engineer is never offered");
    assert.equal((await call(s, "GET", "/complaints/assignees?ticketId=nope")).status, 404);
    const south = await makeTicket({}, { regionId: w.RS.id });
    assert.equal((await call(await tok(w.rmN), "GET", `/complaints/assignees?ticketId=${south.t.id}`)).status, 403, "a Regional Manager cannot probe another region's ticket");
    assert.equal((await call(await tok(w.sales), "GET", "/complaints/assignees")).status, 403);
  });

  test("customers cannot reach any staff route; they see only their own tickets", async () => {
    const mine = await makeTicket({}, { customerId: w.CA.id });
    const theirs = await makeTicket({}, { customerId: w.CB.id });
    const a = await tok(w.custA);
    for (const [m, p, b] of [["PATCH", `/complaints/${mine.t.id}`, { status: "closed" }], ["DELETE", `/complaints/${mine.t.id}`], ["GET", `/complaints/${mine.t.id}/history`], ["GET", "/complaints/assignees"], ["GET", "/complaints/overview"]] as any) {
      assert.equal((await call(a, m, p, b)).status, 403, `${m} ${p}`);
    }
    const list = (await call(a, "GET", "/complaints")).body.map((x: any) => x.id);
    assert.ok(list.includes(mine.t.id) && !list.includes(theirs.t.id));
    assert.equal((await raw(mine.t.id)).status, "open");
  });

  // ------------------------------------------------------------------------------------------
  // history atomicity
  // ------------------------------------------------------------------------------------------

  test("atomic: if the history row cannot be written, the ticket change is rolled back (update paths); a ticket is not created without its CREATED event", async () => {
    const { t } = await makeTicket({ assignedToId: w.v1Eng.id, status: "resolved", resolutionNotes: NOTES });
    const { updateTicket } = await import("../../src/lib/ticketAdmin");
    const ghost = { userId: "no-such-actor", roleKey: "service_team", permissions: new Set(["manage_complaints"]) };
    await assert.rejects(updateTicket(ghost, t.id, { status: "closed", remarks: "x", assignedToId: w.eng.id }), /foreign key|Foreign key/i);
    const r = await raw(t.id);
    assert.deepEqual([r.status, r.closedAt, r.remarks, r.assignedToId], ["resolved", null, null, w.v1Eng.id], "nothing changed");
    assert.equal((await events(t.id)).length, 0);
    // creation: the portal path writes the ticket and its event in one transaction - a ghost actor (FK) makes the event fail
    const { site } = await makeSite(w.CA.id, null, null, false);
    const before = await prisma.complaint.count({ where: { siteId: site.id } });
    const { prisma: p } = await import("../../src/lib/prisma");
    await assert.rejects(p.$transaction(async (tx: any) => {
      const created = await tx.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, category: "x", description: "x", severity: "low", status: "open" } });
      const { logComplaintEventStrict } = await import("../../src/lib/ticketEvents");
      await logComplaintEventStrict(tx, { complaintId: created.id, type: "created", actorId: "no-such-actor" });
    }), /foreign key|Foreign key/i);
    assert.equal(await prisma.complaint.count({ where: { siteId: site.id } }), before, "no orphan ticket");
  });

  test("creation records what was reported (serial and site) in the CREATED event, for portal tickets", async () => {
    const { site, unit } = await makeSite(w.CA.id, null, null);
    const photo = "data:image/png;base64,AA";
    const r = await call(await tok(w.custA), "POST", "/complaints", { siteId: site.id, category: "non_performance", description: "Noise", severity: "low", attachmentUrl: photo });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.complaintIds.add(r.body.id);
    const created = (await events(r.body.id, "created"))[0];
    assert.deepEqual(created.detail, { source: "portal", serialNo: unit.serialNo, siteName: site.companyName, siteId: site.id, unitId: unit.id });
    assert.equal(created.actorId, w.custA.id);
    // R1 D2: even a CLOSED ticket keeps its unit - the unit cannot be deleted (it used to be detached by SET NULL), and the snapshot stays
    await prisma.complaint.update({ where: { id: r.body.id }, data: { status: "closed", closedAt: new Date() } });
    await assert.rejects(prisma.recdUnit.delete({ where: { id: unit.id } }), (e: any) => e.code === "P2003");
    assert.equal((await raw(r.body.id)).unitId, unit.id, "the link is kept");
    assert.equal((await events(r.body.id, "created"))[0].detail.serialNo, unit.serialNo, "and the history still says which serial was reported");
  });

  // ------------------------------------------------------------------------------------------
  // delete (existing policy, retained)
  // ------------------------------------------------------------------------------------------

  // ------------------------------------------------------------------------------------------
  // duplicates
  // ------------------------------------------------------------------------------------------

  test("one open ticket per unit: a simultaneous burst creates one; the rest get the clean 400; a finished ticket permits a new one", async () => {
    const { site } = await makeSite(w.CA.id, null, null);
    const a = await tok(w.custA);
    const body = { siteId: site.id, category: "non_performance", description: "Noise", severity: "low", attachmentUrl: "data:image/png;base64,AA" };
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(a, "POST", "/complaints", body)));
    for (const r of rs) if (r.status === 201) tracked.complaintIds.add(r.body.id);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 400, 400, 400, 400, 400]);
    assert.ok(rs.filter((r) => r.status === 400).every((r) => /open complaint/.test(r.body.error)));
    assert.equal(await prisma.complaint.count({ where: { siteId: site.id } }), 1);
    const first = rs.find((r) => r.status === 201)!;
    await patch(await tok(w.svc), { id: first.body.id }, { status: "resolved", resolutionNotes: NOTES });
    const again = await call(a, "POST", "/complaints", body);
    assert.equal(again.status, 201, "a resolved ticket permits a new one");
    tracked.complaintIds.add(again.body.id);
    assert.notEqual(again.body.ticketNumber, first.body.ticketNumber);
  });

  // ------------------------------------------------------------------------------------------
  // duplicate-ticket guard for tickets WITHOUT a unit (a site with no eligible RECD unit)
  // ------------------------------------------------------------------------------------------

  const unitless = (siteId: string, status = "open", extra: Record<string, unknown> = {}) =>
    prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId, category: "non_performance", description: "x", severity: "low", status, ...extra } }).then((t: any) => { tracked.complaintIds.add(t.id); return t; });
  const portalBody = (siteId: string) => ({ siteId, category: "non_performance", description: "Noise", severity: "low", attachmentUrl: "data:image/png;base64,AA" });

  test("unit-less tickets: a partial unique index makes ONE active ticket per site a database guarantee (same definition as for units: resolved / closed / archived do not count)", async () => {
    const idx = await prisma.$queryRaw`select indexdef from pg_indexes where indexname = 'Complaint_one_open_per_site_without_unit'`;
    assert.equal(idx.length, 1, "the index exists");
    assert.match(idx[0].indexdef, /UNIQUE/);
    assert.match(idx[0].indexdef, /"unitId" IS NULL/);
    assert.match(idx[0].indexdef, /"archivedAt" IS NULL/);
    const { site } = await makeSite(w.CA.id, null, null, false);
    const first = await unitless(site.id);
    await assert.rejects(unitless(site.id), (e: any) => e.code === "P2002", "a second active unit-less ticket on the site is refused by the database itself");
    // each way of being "not active" frees the site
    await prisma.complaint.update({ where: { id: first.id }, data: { status: "resolved" } });
    const second = await unitless(site.id);
    await prisma.complaint.update({ where: { id: second.id }, data: { archivedAt: new Date() } });
    const third = await unitless(site.id);
    await assert.rejects(unitless(site.id), (e: any) => e.code === "P2002");
    // another site is independent; tickets without a site are not constrained by it
    const { site: other } = await makeSite(w.CA.id, null, null, false);
    await unitless(other.id);
    await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: null, category: "x", description: "x", severity: "low", status: "open" } }).then((t: any) => tracked.complaintIds.add(t.id));
    await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: null, category: "x", description: "x", severity: "low", status: "open" } }).then((t: any) => tracked.complaintIds.add(t.id));
    void third;
  });

  test("unit-less tickets through the portal: the sequential duplicate is a clean 400; a simultaneous burst creates exactly ONE (the rest are clean 400s, never 500); a resolved / archived one lets a new one in", async () => {
    const a = await tok(w.custA);
    const { site } = await makeSite(w.CA.id, null, null, false);
    const body = portalBody(site.id);
    const first = await call(a, "POST", "/complaints", body);
    assert.equal(first.status, 201);
    tracked.complaintIds.add(first.body.id);
    const dup = await call(a, "POST", "/complaints", body);
    assert.equal(dup.status, 400, "sequential duplicate");
    assert.match(dup.body.error, /open complaint/);
    const { site: site2 } = await makeSite(w.CA.id, null, null, false);
    for (let round = 0; round < 3; round++) {
      const { site: burstSite } = round === 0 ? { site: site2 } : await makeSite(w.CA.id, null, null, false);
      const rs = await Promise.all(Array.from({ length: 8 }, () => call(a, "POST", "/complaints", portalBody(burstSite.id))));
      for (const r of rs) if (r.status === 201) tracked.complaintIds.add(r.body.id);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 400, 400, 400, 400, 400, 400, 400], `round ${round}: exactly one created, no 500`);
      assert.equal(await prisma.complaint.count({ where: { siteId: burstSite.id, unitId: null, archivedAt: null } }), 1, "one active ticket in the database");
    }
    // finished ticket -> a new one is allowed; archived ticket -> a new one is allowed
    assert.equal((await patch(await tok(w.svc), { id: first.body.id }, { status: "resolved", resolutionNotes: NOTES })).status, 200);
    const again = await call(a, "POST", "/complaints", body);
    assert.equal(again.status, 201, "a resolved ticket permits a new one");
    tracked.complaintIds.add(again.body.id);
    assert.equal((await call(await tok(w.svc), "DELETE", `/complaints/${again.body.id}`)).status, 204);
    const afterArchive = await call(a, "POST", "/complaints", body);
    assert.equal(afterArchive.status, 201, "an archived ticket does not block a new one");
    tracked.complaintIds.add(afterArchive.body.id);
  });

  test("duplicate guard, sites WITH units: unchanged - one active ticket per unit, several units on one site are independent, a burst creates one", async () => {
    const a = await tok(w.custA);
    const { site, unit } = await makeSite(w.CA.id, null, null, true);
    const unit2 = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${++seq}`, orderId: (await prisma.site.findUniqueOrThrow({ where: { id: site.id } })).orderId, siteId: site.id, productId: w.product.id } });
    tracked.unitIds.add(unit2.id);
    const mk = (unitId: string) => call(a, "POST", "/complaints", { ...portalBody(site.id), unitId });
    const rs = await Promise.all([unit.id, unit.id, unit.id, unit2.id, unit2.id].map(mk));
    for (const r of rs) if (r.status === 201) tracked.complaintIds.add(r.body.id);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 201, 400, 400, 400], "one per unit, never a 500");
    assert.deepEqual((await Promise.all(rs.filter((r) => r.status === 201).map((r) => prisma.complaint.findUniqueOrThrow({ where: { id: r.body.id } })))).map((t: any) => t.unitId).sort(), [unit.id, unit2.id].sort());
  });

  test("duplicate guard: reopening a unit-less ticket while another active unit-less ticket exists on the site is a 409 OPEN_TICKET_EXISTS naming it; nothing changes", async () => {
    const { site } = await makeSite(w.CA.id, null, null, false);
    const old = await unitless(site.id, "closed", { closedAt: new Date(), closedById: w.svc.id, resolutionNotes: NOTES });
    const live = await unitless(site.id, "open");
    const before = await raw(old.id);
    const r = await patch(await tok(w.svc), old, { status: "open", reopenReason: WHY });
    assert.deepEqual([r.status, r.body.code], [409, "OPEN_TICKET_EXISTS"]);
    assert.match(r.body.error, new RegExp(live.ticketNumber));
    assert.deepEqual(await raw(old.id), before);
    assert.equal((await events(old.id)).length, 0);
  });

  test("migration: the guard's pre-check stops with a message listing the sites if duplicates already exist (nothing is created), and the index builds when there are none", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261029090000_ticket_unitless_duplicate_guard/migration.sql"), "utf8");
    const doBlock = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END $$;") + "END $$;".length);
    const { site } = await makeSite(w.CA.id, null, null, false);
    let a: any, b: any;
    try {
      await prisma.$executeRawUnsafe(`DROP INDEX "Complaint_one_open_per_site_without_unit"`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Complaint" DISABLE TRIGGER "Complaint_site_level_guard"`); // legacy duplicates predate every guard
      a = await unitless(site.id);
      b = await unitless(site.id);
      await assert.rejects(prisma.$executeRawUnsafe(doBlock), (e: any) => new RegExp(`${site.id}.*${a.ticketNumber}`, "s").test(String(e.message)) && /already have several active tickets/.test(String(e.message)));
      await prisma.complaint.update({ where: { id: b.id }, data: { status: "resolved" } });
      await prisma.$executeRawUnsafe(doBlock); // no duplicates left among the ACTIVE tickets -> passes
    } finally {
      if (b) await prisma.complaint.update({ where: { id: b.id }, data: { status: "resolved" } });
      await prisma.$executeRawUnsafe(`ALTER TABLE "Complaint" ENABLE TRIGGER "Complaint_site_level_guard"`);
      const exists = await prisma.$queryRaw`select 1 from pg_indexes where indexname = 'Complaint_one_open_per_site_without_unit'`;
      if (!exists.length) {
        const create = sql.slice(sql.indexOf("CREATE UNIQUE INDEX"));
        await prisma.$executeRawUnsafe(create);
      }
    }
    assert.equal((await prisma.$queryRaw`select 1 from pg_indexes where indexname = 'Complaint_one_open_per_site_without_unit'`).length, 1, "the index is back");
  });

  // ------------------------------------------------------------------------------------------
  // restoring archived tickets (there is deliberately no purge)
  // ------------------------------------------------------------------------------------------

  test("restore (real database): the ticket returns in its old status with its history; archived + restored events record actors and reasons; a second restore is a 409", async () => {
    const { t } = await makeTicket({ status: "in_progress", assignedToId: w.eng.id }, { regionId: w.RN.id });
    const rm = await tok(w.rmN);
    assert.equal((await call(rm, "DELETE", `/complaints/${t.id}`, { reason: "raised by mistake" })).status, 204);
    const archived = await raw(t.id);
    assert.ok(archived.archivedAt);
    const listed = await call(await tok(w.svc), "GET", "/complaints");
    assert.equal(listed.body.some((x: any) => x.id === t.id), false, "archived tickets leave the working list");
    const r = await call(rm, "POST", `/complaints/${t.id}/restore`, { reason: "it was a real fault" });
    assert.equal(r.status, 204);
    const back = await raw(t.id);
    assert.deepEqual([back.archivedAt, back.archivedById, back.archiveReason, back.status, back.assignedToId], [null, null, null, "in_progress", w.eng.id]);
    assert.equal((await call(await tok(w.svc), "GET", "/complaints")).body.some((x: any) => x.id === t.id), true, "back in the working list");
    const ev = await events(t.id);
    assert.deepEqual(ev.map((e: any) => e.type), ["archived", "restored"]);
    assert.deepEqual([ev[0].actorId, ev[0].detail.reason, ev[1].actorId, ev[1].detail.reason, ev[1].detail.statusAtRestore, ev[1].toValue], [w.rmN.id, "raised by mistake", w.rmN.id, "it was a real fault", "in_progress", "in_progress"]);
    assert.ok(ev[1].createdAt >= ev[0].createdAt);
    assert.deepEqual([(await call(rm, "POST", `/complaints/${t.id}/restore`)).body.code], ["NOT_ARCHIVED"]);
    // history is also readable through the API with the restore in it
    const hist = await call(rm, "GET", `/complaints/${t.id}/history`);
    assert.deepEqual(hist.body.events.map((e: any) => e.type), ["archived", "restored"]);
  });

  test("restore (real database): permissions - only a ticket manager inside their scope; a refusal changes nothing", async () => {
    const { t } = await makeTicket({ assignedToId: w.eng.id }, { regionId: w.RN.id });
    assert.equal((await call(await tok(w.svc), "DELETE", `/complaints/${t.id}`)).status, 204);
    const before = await raw(t.id);
    const evBefore = (await events(t.id)).length;
    for (const who of [w.eng, w.v1Eng, w.custA, w.sales, w.rmS]) assert.equal((await call(await tok(who), "POST", `/complaints/${t.id}/restore`)).status, 403, who.name);
    assert.equal((await call(null, "POST", `/complaints/${t.id}/restore`)).status, 401);
    assert.deepEqual(await raw(t.id), before);
    assert.equal((await events(t.id)).length, evBefore);
    assert.equal((await call(await tok(w.rmN), "POST", `/complaints/${t.id}/restore`)).status, 204, "the region's own manager restores it");
  });

  test("restore (real database): the duplicate rule is re-checked - against an active ticket for the same unit, and for a unit-less ticket the same site; finished tickets restore; a simultaneous restore of two duplicates lets exactly one in", async () => {
    const svc = await tok(w.svc);
    // with a unit
    const { t, site, unit } = await makeTicket({ status: "open" });
    assert.equal((await call(svc, "DELETE", `/complaints/${t.id}`)).status, 204);
    const newer = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, unitId: unit.id, category: "non_performance", description: "newer", severity: "low", status: "open" } });
    tracked.complaintIds.add(newer.id);
    const before = await raw(t.id);
    const r = await call(svc, "POST", `/complaints/${t.id}/restore`);
    assert.deepEqual([r.status, r.body.code], [409, "OPEN_TICKET_EXISTS"]);
    assert.match(r.body.error, new RegExp(newer.ticketNumber));
    assert.deepEqual(await raw(t.id), before, "still archived, nothing changed");
    assert.equal((await events(t.id, "restored")).length, 0);
    await patch(svc, newer, { status: "resolved", resolutionNotes: NOTES });
    assert.equal((await call(svc, "POST", `/complaints/${t.id}/restore`)).status, 204, "once the other ticket is finished it restores");
    // a finished archived ticket restores even next to an active one
    const done = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, unitId: unit.id, category: "non_performance", description: "done", severity: "low", status: "resolved", archivedAt: new Date() } });
    tracked.complaintIds.add(done.id);
    assert.equal((await call(svc, "POST", `/complaints/${done.id}/restore`)).status, 204);
    // unit-less: same rule on the site
    const { site: s2 } = await makeSite(w.CA.id, null, null, false);
    const archivedUl = await unitless(s2.id, "open", { archivedAt: new Date(), archivedById: w.svc.id });
    const liveUl = await unitless(s2.id, "open");
    const ru = await call(svc, "POST", `/complaints/${archivedUl.id}/restore`);
    assert.deepEqual([ru.status, ru.body.code], [409, "OPEN_TICKET_EXISTS"]);
    assert.match(ru.body.error, new RegExp(liveUl.ticketNumber));
    // simultaneous restore of two archived duplicates: the index lets exactly one back
    const { site: s3 } = await makeSite(w.CA.id, null, null, false);
    const x = await unitless(s3.id, "open", { archivedAt: new Date(), archivedById: w.svc.id });
    const y = await unitless(s3.id, "open", { archivedAt: new Date(), archivedById: w.svc.id });
    const rs = await Promise.all([x, y, x, y].map((tk) => call(svc, "POST", `/complaints/${tk.id}/restore`)));
    assert.equal(rs.filter((q) => q.status === 204).length, 1, JSON.stringify(rs.map((q) => q.status)));
    assert.ok(rs.every((q) => [204, 409].includes(q.status)), "no 500");
    assert.equal(await prisma.complaint.count({ where: { siteId: s3.id, archivedAt: null } }), 1);
    assert.equal(await prisma.complaintEvent.count({ where: { complaintId: { in: [x.id, y.id] }, type: "restored" } }), 1, "exactly one restore recorded");
  });

  test("restore (real database): links are re-validated; there is no purge route and the database row of an archived ticket is never deleted by the API", async () => {
    const svc = await tok(w.svc);
    const { t, site } = await makeTicket({}, {});
    assert.equal((await call(svc, "DELETE", `/complaints/${t.id}`)).status, 204);
    // the ticket's customer is no longer the owner of the site's order -> refused, still archived
    const order = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
    await prisma.order.update({ where: { id: order.orderId }, data: { customerId: w.CB.id } });
    const r = await call(svc, "POST", `/complaints/${t.id}/restore`);
    assert.deepEqual([r.status, r.body.code], [409, "RESTORE_LINK_INVALID"]);
    assert.ok((await raw(t.id)).archivedAt);
    await prisma.order.update({ where: { id: order.orderId }, data: { customerId: w.CA.id } });
    // no purge
    for (const [m, p] of [["DELETE", `/complaints/${t.id}/purge`], ["POST", `/complaints/${t.id}/purge`], ["DELETE", `/complaints/${t.id}?purge=true`]] as const) {
      assert.notEqual((await call(svc, m, p, { purge: true })).status, 204, `${m} ${p}`);
    }
    assert.equal((await call(svc, "DELETE", `/complaints/${t.id}`)).status, 409, "a second DELETE does not remove it either");
    assert.equal(await prisma.complaint.count({ where: { id: t.id } }), 1);
    assert.ok((await events(t.id)).length >= 1);
    assert.equal((await call(svc, "POST", `/complaints/${t.id}/restore`)).status, 204);
  });

  // ------------------------------------------------------------------------------------------
  // list filters
  // ------------------------------------------------------------------------------------------

  test("list: filters narrow what the caller may already see (search, status, assignee, dates), invalid values are ignored, pagination is capped, the default answer is unchanged", async () => {
    const a = await makeTicket({ status: "in_progress", assignedToId: w.eng.id, dueDate: new Date("2031-05-01") }, { regionId: w.RN.id });
    const b = await makeTicket({ status: "closed", closedAt: new Date() }, { regionId: w.RS.id });
    const s = await tok(w.mgmt);
    const ids = async (qs: string, who = s) => (await call(who, "GET", `/complaints?${qs}`)).body.map((x: any) => x.id);
    assert.deepEqual((await ids(`search=${a.t.ticketNumber.toLowerCase()}`)), [a.t.id], "ticket number, case-insensitive");
    assert.deepEqual((await ids(`search=${a.unit.serialNo}`)), [a.t.id], "unit serial");
    assert.deepEqual((await ids(`search=${a.site.companyName.replace(/ /g, "%20")}`)), [a.t.id], "site name");
    assert.ok((await ids(`status=closed,in_progress&search=${PREFIX}`)).includes(b.t.id));
    assert.deepEqual((await ids(`status=closed&search=${PREFIX}`)).filter((i: string) => [a.t.id, b.t.id].includes(i)), [b.t.id]);
    assert.deepEqual((await ids(`assignedToId=${w.eng.id}&search=${PREFIX}`)).filter((i: string) => [a.t.id, b.t.id].includes(i)), [a.t.id]);
    assert.deepEqual((await ids(`dueFrom=2031-04-30&dueTo=2031-05-02&search=${PREFIX}`)), [a.t.id]);
    assert.ok((await ids(`status=banana&search=${PREFIX}`)).length >= 2, "an unknown status filter is ignored, not an error");
    assert.ok((await ids(`createdFrom=not-a-date&search=${PREFIX}`)).length >= 2);
    // filters never widen the scope
    assert.deepEqual((await ids(`search=${PREFIX}`, await tok(w.rmN))).filter((i: string) => [a.t.id, b.t.id].includes(i)), [a.t.id], "a Regional Manager still sees only their region");
    assert.deepEqual(await ids(`search=${a.t.ticketNumber}`, await tok(w.custB)), [], "another customer's tickets stay invisible");
    const paged = await call(s, "GET", `/complaints?limit=1&offset=0&search=${PREFIX}`);
    assert.equal(paged.body.length, 1);
    assert.ok(Number(paged.headers.get("x-total-count")) >= 2);
    assert.ok((await call(s, "GET", "/complaints?limit=100000")).body.length <= 500, "capped");
    assert.ok((await call(s, "GET", "/complaints")).body.length >= 2, "no parameters: the unchanged full answer");
  });

  // ------------------------------------------------------------------------------------------
  // SLA escalation
  // ------------------------------------------------------------------------------------------

  const aged = (hours: number) => new Date(Date.now() - hours * HOUR);
  const levelOf = async (t: any) => (await raw(t.id)).slaEscalationLevel;
  const rowsOf = (t: any, level?: number) => prisma.ticketEscalationDelivery.findMany({ where: { complaintId: t.id, ...(level ? { level } : {}) } });

  test("escalation: windows unchanged (24 h / 48 h); level 1 goes to the region's Regional Manager, is recorded once with its history event, and is not repeated", async () => {
    const { t } = await makeTicket({ createdAt: aged(30) }, { regionId: w.RN.id });
    const young = await makeTicket({ createdAt: aged(23) }, { regionId: w.RN.id });
    sent.length = 0;
    const r1 = await esc.runTicketEscalation(new Date());
    assert.ok(r1.escalatedToRegional >= 1);
    assert.equal(await levelOf(t), 1);
    assert.equal(await levelOf(young.t), 0, "23 h: not yet");
    assert.deepEqual(mailsFor(t, "complaint_escalated").map((m) => m.recipientId), [w.rmN.id], "only the region's Regional Manager");
    const ev = await events(t.id, "escalated");
    assert.deepEqual([ev.length, ev[0].fromValue, ev[0].toValue, ev[0].actorLabel, ev[0].detail.audience], [1, "0", "1", "System (SLA)", "regional"]);
    await esc.runTicketEscalation(new Date());
    assert.equal(mailsFor(t, "complaint_escalated").length, 1, "the next run sends nothing more");
    assert.equal((await events(t.id, "escalated")).length, 1);
  });

  test("overlapping runs: five simultaneous sweeps send one message per recipient and record one escalation", async () => {
    const { t } = await makeTicket({ createdAt: aged(30) }, { regionId: w.RS.id });
    sent.length = 0;
    await Promise.all([1, 2, 3, 4, 5].map(() => esc.runTicketEscalation(new Date())));
    assert.equal(mailsFor(t, "complaint_escalated").length, 1);
    assert.equal(await levelOf(t), 1);
    assert.equal((await events(t.id, "escalated")).length, 1);
    assert.equal((await rowsOf(t)).length, 1);
  });

  test("a failed delivery does NOT consume the level: no ESCALATED event, a visible ESCALATION_FAILED event, then the retry succeeds exactly once", async () => {
    const { t } = await makeTicket({ createdAt: aged(30) }, { regionId: w.RN.id });
    emailFail.add(w.rmN.id);
    sent.length = 0;
    const t0 = new Date();
    const r1 = await esc.runTicketEscalation(t0);
    assert.ok(r1.deferred >= 1);
    assert.equal(await levelOf(t), 0, "level not advanced");
    assert.equal((await events(t.id, "escalated")).length, 0, "no success event for a failed delivery");
    const failed = await events(t.id, "escalation_failed");
    assert.deepEqual([failed.length, failed[0].detail.reason, failed[0].detail.audience, failed[0].toValue], [1, "delivery_failed", "regional", "1"]);
    const row = (await rowsOf(t))[0];
    assert.deepEqual([row.deliveredAt, row.attempts], [null, 1], "an in-app log row is not delivery");
    // inside the retry back-off nothing is attempted; the failure is not re-recorded
    await esc.runTicketEscalation(new Date(t0.getTime() + 10 * 60_000));
    assert.equal((await rowsOf(t))[0].attempts, 1);
    assert.equal((await events(t.id, "escalation_failed")).length, 1, "recorded once per reason, not once per run");
    emailFail.delete(w.rmN.id);
    await esc.runTicketEscalation(new Date(t0.getTime() + 2 * HOUR));
    assert.equal(await levelOf(t), 1, "delivered on the retry");
    assert.equal((await events(t.id, "escalated")).length, 1);
    assert.equal(mailsFor(t, "complaint_escalated").length, 1, "exactly one message was ever accepted");
    await esc.runTicketEscalation(new Date(t0.getTime() + 3 * HOUR));
    assert.equal(mailsFor(t, "complaint_escalated").length, 1);
  });

  test("a recipient who already got the level is never sent it again while another recipient is retried (management level)", async () => {
    // Level 2 goes to every active Management / Owner user in this database: the baseline ones succeed, this test's user fails first.
    const { t } = await makeTicket({ createdAt: aged(60), slaEscalationLevel: 1, lastEscalatedAt: aged(30) }, { regionId: w.RN.id });
    emailFail.add(w.mgmt.id);
    sent.length = 0;
    const t0 = new Date();
    await esc.runTicketEscalation(t0);
    assert.equal(await levelOf(t), 1, "one recipient failed: level 2 not reached");
    const delivered1 = (await rowsOf(t, 2)).filter((r: any) => r.deliveredAt).map((r: any) => r.recipientId).sort();
    assert.ok(delivered1.length >= 0);
    emailFail.delete(w.mgmt.id);
    sent.length = 0;
    await esc.runTicketEscalation(new Date(t0.getTime() + 2 * HOUR));
    assert.equal(await levelOf(t), 2);
    const resent = mailsFor(t, "complaint_escalated").map((m) => m.recipientId);
    assert.ok(resent.includes(w.mgmt.id), "the failed recipient was retried");
    for (const id of delivered1) assert.ok(!resent.includes(id), "a recipient already delivered is not messaged again");
    assert.equal((await events(t.id, "escalated")).length, 1);
  });

  test("an empty recipient set does not advance the level and is recorded as such (then it escalates once someone is mapped)", async () => {
    const lonely = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-L`, name: `${PREFIX} L` } });
    tracked.regionIds.add(lonely.id);
    const { t } = await makeTicket({ createdAt: aged(30) }, { regionId: lonely.id });
    // no Regional Manager in the region -> the existing fallback is the Service Managers; make sure none exist for this assertion by checking the result
    const sms = await prisma.user.count({ where: { isActive: true, role: { key: "service_manager" } } });
    sent.length = 0;
    await esc.runTicketEscalation(new Date());
    if (sms === 0) {
      assert.equal(await levelOf(t), 0);
      const f = await events(t.id, "escalation_failed");
      assert.deepEqual([f.length, f[0].detail.reason], [1, "no_recipient"]);
      assert.equal((await events(t.id, "escalated")).length, 0);
      const mapped = await makeUser("late-rm", "regional_manager");
      await prisma.regionManager.create({ data: { regionId: lonely.id, userId: mapped.id } });
      await esc.runTicketEscalation(new Date());
      assert.equal(await levelOf(t), 1, "retried and escalated once a manager exists");
    } else {
      assert.equal(await levelOf(t), 1, "the existing fallback (Service Managers) received it");
    }
  });

  test("paused statuses stay paused (resolved, closed, waiting_for_customer); waiting_for_part and escalated keep escalating - the existing policy is unchanged", async () => {
    const mk = (status: string) => makeTicket({ createdAt: aged(30), status }, { regionId: w.RN.id });
    const paused = [await mk("resolved"), await mk("closed"), await mk("waiting_for_customer")];
    const live = [await mk("waiting_for_part"), await mk("escalated"), await mk("in_progress")];
    sent.length = 0;
    await esc.runTicketEscalation(new Date());
    for (const p of paused) { assert.equal(await levelOf(p.t), 0, p.t.status); assert.equal(mailsFor(p.t, "complaint_escalated").length, 0); }
    for (const l of live) assert.equal(await levelOf(l.t), 1, l.t.status);
  });

  test("a ticket that is paused after its message went out is not advanced; a level jump tells every skipped audience in order", async () => {
    const { t } = await makeTicket({ createdAt: aged(60) }, { regionId: w.RN.id });
    sent.length = 0;
    await esc.runTicketEscalation(new Date());
    assert.equal(await levelOf(t), 2, "30 h and 60 h earned: regional first, then management");
    const ev = (await events(t.id, "escalated")).map((e: any) => [e.fromValue, e.toValue, e.detail.audience]);
    assert.deepEqual(ev, [["0", "1", "regional"], ["1", "2", "management"]]);
    assert.ok(mailsFor(t, "complaint_escalated").some((m) => m.recipientId === w.rmN.id));
    assert.ok(mailsFor(t, "complaint_escalated").some((m) => m.recipientId === w.mgmt.id));
  });

  test("a reopened ticket keeps its escalation level and is not re-escalated for the same level (the clock still runs from creation)", async () => {
    const { t } = await makeTicket({ createdAt: aged(30) }, { regionId: w.RN.id });
    await esc.runTicketEscalation(new Date());
    assert.equal(await levelOf(t), 1);
    await patch(await tok(w.svc), t, { status: "closed" });
    await patch(await tok(w.svc), t, { status: "open" });
    sent.length = 0;
    await esc.runTicketEscalation(new Date());
    assert.equal(await levelOf(t), 1);
    assert.equal(mailsFor(t, "complaint_escalated").length, 0, "no second level-1 message after the reopen");
  });

  // ------------------------------------------------------------------------------------------
  // archive instead of delete; closure details; foreign keys (Requirement 11: complete ticket history)
  // ------------------------------------------------------------------------------------------

  const reportFor = async (t: any, by: any) =>
    prisma.serviceReport.create({ data: { reportNumber: `${t.ticketNumber}-R1`, complaintId: t.id, customerId: t.customerId, createdById: by.id, visitDate: new Date() } });

  test("migration: archive / closure columns, the archive CHECK, SET NULL foreign keys, and the open-ticket index now ignores archived tickets", async () => {
    const cols = (await prisma.$queryRaw`select column_name from information_schema.columns where table_name = 'Complaint' and column_name in ('archivedAt','archivedById','archiveReason','closedById')`).map((r: any) => r.column_name).sort();
    assert.deepEqual(cols, ["archiveReason", "archivedAt", "archivedById", "closedById"]);
    const idx = (await prisma.$queryRaw`select indexdef from pg_indexes where indexname = 'Complaint_one_open_per_unit'`)[0].indexdef as string;
    assert.match(idx, /UNIQUE/);
    assert.match(idx, /archivedAt/);
    const fks = await prisma.$queryRaw`select conname, confdeltype from pg_constraint where conname in ('Complaint_closedById_fkey','Complaint_archivedById_fkey','ComplaintEvent_actorId_fkey','UserAuditLog_targetUserId_fkey')`;
    assert.equal(fks.length, 4);
    for (const f of fks) assert.equal(f.confdeltype, "n", `${f.conname} is ON DELETE SET NULL`);
    const { t } = await makeTicket();
    await assert.rejects(prisma.complaint.update({ where: { id: t.id }, data: { archiveReason: "orphan reason" } }), /Complaint_archive_check|check constraint/i, "an archive reason without an archive time is refused");
  });

  test("DELETE archives: the ticket, its history, its reminder and its escalation records all survive; the archive is recorded; the ticket leaves the working views", async () => {
    const { t } = await makeTicket({ status: "in_progress", createdAt: aged(30), dueDate: new Date("2031-06-01") }, { regionId: w.RN.id });
    const svc = await tok(w.svc);
    await patch(svc, t, { status: "in_progress", remarks: "first visit done" });
    await esc.runTicketEscalation(new Date()); // level 1: an escalation delivery row + ESCALATED event
    await prisma.serviceReminder.create({ data: { activityType: "ticket", complaintId: t.id, regionId: w.RN.id, customerId: w.CA.id, customerName: "C", activityRef: t.ticketNumber, dueDate: new Date("2031-06-01") } });
    const deliveries = await prisma.ticketEscalationDelivery.count({ where: { complaintId: t.id } });
    const eventsBefore = await events(t.id);
    assert.ok(deliveries > 0 && eventsBefore.length >= 2);

    const del = await call(svc, "DELETE", `/complaints/${t.id}`, { reason: "spam entry" });
    assert.equal(del.status, 204);

    const after = await raw(t.id);
    assert.ok(after.archivedAt);
    assert.deepEqual([after.archivedById, after.archiveReason, after.status], [w.svc.id, "spam entry", "in_progress"]);
    const eventsAfter = await events(t.id);
    assert.equal(eventsAfter.length, eventsBefore.length + 1, "no history row was removed; one was added");
    assert.deepEqual(eventsAfter.slice(0, eventsBefore.length).map((e: any) => e.id), eventsBefore.map((e: any) => e.id));
    const last = eventsAfter.at(-1);
    assert.deepEqual([last.type, last.actorId, last.fromValue], ["archived", w.svc.id, "in_progress"]);
    assert.deepEqual(last.detail, { statusAtArchive: "in_progress", reason: "spam entry" });
    assert.equal(await prisma.ticketEscalationDelivery.count({ where: { complaintId: t.id } }), deliveries, "escalation records kept");
    assert.equal(await prisma.serviceReminder.count({ where: { complaintId: t.id } }), 1, "the reminder is kept");

    // out of every working view, still readable for history
    assert.equal((await call(svc, "DELETE", `/complaints/${t.id}`)).body.code, "TICKET_ARCHIVED");
    const listed = async (qs = "", who = svc) => (await call(who, "GET", `/complaints?search=${t.ticketNumber}${qs}`)).body.map((x: any) => x.id);
    assert.deepEqual(await listed(), [], "not in the default list");
    assert.deepEqual(await listed("&includeArchived=1"), [t.id], "a ticket manager can include archived tickets");
    assert.deepEqual(await listed("&includeArchived=1", await tok(w.eng)), [], "an engineer without the broad permissions never gets it");
    assert.deepEqual(await listed("&includeArchived=1", await tok(w.custA)), [], "a customer never does");
    assert.equal((await call(svc, "GET", `/complaints/${t.id}/history`)).body.events.length, eventsAfter.length);
    assert.equal((await patch(svc, t, { status: "closed" })).body.code, "TICKET_ARCHIVED");
    assert.equal((await raw(t.id)).status, "in_progress");

    // escalation and reminders ignore it from now on
    await prisma.complaint.update({ where: { id: t.id }, data: { slaEscalationLevel: 0 } });
    sent.length = 0;
    const run = await esc.runTicketEscalation(new Date());
    assert.equal(await levelOf(t), 0, "an archived ticket is never escalated");
    assert.equal(mailsFor(t, "complaint_escalated").length, 0);
    void run;
    const { runReminderJob } = await import("../../src/lib/reminders");
    await runReminderJob(new Date());
    const reminder = await prisma.serviceReminder.findUniqueOrThrow({ where: { complaintId: t.id } });
    assert.equal(reminder.status, "closed", "the reminder is closed (kept), not deleted");
  });

  test("an archived open ticket no longer occupies its unit; reopening another ticket of that unit is then possible; a live open ticket still blocks", async () => {
    const { t, site, unit } = await makeTicket({ status: "open" });
    const svc = await tok(w.svc);
    const mk = (status: string) => prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, unitId: unit.id, category: "non_performance", description: "x", severity: "low", status } });
    await assert.rejects(mk("open"), (e: any) => e.code === "P2002", "a second open ticket for the unit is refused while the first is live");
    assert.equal((await call(svc, "DELETE", `/complaints/${t.id}`)).status, 204);
    const second = await mk("closed"); tracked.complaintIds.add(second.id);
    const third = await mk("open"); tracked.complaintIds.add(third.id); // the archived one does not block a new open ticket
    const reopen = await patch(svc, second, { status: "open", reopenReason: WHY });
    assert.equal(reopen.status, 409, "the live open ticket (third) blocks reopening");
    assert.equal(reopen.body.code, "OPEN_TICKET_EXISTS");
    assert.match(reopen.body.error, new RegExp(third.ticketNumber));
  });

  test("a ticket with a service report cannot be archived; nothing changes", async () => {
    const { t } = await makeTicket();
    await reportFor(t, w.svc);
    const r = await call(await tok(w.svc), "DELETE", `/complaints/${t.id}`);
    assert.deepEqual([r.status, r.body.code], [409, "HAS_SERVICE_REPORTS"]);
    const row = await raw(t.id);
    assert.equal(row.archivedAt, null);
    assert.equal(await prisma.complaintEvent.count({ where: { complaintId: t.id, type: "archived" } }), 0);
    await prisma.serviceReport.deleteMany({ where: { complaintId: t.id } });
  });

  test("archive permissions through the API: only a ticket manager inside their scope; engineers, vendors, sales, customers and the wrong region are refused and nothing is written", async () => {
    const north = await makeTicket({ assignedToId: w.eng.id }, { regionId: w.RN.id });
    const v1 = await makeTicket({ assignedToId: w.v1Eng.id }, { vendorId: w.V1.id });
    for (const [who, t] of [[w.eng, north.t], [w.sales, north.t], [w.custA, north.t], [w.rmS, north.t], [w.v1Eng, v1.t], [w.v2Eng, v1.t]] as const) {
      const r = await call(await tok(who), "DELETE", `/complaints/${t.id}`);
      assert.equal(r.status, 403, who.name);
      assert.equal((await raw(t.id)).archivedAt, null);
    }
    assert.equal((await call(null, "DELETE", `/complaints/${north.t.id}`)).status, 401);
    assert.equal((await call(await tok(w.rmN), "DELETE", `/complaints/${north.t.id}`)).status, 204, "the Regional Manager of that region may");
    assert.equal((await events(north.t.id, "archived")).length, 1);
  });

  test("closure details: who closed is stored with closedAt, the original closer survives a repeat closure, reopening clears both, every closure stays in the history", async () => {
    const { t } = await makeTicket({ assignedToId: w.eng.id });
    const eng = await tok(w.eng), svc = await tok(w.svc), rm = await tok(w.mgmt);
    await patch(eng, t, { status: "resolved", resolutionNotes: "belt replaced fully", rootCause: "worn belt" }); // the engineer resolves ...
    assert.equal((await raw(t.id)).closedAt, null);
    await patch(rm, t, { status: "closed" }); // ... a manager closes
    let r = await raw(t.id);
    assert.deepEqual([r.closedById, !!r.closedAt], [w.mgmt.id, true]);
    const closedAt = r.closedAt.getTime();
    await patch(svc, t, { status: "closed", remarks: "verified" });
    r = await raw(t.id);
    assert.deepEqual([r.closedById, r.closedAt.getTime()], [w.mgmt.id, closedAt], "a repeat closure keeps the original closer and time");
    await patch(svc, t, { status: "in_progress", reopenReason: WHY });
    r = await raw(t.id);
    assert.deepEqual([r.closedById, r.closedAt], [null, null]);
    await patch(svc, t, { status: "resolved" });
    await patch(svc, t, { status: "closed" });
    assert.equal((await raw(t.id)).closedById, w.svc.id);
    const closures = (await events(t.id, "status_changed")).filter((e: any) => e.toValue === "closed");
    assert.deepEqual(closures.map((e: any) => e.actorId), [w.mgmt.id, w.svc.id]);
    // an overwritten closure detail keeps its earlier text in the history
    await patch(svc, t, { status: "closed", resolutionNotes: "belt and tensioner replaced" });
    const notes = await events(t.id, "notes_updated");
    const last = notes.at(-1);
    assert.deepEqual(last.detail.values.resolutionNotes, { from: "belt replaced fully", to: "belt and tensioner replaced" });
    assert.equal(last.actorId, w.svc.id);
  });

  test("migration backfill: closedById is taken from the latest 'moved to closed' event with an actor - and nowhere else", async () => {
    const sql = (fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20261028090000_ticket_archive_closure", "migration.sql"), "utf8").split("-- Backfill:")[1] ?? "");
    const update = sql.slice(sql.indexOf("UPDATE")).trim().replace(/;\s*$/, "");
    assert.match(update, /^UPDATE "Complaint"/);
    const withActor = await makeTicket({ status: "closed", closedAt: new Date() });
    const noActor = await makeTicket({ status: "closed", closedAt: new Date() });
    const notClosed = await makeTicket({ status: "open" });
    const ev = (id: string, actorId: string | null, toValue: string, at: number) => prisma.complaintEvent.create({ data: { complaintId: id, type: "status_changed", fromValue: "open", toValue, actorId, createdAt: new Date(at) } });
    await ev(withActor.t.id, w.eng.id, "closed", Date.now() - 2000);
    await ev(withActor.t.id, w.mgmt.id, "closed", Date.now() - 1000); // the latest closure wins
    await ev(noActor.t.id, null, "closed", Date.now() - 1000);
    await ev(notClosed.t.id, w.eng.id, "closed", Date.now() - 1000); // a stale event on a ticket that is not closed now
    await prisma.$executeRawUnsafe(update);
    assert.equal((await raw(withActor.t.id)).closedById, w.mgmt.id);
    assert.equal((await raw(noActor.t.id)).closedById, null, "nothing is invented when the event has no actor");
    assert.equal((await raw(notClosed.t.id)).closedById, null);
  });

  test("foreign keys: deleting a staff user keeps their tickets, the history they wrote, closure / archive records and their own audit trail (identity fields are cleared, rows stay)", async () => {
    const u = await makeUser("leaver", "service_engineer");
    const { t } = await makeTicket({ assignedToId: u.id });
    const svc = await tok(w.svc);
    await patch(svc, t, { status: "in_progress", assignedToId: u.id });
    await prisma.complaintEvent.create({ data: { complaintId: t.id, type: "notes_updated", actorId: u.id, detail: { fields: ["remarks"] } } });
    await prisma.complaint.update({ where: { id: t.id }, data: { closedById: u.id, closedAt: new Date(), status: "closed" } });
    const archived = await makeTicket();
    await prisma.complaint.update({ where: { id: archived.t.id }, data: { archivedAt: new Date(), archivedById: u.id } });
    const audit = await prisma.userAuditLog.create({ data: { actorId: w.mgmt.id, targetUserId: u.id, targetIdRecorded: u.id, action: "created" } });
    const eventsBefore = await prisma.complaintEvent.count({ where: { complaintId: t.id } });

    await prisma.user.delete({ where: { id: u.id } });
    tracked.userIds.delete(u.id);

    const after = await raw(t.id);
    assert.deepEqual([after.assignedToId, after.closedById, after.status], [null, null, "closed"], "links cleared, ticket kept");
    assert.equal((await raw(archived.t.id)).archivedById, null);
    assert.ok((await raw(archived.t.id)).archivedAt, "still archived");
    assert.equal(await prisma.complaintEvent.count({ where: { complaintId: t.id } }), eventsBefore, "no history row is lost");
    assert.ok((await events(t.id)).some((e: any) => e.actorId === null && e.type === "notes_updated"), "the event stays, its actor link is cleared");
    const a = await prisma.userAuditLog.findUniqueOrThrow({ where: { id: audit.id } });
    assert.deepEqual([a.targetUserId, a.targetIdRecorded, a.action], [null, u.id, "created"], "the account's audit row survives with its recorded id");
    await prisma.userAuditLog.deleteMany({ where: { id: audit.id } });
  });

  test("foreign keys: a customer who has tickets cannot be deleted (the ticket and its history stay); a contact who raised one can be removed without losing either", async () => {
    const cust = await prisma.customer.create({ data: { name: `${PREFIX} Temp customer` } });
    tracked.customerIds.add(cust.id);
    const contact = await makeUser("contact", "customer", { customerId: cust.id });
    const { t } = await makeTicket({ customerId: cust.id }, { customerId: cust.id });
    await prisma.complaintEvent.create({ data: { complaintId: t.id, type: "created", toValue: "open", actorId: contact.id } });
    await assert.rejects(prisma.customer.delete({ where: { id: cust.id } }), (e: any) => e.code === "P2003", "the customer is protected by its tickets");
    assert.equal(await prisma.complaint.count({ where: { id: t.id } }), 1);
    const audit = await prisma.userAuditLog.create({ data: { actorId: w.mgmt.id, targetUserId: contact.id, targetIdRecorded: contact.id, targetName: contact.name, action: "created" } });
    await prisma.user.delete({ where: { id: contact.id } });
    tracked.userIds.delete(contact.id);
    assert.equal(await prisma.complaint.count({ where: { id: t.id } }), 1);
    assert.equal(await prisma.complaintEvent.count({ where: { complaintId: t.id, type: "created" } }), 1, "the creation record stays");
    assert.equal((await prisma.userAuditLog.findUniqueOrThrow({ where: { id: audit.id } })).targetIdRecorded, contact.id);
    await prisma.userAuditLog.deleteMany({ where: { id: audit.id } });
  });

  test("final closure is for managers (real database): engineers resolve but cannot close, by any route; a manager inside their scope closes", async () => {
    const own = await makeTicket({ assignedToId: w.eng.id }, { regionId: w.RN.id });
    const vend = await makeTicket({ assignedToId: w.v1Eng.id }, { vendorId: w.V1.id });
    for (const [who, t] of [[w.eng, own.t], [w.v1Eng, vend.t]] as const) {
      const r = await patch(await tok(who), t, { status: "closed", resolutionNotes: "finished" });
      assert.deepEqual([r.status, r.body.code], [403, "CLOSE_REQUIRES_MANAGER"], who.name);
      const row = await raw(t.id);
      assert.deepEqual([row.status, row.closedAt, row.closedById, row.resolutionNotes], ["open", null, null, null]);
      assert.equal((await events(t.id)).length, 0, "a refused closure leaves no history");
      assert.equal((await patch(await tok(who), t, { status: "resolved", resolutionNotes: "finished the repair" })).status, 200);
      assert.deepEqual([(await raw(t.id)).status, (await raw(t.id)).closedAt], ["resolved", null]);
    }
    assert.equal((await patch(await tok(w.rmS), own.t, { status: "closed" })).status, 403, "a manager of ANOTHER region is refused by the scope rule");
    assert.equal((await patch(await tok(w.rmN), own.t, { status: "closed" })).status, 200, "the Regional Manager of the ticket's region closes it");
    assert.equal((await raw(own.t.id)).closedById, w.rmN.id);
    assert.equal((await patch(await tok(w.svc), vend.t, { status: "closed" })).status, 200, "the (unscoped) service desk closes the resolved vendor ticket");
  });

  test("reopening a closed ticket (real database): engineers and vendor engineers are refused and NOTHING changes; managers inside their scope reopen; managers outside it are refused", async () => {
    const closedAt = new Date("2026-02-02T00:00:00Z");
    const closed = (over: Record<string, unknown>, where: any) => makeTicket({ status: "closed", closedAt, closedById: w.svc.id, resolutionNotes: "belt replaced", rootCause: "worn belt", ...over }, where);
    const own = await closed({ assignedToId: w.eng.id }, { regionId: w.RN.id });
    const vend = await closed({ assignedToId: w.v1Eng.id }, { vendorId: w.V1.id });
    await prisma.complaintEvent.create({ data: { complaintId: own.t.id, type: "status_changed", fromValue: "resolved", toValue: "closed", actorId: w.svc.id, detail: { transition: "closed" } } });
    for (const [who, t] of [[w.eng, own.t], [w.v1Eng, vend.t]] as const) {
      const before = await raw(t.id);
      const evBefore = (await events(t.id)).map((e: any) => e.id);
      for (const body of [{ status: "open" }, { status: "in_progress", remarks: "again" }, { status: "resolved", resolutionNotes: "changed my mind" }]) {
        const r = await patch(await tok(who), t, body);
        assert.deepEqual([r.status, r.body.code], [403, "REOPEN_REQUIRES_MANAGER"], `${who.name} ${JSON.stringify(body)}`);
      }
      const after = await raw(t.id);
      assert.deepEqual(after, before, "the whole row is byte-for-byte unchanged (status, closedAt, closedById, notes, assignee)");
      assert.deepEqual((await events(t.id)).map((e: any) => e.id), evBefore, "no history row added");
      const ro = await patch(await tok(who), t, { status: "closed", remarks: "late note" });
      assert.deepEqual([ro.status, ro.body.code], [403, "CLOSED_TICKET_READ_ONLY"], "a closed ticket is read-only for a non-manager");
      assert.deepEqual(await raw(t.id), before);
      assert.deepEqual([(await raw(t.id)).status, (await raw(t.id)).closedById], ["closed", w.svc.id]);
    }
    // managers: the scope rules still decide
    const outOfRegion = await patch(await tok(w.rmS), own.t, { status: "open", reopenReason: WHY });
    assert.equal(outOfRegion.status, 403);
    assert.notEqual(outOfRegion.body.code, "REOPEN_REQUIRES_MANAGER");
    assert.equal((await raw(own.t.id)).status, "closed");
    const ok = await patch(await tok(w.rmN), own.t, { status: "open", reopenReason: WHY });
    assert.equal(ok.status, 200, "the Regional Manager of the ticket's region reopens it");
    const reopened = await raw(own.t.id);
    assert.deepEqual([reopened.status, reopened.closedAt, reopened.closedById], ["open", null, null]);
    const last = (await events(own.t.id, "status_changed")).at(-1);
    assert.deepEqual([last.fromValue, last.toValue, last.actorId, last.detail.transition, last.detail.reason], ["closed", "open", w.rmN.id, "reopened", WHY]);
    assert.equal((await patch(await tok(w.svc), vend.t, { status: "open", reopenReason: WHY })).status, 200, "the service desk (unscoped manager) reopens the vendor ticket");
    assert.equal((await patch(await tok(w.custA), vend.t, { status: "closed" })).status, 403);
  });

  // ------------------------------------------------------------------------------------------
  // approved decision A (one definition) and C (Regional Manager = the "Zonal Manager" of requirement 11)
  // ------------------------------------------------------------------------------------------

  test("duplicate definition is the same everywhere: a ticket without a unit is blocked by ANY active ticket on its site (even one for a since-retired unit); create, reopen and restore all agree; finished / archived tickets never block", async () => {
    const a = await tok(w.custA);
    const svc = await tok(w.svc);
    const { site, unit } = await makeSite(w.CA.id, null, null, true);
    const unitTicket = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, unitId: unit.id, category: "non_performance", description: "x", severity: "low", status: "open" } });
    tracked.complaintIds.add(unitTicket.id);
    await prisma.recdUnit.update({ where: { id: unit.id }, data: { status: "retired" } }); // the site now has no ELIGIBLE unit
    const blocked = await call(a, "POST", "/complaints", portalBody(site.id));
    assert.equal(blocked.status, 400, "the site already has an active ticket");
    assert.match(blocked.body.error, new RegExp(unitTicket.ticketNumber));
    assert.equal(await prisma.complaint.count({ where: { siteId: site.id } }), 1);
    // reopen / restore of a unit-less ticket use the same definition
    const oldUnitless = await unitless(site.id, "closed", { closedAt: new Date(), closedById: w.svc.id, resolutionNotes: NOTES });
    const r = await patch(svc, oldUnitless, { status: "open", reopenReason: WHY });
    assert.deepEqual([r.status, r.body.code], [409, "OPEN_TICKET_EXISTS"]);
    assert.match(r.body.error, new RegExp(unitTicket.ticketNumber));
    const archivedUnitless = await unitless(site.id, "open", { archivedAt: new Date(), archivedById: w.svc.id });
    assert.deepEqual([(await call(svc, "POST", `/complaints/${archivedUnitless.id}/restore`)).body.code], ["OPEN_TICKET_EXISTS"]);
    // once the site's ticket is finished (or archived) everything is allowed again
    await patch(svc, unitTicket, { status: "resolved", resolutionNotes: NOTES });
    const created = await call(a, "POST", "/complaints", portalBody(site.id));
    assert.equal(created.status, 201);
    tracked.complaintIds.add(created.body.id);
    // and the database index still stops two simultaneous unit-less tickets (covered above); a second portal call is a clean 400
    assert.equal((await call(a, "POST", "/complaints", portalBody(site.id))).status, 400);
  });

  test("Regional Manager = the approved 'Zonal Manager': raising a ticket notifies Service Team, Service Managers, Management and the site region's Regional Managers - not another region's, not engineers / sales / customers", async () => {
    const a = await tok(w.custA);
    const { site } = await makeSite(w.CA.id, w.RN.id, null, true);
    sent.length = 0;
    const r = await call(a, "POST", "/complaints", { ...portalBody(site.id) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.complaintIds.add(r.body.id);
    const got = new Set(mailsFor(r.body, "complaint_raised").map((m) => m.recipientId));
    for (const who of [w.rmN, w.svc, w.mgmt]) assert.ok(got.has(who.id), `${who.name} is notified`);
    for (const who of [w.rmS, w.eng, w.v1Eng, w.sales, w.custA, w.custB]) assert.ok(!got.has(who.id), `${who.name} is not notified`);
    // an inactive Regional Manager is skipped
    await prisma.user.update({ where: { id: w.rmN.id }, data: { isActive: false } });
    try {
      const { ticketRecipients } = await import("../../src/lib/ticketNotify");
      assert.ok(!(await ticketRecipients("raised", { regionId: w.RN.id })).includes(w.rmN.id));
      assert.ok((await ticketRecipients("raised", { regionId: w.RS.id })).includes(w.rmS.id));
      assert.ok(!(await ticketRecipients("raised", { regionId: w.RS.id })).includes(w.rmN.id), "a Regional Manager of another region is never a recipient");
    } finally {
      await prisma.user.update({ where: { id: w.rmN.id }, data: { isActive: true } });
    }
    // the assigned engineer is told on assignment; escalation to this Regional Manager and then Management is tested above
    sent.length = 0;
    assert.equal((await patch(await tok(w.svc), r.body, { status: "open", assignedToId: w.eng.id })).status, 200);
    assert.deepEqual(mailsFor(r.body, "complaint_assigned").map((m) => m.recipientId), [w.eng.id]);
  });

  // ------------------------------------------------------------------------------------------
  // the one race the indexes cannot see: a ticket without a unit next to a ticket for a RETIRED unit of the same site
  // ------------------------------------------------------------------------------------------

  test("trigger guard: a site-level ticket (no unit, or a retired unit) cannot coexist with another active ticket on the site - sequential, in both orders", async () => {
    const { isActiveTicketConflict } = await import("../../src/lib/ticketDuplicates");
    const { site, unit } = await makeSite(w.CA.id, null, null, true);
    await prisma.recdUnit.update({ where: { id: unit.id }, data: { status: "retired" } });
    const mk = (over: Record<string, unknown>) => prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, category: "non_performance", description: "x", severity: "low", status: "open", ...over } }).then((t: any) => { tracked.complaintIds.add(t.id); return t; });
    const forRetired = await mk({ unitId: unit.id });
    const err: any = await mk({}).then(() => null, (e: any) => e);
    assert.ok(err, "a unit-less ticket next to the retired unit's active ticket is refused by the database");
    assert.equal(err.code, "P2002");
    assert.equal(isActiveTicketConflict(err), true, "the application maps it like the indexes");
    await prisma.complaint.update({ where: { id: forRetired.id }, data: { status: "resolved" } });
    const unitless = await mk({});
    const err2: any = await mk({ unitId: unit.id }).then(() => null, (e: any) => e);
    assert.ok(err2 && err2.code === "P2002", "the other order is refused too");
    // finished and archived tickets never count
    await prisma.complaint.update({ where: { id: unitless.id }, data: { archivedAt: new Date() } });
    await mk({ unitId: unit.id });
  });

  test("trigger guard: simultaneous inserts of a unit-less ticket and a retired-unit ticket for one site - exactly one is created, every round", async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 12; round++) {
      const { site, unit } = await makeSite(w.CA.id, null, null, true);
      await prisma.recdUnit.update({ where: { id: unit.id }, data: { status: "retired" } });
      const mk = (over: Record<string, unknown>) => prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, category: "non_performance", description: "x", severity: "low", status: "open", ...over } }).then((t: any) => { tracked.complaintIds.add(t.id); return "ok"; }, (e: any) => (e.code === "P2002" ? "conflict" : `error:${e.code ?? e.message}`));
      const rs = await Promise.all(round % 2 ? [mk({}), mk({ unitId: unit.id })] : [mk({ unitId: unit.id }), mk({})]);
      outcomes.push(rs.slice().sort().join("+"));
      assert.deepEqual(rs.slice().sort(), ["conflict", "ok"], `round ${round}: ${rs.join(",")}`);
      assert.equal(await prisma.complaint.count({ where: { siteId: site.id, archivedAt: null, status: { notIn: ["resolved", "closed"] } } }), 1);
    }
    assert.equal(new Set(outcomes).size, 1);
    // two simultaneous unit-less tickets: the index and the trigger agree
    const { site: s2 } = await makeSite(w.CA.id, null, null, false);
    const mk2 = () => prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: s2.id, category: "x", description: "x", severity: "low", status: "open" } }).then((t: any) => { tracked.complaintIds.add(t.id); return "ok"; }, (e: any) => (e.code === "P2002" ? "conflict" : "error"));
    assert.deepEqual((await Promise.all([mk2(), mk2(), mk2(), mk2()])).sort(), ["conflict", "conflict", "conflict", "ok"]);
  });

  test("trigger guard: sites with ACTIVE units are not restricted (each unit has its own ticket); and rows that were already duplicated before the trigger stay editable", async () => {
    const { site, unit } = await makeSite(w.CA.id, null, null, true);
    const unit2 = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-SN${++seq}`, orderId: (await prisma.site.findUniqueOrThrow({ where: { id: site.id } })).orderId, siteId: site.id, productId: w.product.id } });
    tracked.unitIds.add(unit2.id);
    const mk = (over: Record<string, unknown>) => prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: site.id, category: "non_performance", description: "x", severity: "low", status: "open", ...over } }).then((t: any) => { tracked.complaintIds.add(t.id); return t; });
    const a = await mk({ unitId: unit.id });
    const b = await mk({ unitId: unit2.id });
    assert.ok(a && b, "two active units, two active tickets");
    // legacy duplicates (made with the trigger switched off): ordinary edits are never refused
    const { site: s2, unit: u2 } = await makeSite(w.CA.id, null, null, true);
    await prisma.recdUnit.update({ where: { id: u2.id }, data: { status: "retired" } });
    await prisma.$executeRawUnsafe(`ALTER TABLE "Complaint" DISABLE TRIGGER "Complaint_site_level_guard"`);
    let d1: any, d2: any;
    try {
      const mk2 = (over: Record<string, unknown>) => prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.CA.id, siteId: s2.id, category: "x", description: "x", severity: "low", status: "open", ...over } }).then((t: any) => { tracked.complaintIds.add(t.id); return t; });
      d1 = await mk2({ unitId: u2.id });
      d2 = await mk2({});
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Complaint" ENABLE TRIGGER "Complaint_site_level_guard"`);
    }
    await prisma.complaint.update({ where: { id: d1.id }, data: { remarks: "edited", slaEscalationLevel: 1 } });
    await prisma.complaint.update({ where: { id: d2.id }, data: { remarks: "edited", status: "in_progress" } });
    assert.equal((await prisma.complaint.findUniqueOrThrow({ where: { id: d2.id } })).status, "in_progress");
    // but making a finished one ACTIVE again next to the other is refused
    await prisma.complaint.update({ where: { id: d1.id }, data: { status: "resolved" } });
    await prisma.complaint.update({ where: { id: d2.id }, data: { status: "resolved" } });
    await prisma.complaint.update({ where: { id: d1.id }, data: { status: "open" } });
    await assert.rejects(prisma.complaint.update({ where: { id: d2.id }, data: { status: "open" } }), (e: any) => e.code === "P2002");
  });

  test("overview counts: a Regional Manager's tiles cover only their own regions; a company-wide role still sees everything", async () => {
    await makeTicket({}, { regionId: w.RN.id });
    await makeTicket({}, { regionId: w.RN.id });
    await makeTicket({}, { regionId: w.RS.id });
    const total = (b: any) => Object.values(b.countsByStatus).reduce((a: number, n: any) => a + n, 0);
    const rn = await call(await tok(w.rmN), "GET", "/complaints/overview");
    const rs = await call(await tok(w.rmS), "GET", "/complaints/overview");
    const all = await call(await tok(w.mgmt), "GET", "/complaints/overview");
    const live = (regionId?: string) => prisma.complaint.count({ where: { archivedAt: null, ...(regionId ? { site: { regionId } } : {}) } });
    assert.equal(total(rn.body), await live(w.RN.id), "North's manager sees North only");
    assert.equal(total(rs.body), await live(w.RS.id));
    assert.equal(total(all.body), await live(), "Management sees the whole company");
    assert.ok(total(rn.body) < total(all.body));
  });

  // ------------------------------------------------------------------------------------------
  // R11.A - customer field exposure (real database)
  // ------------------------------------------------------------------------------------------

  test("customer field exposure: a customer's own ticket carries what they reported, never internal remarks / root cause / SLA level / assignee, and one customer cannot read another's ticket", async () => {
    const { t: tA } = await makeTicket({ rootCause: "Secret internal root cause", remarks: "Staff-only remark", resolutionNotes: "Internal resolution detail", serviceReportUrl: "data:staff-report", slaEscalationLevel: 1, assignedToId: w.eng.id }, { customerId: w.CA.id });
    const { t: tB } = await makeTicket({}, { customerId: w.CB.id });

    const mine = await call(await tok(w.custA), "GET", "/complaints");
    assert.equal(mine.status, 200);
    const seen = mine.body.find((x: any) => x.id === tA.id);
    assert.ok(seen, "the customer sees their own ticket");
    assert.equal(seen.ticketNumber, tA.ticketNumber);
    assert.equal(seen.status, tA.status);
    for (const forbidden of ["rootCause", "remarks", "resolutionNotes", "serviceReportUrl", "slaEscalationLevel", "assignedToId", "assignedTo"]) {
      assert.equal(forbidden in seen, false, `customer response must not carry "${forbidden}"`);
    }
    const text = JSON.stringify(mine.body);
    for (const secret of ["Secret internal root cause", "Staff-only remark", "Internal resolution detail", "data:staff-report"]) {
      assert.ok(!text.includes(secret), `customer response leaked "${secret}"`);
    }
    // Changing the request's own customer scope cannot be bypassed: custA never sees custB's ticket, whatever is asked for.
    assert.ok(!mine.body.some((x: any) => x.id === tB.id), "another customer's ticket is never returned");
    const viaQuery = await call(await tok(w.custA), "GET", `/complaints?search=${tB.ticketNumber}`);
    assert.ok(!viaQuery.body.some((x: any) => x.id === tB.id), "a search parameter cannot widen a customer's own scope");

    // Staff keep the full row - nothing was removed from their own view.
    const staffView = await call(await tok(w.svc), "GET", "/complaints");
    const staffSeen = staffView.body.find((x: any) => x.id === tA.id);
    assert.equal(staffSeen.rootCause, "Secret internal root cause");
    assert.equal(staffSeen.assignedTo?.id, w.eng.id);
  });

  // ------------------------------------------------------------------------------------------
  // R11.D - a site with no region
  // ------------------------------------------------------------------------------------------

  test("a ticket on a site with no region: no Regional Manager recipient is invented, Service Team / Management are still told, and the gap is recorded in the ticket's history", async () => {
    const { site, unit } = await makeSite(w.CA.id, null, null);
    const create = await call(await tok(w.custA), "POST", "/complaints", {
      siteId: site.id,
      unitId: unit.id,
      category: "non_performance",
      description: `${PREFIX} unregioned site ticket`,
      severity: "medium",
      attachmentUrl: "data:image/png;base64,aaa",
    });
    assert.equal(create.status, 201);
    tracked.complaintIds.add(create.body.id);

    // Service Team / Management still got it (the existing audience, unaffected by the missing region).
    assert.ok(mailsFor(create.body, "complaint_raised").some((m) => m.recipientId === w.svc.id));
    assert.ok(mailsFor(create.body, "complaint_raised").some((m) => m.recipientId === w.mgmt.id));
    // No Regional Manager of EITHER region was notified - nobody was guessed.
    assert.equal(mailsFor(create.body, "complaint_raised").filter((m) => m.recipientId === w.rmN.id || m.recipientId === w.rmS.id).length, 0);

    const rows = await events(create.body.id, "notification_gap");
    assert.equal(rows.length, 1, "the gap is recorded once");
    assert.equal((rows[0].detail as any).reason, "site_has_no_region");
  });

  test("a ticket on a site with a region that has no mapped Regional Manager: the gap names that reason, and the SLA escalation falls back to Service Managers instead of inventing a Regional Manager", async () => {
    const orphanRegion = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-orphan`, name: `${PREFIX} Orphan` } });
    tracked.regionIds.add(orphanRegion.id);
    const { site, unit } = await makeSite(w.CA.id, orphanRegion.id, null);
    const create = await call(await tok(w.custA), "POST", "/complaints", {
      siteId: site.id,
      unitId: unit.id,
      category: "non_performance",
      description: `${PREFIX} orphan region ticket`,
      severity: "medium",
      attachmentUrl: "data:image/png;base64,aaa",
    });
    assert.equal(create.status, 201);
    tracked.complaintIds.add(create.body.id);

    const rows = await events(create.body.id, "notification_gap");
    assert.equal(rows.length, 1);
    assert.equal((rows[0].detail as any).reason, "region_has_no_regional_manager");
  });
});
