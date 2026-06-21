import { Router } from "express";
import { createOrderSchema, PERMISSION_KEY, STAGE_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const where = req.auth!.customerId ? { customerId: req.auth!.customerId } : {};
  const orders = await prisma.order.findMany({
    where,
    include: { customer: true, product: true, site: { include: { currentStage: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
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
      orderDate: new Date(data.orderDate),
      promisedDeliveryDate: data.promisedDeliveryDate ? new Date(data.promisedDeliveryDate) : undefined,
      plannedExhaustHookupType: data.plannedExhaustHookupType,
      salesEngineerId: req.auth!.userId,
      site: { create: { currentStageId: firstStage.id } },
    },
    include: { site: true },
  });

  res.status(201).json(order);
});
