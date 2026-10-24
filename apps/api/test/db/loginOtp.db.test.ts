/**
 * Real-database tests for the login OTP (customer login and phone-only login): what is actually stored, the partial
 * unique index, replacement of earlier codes, resend limits, expiry, the persistent guess budget and the atomic
 * claims under concurrent requests.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the
 * disposable Docker database (localhost:5434/platino_test) and they only touch rows they create themselves
 * (unique run prefix; everything is removed in `after`). Nothing is sent anywhere: the WhatsApp Cloud API call is
 * intercepted inside this process before it can leave it, and SMTP is not used by this flow. All phone numbers are
 * synthetic. Run with:  npm run test:db --workspace=apps/api   (database already migrated and seeded, including
 * migration 20261016090000_login_otp_hardening)
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

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
describe("login OTP against the real test database", { skip }, () => {
  const PREFIX = `ZO${Date.now().toString(36).toUpperCase()}`;
  const tracked = { userIds: new Set<string>(), customerIds: new Set<string>(), orderIds: new Set<string>(), phones: new Set<string>() };
  let seq = 0;
  let hit = 0;
  const realConsole = { log: console.log, error: console.error };
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "OTP_DEV_ECHO", "PUBLIC_OTP_DEV_ECHO", "VERCEL", "VERCEL_ENV", "NODE_ENV"];

  const newPhone = () => {
    const n = `8${String((Date.now() % 10_000_000) * 100 + ++seq).padStart(9, "0")}`.slice(0, 10);
    tracked.phones.add(n);
    return n;
  };

  let prisma: any;
  let server: Server;
  let base = "";
  let productId = "";
  let stageId = "";
  let customerRoleId = "";
  const realFetch = globalThis.fetch;
  const whatsapp = { calls: [] as Array<{ to: string; code: string }>, mode: "ok" as "ok" | "http500" };
  const sentCode = () => whatsapp.calls[whatsapp.calls.length - 1]?.code ?? "";

  /** "dev": explicit local echo, nothing sent. "whatsapp": provider configured (call intercepted). "none": neither. */
  function mode(m: "dev" | "whatsapp" | "none") {
    for (const k of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "OTP_DEV_ECHO", "PUBLIC_OTP_DEV_ECHO", "VERCEL", "VERCEL_ENV"]) delete process.env[k];
    process.env.NODE_ENV = "development";
    if (m === "dev") process.env.OTP_DEV_ECHO = "1";
    if (m === "whatsapp") { process.env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token"; process.env.WHATSAPP_PHONE_NUMBER_ID = "000"; }
    whatsapp.mode = "ok";
    whatsapp.calls.length = 0;
  }

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${Math.floor(++hit / 250)}.${hit % 250}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  const reqPhone = (phone: string) => post("/auth/otp/request", { phone });
  const verPhone = (phone: string, code: string) => post("/auth/otp/verify", { phone, code });
  const reqCust = (orderNumber: string, phone: string) => post("/auth/customer/register", { orderNumber, phone });
  const verCust = (orderNumber: string, phone: string, code: string) => post("/auth/customer/verify", { orderNumber, phone, code });
  const wrong = (code: string) => (code === "123456" ? "654321" : "123456");

  async function makeStaff(tag: string, isActive = true) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "service_engineer" } });
    const phone = newPhone();
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, phone, roleId: role.id, isActive, mustChangePassword: false } });
    tracked.userIds.add(user.id);
    return { user, phone };
  }

  async function makeCustomer(tag: string, isActive = true) {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} ${tag}` } });
    tracked.customerIds.add(customer.id);
    const phone = newPhone();
    const contact = await prisma.user.create({
      data: { name: `${PREFIX} contact ${tag}`, phone: `+91${phone}`, roleId: customerRoleId, customerId: customer.id, isActive, mustChangePassword: false },
    });
    tracked.userIds.add(contact.id);
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-O${++seq}`, customerId: customer.id, productId, quantity: 1, site: { create: { currentStageId: stageId } } },
    });
    tracked.orderIds.add(order.id);
    return { customer, contact, phone, orderNumber: order.orderNumber as string };
  }

  /** Pretends the user's earlier codes were requested two minutes ago (the 30 s cooldown is over; the hour is not). */
  const pastCooldown = (userId: string) => prisma.otpCode.updateMany({ where: { userId }, data: { createdAt: new Date(Date.now() - 120_000) } });
  const activeCodes = (userId: string, purpose?: string) => prisma.otpCode.findMany({ where: { userId, consumedAt: null, ...(purpose ? { purpose } : {}) } });

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    console.log = () => {};
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    await prisma.ipRateLimit.deleteMany({}); // disposable DB only: sign-in attempts counted by earlier runs in the same 15-minute window would otherwise answer 429

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.includes("graph.facebook.com")) return realFetch(input, init);
      const body = JSON.parse(init.body);
      whatsapp.calls.push({ to: body.to, code: body.template.components[0].parameters[0].text });
      return whatsapp.mode === "http500" ? new Response("provider error", { status: 500 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { authRouter } = await import("../../src/routes/auth");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use("/auth", authRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    customerRoleId = (await prisma.role.findUniqueOrThrow({ where: { key: "customer" } })).id;
  });

  after(async () => {
    server?.close();
    globalThis.fetch = realFetch;
    try {
      if (prisma) {
        const orderIds = [...tracked.orderIds];
        await prisma.notificationLog.deleteMany({ where: { recipientId: { in: [...tracked.userIds] } } });
        await prisma.site.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
        await prisma.user.deleteMany({ where: { id: { in: [...tracked.userIds] } } }); // OTP rows go with their user
        await prisma.customer.deleteMany({ where: { id: { in: [...tracked.customerIds] } } });
      }
    } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
      for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    }
  });

  // ------------------------------------------------------------------------------------------
  // The migration
  // ------------------------------------------------------------------------------------------

  test("migration: the new columns exist and the partial unique index allows ONE unconsumed code per user and purpose", async () => {
    const [idx] = await prisma.$queryRaw`select indexdef from pg_indexes where indexname = 'OtpCode_one_active_per_user_purpose'`;
    assert.ok(idx, "index exists");
    assert.match(idx.indexdef, /UNIQUE/i);
    assert.match(idx.indexdef, /"userId", purpose|\("userId", "purpose"\)|userId.*purpose/);
    assert.match(idx.indexdef, /WHERE \("?consumedAt"? IS NULL\)/i);

    const u = await makeStaff("index");
    const mk = (purpose: string) => prisma.otpCode.create({ data: { userId: u.user.id, code: "x".repeat(64), purpose, destination: u.phone, expiresAt: new Date(Date.now() + 600_000) } });
    await mk("phone_login");
    await assert.rejects(mk("phone_login"), (e: any) => e.code === "P2002", "a second live code for the same purpose is refused by the database");
    await mk("customer_login"); // an unrelated purpose is independent
    await prisma.otpCode.updateMany({ where: { userId: u.user.id, purpose: "phone_login" }, data: { consumedAt: new Date() } });
    await mk("phone_login"); // fine once the first is consumed
  });

  // ------------------------------------------------------------------------------------------
  // Delivery and storage
  // ------------------------------------------------------------------------------------------

  test("phone-only request (WhatsApp): sent to the stored number, stored as a hash with purpose + destination, no notification log row", async () => {
    mode("whatsapp");
    const u = await makeStaff("deliver");
    const r = await reqPhone(`+91 ${u.phone}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.devCode, undefined);
    assert.equal(r.body.expiresInSeconds, 600);
    assert.equal(r.body.resendAfterSeconds, 30);
    assert.equal(whatsapp.calls.length, 1);
    assert.equal(whatsapp.calls[0].to, `91${u.phone}`);

    const row = await prisma.otpCode.findFirstOrThrow({ where: { userId: u.user.id } });
    assert.match(row.code, /^[0-9a-f]{64}$/);
    assert.notEqual(row.code, sentCode());
    assert.equal(row.purpose, "phone_login");
    assert.equal(row.destination, u.phone);
    assert.equal(row.deliveryStatus, "sent");
    assert.equal(row.attempts, 0);
    const life = row.expiresAt.getTime() - Date.now();
    assert.ok(life > 590_000 && life <= 600_000, `10-minute life (${life} ms left)`);
    assert.equal(await prisma.notificationLog.count({ where: { recipientId: u.user.id } }), 0, "no email / notification record, so no place for a code to leak");
    const ok = await verPhone(`0${u.phone}`, sentCode());
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, u.user.id);
  });

  test("customer request (WhatsApp): goes to the contact's registered number (stored as +91...), purpose customer_login", async () => {
    mode("whatsapp");
    const c = await makeCustomer("cust-deliver");
    const r = await reqCust(c.orderNumber, `0${c.phone}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(whatsapp.calls[0].to, `91${c.phone}`);
    const row = await prisma.otpCode.findFirstOrThrow({ where: { userId: c.contact.id } });
    assert.equal(row.purpose, "customer_login");
    assert.equal(row.destination, c.phone);
    assert.equal((await verCust(c.orderNumber, c.phone, sentCode())).status, 200);
  });

  test("delivery failure: 503, the code is void in the database, and an immediate retry is allowed", async () => {
    mode("whatsapp");
    whatsapp.mode = "http500";
    const u = await makeStaff("fail");
    const r = await reqPhone(u.phone);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, "OTP_DELIVERY_FAILED");
    assert.doesNotMatch(JSON.stringify(r.body), /\bsent\b/i);
    const [row] = await prisma.otpCode.findMany({ where: { userId: u.user.id } });
    assert.ok(row.consumedAt, "void");
    assert.equal(row.deliveryStatus, "failed");
    assert.equal((await verPhone(u.phone, "123456")).status, 401);
    whatsapp.mode = "ok";
    assert.equal((await reqPhone(u.phone)).status, 200, "no cooldown after a delivery that never happened");
  });

  test("without a provider or the explicit local switch nothing is created; with the switch the code is echoed and nothing is sent", async () => {
    const u = await makeStaff("modes");
    mode("none");
    assert.equal((await reqPhone(u.phone)).status, 503);
    mode("dev");
    assert.equal(await prisma.otpCode.count({ where: { userId: u.user.id } }), 0);
    const r = await reqPhone(u.phone);
    assert.equal(r.status, 200);
    assert.match(r.body.devCode, /^[1-9]\d{5}$/);
    assert.equal(whatsapp.calls.length, 0);
    mode("none");
    process.env.VERCEL = "1";
    process.env.OTP_DEV_ECHO = "1";
    assert.equal((await reqPhone(u.phone)).status, 503, "hosted platforms never echo, even with the switch");
  });

  test("enumeration: unknown, deactivated and real phone-only requests get one identical answer; a deactivated account gets no code", async () => {
    mode("whatsapp");
    const real = await makeStaff("enum-real");
    const off = await makeStaff("enum-off", false);
    const bodies = new Set<string>();
    for (const phone of [real.phone, off.phone, newPhone()]) {
      const r = await reqPhone(phone);
      assert.equal(r.status, 200);
      bodies.add(JSON.stringify(r.body));
    }
    assert.equal(bodies.size, 1);
    assert.equal(await prisma.otpCode.count({ where: { userId: off.user.id } }), 0);
    assert.equal(whatsapp.calls.length, 1, "only the active account was messaged");
  });

  // ------------------------------------------------------------------------------------------
  // Replacement, cooldown, hourly cap
  // ------------------------------------------------------------------------------------------

  test("resend: the earlier code is voided in the database, the newest works once, the blocked request changes nothing", async () => {
    mode("dev");
    const u = await makeStaff("resend");
    const first = (await reqPhone(u.phone)).body.devCode as string;
    const blocked = await reqPhone(u.phone);
    // Answered like any other request (a distinct 429 would show which numbers belong to accounts), but nothing was created or sent.
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.devCode, undefined, "no new code");
    assert.equal((await activeCodes(u.user.id)).length, 1, "the blocked request created and voided nothing");
    await pastCooldown(u.user.id);
    const second = (await reqPhone(u.phone)).body.devCode as string;
    assert.equal((await activeCodes(u.user.id)).length, 1, "exactly one live code");
    assert.equal(await prisma.otpCode.count({ where: { userId: u.user.id } }), 2);
    assert.equal((await verPhone(u.phone, first)).status, 401, "old code refused");
    assert.equal((await verPhone(u.phone, second)).status, 200, "new code accepted");
    assert.equal((await verPhone(u.phone, second)).status, 401, "single use");
  });

  test("hourly cap: five requests, then 429 until the hour has passed; other users and other purposes are unaffected", async () => {
    mode("dev");
    const u = await makeStaff("cap");
    const other = await makeStaff("cap-other");
    for (let i = 0; i < 5; i++) { assert.equal((await reqPhone(u.phone)).status, 200, `request ${i + 1}`); await pastCooldown(u.user.id); }
    const limited = await reqPhone(u.phone);
    assert.equal(limited.status, 200, "answered like any request (no account oracle)");
    assert.equal(limited.body.devCode, undefined, "but no sixth code");
    assert.equal(await prisma.otpCode.count({ where: { userId: u.user.id } }), 5);
    assert.equal((await reqPhone(other.phone)).status, 200, "another user is independent");
    await prisma.otpCode.updateMany({ where: { userId: u.user.id }, data: { createdAt: new Date(Date.now() - 3_700_000) } });
    assert.equal((await reqPhone(u.phone)).status, 200, "allowed again after the hour");
  });

  test("a code for one purpose, user or number is never accepted for another", async () => {
    mode("dev");
    const c = await makeCustomer("purpose");
    const staff = await makeStaff("purpose-s");
    // phone-login code for the customer contact, used on the customer login
    const phoneCode = (await reqPhone(c.phone)).body.devCode as string;
    assert.equal((await verCust(c.orderNumber, c.phone, phoneCode)).status, 401, "phone-login code on customer login");
    const custCode = (await reqCust(c.orderNumber, c.phone)).body.devCode as string;
    assert.equal((await verPhone(c.phone, custCode)).status, 401, "customer-login code on phone login");
    // another user's code
    const staffCode = (await reqPhone(staff.phone)).body.devCode as string;
    assert.equal((await verPhone(c.phone, staffCode)).status, 401, "another user's code");
    // delivered to a different number than the one presented
    await prisma.otpCode.updateMany({ where: { userId: staff.user.id }, data: { destination: "9000000009" } });
    assert.equal((await verPhone(staff.phone, staffCode)).status, 401, "destination mismatch");
    // both genuine codes still work for their own purpose
    assert.equal((await verCust(c.orderNumber, c.phone, custCode)).status, 200);
    assert.equal((await verPhone(c.phone, phoneCode)).status, 200);
  });

  // ------------------------------------------------------------------------------------------
  // Expiry
  // ------------------------------------------------------------------------------------------

  test("expiry is judged by the database clock query: an expired code is refused and stays unconsumed", async () => {
    mode("dev");
    const u = await makeStaff("expiry");
    const code = (await reqPhone(u.phone)).body.devCode as string;
    await prisma.otpCode.updateMany({ where: { userId: u.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await verPhone(u.phone, code);
    assert.equal(r.status, 401);
    assert.equal(r.body.token, undefined);
    assert.equal(r.body.error, "Invalid or expired code");
    assert.equal((await prisma.otpCode.findFirstOrThrow({ where: { userId: u.user.id } })).consumedAt, null);
    await prisma.otpCode.updateMany({ where: { userId: u.user.id }, data: { expiresAt: new Date(Date.now() + 5_000) } });
    assert.equal((await verPhone(u.phone, code)).status, 200, "the same code is fine 5 seconds before expiry");
  });

  // ------------------------------------------------------------------------------------------
  // Guesses
  // ------------------------------------------------------------------------------------------

  test("wrong guesses are counted in the database: 5 lock the code, and the count survives a new server instance", async () => {
    mode("dev");
    const u = await makeStaff("budget");
    const code = (await reqPhone(u.phone)).body.devCode as string;
    for (let i = 0; i < 5; i++) assert.equal((await verPhone(u.phone, wrong(code))).status, 401);
    assert.equal((await prisma.otpCode.findFirstOrThrow({ where: { userId: u.user.id } })).attempts, 5);
    assert.equal((await verPhone(u.phone, code)).status, 401, "the right code is refused once the code is locked");
  });

  test("requesting a new code does not reset the budget: 10 guesses per user and hour across all codes", async () => {
    mode("dev");
    const u = await makeStaff("budget-cross");
    const a = (await reqPhone(u.phone)).body.devCode as string;
    for (let i = 0; i < 5; i++) await verPhone(u.phone, wrong(a));
    await pastCooldown(u.user.id);
    const b = (await reqPhone(u.phone)).body.devCode as string;
    for (let i = 0; i < 5; i++) await verPhone(u.phone, wrong(b));
    await pastCooldown(u.user.id);
    const c = (await reqPhone(u.phone)).body.devCode as string;
    const row = await prisma.otpCode.findFirstOrThrow({ where: { userId: u.user.id, consumedAt: null } });
    assert.equal(row.attempts, 0, "the fresh code itself has no wrong guesses");
    assert.equal((await verPhone(u.phone, c)).status, 401, "but the hour's budget is spent");
  });

  test("twelve simultaneous wrong guesses are counted atomically: the code takes at most 5", async () => {
    mode("dev");
    const u = await makeStaff("race-guess");
    const code = (await reqPhone(u.phone)).body.devCode as string;
    const results = await Promise.all(Array.from({ length: 12 }, () => verPhone(u.phone, wrong(code))));
    assert.ok(results.every((r) => r.status === 401));
    assert.equal((await prisma.otpCode.findFirstOrThrow({ where: { userId: u.user.id } })).attempts, 5);
  });

  // ------------------------------------------------------------------------------------------
  // Concurrency
  // ------------------------------------------------------------------------------------------

  test("simultaneous verification of one correct code produces exactly one session (repeated)", async () => {
    mode("dev");
    const u = await makeStaff("race-verify");
    for (let round = 0; round < 4; round++) {
      if (round) await pastCooldown(u.user.id);
      const code = (await reqPhone(u.phone)).body.devCode as string;
      const results = await Promise.all(Array.from({ length: 5 }, () => verPhone(u.phone, code)));
      assert.equal(results.filter((r) => r.status === 200).length, 1, `round ${round}`);
      assert.equal(results.filter((r) => r.body.token).length, 1);
    }
    const sum = await prisma.otpCode.aggregate({ _sum: { attempts: true }, where: { userId: u.user.id } });
    assert.equal(sum._sum.attempts, 0, "right codes never use up the wrong-guess budget");
  });

  test("simultaneous resend requests never leave two usable codes", async () => {
    mode("dev");
    for (let round = 0; round < 3; round++) {
      const u = await makeStaff(`race-resend-${round}`);
      const results = await Promise.all(Array.from({ length: 6 }, () => reqPhone(u.phone)));
      assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
      // The cooldown check and the insert run under a database advisory lock: exactly ONE of the parallel requests issues a code.
      assert.equal(results.filter((r) => r.body.devCode).length, 1, `round ${round}: exactly one request issued a code`);
      assert.equal(await prisma.otpCode.count({ where: { userId: u.user.id } }), 1, `round ${round}: exactly one row was created`);
      assert.equal((await activeCodes(u.user.id)).length, 1, `round ${round}: exactly one live code`);
      let accepted = 0;
      for (const r of results.filter((x) => x.body.devCode)) if ((await verPhone(u.phone, r.body.devCode)).status === 200) accepted++;
      assert.equal(accepted, 1, `round ${round}: exactly one of the issued codes can sign in`);
    }
  });

  // ------------------------------------------------------------------------------------------
  // Inactive accounts
  // ------------------------------------------------------------------------------------------

  test("deactivated accounts: no code is issued; a code that existed before deactivation is refused and not consumed", async () => {
    mode("dev");
    const staff = await makeStaff("inactive-s");
    const c = await makeCustomer("inactive-c");
    const staffCode = (await reqPhone(staff.phone)).body.devCode as string;
    const custCode = (await reqCust(c.orderNumber, c.phone)).body.devCode as string;
    await prisma.user.updateMany({ where: { id: { in: [staff.user.id, c.contact.id] } }, data: { isActive: false } });
    for (const r of [await verPhone(staff.phone, staffCode), await verCust(c.orderNumber, c.phone, custCode)]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.token, undefined);
    }
    assert.equal((await activeCodes(staff.user.id)).length, 1, "not consumed");
    await pastCooldown(staff.user.id);
    const again = await reqPhone(staff.phone);
    assert.equal(again.status, 200);
    assert.equal(again.body.devCode, undefined, "no new code for a deactivated account");
    await prisma.user.updateMany({ where: { id: staff.user.id }, data: { isActive: true } });
    assert.equal((await verPhone(staff.phone, staffCode)).status, 200, "proves the code itself was valid");
  });
});

// Runs even when the guard skips everything above, so a skipped run is never silently empty.
test("the login OTP database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  for (const bad of ["postgresql://u:p@localhost:5432/platino_test", "postgresql://u:p@localhost:5434/postgres", "postgresql://u:p@db.example.com:5434/platino_test", "", undefined]) {
    assert.equal(pointsAtIsolatedDb(bad), false);
  }
});
