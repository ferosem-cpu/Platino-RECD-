import { Router, type Response } from "express";
import {
  createStageEventSchema,
  confirmExhaustHookupSchema,
  uploadSitePhotoSchema,
  assignSiteVendorSchema,
  siteCompanyDetailsSchema,
  updateSiteLocationSchema,
  updateSiteDetailsSchema,
  createSiteContactSchema,
  updateSiteContactSchema,
  setSiteDocumentRequirementsSchema,
  upsertRecdDeliverySchema,
  cloneOrderForSiteSchema,
  setSiteRegionSchema,
  PERMISSION_KEY,
  PENDING_ACTION_CATEGORY,
  VENDOR_STATUS,
  STAGE_KEY,
  ROLE_KEY,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";
import { asString, asOptionalString } from "../lib/params";
import { findTakenSerials, takenSerialsMessage } from "../lib/serials";
import { isSerialConflict, SERIAL_RACE_MESSAGE } from "../lib/uniqueViolations";
import { OrderCreationError, resolveDuplicatePo, withOrderNumber } from "../lib/orderCreation";
import { createDriveFolder, getDriveFolderId } from "../lib/googleDrive";
import { managedRegionIds } from "../lib/regions";
import { SITE_ORDER_WITH_REFS_SELECT, SITE_PEOPLE_INCLUDE, STAFF_REF_SELECT, VENDOR_REF_SELECT } from "../lib/safeSelect";

export const sitesRouter = Router();
sitesRouter.use(authenticate);

/** True for the staff role whose site visibility follows its mapped regions (customers and vendors are scoped by their own ownership rules instead). */
function isRegionScoped(auth: NonNullable<AuthenticatedRequest["auth"]>): boolean {
  return !auth.customerId && !auth.vendorId && auth.roleKey === ROLE_KEY.REGIONAL_MANAGER;
}

sitesRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const assignedToMe = asOptionalString(req.query.assigned_to) === "me";
  const where: Record<string, unknown> = {};
  if (assignedToMe) where.assignedEngineerId = req.auth!.userId;
  if (req.auth!.customerId) where.order = { customerId: req.auth!.customerId };
  // Vendor isolation: a vendor's engineers only ever see sites assigned to their own vendor.
  if (req.auth!.vendorId) where.vendorId = req.auth!.vendorId;
  // A Regional Manager only sees sites in the regions mapped to them (the same rule the ticket module already applies); none mapped = nothing.
  if (isRegionScoped(req.auth!)) where.regionId = { in: await managedRegionIds(req.auth!.userId, req.auth!.roleKey) };

  const sites = await prisma.site.findMany({
    where,
    include: {
      order: { select: { ...SITE_ORDER_WITH_REFS_SELECT, lineItems: { include: { product: true } } } },
      ...SITE_PEOPLE_INCLUDE,
      stageEvents: { orderBy: { createdAt: "desc" }, take: 1, include: { statusOption: true } },
      // The serial(s) printed on this site's RECD(s), for list screens (mobile). Same rows the by-id endpoint returns, narrowed to what a list shows.
      units: { select: { id: true, serialNo: true, status: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(sites);
});

sitesRouter.get("/:id", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const siteId = asString(req.params.id);

  const detail = await prisma.site.findUnique({
    where: { id: siteId },
    include: {
      order: { select: { ...SITE_ORDER_WITH_REFS_SELECT, lineItems: { include: { product: true }, orderBy: { createdAt: "asc" } } } },
      ...SITE_PEOPLE_INCLUDE,
      stageEvents: {
        include: { stageDefinition: true, statusOption: true, createdBy: { select: STAFF_REF_SELECT } },
        orderBy: { createdAt: "asc" },
      },
      photos: { include: { checkpoint: true, uploadedBy: { select: STAFF_REF_SELECT } }, orderBy: { uploadedAt: "asc" } },
      pendingActions: { orderBy: { createdAt: "desc" } },
      contacts: { orderBy: { createdAt: "asc" } },
      documentRequirements: { include: { requirementType: true }, orderBy: { requirementType: { sequenceOrder: "asc" } } },
      recdDelivery: { include: { product: true } },
      region: { select: { id: true, name: true } },
      units: { include: { product: { select: { id: true, name: true, model: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!detail) return res.status(404).json({ error: "Site not found" });
  if (req.auth!.customerId && detail.order.customerId !== req.auth!.customerId) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (req.auth!.vendorId && detail.vendorId !== req.auth!.vendorId) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (isRegionScoped(req.auth!) && !(detail.regionId && (await managedRegionIds(req.auth!.userId, req.auth!.roleKey)).includes(detail.regionId))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(detail);
});

/**
 * The customer-filled "Company Details" form shown on the portal after registration
 * (see login/customer portal). Customer-only, restricted to their own site.
 */
sitesRouter.patch(
  "/:id/company-details",
  requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = siteCompanyDetailsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (!req.auth!.customerId) return res.status(403).json({ error: "Only customers can submit company details" });

    const siteId = asString(req.params.id);
    const site = await prisma.site.findUnique({ where: { id: siteId }, include: { order: true } });
    if (!site) return res.status(404).json({ error: "Site not found" });
    if (site.order.customerId !== req.auth!.customerId) {
      return res.status(403).json({ error: "You can only update your own site" });
    }

    const updated = await prisma.site.update({
      where: { id: siteId },
      data: {
        companyName: parsed.data.companyName,
        address: parsed.data.address,
        dgCapacityKva: parsed.data.dgCapacityKva,
        dgModel: parsed.data.dgModel,
        sitePocName: parsed.data.sitePocName,
        sitePocNumber: parsed.data.sitePocNumber,
      },
    });
    res.json(updated);
  },
);

/** Assigns (or clears) the service region of a site. Staff-only; drives Regional Manager reminders. */
sitesRouter.put("/:id/region", requirePermission(PERMISSION_KEY.MANAGE_REGIONS), async (req: AuthenticatedRequest, res) => {
  const parsed = setSiteRegionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const siteId = asString(req.params.id);
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return res.status(404).json({ error: "Site not found" });
  if (parsed.data.regionId) {
    const region = await prisma.region.findUnique({ where: { id: parsed.data.regionId } });
    if (!region || !region.isActive) return res.status(400).json({ error: "Unknown or inactive region" });
  }
  const updated = await prisma.site.update({
    where: { id: siteId },
    data: { regionId: parsed.data.regionId },
    include: { region: { select: { id: true, name: true } } },
  });
  res.json(updated);
});

/** Creates a sibling Order+Site for another RECD delivered to this same physical location -
 *  same address/companyName/vendor as this site, reset to the first stage, but its own
 *  orderNumber so it's tracked (and later invoiced/dispatched) independently. The alternative
 *  to POST /orders/:id/line-items, which instead adds the unit to this same order/site. */
sitesRouter.post("/:id/clone-order", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const parsed = cloneOrderForSiteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const siteId = asString(req.params.id);
  const site = await prisma.site.findUnique({ where: { id: siteId }, include: { order: true } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId }, select: { id: true } });
  if (!product) return res.status(400).json({ error: "Product not found" });

  const taken = await findTakenSerials(parsed.data.recdSerials);
  if (taken.length) return res.status(409).json({ error: takenSerialsMessage(taken) });

  const firstStage = await prisma.stageDefinition.findUniqueOrThrow({ where: { key: STAGE_KEY.ORDER_RECEIVED } });

  // Order and units are created together so a serial conflict (a request racing us past the
  // check above) cannot leave an order behind with no units. A generated-order-number collision is
  // retried (bounded) in a fresh transaction.
  // The PO is the one the caller entered, else the source order's. It goes through the SAME duplicate rule as POST /orders (per customer,
  // case-insensitive, under the customer + PO lock, inside this transaction): a duplicate is refused (409 DUPLICATE_PO) unless an
  // administrator role passes allowDuplicatePo, in which case the clone is created and flagged poDuplicateFlag.
  const poNumber = parsed.data.poNumber?.trim() || site.order.poNumber;
  const poDate = parsed.data.poDate ? new Date(parsed.data.poDate) : parsed.data.poNumber ? undefined : site.order.poDate;
  let newOrder;
  try {
    newOrder = await withOrderNumber((orderNumber) =>
      prisma.$transaction(async (tx) => {
        const poDuplicateFlag = await resolveDuplicatePo(tx, { customerId: site.order.customerId, poNumber, allowDuplicatePo: parsed.data.allowDuplicatePo, roleKey: req.auth!.roleKey });
        const created = await tx.order.create({
          data: {
            orderNumber,
            customerId: site.order.customerId,
            productId: parsed.data.productId,
            quantity: parsed.data.quantity,
            poNumber,
            poDate,
            poDuplicateFlag,
            salesEngineerId: req.auth!.userId,
            site: {
              create: {
                address: site.address,
                companyName: site.companyName,
                vendorId: site.vendorId,
                regionId: site.regionId,
                currentStageId: firstStage.id,
              },
            },
          },
          include: { site: true, product: true },
        });
        await tx.recdUnit.createMany({
          data: parsed.data.recdSerials.map((serialNo) => ({
            serialNo,
            orderId: created.id,
            siteId: created.site?.id,
            productId: parsed.data.productId,
          })),
        });
        return created;
      }),
    );
  } catch (err) {
    if (err instanceof OrderCreationError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.existingOrderNumber ? { existingOrderNumber: err.existingOrderNumber } : {}) });
    if (isSerialConflict(err)) return res.status(409).json({ error: SERIAL_RACE_MESSAGE });
    throw err;
  }

  res.status(201).json(newOrder);
});

sitesRouter.post(
  "/:id/stage-events",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = createStageEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const site = await prisma.site.findUnique({
      where: { id: asString(req.params.id) },
      include: {
        order: {
          include: { product: true, lineItems: { include: { product: true } } },
        },
      },
    });
    if (!site) return res.status(404).json({ error: "Site not found" });
    if (req.auth!.vendorId && site.vendorId !== req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });

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
      const recdUnits = [
        `${site.order.product.name} (${site.order.product.model})${site.order.quantity > 1 ? ` x${site.order.quantity}` : ""}`,
        ...site.order.lineItems.map(
          (li) => `${li.product.name} (${li.product.model})${li.quantity > 1 ? ` x${li.quantity}` : ""}`,
        ),
      ];
      await sendNotification({
        recipientId: customerContact.id,
        templateKey: "site_stage_updated",
        data: {
          stage: event.stageDefinition.label,
          status: event.statusOption.label,
          comment: event.comment,
          orderNumber: site.order.orderNumber,
          address: site.address,
          companyName: site.companyName,
          recdUnits,
        },
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
    if (req.auth!.vendorId && site.vendorId !== req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });

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

  const siteId = asString(req.params.id);
  if (req.auth!.vendorId) {
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) return res.status(404).json({ error: "Site not found" });
    if (site.vendorId !== req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });
  }

  const photo = await prisma.sitePhoto.create({
    data: {
      siteId,
      checkpointId: parsed.data.checkpointId,
      photoUrl: parsed.data.photoUrl,
      caption: parsed.data.caption,
      uploadedById: req.auth!.userId,
    },
    include: { checkpoint: true },
  });
  res.status(201).json(photo);
});

/**
 * Set/update where the site actually is - address and/or GPS coordinates. Captured by
 * whoever can already change site status (typically the field engineer on-site), so the
 * office and the customer portal can show it on a map instead of just an address string.
 */
sitesRouter.post("/:id/location", requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const parsed = updateSiteLocationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const siteId = asString(req.params.id);
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return res.status(404).json({ error: "Site not found" });
  if (req.auth!.vendorId && site.vendorId !== req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });

  const updated = await prisma.site.update({
    where: { id: siteId },
    data: {
      address: parsed.data.address,
      gpsLat: parsed.data.gpsLat,
      gpsLng: parsed.data.gpsLng,
    },
  });
  res.json(updated);
});

