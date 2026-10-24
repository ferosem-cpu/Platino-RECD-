// Security and behaviour tests for the customer login OTP and the phone-only (mobile app) OTP login.
//
// No database and nothing is sent: Prisma's OtpCode table is replaced by an in-memory model that behaves like
// the real one (test/helpers/fakeOtpStore.ts), and the WhatsApp Cloud API call is intercepted before it leaves
// the process. The real routers run on a throwaway Express app. What these tests cannot show - that the real
// table's atomic updates, unique index and migration behave the same - is checked against the isolated local
// database in test/db/loginOtp.db.test.ts. Live delivery to a phone is NOT tested anywhere (no provider is
// configured). All phone numbers and codes are synthetic.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { LOGIN_OTP_POLICY, LOGIN_OTP_PURPOSE } from "@recd/shared";
import {
  LOGIN_OTP,
  OTP_BAD_CODE_MESSAGE,
  OTP_DELIVERY_FAILED_MESSAGE,
  OTP_UNAVAILABLE_MESSAGE,
  generateLoginOtpCode,
  hashLoginOtp,
  verifyLoginOtpHash,
} from "../src/lib/loginOtp";
import { devEchoAllowed, getOtpDelivery, isHostedOrProduction } from "../src/lib/otpDelivery";
import { loggablePayload } from "../src/services/notifications/notificationService";
import { createFakeOtpStore } from "./helpers/fakeOtpStore";
import { createFakeRateLimitStore } from "./helpers/fakeRateLimitStore";
import { installFakeTransactions } from "./helpers/fakeTransactions";

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

const nodeCrypto = require("crypto") as typeof import("crypto");
const N = "9876543210"; // synthetic: customer contact k1 / staff s1
const OTHER = "9123456780"; // synthetic: customer contact k2 / staff s2
const ORDER = "ORD-T1";
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---- WhatsApp: intercepted, never reaches the network ------------------------------------------
const whatsapp = { calls: [] as Array<{ to: string; code: string; template: string }>, mode: "ok" as "ok" | "http500" | "throw" };
const realFetch = globalThis.fetch;
const sentCode = () => whatsapp.calls[whatsapp.calls.length - 1]?.code ?? "";

