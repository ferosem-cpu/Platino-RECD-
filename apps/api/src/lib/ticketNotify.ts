import type { Prisma } from "@prisma/client";
import { ROLE_KEY } from "@recd/shared";
import { prisma } from "./prisma";
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
