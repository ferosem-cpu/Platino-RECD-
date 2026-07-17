import { Router } from "express";
import { createAmcOrderSchema, PERMISSION_KEY, AMC_ORDER_STATUS } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const amcOrdersRouter = Router();
amcOrdersRouter.use(authenticate);
amcOrdersRouter.use(requirePermission(PERMISSION_KEY.MANAGE_AMC_ORDERS));

amcOrdersRouter.get("/", async (_req, res) => {
  const orders = await prisma.amcOrder.findMany({
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  const counts = {
    total: orders.length,
    completed: orders.filter((o) => o.status === AMC_ORDER_STATUS.COMPLETED).length,
    inProgress: orders.filter((o) => o.status === AMC_ORDER_STATUS.IN_PROGRESS).length,
    yetToStart: orders.filter((o) => o.status === AMC_ORDER_STATUS.YET_TO_START).length,
  };

  res.json({ orders, counts });
});

amcOrdersRouter.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = createAmcOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.amcOrder.create({
    data: {
      poNo: parsed.data.poNo,
      poDate: new Date(parsed.data.poDate),
      customerId: parsed.data.customerId,
      location: parsed.data.location,
      item: parsed.data.item,
      qty: parsed.data.qty,
      amcFrequencyPerYear: parsed.data.amcFrequencyPerYear,
      status: AMC_ORDER_STATUS.YET_TO_START,
      createdById: req.auth!.userId,
    },
    include: { customer: { select: { id: true, name: true } } },
  });

  res.status(201).json(order);
});