const PROVIDER_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "OTP_DEV_ECHO", "PUBLIC_OTP_DEV_ECHO", "VERCEL", "VERCEL_ENV", "RENDER", "DYNO", "K_SERVICE", "AWS_LAMBDA_FUNCTION_NAME"];
function setup(mode: "whatsapp" | "dev" | "none", opts: { nodeEnv?: string; extra?: Record<string, string> } = {}) {
  for (const k of PROVIDER_ENV) delete process.env[k];
  process.env.NODE_ENV = opts.nodeEnv ?? "development";
  if (mode === "whatsapp") { process.env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token"; process.env.WHATSAPP_PHONE_NUMBER_ID = "000"; }
  if (mode === "dev") process.env.OTP_DEV_ECHO = "1";
  Object.assign(process.env, opts.extra ?? {});
  whatsapp.mode = "ok";
}

const consoleLines: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
const realEnv = { NODE_ENV: process.env.NODE_ENV };

let store = createFakeOtpStore();
let contactK1: any;
let contactK2: any;
let staffS1: any;
let staffS2: any;
const contact = (extra: Record<string, unknown> = {}) => ({ id: "k1", name: "Asha", phone: N, email: null, isActive: true, customerId: "cA", ...extra });
const staff = (extra: Record<string, unknown> = {}) => ({ id: "s1", name: "Eng", phone: N, isActive: true, customerId: null, role: { key: "service_engineer" }, ...extra });

let server: Server;
let base = "";
let hit = 0;

before(async () => {
  for (const level of ["log", "error", "warn", "info"] as const) {
    (console as any)[level] = (...args: unknown[]) => { consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  }
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.includes("graph.facebook.com")) return realFetch(input, init);
    if (whatsapp.mode === "throw") throw new Error("network down");
    const body = JSON.parse(init.body);
    whatsapp.calls.push({ to: body.to, code: body.template.components[0].parameters[0].text, template: body.template.name });
    return whatsapp.mode === "http500" ? new Response("provider error", { status: 500 }) : new Response("{}", { status: 200 });
  }) as typeof fetch;

  const { prisma } = await import("../src/lib/prisma");
  installFakeTransactions(prisma); // OTP limits are decided under advisory locks inside a transaction
  createFakeRateLimitStore().install(prisma); // the IP limiter keeps its counters in the database; here they live in memory
  const { authRouter } = await import("../src/routes/auth");
  for (const model of ["user", "order", "otpCode", "notificationLog", "recdUnit"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/auth", authRouter);
  const { authenticate } = await import("../src/middleware/auth");
  app.get("/protected", authenticate, (req: any, res) => res.json({ ok: true, userId: req.auth.userId, role: req.auth.roleKey }));
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
  for (const k of PROVIDER_ENV) delete process.env[k];
  if (realEnv.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = realEnv.NODE_ENV;
});

function reset(mode: "whatsapp" | "dev" | "none" = "whatsapp", opts: Parameters<typeof setup>[1] = {}) {
  for (const k of Object.keys(calls)) delete calls[k];
  consoleLines.length = 0;
  whatsapp.calls.length = 0;
  setup(mode, opts);
  store = createFakeOtpStore();
  contactK1 = contact();
  contactK2 = contact({ id: "k2", name: "Bala", phone: `+91${OTHER}` });
  staffS1 = staff();
  staffS2 = staff({ id: "s2", phone: OTHER });
  const phoneUsers = () => [contactK1, contactK2, staffS1, staffS2].map((u) => ({ role: { key: "customer" }, ...u }));
  stubModel("user", {
    findUnique: () => null,
    findFirst: ({ where }: any) => {
      const wanted: string[] = where.phone.in;
      // staff s1/s2 share their numbers with k1/k2 in some tests; the phone-only lookup returns the first match
      return phoneUsers().find((u) => wanted.some((w) => (u.phone ?? "").replace(/\D/g, "").endsWith(w.replace(/\D/g, "").slice(-10)))) ?? null;
    },
    findUniqueOrThrow: ({ where }: any) => ({ role: { key: where.id.startsWith("k") ? "customer" : "service_engineer" } }),
  });
  stubModel("order", { findUnique: ({ where }: any) => (where.orderNumber === ORDER || where.id === "o1" ? { id: "o1", orderNumber: ORDER, customer: { id: "cA", contacts: [contactK1, contactK2] } } : null) });
  stubModel("recdUnit", { findUnique: ({ where }: any) => (where.serialNo === "SN-0001" ? { orderId: "o1" } : null) });
  stubModel("otpCode", store.stub);
  stubModel("notificationLog", { create: () => ({}) });
}

async function post(path: string, body: unknown, ip?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip ?? `10.2.${Math.floor(++hit / 250)}.${hit % 250}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text, retryAfter: res.headers.get("retry-after") };
}
const customerRequest = (phone = N, orderNumber = ORDER) => post("/auth/customer/register", { orderNumber, phone });
const customerVerify = (code: string, phone = N, orderNumber = ORDER) => post("/auth/customer/verify", { orderNumber, phone, code });
const phoneRequest = (phone = N) => post("/auth/otp/request", { phone });
const phoneVerify = (code: string, phone = N) => post("/auth/otp/verify", { phone, code });
const everythingLogged = () => consoleLines.join("\n");
const waitOutCooldown = () => store.age((LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS + 1) * 1000);
const wrongCode = (real: string) => (real === "111111" ? "222222" : "111111");

// =============================================================================================
// Generation, storage format, policy (unit level)
// =============================================================================================

test("login codes come from crypto.randomInt in the 6-digit range - Math.random is never touched", () => {
  const seen: unknown[][] = [];
  const real = (nodeCrypto as any).randomInt;
  const realRandom = Math.random;
  (nodeCrypto as any).randomInt = (...args: unknown[]) => { seen.push(args); return 654321; };
  Math.random = () => { throw new Error("Math.random must not be used for an OTP"); };
  try {
    assert.equal(generateLoginOtpCode(), "654321");
  } finally {
    (nodeCrypto as any).randomInt = real;
    Math.random = realRandom;
  }
  assert.deepEqual(seen, [[100_000, 1_000_000]]);
  for (let i = 0; i < 200; i++) assert.match(generateLoginOtpCode(), /^[1-9]\d{5}$/);
});

test("neither the OTP code nor the auth routes use Math.random, and no log line anywhere prints a code", () => {
  const src = path.join(__dirname, "..", "src");
  for (const file of ["lib/loginOtp.ts", "lib/otpDelivery.ts", "lib/publicOtp.ts", "routes/auth.ts"]) {
    assert.doesNotMatch(stripComments(fs.readFileSync(path.join(src, file), "utf8")), /Math\.random/, file);
  }
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!/console\.(log|error|warn|info)\(/.test(line)) return;
        if (/\$\{\s*(code|otp|token|password|tempPassword)\b|,\s*(code|otp|token|password)\s*[,)]|OTP:|code for/i.test(line)) offenders.push(`${path.relative(src, p).split(path.sep).join("/")}:${i + 1}`);
      });
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], "no console call may print a code (the old development console provider is gone)");
});

test("only a keyed hash is stored: it hides the code, binds it to the row and the user, and fails closed", () => {
  const h = hashLoginOtp("otp1", "u1", "123456");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes("123456"));
  assert.equal(verifyLoginOtpHash("otp1", "u1", "123456", h), true);
  assert.equal(verifyLoginOtpHash("otp1", "u1", "123457", h), false, "wrong code");
  assert.equal(verifyLoginOtpHash("otp1", "u2", "123456", h), false, "another user");
  assert.equal(verifyLoginOtpHash("otp2", "u1", "123456", h), false, "another row");
  assert.equal(verifyLoginOtpHash("otp1", "u1", "123456", "abc"), false, "a malformed stored value never matches and never throws");
  const old = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "a-different-server-secret";
  try { assert.notEqual(hashLoginOtp("otp1", "u1", "123456"), h, "the hash depends on the server secret"); } finally { process.env.JWT_SECRET = old; }
});

test("the notification log never keeps a code, while other notifications are logged unchanged", () => {
  assert.deepEqual(loggablePayload("otp_code", { code: "424242", orderNumber: ORDER }), { code: "[redacted]", orderNumber: ORDER });
  assert.deepEqual(loggablePayload("complaint_raised", { ticketNumber: "TCK-1" }), { ticketNumber: "TCK-1" });
});

test("one policy: the server's expiry equals the shared policy the apps display", () => {
  assert.equal(LOGIN_OTP.TTL_MS, LOGIN_OTP_POLICY.EXPIRY_SECONDS * 1000);
  assert.equal(LOGIN_OTP_POLICY.EXPIRY_SECONDS, 600, "login codes keep their 10-minute life");
  assert.equal(LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS, 30);
});

// =============================================================================================
// Development disclosure: off by default, explicit opt-in, never hosted or in production
// =============================================================================================

test("a code can be returned in a response ONLY with the explicit opt-in, on a developer machine", () => {
  assert.equal(devEchoAllowed({}), false, "unset environment: off");
  assert.equal(devEchoAllowed({ NODE_ENV: "development" }), false, "development WITHOUT the opt-in: off");
  assert.equal(devEchoAllowed({ NODE_ENV: "test" }), false);
  assert.equal(devEchoAllowed({ OTP_DEV_ECHO: "0" }), false);
  assert.equal(devEchoAllowed({ OTP_DEV_ECHO: "true" }), false, "only the exact value 1 counts");
  assert.equal(devEchoAllowed({ NODE_ENV: "development", OTP_DEV_ECHO: "1" }), true);
  assert.equal(devEchoAllowed({ OTP_DEV_ECHO: "1" }), true, "unset NODE_ENV on a laptop + opt-in");
  assert.equal(devEchoAllowed({ NODE_ENV: "development", PUBLIC_OTP_DEV_ECHO: "1" }), true, "the older name still works");
  for (const hosted of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" }, { RENDER: "true" }, { DYNO: "web.1" }, { K_SERVICE: "api" }, { AWS_LAMBDA_FUNCTION_NAME: "f" }, { FLY_APP_NAME: "x" }]) {
    assert.equal(devEchoAllowed({ ...hosted, OTP_DEV_ECHO: "1", PUBLIC_OTP_DEV_ECHO: "1" } as any), false, JSON.stringify(hosted));
    assert.equal(isHostedOrProduction(hosted as any), true);
  }
  assert.equal(getOtpDelivery({}), null, "no provider, no opt-in: login by code is unavailable");
  assert.equal(getOtpDelivery({ NODE_ENV: "development" }), null);
  assert.equal(getOtpDelivery({ OTP_DEV_ECHO: "1" })?.name, "dev");
  assert.equal(getOtpDelivery({ NODE_ENV: "production", OTP_DEV_ECHO: "1" }), null);
  assert.equal(getOtpDelivery({ WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_PHONE_NUMBER_ID: "1", NODE_ENV: "production" })?.name, "whatsapp");
});

test("without a provider or the opt-in, a code request is 'not available' for EVERYONE - and nothing is created", async () => {
  for (const [label, mode, opts] of [
    ["nothing configured", "none", {}],
    ["development without the opt-in", "none", { nodeEnv: "development" }],
    ["hosted with the opt-in", "dev", { extra: { VERCEL: "1" } }],
    ["production with the opt-in", "dev", { nodeEnv: "production" }],
  ] as const) {
    reset(mode, opts);
    const known = await customerRequest();
    const unknown = await customerRequest(OTHER, "NO-SUCH-ORDER");
    const phone = await phoneRequest();
    for (const r of [known, unknown, phone]) {
      assert.equal(r.status, 503, label);
      assert.equal(r.body.error, OTP_UNAVAILABLE_MESSAGE);
      assert.equal(r.body.devCode, undefined);
    }
    assert.equal(store.rows.length, 0, `${label}: no code created`);
    assert.equal(whatsapp.calls.length, 0);
  }
});

test("explicit local development: the code is returned, labelled, nothing is sent and nothing is logged", async () => {
  reset("dev");
  const r = await customerRequest();
  assert.equal(r.status, 200);
  assert.match(r.body.devCode, /^\d{6}$/);
  assert.match(r.body.message, /Development mode/);
  assert.equal(whatsapp.calls.length, 0, "nothing was sent to a phone");
  assert.ok(!everythingLogged().includes(r.body.devCode), "the code is not in any log line");
  const v = await customerVerify(r.body.devCode);
  assert.equal(v.status, 200, "the echoed code works exactly once");
  assert.equal((await customerVerify(r.body.devCode)).status, 401);
});

test("with WhatsApp configured the code is never echoed, even if the opt-in is also set", async () => {
  reset("whatsapp", { extra: { OTP_DEV_ECHO: "1" } });
  const r = await customerRequest();
  assert.equal(r.status, 200);
  assert.equal(r.body.devCode, undefined);
  assert.equal(whatsapp.calls.length, 1);
  assert.ok(!r.raw.includes(sentCode()));
});

// =============================================================================================
// Customer login: delivery to the REGISTERED mobile number
// =============================================================================================

test("customer request: the code goes by WhatsApp to the number stored on the contact - whatever spelling was typed", async () => {
  for (const [stored, typed] of [[N, `+91${N}`], [`+91${N}`, `0${N}`], [`91${N}`, "98765 43210"]] as const) {
    reset();
    contactK1 = contact({ phone: stored });
    const r = await customerRequest(typed);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(whatsapp.calls.length, 1);
    assert.equal(whatsapp.calls[0].to, `91${N}`, "normalised registered number");
    assert.equal(whatsapp.calls[0].template, "recd_otp");
    assert.match(sentCode(), /^[1-9]\d{5}$/);
  }
});

test("customer request: the answer promises nothing the system did not do, carries the timings, and never contains the code", async () => {
  reset();
  const r = await customerRequest();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["expiresInSeconds", "message", "ok", "resendAfterSeconds"]);
  assert.equal(r.body.expiresInSeconds, 600);
  assert.equal(r.body.resendAfterSeconds, 30);
  assert.match(r.body.message, /^If those details match an active account/);
  assert.ok(!r.raw.includes(sentCode()));
  assert.equal(called("notificationLog.create").length, 0, "no email / notification row is involved any more");
  assert.ok(!everythingLogged().includes(sentCode()), "the code is in no log line");
  assert.ok(!everythingLogged().includes(N), "neither is the phone number");
});

test("customer request: the stored row holds only a hash, the purpose and the destination - bound to the contact", async () => {
  reset();
  await customerRequest();
  const row = store.rows[0];
  assert.equal(row.userId, "k1");
  assert.equal(row.purpose, LOGIN_OTP_PURPOSE.CUSTOMER_LOGIN);
  assert.equal(row.destination, N);
  assert.equal(row.deliveryStatus, "sent");
  assert.notEqual(row.code, sentCode());
  assert.equal(row.code, hashLoginOtp(row.id, "k1", sentCode()));
  const life = row.expiresAt.getTime() - Date.now();
  assert.ok(life > 595_000 && life <= 600_000, `10-minute life (${life} ms left)`);
});

test("customer request: another number, another order, an inactive or number-less contact get the same reply and NO code and NO message", async () => {
  reset();
  const expected = (await customerRequest()).body;
  const cases: Array<[string, () => Promise<any>]> = [
    ["a number that is not a contact of the order", () => { reset(); return customerRequest("9000000009"); }],
    ["an unknown order", () => { reset(); stubModel("order", { findUnique: () => null }); return customerRequest(); }],
    ["an inactive contact", () => { reset(); contactK1 = contact({ isActive: false }); return customerRequest(); }],
  ];
  for (const [label, run] of cases) {
    const r = await run();
    assert.equal(r.status, 200, label);
    assert.deepEqual(r.body, expected, label);
    assert.equal(store.rows.length, 0, `${label}: no code`);
    assert.equal(whatsapp.calls.length, 0, `${label}: nothing sent`);
  }
  for (const stored of [null, "", "not a number", "12345"]) {
    reset();
    contactK1 = contact({ phone: stored });
    const r = await customerRequest();
    assert.equal(r.status, 200);
    assert.equal(store.rows.length, 0, `unmatched stored number ${JSON.stringify(stored)}`);
  }
});

test("customer request: delivery failure is a 503 that says so - never 'sent' - and leaves no usable code", async () => {
  for (const mode of ["http500", "throw"] as const) {
    reset();
    whatsapp.mode = mode;
    const r = await customerRequest();
    assert.equal(r.status, 503, mode);
    assert.equal(r.body.error, OTP_DELIVERY_FAILED_MESSAGE);
    assert.equal(r.body.code, "OTP_DELIVERY_FAILED");
    assert.equal(r.body.ok, undefined);
    assert.equal(store.activeFor("k1").length, 0, "the undelivered code is void");
    assert.equal(store.rows[0].deliveryStatus, "failed");
    assert.equal((await customerVerify("123456")).status, 401);
    assert.ok(!/sent/i.test(r.raw.replace(OTP_DELIVERY_FAILED_MESSAGE, "")), "no claim of success");
  }
  // And a failed attempt does not lock the user out of an immediate retry.
  reset();
  whatsapp.mode = "http500";
  assert.equal((await customerRequest()).status, 503);
  whatsapp.mode = "ok";
  assert.equal((await customerRequest()).status, 200, "no 30-second wait after a delivery that never happened");
});

// =============================================================================================
// Customer login: verify - correct, wrong, expired, reused, wrong purpose / number / user
// =============================================================================================

test("customer verify: the correct, unexpired code signs in once, as that contact, and is consumed", async () => {
  reset();
  await customerRequest();
  const code = sentCode();
  const ok = await customerVerify(code, `0${N}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.id, "k1");
  assert.equal(ok.body.user.role, "customer");
  assert.ok(store.rows[0].consumedAt, "the code is consumed");
  const again = await customerVerify(code);
  assert.equal(again.status, 401, "a used code is refused");
  assert.equal(again.body.token, undefined);
});

