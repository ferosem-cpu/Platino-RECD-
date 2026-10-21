// The public (login-free) complaint OTP flow, end to end through the real router: request -> verify -> raise a
// ticket. Prisma's PublicOtp table is replaced by an in-memory model and the WhatsApp Cloud API call is intercepted
// before it leaves the process - nothing is sent. Real-database behaviour of the atomic claims is not proven here.
// The business rules are unchanged: 5-minute code, 5 guesses, 30 s resend, database-backed request limits,
// a single-use 15-minute session token. All numbers and codes are synthetic.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { ISSUE_CATEGORY, PUBLIC_OTP } from "@recd/shared";
import { matchesCondition } from "./helpers/fakeOtpStore";
import { createFakeRateLimitStore } from "./helpers/fakeRateLimitStore";

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

const PHONE = "9876543210";
const OTHER = "9123456780";
const SERIAL = "SER-001";
const UNIT = { id: "u1", serialNo: SERIAL, status: "active", siteId: "s1", order: { customerId: "c1" }, site: { id: "s1", regionId: null } };

// ---- an in-memory PublicOtp table ----------------------------------------------------------------
let rows: any[] = [];
let seq = 0;
const tick = () => new Promise<void>((r) => setImmediate(r));
const match = (r: any, where: any = {}) => Object.entries(where).every(([k, c]) => matchesCondition(r[k], c));
const publicOtpTable: Stub = {
  async count({ where }: any) { await tick(); return rows.filter((r) => match(r, where)).length; },
  async findFirst({ where, orderBy }: any) {
    await tick();
    const list = rows.filter((r) => match(r, where));
    if (orderBy?.createdAt === "desc") list.sort((a, b) => b.createdAt - a.createdAt);
    return list[0] ? { ...list[0] } : null;
  },
  async findUnique({ where }: any) { await tick(); const r = rows.find((x) => x.sessionHash && x.sessionHash === where.sessionHash); return r ? { ...r } : null; },
  async create({ data }: any) {
    await tick();
    const r = { attempts: 0, verifiedAt: null, sessionHash: null, sessionExpiresAt: null, sessionUsedAt: null, createdAt: new Date(Date.now() + ++seq), ...data };
    rows.push(r);
    return { ...r };
  },
  async update({ where, data }: any) { await tick(); const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
  async updateMany({ where, data }: any) {
    await tick();
    const hit = rows.filter((r) => match(r, where));
    for (const r of hit) for (const [k, v] of Object.entries<any>(data)) r[k] = v && typeof v === "object" && "increment" in v ? r[k] + v.increment : v;
    return { count: hit.length };
  },
};
const ageRows = (ms: number) => rows.forEach((r) => {
  r.createdAt = new Date(r.createdAt.getTime() - ms);
  r.expiresAt = new Date(r.expiresAt.getTime() - ms);
  if (r.sessionExpiresAt) r.sessionExpiresAt = new Date(r.sessionExpiresAt.getTime() - ms);
});

// ---- WhatsApp intercepted ------------------------------------------------------------------------
const whatsapp = { calls: [] as Array<{ to: string; code: string }>, mode: "ok" as "ok" | "http500" };
const realFetch = globalThis.fetch;
const sentCode = () => whatsapp.calls[whatsapp.calls.length - 1]?.code ?? "";

const consoleLines: string[] = [];
const realConsole = { log: console.log, error: console.error };
const PROVIDER_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "OTP_DEV_ECHO", "PUBLIC_OTP_DEV_ECHO", "VERCEL", "VERCEL_ENV"];

let server: Server;
let base = "";
let hit = 0;

