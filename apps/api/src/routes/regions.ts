import { Router } from "express";
import {
  createRegionSchema,
  updateRegionSchema,
  setRegionManagersSchema,
  PERMISSION_KEY,
  ROLE_KEY,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { asString } from "../lib/params";
import { regionKeyFromName } from "../lib/regions";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const regionsRouter = Router();
regionsRouter.use(authenticate);

/** Any signed-in staff member may list regions (pickers); customers/vendors may not. */
regionsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  if (req.auth!.customerId || req.auth!.vendorId) return res.status(403).json({ error: "Forbidden" });
  const regions = await prisma.region.findMany({
    include: {
      managers: { include: { user: { select: { id: true, name: true, email: true, phone: true, isActive: true } } } },
      _count: { select: { sites: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json(
    regions.map(({ managers, _count, ...r }) => ({
      ...r,
      siteCount: _count.sites,
      managers: managers.map((m) => m.user),
    })),
  );
});

regionsRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_REGIONS), async (req, res) => {
  const parsed = createRegionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const key = regionKeyFromName(parsed.data.name);
  if (!key) return res.status(400).json({ error: "Region name must contain letters or digits" });

  const clash = await prisma.region.findFirst({
    where: { OR: [{ key }, { name: { equals: parsed.data.name, mode: "insensitive" } }] },
  });
  if (clash) return res.status(409).json({ error: `A region named "${clash.name}" already exists` });

  const region = await prisma.region.create({ data: { key, name: parsed.data.name } });
  res.status(201).json(region);
});

regionsRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_REGIONS), async (req, res) => {
  const parsed = updateRegionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const existing = await prisma.region.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Region not found" });

  const data: { name?: string; key?: string; isActive?: boolean } = {};
  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    const key = regionKeyFromName(parsed.data.name);
    if (!key) return res.status(400).json({ error: "Region name must contain letters or digits" });
    const clash = await prisma.region.findFirst({
      where: { id: { not: id }, OR: [{ key }, { name: { equals: parsed.data.name, mode: "insensitive" } }] },
    });
    if (clash) return res.status(409).json({ error: `A region named "${clash.name}" already exists` });
    data.name = parsed.data.name;
    data.key = key;
  }
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;

  res.json(await prisma.region.update({ where: { id }, data }));
});

/** Replaces the set of Regional Managers mapped to a region. Only active users holding the
 *  regional_manager role are accepted. */
regionsRouter.put("/:id/managers", requirePermission(PERMISSION_KEY.MANAGE_REGIONS), async (req, res) => {
  const parsed = setRegionManagersSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = asString(req.params.id);
  const region = await prisma.region.findUnique({ where: { id } });
  if (!region) return res.status(404).json({ error: "Region not found" });

  const userIds = [...new Set(parsed.data.userIds)];
  if (userIds.length) {
    const valid = await prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true, role: { key: ROLE_KEY.REGIONAL_MANAGER } },
      select: { id: true },
    });
    if (valid.length !== userIds.length) {
      return res.status(400).json({ error: "Every manager must be an active user with the Regional Manager role" });
    }
  }

  await prisma.$transaction([
    prisma.regionManager.deleteMany({ where: { regionId: id } }),
    ...(userIds.length ? [prisma.regionManager.createMany({ data: userIds.map((userId) => ({ regionId: id, userId })) })] : []),
  ]);
  res.json({ regionId: id, userIds });
});