test("customer verify: wrong, expired, reused, wrong-number and unknown cases get the IDENTICAL 401 and no token", async () => {
  reset();
  await customerRequest();
  const code = sentCode();
  const bodies: any[] = [];
  const record = (r: any, label: string) => { assert.equal(r.status, 401, label); assert.equal(r.body.token, undefined, label); bodies.push(r.body); };

  record(await customerVerify(wrongCode(code)), "wrong code");
  record(await customerVerify(code, OTHER), "right code, another contact's number");
  record(await customerVerify(code, N, "NO-SUCH-ORDER"), "unknown order");
  record(await customerVerify("000000", "9000000009"), "unknown number");
  store.age(LOGIN_OTP.TTL_MS + 1000);
  record(await customerVerify(code), "right code after expiry");
  assert.ok(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0])), "one answer for every failure");
  assert.equal(bodies[0].error, OTP_BAD_CODE_MESSAGE);
});

test("customer verify: a code is accepted only up to its expiry, judged by the server", async () => {
  reset();
  await customerRequest();
  const code = sentCode();
  store.age(LOGIN_OTP.TTL_MS - 5_000);
  assert.equal((await customerVerify(code)).status, 200, "still valid 5 seconds before expiry");
  reset();
  await customerRequest();
  const late = sentCode();
  store.age(LOGIN_OTP.TTL_MS + 1);
  assert.equal((await customerVerify(late)).status, 401, "refused one millisecond after");
  assert.equal(store.rows[0].consumedAt, null, "and an expired code is not 'consumed' into a session");
});

