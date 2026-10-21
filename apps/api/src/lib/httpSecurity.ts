/**
 * HTTP-level hardening for the API: an explicit CORS allowlist, security response headers, and a last-line scrub of secret keys.
 *
 * CORS is a browser rule, not authentication: every route still authenticates and authorises on its own. The allowlist only decides
 * which web origins a browser may read responses from. Requests with NO Origin header (the mobile app, server-to-server calls, cron) are
 * not browser cross-origin requests and are unaffected.
 */
import type { CorsOptions } from "cors";
import helmet from "helmet";
import type { RequestHandler } from "express";
import { stripSecretKeys } from "./safeSelect";

/** Origins a developer machine needs (Next.js admin-web dev server, Expo web). Only added outside production / hosted platforms. */
export const DEV_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
];

export interface AllowedOrigins {
  origins: ReadonlySet<string>;
  /** Human-readable configuration problems (never include secrets). */
  problems: string[];
}

/** "https://app.example.com/" and "https://app.example.com/path" both become "https://app.example.com"; anything else is rejected. */
export function normalizeOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value || value === "*" || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isHostedOrProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || !!env.VERCEL;
}

/**
 * Allowlist = CORS_ALLOWED_ORIGINS (comma separated) + ADMIN_WEB_URL (the admin web app, already configured for e-mail links)
 * + the local dev origins when NOT in production / on a hosted platform. A wildcard or malformed entry is dropped and reported;
 * an empty allowlist in production simply means no browser origin is trusted (fail closed), with a warning.
 */
export function parseAllowedOrigins(env: NodeJS.ProcessEnv): AllowedOrigins {
  const problems: string[] = [];
  const origins = new Set<string>();
  const entries = [...(env.CORS_ALLOWED_ORIGINS ?? "").split(","), env.ADMIN_WEB_URL ?? ""].map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const origin = normalizeOrigin(entry);
    if (!origin) problems.push(`Ignoring an invalid CORS origin entry (wildcards, "null" and non-http(s) values are refused): ${JSON.stringify(entry.slice(0, 60))}`);
    else origins.add(origin);
  }
  if (!isHostedOrProduction(env)) for (const dev of DEV_ALLOWED_ORIGINS) origins.add(dev);
  if (origins.size === 0 && isHostedOrProduction(env)) {
    problems.push("No CORS origin is configured (set ADMIN_WEB_URL and/or CORS_ALLOWED_ORIGINS): browsers on other origins cannot call this API.");
  }
  return { origins, problems };
}

export function buildCorsOptions(allowed: AllowedOrigins): CorsOptions {
  return {
    origin(origin, callback) {
      // No Origin header = not a cross-origin browser request (mobile app, curl, cron, same-origin): nothing for CORS to decide.
      if (!origin) return callback(null, false);
      // A disallowed origin simply receives no Access-Control-Allow-* headers, so the browser refuses to expose the response.
      callback(null, allowed.origins.has(origin));
    },
    // Authentication is a bearer token in the Authorization header - no cookies, so credentialed CORS is not needed or enabled.
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["X-Total-Count", "Content-Disposition"],
    maxAge: 600,
  };
}

/**
 * Helmet with an API-appropriate policy.
 *  - CSP `default-src 'none'` + `frame-ancestors 'none'`: the API serves JSON, PDFs and images, never an HTML app, so nothing may load or frame.
 *  - Cross-Origin-Resource-Policy `cross-origin` (Helmet's default is same-origin): the admin web app lives on a different origin and
 *    must be able to read these responses; CORS above still decides who that is. This is the one deliberate relaxation.
 *  - HSTS, nosniff, no-referrer, X-Frame-Options and removal of X-Powered-By are Helmet's defaults.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
  });
}

/** Defence in depth: removes password / token-version / OTP / session hashes from any JSON body, whichever route built it. */
export function scrubSecretKeysFromJson(): RequestHandler {
  return (_req, res, next) => {
    const original = res.json.bind(res);
    res.json = (body?: unknown) => original(stripSecretKeys(body));
    next();
  };
}
