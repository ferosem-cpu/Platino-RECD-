import type { Request, Response, NextFunction } from "express";

/**
 * Minimal fixed-window rate limiter for the unauthenticated auth endpoints (login, OTP request
 * and verify) so passwords and 6-digit OTP codes can't be brute-forced without limit.
 *
 * Deliberately dependency-free and in-memory: on a single long-running server this is effective;
 * on serverless (Vercel) the store is per-instance so it caps a single warm instance rather than
 * the whole fleet. For a hard, fleet-wide guarantee move this to a shared store (Redis/Upstash) or
 * put it behind the platform WAF - but even the in-memory form removes the "unlimited attempts"
 * hole documented in the audit.
 */
interface Hit {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Hit>();

export function rateLimit(options: { windowMs: number; max: number; keyPrefix: string }) {
  const { windowMs, max, keyPrefix } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    existing.count += 1;
    if (existing.count > max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }
    next();
  };
}

// Opportunistically drop expired buckets so the map can't grow unbounded on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of buckets) {
    if (hit.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref?.();
