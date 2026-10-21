import { createHmac } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

/**
 * Fixed-window per-IP rate limiter for the unauthenticated endpoints (login, OTP request and verify, public complaints), so passwords and
 * 6-digit OTP codes can't be brute-forced without limit.
 *
 * The count is kept in PostgreSQL (table IpRateLimit) with ONE atomic upsert-and-increment per request, so every API instance and every
 * restart shares the same counters and concurrent requests cannot slip past the threshold. The key is an HMAC of "<limiter>:<client address>",
 * so raw addresses are never stored. The client address is `req.ip`, which Express derives from X-Forwarded-For ONLY for proxies named by
 * TRUST_PROXY (see lib/proxyConfig.ts) - a spoofed header from an ordinary client is ignored.
 *
 * If the database cannot be reached the limiter does NOT switch itself off: it falls back to a per-process in-memory counter (the previous
 * behaviour), so protection is reduced to one instance rather than removed.
 */
interface Hit {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Hit>();

function memoryHit(key: string, windowMs: number, now: number): Hit {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

const keyHash = (limiter: string, ip: string) => createHmac("sha256", process.env.JWT_SECRET ?? "").update(`ip-rate-limit:${limiter}:${ip}`).digest("hex");

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;
const PURGE_SAMPLE = 0.01;

/** Counts this request in the shared store. `shared` is false when the database was unavailable and the in-process counter was used. */
export async function countRequest(limiter: string, ip: string, windowMs: number, now = Date.now()): Promise<Hit & { shared: boolean }> {
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  try {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "IpRateLimit" ("keyHash", "windowStart", "count") VALUES (${keyHash(limiter, ip)}, ${windowStart}, 1)
      ON CONFLICT ("keyHash", "windowStart") DO UPDATE SET "count" = "IpRateLimit"."count" + 1
      RETURNING "count"`;
    const count = Number(rows[0]?.count);
    if (!Number.isFinite(count)) throw new Error("unexpected rate-limit result");
    if (Math.random() < PURGE_SAMPLE) {
      prisma.ipRateLimit.deleteMany({ where: { windowStart: { lt: new Date(now - PURGE_AFTER_MS) } } }).catch(() => undefined);
    }
    return { count, resetAt: windowStart.getTime() + windowMs, shared: true };
  } catch {
    // Deliberately no address in the log line.
    console.warn("Rate-limit store unavailable; using the per-process limiter for this request");
    return { ...memoryHit(`${limiter}:${ip}`, windowMs, now), shared: false };
  }
}

export function rateLimit(options: { windowMs: number; max: number; keyPrefix: string }) {
  const { windowMs, max, keyPrefix } = options;
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const hit = await countRequest(keyPrefix, ip, windowMs, now);
    if (hit.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((hit.resetAt - now) / 1000))));
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }
    next();
  };
}

// Opportunistically drop expired in-process buckets so the fallback map can't grow unbounded on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of buckets) {
    if (hit.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref?.();
