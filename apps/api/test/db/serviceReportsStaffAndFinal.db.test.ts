/**
 * Real-database tests for Requirement 4, part 2: (A) the STAFF list of service reports with its role/scope rules and filters, and
 * (B) the immutability of a FINAL (signed or submitted) report - at the database (triggers, foreign keys) and through the API.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; removed in `after`). The one
 * exception to "never delete a final report" is that clean-up, which switches the delete guard off for the rows of THIS run and on again
 * straight after. No real signature or document is used; all names are synthetic. Nothing is sent anywhere.
 *   Needs migration 20261101090000_signed_report_immutability (npm run test:db --workspace=apps/api).
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { makePng, pngDataUrl } from "../helpers/png";

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
describe("service report staff list and final-report immutability against the real test database", { skip }, () => {
  const PREFIX = `ZS${Date.now().toString(36).toUpperCase()}`;
  const tracked = {
    userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), complaintIds: new Set<string>(),
    unitIds: new Set<string>(), regionIds: new Set<string>(), vendorIds: new Set<string>(), amcIds: new Set<string>(),
  };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let setStorage: (s: any) => void;
  let productId = "";
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const W: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }

  /** customer + contact login + order/site (in a region, with a vendor) + unit + a closed ticket assigned to `engineer`. */
  async function makeSide(tag: string, region: any, vendor: any, engineer: any) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    tracked.customerIds.add(customer.id);
    const contact = await makeUser(`${tag} contact`, "customer", { customerId: customer.id });
    const order = await prisma.order.create({
      data: {
        orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 1,
        site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, address: `${tag} Estate`, regionId: region.id, vendorId: vendor.id } },
      },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-${tag}-SN`, orderId: order.id, siteId: order.site.id, productId } });
    tracked.unitIds.add(unit.id);
    const ticket = await makeTicket({ customer, site: order.site, unit }, engineer);
    const amc = await prisma.amcOrder.create({
      data: { poNo: `${PREFIX}-${tag}-PO`, poDate: new Date("2026-04-01"), customerId: customer.id, location: `${tag} city`, item: "RECD", qty: 1, amcFrequencyPerYear: 4, amcType: "camc", units: { create: [{ unitId: unit.id }] } },
    });
    tracked.amcIds.add(amc.id);
    return { customer, contact, order, site: order.site, unit, ticket, amc };
  }

  async function makeTicket(w: { customer: any; site: any; unit: any }, engineer: any) {
    const t = await prisma.complaint.create({
      data: {
        ticketNumber: `${PREFIX}-T${++seq}`, customerId: w.customer.id, siteId: w.site.id, unitId: w.unit.id, category: "non_performance", description: `${PREFIX} ticket`,
        severity: "medium", status: "closed", assignedToId: engineer.id, serviceReportUrl: "data:application/pdf;base64,AAAA",
      },
    });
    tracked.complaintIds.add(t.id);
    return t;
  }

  const tokenOf = (user: any) => signToken({ userId: user.id, roleKey: "x", customerId: user.customerId ?? null });
  async function call(as: any, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenOf(as)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { json = null; }
    return { status: res.status, body: json };
  }
  const fields = { visitDate: "2026-10-14", workPerformed: "Replaced the gasket.", findings: "Exhaust leak at the flange.", resolution: "Leak sealed." };
  const sign = (as: any, r: any) => call(as, "POST", `/service-reports/${r.id}/sign`, { signerName: "Asha Rao", signatureImage: pngDataUrl(makePng()), version: r.version, confirm: true });

  async function ticketReport(side: any, staff: any, ticket = side.ticket) {
    const c = await call(staff, "POST", "/service-reports", { complaintId: ticket.id, ...fields });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    return c.body;
  }
  async function signedTicketReport(side: any, staff: any, ticket = side.ticket) {
    const d = await ticketReport(side, staff, ticket);
    const s = await call(staff, "POST", `/service-reports/${d.id}/submit`, { expectedVersion: d.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const signed = await sign(side.contact, s.body);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    return signed.body;
  }
  const row = (id: string) => prisma.serviceReport.findUniqueOrThrow({ where: { id } });

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ setReportStorageForTests: setStorage } = await import("../../src/lib/reportStorage"));
    setStorage(undefined);

    const { serviceReportsRouter } = await import("../../src/routes/serviceReports");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/service-reports", serviceReportsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_engineer", "management", "sales", "regional_manager"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;

    W.R1 = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-1`, name: `${PREFIX} R1` } });
    W.R2 = await prisma.region.create({ data: { key: `${PREFIX.toLowerCase()}-2`, name: `${PREFIX} R2` } });
    tracked.regionIds.add(W.R1.id).add(W.R2.id);
    for (const n of [1, 2]) {
      W[`V${n}`] = await prisma.vendor.create({ data: { name: `${PREFIX} V${n}`, status: "approved", contactName: "c", contactEmail: `${PREFIX.toLowerCase()}-v${n}@example.test` } });
      tracked.vendorIds.add(W[`V${n}`].id);
    }
    W.mgmt = await makeUser("manager", "management");
    W.sales = await makeUser("sales", "sales");
    W.eng1 = await makeUser("engineer 1", "service_engineer");
    W.eng2 = await makeUser("engineer 2", "service_engineer");
    W.vendor1 = await makeUser("vendor user 1", "service_engineer", { vendorId: W.V1.id });
    W.rm1 = await makeUser("regional 1", "regional_manager");
    await prisma.regionManager.create({ data: { regionId: W.R1.id, userId: W.rm1.id } });

    W.A = await makeSide("A", W.R1, W.V1, W.eng1);
    W.B = await makeSide("B", W.R2, W.V2, W.eng2);
  });

  after(async () => {
    server?.close();
    setStorage?.(undefined);
    try {
      if (prisma) {
        const complaintIds = [...tracked.complaintIds];
        const reports = await prisma.serviceReport.findMany({
          where: { OR: [{ complaintId: { in: complaintIds } }, { amcOrderId: { in: [...tracked.amcIds] } }] },
          select: { id: true, signatureFileId: true, pdfFileId: true },
        });
        await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" DISABLE TRIGGER "ServiceReport_final_no_delete"');
        try {
          await prisma.serviceReport.deleteMany({ where: { id: { in: reports.map((r: any) => r.id) } } });
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" ENABLE TRIGGER "ServiceReport_final_no_delete"');
        }
        await prisma.reportFile.deleteMany({ where: { id: { in: reports.flatMap((r: any) => [r.signatureFileId, r.pdfFileId]).filter(Boolean) } } });
        await prisma.complaint.deleteMany({ where: { id: { in: complaintIds } } });
        await prisma.amcOrder.deleteMany({ where: { id: { in: [...tracked.amcIds] } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
        await prisma.region.deleteMany({ where: { id: { in: [...tracked.regionIds] } } });
        await prisma.vendor.deleteMany({ where: { id: { in: [...tracked.vendorIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // A. Staff list
  // ------------------------------------------------------------------------------------------

  test("setup: signed ticket reports on both sides, a draft on side A, an AMC report on side A", async () => {
    W.signedA = await signedTicketReport(W.A, W.mgmt);
    W.signedB = await signedTicketReport(W.B, W.mgmt);
    W.draftA = await ticketReport(W.A, W.mgmt); // a new visit on the same ticket (the finished one does not block it)
    const amc = await call(W.mgmt, "POST", "/service-reports", { amcOrderId: W.A.amc.id, unitId: W.A.unit.id, acknowledgementRequired: false, ...fields });
    assert.equal(amc.status, 201, JSON.stringify(amc.body));
    const sub = await call(W.mgmt, "POST", `/service-reports/${amc.body.id}/submit`, { expectedVersion: amc.body.version });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    W.amcA = sub.body; // final WITHOUT a signature
    assert.equal(W.amcA.status, "submitted");
  });

  const list = (as: any, query = "") => call(as, "GET", `/service-reports?q=${PREFIX}${query}`);
  const ids = (res: any) => new Set<string>(res.body.reports.map((r: any) => r.id));

  test("management lists every report (tickets and AMC) with ticket / AMC reference, customer, site and serial", async () => {
    const res = await list(W.mgmt);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(ids(res), new Set([W.signedA.id, W.signedB.id, W.draftA.id, W.amcA.id]));
    assert.equal(res.body.total, 4);
    const a = res.body.reports.find((r: any) => r.id === W.signedA.id);
    assert.equal(a.ticketNumber, W.A.ticket.ticketNumber);
    assert.equal(a.customerName, `${PREFIX} A`);
    assert.equal(a.siteName, `${PREFIX} A Plant`);
    assert.equal(a.unitSerial, `${PREFIX}-A-SN`, "a ticket report shows the unit's serial");
    assert.equal(a.kind, "ticket");
    const amc = res.body.reports.find((r: any) => r.id === W.amcA.id);
    assert.equal(amc.kind, "amc");
    assert.ok(amc.amc.ref.startsWith("AMC-"));
    assert.equal(amc.unitSerial, `${PREFIX}-A-SN`);
  });

  test("an engineer sees only reports of tickets assigned to them, and no AMC reports", async () => {
    assert.deepEqual(ids(await list(W.eng1)), new Set([W.signedA.id, W.draftA.id]));
    assert.deepEqual(ids(await list(W.eng2)), new Set([W.signedB.id]));
  });

  test("a Regional Manager sees only their region's ticket reports; a vendor user only their vendor's sites", async () => {
    assert.deepEqual(ids(await list(W.rm1)), new Set([W.signedA.id, W.draftA.id]), "region R1 only, and no AMC (no AMC permission)");
    // the vendor user is a service engineer for vendor V1, but NOT assigned to the ticket -> nothing; once assigned, only V1's site is reachable
    assert.deepEqual(ids(await list(W.vendor1)), new Set());
    await prisma.complaint.update({ where: { id: W.A.ticket.id }, data: { assignedToId: W.vendor1.id } });
    await prisma.complaint.update({ where: { id: W.B.ticket.id }, data: { assignedToId: W.vendor1.id } });
    try {
      assert.deepEqual(ids(await list(W.vendor1)), new Set([W.signedA.id, W.draftA.id]), "assigned to both tickets, but only vendor V1's site is in scope");
    } finally {
      await prisma.complaint.update({ where: { id: W.A.ticket.id }, data: { assignedToId: W.eng1.id } });
      await prisma.complaint.update({ where: { id: W.B.ticket.id }, data: { assignedToId: W.eng2.id } });
    }
  });

  test("roles without report rights get 403; a customer cannot use the staff list (400) but still has /mine", async () => {
    assert.equal((await call(W.sales, "GET", "/service-reports")).status, 403);
    assert.equal((await call(W.A.contact, "GET", "/service-reports")).status, 400);
    const mine = await call(W.A.contact, "GET", "/service-reports/mine");
    assert.equal(mine.status, 200);
    assert.deepEqual(new Set(mine.body.reports.map((r: any) => r.id)), new Set([W.signedA.id, W.amcA.id]), "the customer's own, non-draft reports only");
  });

  test("filters (status, kind, customer, site, unit, free text) only ever narrow the caller's own scope", async () => {
    assert.deepEqual(ids(await list(W.mgmt, "&status=signed")), new Set([W.signedA.id, W.signedB.id]));
    assert.deepEqual(ids(await list(W.mgmt, "&status=submitted")), new Set([W.amcA.id]));
    assert.deepEqual(ids(await list(W.mgmt, "&kind=amc")), new Set([W.amcA.id]));
    assert.deepEqual(ids(await list(W.mgmt, `&customerId=${W.B.customer.id}`)), new Set([W.signedB.id]));
    assert.deepEqual(ids(await list(W.mgmt, `&siteId=${W.A.site.id}`)), new Set([W.signedA.id, W.draftA.id, W.amcA.id]));
    assert.deepEqual(ids(await list(W.mgmt, `&unitId=${W.B.unit.id}`)), new Set([W.signedB.id]));
    assert.deepEqual(ids(await call(W.mgmt, "GET", `/service-reports?q=${W.A.unit.serialNo}`)), new Set([W.signedA.id, W.draftA.id, W.amcA.id]), "by serial");
    assert.deepEqual(ids(await call(W.mgmt, "GET", `/service-reports?q=${W.B.ticket.ticketNumber}`)), new Set([W.signedB.id]), "by ticket number");
    // an engineer filtering for the OTHER side's customer / site / unit gets nothing - a filter cannot widen scope
    assert.deepEqual(ids(await list(W.eng1, `&customerId=${W.B.customer.id}`)), new Set());
    assert.deepEqual(ids(await list(W.eng1, `&siteId=${W.B.site.id}`)), new Set());
    assert.deepEqual(ids(await list(W.rm1, `&unitId=${W.B.unit.id}`)), new Set());
  });

  test("paging reports the total; a bad filter value is a 400, not an empty list", async () => {
    const page = await list(W.mgmt, "&limit=2&offset=0");
    assert.equal(page.body.reports.length, 2);
    assert.equal(page.body.total, 4);
    const next = await list(W.mgmt, "&limit=2&offset=2");
    assert.equal(next.body.reports.length, 2);
    assert.equal(new Set([...ids(page), ...ids(next)]).size, 4, "no overlap, nothing missing");
    assert.equal((await list(W.mgmt, "&status=approved")).status, 400);
    assert.equal((await list(W.mgmt, "&kind=other")).status, 400);
  });

  test("the existing per-ticket / per-AMC lists are unchanged", async () => {
    const t = await call(W.mgmt, "GET", `/service-reports?complaintId=${W.A.ticket.id}`);
    assert.equal(t.status, 200);
    assert.equal(t.body.reports.length, 2);
    assert.equal(typeof t.body.canWrite, "boolean");
    assert.equal((await call(W.mgmt, "GET", `/service-reports?complaintId=${W.A.ticket.id}&amcOrderId=${W.A.amc.id}`)).status, 400);
    assert.equal((await call(W.eng2, "GET", `/service-reports?complaintId=${W.A.ticket.id}`)).status, 403, "an engineer cannot read another engineer's ticket reports");
  });

  // ------------------------------------------------------------------------------------------
  // B. Final reports are immutable
  // ------------------------------------------------------------------------------------------

  test("the database refuses to change what a final report rests on: site, unit, submitter, signer, creation time, id and the existing fields", async () => {
    for (const final of [W.signedA, W.amcA]) {
      const before = await row(final.id);
      const changes: Array<[string, Record<string, unknown>]> = [
        ["site", { siteId: W.B.site.id }],
        ["site cleared", { siteId: null }],
        ["unit", { unitId: W.B.unit.id }],
        ["unit cleared", { unitId: null }],
        ["submitter", { submittedById: W.eng2.id }],
        ["signer", { signedById: W.eng2.id }],
        ["creator", { createdById: W.eng2.id }],
        ["created at", { createdAt: new Date("2020-01-01") }],
        ["report number", { reportNumber: `${PREFIX}-FAKE` }],
        ["customer", { customerId: W.B.customer.id }],
        ["serial snapshot", { unitSerialNo: "FAKE" }],
        ["text", { findings: "Rewritten" }],
        ["pdf hash", { pdfSha256: "0".repeat(64) }],
      ];
      for (const [label, data] of changes) {
        await assert.rejects(prisma.serviceReport.update({ where: { id: final.id }, data }), /final and cannot be changed|check constraint/i, `${before.status}: ${label}`);
      }
      await assert.rejects(prisma.$executeRawUnsafe(`UPDATE "ServiceReport" SET "id" = '${PREFIX}-X' WHERE "id" = '${final.id}'`), /final and cannot be changed/i, "primary key");
      const after = await row(final.id);
      for (const k of ["siteId", "unitId", "submittedById", "signedById", "createdById", "createdAt", "reportNumber", "customerId", "unitSerialNo", "findings", "pdfSha256"]) {
        assert.deepEqual(after[k], before[k], `${before.status}: ${k} unchanged`);
      }
    }
  });

  test("the submitter / signer link can only be lost (the person's account was deleted), never re-pointed - and the report stays intact", async () => {
    const sideC = await makeSide("C", W.R1, W.V1, W.eng1);
    const signed = await signedTicketReport(sideC, W.mgmt);
    const before = await row(signed.id);
    assert.equal(before.signedById, sideC.contact.id);
    await prisma.user.delete({ where: { id: sideC.contact.id } }); // ON DELETE SET NULL on signedById
    tracked.userIds.delete(sideC.contact.id);
    const after = await row(signed.id);
    assert.equal(after.signedById, null);
    assert.equal(after.signerName, before.signerName, "the typed signer name is kept");
    assert.equal(after.status, "signed");
    assert.equal(await prisma.serviceReportEvent.count({ where: { reportId: signed.id } }) > 0, true, "its history is kept");
  });

  test("a final report cannot be deleted, directly or by removing its customer, ticket, site or unit; a draft still can", async () => {
    for (const final of [W.signedA, W.amcA]) {
      await assert.rejects(prisma.serviceReport.delete({ where: { id: final.id } }), /final and cannot be deleted/i);
      await assert.rejects(prisma.serviceReport.deleteMany({ where: { id: final.id } }), /final and cannot be deleted/i);
    }
    await assert.rejects(prisma.complaint.delete({ where: { id: W.A.ticket.id } }), (e: any) => e.code === "P2003", "ticket: foreign key");
    await assert.rejects(prisma.customer.delete({ where: { id: W.A.customer.id } }), (e: any) => e.code === "P2003", "customer: foreign key");
    await assert.rejects(prisma.recdUnit.delete({ where: { id: W.A.unit.id } }), (e: any) => e.code === "P2003", "unit: foreign key");
    await assert.rejects(prisma.site.delete({ where: { id: W.A.site.id } }), (e: any) => e.code === "P2003", "site: foreign key (was ON DELETE SET NULL)");
    assert.equal((await row(W.signedA.id)).siteId, W.A.site.id);

    const scratch = await makeTicket(W.B, W.eng2);
    const draft = await ticketReport(W.B, W.mgmt, scratch);
    await prisma.serviceReport.delete({ where: { id: draft.id } });
    assert.equal(await prisma.serviceReport.count({ where: { id: draft.id } }), 0, "unsigned work can still be removed");
  });

  test("the stored signature and PDF files of a final report cannot be altered or deleted", async () => {
    const r = await row(W.signedA.id);
    for (const fileId of [r.signatureFileId, r.pdfFileId]) {
      await assert.rejects(prisma.reportFile.update({ where: { id: fileId }, data: { data: Buffer.from("tampered") } }), /final and cannot be changed/i, "update");
      await assert.rejects(prisma.reportFile.update({ where: { id: fileId }, data: { sha256: "0".repeat(64) } }), /final and cannot be changed/i, "hash");
      await assert.rejects(prisma.reportFile.delete({ where: { id: fileId } }), (e: any) => e.code === "P2003", "delete: foreign key");
    }
    const pdf = await call(W.mgmt, "GET", `/service-reports/${W.signedA.id}/pdf`);
    assert.equal(pdf.status, 200, "and the integrity check still passes");
  });

  test("the history of a final report is append-only; the history of an unfinished one is not frozen", async () => {
    const events = await prisma.serviceReportEvent.findMany({ where: { reportId: W.signedA.id } });
    assert.ok(events.length >= 3, "created, submitted, signed");
    await assert.rejects(prisma.serviceReportEvent.update({ where: { id: events[0].id }, data: { toValue: "forged" } }), /cannot be changed or deleted/i);
    await assert.rejects(prisma.serviceReportEvent.delete({ where: { id: events[0].id } }), /cannot be changed or deleted/i);
    await assert.rejects(prisma.serviceReportEvent.deleteMany({ where: { reportId: W.signedA.id } }), /cannot be changed or deleted/i);
    const appended = await prisma.serviceReportEvent.create({ data: { reportId: W.signedA.id, type: "service_report_updated", toValue: "note" } });
    assert.ok(appended.id, "appending is still allowed");
    assert.equal(await prisma.serviceReportEvent.count({ where: { reportId: W.signedA.id } }), events.length + 1);
    // an unfinished report keeps working as before
    const draftEvents = await prisma.serviceReportEvent.findMany({ where: { reportId: W.draftA.id } });
    assert.ok(draftEvents.length >= 1);
    await prisma.serviceReportEvent.update({ where: { id: draftEvents[0].id }, data: { toValue: "draft" } });
  });

  test("through the API a final report accepts no change at all: edit, reopen, re-sign, and site / unit / customer in the body are all refused", async () => {
    for (const final of [W.signedA, W.amcA]) {
      const edit = await call(W.mgmt, "PATCH", `/service-reports/${final.id}`, { expectedVersion: final.version, findings: "Rewrite", siteId: W.B.site.id, unitId: W.B.unit.id, customerId: W.B.customer.id });
      assert.deepEqual([edit.status, edit.body.code], [409, "REPORT_FINAL"]);
      assert.equal((await call(W.mgmt, "POST", `/service-reports/${final.id}/reopen`, { expectedVersion: final.version })).status, 409);
      assert.equal((await call(W.mgmt, "POST", `/service-reports/${final.id}/submit`, { expectedVersion: final.version })).status, 409);
    }
    assert.equal((await sign(W.A.contact, W.signedA)).status, 409, "a signed report cannot be signed again");
    const after = await row(W.signedA.id);
    assert.deepEqual([after.siteId, after.unitId, after.customerId, after.findings], [W.A.site.id, W.A.unit.id, W.A.customer.id, fields.findings]);
  });

  test("legitimate unsigned workflow still works end to end: edit a draft, submit, take back, edit again, submit, sign", async () => {
    const ticket = await makeTicket(W.B, W.eng2);
    const d = await ticketReport(W.B, W.eng2, ticket);
    const edited = await call(W.eng2, "PATCH", `/service-reports/${d.id}`, { expectedVersion: d.version, findings: "Updated findings after a closer look." });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const sub = await call(W.eng2, "POST", `/service-reports/${d.id}/submit`, { expectedVersion: edited.body.version });
    assert.equal(sub.status, 200);
    const back = await call(W.eng2, "POST", `/service-reports/${d.id}/reopen`, { expectedVersion: sub.body.version });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const again = await call(W.eng2, "PATCH", `/service-reports/${d.id}`, { expectedVersion: back.body.version, resolution: "Leak sealed and tested." });
    assert.equal(again.status, 200);
    const sub2 = await call(W.eng2, "POST", `/service-reports/${d.id}/submit`, { expectedVersion: again.body.version });
    assert.equal(sub2.status, 200);
    assert.equal((await sign(W.B.contact, sub2.body)).status, 200);
    assert.equal((await row(d.id)).status, "signed");
  });

  test("migration objects: the new triggers exist and the site link is RESTRICT", async () => {
    const sr = await prisma.$queryRaw`select tgname from pg_trigger where tgrelid = '"ServiceReport"'::regclass and not tgisinternal order by tgname`;
    assert.deepEqual(sr.map((t: any) => t.tgname), ["ServiceReport_final_no_delete", "ServiceReport_signed_is_final"]);
    const rf = await prisma.$queryRaw`select tgname from pg_trigger where tgrelid = '"ReportFile"'::regclass and not tgisinternal`;
    assert.deepEqual(rf.map((t: any) => t.tgname), ["ReportFile_referenced_is_final"]);
    const ev = await prisma.$queryRaw`select tgname from pg_trigger where tgrelid = '"ServiceReportEvent"'::regclass and not tgisinternal`;
    assert.deepEqual(ev.map((t: any) => t.tgname), ["ServiceReportEvent_final_is_append_only"]);
    const [fk] = await prisma.$queryRaw`select confdeltype from pg_constraint where conname = 'ServiceReport_siteId_fkey'`;
    assert.equal(fk.confdeltype, "r", "RESTRICT");
  });
});
