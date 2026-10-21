// Route-level tests for the mobile-number rules on customer contacts, vendors, site contacts
// and the customer / phone-only logins.
//
// No database: Prisma's model delegates are replaced by in-memory stubs and the real routers
// (authentication, permissions, validation, normalisation) run on a throwaway Express app.
// That proves the route logic only - database constraints, transactions and rollback are covered
// by the real-database suite (test/db/mobileNumbers.db.test.ts), not here.
// All phone numbers below are synthetic; nothing is sent anywhere (no SMTP, no WhatsApp).
process.env.JWT_SECRET = "test-secret";
// Deliberately unreachable: a delegate that was forgotten in the stubs fails fast instead of reaching a database.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;
for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "VERCEL", "VERCEL_ENV"]) delete process.env[k];
// The login-code routes only work with a delivery provider; these tests are about number handling, so they use the
// explicit local-development switch (the code is echoed, nothing is sent). Delivery itself is tested in loginOtp.test.ts.
process.env.OTP_DEV_ECHO = "1";
process.env.NODE_ENV = "development";

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { INDIAN_MOBILE_MESSAGE, PERMISSION_KEY, ROLE_KEY, mobileStorageVariants } from "@recd/shared";
import { hashLoginOtp } from "../src/lib/loginOtp";
import { createFakeOtpStore } from "./helpers/fakeOtpStore";
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
const p2002 = (modelName: string, ...target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName, target } });

// Synthetic numbers.
const N = "9876543210";
const OTHER = "9123456780";
const ACCEPTED = [N, `+91${N}`, `91${N}`, `0${N}`, "+91 98765 43210", "98765-43210", `  ${N}  `];
const BAD = ["", "   ", "98765", "987654321", "98765432101", "98765abcde", "5876543210", "+14155552671"];

const users: Record<string, { id: string; role: string; perms: string[] }> = {
  admin: { id: "admin", role: ROLE_KEY.MANAGEMENT, perms: [PERMISSION_KEY.MANAGE_ORDERS, PERMISSION_KEY.MANAGE_VENDORS, PERMISSION_KEY.CHANGE_SITE_STATUS, PERMISSION_KEY.VIEW_SITE_STATUS] },
  nobody: { id: "nobody", role: ROLE_KEY.SALES, perms: [PERMISSION_KEY.VIEW_SITE_STATUS] },
};

let server: Server;
let base = "";
let tokenFor: (u: string) => string;
let hit = 0;
let otpStore = createFakeOtpStore();
const realConsole = { log: console.log, error: console.error };

before(async () => {
  console.log = () => {}; // the routes log OTP details; keep them (and the synthetic numbers) out of test output
  console.error = () => {};
  const { prisma } = await import("../src/lib/prisma");
  createFakeRateLimitStore().install(prisma); // the IP limiter keeps its counters in the database; here they live in memory
  const { signToken } = await import("../src/lib/jwt");
  const { customersRouter } = await import("../src/routes/customers");
  const { vendorsRouter } = await import("../src/routes/vendors");
  const { sitesRouter } = await import("../src/routes/sites");
  const { authRouter } = await import("../src/routes/auth");
  for (const model of ["user", "customer", "role", "order", "vendor", "site", "siteContact", "otpCode", "notificationLog", "userAuditLog"]) {
    Object.defineProperty(prisma, model, {
      configurable: true,
      get: () => new Proxy({}, { get: (_t, fn: string) => (...a: any[]) => db[model]?.[fn]?.(...a) }),
    });
  }
  (prisma as any).$transaction = async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg));
  tokenFor = (u) => signToken({ userId: users[u].id, roleKey: users[u].role, customerId: null });

  const app = express();
  app.set("trust proxy", true); // lets each request carry its own X-Forwarded-For so the login rate limiter is not tripped by the test itself
  app.use(express.json());
  app.use("/customers", customersRouter);
  app.use("/vendors", vendorsRouter);
  app.use("/sites", sitesRouter);
  app.use("/auth", authRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  console.log = realConsole.log;
  console.error = realConsole.error;
});

