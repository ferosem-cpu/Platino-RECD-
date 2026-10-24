import { recdSerialSchema } from "@recd/shared";
import { prisma } from "./prisma";

/** Returns the already-registered serials among `serials` (serials are globally unique). */
export async function findTakenSerials(serials: string[]): Promise<string[]> {
  if (!serials.length) return [];
  const rows = await prisma.recdUnit.findMany({ where: { serialNo: { in: serials } }, select: { serialNo: true } });
  return rows.map((r) => r.serialNo!).filter(Boolean);
}

export function takenSerialsMessage(taken: string[]): string {
  return `Serial number already registered: ${taken.join(", ")}`;
}

/**
 * Validates a loosely-typed serial list (e.g. from an AI tool call): exactly `quantity`
 * distinct, well-formed serials. Returns the normalised (upper-case) serials or a message.
 */
export function parseSerialList(raw: unknown, quantity: number): { serials: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `recdSerials is required: ${quantity} RECD serial number(s), one per unit. Ask the user for them - never invent serials.` };
  }
  const serials: string[] = [];
  for (const value of raw) {
    const parsed = recdSerialSchema.safeParse(value);
    if (!parsed.success) return { error: `Invalid serial number "${String(value)}": ${parsed.error.issues[0]?.message ?? "invalid"}` };
    serials.push(parsed.data);
  }
  if (serials.length !== quantity) return { error: `Enter ${quantity} RECD serial number(s) - one per unit (got ${serials.length}).` };
  if (new Set(serials).size !== serials.length) return { error: "Duplicate serial numbers in this order." };
  return { serials };
}
