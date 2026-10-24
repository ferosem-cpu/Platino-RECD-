/**
 * Real-database tests for digital service reports: the foreign keys, the partial unique index, the CHECK constraints,
 * the "signed is immutable" trigger, the Restrict / SET NULL rules, the database storage provider, and the atomic
 * claims under concurrent requests - all through the real router, real authentication and the real Prisma client.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the
 * disposable Docker database (localhost:5434/platino_test) and they only touch rows they create themselves
 * (unique run prefix; everything is removed in `after`). No real signature or document is used: the signature is
 * a generated PNG and all names are synthetic. Nothing is sent anywhere. Run with:
 *   npm run test:db --workspace=apps/api   (database migrated through 20261017090000_service_reports)
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
describe("service reports against the real test database", { skip }, () => {
  const PREFIX = `ZR${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), complaintIds: new Set<string>(), unitIds: new Set<string>() };
  let seq = 0;
  const realConsole = { log: console.log, error: console.error };

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let setStorage: (s: any) => void;
  let productId = "";
  let stageId = "";
  let roleIds: Record<string, string> = {};

  /** Two customers, each with a contact login, an order + site + unit and one ticket. */
  const world: Record<string, any> = {};

  async function makeUser(tag: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, roleId: roleIds[roleKey], isActive: true, mustChangePassword: false, ...extra } });
    tracked.userIds.add(user.id);
    return user;
  }

  async function makeCustomer(tag: string) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    tracked.customerIds.add(customer.id);
    const contact = await makeUser(`${tag} contact`, "customer", { customerId: customer.id });
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-${tag}-O${++seq}`, customerId: customer.id, productId, quantity: 1, site: { create: { currentStageId: stageId, companyName: `${PREFIX} ${tag} Plant`, address: `${tag} Industrial Estate`, dgModel: "KG1-250", dgCapacityKva: 250 } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const unit = await prisma.recdUnit.create({ data: { serialNo: `${PREFIX}-${tag}-SN`, orderId: order.id, siteId: order.site.id, productId } });
    tracked.unitIds.add(unit.id);
    return { customer, contact, order, site: order.site, unit };
  }

  async function makeTicket(w: any, assignedToId: string | null, n = ++seq) {
    const t = await prisma.complaint.create({
      data: { ticketNumber: `${PREFIX}-T${n}`, customerId: w.customer.id, siteId: w.site.id, unitId: w.unit.id, category: "non_performance", description: `${PREFIX} ticket`, severity: "medium", status: "closed", assignedToId, // closed: the one-open-ticket-per-unit rule would otherwise allow only one test ticket per unit
         serviceReportUrl: "data:application/pdf;base64,AAAA" },
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
    return { status: res.status, body: json, buf, headers: res.headers };
  }

  const fields = { visitDate: "2026-10-14", workPerformed: "Replaced the gasket.", findings: "Exhaust leak at the flange.", resolution: "Leak sealed." };
  const create = (as: any, complaintId: string) => call(as, "POST", "/service-reports", { complaintId, ...fields });
  async function awaiting(ticket: any, staff: any) {
    const c = await create(staff, ticket.id);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const s = await call(staff, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: c.body.version });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body;
  }
  const sign = (as: any, r: any, over: Record<string, unknown> = {}) =>
    call(as, "POST", `/service-reports/${r.id}/sign`, { signerName: "Asha Rao", signatureImage: pngDataUrl(makePng()), version: r.version, confirm: true, ...over });
  const reportFileCount = () => prisma.reportFile.count();

  before(async () => {
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    ({ signToken } = await import("../../src/lib/jwt"));
    ({ setReportStorageForTests: setStorage } = await import("../../src/lib/reportStorage"));
    setStorage(undefined); // the real "database" provider

    const { serviceReportsRouter } = await import("../../src/routes/serviceReports");
    const { complaintsRouter } = await import("../../src/routes/complaints");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/service-reports", serviceReportsRouter);
    app.use("/complaints", complaintsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    for (const key of ["customer", "service_engineer", "management", "sales"]) roleIds[key] = (await prisma.role.findUniqueOrThrow({ where: { key } })).id;

    world.A = await makeCustomer("A");
    world.B = await makeCustomer("B");
    world.eng = await makeUser("engineer", "service_engineer");
    world.engOther = await makeUser("engineer other", "service_engineer");
    world.mgmt = await makeUser("manager", "management");
    world.sales = await makeUser("sales", "sales");
  });

  after(async () => {
    server?.close();
    setStorage?.(undefined);
    try {
      if (prisma) {
        const complaintIds = [...tracked.complaintIds];
        const reports = await prisma.serviceReport.findMany({ where: { complaintId: { in: complaintIds } }, select: { id: true, signatureFileId: true, pdfFileId: true } });
        // The disposable test database only: final (signed / submitted) reports cannot be deleted any more (migration 20261101090000), so the
        // guard is switched off for this clean-up of the rows THIS run created, and switched on again straight after.
        await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" DISABLE TRIGGER "ServiceReport_final_no_delete"');
        try {
          await prisma.serviceReport.deleteMany({ where: { id: { in: reports.map((r: any) => r.id) } } });
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "ServiceReport" ENABLE TRIGGER "ServiceReport_final_no_delete"');
        }
        await prisma.reportFile.deleteMany({ where: { id: { in: reports.flatMap((r: any) => [r.signatureFileId, r.pdfFileId]).filter(Boolean) } } });
        await prisma.complaint.deleteMany({ where: { id: { in: complaintIds } } }); // their events go with them
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

  test("migration objects exist: tables, the one-unsigned-per-ticket index, both CHECKs and the immutability trigger", async () => {
    const [idx] = await prisma.$queryRaw`select indexdef from pg_indexes where indexname = 'ServiceReport_one_open_per_complaint'`;
    assert.match(idx.indexdef, /UNIQUE/i);
    assert.match(idx.indexdef, /draft.*awaiting_signature/i);
    const checks = await prisma.$queryRaw`select conname from pg_constraint where conrelid = '"ServiceReport"'::regclass and contype = 'c' order by conname`;
    assert.deepEqual(checks.map((c: any) => c.conname), ["ServiceReport_final_states_check", "ServiceReport_kind_owner_check", "ServiceReport_signed_complete_check", "ServiceReport_status_check"]);
    const trg = await prisma.$queryRaw`select tgname from pg_trigger where tgrelid = '"ServiceReport"'::regclass and not tgisinternal order by tgname`;
    assert.deepEqual(trg.map((t: any) => t.tgname), ["ServiceReport_final_no_delete", "ServiceReport_signed_is_final"]);
  });

  test("database rules: one unsigned report per ticket, a closed status vocabulary, and 'signed' must be complete", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const data = { complaintId: t.id, customerId: world.A.customer.id, siteId: world.A.site.id, unitId: world.A.unit.id, createdById: world.eng.id, visitDate: new Date("2026-10-14") };
    const first = await prisma.serviceReport.create({ data: { ...data, reportNumber: `${t.ticketNumber}-R1` } });
    await assert.rejects(prisma.serviceReport.create({ data: { ...data, reportNumber: `${t.ticketNumber}-R2` } }), (e: any) => e.code === "P2002", "second unsigned report refused");
    await assert.rejects(prisma.serviceReport.update({ where: { id: first.id }, data: { status: "bogus" } }), /ServiceReport_status_check|check constraint/i);
    await assert.rejects(prisma.serviceReport.update({ where: { id: first.id }, data: { status: "signed" } }), /ServiceReport_signed_complete_check|check constraint/i, "an incomplete row cannot be marked signed");
    await assert.rejects(prisma.serviceReport.create({ data: { ...data, reportNumber: `${t.ticketNumber}-R1` } }), (e: any) => e.code === "P2002", "report numbers are unique");
  });

  test("foreign keys: a report must point at a real ticket, customer and user", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const ok = { reportNumber: `${t.ticketNumber}-R1`, complaintId: t.id, customerId: world.A.customer.id, createdById: world.eng.id, visitDate: new Date() };
    for (const bad of [{ complaintId: "nope" }, { customerId: "nope" }, { createdById: "nope" }, { siteId: "nope" }, { unitId: "nope" }]) {
      await assert.rejects(prisma.serviceReport.create({ data: { ...ok, ...bad } }), (e: any) => e.code === "P2003", JSON.stringify(bad));
    }
  });

  // ------------------------------------------------------------------------------------------
  // The full workflow with the real storage provider
  // ------------------------------------------------------------------------------------------

  test("end to end: draft -> submit -> customer signs -> signed PDF stored in the database and downloadable", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const r = await awaiting(t, world.eng);
    assert.equal(r.customerId, world.A.customer.id);
    assert.equal(r.siteId, world.A.site.id);
    assert.equal(r.unitId, world.A.unit.id);

    const filesBefore = await reportFileCount();
    const s = await sign(world.A.contact, r);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(await reportFileCount(), filesBefore + 2, "a signature file and a PDF");

    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(row.status, "signed");
    assert.equal(row.signerName, "Asha Rao");
    assert.equal(row.signedById, world.A.contact.id);
    assert.equal(row.signedVersion, r.version);
    assert.ok(row.signedAt && row.submittedAt);

    const pdfFile = await prisma.reportFile.findUniqueOrThrow({ where: { id: row.pdfFileId } });
    assert.equal(pdfFile.contentType, "application/pdf");
    assert.equal(pdfFile.sha256, row.pdfSha256);
    assert.equal(Buffer.from(pdfFile.data).subarray(0, 5).toString("latin1"), "%PDF-");

    for (const who of [world.A.contact, world.eng, world.mgmt]) {
      const d = await call(who, "GET", `/service-reports/${r.id}/pdf`);
      assert.equal(d.status, 200);
      assert.equal(d.headers.get("content-type"), "application/pdf");
      assert.ok(d.buf.equals(Buffer.from(pdfFile.data)), "the downloaded bytes are the stored bytes");
    }
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(Buffer.from(pdfFile.data)) });
    const text = (await parser.getText()).text;
    await parser.destroy();
    for (const expected of [r.reportNumber, `${PREFIX} A`, `${PREFIX}-A-SN`, "Signed by: Asha Rao", "Exhaust leak at the flange", "SIGNED - FINAL"]) assert.ok(text.includes(expected), expected);

    const after = await prisma.complaint.findUniqueOrThrow({ where: { id: t.id } });
    assert.equal(after.serviceReportUrl, "data:application/pdf;base64,AAAA", "the legacy attachment is untouched");
    const events = await prisma.complaintEvent.findMany({ where: { complaintId: t.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e: any) => e.type), ["service_report_created", "service_report_submitted", "service_report_signed"]);
    assert.equal(events[2].actorId, world.A.contact.id);
  });

  test("ownership: ids in the request are ignored; another customer, another engineer and sales cannot reach the report", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const c = await call(world.eng, "POST", "/service-reports", { complaintId: t.id, ...fields, customerId: world.B.customer.id, siteId: world.B.site.id, unitId: world.B.unit.id });
    assert.equal(c.status, 201);
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: c.body.id } });
    assert.deepEqual([row.customerId, row.siteId, row.unitId], [world.A.customer.id, world.A.site.id, world.A.unit.id]);

    const sub = await call(world.eng, "POST", `/service-reports/${c.body.id}/submit`, { expectedVersion: 1 });
    assert.equal(sub.status, 200);
    assert.equal((await sign(world.B.contact, sub.body)).status, 404, "customer B cannot sign customer A's report");
    assert.equal((await call(world.B.contact, "GET", `/service-reports/${c.body.id}`)).status, 404);
    assert.equal((await call(world.engOther, "GET", `/service-reports/${c.body.id}`)).status, 403);
    assert.equal((await call(world.sales, "GET", `/service-reports/${c.body.id}`)).status, 403);
    assert.equal((await create(world.engOther, t.id)).status, 403);
    assert.equal((await call(world.A.contact, "GET", `/service-reports/${c.body.id}`)).status, 200);
    assert.equal((await prisma.serviceReport.findUniqueOrThrow({ where: { id: c.body.id } })).status, "awaiting_signature");
  });

  // ------------------------------------------------------------------------------------------
  // Immutability, deletes, archived units
  // ------------------------------------------------------------------------------------------

  test("a signed report cannot be changed - not by the API and not even by a direct database update", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const r = await awaiting(t, world.eng);
    const s = await sign(world.A.contact, r);
    assert.equal(s.status, 200);
    assert.equal((await call(world.mgmt, "PATCH", `/service-reports/${r.id}`, { expectedVersion: r.version, findings: "Rewrite" })).status, 409);
    for (const change of [{ findings: "Rewrite" }, { signerName: "Someone Else" }, { status: "draft" }, { pdfSha256: "0".repeat(64) }, { version: 99 }]) {
      await assert.rejects(prisma.serviceReport.update({ where: { id: r.id }, data: change }), /final and cannot be changed/i, JSON.stringify(change));
    }
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(row.findings, fields.findings);
    assert.equal(row.signerName, "Asha Rao");
  });

  test("a signed report keeps its unit: the unit cannot be deleted (RESTRICT), the report stays signed and downloadable; its ticket cannot be deleted", async () => {
    const w = await makeCustomer("C");
    const t = await makeTicket(w, world.eng.id);
    const r = await awaiting(t, world.eng);
    assert.equal((await sign(w.contact, r)).status, 200);

    await assert.rejects(prisma.complaint.delete({ where: { id: t.id } }), (e: any) => e.code === "P2003", "the database refuses to delete a ticket that has a report");
    const api = await call(world.mgmt, "DELETE", `/complaints/${t.id}`);
    assert.equal(api.status, 409);
    assert.equal(api.body.code, "HAS_SERVICE_REPORTS");

    // R1 D2: a unit that tickets / reports point at can no longer be deleted (it used to be detached with SET NULL, freeing its serial).
    await assert.rejects(prisma.recdUnit.delete({ where: { id: w.unit.id } }), (e: any) => e.code === "P2003", "the database refuses to delete a unit with history");
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(row.unitId, w.unit.id, "the report still points at its unit");
    assert.equal(row.status, "signed");
    assert.equal(row.customerId, w.customer.id);
    assert.equal((await call(w.contact, "GET", `/service-reports/${r.id}/pdf`)).status, 200, "and the PDF still downloads");
  });

  // ------------------------------------------------------------------------------------------
  // Concurrency and failure
  // ------------------------------------------------------------------------------------------

  test("simultaneous report creation for one ticket: exactly one wins (the unique index), the rest get a clear 409", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => create(world.eng, t.id)));
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join());
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(await prisma.serviceReport.count({ where: { complaintId: t.id } }), 1);
  });

  test("simultaneous signing: exactly one signature wins and no surplus files are left in storage", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const r = await awaiting(t, world.eng);
    const before = await reportFileCount();
    const results = await Promise.all(Array.from({ length: 5 }, () => sign(world.A.contact, r)));
    assert.equal(results.filter((x) => x.status === 200).length, 1, results.map((x) => x.status).join());
    assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 409));
    assert.equal(await reportFileCount(), before + 2, "only the winner's two files remain");
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    assert.ok(await prisma.reportFile.findUnique({ where: { id: row.signatureFileId } }));
    assert.ok(await prisma.reportFile.findUnique({ where: { id: row.pdfFileId } }));
    assert.equal(await prisma.complaintEvent.count({ where: { complaintId: t.id, type: "service_report_signed" } }), 1);
  });

  test("a storage failure half-way leaves no record, no file and an unsigned report that can be signed on retry", async () => {
    const { getReportStorage } = await import("../../src/lib/reportStorage");
    const real = getReportStorage()!;
    let puts = 0;
    setStorage({ ...real, name: "flaky", put: async (b: Buffer, c: string) => { if (++puts === 2) throw new Error("disk full"); return real.put(b, c); }, get: real.get.bind(real), delete: real.delete.bind(real) });
    try {
      const t = await makeTicket(world.A, world.eng.id);
      const r = await awaiting(t, world.eng);
      const before = await reportFileCount();
      const failed = await sign(world.A.contact, r);
      assert.equal(failed.status, 502);
      assert.equal(await reportFileCount(), before, "the first file was removed again");
      const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
      assert.deepEqual([row.status, row.signedAt, row.pdfFileId, row.signatureFileId], ["awaiting_signature", null, null, null]);
      puts = 10;
      assert.equal((await sign(world.A.contact, r)).status, 200, "retry works");
    } finally {
      setStorage(undefined);
    }
  });

  test("download integrity: a damaged stored PDF is refused, a missing one is reported - never served", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const r = await awaiting(t, world.eng);
    assert.equal((await sign(world.A.contact, r)).status, 200);
    const row = await prisma.serviceReport.findUniqueOrThrow({ where: { id: r.id } });
    const file = await prisma.reportFile.findUniqueOrThrow({ where: { id: row.pdfFileId } });
    // The database now refuses to change a stored report file (migration 20261101090000), so the damage is simulated the way real corruption
    // would arrive - outside the application - by switching that guard off for these two statements only (disposable test database).
    await prisma.$executeRawUnsafe('ALTER TABLE "ReportFile" DISABLE TRIGGER "ReportFile_referenced_is_final"');
    try {
      await prisma.reportFile.update({ where: { id: file.id }, data: { data: Buffer.concat([Buffer.from(file.data), Buffer.from("x")]) } });
      const bad = await call(world.A.contact, "GET", `/service-reports/${r.id}/pdf`);
      assert.equal(bad.status, 500);
      assert.equal(bad.body.code, "FILE_INTEGRITY");
      await prisma.reportFile.update({ where: { id: file.id }, data: { data: file.data } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "ReportFile" ENABLE TRIGGER "ReportFile_referenced_is_final"');
    }
    assert.equal((await call(world.A.contact, "GET", `/service-reports/${r.id}/pdf`)).status, 200, "restored bytes pass the check again");
    // The foreign key stops anyone deleting a file a report still points at.
    await assert.rejects(prisma.reportFile.delete({ where: { id: file.id } }), (e: any) => e.code === "P2003");
  });

  test("list queries never load file contents: the report list returns metadata only", async () => {
    const t = await makeTicket(world.A, world.eng.id);
    const r = await awaiting(t, world.eng);
    await sign(world.A.contact, r);
    const list = await call(world.eng, "GET", `/service-reports?complaintId=${t.id}`);
    assert.equal(list.status, 200);
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes("JVBER") && !text.includes("iVBOR"), "no base64 PDF / PNG in the list");
    assert.equal(list.body.reports[0].pdfAvailable, true);
  });
});

test("the service-report database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  for (const bad of ["postgresql://u:p@localhost:5432/platino_test", "postgresql://u:p@localhost:5434/postgres", "postgresql://u:p@db.example.com:5434/platino_test", "", undefined]) {
    assert.equal(pointsAtIsolatedDb(bad), false);
  }
});
