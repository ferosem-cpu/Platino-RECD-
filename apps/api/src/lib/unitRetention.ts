import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * A RECD unit is the anchor of its service history, so it is never hard-deleted once anything refers to it. AMC links and warranty history
 * have their own, older checks and messages in the order routes; this covers the remaining references (tickets, service reports, reminders,
 * AMC visits, serial corrections). The database enforces the same rule with RESTRICT foreign keys, so a record created between this check
 * and the delete still stops the delete (see `isUnitHistoryViolation`).
 */
export async function unitHistoryBlockers(
  where: Prisma.RecdUnitWhereInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string[]> {
  const unit = { unit: where };
  const [tickets, reports, reminders, visits, corrections] = await Promise.all([
    client.complaint.count({ where: unit }),
    client.serviceReport.count({ where: unit }),
    client.serviceReminder.count({ where: unit }),
    client.amcVisit.count({ where: unit }),
    client.recdUnitSerialHistory.count({ where: unit }),
  ]);
  const found: string[] = [];
  if (tickets) found.push(`${tickets} service ticket(s)`);
  if (reports) found.push(`${reports} service report(s)`);
  if (reminders) found.push(`${reminders} service reminder(s)`);
  if (visits) found.push(`${visits} AMC visit(s)`);
  if (corrections) found.push("a serial-number correction history");
  return found;
}

export const unitHistoryBlockedMessage = (found: string[], what: "unit" | "order") =>
  `Cannot ${what === "unit" ? "remove this unit" : "delete this order"} - ${what === "unit" ? "it has" : "one of its RECD units has"} ${found.join(", ")}, which are kept as service history.`;

/** True when the database refused a delete because a history row still points at the unit (a foreign-key RESTRICT, Prisma P2003/P2014). */
export function isUnitHistoryViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014");
}
