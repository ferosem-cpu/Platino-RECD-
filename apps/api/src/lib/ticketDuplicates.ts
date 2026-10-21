/**
 * The duplicate-ticket rule in ONE place (Requirement 11: "prevent duplicate tickets for the same issue").
 * Definition (unchanged from the existing application): a ticket is ACTIVE while it is not resolved / closed and not archived.
 *  - a ticket about a RECD unit: at most one active ticket per unit (partial unique index Complaint_one_open_per_unit);
 *  - a ticket with NO unit (a site with no eligible unit): at most one active unit-less ticket per site (partial unique index
 *    Complaint_one_open_per_site_without_unit). This is exactly what the portal's application-side check always did; the index makes it
 *    hold under simultaneous requests.
 * The application checks give a friendly message; the indexes are the guarantee.
 */
import { TICKET_CLOSED_STATUSES } from "@recd/shared";
import type { Prisma } from "@prisma/client";
import { isViolationOn } from "./uniqueViolations";

type Db = Pick<Prisma.TransactionClient, "complaint">;

/** The active ticket (if any) that would collide with a ticket for this unit / site. `excludeId` = the ticket being reopened / restored. */
export async function findBlockingActiveTicket(
  db: Db,
  target: { unitId: string | null; siteId: string | null },
  excludeId?: string,
): Promise<{ id: string; ticketNumber: string } | null> {
  const base = { status: { notIn: [...TICKET_CLOSED_STATUSES] }, archivedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) };
  if (target.unitId) return db.complaint.findFirst({ where: { ...base, unitId: target.unitId }, select: { id: true, ticketNumber: true } });
  if (target.siteId) return db.complaint.findFirst({ where: { ...base, siteId: target.siteId }, select: { id: true, ticketNumber: true } });
  return null;
}

/** A unique violation raised by EITHER duplicate-ticket index. */
export const isActiveTicketConflict = (err: unknown) => isViolationOn(err, "Complaint", "unitId") || isViolationOn(err, "Complaint", "siteId");
