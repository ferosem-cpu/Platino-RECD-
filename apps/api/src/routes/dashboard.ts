import { Router } from "express";
import { PERMISSION_KEY, COMPLAINT_STATUS, SITC_PHASE } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission } from "../middleware/auth";

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

/** Owner/Admin and Management only. Lean Phase 1 dashboard: counts, not the fuller revenue/drill-down version. */
dashboardRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_DASHBOARD), async (_req, res) => {
  const sites = await prisma.site.findMany({ include: { currentStage: true } });
  const sitesByPhase: Record<string, number> = Object.fromEntries(Object.values(SITC_PHASE).map((p) => [p, 0]));
  for (const site of sites) sitesByPhase[site.currentStage.phase] += 1;

  const grouped = await prisma.complaint.groupBy({ by: ["status"], _count: { _all: true } });
  const complaintsByStatus: Record<string, number> = Object.fromEntries(
    Object.values(COMPLAINT_STATUS).map((s) => [s, 0]),
  );
  for (const row of grouped) complaintsByStatus[row.status] = row._count._all;

  res.json({ sitesByPhase, complaintsByStatus });
});