test("customer verify: a code issued for another PURPOSE, user or destination is never accepted", async () => {
  reset();
  // The same person also has a phone-only login code: it must not open the customer login, nor the reverse.
  await phoneRequest(N);
  const phoneCode = sentCode();
  assert.equal((await customerVerify(phoneCode)).status, 401, "phone-login code on the customer login");
  await customerRequest();
  const customerCode = sentCode();
  assert.equal((await post("/auth/otp/verify", { phone: N, code: customerCode })).status, 401, "customer-login code on the phone login");
  // Another contact's code cannot be used with this contact's number.
  reset();
  await customerRequest(OTHER);
  const k2Code = sentCode();
  assert.equal((await customerVerify(k2Code, N)).status, 401, "k2's code, k1's number");
  assert.equal((await customerVerify(k2Code, OTHER)).status, 200, "k2's code, k2's number");
  // A row whose destination differs from the number presented (e.g. the number was edited) is refused.
  reset();
  await customerRequest();
  store.rows[0].destination = "9000000009";
  assert.equal((await customerVerify(sentCode())).status, 401, "delivered to a different number than the one being verified");
});

test("customer verify: a deactivated contact gets no session even with a valid code, and the code is not consumed", async () => {
  reset();
  await customerRequest();
  contactK1.isActive = false;
  const r = await customerVerify(sentCode());
  assert.equal(r.status, 401);
  assert.equal(r.body.token, undefined);
  assert.equal(store.rows[0].consumedAt, null);
});