/**
 * Assign (or clear) the external vendor responsible for a site - a management decision after
 * approving the vendor. Setting it is what scopes the site into that vendor's isolated view.
 */
sitesRouter.post("/:id/assign-vendor", requirePermission(PERMISSION_KEY.MANAGE_VENDORS), async (req: AuthenticatedRequest, res) => {
  const parsed = assignSiteVendorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const siteId = asString(req.params.id);
  const site = await prisma.site.findUnique({ where: { id: siteId }, include: { order: { include: { customer: true } } } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  if (parsed.data.vendorId) {
    const vendor = await prisma.vendor.findUnique({ where: { id: parsed.data.vendorId } });
    if (!vendor) return res.status(400).json({ error: "Unknown vendor" });
    if (vendor.status !== VENDOR_STATUS.APPROVED) return res.status(400).json({ error: "Vendor is not approved" });
  }

  const data: Record<string, unknown> = { vendorId: parsed.data.vendorId };
  if (parsed.data.assignedEngineerId !== undefined) data.assignedEngineerId = parsed.data.assignedEngineerId;

  const updated = await prisma.site.update({
    where: { id: siteId },
    data,
    include: { vendor: { select: VENDOR_REF_SELECT }, assignedEngineer: { select: STAFF_REF_SELECT } },
  });

  // Notify the vendor's engineers a new site landed in their queue - a newly-assigned vendor
  // (as opposed to a no-op re-save or a clear-to-unassigned) is the only case worth emailing.
  if (parsed.data.vendorId && parsed.data.vendorId !== site.vendorId) {
    const vendorMembers = await prisma.user.findMany({ where: { vendorId: parsed.data.vendorId } });
    await Promise.all(
      vendorMembers.map((member) =>
        sendNotification({
          recipientId: member.id,
          templateKey: "vendor_assigned_site",
          data: {
            orderNumber: site.order.orderNumber,
            customerName: site.order.customer.name,
            address: site.address,
          },
        }),
      ),
    );
  }

  res.json(updated);
});

/**
 * Update the site's own identity fields - end-client/site-owner name and address. Distinct
 * from POST /:id/location, which is field-captured GPS + address from the erection engineer;
 * this is office-side editing (e.g. after a bulk import) and doesn't touch gpsLat/gpsLng.
 */
sitesRouter.patch("/:id", requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const parsed = updateSiteDetailsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const siteId = asString(req.params.id);
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return res.status(404).json({ error: "Site not found" });
  if (req.auth!.vendorId && site.vendorId !== req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });

  const updated2 = await prisma.site.update({ where: { id: siteId }, data: parsed.data });
  res.json(updated2);
});