function reset() {
  for (const k of Object.keys(calls)) delete calls[k];
  stubModel("user", {
    findUnique: ({ where }: any) => {
      if (where.id) {
        const u = Object.values(users).find((x) => x.id === where.id);
        if (!u) return null;
        return { id: u.id, isActive: true, customerId: null, vendorId: null, email: null, role: { key: u.role, permissions: u.perms.map((key) => ({ permission: { key } })) } };
      }
      return null; // by email: nobody has it
    },
    findFirst: () => null,
    findUniqueOrThrow: () => ({ role: { key: ROLE_KEY.CUSTOMER } }),
    create: ({ data }: any) => ({ id: "newuser", ...data }),
    update: ({ data }: any) => ({ id: "u", ...data }),
  });
  stubModel("role", { findUniqueOrThrow: () => ({ id: "role-x" }) });
  stubModel("notificationLog", { create: () => ({}) });
  stubModel("userAuditLog", { create: () => ({}), updateMany: () => ({ count: 0 }) });
  otpStore = createFakeOtpStore();
  stubModel("otpCode", otpStore.stub);
}

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(++hit / 250)}.${hit % 250}`, ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const mentionsMobileRule = (body: any) => JSON.stringify(body).includes(INDIAN_MOBILE_MESSAGE);

// =============================================================================================
// Customer contacts
// =============================================================================================

const newCustomer = (contactPhone: unknown) => ({ name: "Acme Ltd", contactName: "Asha", contactPhone });
function stubCustomerCreate(taken = false) {
  stubModel("user", { ...db.user, findFirst: () => (taken ? { id: "existing" } : null) });
  stubModel("customer", { create: ({ data }: any) => ({ id: "c1", name: data.name, contacts: [{ id: "k1", ...data.contacts.create }] }) });
}

test("POST /customers: every accepted spelling is stored as the same 10 digits", async () => {
  for (const input of ACCEPTED) {
    reset(); stubCustomerCreate();
    const r = await call("admin", "POST", "/customers", newCustomer(input));
    assert.equal(r.status, 201, JSON.stringify(input) + JSON.stringify(r.body));
    assert.equal(called("customer.create")[0][0].data.contacts.create.phone, N, `stored value for ${JSON.stringify(input)}`);
    assert.equal(r.body.contacts[0].phone, N);
  }
});

test("POST /customers: invalid, empty and missing numbers are rejected on the server and create nothing", async () => {
  for (const input of BAD) {
    reset(); stubCustomerCreate();
    const r = await call("admin", "POST", "/customers", newCustomer(input));
    assert.equal(r.status, 400, JSON.stringify(input));
    assert.ok(mentionsMobileRule(r.body), JSON.stringify(r.body));
    assert.equal(called("customer.create").length, 0, `no record for ${JSON.stringify(input)}`);
  }
  reset(); stubCustomerCreate();
  const missing = await call("admin", "POST", "/customers", { name: "Acme Ltd", contactName: "Asha" });
  assert.equal(missing.status, 400);
  assert.ok(mentionsMobileRule(missing.body));
  assert.equal(called("customer.create").length, 0);
});

test("POST /customers: keeps requiring the same permission", async () => {
  reset(); stubCustomerCreate();
  assert.equal((await call("nobody", "POST", "/customers", newCustomer(N))).status, 403);
  assert.equal((await call(null, "POST", "/customers", newCustomer(N))).status, 401);
  assert.equal(called("customer.create").length, 0);
});

test("POST /customers: a number already used - in ANY stored format - is refused clearly", async () => {
  reset(); stubCustomerCreate(true);
  const r = await call("admin", "POST", "/customers", newCustomer(`+91 ${N}`));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "A contact with that phone number already exists");
  assert.deepEqual(called("user.findFirst")[0][0].where.phone.in, mobileStorageVariants(N), "older +91 / 91 / 0 spellings are checked too");
  assert.equal(called("customer.create").length, 0);
});

test("POST /customers: losing a race on the unique number is the same clear message, other unique errors are not hidden", async () => {
  reset(); stubCustomerCreate();
  stubModel("customer", { create: () => { throw p2002("User", "phone"); } });
  const raced = await call("admin", "POST", "/customers", newCustomer(N));
  assert.equal(raced.status, 400);
  assert.equal(raced.body.error, "A contact with that phone number already exists");

  // the shape Prisma really produces for a contact created inside a customer (captured from Postgres)
  stubModel("customer", { create: () => { throw p2002("Customer", "phone"); } });
  const nested = await call("admin", "POST", "/customers", newCustomer(N));
  assert.equal(nested.status, 400);
  assert.equal(nested.body.error, "A contact with that phone number already exists");

  stubModel("customer", { create: () => { throw p2002("User", "email"); } });
  const emailClash = await call("admin", "POST", "/customers", newCustomer(N));
  assert.equal(emailClash.status, 409, "an email clash is a clear client error (it used to be an unexplained 500)");
  assert.match(emailClash.body.error, /email/i);
  assert.doesNotMatch(emailClash.body.error, /phone/i, "an email clash is not reported as a phone clash");
});

// ---- updates --------------------------------------------------------------------------------

const contactsOf = (...cs: Array<{ id: string; phone: string | null }>) => cs;
function stubCustomerUpdate(contacts: Array<{ id: string; phone: string | null }>, taken = false) {
  stubModel("user", { ...db.user, findFirst: () => (taken ? { id: "someone-else" } : null), update: ({ data, where }: any) => ({ id: where.id, ...data }) });
  stubModel("customer", {
    findUnique: () => ({ id: "c1", contacts }),
    update: ({ data }: any) => ({ id: "c1", ...data, contacts }),
  });
}

test("PUT /customers/:id: a valid number is normalised before it is stored", async () => {
  reset(); stubCustomerUpdate(contactsOf({ id: "k1", phone: OTHER }));
  const r = await call("admin", "PUT", "/customers/c1", { contactPhone: "+91 98765-43210" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(called("user.update")[0][0].data.phone, N);
});

test("PUT /customers/:id: an invalid number is rejected and nothing is changed (not even the other fields)", async () => {
  for (const input of BAD) {
    reset(); stubCustomerUpdate(contactsOf({ id: "k1", phone: OTHER }));
    const r = await call("admin", "PUT", "/customers/c1", { name: "Renamed", contactPhone: input });
    assert.equal(r.status, 400, JSON.stringify(input));
    assert.ok(mentionsMobileRule(r.body));
    assert.equal(called("user.update").length, 0);
    assert.equal(called("customer.update").length, 0, "the rename was not applied either");
  }
});

test("PUT /customers/:id: edits the PRIMARY (oldest) contact by default - ordering is requested from the database", async () => {
  reset(); stubCustomerUpdate(contactsOf({ id: "oldest", phone: OTHER }, { id: "newer", phone: "9000000001" }));
  const r = await call("admin", "PUT", "/customers/c1", { contactName: "New name" });
  assert.equal(r.status, 200);
  assert.deepEqual(called("customer.findUnique")[0][0].include.contacts.orderBy, { createdAt: "asc" });
  assert.equal(called("user.update")[0][0].where.id, "oldest");
});

test("PUT /customers/:id: contactId edits exactly that contact; a contact of another customer is refused", async () => {
  reset(); stubCustomerUpdate(contactsOf({ id: "oldest", phone: OTHER }, { id: "second", phone: "9000000001" }));
  const ok = await call("admin", "PUT", "/customers/c1", { contactId: "second", contactPhone: N });
  assert.equal(ok.status, 200);
  assert.equal(called("user.update")[0][0].where.id, "second");
  assert.equal(called("user.update").length, 1);

  reset(); stubCustomerUpdate(contactsOf({ id: "oldest", phone: OTHER }));
  const foreign = await call("admin", "PUT", "/customers/c1", { contactId: "belongs-to-another-customer", contactPhone: N });
  assert.equal(foreign.status, 404);
  assert.equal(called("user.update").length, 0);
});

test("PUT /customers/:id: the same number in an older format is not a duplicate; a number held by someone else is", async () => {
  reset(); stubCustomerUpdate(contactsOf({ id: "k1", phone: `+91${N}` }), true);
  const same = await call("admin", "PUT", "/customers/c1", { contactPhone: N });
  assert.equal(same.status, 200, "re-saving the same number must not clash with itself");
  assert.equal(called("user.findFirst").length, 0);
  assert.equal(called("user.update")[0][0].data.phone, N, "and the old format is tidied to 10 digits");

  reset(); stubCustomerUpdate(contactsOf({ id: "k1", phone: OTHER }), true);
  const taken = await call("admin", "PUT", "/customers/c1", { contactPhone: N });
  assert.equal(taken.status, 400);
  assert.equal(taken.body.error, "A contact with that phone number already exists");
  assert.equal(called("user.findFirst")[0][0].where.id.not, "k1", "the contact being edited is excluded from the check");
  assert.equal(called("user.update").length, 0);
});

test("PUT /customers/:id: contact fields for a customer with no contact are refused, not silently dropped", async () => {
  reset(); stubCustomerUpdate([]);
  const r = await call("admin", "PUT", "/customers/c1", { contactPhone: N });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no contact/);
  reset(); stubCustomerUpdate([]);
  assert.equal((await call("admin", "PUT", "/customers/c1", { name: "Only the name" })).status, 200, "renaming still works");
});

// =============================================================================================
// Customer / phone-only login: any accepted spelling finds the same stored number
// =============================================================================================

const contact = (phone: string | null, extra: Record<string, unknown> = {}) => ({ id: "k1", name: "Asha", phone, email: null, isActive: true, customerId: "cA", ...extra });
function stubLoginOrder(contacts: any[]) {
  stubModel("order", { findUnique: () => ({ id: "o1", orderNumber: "ORD-T1", customer: { id: "cA", contacts } }) });
}

test("customer login: every accepted spelling matches a number stored normalised OR in an older format", async () => {
  for (const stored of [N, `+91${N}`, `91${N}`, `0${N}`, `+91 98765 43210`]) {
    for (const typed of ACCEPTED) {
      reset(); stubLoginOrder([contact(stored)]);
      const r = await call(null, "POST", "/auth/customer/register", { orderNumber: "ORD-T1", phone: typed });
      assert.equal(r.status, 200, `stored ${JSON.stringify(stored)} typed ${JSON.stringify(typed)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.devCode, /^\d{6}$/, "development mode shows the code");
      assert.equal(called("otpCode.create")[0][0].data.userId, "k1", "the OTP belongs to the matched contact");
    }
  }
});

