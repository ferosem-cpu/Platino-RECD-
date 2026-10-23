/**
 * Real-database tests for the PUBLIC complaint OTP (serial + mobile + code): the request limits under genuinely parallel
 * requests (PostgreSQL advisory locks), failed-delivery handling, expiry, wrong codes, attempt limits and single use.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker
 * database (localhost:5434/platino_test) and they only touch rows they create themselves (unique run prefix; everything is
 * removed in `after`). Nothing is sent anywhere: the WhatsApp Cloud API call is intercepted inside this process before it
 * can leave it. All serials and phone numbers are synthetic. Run with:  npm run test:db --workspace=apps/api
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { PUBLIC_OTP } from "@recd/shared";

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
describe("public complaint OTP against the real test database", { skip }, () => {
  const PREFIX = `ZP${Date.now().toString(36).toUpperCase()}`;
  const tracked = { customerIds: new Set<string>(), orderIds: new Set<string>(), unitIds: new Set<string>(), serials: new Set<string>() };
  let seq = 0;
  let hit = 0;
  const realConsole = { log: console.log, error: console.error };
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "OTP_DEV_ECHO", "PUBLIC_OTP_DEV_ECHO", "VERCEL", "VERCEL_ENV", "NODE_ENV"];

  let prisma: any;
  let server: Server;
  let base = "";
  let productId = "";
  let stageId = "";
  const realFetch = globalThis.fetch;
  const whatsapp = { calls: [] as Array<{ to: string; code: string }>, mode: "ok" as "ok" | "http500" };
  const sentCode = () => whatsapp.calls[whatsapp.calls.length - 1]?.code ?? "";
  const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

  /** A 10-digit synthetic mobile, unique within this run. */
  const newPhone = () => `7${String((Date.now() % 100_000) * 10_000 + ++seq).padStart(9, "0")}`.slice(0, 10);

  async function post(path: string, body: unknown, ip?: string) {
    const res = await fetch(`${base}/pc${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip ?? `10.8.${Math.floor(++hit / 250)}.${hit % 250}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  const requestOtp = (serialNo: string, phone: string, ip?: string) => post("/otp/request", { serialNo, phone }, ip);
  const verifyOtp = (serialNo: string, phone: string, code: string) => post("/otp/verify", { serialNo, phone, code });

  /** A customer with an order, site and ONE active unit; returns the unit's serial. */
  async function makeUnit(tag: string): Promise<string> {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    tracked.customerIds.add(customer.id);
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-O${++seq}`, customerId: customer.id, productId, quantity: 1, site: { create: { currentStageId: stageId } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    const serialNo = `${PREFIX}-${tag}`.toUpperCase();
    const unit = await prisma.recdUnit.create({ data: { serialNo, orderId: order.id, siteId: order.site.id, productId } });
    tracked.unitIds.add(unit.id);
    tracked.serials.add(serialNo);
    return serialNo;
  }

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    await prisma.ipRateLimit.deleteMany({}); // disposable DB only

    for (const k of ["OTP_DEV_ECHO", "PUBLIC_OTP_DEV_ECHO", "VERCEL", "VERCEL_ENV"]) delete process.env[k];
    process.env.NODE_ENV = "development";
    process.env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "000";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.includes("graph.facebook.com")) return realFetch(input, init);
      const body = JSON.parse(init.body);
      whatsapp.calls.push({ to: body.to, code: body.template.components[0].parameters[0].text });
      return whatsapp.mode === "http500" ? new Response("provider error", { status: 500 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { publicComplaintsRouter } = await import("../../src/routes/publicComplaints");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use("/pc", publicComplaintsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
  });

  after(async () => {
    server?.close();
    globalThis.fetch = realFetch;
    try {
      if (prisma) {
        await prisma.publicOtp.deleteMany({ where: { serialNorm: { in: [...tracked.serials] } } });
        await prisma.recdUnit.deleteMany({ where: { id: { in: [...tracked.unitIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: [...tracked.orderIds] } } });
        await prisma.order.deleteMany({ where: { id: { in: [...tracked.orderIds] } } });
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
      for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    }
  });

  const fresh = () => { whatsapp.calls.length = 0; whatsapp.mode = "ok"; };
  const rowsFor = (serialNo: string) => prisma.publicOtp.findMany({ where: { serialNorm: serialNo }, orderBy: { createdAt: "asc" } });

  // ------------------------------------------------------------------------------------------
  // A. The read-count-then-insert race
  // ------------------------------------------------------------------------------------------

  test("parallel requests from different numbers cannot exceed the per-serial hourly cap (repeated)", async () => {
    for (let round = 0; round < 3; round++) {
      fresh();
      const serial = await makeUnit(`CAP${round}`);
      const results = await Promise.all(Array.from({ length: 30 }, () => requestOtp(serial, newPhone())));
      const ok = results.filter((r) => r.status === 200).length;
      const limited = results.filter((r) => r.status === 429).length;
      assert.equal(ok, 10, `round ${round}: exactly the cap of 10 (statuses: ${results.map((r) => r.status).join()})`);
      assert.equal(limited, 20);
      assert.equal((await rowsFor(serial)).length, 10, `round ${round}: no more rows than the cap`);
      assert.equal(whatsapp.calls.length, 10, `round ${round}: and no more WhatsApp messages than the cap`);
    }
  });

  test("parallel requests for ONE number create exactly one code (the 30 s cooldown cannot be raced)", async () => {
    for (let round = 0; round < 3; round++) {
      fresh();
      const serial = await makeUnit(`COOL${round}`);
      const phone = newPhone();
      const results = await Promise.all(Array.from({ length: 12 }, () => requestOtp(serial, phone)));
      assert.equal(results.filter((r) => r.status === 200).length, 1, `round ${round}: ${results.map((r) => r.status).join()}`);
      assert.equal((await rowsFor(serial)).length, 1);
      assert.equal(whatsapp.calls.length, 1);
    }
  });

  test("parallel requests from one address cannot exceed the per-address hourly cap", async () => {
    fresh();
    const ip = "10.99.99.99";
    const serial = await makeUnit("IPCAP");
    // 30 different (unknown) serials plus one real one, so neither the per-serial nor the per-number limit is what stops them
    const serials = Array.from({ length: 30 }, (_, i) => `${serial}-X${i}`);
    for (const s of serials) tracked.serials.add(s);
    const results = await Promise.all(serials.map((s) => requestOtp(s, newPhone(), ip)));
    assert.equal(results.filter((r) => r.status === 200).length, 20, results.map((r) => r.status).join());
    assert.equal(await prisma.publicOtp.count({ where: { ip } }), 20);
  });

  // ------------------------------------------------------------------------------------------
  // B. Failed delivery
  // ------------------------------------------------------------------------------------------

  test("failed delivery: voided at once, never accepted; a later successful resend works", async () => {
    fresh();
    const serial = await makeUnit("FAIL");
    const phone = newPhone();
    whatsapp.mode = "http500";
    assert.equal((await requestOtp(serial, phone)).status, 200, "the public answer is unchanged");
    const lost = sentCode();
    const [row] = await rowsFor(serial);
    assert.equal(row.deliveryStatus, "failed");
    assert.ok(row.expiresAt.getTime() <= Date.now());
    assert.equal((await verifyOtp(serial, phone, lost)).status, 400, "an undelivered code is not a valid authentication code");

    await prisma.publicOtp.updateMany({ where: { serialNorm: serial }, data: { createdAt: new Date(Date.now() - 60_000) } }); // past the 30 s cooldown
    whatsapp.mode = "ok";
    assert.equal((await requestOtp(serial, phone)).status, 200);
    const delivered = sentCode();
    const rows = await rowsFor(serial);
    assert.deepEqual(rows.map((r: any) => r.deliveryStatus), ["failed", "sent"]);
    assert.equal((await verifyOtp(serial, phone, lost)).status, 400, "the failed code still does not work");
    assert.equal((await verifyOtp(serial, phone, delivered)).status, 200);
  });

  test("failed delivery: a failed RESEND does not hide the earlier code that was delivered", async () => {
    fresh();
    const serial = await makeUnit("SHADOW");
    const phone = newPhone();
    await requestOtp(serial, phone);
    const first = sentCode();
    await prisma.publicOtp.updateMany({ where: { serialNorm: serial }, data: { createdAt: new Date(Date.now() - 60_000) } });
    whatsapp.mode = "http500";
    await requestOtp(serial, phone);
    assert.deepEqual((await rowsFor(serial)).map((r: any) => r.deliveryStatus), ["sent", "failed"]);
    whatsapp.mode = "ok";
    assert.equal((await verifyOtp(serial, phone, first)).status, 200, "the person still has the code they received");
  });

  test("a row that was never confirmed as delivered ('pending', e.g. the process died mid-send) cannot be verified", async () => {
    fresh();
    const serial = await makeUnit("PEND");
    const phone = newPhone();
    await requestOtp(serial, phone);
    const code = sentCode();
    await prisma.publicOtp.updateMany({ where: { serialNorm: serial }, data: { deliveryStatus: "pending" } });
    assert.equal((await verifyOtp(serial, phone, code)).status, 400);
  });

  // ------------------------------------------------------------------------------------------
  // Expiry, wrong codes, attempt limits, single use
  // ------------------------------------------------------------------------------------------

  test("expired and wrong codes are refused with the same answer; the right code works once", async () => {
    fresh();
    const serial = await makeUnit("LIFE");
    const phone = newPhone();
    await requestOtp(serial, phone);
    const code = sentCode();
    const bad = await verifyOtp(serial, phone, wrong(code));
    assert.equal(bad.status, 400);
    await prisma.publicOtp.updateMany({ where: { serialNorm: serial }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await verifyOtp(serial, phone, code);
    assert.equal(expired.status, 400);
    assert.deepEqual(expired.body, bad.body, "expired and wrong are indistinguishable");

    await prisma.publicOtp.updateMany({ where: { serialNorm: serial }, data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) } });
    await requestOtp(serial, phone);
    const second = sentCode();
    const ok = await verifyOtp(serial, phone, second);
    assert.equal(ok.status, 200);
    assert.equal((await verifyOtp(serial, phone, second)).status, 400, "single use");
  });

  test("simultaneous correct verifications produce exactly one session; simultaneous wrong guesses stop at the attempt cap", async () => {
    fresh();
    const serial = await makeUnit("ATT");
    const phone = newPhone();
    await requestOtp(serial, phone);
    const code = sentCode();
    await Promise.all(Array.from({ length: 12 }, () => verifyOtp(serial, phone, wrong(code))));
    const [row] = await rowsFor(serial);
    assert.equal(row.attempts, PUBLIC_OTP.MAX_VERIFY_ATTEMPTS, "never more than the cap, however many parallel guesses");
    assert.equal((await verifyOtp(serial, phone, code)).status, 400, "locked: even the right code is refused");

    const serial2 = await makeUnit("ONCE");
    const phone2 = newPhone();
    await requestOtp(serial2, phone2);
    const code2 = sentCode();
    const results = await Promise.all(Array.from({ length: 8 }, () => verifyOtp(serial2, phone2, code2)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.body?.sessionToken).length, 1);
  });

  test("an unknown serial is answered identically and nothing is sent; the attempt is still recorded (so it is rate limited too)", async () => {
    fresh();
    const real = await makeUnit("REALSN");
    const a = await requestOtp(real, newPhone());
    const unknownSerial = `${PREFIX}-NOPE`;
    tracked.serials.add(unknownSerial);
    const b = await requestOtp(unknownSerial, newPhone());
    assert.deepEqual(b.body, a.body);
    assert.equal(whatsapp.calls.length, 1);
    const [row] = await rowsFor(unknownSerial);
    assert.equal(row.unitId, null);
    assert.equal(row.deliveryStatus, "skipped");
  });
});