before(async () => {
  console.log = (...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.includes("graph.facebook.com")) return realFetch(input, init);
    const body = JSON.parse(init.body);
    whatsapp.calls.push({ to: body.to, code: body.template.components[0].parameters[0].text });
    return whatsapp.mode === "http500" ? new Response("provider error", { status: 500 }) : new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { prisma } = await import("../src/lib/prisma");
  createFakeRateLimitStore().install(prisma); // the IP limiter keeps its counters in the database; here they live in memory
  const { publicComplaintsRouter } = await import("../src/routes/publicComplaints");
  for (const model of ["publicOtp", "recdUnit", "complaint", "complaintEvent", "user"]) {
    Object.defineProperty(prisma, model, { configurable: true, get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }) });
  }
  // The ticket and its CREATED history row are written in one transaction (R11): run it against the same in-memory stubs.
  (prisma as any).$transaction = async (fn: any) => fn(prisma);
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/pc", publicComplaintsRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
  for (const k of PROVIDER_ENV) delete process.env[k];
});

function reset(mode: "whatsapp" | "none" = "whatsapp") {
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of PROVIDER_ENV) delete process.env[k];
  process.env.NODE_ENV = "development";
  if (mode === "whatsapp") { process.env.WHATSAPP_ACCESS_TOKEN = "not-a-real-token"; process.env.WHATSAPP_PHONE_NUMBER_ID = "000"; }
  whatsapp.calls.length = 0;
  whatsapp.mode = "ok";
  consoleLines.length = 0;
  rows = [];
  stubModel("publicOtp", publicOtpTable);
  stubModel("recdUnit", { findUnique: ({ where }: any) => (where.serialNo === SERIAL || where.id === "u1" ? { ...UNIT, product: { name: "RECD", model: "X1" } } : null) });
  stubModel("complaint", { findFirst: () => null, create: ({ data }: any) => ({ id: "t1", status: "open", ...data }) });
  stubModel("complaintEvent", { create: () => ({}) });
  stubModel("user", { findMany: () => [], findUnique: () => null });
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}/pc${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.5.${Math.floor(++hit / 250)}.${hit % 250}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text };
}
const requestOtp = (serialNo = SERIAL, phone = PHONE) => post("/otp/request", { serialNo, phone });
const verifyOtp = (code: string, serialNo = SERIAL, phone = PHONE) => post("/otp/verify", { serialNo, phone, code });
const ticketBody = (sessionToken: string) => ({
  sessionToken, reporterName: "Mani", reporterType: "reseller", issueCategory: Object.values(ISSUE_CATEGORY)[0], description: "The unit trips every morning.",
});
const submitTicket = (sessionToken: string) => post("/", ticketBody(sessionToken));
const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

test("policy unchanged: 5-minute code, 5 guesses, 30 s resend, 15-minute single-use session", () => {
  assert.equal(PUBLIC_OTP.EXPIRY_SECONDS, 300);
  assert.equal(PUBLIC_OTP.MAX_VERIFY_ATTEMPTS, 5);
  assert.equal(PUBLIC_OTP.RESEND_COOLDOWN_SECONDS, 30);
  assert.equal(PUBLIC_OTP.SESSION_SECONDS, 900);
});