// =============================================================================================
// Resend: replaces the previous code, cooldown, hourly cap, independence between users, concurrency
// =============================================================================================

test("resend: the old code stops working, the newest works before expiry, and each is single use", async () => {
  reset();
  await customerRequest();
  const first = sentCode();
  waitOutCooldown();
  assert.equal((await customerRequest()).status, 200);
  const second = sentCode();
  assert.equal(store.activeFor("k1").length, 1, "exactly one live code");
  assert.equal(whatsapp.calls.length, 2);
  assert.equal((await customerVerify(first)).status, 401, "the replaced code is refused");
  const ok = await customerVerify(second);
  assert.equal(ok.status, 200, "the newest code works");
  assert.equal((await customerVerify(second)).status, 401, "and only once");
});

test("resend: blocked during the 30-second cooldown - answered like any other request (no account oracle) - and the blocked request replaces nothing", async () => {
  reset();
  const accepted = await customerRequest();
  const first = sentCode();
  const blocked = await customerRequest();
  // A cooldown exists only for a real account, so a distinct 429 would reveal which numbers are registered: the answer is identical to the first one.
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.body, accepted.body);
  assert.equal(blocked.retryAfter, null, "no Retry-After header either");
  assert.equal(whatsapp.calls.length, 1, "nothing was sent");
  assert.equal(store.rows.length, 1, "nothing was created");
  assert.equal((await customerVerify(first)).status, 200, "the first code is still valid");
});

test("resend: at most 5 requests per hour per user; the sixth is refused until the hour has passed", async () => {
  reset();
  for (let i = 0; i < LOGIN_OTP_POLICY.MAX_REQUESTS_PER_HOUR; i++) {
    assert.equal((await customerRequest()).status, 200, `request ${i + 1}`);
    waitOutCooldown();
  }
  const limited = await customerRequest();
  assert.equal(limited.status, 200, "same answer as an accepted request (no account oracle)");
  assert.equal(limited.retryAfter, null);
  assert.equal(whatsapp.calls.length, 5, "but no sixth message was sent");
  assert.equal(store.rows.length, 5, "and no sixth code was created");
  store.age(3_600_000);
  assert.equal((await customerRequest()).status, 200, "allowed again after the hour");
});

test("resend: failed deliveries still count towards the hourly cap (a provider is not hammered)", async () => {
  reset();
  whatsapp.mode = "http500";
  for (let i = 0; i < LOGIN_OTP_POLICY.MAX_REQUESTS_PER_HOUR; i++) assert.equal((await customerRequest()).status, 503);
  whatsapp.mode = "ok";
  const before = whatsapp.calls.length;
  assert.equal((await customerRequest()).status, 200, "the cap holds (answered like any request)");
  assert.equal(whatsapp.calls.length, before, "but nothing more is sent");
});

test("different users have independent codes, cooldowns and limits", async () => {
  reset();
  await customerRequest(N);
  const k1Code = sentCode();
  const k2 = await customerRequest(OTHER);
  assert.equal(k2.status, 200, "k2 is not held back by k1's cooldown");
  const k2Code = sentCode();
  assert.equal(store.activeFor("k1").length, 1);
  assert.equal(store.activeFor("k2").length, 1);
  assert.equal((await customerVerify(k1Code, N)).status, 200, "k2's request did not void k1's code");
  assert.equal((await customerVerify(k2Code, OTHER)).status, 200);
  // Same person, other purpose: a phone-login request leaves a customer-login code alone.
  reset();
  await customerRequest(N);
  const custCode = sentCode();
  await phoneRequest(N);
  assert.equal((await customerVerify(custCode)).status, 200, "an unrelated purpose is not invalidated");
});

test("simultaneous resend requests leave at most ONE usable code", async () => {
  reset();
  const results = await Promise.all(Array.from({ length: 6 }, () => customerRequest()));
  assert.ok(results.every((r) => r.status === 200 && r.body.ok), "every request got the same answer");
  assert.equal(store.rows.length, 1, "the check-and-insert runs under a lock: only ONE code was created, not one per request");
  assert.equal(store.activeFor("k1").length, 1, "one live code");
  assert.equal(whatsapp.calls.length, 1, "one message");
  const sent = whatsapp.calls.map((c) => c.code);
  let accepted = 0;
  for (const c of sent) if ((await customerVerify(c)).status === 200) accepted++;
  assert.equal(accepted, 1, "exactly one of the codes that were sent can sign in");
});