test("customer login: invalid numbers are refused up front; a valid number that matches nobody gets the SAME answer as a real request and no code", async () => {
  for (const typed of BAD) {
    reset(); stubLoginOrder([contact(N)]);
    const r = await call(null, "POST", "/auth/customer/register", { orderNumber: "ORD-T1", phone: typed });
    assert.equal(r.status, 400, JSON.stringify(typed));
    assert.ok(mentionsMobileRule(r.body));
    assert.equal(called("otpCode.create").length, 0);
  }
  reset(); stubLoginOrder([contact(N)]);
  assert.equal((await call(null, "POST", "/auth/customer/register", { orderNumber: "ORD-T1" })).status, 400, "field missing");
  const wrong = await call(null, "POST", "/auth/customer/register", { orderNumber: "ORD-T1", phone: OTHER });
  assert.equal(wrong.status, 200, "no account signal");
  assert.equal(wrong.body.devCode, undefined);
  assert.equal(called("otpCode.create").length, 0, "and no code is created");
});

test("customer login: a contact stored with no or unreadable number can never be matched", async () => {
  for (const stored of [null, "", "not a number", "12345"]) {
    reset(); stubLoginOrder([contact(stored)]);
    const r = await call(null, "POST", "/auth/customer/register", { orderNumber: "ORD-T1", phone: N });
    assert.equal(r.status, 200, String(stored));
    assert.equal(called("otpCode.create").length, 0, `no code for ${JSON.stringify(stored)}`);
  }
});

