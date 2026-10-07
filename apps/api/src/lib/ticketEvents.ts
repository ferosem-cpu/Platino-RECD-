import type { Prisma } from "@prisma/client";
import type { ComplaintEventType } from "@recd/shared";
import { prisma } from "./prisma";

/** Append a history row. Best effort: history must never break the action it records. */
export async function logComplaintEvent(args: {
  complaintId: string;
  type: ComplaintEventType;
  fromValue?: string | null;
  toValue?: string | null;
  actorId?: string | null;
  actorLabel?: string | null;
  detail?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.complaintEvent.create({
      data: {
        complaintId: args.complaintId,
        type: args.type,
        fromValue: args.fromValue ?? null,
        toValue: args.toValue ?? null,
        actorId: args.actorId ?? null,
        actorLabel: args.actorLabel ?? null,
        detail: args.detail,
      },
    });
  } catch (err) {
    console.error("Failed to log complaint event", err);
  }
}
