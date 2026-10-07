import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import type { UserAuditAction } from "@recd/shared";

/**
 * Appends one row to the user-administration audit trail. Never throws: a failed audit
 * write must not roll back (or mask) the admin action it describes - it is logged instead.
 * Never pass password material in `changes`.
 */
export async function logUserAudit(
  actorId: string | null,
  targetUserId: string,
  action: UserAuditAction,
  changes?: Record<string, unknown>,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  try {
    await client.userAuditLog.create({
      data: { actorId, targetUserId, action, changes: (changes ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  } catch (err) {
    console.error("User audit write failed", err);
  }
}

/** Shallow before/after diff of the named fields; returns null when nothing changed. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: T, fields: (keyof T)[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (before[f] !== after[f]) out[String(f)] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return Object.keys(out).length ? out : null;
}
