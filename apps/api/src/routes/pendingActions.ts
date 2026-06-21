import { Router } from "express";
import { resolvePendingActionSchema, PERMISSION_KEY, PENDING_ACTION_CATEGORY, EXHAUST_HOOKUP_TYPE } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";
import { asString } from "../lib/params";

export const pendingActionsRouter = Router();
pendingActionsRouter.use(authenticate);

pendingActionsRouter.get("/", requirePermission(PERMISSION_KEY.RESOLVE_PENDING_ACTION), async (req: AuthenticatedRequest, res) => {
  const where = req.auth!.customerId
    ? { status: "open", site: { order: { customerId: req.auth!.customerId } } }
    : { status: "open" };
  const actions = await prisma.pendingAction.findMany({
    where,
    include: { site: { include: { order: { include: { customer: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(actions);
});

/**
 * Generic resolve endpoint. The one category with special handling today is
 * customer_approval for the exhaust hookup decision (see project notes) -
 * resolving it writes the decision back onto Site.confirmedExhaustHookupType.
 * Other categories just record the resolution text for now.
 */
pendingActionsRouter.post(
  "/:id/resolve",
  requirePermission(PERMISSION_KEY.RESOLVE_PENDING_ACTION),
  async (req: AuthenticatedRequest, res) => {
    const parsed = resolvePendingActionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const action = await prisma.pendingAction.findUnique({ where: { id: asString(req.params.id) }, include: { site: true } });
    if (!action) return res.status(404).json({ error: "Pending action not found" });

    const updated = await prisma.pendingAction.update({
      where: { id: action.id },
      data: { status: "resolved", resolution: parsed.data.resolution, resolvedAt: new Date() },
    });

    if (action.category === PENDING_ACTION_CATEGORY.CUSTOMER_APPROVAL) {
      const confirmedType =
        parsed.data.resolution === "keep_existing"
          ? EXHAUST_HOOKUP_TYPE.ADD_AFTER_EXISTING_EXHAUST
          : EXHAUST_HOOKUP_TYPE.REPLACE_EXISTING_SILENCER;
      await prisma.site.update({ where: { id: action.siteId }, data: { confirmedExhaustHookupType: confirmedType } });

      const site = await prisma.site.findUnique({ where: { id: action.siteId } });
      if (site?.assignedEngineerId) {
        await sendNotification({
          recipientId: site.assignedEngineerId,
          templateKey: "exhaust_hookup_resolved",
          data: { siteId: action.siteId, confirmedType },
        });
      }
    }

    res.json(updated);
  },
);
