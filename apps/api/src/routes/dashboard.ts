import { Router } from "express";
import { PERMISSION_KEY, COMPLAINT_STATUS, ROLE_KEY, SITC_PHASE } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { asOptionalString } from "../lib/params";
import { managedRegionIds } from "../lib/regions";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

/**
 * Lean Phase 1 dashboard: counts, not the fuller revenue/drill-down version.
 *
 * Scope (decided here, in the data queries - the screen is never the protection):
 *  - Regional Manager (the approved "Zonal Manager"): only the regions mapped to them, exactly like their site and ticket lists. A manager with no
 *    mapped region sees zero everywhere (never the company-wide figures). A ticket without a site belongs to no region, so it is not counted for them.
 *  - Super Admin, Owner/Admin, Management and every other role holding the dashboard permission: company-wide, as before.
 *  - `?regionId=` narrows the figures to one region for anyone, but can only ever INTERSECT with the caller's own scope: a Regional Manager asking
 *    for a region that is not theirs gets zero, not that region's numbers.
 */
dashboardRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_DASHBOARD), async (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  let regionIds: string[] | null = null; // null = unrestricted
  if (!auth.customerId && !auth.vendorId && auth.roleKey === ROLE_KEY.REGIONAL_MANAGER) regionIds = await managedRegionIds(auth.userId, auth.roleKey);
  const requested = asOptionalString(req.query.regionId);
  if (requested) regionIds = regionIds ? regionIds.filter((r) => r === requested) : [requested];

  const siteWhere = regionIds ? { regionId: { in: regionIds } } : {};
  const complaintWhere = { archivedAt: null, ...(regionIds ? { site: { regionId: { in: regionIds } } } : {}) };

  const sites = await prisma.site.findMany({ where: siteWhere, include: { currentStage: true } });
  const sitesByPhase: Record<string, number> = Object.fromEntries(Object.values(SITC_PHASE).map((p) => [p, 0]));
  for (const site of sites) sitesByPhase[site.currentStage.phase] += 1;

  const grouped = await prisma.complaint.groupBy({ by: ["status"], where: complaintWhere, _count: { _all: true } });
  const complaintsByStatus: Record<string, number> = Object.fromEntries(
    Object.values(COMPLAINT_STATUS).map((s) => [s, 0]),
  );
  for (const row of grouped) complaintsByStatus[row.status] = row._count._all;

  res.json({ sitesByPhase, complaintsByStatus });
});
