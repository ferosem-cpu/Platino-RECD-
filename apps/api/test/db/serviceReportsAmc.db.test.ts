/**
 * Real-database tests for AMC service reports (Requirement 5): the owner CHECK, the unique indexes, the foreign keys,
 * the "final reports are immutable" trigger, the serial snapshot, the audit table, and the atomic claims under
 * concurrent requests - through the real routers, real authentication and the real Prisma client.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the
 * disposable Docker database (localhost:5434/platino_test) and they only touch rows they create themselves
 * (unique run prefix; everything is removed in `after`). No real signature or document is used: the signature is a
 * generated PNG and all names are synthetic. Nothing is sent anywhere. Run with:
 *   npm run test:db --workspace=apps/api   (database migrated through 20261018090000_amc_service_reports)
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
describe("AMC service reports against the real test database", { skip }, () => {
  const PREFIX = `ZA${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), amcIds: new Set<string>(), unitIds: new Set<string>() };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let setStorage: (s: any) => void;
  let getStorage: () => any;
  let productId = "";
  let stageId = "";
  const roleIds: Record<string, string> = {};
  const world: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }

  /** A customer with a contact login, one site, two active units and an AMC order covering both. */
  async function makeCustomer(tag: string) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    tracked.customerIds.add(customer.id);
    const contact = await makeUser(`${tag} contact`, "customer", { customerId: customer.id });
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 2, site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, address: `${tag} Industrial Estate`, dgModel: "KG1-250", dgCapacityKva: 250 } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const units: any[] = [];
    for (const n of [1, 2]) {
      const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-${tag}-SN${n}`, orderId: order.id, siteId: order.site.id, productId } });
      tracked.unitIds.add(unit.id);
      units.push(unit);
    }
    const amc = await prisma.amcOrder.create({
      data: { poNo: `${PREFIX}-${tag}-PO`, poDate: new Date("2026-04-01"), customerId: customer.id, location: `${tag} city`, item: "RECD", qty: 2, amcFrequencyPerYear: 4, amcType: "camc", units: { create: units.map((u) => ({ unitId: u.id })) } },
    });
    tracked.amcIds.add(amc.id);
    return { customer, contact, order, site: order.site, units, amc };
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
    return { status: res.status, body: json, buf, headers: res.headers };
  }

  const fields = { visitDate: "2026-10-14", workPerformed: "Quarterly service: cleaned filter.", findings: "Back-pressure normal.", resolution: "No action needed." };
  const createAmc = (as: any, w: any, unitIndex = 0, over: Record<string, unknown> = {}) => call(as, "POST", "/service-reports", { amcOrderId: w.amc.id, unitId: w.units[unitIndex].id, ...fields, ...over });
  async function awaiting(w: any, unitIndex = 0) {
    const c = await createAmc(world.mgmt, w, unitIndex);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const s = await call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: c.body.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body;
  }
  const sign = (as: any, r: any, over: Record<string, unknown> = {}) =>
    call(as, "POST", `/service-reports/${r.id}/sign`, { signerName: "Asha Rao", signatureImage: pngDataUrl(makePng()), version: r.version, confirm: true, ...over });
  const reportFileCount = () => prisma.reportFile.count();
  const pdfText = async (buf: Buffer) => {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  };

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ setReportStorageForTests: setStorage, getReportStorage: getStorage } = await import("../../src/lib/reportStorage"));
    setStorage(undefined);

    const { serviceReportsRouter } = await import("../../src/routes/serviceReports");
    const { recdUnitsRouter } = await import("../../src/routes/recdUnits");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/service-reports", serviceReportsRouter);
    app.use("/recd-units", recdUnitsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_engineer", "management", "sales"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
    world.A = await makeCustomer("A");
    world.B = await makeCustomer("B");
    world.mgmt = await makeUser("manager", "management");
    world.eng = await makeUser("engineer", "service_engineer");
    world.sales = await makeUser("sales", "sales");
  });

  after(async () => {
    server?.close();
    setStorage?.(undefined);
    try {
      if (prisma) {
        const amcIds = [...tracked.amcIds];
        const reports = await prisma.serviceReport.findMany({ where: { amcOrderId: { in: amcIds } }, select: { id: true, signatureFileId: true, pdfFileId: true } });
        // The disposable test database only: final (signed / submitted) reports cannot be deleted any more (migration 20261101090000), so the
        // guard is switched off for this clean-up of the rows THIS run created, and switched on again straight after.
        await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" DISABLE TRIGGER "ServiceReport_final_no_delete"');
        try {
          await prisma.serviceReport.deleteMany({ where: { id: { in: reports.map((r: any) => r.id) } } }); // their events cascade
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" ENABLE TRIGGER "ServiceReport_final_no_delete"');
        }
        await prisma.reportFile.deleteMany({ where: { id: { in: reports.flatMap((r: any) => [r.signatureFileId, r.pdfFileId]).filter(Boolean) } } });
        await prisma.amcOrder.deleteMany({ where: { id: { in: amcIds } } }); // unit links cascade
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // The migration's guarantees
  // ------------------------------------------------------------------------------------------

  test("migration objects exist: new columns, nullable ticket link, owner / final-state checks, both open-report indexes, audit table", async () => {
    const cols = await prisma.$queryRaw`select column_name, is_nullable from information_schema.columns where table_name = 'ServiceReport' and column_name in ('complaintId','amcOrderId','kind','acknowledgementRequired','unitSerialNo')`;
    const byName = Object.fromEntries(cols.map((c: any) => [c.column_name, c.is_nullable]));
    assert.deepEqual(Object.keys(byName).sort(), ["acknowledgementRequired", "amcOrderId", "complaintId", "kind", "unitSerialNo"]);
    assert.equal(byName.complaintId, "YES");
    assert.equal(byName.kind, "NO");
    const idx = await prisma.$queryRaw`select indexname, indexdef from pg_indexes where tablename = 'ServiceReport' and indexname like 'ServiceReport_one_open%' order by indexname`;
    assert.deepEqual(idx.map((i: any) => i.indexname), ["ServiceReport_one_open_per_amc_unit", "ServiceReport_one_open_per_complaint"]);
    assert.ok(idx.every((i: any) => /UNIQUE/i.test(i.indexdef) && /draft/.test(i.indexdef)));
    const old = await prisma.$queryRaw`select 1 from pg_indexes where indexname = 'ServiceReport_one_unsigned_per_complaint'`;
    assert.equal(old.length, 0, "the Requirement 4 index was replaced");
    const checks = await prisma.$queryRaw`select conname from pg_constraint where conrelid = '"ServiceReport"'::regclass and contype = 'c' order by conname`;
    assert.deepEqual(checks.map((c: any) => c.conname), ["ServiceReport_final_states_check", "ServiceReport_kind_owner_check", "ServiceReport_signed_complete_check", "ServiceReport_status_check"]);
    const [ev] = await prisma.$queryRaw`select to_regclass('"ServiceReportEvent"')::text as t`;
    assert.ok(ev.t);
  });

  test("owner rule: a report belongs to exactly one of a ticket or an AMC order, and an AMC report must carry its serial snapshot", async () => {
    const w = world.A;
    const base = { reportNumber: `${PREFIX}-X${++seq}`, customerId: w.customer.id, createdById: world.mgmt.id, visitDate: new Date("2026-10-14") };
    const ticket = await prisma.complaint.create({ data: { ticketNumber: `${PREFIX}-OT${++seq}`, customerId: w.customer.id, category: "non_performance", description: "x", severity: "low", status: "closed" } });
    try {
      const bad: Array<[string, Record<string, unknown>]> = [
        ["neither owner", {}],
        ["both owners", { kind: "amc", amcOrderId: w.amc.id, complaintId: ticket.id, unitSerialNo: "S" }],
        ["kind amc without an AMC order", { kind: "amc", unitSerialNo: "S" }],
        ["kind amc with a ticket", { kind: "amc", complaintId: ticket.id, unitSerialNo: "S" }],
        ["kind ticket with an AMC order", { kind: "ticket", amcOrderId: w.amc.id }],
        ["amc without a serial snapshot", { kind: "amc", amcOrderId: w.amc.id }],
        ["ticket report not needing a signature", { kind: "ticket", complaintId: ticket.id, acknowledgementRequired: false }],
      ];
      for (const [label, extra] of bad) {
        await assert.rejects(prisma.serviceReport.create({ data: { ...base, reportNumber: `${PREFIX}-X${++seq}`, ...extra } }), /kind_owner_check|check constraint/i, label);
      }
      const ok = await prisma.serviceReport.create({ data: { ...base, reportNumber: `${PREFIX}-X${++seq}`, complaintId: ticket.id } });
      assert.deepEqual([ok.kind, ok.acknowledgementRequired, ok.amcOrderId, ok.unitSerialNo], ["ticket", true, null, null], "a row shaped like the Requirement 4 ones still works, with safe defaults");
      const amcOk = await prisma.serviceReport.create({ data: { ...base, reportNumber: `${PREFIX}-X${++seq}`, kind: "amc", amcOrderId: w.amc.id, unitId: w.units[0].id, unitSerialNo: w.units[0].serialNo } });
      assert.equal(amcOk.kind, "amc");
      await prisma.serviceReport.deleteMany({ where: { id: { in: [ok.id, amcOk.id] } } });
    } finally {
      await prisma.complaint.delete({ where: { id: ticket.id } });
    }
  });

  test("final-state rules: 'submitted' needs a PDF and no acknowledgement; 'signed' needs acknowledgement; nothing else can be final", async () => {
    const w = world.A;
    const row = await prisma.serviceReport.create({ data: { reportNumber: `${PREFIX}-F${++seq}`, kind: "amc", amcOrderId: w.amc.id, unitId: w.units[0].id, unitSerialNo: "S", customerId: w.customer.id, createdById: world.mgmt.id, visitDate: new Date("2026-10-14") } });
    await assert.rejects(prisma.serviceReport.update({ where: { id: row.id }, data: { status: "submitted" } }), /final_states_check|check constraint/i, "submitted without a PDF");
    await assert.rejects(prisma.serviceReport.update({ where: { id: row.id }, data: { status: "signed" } }), /signed_complete_check|check constraint/i);
    await assert.rejects(prisma.serviceReport.update({ where: { id: row.id }, data: { status: "approved" } }), /status_check|check constraint/i);
    await prisma.serviceReport.delete({ where: { id: row.id } });
  });

  test("open-report index: one draft/awaiting report per AMC order + unit; other units and finished visits are independent", async () => {
    const w = world.A;
    const mk = (unitIndex: number, extra: Record<string, unknown> = {}) =>
      prisma.serviceReport.create({ data: { reportNumber: `${PREFIX}-I${++seq}`, kind: "amc", amcOrderId: w.amc.id, unitId: w.units[unitIndex].id, unitSerialNo: w.units[unitIndex].serialNo, customerId: w.customer.id, createdById: world.mgmt.id, visitDate: new Date("2026-10-14"), ...extra } });
    const first = await mk(0);
    await assert.rejects(mk(0), (e: any) => e.code === "P2002", "second open report for the same AMC unit");
    const other = await mk(1);
    await prisma.serviceReport.update({ where: { id: first.id }, data: { status: "awaiting_signature" } });
    await assert.rejects(mk(0), (e: any) => e.code === "P2002", "awaiting signature still counts as open");
    await prisma.serviceReport.deleteMany({ where: { id: { in: [first.id, other.id] } } });
  });

  test("foreign keys: an AMC order must exist, and an AMC order that has reports cannot be deleted", async () => {
    const w = world.A;
    const data = { reportNumber: `${PREFIX}-K${++seq}`, kind: "amc", unitSerialNo: "S", customerId: w.customer.id, createdById: world.mgmt.id, visitDate: new Date("2026-10-14") };
    await assert.rejects(prisma.serviceReport.create({ data: { ...data, amcOrderId: "nope" } }), (e: any) => e.code === "P2003");
    const amc = await prisma.amcOrder.create({ data: { poNo: `${PREFIX}-DEL`, poDate: new Date("2026-04-01"), customerId: w.customer.id, location: "x", item: "x", qty: 1, amcFrequencyPerYear: 1 } });
    tracked.amcIds.add(amc.id);
    const r = await prisma.serviceReport.create({ data: { ...data, amcOrderId: amc.id } });
    await assert.rejects(prisma.amcOrder.delete({ where: { id: amc.id } }), (e: any) => e.code === "P2003", "RESTRICT: reports are never deleted by accident");
    await prisma.serviceReport.delete({ where: { id: r.id } });
  });

  // ------------------------------------------------------------------------------------------
  // The workflow
  // ------------------------------------------------------------------------------------------

  test("end to end (acknowledgement required): create -> submit -> customer signs -> signed AMC PDF stored, downloadable, audited", async () => {
    const w = world.A;
    const filesBefore = await reportFileCount();
    const r = await awaiting(w, 0);
    assert.deepEqual([r.kind, r.customerId, r.siteId, r.unitId, r.unitSerialNo], ["amc", w.customer.id, w.site.id, w.units[0].id, w.units[0].serialNo]);

    const s = await sign(w.contact, r);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(await reportFileCount(), filesBefore + 2);
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    assert.deepEqual([row.status, row.signerName, row.signedById, row.signedVersion], ["signed", "Asha Rao", w.contact.id, r.version]);
    assert.ok(row.signedAt && row.pdfFileId && row.signatureFileId && row.pdfSha256);
    assert.equal(row.complaintId, null);
    assert.equal(row.amcOrderId, w.amc.id);

    for (const who of [w.contact, world.mgmt]) {
      const d = await call(who, "GET", `/service-reports/${r.id}/pdf`);
      assert.equal(d.status, 200);
      assert.equal(d.headers.get("content-type"), "application/pdf");
      assert.equal(d.headers.get("content-disposition"), `attachment; filename="service-report-${r.reportNumber}.pdf"`);
      const text = await pdfText(d.buf);
      for (const e of ["AMC Service Report", r.reportNumber, `${PREFIX}-A-PO`, "CAMC (Comprehensive)", `${PREFIX} A`, `${PREFIX}-A-SN1`, "Signed by: Asha Rao", "SIGNED - FINAL"]) assert.ok(text.includes(e), e);
    }
    const events = await prisma.serviceReportEvent.findMany({ where: { reportId: r.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e: any) => e.type), ["service_report_created", "service_report_submitted", "service_report_signed"]);
    assert.equal(events[2].actorId, w.contact.id);
    assert.equal(events[0].detail.amcOrderId, w.amc.id);
    assert.equal(events[0].detail.unitId, w.units[0].id);
  });

  test("end to end (acknowledgement NOT required): staff finalise it as 'submitted' with a stored PDF that says it is not signed", async () => {
    const w = world.A;
    const before = await reportFileCount();
    const c = await createAmc(world.mgmt, w, 1, { acknowledgementRequired: false });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const s = await call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: c.body.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.status, "submitted");
    assert.equal(await reportFileCount(), before + 1, "one PDF, no signature file");
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: c.body.id } });
    assert.deepEqual([row.status, row.signedAt, row.signatureFileId, row.signerName], ["submitted", null, null, null]);
    assert.ok(row.pdfFileId && row.pdfSha256);

    const d = await call(w.contact, "GET", `/service-reports/${c.body.id}/pdf`);
    assert.equal(d.status, 200);
    const text = await pdfText(d.buf);
    assert.ok(text.includes("SUBMITTED - FINAL, NOT SIGNED") && !text.includes("Signed by") && !text.includes("SIGNED - FINAL"));
    assert.equal((await sign(w.contact, s.body)).status, 409, "and it can never be signed afterwards");
  });

  test("final reports are immutable - the API refuses, and so does the database, whatever the final state", async () => {
    const w = world.B;
    const signedOne = await awaiting(w, 0);
    await sign(w.contact, signedOne);
    const c = await createAmc(world.mgmt, w, 1, { acknowledgementRequired: false });
    const submittedOne = (await call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: 1 })).body;
    for (const r of [signedOne, submittedOne]) {
      assert.equal((await call(world.mgmt, "PATCH", `/service-reports/${r.id}`, { expectedVersion: r.version, findings: "Rewrite" })).status, 409);
      assert.equal((await call(world.mgmt, "POST", `/service-reports/${r.id}/reopen`, { expectedVersion: r.version })).status, 409);
      const finalRow = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
      assert.ok(["signed", "submitted"].includes(finalRow.status));
      for (const change of [{ findings: "Rewrite" }, { unitSerialNo: "FAKE" }, { acknowledgementRequired: !finalRow.acknowledgementRequired }, { status: "draft" }, { amcOrderId: null }, { pdfSha256: "0".repeat(64) }]) {
        await assert.rejects(prisma.serviceReport.update({ where: { id: r.id }, data: change }), /final and cannot be changed|check constraint/i, `${finalRow.status}: ${JSON.stringify(change)}`);
      }
    }
  });

  test("relationships are checked against the real tables: units of another customer or outside the AMC are refused, and ids in the body are ignored", async () => {
    const A = world.A, B = world.B;
    const foreign = await call(world.mgmt, "POST", "/service-reports", { amcOrderId: A.amc.id, unitId: B.units[0].id, ...fields });
    assert.deepEqual([foreign.status, foreign.body.code], [400, "UNIT_NOT_IN_AMC"]);
    const crossAmc = await call(world.mgmt, "POST", "/service-reports", { amcOrderId: B.amc.id, unitId: A.units[0].id, ...fields });
    assert.equal(crossAmc.body.code, "UNIT_NOT_IN_AMC");
    assert.equal((await call(world.mgmt, "POST", "/service-reports", { amcOrderId: "nope", unitId: A.units[0].id, ...fields })).status, 404);

    const sneaky = await call(world.mgmt, "POST", "/service-reports", { amcOrderId: B.amc.id, unitId: B.units[0].id, ...fields, customerId: A.customer.id, siteId: A.site.id, unitSerialNo: "FAKE" });
    assert.equal(sneaky.status, 201, JSON.stringify(sneaky.body));
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: sneaky.body.id } });
    assert.deepEqual([row.customerId, row.siteId, row.unitId, row.unitSerialNo], [B.customer.id, B.site.id, B.units[0].id, B.units[0].serialNo]);
    await prisma.serviceReport.delete({ where: { id: row.id } });
  });

  test("access: AMC managers and the owning customer only; other customers, engineers and sales are refused", async () => {
    const A = world.A, B = world.B;
    const r = await awaiting(A, 0);
    const id = r.id;
    assert.equal((await call(A.contact, "GET", `/service-reports/${id}`)).status, 200);
    assert.equal((await call(world.mgmt, "GET", `/service-reports/${id}`)).status, 200);
    assert.equal((await call(B.contact, "GET", `/service-reports/${id}`)).status, 404);
    assert.equal((await call(B.contact, "GET", `/service-reports?amcOrderId=${A.amc.id}`)).status, 404);
    assert.equal((await sign(B.contact, { id, version: 1 })).status, 404);
    for (const who of [world.eng, world.sales]) {
      assert.equal((await call(who, "GET", `/service-reports/${id}`)).status, 403);
      assert.equal((await call(who, "GET", `/service-reports?amcOrderId=${A.amc.id}`)).status, 403);
      assert.equal((await createAmc(who, A, 0)).status, 403);
    }
    const mine = await call(A.contact, "GET", "/service-reports/mine");
    assert.ok(mine.body.reports.every((x: any) => x.customerId === A.customer.id && x.status !== "draft"));
  });

  test("serial snapshot: the report keeps the serial from when it was written, even if the unit's serial is later changed", async () => {
    const w = await freshWorld("SN");
    const c = await createAmc(world.mgmt, w, 0);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const original = w.units[0].serialNo;
    await prisma.recdUnit.update({ where: { id: w.units[0].id }, data: { serialNo: `${original}-CHANGED` } });
    try {
      const s = await call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: 1 });
      assert.equal(s.status, 200);
      const detail = await call(world.mgmt, "GET", `/service-reports/${c.body.id}`);
      assert.equal(detail.body.unit.serialNo, original, "shown from the snapshot");
      assert.equal((await prisma.serviceReport.findUniqueOrThrow({ where: { id: c.body.id } })).unitSerialNo, original);
      const signedR = await sign(w.contact, s.body);
      assert.equal(signedR.status, 200);
      const pdf = await call(w.contact, "GET", `/service-reports/${c.body.id}/pdf`);
      const text = await pdfText(pdf.buf);
      assert.ok(text.includes(original) && !text.includes("CHANGED"));
    } finally {
      await prisma.recdUnit.update({ where: { id: w.units[0].id }, data: { serialNo: original } });
    }
  });

  test("multiple visits: separate reports for the same unit over time, numbered in order, earlier ones untouched; frequency is not a limit", async () => {
    const w = await freshWorld("MV");
    const numbers: string[] = [];
    let firstSnapshot = "";
    for (let i = 0; i < 5; i++) {
      const r = await awaiting(w, 0);
      assert.equal((await sign(w.contact, r)).status, 200);
      numbers.push(r.reportNumber);
      if (i === 0) firstSnapshot = JSON.stringify(await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } }));
    }
    assert.deepEqual(numbers.map((n) => n.split("-R")[1]), ["1", "2", "3", "4", "5"]);
    assert.equal(await prisma.serviceReport.count({ where: { amcOrderId: w.amc.id, status: "signed" } }), 5, "this AMC contracts 4 visits a year; 5 actual reports are stored");
    const first = await prisma.serviceReport.findFirstOrThrow({ where: { amcOrderId: w.amc.id, reportNumber: numbers[0] } });
    assert.equal(JSON.stringify(first), firstSnapshot, "the first visit is untouched by the later ones");
    const list = await call(world.mgmt, "GET", `/service-reports?amcOrderId=${w.amc.id}`);
    assert.equal(list.body.reports.length, 5);
  });

  // ------------------------------------------------------------------------------------------
  // Concurrency and failure
  // ------------------------------------------------------------------------------------------

  async function freshWorld(tag: string) {
    const w = await makeCustomer(tag);
    return w;
  }

  test("simultaneous creation for one AMC unit: exactly one wins (the unique index), the rest get a clear 409", async () => {
    const w = await freshWorld("R1");
    const results = await Promise.all(Array.from({ length: 6 }, () => createAmc(world.mgmt, w, 0)));
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join());
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(await prisma.serviceReport.count({ where: { amcOrderId: w.amc.id } }), 1);
  });

  test("simultaneous signing: exactly one wins and no surplus files are left in storage", async () => {
    const w = await freshWorld("R2");
    const r = await awaiting(w, 0);
    const before = await reportFileCount();
    const results = await Promise.all(Array.from({ length: 5 }, () => sign(w.contact, r)));
    assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
    assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 409));
    assert.equal(await reportFileCount(), before + 2);
    assert.equal(await prisma.serviceReportEvent.count({ where: { reportId: r.id, type: "service_report_signed" } }), 1);
  });

  test("simultaneous no-signature submission: exactly one final report and one PDF", async () => {
    const w = await freshWorld("R3");
    const c = await createAmc(world.mgmt, w, 0, { acknowledgementRequired: false });
    const before = await reportFileCount();
    const results = await Promise.all(Array.from({ length: 5 }, () => call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: 1 })));
    assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
    assert.equal(await reportFileCount(), before + 1);
  });

  test("a storage failure leaves no record and no file (signing and no-signature submission), and a retry succeeds", async () => {
    const real = getStorage()!;
    let puts = 0;
    setStorage({ ...real, name: "flaky", put: async (b: Buffer, c: string) => { if (++puts === 2) throw new Error("disk full"); return real.put(b, c); }, get: real.get.bind(real), delete: real.delete.bind(real) });
    try {
      const w = await freshWorld("R4");
      const r = await awaiting(w, 0);
      const before = await reportFileCount();
      assert.equal((await sign(w.contact, r)).status, 502);
      assert.equal(await reportFileCount(), before, "the first file was removed again");
      const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
      assert.deepEqual([row.status, row.pdfFileId, row.signatureFileId, row.signedAt], ["awaiting_signature", null, null, null]);
      puts = 10;
      assert.equal((await sign(w.contact, r)).status, 200);

      const c = await createAmc(world.mgmt, w, 1, { acknowledgementRequired: false });
      const before2 = await reportFileCount();
      puts = 1; // the next put (#2) fails
      const failed = await call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: 1 });
      assert.equal(failed.status, 502);
      assert.equal(await reportFileCount(), before2);
      assert.equal((await prisma.serviceReport.findUniqueOrThrow({ where: { id: c.body.id } })).status, "draft");
      puts = 10;
      assert.equal((await call(world.mgmt, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: 1 })).status, 200);
    } finally {
      setStorage(undefined);
    }
  });

  test("a damaged stored PDF is refused and a missing one reported - never served", async () => {
    const w = await freshWorld("R5");
    const r = await awaiting(w, 0);
    await sign(w.contact, r);
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    const file = await prisma.reportFile.findUniqueOrThrow({ where: { id: row.pdfFileId } });
    // The database now refuses to change a stored report file (migration 20261101090000), so the damage is simulated the way real corruption
    // would arrive - outside the application - by switching that guard off for these two statements only (disposable test database).
    await prisma.$executeRawUnsafe('ALTER TABLE "ReportFile" DISABLE TRIGGER "ReportFile_referenced_is_final"');
    try {
      await prisma.reportFile.update({ where: { id: file.id }, data: { data: Buffer.concat([Buffer.from(file.data), Buffer.from("x")]) } });
      const bad = await call(w.contact, "GET", `/service-reports/${r.id}/pdf`);
      assert.deepEqual([bad.status, bad.body.code], [500, "FILE_INTEGRITY"]);
      await prisma.reportFile.update({ where: { id: file.id }, data: { data: file.data } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "ReportFile" ENABLE TRIGGER "ReportFile_referenced_is_final"');
    }
    assert.equal((await call(w.contact, "GET", `/service-reports/${r.id}/pdf`)).status, 200);
    await assert.rejects(prisma.reportFile.delete({ where: { id: file.id } }), (e: any) => e.code === "P2003", "a file a report points at cannot be deleted");
  });

  // ------------------------------------------------------------------------------------------
  // Viewing from the unit and after the unit / AMC changes
  // ------------------------------------------------------------------------------------------

  test("the RECD unit history lists its AMC reports (metadata only) for AMC managers and the owning customer, and for nobody else", async () => {
    const w = await freshWorld("R6");
    const r = await awaiting(w, 0);
    await sign(w.contact, r);
    const draft = await createAmc(world.mgmt, w, 1);
    assert.equal(draft.status, 201);
    const unitId = w.units[0].id;
    const staff = await call(world.mgmt, "GET", `/recd-units/${unitId}/history`);
    assert.equal(staff.status, 200, JSON.stringify(staff.body).slice(0, 200));
    assert.deepEqual(staff.body.amcServiceReports.map((x: any) => [x.id, x.status, x.pdfAvailable, x.unitSerialNo]), [[r.id, "signed", true, w.units[0].serialNo]]);
    assert.ok(!JSON.stringify(staff.body.amcServiceReports).includes("pdfFileId"), "no file references");
    const mine = await call(w.contact, "GET", `/recd-units/${unitId}/history`);
    assert.equal(mine.body.amcServiceReports.length, 1);
    assert.equal((await call(world.B.contact, "GET", `/recd-units/${unitId}/history`)).status, 403);
    const eng = await call(world.eng, "GET", `/recd-units/${unitId}/history`);
    assert.ok(eng.status === 403 || eng.body.amcServiceReports.length === 0, "engineers get no AMC reports");
    // drafts are never listed
    const other = await call(world.mgmt, "GET", `/recd-units/${w.units[1].id}/history`);
    assert.equal(other.body.amcServiceReports.length, 0);
  });

  test("a signed AMC report stays available when its unit is retired and when the AMC order expires", async () => {
    const w = await freshWorld("R7");
    const r = await awaiting(w, 0);
    await sign(w.contact, r);
    await prisma.recdUnit.update({ where: { id: w.units[0].id }, data: { status: "retired" } });
    await prisma.amcOrder.update({ where: { id: w.amc.id }, data: { poDate: new Date("2020-01-01"), status: "completed" } });
    assert.equal((await call(w.contact, "GET", `/service-reports/${r.id}/pdf`)).status, 200);
    assert.equal((await call(world.mgmt, "GET", `/service-reports/${r.id}`)).status, 200);
    const retired = await createAmc(world.mgmt, w, 0);
    assert.equal(retired.body.code, "UNIT_RETIRED", "but no NEW visit is written for a retired unit");
  });
});

test("the AMC report database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  for (const bad of ["postgresql://u:p@localhost:5432/platino_test", "postgresql://u:p@localhost:5434/postgres", "postgresql://u:p@db.example.com:5434/platino_test", "", undefined]) {
    assert.equal(pointsAtIsolatedDb(bad), false);
  }
});
