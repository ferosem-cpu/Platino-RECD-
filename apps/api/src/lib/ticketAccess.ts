/**
 * Who may read or change ONE ticket (Requirement 11). The list already scoped tickets by role; the history followed the same rules; the write
 * routes (PATCH / DELETE / assignment) did not. This is the single rule all of them now use, so a ticket is reachable the same way
 * everywhere:
 *  - a Regional Manager only for tickets on sites in the regions mapped to them (a ticket without a site is out of every region);
 *  - a vendor-scoped user (User.vendorId) only for tickets on that vendor's sites;
 *  - a user without the broad permissions (manage / overview) only for a ticket assigned to them;
 *  - everyone else holding manage_complaints / view_complaints_overview: all tickets, as before.
 * Customers never reach these routes (they hold neither permission); their own tickets are scoped in the list.
 */
import { PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { managedRegionIds } from "./regions";

export interface TicketAuth {
  userId: string;
  roleKey: string;
  vendorId?: string | null;
  permissions: Set<string>;
}

export interface TicketForAccess {
  assignedToId: string | null;
  site: { regionId: string | null; vendorId: string | null } | null;
}

export const OUT_OF_REGION = "This ticket is outside the regions assigned to you";
export const OUT_OF_VENDOR = "This ticket is not on one of your vendor's sites";
export const NOT_ASSIGNED = "This complaint is not assigned to you";

/** null = allowed, otherwise the (non-sensitive) reason for a 403. */
export async function ticketAccessError(auth: TicketAuth, ticket: TicketForAccess): Promise<string | null> {
  const broad = auth.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || auth.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW);
  if (auth.roleKey === ROLE_KEY.REGIONAL_MANAGER) {
    const regions = await managedRegionIds(auth.userId, auth.roleKey);
    if (!ticket.site?.regionId || !regions.includes(ticket.site.regionId)) return OUT_OF_REGION;
  }
  if (auth.vendorId && ticket.site?.vendorId !== auth.vendorId) return OUT_OF_VENDOR;
  if (!broad && ticket.assignedToId !== auth.userId) return NOT_ASSIGNED;
  return null;
}