test("simultaneous verification of one correct code produces exactly one session", async () => {
  reset();
  await customerRequest();
  const code = sentCode();
  const results = await Promise.all(Array.from({ length: 6 }, () => customerVerify(code)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 401).length, 5);
  assert.equal(results.filter((r) => r.body.token).length, 1);
});

// =============================================================================================
// Wrong guesses: counted in the database, not resettable by asking for another code
// =============================================================================================

test("5 wrong guesses lock a code - even the right code is then refused - and the count lives in the stored row", async () => {
  reset();
  await customerRequest();
  const code = sentCode();
  for (let i = 0; i < LOGIN_OTP_POLICY.MAX_ATTEMPTS_PER_CODE; i++) assert.equal((await customerVerify(wrongCode(code))).status, 401);
  assert.equal(store.rows[0].attempts, 5, "persisted on the row, so every server instance sees it");
  const late = await customerVerify(code);
  assert.equal(late.status, 401);
  assert.equal(late.body.token, undefined);
});

test("requesting a new code does NOT reset the guess budget: 10 guesses per hour across all codes", async () => {
  reset();
  await customerRequest();
  const a = sentCode();
  for (let i = 0; i < 5; i++) await customerVerify(wrongCode(a));
  waitOutCooldown();
  await customerRequest();
  const b = sentCode();
  assert.equal(store.rows.find((r) => !r.consumedAt)!.attempts, 0, "the new code starts at zero ...");
  for (let i = 0; i < 5; i++) await customerVerify(wrongCode(b));
  waitOutCooldown();
  await customerRequest();
  const c = sentCode();
  const r = await customerVerify(c);
  assert.equal(r.status, 401, "... but the hour's budget is already spent, so even a fresh correct code is refused");
  assert.equal(r.body.token, undefined);
  store.age(3_600_000);
  assert.equal((await customerVerify(c)).status, 401, "(that code has also expired by then)");
  await customerRequest();
  assert.equal((await customerVerify(sentCode())).status, 200, "a new code after the hour works");
});

test("a right code (even presented twice at once) does not use up the wrong-guess budget", async () => {
  reset();
  for (let i = 0; i < 4; i++) {
    if (i) waitOutCooldown();
    await customerRequest();
    const code = sentCode();
    const both = await Promise.all([customerVerify(code), customerVerify(code)]);
    assert.equal(both.filter((r) => r.status === 200).length, 1);
  }
  assert.equal(store.rows.reduce((n, r) => n + r.attempts, 0), 0, "only wrong guesses are counted");
  waitOutCooldown();
  await customerRequest();
  assert.equal((await customerVerify(sentCode())).status, 200, "still able to sign in");
});

