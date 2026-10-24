/**
 * Real-database tests for the mobile-number rules (what is actually STORED, unique-number races, rollback of the
 * customer+contact insert), the customer / phone-only login OTP security (hash storage, redacted notification log,
 * deactivated accounts, single use, enumeration) and who may see which contact number on a ticket.
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at
 * the disposable Docker database (localhost:5434/platino_test) and they only touch rows they create
 * themselves (unique run prefix; everything is removed in `after`). All phone numbers are synthetic.
 * Nothing is sent: SMTP and WhatsApp are not configured, and the contacts have no email address.
 * Run with:  npm run test:db --workspace=apps/api   (database already migrated and seeded)
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
describe("mobile-number rules against the real test database", { skip }, () => {
  const PREFIX = `ZM${Date.now().toString(36).toUpperCase()}`;
  const tracked = { customerIds: new Set<string>(), vendorIds: new Set<string>(), orderIds: new Set<string>(), userIds: new Set<string>(), phones: new Set<string>() };
  let seq = 0;
  let hit = 0;
  const realConsole = { log: console.log, error: console.error };

  /** A unique synthetic 10-digit mobile number (starts with 9). */
  const newPhone = () => {
    const n = `9${String((Date.now() % 10_000_000) * 100 + ++seq).padStart(9, "0")}`.slice(0, 10);
    tracked.phones.add(n);
    return n;
  };
  const spellings = (n: string) => [n, `+91${n}`, `91${n}`, `0${n}`, `+91 ${n.slice(0, 5)} ${n.slice(5)}`, `${n.slice(0, 5)}-${n.slice(5)}`, `  ${n}  `];

  let prisma: any;
  let server: Server;
  let base = "";
  let signToken: (p: any) => string;
  let adminToken = "";
  let productId = "";
  let stageId = "";
  let customerRoleId = "";
  let loginOtp: typeof import("../../src/lib/loginOtp");

  async function call(method: string, path: string, body?: unknown, token: string | null = adminToken) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${Math.floor(++hit / 250)}.${hit % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  const customerBody = (tag: string, phone: unknown) => ({ name: `${PREFIX} ${tag}`, contactName: `Contact ${tag}`, contactPhone: phone });
  const customersNamed = (tag: string) => prisma.customer.count({ where: { name: `${PREFIX} ${tag}` } });

  async function makeCustomer(tag: string, phone = newPhone()) {
    const r = await call("POST", "/customers", customerBody(tag, phone));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.customerIds.add(r.body.id);
    return { customer: r.body, phone, contactId: r.body.contacts[0].id as string };
  }

  async function makeOrderWithSite(customerId: string) {
    const order = await prisma.order.create({
      data: { orderNumber: `${PREFIX}-O${++seq}`, customerId, productId, quantity: 1, site: { create: { currentStageId: stageId } } },
      include: { site: true },
    });
    tracked.orderIds.add(order.id);
    return order as { id: string; orderNumber: string; site: { id: string } };
  }

  async function cleanup() {
    if (!prisma) return;
    const customerIds = [...tracked.customerIds];
    const vendorIds = [...tracked.vendorIds];
    const named = await prisma.customer.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const namedVendors = await prisma.vendor.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const allCustomers = [...new Set([...customerIds, ...named.map((c: any) => c.id)])];
    const allVendors = [...new Set([...vendorIds, ...namedVendors.map((v: any) => v.id)])];
    const phoneVariants = [...tracked.phones].flatMap((n) => [n, `+91${n}`, `91${n}`, `0${n}`]);
    const users = await prisma.user.findMany({
      where: { OR: [{ customerId: { in: allCustomers } }, { vendorId: { in: allVendors } }, { phone: { in: phoneVariants } }, { id: { in: [...tracked.userIds] } }] },
      select: { id: true },
    });
    const userIds = users.map((u: any) => u.id);
    await prisma.notificationLog.deleteMany({ where: { recipientId: { in: userIds } } });
    await prisma.complaint.deleteMany({ where: { OR: [{ ticketNumber: { startsWith: PREFIX } }, { description: { startsWith: PREFIX } }] } });
    const orders = await prisma.order.findMany({ where: { OR: [{ id: { in: [...tracked.orderIds] } }, { orderNumber: { startsWith: PREFIX } }] }, select: { id: true } });
    const orderIds = orders.map((o: any) => o.id);
    await prisma.site.deleteMany({ where: { orderId: { in: orderIds } } }); // site contacts go with their site
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // OTP rows go with their user
    await prisma.vendor.deleteMany({ where: { id: { in: allVendors } } });
    await prisma.customer.deleteMany({ where: { id: { in: allCustomers } } });
  }

  before(async () => {
    // These tests need a login-code route that works without a phone: the explicit local-development switch echoes
    // the code (nothing is sent). Real delivery and the other modes are covered in loginOtp.db.test.ts.
    for (const k of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "VERCEL", "VERCEL_ENV"]) delete process.env[k];
    process.env.OTP_DEV_ECHO = "1";
    console.log = () => {}; // the login route logs OTP details; keep them out of the test output
    console.error = () => {};
    ({ prisma } = await import("../../src/lib/prisma"));
    const [{ db }] = await prisma.$queryRaw`select current_database() as db`;
    assert.equal(db, ISOLATED.database, "connected to the wrong database - aborting");
    await prisma.ipRateLimit.deleteMany({}); // disposable DB only: sign-in attempts counted by earlier runs in the same 15-minute window would otherwise answer 429
    assert.notEqual(process.env.NODE_ENV, "production");

    ({ signToken } = await import("../../src/lib/jwt"));
    const { customersRouter } = await import("../../src/routes/customers");
    const { vendorsRouter } = await import("../../src/routes/vendors");
    const { sitesRouter } = await import("../../src/routes/sites");
    const { authRouter } = await import("../../src/routes/auth");
    const { complaintsRouter } = await import("../../src/routes/complaints");
    loginOtp = await import("../../src/lib/loginOtp");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "10mb" }));
    app.use("/customers", customersRouter);
    app.use("/vendors", vendorsRouter);
    app.use("/sites", sitesRouter);
    app.use("/auth", authRouter);
    app.use("/complaints", complaintsRouter);
    app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "superadmin@platino.example" }, include: { role: true } });
    adminToken = signToken({ userId: admin.id, roleKey: admin.role.key, customerId: null });
    productId = (await prisma.product.findUniqueOrThrow({ where: { model: "RECD-250" } })).id;
    stageId = (await prisma.stageDefinition.findFirstOrThrow({ orderBy: { sequenceOrder: "asc" } })).id;
    customerRoleId = (await prisma.role.findUniqueOrThrow({ where: { key: "customer" } })).id;
  });

  after(async () => {
    server?.close();
    try { await cleanup(); } finally {
      await prisma?.$disconnect();
      console.log = realConsole.log;
      console.error = realConsole.error;
    }
  });

  // ------------------------------------------------------------------------------------------
  // Customer contacts: what is really stored
  // ------------------------------------------------------------------------------------------

  test("customers: every accepted spelling is stored as 10 digits on a contact linked to the new customer", async () => {
    for (const [i, _] of spellings("9").entries()) {
      const n = newPhone();
      const typed = spellings(n)[i];
      const r = await call("POST", "/customers", customerBody(`fmt${i}`, typed));
      assert.equal(r.status, 201, `${JSON.stringify(typed)}: ${JSON.stringify(r.body)}`);
      tracked.customerIds.add(r.body.id);
      const users = await prisma.user.findMany({ where: { customerId: r.body.id }, include: { role: true } });
      assert.equal(users.length, 1);
      assert.equal(users[0].phone, n, "stored as exactly 10 digits");
      assert.equal(users[0].role.key, "customer");
      assert.equal(users[0].customerId, r.body.id, "the contact belongs to the customer it was created with");
    }
  });

  test("customers: invalid, empty and missing numbers are refused and no customer or contact is created", async () => {
    const bad = ["", "   ", "98765", "98765432101", "98765abcde", "5876543210", "+14155552671"];
    const usersBefore = await prisma.user.count();
    for (const [i, input] of bad.entries()) {
      const r = await call("POST", "/customers", customerBody(`bad${i}`, input));
      assert.equal(r.status, 400, JSON.stringify(input));
      assert.equal(await customersNamed(`bad${i}`), 0);
    }
    const missing = await call("POST", "/customers", { name: `${PREFIX} missing`, contactName: "X" });
    assert.equal(missing.status, 400);
    assert.equal(await customersNamed("missing"), 0);
    assert.equal(await prisma.user.count(), usersBefore, "no contact was created by any refused request");
  });

  test("customers: a number already in use - in any stored format - is a clear 400 and creates nothing", async () => {
    const { phone } = await makeCustomer("dup-base");
    for (const typed of [phone, `+91${phone}`, `0${phone}`]) {
      const r = await call("POST", "/customers", customerBody("dup-again", typed));
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "A contact with that phone number already exists");
    }
    assert.equal(await customersNamed("dup-again"), 0);

    // an OLDER row that still holds the number in the +91 format
    const legacyPhone = newPhone();
    const legacyCustomer = await prisma.customer.create({ data: { name: `${PREFIX} legacy-holder` } });
    tracked.customerIds.add(legacyCustomer.id);
    await prisma.user.create({ data: { name: "Legacy", phone: `+91${legacyPhone}`, roleId: customerRoleId, customerId: legacyCustomer.id, isActive: true, mustChangePassword: false } });
    const r = await call("POST", "/customers", customerBody("dup-legacy", legacyPhone));
    assert.equal(r.status, 400, "the bare number clashes with the +91 row");
    assert.equal(await customersNamed("dup-legacy"), 0);
  });

  test("customers: two simultaneous requests for one number - exactly one wins, no customer is left without its contact", async () => {
    for (let round = 0; round < 5; round++) {
      const phone = newPhone();
      const [a, b] = await Promise.all([
        call("POST", "/customers", customerBody(`race${round}-a`, phone)),
        call("POST", "/customers", customerBody(`race${round}-b`, `+91 ${phone}`)),
      ]);
      for (const r of [a, b]) if (r.status === 201) tracked.customerIds.add(r.body.id);
      assert.deepEqual([a.status, b.status].sort(), [201, 400], `round ${round}: ${JSON.stringify([a.body, b.body])}`);
      assert.equal(await prisma.user.count({ where: { phone } }), 1, `round ${round}: one holder of the number`);
      const created = await prisma.customer.count({ where: { name: { in: [`${PREFIX} race${round}-a`, `${PREFIX} race${round}-b`] } } });
      assert.equal(created, 1, `round ${round}: the loser's customer row was rolled back with its contact`);
    }
  });

  // ------------------------------------------------------------------------------------------
  // Customer login: any accepted spelling finds the stored number
  // ------------------------------------------------------------------------------------------

  /** Pretends the customer's earlier code was requested a while ago, so the 30-second resend cooldown does not apply. */
  async function pastCooldown(orderNumber: string) {
    const order = await prisma.order.findUnique({ where: { orderNumber }, select: { customerId: true } });
    if (order) await prisma.otpCode.updateMany({ where: { user: { customerId: order.customerId } }, data: { createdAt: new Date(Date.now() - 120_000) } });
  }

  async function login(orderNumber: string, typedForRequest: string, typedForVerify = typedForRequest) {
    await pastCooldown(orderNumber);
    const requested = await call("POST", "/auth/customer/register", { orderNumber, phone: typedForRequest }, null);
    if (requested.status !== 200) return { requested, verified: null as any };
    assert.ok(requested.body.devCode, "development mode echoes the code, so nothing needs to be delivered");
    const verified = await call("POST", "/auth/customer/verify", { orderNumber, phone: typedForVerify, code: requested.body.devCode }, null);
    return { requested, verified };
  }

  test("customer login: a customer created through the API logs in with any accepted spelling of the number", async () => {
    const { customer, phone, contactId } = await makeCustomer("login");
    const order = await makeOrderWithSite(customer.id);

    for (const [requestTyped, verifyTyped] of [[phone, `+91${phone}`], [`0${phone}`, phone], [`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, `91${phone}`]]) {
      const { requested, verified } = await login(order.orderNumber, requestTyped, verifyTyped);
      assert.equal(requested.status, 200, JSON.stringify(requested.body));
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.user.id, contactId, "signed in as the matched contact");
      assert.equal(verified.body.user.customerId, customer.id);
      assert.ok(verified.body.token);
    }
  });

  test("customer login: an OLDER contact stored with +91 still logs in, and the OTP belongs to that contact", async () => {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} legacy-login` } });
    tracked.customerIds.add(customer.id);
    const phone = newPhone();
    const contact = await prisma.user.create({ data: { name: "Legacy", phone: `+91 ${phone}`, roleId: customerRoleId, customerId: customer.id, isActive: true, mustChangePassword: false } });
    const order = await makeOrderWithSite(customer.id);

    const { requested, verified } = await login(order.orderNumber, phone);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const otp = await prisma.otpCode.findFirstOrThrow({ where: { userId: contact.id }, orderBy: { createdAt: "desc" } });
    assert.notEqual(otp.code, requested.body.devCode, "the database does not hold the code");
    assert.equal(loginOtp.verifyLoginOtpHash(otp.id, contact.id, requested.body.devCode, otp.code), true, "it holds a hash that verifies it");
    assert.equal(verified.status, 200);
    assert.equal(verified.body.user.id, contact.id);
    assert.ok((await prisma.otpCode.findUniqueOrThrow({ where: { id: otp.id } })).consumedAt, "the code is marked used");
  });

  test("customer login: wrong, used, expired and misdirected codes never produce a token", async () => {
    const { customer, phone } = await makeCustomer("login-bad");
    const other = await makeCustomer("login-other");
    const order = await makeOrderWithSite(customer.id);

    const requested = await call("POST", "/auth/customer/register", { orderNumber: order.orderNumber, phone }, null);
    const code = requested.body.devCode as string;
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal((await call("POST", "/auth/customer/verify", { orderNumber: order.orderNumber, phone, code: wrong }, null)).status, 401, "wrong code");

    // another customer's number cannot be substituted at verify time
    const swapped = await call("POST", "/auth/customer/verify", { orderNumber: order.orderNumber, phone: other.phone, code }, null);
    assert.equal(swapped.status, 401);
    assert.equal(swapped.body.token, undefined);

    const good = await call("POST", "/auth/customer/verify", { orderNumber: order.orderNumber, phone, code }, null);
    assert.equal(good.status, 200);
    const replay = await call("POST", "/auth/customer/verify", { orderNumber: order.orderNumber, phone, code }, null);
    assert.equal(replay.status, 401, "a used code cannot be replayed");

    await pastCooldown(order.orderNumber);
    const second = await call("POST", "/auth/customer/register", { orderNumber: order.orderNumber, phone }, null);
    await prisma.otpCode.updateMany({ where: { user: { customerId: customer.id }, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await call("POST", "/auth/customer/verify", { orderNumber: order.orderNumber, phone, code: second.body.devCode }, null);
    assert.equal(expired.status, 401, "an expired code is refused");
  });

  test("customer login: invalid numbers are refused and numbers of other customers never get a code", async () => {
    const { customer } = await makeCustomer("login-guard");
    const stranger = await makeCustomer("login-stranger");
    const order = await makeOrderWithSite(customer.id);
    const before = await prisma.otpCode.count();
    for (const typed of ["", "98765", "abcdefghij", "5876543210"]) {
      assert.equal((await call("POST", "/auth/customer/register", { orderNumber: order.orderNumber, phone: typed }, null)).status, 400, JSON.stringify(typed));
    }
    const unmatched = await call("POST", "/auth/customer/register", { orderNumber: order.orderNumber, phone: stranger.phone }, null);
    assert.equal(unmatched.status, 200, "no account signal");
    assert.equal(unmatched.body.devCode, undefined);
    assert.equal(await prisma.otpCode.count(), before, "no OTP row was created");
  });

  // ------------------------------------------------------------------------------------------
  // Customer updates
  // ------------------------------------------------------------------------------------------

  test("customer update: edits the primary (oldest) contact by default and exactly the named contact with contactId", async () => {
    const { customer, contactId: primaryId } = await makeCustomer("upd");
    await new Promise((r) => setTimeout(r, 15)); // distinct createdAt
    const secondPhone = newPhone();
    const second = await prisma.user.create({ data: { name: "Second", phone: secondPhone, roleId: customerRoleId, customerId: customer.id, isActive: true, mustChangePassword: false } });

    const newPrimary = newPhone();
    const r1 = await call("PUT", `/customers/${customer.id}`, { contactPhone: `+91 ${newPrimary}` });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: primaryId } })).phone, newPrimary, "the oldest contact was changed");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).phone, secondPhone, "the other contact was not touched");

    const newSecond = newPhone();
    const r2 = await call("PUT", `/customers/${customer.id}`, { contactId: second.id, contactPhone: `0${newSecond}`, contactName: "Second renamed" });
    assert.equal(r2.status, 200);
    const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal(afterSecond.phone, newSecond);
    assert.equal(afterSecond.name, "Second renamed");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: primaryId } })).phone, newPrimary, "primary still untouched");
    assert.deepEqual(r2.body.contacts.map((c: any) => c.id), [primaryId, second.id], "contacts are returned oldest first");
  });

  test("customer update: a contact of another customer is refused, an invalid number changes nothing, a clash is a clear 400", async () => {
    const a = await makeCustomer("upd-a");
    const b = await makeCustomer("upd-b");
    const foreign = await call("PUT", `/customers/${a.customer.id}`, { contactId: b.contactId, contactPhone: newPhone() });
    assert.equal(foreign.status, 404);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: b.contactId } })).phone, b.phone, "the other customer's contact is untouched");

    const invalid = await call("PUT", `/customers/${a.customer.id}`, { name: `${PREFIX} renamed`, contactPhone: "12345" });
    assert.equal(invalid.status, 400);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: a.customer.id } })).name, `${PREFIX} upd-a`, "the rename was not applied either");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.contactId } })).phone, a.phone);

    const clash = await call("PUT", `/customers/${a.customer.id}`, { contactPhone: `+91${b.phone}` });
    assert.equal(clash.status, 400);
    assert.equal(clash.body.error, "A contact with that phone number already exists");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.contactId } })).phone, a.phone);
  });

  test("customer update: re-saving an older-format number tidies it to 10 digits without clashing with itself", async () => {
    const customer = await prisma.customer.create({ data: { name: `${PREFIX} tidy` } });
    tracked.customerIds.add(customer.id);
    const phone = newPhone();
    const contact = await prisma.user.create({ data: { name: "Legacy", phone: `+91${phone}`, roleId: customerRoleId, customerId: customer.id, isActive: true, mustChangePassword: false } });
    const r = await call("PUT", `/customers/${customer.id}`, { contactPhone: phone });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: contact.id } })).phone, phone);
  });

  // ------------------------------------------------------------------------------------------
  // Vendors
  // ------------------------------------------------------------------------------------------

  const vendorBody = (tag: string, phone: unknown) => ({ name: `${PREFIX} ${tag}`, contactName: `Vendor ${tag}`, contactEmail: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, contactPhone: phone });
  const vendorsNamed = (tag: string) => prisma.vendor.count({ where: { name: `${PREFIX} ${tag}` } });

  test("vendors: registration stores the number as 10 digits; missing or invalid numbers create no vendor", async () => {
    for (const [i, _] of spellings("9").entries()) {
      const n = newPhone();
      const r = await call("POST", "/vendors/register", vendorBody(`reg${i}`, spellings(n)[i]), null);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      tracked.vendorIds.add(r.body.id);
      assert.equal((await prisma.vendor.findUniqueOrThrow({ where: { id: r.body.id } })).contactPhone, n);
    }
    for (const [i, input] of ["", "98765", "abcdefghij", "5876543210"].entries()) {
      const r = await call("POST", "/vendors/register", vendorBody(`regbad${i}`, input), null);
      assert.equal(r.status, 400, JSON.stringify(input));
      assert.equal(await vendorsNamed(`regbad${i}`), 0);
    }
    const { contactPhone: _drop, ...noPhone } = vendorBody("regnone", "x");
    assert.equal((await call("POST", "/vendors/register", noPhone, null)).status, 400);
    assert.equal(await vendorsNamed("regnone"), 0);
  });

  test("vendors: staff adding a vendor creates a login with the SAME normalised number, linked to that vendor", async () => {
    const n = newPhone();
    const r = await call("POST", "/vendors", vendorBody("staff", `+91 ${n}`));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.vendorIds.add(r.body.id);
    assert.equal(r.body.contactLoginCreated, true);
    assert.equal((await prisma.vendor.findUniqueOrThrow({ where: { id: r.body.id } })).contactPhone, n);
    const login = await prisma.user.findFirstOrThrow({ where: { vendorId: r.body.id } });
    assert.equal(login.phone, n);
    assert.equal(login.email, (await prisma.vendor.findUniqueOrThrow({ where: { id: r.body.id } })).contactEmail);
  });

  test("vendors: a number already used by another user keeps the vendor, skips the login, and explains why (no 500)", async () => {
    const holder = await makeCustomer("vendor-holder");
    const r = await call("POST", "/vendors", vendorBody("dupe", `+91${holder.phone}`));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tracked.vendorIds.add(r.body.id);
    assert.equal(r.body.contactLoginCreated, false);
    assert.match(r.body.contactLoginSkippedReason, /already used by another user/);
    assert.equal(await prisma.user.count({ where: { vendorId: r.body.id } }), 0);
    assert.equal(await prisma.user.count({ where: { phone: holder.phone } }), 1, "the existing contact keeps the number");
  });

  test("vendors: approving creates the login from the stored number; older records are normalised and nothing is invented", async () => {
    const approveNew = async (tag: string, stored: string | null) => {
      const v = await prisma.vendor.create({
        data: { name: `${PREFIX} ${tag}`, contactName: `Vendor ${tag}`, contactEmail: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, contactPhone: stored, status: "pending" },
      });
      tracked.vendorIds.add(v.id);
      const r = await call("POST", `/vendors/${v.id}/approve`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { vendor: v, response: r.body, login: await prisma.user.findFirst({ where: { vendorId: v.id } }) };
    };
    const n = newPhone();
    const legacy = await approveNew("approve-legacy", `+91 ${n.slice(0, 5)} ${n.slice(5)}`);
    assert.equal(legacy.login?.phone, n, "older spelling becomes 10 digits");
    assert.equal((await prisma.vendor.findUniqueOrThrow({ where: { id: legacy.vendor.id } })).contactPhone, `+91 ${n.slice(0, 5)} ${n.slice(5)}`, "the vendor record itself is not rewritten");

    const none = await approveNew("approve-none", null);
    assert.equal(none.response.contactLoginCreated, true);
    assert.equal(none.login?.phone, null, "no number is made up");

    const text = await approveNew("approve-text", "call the office");
    assert.equal(text.login?.phone, null, "unreadable text is not copied onto the user");
  });

  test("vendors: two approvals racing for one number - one login, the other skipped with a reason, never a 500", async () => {
    const n = newPhone();
    const mk = async (tag: string) => {
      const v = await prisma.vendor.create({ data: { name: `${PREFIX} ${tag}`, contactName: tag, contactEmail: `${PREFIX.toLowerCase()}-${tag}-${++seq}@example.invalid`, contactPhone: n, status: "pending" } });
      tracked.vendorIds.add(v.id);
      return v;
    };
    const [v1, v2] = [await mk("race-v1"), await mk("race-v2")];
    const [r1, r2] = await Promise.all([call("POST", `/vendors/${v1.id}/approve`), call("POST", `/vendors/${v2.id}/approve`)]);
    assert.deepEqual([r1.status, r2.status], [200, 200], JSON.stringify([r1.body, r2.body]));
    assert.deepEqual([r1.body.contactLoginCreated, r2.body.contactLoginCreated].sort(), [false, true]);
    const skipped = r1.body.contactLoginCreated ? r2.body : r1.body;
    assert.match(skipped.contactLoginSkippedReason, /already used by another user/);
    assert.equal(await prisma.user.count({ where: { phone: n } }), 1);
  });

  // ------------------------------------------------------------------------------------------
  // Site contacts
  // ------------------------------------------------------------------------------------------

  test("site contacts: stored as 10 digits, linked to the right site and customer; invalid numbers store nothing", async () => {
    const { customer } = await makeCustomer("site-owner");
    const order = await makeOrderWithSite(customer.id);
    const other = await makeCustomer("site-other");
    const otherOrder = await makeOrderWithSite(other.customer.id);

    const n = newPhone();
    const created = await call("POST", `/sites/${order.site.id}/contacts`, { name: "Security desk", phone: `+91 ${n}`, role: "Security head" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const row = await prisma.siteContact.findUniqueOrThrow({ where: { id: created.body.id }, include: { site: { include: { order: true } } } });
    assert.equal(row.phone, n);
    assert.equal(row.siteId, order.site.id);
    assert.equal(row.site.order.customerId, customer.id, "the contact belongs to the right customer's site");
    assert.equal(await prisma.siteContact.count({ where: { siteId: otherOrder.site.id } }), 0, "the other customer's site has no contacts");

    for (const bad of ["", "   ", "12345", "abcdefghij", "5876543210", undefined]) {
      const r = await call("POST", `/sites/${order.site.id}/contacts`, { name: "Bad", phone: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(await prisma.siteContact.count({ where: { siteId: order.site.id } }), 1, "only the valid contact was stored");
    assert.equal((await call("POST", `/sites/does-not-exist/contacts`, { name: "X", phone: n })).status, 404);
  });

  test("site contacts: updates are validated and normalised; a legacy contact with no number can still be renamed", async () => {
    const { customer } = await makeCustomer("site-upd");
    const order = await makeOrderWithSite(customer.id);
    const n = newPhone();
    const created = await call("POST", `/sites/${order.site.id}/contacts`, { name: "Desk", phone: n });
    const id = created.body.id as string;

    const m = newPhone();
    const ok = await call("PATCH", `/sites/${order.site.id}/contacts/${id}`, { phone: `0${m}` });
    assert.equal(ok.status, 200);
    assert.equal((await prisma.siteContact.findUniqueOrThrow({ where: { id } })).phone, m);

    const bad = await call("PATCH", `/sites/${order.site.id}/contacts/${id}`, { phone: "12345", name: "Renamed" });
    assert.equal(bad.status, 400);
    const unchanged = await prisma.siteContact.findUniqueOrThrow({ where: { id } });
    assert.equal(unchanged.phone, m);
    assert.equal(unchanged.name, "Desk", "nothing from the refused request was applied");

    const legacy = await prisma.siteContact.create({ data: { siteId: order.site.id, name: "Legacy no number" } });
    const rename = await call("PATCH", `/sites/${order.site.id}/contacts/${legacy.id}`, { name: "Legacy renamed" });
    assert.equal(rename.status, 200);
    const after = await prisma.siteContact.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(after.name, "Legacy renamed");
    assert.equal(after.phone, null, "the missing number was left alone, not invented");
  });

  test("site contacts: a contact can only be changed or deleted through its own site", async () => {
    const a = await makeOrderWithSite((await makeCustomer("site-a")).customer.id);
    const b = await makeOrderWithSite((await makeCustomer("site-b")).customer.id);
    const created = await call("POST", `/sites/${a.site.id}/contacts`, { name: "A's contact", phone: newPhone() });
    const before = await prisma.siteContact.findUniqueOrThrow({ where: { id: created.body.id } });

    assert.equal((await call("PATCH", `/sites/${b.site.id}/contacts/${before.id}`, { phone: newPhone() })).status, 404);
    assert.equal((await call("DELETE", `/sites/${b.site.id}/contacts/${before.id}`)).status, 404);
    const after = await prisma.siteContact.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(after.phone, before.phone);
    assert.equal(after.siteId, a.site.id);
  });

  // ------------------------------------------------------------------------------------------
  // OTP security against the real tables
  // ------------------------------------------------------------------------------------------

  /** Runs fn with NODE_ENV=production (awaited), then puts the development value back. */
  async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try { return await fn(); } finally { process.env.NODE_ENV = saved; }
  }
  /** Everything the server writes to its log while fn runs. */
  async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
    const lines: string[] = [];
    const saved = { log: console.log, error: console.error, warn: console.warn };
    const grab = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    console.log = grab; console.error = grab; console.warn = grab;
    try { return { result: await fn(), logged: lines.join("\n") }; } finally { Object.assign(console, saved); }
  }
  async function makeStaff(tag: string, isActive = true, roleKey = "service_engineer") {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const phone = newPhone();
    const user = await prisma.user.create({ data: { name: `${PREFIX} ${tag}`, phone, roleId: role.id, isActive, mustChangePassword: false } });
    tracked.userIds.add(user.id);
    return { user, phone, role };
  }

  // The login-OTP tests (storage, delivery, resend, expiry, attempts, concurrency) moved to
  // test/db/loginOtp.db.test.ts when login codes switched from email to WhatsApp and gained purpose / destination /
  // persistent attempt counting. phoneLogin / phoneVerify above are no longer used here.

  // ------------------------------------------------------------------------------------------
  // Who sees which contact number on a ticket (real rows, real relations)
  // ------------------------------------------------------------------------------------------

  test("ticket contacts: each ticket shows its own site's and customer's people; roles see only what they should", async () => {
    const A = await makeCustomer("tc-a");
    await new Promise((r) => setTimeout(r, 15));
    const aSecond = await prisma.user.create({ data: { name: "Second contact of A", phone: newPhone(), roleId: customerRoleId, customerId: A.customer.id, isActive: true, mustChangePassword: false } });
    tracked.userIds.add(aSecond.id);
    const B = await makeCustomer("tc-b");

    const orderA = await makeOrderWithSite(A.customer.id);
    const orderB = await makeOrderWithSite(B.customer.id);
    const pocPhone = newPhone();
    await prisma.site.update({ where: { id: orderA.site.id }, data: { sitePocName: "POC of A", sitePocNumber: pocPhone } });
    await prisma.site.update({ where: { id: orderB.site.id }, data: { sitePocName: "POC of B (no number)" } });
    const contactPhone = newPhone();
    await prisma.siteContact.create({ data: { siteId: orderA.site.id, name: "Desk of A", role: "Security head", phone: contactPhone } });
    await prisma.siteContact.create({ data: { siteId: orderA.site.id, name: "Legacy contact of A" } });
    await prisma.siteContact.create({ data: { siteId: orderB.site.id, name: "Desk of B", phone: newPhone() } });

    const engineer = await makeStaff("tc-eng");
    const reporterPhone = newPhone();
    const ticketData = (tag: string, customerId: string, siteId: string, extra: Record<string, unknown>) => ({
      ticketNumber: `${PREFIX}-${tag}`, customerId, siteId, category: "non_performance", description: `${PREFIX} ${tag}`, severity: "low", status: "open", ...extra,
    });
    await prisma.complaint.create({ data: ticketData("TA", A.customer.id, orderA.site.id, { source: "public", reporterName: "Reseller Mani", reporterType: "reseller", reporterPhone, assignedToId: engineer.user.id }) });
    await prisma.complaint.create({ data: ticketData("TB", B.customer.id, orderB.site.id, { source: "portal" }) });

    const mine = (list: any[]) => list.filter((t) => String(t.ticketNumber).startsWith(PREFIX));
    const tokenFor = (userId: string, roleKey: string, customerId: string | null) => signToken({ userId, roleKey, customerId });

    // --- service desk / management: everything, each ticket with ITS OWN people
    const desk = await call("GET", "/complaints");
    assert.equal(desk.status, 200);
    const tickets = mine(desk.body);
    const ta = tickets.find((t: any) => t.ticketNumber === `${PREFIX}-TA`).contactInfo;
    const tb = tickets.find((t: any) => t.ticketNumber === `${PREFIX}-TB`).contactInfo;
    assert.deepEqual(ta.reporter, { name: "Reseller Mani", type: "reseller", phone: reporterPhone });
    assert.deepEqual(ta.sitePoc, { name: "POC of A", phone: pocPhone });
    assert.deepEqual(ta.siteContacts.map((c: any) => [c.name, c.phone]), [["Desk of A", contactPhone], ["Legacy contact of A", null]], "oldest first; the legacy contact has no number");
    assert.deepEqual(ta.customerContact, { name: `Contact tc-a`, phone: A.phone }, "the PRIMARY (oldest) contact, not the second one");
    assert.equal(tb.reporter, null);
    assert.deepEqual(tb.sitePoc, { name: "POC of B (no number)", phone: null });
    assert.deepEqual(tb.siteContacts.map((c: any) => c.name), ["Desk of B"]);
    assert.equal(tb.customerContact.name, "Contact tc-b");
    assert.ok(!JSON.stringify(ta).includes("Desk of B") && !JSON.stringify(ta).includes("Contact tc-b"), "A's ticket shows nothing of B");
    assert.ok(!JSON.stringify(tb).includes("Desk of A") && !JSON.stringify(tb).includes(reporterPhone) && !JSON.stringify(tb).includes("Contact tc-a"), "B's ticket shows nothing of A");
    assert.equal(tickets.every((t: any) => !("contacts" in t.site)), true);

    // --- customer A: only their own ticket, no contact block, no reseller number
    const customerToken = tokenFor(A.contactId, "customer", A.customer.id);
    const asCustomer = await call("GET", "/complaints", undefined, customerToken);
    assert.equal(asCustomer.status, 200);
    const own = mine(asCustomer.body);
    assert.deepEqual(own.map((t: any) => t.ticketNumber), [`${PREFIX}-TA`], "never B's ticket");
    assert.equal(own[0].contactInfo, undefined);
    assert.equal("reporterPhone" in own[0], false);
    assert.ok(!JSON.stringify(asCustomer.body).includes(reporterPhone), "the reseller's number is nowhere in the customer's response");

    // --- field engineer: only the ticket assigned to them; site people yes, customer company contact no
    const asEngineer = await call("GET", "/complaints", undefined, tokenFor(engineer.user.id, "service_engineer", null));
    assert.equal(asEngineer.status, 200);
    assert.deepEqual(mine(asEngineer.body).map((t: any) => t.ticketNumber), [`${PREFIX}-TA`]);
    assert.equal(mine(asEngineer.body)[0].contactInfo.customerContact, null);
    assert.deepEqual(mine(asEngineer.body)[0].contactInfo.sitePoc, { name: "POC of A", phone: pocPhone });

    // --- the seeded vendor-scoped engineer has no assigned ticket: sees none of it
    const vendorEng = await prisma.user.findUniqueOrThrow({ where: { email: "erection@platino.example" }, include: { role: true } });
    const asVendor = await call("GET", "/complaints", undefined, tokenFor(vendorEng.id, vendorEng.role.key, null));
    assert.equal(asVendor.status, 200);
    assert.deepEqual(mine(asVendor.body), []);

    // --- sales has no complaint access at all
    const sales = await prisma.user.findUniqueOrThrow({ where: { email: "sales@platino.example" }, include: { role: true } });
    assert.equal((await call("GET", "/complaints", undefined, tokenFor(sales.id, sales.role.key, null))).status, 403);
    assert.equal((await call("GET", "/complaints", undefined, null)).status, 401);
  });
});

// Runs even when the guard skips everything above, so a skipped run is never silently empty.
test("the isolated-database guard accepts only the disposable local database", () => {
  assert.equal(pointsAtIsolatedDb("postgresql://u:p@localhost:5434/platino_test"), true);
  for (const bad of [
    "postgresql://u:p@localhost:5432/platino_test",
    "postgresql://u:p@localhost:5434/postgres",
    "postgresql://u:p@db.example.com:5434/platino_test",
    "postgresql://u:p@aws-1-ap-south-1.pooler.supabase.com:6543/postgres",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(pointsAtIsolatedDb(bad), false);
  }
});
