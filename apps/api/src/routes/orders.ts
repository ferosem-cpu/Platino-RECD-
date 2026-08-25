import { Router } from "express";
import { addOrderLineItemSchema, createOrderSchema, PERMISSION_KEY, STAGE_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const where = req.auth!.customerId ? { customerId: req.auth!.customerId } : {};
  const orders = await prisma.order.findMany({
    where,
    include: { customer: true, product: true, site: { include: { currentStage: true } }, lineItems: { include: { product: true } } },
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
      site: { include: { currentStage: true, assignedEngineer: true, vendor: true } },
      lineItems: { include: { product: true }, orderBy: { createdAt: "asc" } },
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

  const firstStage = await prisma.stageDefinition.findUniqueOrThrow({ where: { key: STAGE_KEY.ORDER_RECEIVED } });
  const orderNumber = `ORD-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const order = await prisma.order.create({
    data: {
      orderNumber,
      customerId: data.customerId,
      productId: data.productId,
      quantity: data.quantity,
      value: data.value,
      orderDate: data.orderDate ? new Date(data.orderDate) : undefined,
      promisedDeliveryDate: data.promisedDeliveryDate ? new Date(data.promisedDeliveryDate) : undefined,
      plannedExhaustHookupType: data.plannedExhaustHookupType,
      salesEngineerId: req.auth!.userId,
      site: { create: { currentStageId: firstStage.id } },
    },
    include: { site: true },
  });

  res.status(201).json(order);
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

  const lineItem = await prisma.orderLineItem.create({
    data: { orderId, productId: parsed.data.productId, quantity: parsed.data.quantity },
    include: { product: true },
  });

  res.status(201).json(lineItem);
});

ordersRouter.delete("/:id/line-items/:lineItemId", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const orderId = asString(req.params.id);
  const lineItemId = asString(req.params.lineItemId);
  const lineItem = await prisma.orderLineItem.findUnique({ where: { id: lineItemId } });
  if (!lineItem || lineItem.orderId !== orderId) return res.status(404).json({ error: "Line item not found" });

  await prisma.orderLineItem.delete({ where: { id: lineItemId } });
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
    await tx.orderLineItem.deleteMany({ where: { orderId } });
    await tx.order.delete({ where: { id: orderId } });
  });

  res.status(204).send();
});