// ---------------------------------------------------------------------------
// Site contacts (multiple POCs per site)
// ---------------------------------------------------------------------------

/**
 * Loads the site a contact request targets and enforces the same scoping the other site routes use:
 * a vendor user only reaches sites assigned to their vendor, a customer user only their own sites.
 * Staff with no vendor/customer link (management, PMs, engineers on the permission) are unscoped.
 * Sends the 404/403 itself and returns null when the request must stop.
 */
async function loadScopedSite(req: AuthenticatedRequest, res: Response) {
  const site = await prisma.site.findUnique({ where: { id: asString(req.params.id) }, include: { order: true } });
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return null;
  }
  if (req.auth!.vendorId && site.vendorId !== req.auth!.vendorId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  if (req.auth!.customerId && site.order.customerId !== req.auth!.customerId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return site;
}

sitesRouter.post("/:id/contacts", requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const parsed = createSiteContactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const site = await loadScopedSite(req, res);
  if (!site) return;

  const contact = await prisma.siteContact.create({ data: { siteId: site.id, ...parsed.data } });
  res.status(201).json(contact);
});

sitesRouter.patch(
  "/:id/contacts/:contactId",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = updateSiteContactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const site = await loadScopedSite(req, res);
    if (!site) return;
    const contact = await prisma.siteContact.findUnique({ where: { id: asString(req.params.contactId) } });
    if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Contact not found" });

    const updated = await prisma.siteContact.update({ where: { id: contact.id }, data: parsed.data });
    res.json(updated);
  },
);

