// Server-side forced password change (Requirement 3). No database: the User delegate is a small in-memory store. The REAL authentication
// middleware and the REAL auth router run over HTTP; a throwaway route stands in for "any other protected API route".
// What it proves: an account flagged mustChangePassword cannot use the API with a perfectly valid token - the boundary is the server, not the
// web AuthGuard - except for the two routes needed to complete the change, and the change clears the flag and revokes older tokens.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import bcrypt from "bcryptjs";
import { createFakeRateLimitStore } from "./helpers/fakeRateLimitStore";

/* eslint-disable @typescript-eslint/no-explicit-any */
const PASSWORD = "Temp-Passw0rd!";
const NEW_PASSWORD = "Brand-New-Passw0rd!";
const HASH = bcrypt.hashSync(PASSWORD, 4);

interface Row { id: string; email: string; roleKey: string; isActive: boolean; tokenVersion: number; passwordHash: string; mustChangePassword: boolean; customerId: string | null; vendorId: string | null }
let user: Row;
const updates: any[] = [];
let server: Server;
let base = "";
let signToken: (p: any) => string;
let verifyToken: (t: string) => any;
const tokenFor = (u: Row = user) => signToken({ userId: u.id, roleKey: u.roleKey, customerId: u.customerId, tokenVersion: u.tokenVersion });
const consoleWarn = console.warn;

