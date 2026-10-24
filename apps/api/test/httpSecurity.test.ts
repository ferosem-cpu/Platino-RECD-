// CORS allowlist and security headers (src/lib/httpSecurity.ts), exercised both on a small app and on the real app exported by src/index.ts.
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"; // unreachable on purpose
process.env.DIRECT_URL = process.env.DATABASE_URL;

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import cors from "cors";
import { buildCorsOptions, normalizeOrigin, parseAllowedOrigins, scrubSecretKeysFromJson, securityHeaders, DEV_ALLOWED_ORIGINS } from "../src/lib/httpSecurity";

const ADMIN = "https://admin.platino.example";
const OTHER = "https://other.platino.example";
const EVIL = "https://evil.example";

// ---- parsing -------------------------------------------------------------------------------------------------------------------------

test("origins: normalised to scheme://host[:port]; wildcard, 'null', non-http(s) and garbage entries are refused and reported", () => {
  assert.equal(normalizeOrigin("https://App.Example.com/"), "https://app.example.com");
  assert.equal(normalizeOrigin("https://app.example.com/some/path?q=1"), "https://app.example.com");
  assert.equal(normalizeOrigin("http://localhost:3000"), "http://localhost:3000");
  for (const bad of ["*", "null", "", "   ", "ftp://x.example", "javascript:alert(1)", "not a url", "https://user:pw@x.example"]) assert.equal(normalizeOrigin(bad), null, JSON.stringify(bad));

  const parsed = parseAllowedOrigins({ NODE_ENV: "production", ADMIN_WEB_URL: `${ADMIN}/`, CORS_ALLOWED_ORIGINS: `${OTHER}, *, not a url, ftp://x.example` } as NodeJS.ProcessEnv);
  assert.deepEqual([...parsed.origins].sort(), [ADMIN, OTHER].sort());
  assert.equal(parsed.problems.length, 3, "one report per refused entry");
  assert.equal(parsed.problems.some((p) => p.includes("pw@")), false, "reports never echo credentials");
});