test("the guess limits are not process memory: a brand-new module state (another instance) sees the same limits", async () => {
  reset();
  await customerRequest();
  const code = sentCode();
  for (let i = 0; i < 5; i++) await customerVerify(wrongCode(code));
  // Another server instance has none of this process's variables - it only has the table.
  const src = stripComments(fs.readFileSync(path.join(__dirname, "..", "src", "lib", "loginOtp.ts"), "utf8"));
  assert.doesNotMatch(src, /new Map\(|setInterval|const failures/, "no in-memory counter remains in the login OTP code");
  const rowsSeenByAnotherInstance = store.rows.map((r) => ({ ...r }));
  assert.equal(rowsSeenByAnotherInstance[0].attempts, 5);
});

test("the per-IP request limit still applies on top", async () => {
  reset();
  const ip = "203.0.113.9";
  let status = 0;
  for (let i = 0; i < 12; i++) status = (await post("/auth/customer/verify", { orderNumber: ORDER, phone: N, code: "123456" }, ip)).status;
  assert.equal(status, 429);
});

// =============================================================================================
// Phone-only login (mobile app)
// =============================================================================================

test("phone-only request: the code goes by WhatsApp to the account's stored number, with the phone-login purpose", async () => {
  reset();
  staffS1 = staff({ phone: `+91${N}` });
  contactK1 = contact({ id: "zz", phone: "9000000001" }); // keep the customer contact out of the lookup
  const r = await phoneRequest(`0${N}`);
  assert.equal(r.status, 200);
  assert.equal(whatsapp.calls.length, 1);
  assert.equal(whatsapp.calls[0].to, `91${N}`);
  assert.equal(store.rows[0].userId, "s1");
  assert.equal(store.rows[0].purpose, LOGIN_OTP_PURPOSE.PHONE_LOGIN);
  assert.equal(r.body.expiresInSeconds, 600);
  assert.equal(r.body.resendAfterSeconds, 30);
  assert.ok(!r.raw.includes(sentCode()));
});

test("phone-only request: unknown and deactivated accounts get the SAME answer as a real one; only the active one gets a code", async () => {
  reset();
  contactK1 = contact({ id: "zz", phone: "9000000001" });
  const real = await phoneRequest(N);
  const sentBefore = whatsapp.calls.length;
  reset();
  const unknown = await phoneRequest("9000000009");
  reset();
  contactK1 = contact({ id: "zz", phone: "9000000001" });
  staffS1 = staff({ isActive: false });
  const inactive = await phoneRequest(N);
  assert.deepEqual(unknown.body, real.body);
  assert.deepEqual(inactive.body, real.body);
  assert.equal(sentBefore, 1);
  assert.equal(whatsapp.calls.length, 0);
  assert.equal(store.rows.length, 0);
});

test("phone-only request: a failed delivery is reported as a failure and leaves no usable code", async () => {
  reset();
  contactK1 = contact({ id: "zz", phone: "9000000001" });
  whatsapp.mode = "http500";
  const r = await phoneRequest();
  assert.equal(r.status, 503);
  assert.equal(r.body.error, OTP_DELIVERY_FAILED_MESSAGE);
  assert.equal(store.activeFor("s1").length, 0);
  assert.ok(!everythingLogged().includes(N));
});

test("phone-only verify: an active account signs in once for its own role; replay, wrong, expired and other-number codes fail", async () => {
  reset();
  contactK1 = contact({ id: "zz", phone: "9000000001" });
  await phoneRequest();
  const code = sentCode();
  assert.equal((await phoneVerify(wrongCode(code))).status, 401);
  assert.equal((await phoneVerify(code, OTHER)).status, 401, "another number");
  const ok = await phoneVerify(code, `+91${N}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, "service_engineer");
  assert.equal((await phoneVerify(code)).status, 401, "replay");
  waitOutCooldown();
  await phoneRequest();
  const late = sentCode();
  store.age(LOGIN_OTP.TTL_MS + 1000);
  const expired = await phoneVerify(late);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.token, undefined);
});

test("phone-only verify: a DEACTIVATED account gets no session even with a valid code, and the code is not consumed", async () => {
  reset();
  contactK1 = contact({ id: "zz", phone: "9000000001" });
  await phoneRequest();
  staffS1.isActive = false;
  const r = await phoneVerify(sentCode());
  assert.equal(r.status, 401);
  assert.equal(r.body.token, undefined);
  assert.equal(store.rows[0].consumedAt, null);
});

test("phone-only: resend replaces the old code, the cooldown applies, and the guess budget is shared", async () => {
  reset();
  contactK1 = contact({ id: "zz", phone: "9000000001" });
  await phoneRequest();
  const first = sentCode();
  assert.equal((await phoneRequest()).status, 200, "answered like any request");
  assert.equal(whatsapp.calls.length, 1, "but no second code during the cooldown");
  waitOutCooldown();
  assert.equal((await phoneRequest()).status, 200);
  assert.equal((await phoneVerify(first)).status, 401, "old code refused");
  const second = sentCode();
  for (let i = 0; i < 5; i++) await phoneVerify(wrongCode(second));
  assert.equal((await phoneVerify(second)).status, 401, "locked after 5 wrong guesses");
});

// =============================================================================================
// Requirement 3: who may use the phone-only login, and how OTP sessions meet the token-version boundary
// =============================================================================================

const roleWith = (key: string, perms: string[] = []) => ({ key, permissions: perms.map((p) => ({ permission: { key: p } })) });
const get = async (p: string, token: string) => {
  const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `10.7.${Math.floor(++hit / 250)}.${hit % 250}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const awayFromCustomerContact = () => { contactK1 = contact({ id: "zz", phone: "9000000001" }); };

test("policy helper: the three administrative roles and any role holding an administrative permission are denied; ordinary roles pass; an unknown role never does", () => {
  const { isPhoneOtpLoginAllowed } = require("@recd/shared") as typeof import("@recd/shared");
  for (const key of ["super_admin", "owner_admin", "management"]) assert.equal(isPhoneOtpLoginAllowed({ role: roleWith(key) }), false, key);
  for (const perm of ["manage_users", "manage_settings", "manage_regions", "manage_warranty"]) {
    assert.equal(isPhoneOtpLoginAllowed({ role: roleWith("custom_role", ["view_site_status", perm]) }), false, perm);
  }
  for (const key of ["customer", "vendor", "service_engineer", "sales", "finance", "erection_engineer", "service_team"]) {
    assert.equal(isPhoneOtpLoginAllowed({ role: roleWith(key, ["view_site_status", "raise_complaint"]) }), true, key);
  }
  assert.equal(isPhoneOtpLoginAllowed({ role: roleWith("service_engineer") }), true, "no permission list loaded = nothing administrative to find");
  assert.equal(isPhoneOtpLoginAllowed({}), false);
  assert.equal(isPhoneOtpLoginAllowed(null), false);
  assert.equal(isPhoneOtpLoginAllowed({ role: { key: "" } }), false);
});

for (const [label, role] of [
  ["Super Admin", roleWith("super_admin")],
  ["Owner / Admin", roleWith("owner_admin")],
  ["Management", roleWith("management")],
  ["a custom role holding manage_users", roleWith("ops_lead", ["manage_users"])],
  ["a custom role holding manage_settings", roleWith("ops_lead", ["manage_settings"])],
] as const) {
  test(`phone-only login is refused for ${label}: same answer as an unknown number, NO code created or sent`, async () => {
    reset();
    awayFromCustomerContact();
    const unknown = await phoneRequest("9000000009");
    staffS1 = staff({ role });
    const r = await phoneRequest();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, unknown.body, "indistinguishable from an unknown number - account existence is not revealed");
    assert.equal(whatsapp.calls.length, 0, "nothing sent");
    assert.equal(store.rows.length, 0, "no code stored");
  });

  test(`phone-only verify is refused for ${label} even with a code that existed before the role was changed`, async () => {
    reset();
    awayFromCustomerContact();
    await phoneRequest(); // staff s1 is a service engineer at this point: a real code exists
    const code = sentCode();
    staffS1.role = role; // the role is changed after the code was issued
    const r = await phoneVerify(code);
    assert.equal(r.status, 401);
    assert.equal(r.body.token, undefined);
    assert.equal(store.rows[0].consumedAt, null, "the code was not even consumed");
    assert.equal(r.body.error, OTP_BAD_CODE_MESSAGE);
  });
}

test("phone-only login still works for non-privileged staff and for customer / vendor accounts", async () => {
  for (const key of ["service_engineer", "sales", "customer", "vendor"]) {
    reset();
    awayFromCustomerContact();
    staffS1 = staff({ role: roleWith(key, ["view_site_status"]) });
    assert.equal((await phoneRequest()).status, 200, key);
    assert.equal(whatsapp.calls.length, 1, `${key}: a code is sent`);
    const ok = await phoneVerify(sentCode());
    assert.equal(ok.status, 200, key);
    assert.equal(ok.body.user.role, key);
  }
});

test("the customer login (order number + phone) is unaffected by the phone-only role policy", async () => {
  reset();
  const request = await customerRequest();
  assert.equal(request.status, 200);
  const ok = await customerVerify(sentCode());
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test("inactive accounts remain refused (no code, no session)", async () => {
  reset();
  awayFromCustomerContact();
  staffS1 = staff({ isActive: false });
  await phoneRequest();
  assert.equal(whatsapp.calls.length, 0);
  const v = await phoneVerify("123456");
  assert.equal(v.status, 401);
  assert.equal(v.body.token, undefined);
});

test("a failed delivery cannot produce a session: the code is voided and verifying it fails", async () => {
  reset();
  awayFromCustomerContact();
  whatsapp.mode = "http500";
  const r = await phoneRequest();
  assert.equal(r.status, 503);
  const attempted = whatsapp.calls[whatsapp.calls.length - 1]?.code ?? "000000";
  const v = await phoneVerify(attempted);
  assert.equal(v.status, 401);
  assert.equal(v.body.token, undefined);
});

test("an OTP-issued token carries the account's CURRENT token version and works on a protected route", async () => {
  reset();
  awayFromCustomerContact();
  staffS1 = staff({ tokenVersion: 7, mustChangePassword: false, role: roleWith("service_engineer", ["view_site_status"]) });
  stubModel("user", { ...db.user, findUnique: ({ where }: any) => (where.id === "s1" ? staffS1 : null) });
  await phoneRequest();
  const ok = await phoneVerify(sentCode());
  assert.equal(ok.status, 200);
  const { verifyToken } = await import("../src/lib/jwt");
  assert.equal(verifyToken(ok.body.token).tv, 7);
  assert.equal((await get("/protected", ok.body.token)).status, 200);
});

test("an OTP-issued token stops working after a password reset, a role change, a deactivation, and a reactivation does not bring it back", async () => {
  reset();
  awayFromCustomerContact();
  staffS1 = staff({ tokenVersion: 2, mustChangePassword: false, role: roleWith("service_engineer", ["view_site_status"]) });
  stubModel("user", { ...db.user, findUnique: ({ where }: any) => (where.id === "s1" ? staffS1 : null) });
  await phoneRequest();
  const { token } = (await phoneVerify(sentCode())).body;
  assert.equal((await get("/protected", token)).status, 200);

  staffS1.tokenVersion += 1; // password reset / role change / link change all bump the version
  assert.equal((await get("/protected", token)).status, 401, "after a version bump (password reset or role change)");

  staffS1.tokenVersion -= 1; // pretend the bump had not happened, then take the account out of service
  assert.equal((await get("/protected", token)).status, 200);
  staffS1.isActive = false;
  assert.equal((await get("/protected", token)).status, 401, "deactivated");
  staffS1.isActive = true;
  staffS1.tokenVersion += 1; // the user administration bumps the version on deactivation AND on reactivation
  assert.equal((await get("/protected", token)).status, 401, "reactivation does not restore the old token");
});

test("an OTP session for an account that must change its password cannot reach ordinary routes", async () => {
  reset();
  awayFromCustomerContact();
  staffS1 = staff({ tokenVersion: 1, mustChangePassword: true, role: roleWith("service_engineer", ["view_site_status"]) });
  stubModel("user", { ...db.user, findUnique: ({ where }: any) => (where.id === "s1" ? staffS1 : null) });
  await phoneRequest();
  const login = await phoneVerify(sentCode());
  assert.equal(login.status, 200, "the person can sign in ...");
  const blocked = await get("/protected", login.body.token);
  assert.equal(blocked.status, 403, "... but the session is limited to completing the password change");
  assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
});

test("customer login accepts the serial number of any RECD unit of the order as well as the order number (the field is labelled RECD Serial Number); an unknown serial gets the generic reply", async () => {
  reset();
  const generic = await customerRequest(N, ORDER + "-nope");
  const unknownSerial = await customerRequest(N, "SN-9999");
  assert.deepEqual([unknownSerial.status, unknownSerial.body], [generic.status, generic.body], "an unknown serial is indistinguishable from an unknown order");
  const bySerial = await customerRequest(N, "sn-0001"); // typed in lower case: serials are stored upper-case
  assert.equal(bySerial.status, 200);
  // the code really was created for the order's contact: asking again by ORDER NUMBER is held back by the 30 s resend cooldown
  const sentBefore = whatsapp.calls.length;
  await customerRequest(N, ORDER);
  assert.equal(whatsapp.calls.length, sentBefore, "the serial reached the same account as the order number (the order-number request was held back by the cooldown)");
});