before(async () => {
  console.warn = () => undefined;
  const { prisma } = await import("../src/lib/prisma");
  createFakeRateLimitStore().install(prisma);
  ({ signToken, verifyToken } = await import("../src/lib/jwt"));
  const { authenticate, requirePermission } = await import("../src/middleware/auth");
  const { authRouter } = await import("../src/routes/auth");
  const view = (u: Row) => ({ ...u, role: { key: u.roleKey, name: u.roleKey, permissions: [{ permission: { key: "manage_users" } }] } });
  Object.defineProperty(prisma, "user", {
    configurable: true,
    get: () => ({
      findUnique: async ({ where }: any) => (user && where.id === user.id ? view(user) : null),
      findFirst: async ({ where }: any) => (user && where?.email?.equals?.toLowerCase() === user.email ? view(user) : null),
      update: async ({ where, data }: any) => {
        updates.push({ where, data });
        for (const [k, v] of Object.entries<any>(data)) (user as any)[k] = v && typeof v === "object" && "increment" in v ? (user as any)[k] + v.increment : v;
        return view(user);
      },
    }),
  });
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  // Stands in for any ordinary protected route (read and write verbs).
  app.get("/protected", authenticate, (_q, res) => res.json({ ok: true }));
  app.post("/protected", authenticate, requirePermission("manage_users"), (_q, res) => res.json({ ok: true }));
  app.delete("/protected", authenticate, (_q, res) => res.json({ ok: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server?.close(); console.warn = consoleWarn; });

beforeEach(() => {
  updates.length = 0;
  user = { id: "u1", email: "forced@example.test", roleKey: "service_engineer", isActive: true, tokenVersion: 3, passwordHash: HASH, mustChangePassword: true, customerId: null, vendorId: null };
});

async function call(method: string, p: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text };
}

test("a VALID token for an account that must change its password is refused on ordinary routes with PASSWORD_CHANGE_REQUIRED", async () => {
  const token = tokenFor();
  for (const [method, p] of [["GET", "/protected"], ["POST", "/protected"], ["DELETE", "/protected"]] as const) {
    const r = await call(method, p, token, method === "POST" ? {} : undefined);
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.body.code, "PASSWORD_CHANGE_REQUIRED");
    assert.ok(!/token|hash|secret/i.test(r.body.error), "non-sensitive wording");
  }
});

test("the flag is read from the database on every request, never from the token: a token issued BEFORE the flag was set is refused too", async () => {
  user.mustChangePassword = false;
  const token = tokenFor();
  assert.equal((await call("GET", "/protected", token)).status, 200);
  user.mustChangePassword = true;
  assert.equal((await call("GET", "/protected", token)).body.code, "PASSWORD_CHANGE_REQUIRED");
});

test("an ordinary account (flag clear) is not affected", async () => {
  user.mustChangePassword = false;
  assert.equal((await call("GET", "/protected", tokenFor())).status, 200);
  assert.equal((await call("POST", "/protected", tokenFor(), {})).status, 200);
});

test("GET /auth/me stays available so the app can show the password-change screen, and it reports the flag", async () => {
  const r = await call("GET", "/auth/me", tokenFor());
  assert.equal(r.status, 200);
  assert.equal(r.body.mustChangePassword, true);
  assert.equal(r.body.id, "u1");
});

test("the /auth/me exemption does not permit anything else under /auth, or any mutation", async () => {
  const token = tokenFor();
  assert.equal((await call("POST", "/auth/me", token, {})).status, 404);
  assert.equal((await call("DELETE", "/auth/me", token)).status, 404);
  assert.equal((await call("GET", "/auth/change-password", token)).status, 404);
  assert.equal(updates.length, 0, "nothing was written");
});

test("the exempt routes still run every other check: no token, a garbage token, a stale tokenVersion and a deactivated account are all refused", async () => {
  assert.equal((await call("GET", "/auth/me", null)).status, 401);
  assert.equal((await call("GET", "/auth/me", "not-a-token")).status, 401);
  const stale = tokenFor();
  user.tokenVersion += 1;
  assert.equal((await call("GET", "/auth/me", stale)).status, 401, "old tokenVersion");
  assert.equal((await call("POST", "/auth/change-password", stale, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401);
  const fresh = tokenFor();
  user.isActive = false;
  assert.equal((await call("GET", "/auth/me", fresh)).status, 401, "inactive");
  assert.equal((await call("POST", "/auth/change-password", fresh, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401);
  assert.equal(updates.length, 0);
});

test("a failed password change (wrong current password, weak new password) changes nothing: the flag stays, no new token is issued", async () => {
  const token = tokenFor();
  const wrong = await call("POST", "/auth/change-password", token, { currentPassword: "Nope-Nope-1", newPassword: NEW_PASSWORD });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.token, undefined);
  const weak = await call("POST", "/auth/change-password", token, { currentPassword: PASSWORD, newPassword: "short" });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.token, undefined);
  assert.equal(updates.length, 0);
  assert.equal(user.mustChangePassword, true);
  assert.equal((await call("GET", "/protected", token)).body.code, "PASSWORD_CHANGE_REQUIRED");
});

test("the permitted flow: change password -> flag cleared, new bcrypt hash stored, tokenVersion bumped, OLD token rejected, NEW token works", async () => {
  const old = tokenFor();
  const r = await call("POST", "/auth/change-password", old, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(updates.length, 1);
  assert.equal(user.mustChangePassword, false);
  assert.equal(user.tokenVersion, 4);
  assert.notEqual(user.passwordHash, HASH);
  assert.ok(user.passwordHash.startsWith("$2"), "stored as a bcrypt hash");
  assert.ok(await bcrypt.compare(NEW_PASSWORD, user.passwordHash));
  assert.ok(!r.raw.includes(NEW_PASSWORD) && !r.raw.includes(user.passwordHash), "the response carries neither password nor hash");
  assert.equal(verifyToken(r.body.token).tv, 4, "the fresh token carries the CURRENT token version");

  assert.equal((await call("GET", "/protected", old)).status, 401, "the pre-change token is revoked");
  assert.equal((await call("GET", "/auth/me", old)).status, 401);
  assert.equal((await call("GET", "/protected", r.body.token)).status, 200, "the fresh token reaches ordinary routes");
});

test("password login for a flagged account issues a token, but that token cannot reach ordinary routes until the password is changed", async () => {
  const login = await call("POST", "/auth/login", null, { email: user.email, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal((await call("GET", "/protected", login.body.token)).body.code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal((await call("GET", "/auth/me", login.body.token)).status, 200);
});

test("every router uses the strict `authenticate`; only the two password-change routes in auth.ts use the permissive variant", () => {
  const routesDir = path.resolve(__dirname, "../src/routes");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const offenders: string[] = [];
  for (const f of fs.readdirSync(routesDir).filter((n) => n.endsWith(".ts"))) {
    const src = strip(fs.readFileSync(path.join(routesDir, f), "utf8"));
    if (/authenticateAllowingPasswordChange/.test(src) && f !== "auth.ts") offenders.push(f);
    assert.ok(!/verifyToken\s*\(/.test(src), `${f} must not verify tokens itself`);
  }
  assert.deepEqual(offenders, []);
  const auth = strip(fs.readFileSync(path.join(routesDir, "auth.ts"), "utf8"));
  const uses = [...auth.matchAll(/authRouter\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*authenticateAllowingPasswordChange/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(uses, ["get /me", "post /change-password"]);
  assert.ok(!/[^\w]authenticate\b/.test(auth.replace(/authenticateAllowingPasswordChange/g, "")), "auth.ts has no other authenticated routes");
});
