import { Router } from "express";
import {
  createStageEventSchema,
  confirmExhaustHookupSchema,
  uploadSitePhotoSchema,
  PERMISSION_KEY,
  PENDING_ACTION_CATEGORY,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";
import { asString, asOptionalString } from "../lib/params";

export const sitesRouter = Router();
sitesRouter.use(authenticate);

async function assertSiteVisible(siteId: string, auth: AuthenticatedRequest["auth"]) {
  const site = await prisma.site.findUnique({ where: { id: siteId }, include: { order: true } });
  if (!site) return null;
  if (auth!.customerId && site.order.customerId !== auth!.customerId) return undefined; // not theirs
  return site;
}

sitesRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const assignedToMe = asOptionalString(req.query.assigned_to) === "me";
  const where: Record<string, unknown> = {};
  if (assignedToMe) where.assignedEngineerId = req.auth!.userId;
  if (req.auth!.customerId) where.order = { customerId: req.auth!.customerId };

  const sites = await prisma.site.findMany({
    where,
    include: { order: { include: { customer: true } }, currentStage: true, assignedEngineer: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json(sites);
});

sitesRouter.get("/:id", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const siteId = asString(req.params.id);
  const site = await assertSiteVisible(siteId, req.auth);
  if (site === null) return res.status(404).json({ error: "Site not found" });
  if (site === undefined) return res.status(403).json({ error: "Forbidden" });

  const detail = await prisma.site.findUnique({
    where: { id: siteId },
    include: {
      order: { include: { customer: true, product: true } },
      currentStage: true,
      assignedEngineer: true,
      stageEvents: {
        include: { stageDefinition: true, statusOption: true, createdBy: true },
        orderBy: { createdAt: "asc" },
      },
      photos: { include: { checkpoint: true, uploadedBy: true }, orderBy: { uploadedAt: "asc" } },
      pendingActions: { orderBy: { createdAt: "desc" } },
    },
  });
  res.json(detail);
});

sitesRouter.post(
  "/:id/stage-events",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = createStageEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const site = await prisma.site.findUnique({ where: { id: asString(req.params.id) }, include: { order: true } });
    if (!site) return res.status(404).json({ error: "Site not found" });

    const [event] = await prisma.$transaction([
      prisma.siteStageEvent.create({
        data: {
          siteId: site.id,
          stageDefinitionId: parsed.data.stageDefinitionId,
          statusOptionId: parsed.data.statusOptionId,
          comment: parsed.data.comment,
          photoUrl: parsed.data.photoUrl,
          createdById: req.auth!.userId,
        },
        include: { stageDefinition: true, statusOption: true },
      }),
      prisma.site.update({ where: { id: site.id }, data: { currentStageId: parsed.data.stageDefinitionId } }),
    ]);

    const customerContact = await prisma.user.findFirst({ where: { customerId: site.order.customerId } });
    if (customerContact) {
      await sendNotification({
        recipientId: customerContact.id,
        templateKey: "site_stage_updated",
        data: { stage: event.stageDefinition.label, status: event.statusOption.label, comment: event.comment },
      });
    }

    res.status(201).json(event);
  },
);

/**
 * Erection engineer confirms the exhaust hookup on-site. If it matches the plan, this just
 * records the confirmed value. If not, it escalates to the customer as a pending action
 * rather than being decided internally - see project notes on the exhaust-hookup escalation.
 */
sitesRouter.post(
  "/:id/confirm-exhaust-hookup",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = confirmExhaustHookupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const site = await prisma.site.findUnique({ where: { id: asString(req.params.id) }, include: { order: true } });
    if (!site) return res.status(404).json({ error: "Site not found" });

    if (parsed.data.matchesPlan) {
      const updated = await prisma.site.update({
        where: { id: site.id },
        data: { confirmedExhaustHookupType: parsed.data.confirmedExhaustHookupType },
      });
      return res.json({ site: updated, pendingAction: null });
    }

    const pendingAction = await prisma.pendingAction.create({
      data: {
        siteId: site.id,
        category: PENDING_ACTION_CATEGORY.CUSTOMER_APPROVAL,
        description:
          "The planned exhaust hookup doesn't work on-site. Please confirm: keep your existing exhaust filter, or remove it and replace with the RECD.",
        ownerType: "CUSTOMER",
        priority: "high",
      },
    });

    const customerContact = await prisma.user.findFirst({ where: { customerId: site.order.customerId } });
    if (customerContact) {
      await sendNotification({
        recipientId: customerContact.id,
        templateKey: "exhaust_hookup_approval_needed",
        data: { siteId: site.id, pendingActionId: pendingAction.id },
      });
    }

    res.status(201).json({ site, pendingAction });
  },
);

sitesRouter.post("/:id/photos", requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const parsed = uploadSitePhotoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const photo = await prisma.sitePhoto.create({
    data: {
      siteId: asString(req.params.id),
      checkpointId: parsed.data.checkpointId,
      photoUrl: parsed.data.photoUrl,
      caption: parsed.data.caption,
      uploadedById: req.auth!.userId,
    },
    include: { checkpoint: true },
  });
  res.status(201).json(photo);
});
