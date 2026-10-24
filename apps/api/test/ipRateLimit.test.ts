// Shared per-IP rate limiter and trusted-proxy handling (Requirement 3). No database and no network beyond loopback: the IpRateLimit table is
// replaced by an in-memory stand-in with the same single-statement atomic behaviour (test/helpers/fakeRateLimitStore.ts); the real SQL is run
// against the isolated test database in test/db/ipRateLimit.db.test.ts. The "instances" are separate Express apps in this process that share
// only that store - exactly what separate server instances share in production.
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
import { parseTrustProxy } from "../src/lib/proxyConfig";
import { createFakeRateLimitStore } from "./helpers/fakeRateLimitStore";

/* eslint-disable @typescript-eslint/no-explicit-any */
const store = createFakeRateLimitStore();
const servers: Server[] = [];
const warnings: string[] = [];
const realWarn = console.warn;
let rateLimit: typeof import("../src/middleware/rateLimit").rateLimit;
let countRequest: typeof import("../src/middleware/rateLimit").countRequest;

before(async () => {
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  const { prisma } = await import("../src/lib/prisma");
  store.install(prisma);
  ({ rateLimit, countRequest } = await import("../src/middleware/rateLimit"));
});
after(() => { for (const s of servers) s.close(); console.warn = realWarn; });
beforeEach(() => { store.reset(); warnings.length = 0; });

/** One API "instance": its own Express app and limiter, sharing nothing with the others except the store. */
async function startInstance(opts: { trustProxy?: number | string[] | false; max?: number; windowMs?: number } = {}) {
  const app = express();
  app.set("trust proxy", opts.trustProxy ?? false);
  app.use(rateLimit({ windowMs: opts.windowMs ?? 15 * 60 * 1000, max: opts.max ?? 3, keyPrefix: "test" }));
  app.get("/x", (req, res) => res.json({ ip: req.ip }));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const hitIt = async (base: string, xff?: string) => {
  const res = await fetch(`${base}/x`, { headers: xff ? { "x-forwarded-for": xff } : {} });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as any };
};

test("the limit is enforced, answers 429 with Retry-After, and the first requests pass", async () => {
  const a = await startInstance({ max: 3 });
  assert.deepEqual([(await hitIt(a)).status, (await hitIt(a)).status, (await hitIt(a)).status], [200, 200, 200]);
  const blocked = await hitIt(a);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) >= 1);
  assert.match(blocked.body.error, /Too many attempts/);
});

test("the counters are SHARED: two separate instances count against the same limit", async () => {
  const a = await startInstance({ max: 4 });
  const b = await startInstance({ max: 4 });
  assert.equal((await hitIt(a)).status, 200);
  assert.equal((await hitIt(b)).status, 200);
  assert.equal((await hitIt(a)).status, 200);
  assert.equal((await hitIt(b)).status, 200);
  assert.equal((await hitIt(a)).status, 429, "the fifth request, on either instance, is refused");
  assert.equal((await hitIt(b)).status, 429);
});

test("concurrent requests cannot slip past the threshold, even spread over several instances", async () => {
  const instances = await Promise.all([startInstance({ max: 5 }), startInstance({ max: 5 }), startInstance({ max: 5 })]);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => hitIt(instances[i % 3])));
  assert.equal(results.filter((r) => r.status === 200).length, 5, "exactly the configured number got through");
  assert.equal(results.filter((r) => r.status === 429).length, 25);
});

test("with NO trusted proxy a client cannot choose its identity: every X-Forwarded-For value from the same peer shares one bucket", async () => {
  const a = await startInstance({ max: 3, trustProxy: false });
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) seen.push((await hitIt(a, `203.0.113.${i + 1}`)).status);
  assert.deepEqual(seen, [200, 200, 200, 429, 429, 429]);
  assert.match((await hitIt(a, "198.51.100.7")).body.ip ?? "x", /127\.0\.0\.1|::ffff:127\.0\.0\.1|x/);
});

test("with ONE trusted proxy hop the address comes from that proxy, and entries a client prepends cannot change it", async () => {
  const a = await startInstance({ max: 2, trustProxy: 1 });
  // The proxy appends the real peer; the client controls only what is to the left.
  assert.equal((await hitIt(a, "9.9.9.9, 203.0.113.5")).body.ip, "203.0.113.5");
  assert.equal((await hitIt(a, "1.2.3.4, 203.0.113.5")).status, 200, "a different forged prefix, same real client");
  assert.equal((await hitIt(a, "5.6.7.8, 203.0.113.5")).status, 429, "third request from the same real client is blocked whatever was forged");
  assert.equal((await hitIt(a, "203.0.113.99")).status, 200, "a different real client has its own bucket");
});

