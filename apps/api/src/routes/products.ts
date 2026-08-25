import { Router } from "express";
import { createProductSchema, updateProductSchema, PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { requirePermission, authenticate } from "../middleware/auth";
import { asString } from "../lib/params";

export const productsRouter = Router();
productsRouter.use(authenticate);

// Read access: anyone who can place an order needs to pick a product.
productsRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { model: "asc" } });
  res.json(products);
});

productsRouter.get("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

productsRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const modelTaken = await prisma.product.findUnique({ where: { model: parsed.data.model } });
  if (modelTaken) return res.status(400).json({ error: "A product with that model already exists" });

  const product = await prisma.product.create({
    data: {
      name: parsed.data.name,
      model: parsed.data.model,
      ratingSpec: parsed.data.ratingSpec,
      capacityKva: parsed.data.capacityKva,
      warrantyMonths: parsed.data.warrantyMonths,
      shape: parsed.data.shape,
      dimensions: parsed.data.dimensions,
      weightKg: parsed.data.weightKg,
      silencerType: parsed.data.silencerType,
    },
  });

  res.status(201).json(product);
});

productsRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Product not found" });

  if (data.model && data.model !== existing.model) {
    const modelTaken = await prisma.product.findUnique({ where: { model: data.model } });
    if (modelTaken) return res.status(400).json({ error: "A product with that model already exists" });
  }

  const product = await prisma.product.update({
    where: { id },
    data: {
      name: data.name,
      model: data.model,
      ratingSpec: data.ratingSpec,
      capacityKva: data.capacityKva,
      warrantyMonths: data.warrantyMonths,
      shape: data.shape,
      dimensions: data.dimensions,
      weightKg: data.weightKg,
      silencerType: data.silencerType,
    },
  });
  res.json(product);
});

productsRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Product not found" });

  const [orders, orderLineItems, recdDeliveries] = await Promise.all([
    prisma.order.count({ where: { productId: id } }),
    prisma.orderLineItem.count({ where: { productId: id } }),
    prisma.recdDelivery.count({ where: { productId: id } }),
  ]);
  if (orders > 0 || orderLineItems > 0 || recdDeliveries > 0) {
    return res.status(400).json({
      error: "Cannot delete a product that is used in orders or RECD deliveries",
    });
  }

  await prisma.product.delete({ where: { id } });
  res.status(204).end();
});