sitesRouter.delete(
  "/:id/contacts/:contactId",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const site = await loadScopedSite(req, res);
    if (!site) return;
    const contact = await prisma.siteContact.findUnique({ where: { id: asString(req.params.contactId) } });
    if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Contact not found" });

    await prisma.siteContact.delete({ where: { id: contact.id } });
    res.status(204).send();
  },
);

// ---------------------------------------------------------------------------
// Document requirements (police verification, ESIC, insurance, PPE, ...)
// ---------------------------------------------------------------------------

/**
 * Bulk-set every document requirement for a site in one call - the admin UI renders all
 * requirement types as a table with a required yes/no toggle per row and saves the whole
 * table at once, rather than one request per checkbox.
 */
sitesRouter.put(
  "/:id/document-requirements",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const parsed = setSiteDocumentRequirementsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const siteId = asString(req.params.id);
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site) return res.status(404).json({ error: "Site not found" });

    await prisma.$transaction(
      parsed.data.requirements.map((r) =>
        prisma.siteDocumentRequirement.upsert({
          where: { siteId_requirementTypeId: { siteId, requirementTypeId: r.requirementTypeId } },
          update: {
            required: r.required,
            status: r.status,
            documentUrl: r.documentUrl,
            notes: r.notes,
          },
          create: {
            siteId,
            requirementTypeId: r.requirementTypeId,
            required: r.required,
            status: r.status ?? undefined,
            documentUrl: r.documentUrl,
            notes: r.notes,
          },
        }),
      ),
    );

    const requirements = await prisma.siteDocumentRequirement.findMany({
      where: { siteId },
      include: { requirementType: true },
      orderBy: { requirementType: { sequenceOrder: "asc" } },
    });
    res.json(requirements);
  },
);