test("origins: local development origins are allowed only outside production and hosted platforms", () => {
  const dev = parseAllowedOrigins({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  for (const o of DEV_ALLOWED_ORIGINS) assert.equal(dev.origins.has(o), true, o);
  assert.deepEqual(dev.problems, []);
  for (const env of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { NODE_ENV: "development", VERCEL: "1" }] as NodeJS.ProcessEnv[]) {
    const p = parseAllowedOrigins(env);
    for (const o of DEV_ALLOWED_ORIGINS) assert.equal(p.origins.has(o), false, `${JSON.stringify(env)} must not allow ${o}`);
  }
});

test("origins: missing configuration in production fails closed (nothing trusted) and says so", () => {
  const p = parseAllowedOrigins({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(p.origins.size, 0);
  assert.equal(p.problems.length, 1);
  assert.match(p.problems[0], /ADMIN_WEB_URL/);
});

// ---- behaviour on a real HTTP server -------------------------------------------------------------------------------------------------

let server: Server;
let base = "";
let realServer: Server;
let realBase = "";

before(async () => {
  const allowed = parseAllowedOrigins({ NODE_ENV: "production", ADMIN_WEB_URL: ADMIN, CORS_ALLOWED_ORIGINS: OTHER } as NodeJS.ProcessEnv);
  const app = express();
  app.use(securityHeaders());
  app.use(cors(buildCorsOptions(allowed)));
  app.use(scrubSecretKeysFromJson());
  app.get("/data", (_q, res) => res.json({ ok: true }));
  app.get("/boom", () => { throw new Error("boom"); });
  app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "Internal server error" }); });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The REAL application: src/index.ts. NODE_ENV=production + VERCEL stops it from calling listen(); its CORS env is set explicitly
  // (dotenv never overrides variables that are already set).
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1";
  process.env.ADMIN_WEB_URL = ADMIN;
  process.env.CORS_ALLOWED_ORIGINS = OTHER;
  const warn = console.warn;
  console.warn = () => {}; // the app warns about TRUST_PROXY on a hosted platform; irrelevant here
  const mod = await import("../src/index");
  console.warn = warn;
  await new Promise<void>((resolve) => { realServer = mod.default.listen(0, "127.0.0.1", resolve); });
  realBase = `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;
});
after(() => { server?.close(); realServer?.close(); });

for (const [label, getBase] of [["small app", () => base], ["real app (src/index.ts)", () => realBase]] as const) {
  const path = label === "small app" ? "/data" : "/health";

  test(`CORS [${label}]: an allowed origin is echoed back (never *), a disallowed one gets no CORS headers`, async () => {
    for (const origin of [ADMIN, OTHER]) {
      const r = await fetch(`${getBase()}${path}`, { headers: { Origin: origin } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("access-control-allow-origin"), origin);
      assert.match(r.headers.get("vary") ?? "", /Origin/i);
      assert.equal(r.headers.get("access-control-allow-credentials"), null, "no credentialed CORS");
    }
    const evil = await fetch(`${getBase()}${path}`, { headers: { Origin: EVIL } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    // lookalikes and scheme / port variants of an allowed origin are different origins
    for (const origin of [`${ADMIN}.evil.example`, ADMIN.replace("https", "http"), `${ADMIN}:8443`, "null"]) {
      const r = await fetch(`${getBase()}${path}`, { headers: { Origin: origin } });
      assert.equal(r.headers.get("access-control-allow-origin"), null, origin);
    }
  });

  test(`CORS [${label}]: preflight is answered for allowed origins only, with just the methods and headers the apps use`, async () => {
    const ok = await fetch(`${getBase()}${path}`, { method: "OPTIONS", headers: { Origin: ADMIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), ADMIN);
    assert.match(ok.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match((ok.headers.get("access-control-allow-headers") ?? "").toLowerCase(), /authorization/);
    assert.match((ok.headers.get("access-control-allow-headers") ?? "").toLowerCase(), /content-type/);

    const bad = await fetch(`${getBase()}${path}`, { method: "OPTIONS", headers: { Origin: EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
    assert.equal(bad.headers.get("access-control-allow-methods"), null);
  });

  test(`CORS [${label}]: a request with no Origin header (mobile app, cron, server-to-server) is unaffected`, async () => {
    const r = await fetch(`${getBase()}${path}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });

  test(`security headers [${label}]: present on ordinary, preflight and refused-origin responses`, async () => {
    const responses = [
      await fetch(`${getBase()}${path}`),
      await fetch(`${getBase()}${path}`, { method: "OPTIONS", headers: { Origin: ADMIN, "Access-Control-Request-Method": "GET" } }),
      await fetch(`${getBase()}${path}`, { headers: { Origin: EVIL } }),
    ];
    for (const r of responses) {
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("x-powered-by"), null, "framework banner removed");
      assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
      const csp = r.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      // the one deliberate relaxation: the admin web app (another origin) must be able to read API responses; CORS decides who
      assert.equal(r.headers.get("cross-origin-resource-policy"), "cross-origin");
    }
  });
}

test("JSON responses are unchanged by the hardening, and an error response still carries the headers", async () => {
  const ok = await fetch(`${base}/data`, { headers: { Origin: ADMIN } });
  assert.deepEqual(await ok.json(), { ok: true });
  assert.match(ok.headers.get("content-type") ?? "", /application\/json/);
  const err = await fetch(`${base}/boom`);
  assert.equal(err.status, 500);
  assert.equal(err.headers.get("x-content-type-options"), "nosniff");
});

test("CORS is not authentication: an allowed origin without a token still gets 401 from a protected route of the real app", async () => {
  for (const path of ["/sites", "/orders", "/customers", "/users", "/pending-actions"]) {
    const r = await fetch(`${realBase}${path}`, { headers: { Origin: ADMIN } });
    assert.equal(r.status, 401, path);
  }
});