test("a trusted-proxy list works too, and untrusted peers are still not believed", async () => {
  const trusted = await startInstance({ max: 5, trustProxy: ["loopback"] });
  assert.equal((await hitIt(trusted, "198.51.100.20")).body.ip, "198.51.100.20");
  const none = await startInstance({ max: 5, trustProxy: ["10.0.0.0/8"] });
  assert.notEqual((await hitIt(none, "198.51.100.20")).body.ip, "198.51.100.20", "loopback is not in the trusted list");
});

test("addresses are never stored: the stored key is a hash that does not contain the address", async () => {
  const a = await startInstance({ max: 3, trustProxy: 1 });
  await hitIt(a, "203.0.113.5");
  const keys = [...store.rows.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[0-9a-f]{64}\|\d+$/);
  assert.ok(!keys[0].includes("203.0.113.5"));
  assert.ok(!warnings.join(" ").includes("203.0.113.5"));
});

test("the limit is per limiter name as well as per address", async () => {
  const now = Date.now();
  await countRequest("auth", "203.0.113.5", 60_000, now);
  const other = await countRequest("public-complaints", "203.0.113.5", 60_000, now);
  assert.equal(other.count, 1);
});

test("windows expire: a new window starts a fresh count, and the old row is left for the purge", async () => {
  const windowMs = 60_000;
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % windowMs); // start of a window
  assert.equal((await countRequest("auth", "203.0.113.5", windowMs, t0 + 1_000)).count, 1);
  assert.equal((await countRequest("auth", "203.0.113.5", windowMs, t0 + 2_000)).count, 2);
  const next = await countRequest("auth", "203.0.113.5", windowMs, t0 + windowMs + 1);
  assert.equal(next.count, 1, "fresh window");
  assert.equal(next.resetAt, t0 + 2 * windowMs);
  assert.equal(store.rows.size, 2);
});

test("if the shared store fails the limiter does NOT switch off: it falls back to a per-process counter and still blocks", async () => {
  store.failing = true;
  const a = await startInstance({ max: 3 });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await hitIt(a)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.ok(warnings.some((w) => /Rate-limit store unavailable/.test(w)));
  assert.ok(!warnings.join(" ").includes("127.0.0.1"), "no address in the log");
  const recovered = await countRequest("recovered", "203.0.113.5", 60_000);
  assert.equal(recovered.shared, false);
  store.failing = false;
  assert.equal((await countRequest("recovered2", "203.0.113.5", 60_000)).shared, true);
});

test("TRUST_PROXY parsing: unset trusts nothing; a hop count or an address list is accepted; 'true' and junk are refused", () => {
  assert.deepEqual(parseTrustProxy(undefined), { setting: false });
  assert.deepEqual(parseTrustProxy(""), { setting: false });
  assert.deepEqual(parseTrustProxy("false"), { setting: false });
  assert.deepEqual(parseTrustProxy("1"), { setting: 1 });
  assert.deepEqual(parseTrustProxy(" 2 "), { setting: 2 });
  assert.deepEqual(parseTrustProxy("loopback, 10.0.0.0/8"), { setting: ["loopback", "10.0.0.0/8"] });
  assert.deepEqual(parseTrustProxy("203.0.113.5"), { setting: ["203.0.113.5"] });
  assert.deepEqual(parseTrustProxy("::1"), { setting: ["::1"] });
  for (const bad of ["true", "yes", "all", "*", "0.0.0.0/0x", "99", "-1", "1; drop table"]) {
    const r = parseTrustProxy(bad);
    assert.equal(r.setting, false, bad);
    assert.ok(r.problem, `${bad} is reported`);
  }
});

test("source: the app wires TRUST_PROXY (never `true`), the IP comes from req.ip, and the configured request limits are unchanged", () => {
  const src = (f: string) =>
    fs.readFileSync(path.resolve(__dirname, "../src", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments removed
  const index = src("index.ts");
  assert.match(index, /parseTrustProxy\(process\.env\.TRUST_PROXY\)/);
  assert.match(index, /app\.set\("trust proxy", trustProxy\.setting\)/);
  assert.doesNotMatch(index, /app\.set\("trust proxy", true\)/);
  assert.match(src("routes/auth.ts"), /rateLimit\(\{ windowMs: 15 \* 60 \* 1000, max: 10, keyPrefix: "auth" \}\)/);
  const pub = src("routes/publicComplaints.ts");
  assert.match(pub, /rateLimit\(\{ windowMs: 15 \* 60 \* 1000, max: 60, keyPrefix: "public-complaints" \}\)/);
  assert.doesNotMatch(pub, /x-forwarded-for/i);
  assert.doesNotMatch(src("middleware/rateLimit.ts"), /x-forwarded-for/i);
});
