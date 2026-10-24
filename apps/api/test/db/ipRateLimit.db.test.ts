/**
 * Real-database tests for the shared per-IP limiter: the single atomic upsert-and-increment statement, concurrency, window expiry and the
 * stored key format, against the actual IpRateLimit table (migration 20261025090000_ip_rate_limit).
 *
 * SAFETY: these tests WRITE rows. They refuse to run unless BOTH DATABASE_URL and DIRECT_URL point at the disposable Docker database
 * (localhost:5434/platino_test). They only create rows in a window far in the past (year 2001, which no real request can use) and remove exactly
 * those rows afterwards. No network call is made; the addresses are documentation-range examples. Run with:
 *   npm run test:db --workspace=apps/api   (database already migrated)
 */
import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";

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
describe("shared IP rate limiter against the real test database", { skip }, () => {
  const WINDOW = 15 * 60 * 1000;
  const BASE = Date.UTC(2001, 0, 1, 0, 0, 0); // a window that cannot collide with real traffic
  const windowStart = new Date(Math.floor(BASE / WINDOW) * WINDOW);
  let prisma: any;
  let countRequest: typeof import("../../src/middleware/rateLimit").countRequest;
  const realWarn = console.warn;

  before(async () => {
    console.warn = () => undefined;
    ({ prisma } = await import("../../src/lib/prisma"));
    ({ countRequest } = await import("../../src/middleware/rateLimit"));
    await prisma.ipRateLimit.deleteMany({ where: { windowStart } });
  });
  after(async () => {
    console.warn = realWarn;
    await prisma.ipRateLimit.deleteMany({ where: { windowStart } });
    const left = await prisma.ipRateLimit.count({ where: { windowStart } });
    assert.equal(left, 0, "test rows removed");
    await prisma.$disconnect();
  });

  test("the statement counts 1, 2, 3 ... for one limiter and address, from the real table", async () => {
    const counts = [];
    for (let i = 0; i < 3; i++) counts.push((await countRequest("db-test-a", "203.0.113.10", WINDOW, BASE + i)).count);
    assert.deepEqual(counts, [1, 2, 3]);
    const hit = await countRequest("db-test-a", "203.0.113.10", WINDOW, BASE + 5);
    assert.equal(hit.shared, true, "answered by the database, not the in-process fallback");
  });

  test("50 concurrent requests are counted exactly: the database hands out 1..50 once each, so none can pass an uncounted", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => countRequest("db-test-b", "203.0.113.11", WINDOW, BASE + 10)));
    assert.ok(results.every((r) => r.shared));
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    assert.deepEqual(counts, Array.from({ length: 50 }, (_, i) => i + 1));
    const stored = await prisma.ipRateLimit.findMany({ where: { windowStart, count: 50 } });
    assert.equal(stored.length, 1);
  });

  test("limiters and addresses are separate, and a new window starts again at 1", async () => {
    assert.equal((await countRequest("db-test-c", "203.0.113.12", WINDOW, BASE + 20)).count, 1);
    assert.equal((await countRequest("db-test-c", "203.0.113.13", WINDOW, BASE + 20)).count, 1, "other address");
    assert.equal((await countRequest("db-test-d", "203.0.113.12", WINDOW, BASE + 20)).count, 1, "other limiter");
    const next = await countRequest("db-test-c", "203.0.113.12", WINDOW, BASE + WINDOW + 20);
    assert.equal(next.count, 1, "next window");
    await prisma.ipRateLimit.deleteMany({ where: { windowStart: new Date(windowStart.getTime() + WINDOW) } });
  });

  test("only a keyed hash is stored - no row contains an address - and the count cannot be negative", async () => {
    const rows = await prisma.ipRateLimit.findMany({ where: { windowStart } });
    assert.ok(rows.length >= 4);
    for (const r of rows) {
      assert.match(r.keyHash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(r).includes("203.0.113"));
    }
    await assert.rejects(() => prisma.ipRateLimit.create({ data: { keyHash: "f".repeat(64), windowStart, count: -1 } }), /check|constraint|violat/i);
  });

  test("a purge of old windows removes only rows older than its cutoff and leaves newer windows alone", async () => {
    const newer = new Date(Date.UTC(2002, 0, 1));
    await prisma.ipRateLimit.create({ data: { keyHash: "e".repeat(64), windowStart, count: 1 } });
    await prisma.ipRateLimit.create({ data: { keyHash: "e".repeat(64), windowStart: newer, count: 1 } });
    const purged = await prisma.ipRateLimit.deleteMany({ where: { windowStart: { lt: new Date(Date.UTC(2001, 6, 1)) }, keyHash: "e".repeat(64) } });
    assert.equal(purged.count, 1);
    assert.equal(await prisma.ipRateLimit.count({ where: { keyHash: "e".repeat(64), windowStart: newer } }), 1);
    await prisma.ipRateLimit.deleteMany({ where: { windowStart: newer } });
  });
});
