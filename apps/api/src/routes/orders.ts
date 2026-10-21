import { Router } from "express";
import { addOrderLineItemSchema, createOrderSchema, PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";
import { findTakenSerials, takenSerialsMessage } from "../lib/serials";
import { isSerialConflict, SERIAL_RACE_MESSAGE } from "../lib/uniqueViolations";
import { assertOrderReferences, createNewOrder, OrderCreationError } from "../lib/orderCreation";
import { SITE_PEOPLE_INCLUDE } from "../lib/safeSelect";

export const ordersRouter = Router();
ordersRouter.use(authenticate);


ordersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const where = req.auth!.customerId ? { customerId: req.auth!.customerId } : {};
  const orders = await prisma.order.findMany({
    where,
    include: { customer: true, product: true, site: { include: { currentStage: true } }, lineItems: { include: { product: true } }, units: { select: { id: true, serialNo: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

ordersRouter.get("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const orderId = asString(req.params.id);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: { include: { contacts: { select: { id: true, name: true, phone: true, email: true } } } },
      product: true,
      salesEngineer: { select: { id: true, name: true } },
      site: { include: SITE_PEOPLE_INCLUDE },
      lineItems: { include: { product: true }, orderBy: { createdAt: "asc" } },
      units: { include: { product: { select: { id: true, name: true, model: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (req.auth!.customerId && order.customerId !== req.auth!.customerId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // A customer can have multiple orders, each with its own site - surface the sibling
  // sites here so an order's page shows the customer's full site footprint, not just this one.
  const otherSites = await prisma.site.findMany({
    where: { order: { customerId: order.customerId }, NOT: { id: order.site?.id } },
    include: { currentStage: true, order: { select: { orderNumber: true } } },
    orderBy: { createdAt: "desc" },
  });

  res.json({ ...order, otherCustomerSites: otherSites });
});

ordersRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  try {
    // Unknown customer / product is a clean 400 (see lib/orderCreation.ts for the shared creation rules).
    await assertOrderReferences(prisma, data.customerId, [data.productId]);

    const taken = await findTakenSerials(data.recdSerials);
    if (taken.length) {
      return res.status(409).json({ error: takenSerialsMessage(taken) });
    }

    // Duplicate-PO guard (same customer, case-insensitive, trimmed), checked INSIDE the creating transaction under a
    // per-customer+PO lock so two simultaneous requests cannot both pass. Admins may knowingly override, in which case
    // the order is flagged so it shows up in review. Order, site and units are saved together: if a request racing us
    // registers one of the serials first, the unique index rejects ours and the whole transaction rolls back.
    const order = await createNewOrder({
      customerId: data.customerId,
      productId: data.productId,
      quantity: data.quantity,
      value: data.value,
      orderDate: data.orderDate,
      promisedDeliveryDate: data.promisedDeliveryDate,
      plannedExhaustHookupType: data.plannedExhaustHookupType,
      poNumber: data.poNumber,
      poDate: data.poDate,
      serials: data.recdSerials,
      salesEngineerId: req.auth!.userId,
      allowDuplicatePo: data.allowDuplicatePo,
      roleKey: req.auth!.roleKey,
    });
    res.status(201).json(order);
  } catch (err) {
    // Say which constraint actually fired; anything else is a real failure, not a validation error.
    if (err instanceof OrderCreationError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (isSerialConflict(err)) return res.status(409).json({ error: SERIAL_RACE_MESSAGE });
    throw err;
  }
});

/** Adds another RECD unit to an existing order (same order/site, e.g. a 500kva + a 380kva
 *  delivered together) - the alternative to POST /sites/:id/clone-order, which instead
 *  creates a fully separate order+site for the second unit. */
ordersRouter.post("/:id/line-items", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const parsed = addOrderLineItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const orderId = asString(req.params.id);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (req.auth!.customerId && order.customerId !== req.auth!.customerId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId }, select: { id: true } });
  if (!product) return res.status(400).json({ error: "Product not found" });

  const taken = await findTakenSerials(parsed.data.recdSerials);
  if (taken.length) return res.status(409).json({ error: `Serial number already registered: ${taken.join(", ")}` });

  const siteId = (await prisma.site.findUnique({ where: { orderId }, select: { id: true } }))?.id;
  let lineItem;
  try {
    lineItem = await prisma.$transaction(async (tx) => {
      const li = await tx.orderLineItem.create({
        data: { orderId, productId: parsed.data.productId, quantity: parsed.data.quantity },
        include: { product: true },
      });
      await tx.recdUnit.createMany({
        data: parsed.data.recdSerials.map((serialNo) => ({
          serialNo, orderId, siteId, productId: parsed.data.productId, lineItemId: li.id,
        })),
      });
      return li;
    });
  } catch (err) {
    if (isSerialConflict(err)) return res.status(409).json({ error: SERIAL_RACE_MESSAGE });
    throw err;
  }

  res.status(201).json(lineItem);
});

ordersRouter.delete("/:id/line-items/:lineItemId", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const orderId = asString(req.params.id);
  const lineItemId = asString(req.params.lineItemId);
  const lineItem = await prisma.orderLineItem.findUnique({ where: { id: lineItemId } });
  if (!lineItem || lineItem.orderId !== orderId) return res.status(404).json({ error: "Line item not found" });

  const amcLinks = await prisma.amcOrderUnit.count({ where: { unit: { lineItemId } } });
  if (amcLinks) {
    return res.status(409).json({ error: "Cannot remove this unit - it is covered by an AMC order. Remove it from the AMC first." });
  }

  const warrantyHistory = await prisma.warrantyHistory.count({ where: { unit: { lineItemId } } });
  if (warrantyHistory) {
    return res.status(409).json({ error: "Cannot remove this unit - it has warranty history, which is kept for audit." });
  }

  await prisma.$transaction([
    prisma.recdUnit.deleteMany({ where: { lineItemId } }),
    prisma.orderLineItem.delete({ where: { id: lineItemId } }),
  ]);
  res.status(204).end();
});

/**
 * Delete an order and its site (and the site's own operational records - stage events,
 * photos, pending actions, contacts, document requirements, delivery status). Refuses if
 * anything carrying real business history points at the site (complaints), since silently
 * cascading those away would destroy audit trail.
 *
 * Upstream this also blocked on invoices / converted quotations / purchase orders /
 * expenses; none of those exist here (no finance module), so only complaints remain.
 */
ordersRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const orderId = asString(req.params.id);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { site: true } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (req.auth!.customerId && order.customerId !== req.auth!.customerId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const siteId = order.site?.id;
  const complaintCount = siteId ? await prisma.complaint.count({ where: { siteId } }) : 0;
  if (complaintCount) {
    return res.status(400).json({
      error: `Cannot delete this order - it has linked records: ${complaintCount} complaint(s). Resolve or remove those first.`,
    });
  }

  const amcLinks = await prisma.amcOrderUnit.count({ where: { unit: { orderId } } });
  if (amcLinks) {
    return res.status(400).json({
      error: `Cannot delete this order - ${amcLinks} of its RECD unit(s) are covered by an AMC order.`,
    });
  }

  if (await prisma.warrantyHistory.count({ where: { unit: { orderId } } })) {
    return res.status(409).json({ error: "Cannot delete this order - one of its RECD units has warranty history, which is kept for audit." });
  }

  await prisma.$transaction(async (tx) => {
    if (siteId) {
      await tx.siteContact.deleteMany({ where: { siteId } });
      await tx.siteDocumentRequirement.deleteMany({ where: { siteId } });
      await tx.recdDelivery.deleteMany({ where: { siteId } });
      await tx.sitePhoto.deleteMany({ where: { siteId } });
      await tx.siteStageEvent.deleteMany({ where: { siteId } });
      await tx.pendingAction.deleteMany({ where: { siteId } });
      await tx.site.delete({ where: { id: siteId } });
    }
    await tx.recdUnit.deleteMany({ where: { orderId } });
    await tx.orderLineItem.deleteMany({ where: { orderId } });
    await tx.order.delete({ where: { id: orderId } });
  });

  res.status(204).send();
});
