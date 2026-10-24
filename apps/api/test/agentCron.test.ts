// Authentication of the conversation-cleanup cron route. The database is replaced by a stub that counts deleteMany calls, so a rejected
// request is shown not to reach the delete at all; no real database and no network beyond loopback are used.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TEST_SECRET = "unit-test-cron-secret";
let deleteCalls: any[] = [];
let server: Server;
let base = "";

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  (prisma as any).agentConversation = { deleteMany: async (args: any) => { deleteCalls.push(args); return { count: 3 }; } };
  const { agentCronRouter } = await import("../src/routes/agentCron");
  const app = express();
  app.use("/agent", agentCronRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); delete process.env.CRON_SECRET; });
beforeEach(() => { deleteCalls = []; delete process.env.CRON_SECRET; });

const call = async (authorization?: string) => {
  const res = await fetch(`${base}/agent/cron/cleanup-conversations`, { headers: authorization ? { authorization } : {} });
  return { status: res.status, body: (await res.json()) as any };
};

test("CRON_SECRET not set: every request is refused and nothing is deleted", async () => {
  for (const header of [undefined, "Bearer ", "Bearer undefined", "Bearer anything", "undefined"]) {
    const r = await call(header);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "Unauthorized" });
  }
  assert.equal(deleteCalls.length, 0);
});

test("CRON_SECRET set to an empty string behaves as not set", async () => {
  process.env.CRON_SECRET = "";
  assert.equal((await call("Bearer ")).status, 401);
  assert.equal((await call()).status, 401);
  assert.equal(deleteCalls.length, 0);
});

test("incorrect or malformed credentials are refused and nothing is deleted", async () => {
  process.env.CRON_SECRET = TEST_SECRET;
  for (const header of [undefined, "", "Bearer wrong", `Bearer ${TEST_SECRET}x`, `Bearer ${TEST_SECRET.slice(0, -1)}`, TEST_SECRET, `bearer ${TEST_SECRET}`, `Bearer  ${TEST_SECRET}`]) {
    assert.equal((await call(header)).status, 401, String(header));
  }
  assert.equal(deleteCalls.length, 0);
});

test("the correct secret runs the cleanup exactly once, deleting only conversations older than 30 days", async () => {
  process.env.CRON_SECRET = TEST_SECRET;
  const before = Date.now();
  const r = await call(`Bearer ${TEST_SECRET}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { deleted: 3 });
  assert.equal(deleteCalls.length, 1);
  const cutoff: Date = deleteCalls[0].where.updatedAt.lt;
  const ageMs = before - cutoff.getTime();
  assert.ok(Math.abs(ageMs - 30 * 24 * 60 * 60 * 1000) < 60_000, "cutoff is 30 days ago");
  assert.deepEqual(Object.keys(deleteCalls[0].where), ["updatedAt"]);
});

test("the response never contains the secret", async () => {
  process.env.CRON_SECRET = TEST_SECRET;
  assert.ok(!JSON.stringify((await call("Bearer wrong")).body).includes(TEST_SECRET));
  assert.ok(!JSON.stringify((await call(`Bearer ${TEST_SECRET}`)).body).includes(TEST_SECRET));
});