test("request: a registered serial gets a WhatsApp code at the typed number; the response reveals nothing and holds no code", async () => {
  reset();
  const r = await requestOtp(SERIAL, `+91${PHONE}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["expiresInSeconds", "message", "ok", "resendAfterSeconds"]);
  assert.equal(r.body.expiresInSeconds, 300);
  assert.equal(whatsapp.calls.length, 1);
  assert.equal(whatsapp.calls[0].to, `91${PHONE}`);
  assert.ok(!r.raw.includes(sentCode()));
  assert.equal(rows[0].deliveryChannel, "whatsapp");
  assert.equal(rows[0].deliveryStatus, "sent");
  assert.notEqual(rows[0].codeHash, sentCode());
  assert.ok(!consoleLines.join("\n").includes(sentCode()), "no log line holds the code");
});

test("request: an unknown serial gets the identical answer, but nothing is sent", async () => {
  reset();
  const real = await requestOtp();
  const fake = await requestOtp("NO-SUCH-1", OTHER);
  assert.deepEqual(fake.body, real.body);
  assert.equal(whatsapp.calls.length, 1, "only the registered serial triggered a message");
  assert.equal(rows[1].unitId, null);
  assert.equal(rows[1].deliveryStatus, "skipped");
});

test("request: no provider (not configured, no local opt-in) is 'not available' - the old development fallback is gone", async () => {
  reset("none");
  const r = await requestOtp();
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "OTP_UNAVAILABLE");
  assert.equal(rows.length, 0);
});

test("request: a failed WhatsApp send is recorded as failed internally; the public wording stays conditional", async () => {
  reset();
  whatsapp.mode = "http500";
  const r = await requestOtp();
  assert.equal(rows[0].deliveryStatus, "failed", "internal status is accurate");
  // Documented trade-off: the public answer is identical for every outcome so serials cannot be enumerated;
  // the wording is conditional ("If this serial number is registered ...") and the page offers "Resend code".
  assert.equal(r.status, 200);
  assert.match(r.body.message, /^If this serial number is registered/);
});

test("verify: the correct code gives a session token once; wrong, wrong number, wrong serial and replay are refused", async () => {
  reset();
  await requestOtp();
  const code = sentCode();
  for (const bad of [await verifyOtp(wrong(code)), await verifyOtp(code, SERIAL, OTHER), await verifyOtp(code, "NO-SUCH-1")]) {
    assert.equal(bad.status, 400);
    assert.equal(bad.body.sessionToken, undefined);
  }
  const ok = await verifyOtp(code);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.sessionToken.length >= 32);
  assert.equal(ok.body.expiresInSeconds, 900);
  assert.equal((await verifyOtp(code)).status, 400, "a consumed code cannot be used again");
  assert.notEqual(rows[0].sessionHash, ok.body.sessionToken, "only a hash of the token is stored");
});

test("verify: an expired code is refused (server clock), a code just before expiry is not", async () => {
  reset();
  await requestOtp();
  const code = sentCode();
  ageRows(290_000);
  assert.equal((await verifyOtp(code)).status, 200, "10 s before expiry");
  reset();
  await requestOtp();
  const late = sentCode();
  ageRows(301_000);
  const r = await verifyOtp(late);
  assert.equal(r.status, 400);
  assert.equal(r.body.sessionToken, undefined);
});

test("verify: 5 wrong guesses lock the code - even the right one is then refused", async () => {
  reset();
  await requestOtp();
  const code = sentCode();
  for (let i = 0; i < 5; i++) assert.equal((await verifyOtp(wrong(code))).status, 400);
  assert.equal(rows[0].attempts, 5);
  assert.equal((await verifyOtp(code)).status, 400);
});

test("resend: blocked for 30 s, then the NEW code works and the old one does not; hourly caps apply", async () => {
  reset();
  await requestOtp();
  const first = sentCode();
  const blocked = await requestOtp();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /wait \d+s/);
  assert.equal(whatsapp.calls.length, 1);
  ageRows(31_000);
  assert.equal((await requestOtp()).status, 200);
  const second = sentCode();
  assert.equal((await verifyOtp(first)).status, 400, "an older code does not work once a newer one exists");
  assert.equal((await verifyOtp(second)).status, 200);

  reset();
  for (let i = 0; i < 5; i++) { assert.equal((await requestOtp()).status, 200); ageRows(31_000); }
  const limited = await requestOtp();
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /Too many code requests/);
});

test("ticket: no, malformed, unverified, expired or already-used session tokens cannot create a ticket", async () => {
  reset();
  assert.equal((await submitTicket("x".repeat(40))).status, 401, "unknown token");
  assert.equal((await post("/", { ...ticketBody("short") })).status, 400, "malformed token");
  assert.equal((await post("/", { reporterName: "Mani" })).status, 400, "no token");
  await requestOtp();
  assert.equal((await submitTicket("y".repeat(64))).status, 401, "a code was requested but never verified");
  assert.equal(called("complaint.create").length, 0, "no ticket from an invalid verification");

  reset();
  await requestOtp();
  const token = (await verifyOtp(sentCode())).body.sessionToken;
  ageRows(901_000);
  assert.equal((await submitTicket(token)).status, 401, "expired session");
  assert.equal(called("complaint.create").length, 0);
});

test("ticket: a verified session raises exactly one ticket - the token cannot be reused", async () => {
  reset();
  await requestOtp();
  const token = (await verifyOtp(sentCode())).body.sessionToken;
  const first = await submitTicket(token);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(first.body.ticketNumber, /^TCK-/);
  assert.equal(called("complaint.create")[0][0].data.reporterPhone, PHONE, "the verified number is the reporter's number");
  const again = await submitTicket(token);
  assert.equal(again.status, 401);
  assert.equal(called("complaint.create").length, 1);
});

test("ticket: three simultaneous submissions of one session token raise one ticket", async () => {
  reset();
  await requestOtp();
  const token = (await verifyOtp(sentCode())).body.sessionToken;
  const results = await Promise.all([submitTicket(token), submitTicket(token), submitTicket(token)]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(called("complaint.create").length, 1);
});

// ---- Requirement 3: the verified session decides the unit; nothing the client sends can change it ------------------------
test("ticket: the unit, site and customer come from the VERIFIED session - ids supplied by the client are ignored", async () => {
  reset();
  await requestOtp();
  const token = (await verifyOtp(sentCode())).body.sessionToken;
  const r = await post("/", { ...ticketBody(token), unitId: "u-other", siteId: "s-other", customerId: "c-other", serialNo: "SER-OTHER", reporterPhone: OTHER, status: "closed" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const data = called("complaint.create")[0][0].data;
  assert.equal(data.unitId, "u1");
  assert.equal(data.siteId, "s1");
  assert.equal(data.customerId, "c1");
  assert.equal(data.reporterPhone, PHONE, "the verified number, not a number sent with the ticket");
  assert.equal(data.status, "open");
});

test("verify: a code requested for one serial cannot be redeemed for another serial or another phone", async () => {
  reset();
  await requestOtp();
  const code = sentCode();
  assert.equal((await verifyOtp(code, "SER-OTHER")).status, 400);
  assert.equal((await verifyOtp(code, SERIAL, OTHER)).status, 400);
  assert.equal(rows[0].verifiedAt, null);
  assert.ok((await verifyOtp(code)).body.sessionToken);
});

test("ticket: an already-open ticket for the unit is refused (409) BEFORE the session is claimed, so the reporter keeps a valid session", async () => {
  reset();
  await requestOtp();
  const token = (await verifyOtp(sentCode())).body.sessionToken;
  stubModel("complaint", { findFirst: () => ({ ticketNumber: "TCK-2026-00001" }), create: () => { throw new Error("must not be called"); } });
  const dup = await submitTicket(token);
  assert.equal(dup.status, 409);
  assert.equal(called("complaint.create").length, 0);
  assert.equal(rows[0].sessionUsedAt ?? null, null, "session not consumed by a refusal");
});

test("ticket: the reporter address recorded for limits is the Express req.ip (honouring only TRUST_PROXY), never a raw header read", () => {
  const src = require("fs").readFileSync(require("path").resolve(__dirname, "../src/routes/publicComplaints.ts"), "utf8").replace(/\/\/.*$/gm, "");
  assert.match(src, /const ip = req\.ip \|\| null/);
  assert.doesNotMatch(src, /x-forwarded-for|x-real-ip/i);
});

test("privacy: neither the verify nor the ticket responses expose customer, site or contact details", async () => {
  reset();
  await requestOtp();
  const verified = await verifyOtp(sentCode());
  assert.deepEqual(Object.keys(verified.body).sort(), ["expiresInSeconds", "recd", "sessionToken"]);
  const t = await submitTicket(verified.body.sessionToken);
  assert.equal(t.status, 201);
  assert.ok(!/c1|s1|customer|site/i.test(JSON.stringify(Object.keys(t.body))), JSON.stringify(Object.keys(t.body)));
});
