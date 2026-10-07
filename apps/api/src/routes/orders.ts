import { Router } from "express";
import { addOrderLineItemSchema, createOrderSchema, PERMISSION_KEY, ROLE_KEY, STAGE_KEY } from "@recd/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

const ADMIN_ROLES_FOR_PO_OVERRIDE: string[] = [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT];

/** Returns the already-registered serials among `serials` (serials are globally unique). */
async function findTakenSerials(serials: string[]): Promise<string[]> {
  if (!serials.length) return [];
  const rows = await prisma.recdUnit.findMany({ where: { serialNo: { in: serials } }, select: { serialNo: true } });
  return rows.map((r) => r.serialNo!).filter(Boolean);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

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
      site: { include: { currentStage: true, assignedEngineer: true, vendor: true } },
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

  const taken = await findTakenSerials(data.recdSerials);
  if (taken.length) {
    return res.status(409).json({ error: `Serial number already registered: ${taken.join(", ")}` });
  }

  // Duplicate PO guard: same customer + same PO number. Admins may knowingly override, in
  // which case the order is flagged so it shows up in review.
  const dupePo = await prisma.order.findFirst({
    where: { customerId: data.customerId, poNumber: { equals: data.poNumber, mode: "insensitive" } },
    select: { orderNumber: true },
  });
  let poDuplicateFlag = false;
  if (dupePo) {
    const mayOverride = ADMIN_ROLES_FOR_PO_OVERRIDE.includes(req.auth!.roleKey);
    if (!(data.allowDuplicatePo && mayOverride)) {
      return res.status(409).json({
        error: `PO ${data.poNumber} already exists for this customer (order ${dupePo.orderNumber}).` +
          (mayOverride ? " Tick 'allow duplicate PO' to create it anyway." : " Ask an admin to override if this is intentional."),
        code: "DUPLICATE_PO",
      });
    }
    poDuplicateFlag = true;
  }

  const firstStage = await prisma.stageDefinition.findUniqueOrThrow({ where: { key: STAGE_KEY.ORDER_RECEIVED } });
  const orderNumber = `ORD-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  let order;
  try {
    order = await prisma.order.create({
      data: {
        orderNumber,
        customerId: data.customerId,
        productId: data.productId,
        quantity: data.quantity,
        value: data.value,
        orderDate: data.orderDate ? new Date(data.orderDate) : undefined,
        promisedDeliveryDate: data.promisedDeliveryDate ? new Date(data.promisedDeliveryDate) : undefined,
        plannedExhaustHookupType: data.plannedExhaustHookupType,
        poNumber: data.poNumber,
        poDate: data.poDate ? new Date(data.poDate) : undefined,
        poDuplicateFlag,
        salesEngineerId: req.auth!.userId,
        site: { create: { currentStageId: firstStage.id } },
      },
      include: { site: true },
    });
    await prisma.recdUnit.createMany({
      data: data.recdSerials.map((serialNo) => ({
        serialNo,
        orderId: order!.id,
        siteId: order!.site?.id,
        productId: data.productId,
      })),
    });
  } catch (err) {
    // Lost a race with another request registering the same serial.
    if (isUniqueViolation(err)) {
      if (order) await prisma.order.delete({ where: { id: order.id } }).catch(() => undefined);
      return res.status(409).json({ error: "One of those serial numbers was just registered by someone else" });
    }
    throw err;
  }

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
    if (isUniqueViolation(err)) return res.status(409).json({ error: "One of those serial numbers was just registered by someone else" });
    throw err;
  }

  res.status(201).json(lineItem);
});

ordersRouter.delete("/:id/line-items/:lineItemId", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const orderId = asString(req.params.id);
  const lineItemId = asString(req.params.lineItemId);
  const lineItem = await prisma.orderLineItem.findUnique({ where: { id: lineItemId } });
  if (!lineItem || lineItem.orderId !== orderId) return res.status(404).json({ error: "Line item not found" });

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
