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
      data: { actorId, targetUserId, targetIdRecorded: targetUserId, action, changes: (changes ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  } catch (err) {
    console.error("User audit write failed", err);
  }
}

/**
 * MANDATORY audit write for a user-administration change: runs on the SAME transaction client as the change and is NOT swallowed - if it
 * fails the whole transaction (the change included) rolls back, so an account can never change without its audit record. Never pass
 * password material, hashes, tokens or OTP codes in `changes`.
 */
export async function logUserAuditStrict(
  tx: Prisma.TransactionClient,
  actorId: string | null,
  targetUserId: string,
  action: UserAuditAction,
  changes?: Record<string, unknown>,
) {
  await tx.userAuditLog.create({
    data: { actorId, targetUserId, targetIdRecorded: targetUserId, action, changes: (changes ?? undefined) as Prisma.InputJsonValue | undefined },
  });
}

/** Shallow before/after diff of the named fields; returns null when nothing changed. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: T, fields: (keyof T)[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (before[f] !== after[f]) out[String(f)] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * MANDATORY audit write for deleting accounts: call it in the SAME transaction, immediately BEFORE the users are deleted. It stamps the
 * display name onto the accounts' existing audit rows and records a "deleted" event; deleting the user then only clears the live link
 * (ON DELETE SET NULL) - the trail itself, with `targetIdRecorded` and `targetName`, stays. Never pass personal data beyond the name.
 */
export async function logAccountsDeletedStrict(
  tx: Prisma.TransactionClient,
  actorId: string | null,
  accounts: { id: string; name: string }[],
  changes?: Record<string, unknown>,
) {
  for (const account of accounts) {
    await tx.userAuditLog.updateMany({
      where: { OR: [{ targetUserId: account.id }, { targetIdRecorded: account.id }] },
      data: { targetName: account.name },
    });
    await tx.userAuditLog.create({
      data: {
        actorId,
        targetUserId: account.id,
        targetIdRecorded: account.id,
        targetName: account.name,
        action: "deleted",
        changes: (changes ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