// ---------------------------------------------------------------------------
// RECD delivery tracking
// ---------------------------------------------------------------------------

sitesRouter.put("/:id/recd-delivery", requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const parsed = upsertRecdDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const siteId = asString(req.params.id);
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const data = {
    productId: parsed.data.productId ?? undefined,
    quantity: parsed.data.quantity ?? undefined,
    deliveryStatus: parsed.data.deliveryStatus,
    statusNote: parsed.data.statusNote ?? undefined,
    priority: parsed.data.priority ?? undefined,
    expectedDate: parsed.data.expectedDate ? new Date(parsed.data.expectedDate) : undefined,
    actualDate: parsed.data.actualDate ? new Date(parsed.data.actualDate) : undefined,
  };

  const delivery = await prisma.recdDelivery.upsert({
    where: { siteId },
    update: data,
    create: { siteId, ...data },
    include: { product: true },
  });
  res.json(delivery);
});

// ---------------------------------------------------------------------------
// Google Drive folders (photographs + drawings)
// ---------------------------------------------------------------------------

/**
 * Creates the Photographs and Drawings subfolders for this site under the company Drive
 * account's parent folder (see lib/googleDrive.ts), named so they're identifiable in Drive
 * itself, and persists the folder id + webViewLink so the admin UI can link straight to
 * them. Safe to call once; calling again would create duplicate folders, so the UI only
 * shows the "create" action while the links are unset.
 */
sitesRouter.post(
  "/:id/drive-folders",
  requirePermission(PERMISSION_KEY.CHANGE_SITE_STATUS),
  async (req: AuthenticatedRequest, res) => {
    const siteId = asString(req.params.id);
    const site = await prisma.site.findUnique({ where: { id: siteId }, include: { order: { include: { customer: true } } } });
    if (!site) return res.status(404).json({ error: "Site not found" });

    let parentFolderId: string;
    try {
      parentFolderId = getDriveFolderId();
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Drive is not configured" });
    }

    const label = site.companyName || site.address || site.id;
    const siteFolder = await createDriveFolder(`${site.order.customer.name} - ${label}`, parentFolderId);
    const [photosFolder, drawingsFolder] = await Promise.all([
      createDriveFolder("Photographs", siteFolder.id),
      createDriveFolder("Drawings", siteFolder.id),
    ]);

    const updated = await prisma.site.update({
      where: { id: siteId },
      data: {
        photosDriveFolderId: photosFolder.id,
        photosDriveFolderUrl: photosFolder.webViewLink,
        drawingsDriveFolderId: drawingsFolder.id,
        drawingsDriveFolderUrl: drawingsFolder.webViewLink,
      },
    });
    res.status(201).json(updated);
  },
);