test("customer verify: the code is checked against the matched contact; a stored number in another format still matches", async () => {
  reset(); stubLoginOrder([contact(`+91${N}`)]);
  otpStore.seed({ id: "otp1", userId: "k1", code: hashLoginOtp("otp1", "k1", "123456"), destination: N });
  const ok = await call(null, "POST", "/auth/customer/verify", { orderNumber: "ORD-T1", phone: `0${N}`, code: "123456" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
  const where = called("otpCode.findFirst")[0][0].where;
  assert.equal(where.userId, "k1");
  assert.equal(where.destination, N, "the code must have been delivered to the number being verified");
  assert.equal(where.consumedAt, null, "an already-used code is not considered");
  assert.ok(where.expiresAt.gt instanceof Date, "an expired code is not considered");
  assert.ok(otpStore.rows[0].consumedAt, "the code is consumed");
});

test("customer verify: the destination cannot be switched to another customer's number", async () => {
  reset(); stubLoginOrder([contact(N)]);
  otpStore.seed({ id: "otp1", userId: "k1", code: hashLoginOtp("otp1", "k1", "123456"), destination: N });
  const r = await call(null, "POST", "/auth/customer/verify", { orderNumber: "ORD-T1", phone: OTHER, code: "123456" });
  assert.equal(r.status, 401, "OTHER is not a contact of this order's customer");
  assert.equal(r.body.token, undefined);
  assert.equal(called("otpCode.findFirst").length, 0, "the code is not even looked up");
  assert.equal((await call(null, "POST", "/auth/customer/verify", { orderNumber: "ORD-T1", phone: "12345", code: "123456" })).status, 400);
});

test("phone-only login (mobile app): finds the account by any accepted spelling and rejects invalid numbers", async () => {
  for (const typed of ACCEPTED) {
    reset();
    stubModel("user", { ...db.user, findFirst: () => ({ id: "k1", phone: `+91${N}`, isActive: true, role: { key: "customer" } }) });
    const r = await call(null, "POST", "/auth/otp/request", { phone: typed });
    assert.equal(r.status, 200, JSON.stringify(typed));
    assert.deepEqual(called("user.findFirst")[0][0].where.phone.in, mobileStorageVariants(N));
    assert.equal(called("otpCode.create")[0][0].data.userId, "k1");
  }
  for (const typed of BAD) {
    reset();
    assert.equal((await call(null, "POST", "/auth/otp/request", { phone: typed })).status, 400, JSON.stringify(typed));
    assert.equal(called("otpCode.create").length, 0);
  }
  reset();
  const unknown = await call(null, "POST", "/auth/otp/request", { phone: N });
  assert.equal(unknown.status, 200, "unknown number: same answer as a real one");
  assert.equal(called("otpCode.create").length, 0);
  assert.equal((await call(null, "POST", "/auth/otp/verify", { phone: "bad", code: "123456" })).status, 400);
});

// =============================================================================================
// Vendors
// =============================================================================================

const newVendor = (contactPhone: unknown) => ({ name: "Coimbatore Erectors", contactName: "Vik", contactEmail: "vik@example.com", contactPhone });
function stubVendorCreate() {
  stubModel("vendor", {
    findUnique: () => null,
    create: ({ data }: any) => ({ id: "v1", ...data }),
  });
}

for (const [label, path, who] of [["public registration", "/vendors/register", null], ["staff adding a vendor", "/vendors", "admin"]] as const) {
  test(`vendors (${label}): every accepted spelling is stored as the same 10 digits`, async () => {
    for (const input of ACCEPTED) {
      reset(); stubVendorCreate();
      const r = await call(who, "POST", path, newVendor(input));
      assert.equal(r.status, 201, JSON.stringify(input) + JSON.stringify(r.body));
      assert.equal(called("vendor.create")[0][0].data.contactPhone, N);
    }
  });

  test(`vendors (${label}): a missing or invalid number is rejected on the server and creates nothing`, async () => {
    for (const input of BAD) {
      reset(); stubVendorCreate();
      const r = await call(who, "POST", path, newVendor(input));
      assert.equal(r.status, 400, JSON.stringify(input));
      assert.ok(mentionsMobileRule(r.body));
      assert.equal(called("vendor.create").length, 0);
      assert.equal(called("user.create").length, 0, "and no login user");
    }
    reset(); stubVendorCreate();
    const { contactPhone: _drop, ...noPhone } = newVendor(N);
    const r = await call(who, "POST", path, noPhone);
    assert.equal(r.status, 400);
    assert.equal(called("vendor.create").length, 0);
  });
}

test("vendors (staff add): the login user gets the SAME normalised number", async () => {
  reset(); stubVendorCreate();
  const r = await call("admin", "POST", "/vendors", newVendor(`+91 ${N}`));
  assert.equal(r.status, 201);
  assert.equal(r.body.contactLoginCreated, true);
  assert.equal(called("vendor.create")[0][0].data.contactPhone, N);
  assert.equal(called("user.create")[0][0].data.phone, N);
  assert.equal(called("user.create")[0][0].data.vendorId, "v1", "the login belongs to this vendor");
});

test("vendors: a number already used by another user keeps the vendor but skips the login with a clear reason (no 500)", async () => {
  reset(); stubVendorCreate();
  stubModel("user", { ...db.user, findFirst: () => ({ id: "someone" }) });
  const r = await call("admin", "POST", "/vendors", newVendor(N));
  assert.equal(r.status, 201);
  assert.equal(r.body.contactLoginCreated, false);
  assert.match(r.body.contactLoginSkippedReason, /already used by another user/);
  assert.equal(called("user.create").length, 0);
  assert.deepEqual(called("user.findFirst")[0][0].where.phone.in, mobileStorageVariants(N));

  // lost the race between the check and the insert
  reset(); stubVendorCreate();
  stubModel("user", { ...db.user, create: () => { throw p2002("User", "phone"); } });
  const raced = await call("admin", "POST", "/vendors", newVendor(N));
  assert.equal(raced.status, 201);
  assert.equal(raced.body.contactLoginCreated, false);
  assert.match(raced.body.contactLoginSkippedReason, /already used by another user/);

  // an e-mail conflict (the same address in another case, created at the same moment) is skipped with its own reason, not a 500 (R10)
  reset(); stubVendorCreate();
  stubModel("user", { ...db.user, create: () => { throw p2002("User", "email"); } });
  const emailRaced = await call("admin", "POST", "/vendors", newVendor(N));
  assert.equal(emailRaced.status, 201);
  assert.match(emailRaced.body.contactLoginSkippedReason, /email already exists/);

  // anything else is still a real failure
  reset(); stubVendorCreate();
  stubModel("user", { ...db.user, create: () => { throw p2002("User", "title"); } });
  assert.equal((await call("admin", "POST", "/vendors", newVendor(N))).status, 500);
});

test("vendors: approving a pending vendor creates the login from its stored number; legacy records are normalised, never invented", async () => {
  const approve = async (storedPhone: string | null) => {
    reset();
    stubModel("vendor", { findUnique: () => ({ id: "v9", name: "Old vendor", contactName: "Old", contactEmail: "old@example.com", contactPhone: storedPhone, status: "pending" }), update: () => ({}) });
    return call("admin", "POST", "/vendors/v9/approve");
  };
  assert.equal((await approve(`+91 ${N}`)).status, 200);
  assert.equal(called("user.create")[0][0].data.phone, N, "an older +91 spelling becomes 10 digits");

  assert.equal((await approve(null)).status, 200);
  assert.equal(called("user.create")[0][0].data.phone, null, "a legacy vendor without a number gets a login without one - no number is made up");

  assert.equal((await approve("call the office")).status, 200);
  assert.equal(called("user.create")[0][0].data.phone, null, "unreadable text is not copied onto the user");
});

test("vendors: staff routes keep their permission", async () => {
  reset(); stubVendorCreate();
  assert.equal((await call("nobody", "POST", "/vendors", newVendor(N))).status, 403);
  assert.equal((await call(null, "POST", "/vendors/v1/approve")).status, 401);
});

// =============================================================================================
// Site contacts
// =============================================================================================

const siteContact = (phone: unknown) => ({ name: "Security desk", phone, role: "Security head" });
function stubSite() {
  // any requested id is an existing, unscoped site (so "other-site" is a real site the contact does NOT belong to)
  stubModel("site", { findUnique: ({ where }: any) => ({ id: where.id, vendorId: null, order: { customerId: "c1" } }), update: () => ({}) });
  stubModel("siteContact", {
    create: ({ data }: any) => ({ id: "sc1", ...data }),
    findUnique: () => ({ id: "sc1", siteId: "s1", name: "Old", phone: null }),
    update: ({ where, data }: any) => ({ id: where.id, siteId: "s1", ...data }),
    delete: () => ({}),
  });
}

test("site contacts: every accepted spelling is stored as the same 10 digits, linked to the site in the URL", async () => {
  for (const input of ACCEPTED) {
    reset(); stubSite();
    const r = await call("admin", "POST", "/sites/s1/contacts", siteContact(input));
    assert.equal(r.status, 201, JSON.stringify(input) + JSON.stringify(r.body));
    const data = called("siteContact.create")[0][0].data;
    assert.equal(data.phone, N);
    assert.equal(data.siteId, "s1");
    assert.equal(data.name, "Security desk");
  }
});

test("site contacts: missing, empty and invalid numbers are rejected on the server and create nothing", async () => {
  for (const input of BAD) {
    reset(); stubSite();
    const r = await call("admin", "POST", "/sites/s1/contacts", siteContact(input));
    assert.equal(r.status, 400, JSON.stringify(input));
    assert.ok(mentionsMobileRule(r.body));
    assert.equal(called("siteContact.create").length, 0);
  }
  reset(); stubSite();
  const r = await call("admin", "POST", "/sites/s1/contacts", { name: "No number" });
  assert.equal(r.status, 400);
  assert.equal(called("siteContact.create").length, 0);
});

test("site contacts: an unknown site gets 404 and keeps the permission", async () => {
  reset(); stubSite();
  stubModel("site", { findUnique: () => null });
  assert.equal((await call("admin", "POST", "/sites/nope/contacts", siteContact(N))).status, 404);
  reset(); stubSite();
  assert.equal((await call("nobody", "POST", "/sites/s1/contacts", siteContact(N))).status, 403);
  assert.equal(called("siteContact.create").length, 0);
});

test("site contacts (update): a valid number is normalised, an invalid one is refused and nothing changes", async () => {
  reset(); stubSite();
  const ok = await call("admin", "PATCH", "/sites/s1/contacts/sc1", { phone: "+91 98765 43210" });
  assert.equal(ok.status, 200);
  assert.equal(called("siteContact.update")[0][0].data.phone, N);

  for (const input of BAD) {
    reset(); stubSite();
    const r = await call("admin", "PATCH", "/sites/s1/contacts/sc1", { phone: input });
    assert.equal(r.status, 400, JSON.stringify(input));
    assert.equal(called("siteContact.update").length, 0);
  }
});

test("site contacts (update): a legacy contact with no number can still be renamed without inventing a number", async () => {
  reset(); stubSite();
  const r = await call("admin", "PATCH", "/sites/s1/contacts/sc1", { name: "Renamed" });
  assert.equal(r.status, 200);
  const data = called("siteContact.update")[0][0].data;
  assert.equal(data.name, "Renamed");
  assert.equal("phone" in data, false);
});

test("site contacts: a contact can only be changed or deleted through ITS OWN site", async () => {
  reset(); stubSite();
  assert.equal((await call("admin", "PATCH", "/sites/other-site/contacts/sc1", { phone: N })).status, 404);
  assert.equal((await call("admin", "DELETE", "/sites/other-site/contacts/sc1")).status, 404);
  assert.equal(called("siteContact.update").length, 0);
  assert.equal(called("siteContact.delete").length, 0);
  assert.equal((await call("admin", "DELETE", "/sites/s1/contacts/sc1")).status, 204);
});
