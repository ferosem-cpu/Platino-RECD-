import { Router } from "express";
import { setRecdSerialSchema, PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { asString, asOptionalString } from "../lib/params";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const recdUnitsRouter = Router();
recdUnitsRouter.use(authenticate);

const unitInclude = {
  product: { select: { id: true, name: true, model: true, warrantyMonths: true } },
  order: { select: { id: true, orderNumber: true, poNumber: true, customer: { select: { id: true, name: true } } } },
  site: { select: { id: true, companyName: true, address: true, regionId: true, region: { select: { id: true, name: true } } } },
} as const;

/** List/search units. `search` matches serial number; `pending=1` lists units still awaiting a serial. */
recdUnitsRouter.get("/", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const search = asOptionalString(req.query.search)?.trim();
  const pending = asOptionalString(req.query.pending) === "1";
  const orderId = asOptionalString(req.query.orderId);

  const where: Record<string, unknown> = {};
  if (search) where.serialNo = { contains: search, mode: "insensitive" };
  if (pending) where.serialNo = null;
  if (orderId) where.orderId = orderId;
  if (req.auth!.customerId) where.order = { customerId: req.auth!.customerId };
  if (req.auth!.vendorId) where.site = { vendorId: req.auth!.vendorId };

  const units = await prisma.recdUnit.findMany({
    where,
    include: unitInclude,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
  res.json(units);
});

recdUnitsRouter.get("/:id", requirePermission(PERMISSION_KEY.VIEW_SITE_STATUS), async (req: AuthenticatedRequest, res) => {
  const unit = await prisma.recdUnit.findUnique({ where: { id: asString(req.params.id) }, include: unitInclude });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (req.auth!.customerId) {
    const o = await prisma.order.findUnique({ where: { id: unit.orderId }, select: { customerId: true } });
    if (o?.customerId !== req.auth!.customerId) return res.status(403).json({ error: "Forbidden" });
  }
  if (req.auth!.vendorId) {
    const s = unit.siteId ? await prisma.site.findUnique({ where: { id: unit.siteId }, select: { vendorId: true } }) : null;
    if (s?.vendorId !== req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });
  }
  res.json(unit);
});

/** Sets the serial on a unit that has none yet. Serials are write-once here: correcting an
 *  already-set serial would silently orphan service history keyed to it, so it needs an
 *  explicit admin path (not part of this phase). */
recdUnitsRouter.put("/:id/serial", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const parsed = setRecdSerialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const unit = await prisma.recdUnit.findUnique({ where: { id } });
  if (!unit) return res.status(404).json({ error: "RECD unit not found" });
  if (unit.serialNo) return res.status(409).json({ error: "This unit already has a serial number" });

  const clash = await prisma.recdUnit.findUnique({ where: { serialNo: parsed.data.serialNo } });
  if (clash) return res.status(409).json({ error: `Serial number ${parsed.data.serialNo} is already registered` });

  res.json(await prisma.recdUnit.update({ where: { id }, data: { serialNo: parsed.data.serialNo }, include: unitInclude }));
});
