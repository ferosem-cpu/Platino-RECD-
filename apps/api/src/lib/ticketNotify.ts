import type { Prisma } from "@prisma/client";
import { COMPLAINT_EVENT, ROLE_KEY } from "@recd/shared";
import { prisma } from "./prisma";
import { logComplaintEvent } from "./ticketEvents";
import { send as sendNotification } from "../services/notifications/notificationService";

type Audience = "raised" | "regional" | "management";

/** Active users who should hear about a ticket, by audience. Ids are de-duplicated. */
export async function ticketRecipients(
  audience: Audience,
  opts: { regionId?: string | null; assignedToId?: string | null },
): Promise<string[]> {
  // Existing ticket alerts go to the region's REGIONAL Managers only. Service Managers mapped to a region (Requirement 6) are
  // reached by the reminder process (lib/reminders.ts); this keeps the ticket-age escalation exactly as it was.
  const regionManagers = opts.regionId ? [{ regionsManaged: { some: { regionId: opts.regionId } }, role: { key: ROLE_KEY.REGIONAL_MANAGER } }] : [];
  let where: Prisma.UserWhereInput;
  if (audience === "raised") {
    where = {
      OR: [
        { role: { key: { in: [ROLE_KEY.SERVICE_TEAM, ROLE_KEY.SERVICE_MANAGER, ROLE_KEY.MANAGEMENT] } } },
        ...regionManagers,
        ...(opts.assignedToId ? [{ id: opts.assignedToId }] : []),
      ],
    };
  } else if (audience === "regional") {
    // Regional Managers of the site's region; if the site has no region (or no manager),
    // fall back to the Service Managers so the alert is never dropped.
    const rms = regionManagers.length
      ? await prisma.user.findMany({ where: { isActive: true, OR: regionManagers }, select: { id: true } })
      : [];
    if (rms.length) return rms.map((u: { id: string }) => u.id);
    where = { role: { key: ROLE_KEY.SERVICE_MANAGER } };
  } else {
    where = { role: { key: { in: [ROLE_KEY.MANAGEMENT, ROLE_KEY.OWNER_ADMIN] } } };
  }
  const users = await prisma.user.findMany({ where: { isActive: true, ...where }, select: { id: true } });
  return Array.from(new Set<string>(users.map((u: { id: string }) => u.id)));
}

/** Best-effort fan-out: a provider failure never rolls back the committed write. */
export async function notifyMany(
  recipientIds: string[],
  templateKey: string,
  data: Record<string, unknown>,
): Promise<void> {
  await Promise.all(
    recipientIds.map((recipientId) =>
      sendNotification({ recipientId, templateKey, data }).catch((err) => console.error("Notification failed", err)),
    ),
  );
}

export type RegionalGap = "site_has_no_region" | "region_has_no_regional_manager";

/**
 * Why no Regional Manager can be told about a ticket (null = there is at least one active Regional Manager mapped to its region).
 * The business rule for a site WITHOUT a region is not specified; nothing is assigned or guessed - the ticket still reaches the Service
 * Team / Service Managers / Management and the gap is written to its history so someone can fix the site's region.
 */
export async function regionalManagerGap(regionId: string | null | undefined): Promise<RegionalGap | null> {
  if (!regionId) return "site_has_no_region";
  const n = await prisma.user.count({ where: { isActive: true, role: { key: ROLE_KEY.REGIONAL_MANAGER }, regionsManaged: { some: { regionId } } } });
  return n === 0 ? "region_has_no_regional_manager" : null;
}

/**
 * Tells the ticket's audience that it was raised (portal and public flow share this) and surfaces any gap: no Regional Manager for the
 * region, or nobody at all. Never throws - the ticket is already committed.
 */
export async function notifyTicketRaised(args: { complaintId: string; regionId: string | null | undefined; data: Record<string, unknown> }): Promise<void> {
  try {
    const recipients = await ticketRecipients("raised", { regionId: args.regionId });
    const gap = await regionalManagerGap(args.regionId);
    if (gap || recipients.length === 0) {
      await logComplaintEvent({
        complaintId: args.complaintId,
        type: COMPLAINT_EVENT.NOTIFICATION_GAP,
        actorLabel: "System (notifications)",
        detail: { event: "raised", reason: recipients.length === 0 ? "no_recipients" : gap, recipients: recipients.length },
      });
    }
    await notifyMany(recipients, "complaint_raised", args.data);
  } catch (err) {
    console.error("Ticket-raised notification failed", err);
  }
}
