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
