import type { Prisma } from "@prisma/client";

/**
 * Serialises concurrent requests that must make a "count what exists, then insert" decision (OTP request limits).
 * Takes transaction-scoped PostgreSQL advisory locks, released automatically at COMMIT / ROLLBACK, so a second request for
 * the same key waits until the first one's row is visible and therefore counted. The lock does not need any row to exist
 * yet, which is what a unique index or a SELECT ... FOR UPDATE cannot offer for the first request of a window.
 *
 * Keys are locked in sorted order, so two requests that share only some keys can never deadlock. Hash collisions between
 * unrelated keys only cause a short, harmless wait.
 */
export async function lockKeys(tx: Prisma.TransactionClient, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}
