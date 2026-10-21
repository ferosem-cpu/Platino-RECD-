import { prisma } from "./prisma";
import { ROLE_KEY } from "@recd/shared";

export function regionKeyFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Region ids a Regional Manager is mapped to (empty for everyone else / no mapping). */
export async function managedRegionIds(userId: string, roleKey: string): Promise<string[]> {
  if (roleKey !== ROLE_KEY.REGIONAL_MANAGER) return [];
  const rows = await prisma.regionManager.findMany({ where: { userId }, select: { regionId: true } });
  return rows.map((r) => r.regionId);
}

export type ReminderScope = { all: true } | { all: false; regionIds: string[] };

/**
 * Which regions' reminders a user may see on the reminder dashboard (Requirement 6).
 *  - Regional Manager: their mapped regions only (none mapped = nothing).
 *  - Service Manager: their mapped regions when they have any; with no mapping they keep today's desk-wide view.
 *  - everyone else holding the dashboard permission (management, owner, admin ...): all regions.
 * This only scopes the NEW dashboard; ticket access rules elsewhere are unchanged.
 */
export async function reminderScope(userId: string, roleKey: string): Promise<ReminderScope> {
  if (roleKey !== ROLE_KEY.REGIONAL_MANAGER && roleKey !== ROLE_KEY.SERVICE_MANAGER) return { all: true };
  const rows = await prisma.regionManager.findMany({ where: { userId }, select: { regionId: true } });
  const regionIds = rows.map((r) => r.regionId);
  if (roleKey === ROLE_KEY.SERVICE_MANAGER && regionIds.length === 0) return { all: true };
  return { all: false, regionIds };
}
