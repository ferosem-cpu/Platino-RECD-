// POST /customers and PUT /customers/:id when the contact's email is already used by another user.
// Prisma is replaced by in-memory stubs that raise the P2002 shape this project's Postgres produces.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const p2002 = (modelName: string, target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName, target } });

let createError: unknown = null;
let updateError: unknown = null;
let attemptedCreates = 0;
let server: Server;
let base = "";
let token = "";

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { signToken } = await import("../src/lib/jwt");
  const { customersRouter } = await import("../src/routes/customers");
  const define = (model: string, impl: Record<string, (...a: any[]) => any>) =>
    Object.defineProperty(prisma, model, { configurable: true, get: () => impl });
  define("user", {
    findUnique: () => ({ id: "mgr", isActive: true, customerId: null, vendorId: null, role: { key: ROLE_KEY.MANAGEMENT, permissions: [{ permission: { key: PERMISSION_KEY.MANAGE_ORDERS } }] } }),
    findFirst: () => null, // no phone clash: only the email can conflict
  });
  define("role", { findUniqueOrThrow: () => ({ id: "customer-role" }) });
  define("customer", {
    findUnique: () => ({ id: "c1", contacts: [{ id: "u1", phone: "9000000001" }] }),
    update: () => ({ id: "c1" }),
  });
  (prisma as any).$transaction = async (fn: any) => {
    const tx = {
      user: { update: () => { if (updateError) throw updateError; return {}; } },
      customer: {
        create: () => { attemptedCreates++; if (createError) throw createError; return { id: "c1", contacts: [{ id: "u1" }] }; },
        update: () => ({ id: "c1" }),
      },
      userAuditLog: { create: () => ({}), updateMany: () => ({ count: 0 }) },
    };
    return fn(tx);
  };
  token = signToken({ userId: "mgr", roleKey: ROLE_KEY.MANAGEMENT, customerId: null });
  const app = express();
  app.use(express.json());
  app.use("/customers", customersRouter);
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

const send = async (method: string, path: string, body: unknown) => {
  const res = await fetch(`${base}/customers${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const NEW = { name: "Acme", contactName: "Asha", contactPhone: "9000000001", contactEmail: "dup@example.com" };

test("creating a customer with an email already in use is a clear 409, not a 500", async () => {
  createError = p2002("Customer", ["email"]); // nested contact create is reported against the parent model
  const r = await send("POST", "/", NEW);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /email/i);
  createError = p2002("User", ["email"]);
  assert.equal((await send("POST", "/", NEW)).status, 409);
});

test("updating a contact to an email already in use is a clear 409", async () => {
  updateError = p2002("User", ["email"]);
  const r = await send("PUT", "/c1", { contactEmail: "dup@example.com" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /email/i);
});

test("a phone conflict keeps its own message and status", async () => {
  createError = p2002("Customer", ["phone"]);
  const r = await send("POST", "/", NEW);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /phone/i);
});

test("unrelated database errors are NOT hidden as an email conflict", async () => {
  for (const e of [new Error("connection lost"), p2002("Customer", ["name"]), p2002("Order", ["orderNumber"])]) {
    createError = e;
    assert.equal((await send("POST", "/", NEW)).status, 500);
  }
  updateError = new Error("deadlock");
  assert.equal((await send("PUT", "/c1", { contactEmail: "x@example.com" })).status, 500);
});

test("without a conflict the request still succeeds", async () => {
  createError = null;
  updateError = null;
  attemptedCreates = 0;
  assert.equal((await send("POST", "/", NEW)).status, 201);
  assert.equal(attemptedCreates, 1);
  assert.equal((await send("PUT", "/c1", { contactEmail: "new@example.com" })).status, 200);
});
