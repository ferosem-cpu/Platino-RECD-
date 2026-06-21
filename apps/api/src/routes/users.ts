import { Router } from "express";
import bcrypt from "bcryptjs";
import { createUserSchema, updateUserSchema, PERMISSION_KEY } from "@recd/shared";
import { asString } from "../lib/params";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (_req, res) => {
  const users = await prisma.user.findMany({
    include: { role: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(users.map(({ passwordHash, ...u }) => u));
});

/**
 * Owner/Admin adds a person and assigns a role - that role's predefined view/change-status
 * permission bundle applies (see project notes; per-person overrides independent of role
 * are an explicit Phase 2 refinement, not this).
 */
usersRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const role = await prisma.role.findUnique({ where: { key: parsed.data.roleKey } });
  if (!role) return res.status(400).json({ error: `Unknown role key: ${parsed.data.roleKey}` });

  const tempPassword = Math.random().toString(36).slice(2, 10);
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const user = await prisma.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      roleId: role.id,
      passwordHash,
      createdById: req.auth!.userId,
    },
  });

  // Phase 1: return the temp password in the response for the admin to relay manually.
  // Swap for a "set your password" email link once the email provider is fully wired up.
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: role.key, tempPassword });
});

// ---------------------------------------------------------------------------
// Update user
// ---------------------------------------------------------------------------

usersRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = asString(req.params.id);
  const existing = await prisma.user.findUnique({
    where: { id },
    include: { role: true },
  });
  if (!existing) return res.status(404).json({ error: "User not found" });

  // Guard: User changing their own role
  if (id === req.auth!.userId) {
    if (parsed.data.roleKey !== undefined && parsed.data.roleKey !== existing.role.key) {
      return res.status(400).json({ error: "You cannot change your own role" });
    }
  }

  // Guard: Demoting the last active Super Admin
  if (parsed.data.roleKey !== undefined && parsed.data.roleKey !== existing.role.key) {
    if (existing.role.key === "super_admin") {
      const activeSuperAdmins = await prisma.user.count({
        where: {
          role: { key: "super_admin" },
          isActive: true,
        },
      });
      if (activeSuperAdmins <= 1) {
        return res.status(400).json({ error: "Cannot demote the last active Super Admin" });
      }
    }
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.email !== undefined) data.email = parsed.data.email;
  if (parsed.data.phone !== undefined) data.phone = parsed.data.phone;
  if (parsed.data.title !== undefined) data.title = parsed.data.title;

  if (parsed.data.roleKey !== undefined) {
    const role = await prisma.role.findUnique({ where: { key: parsed.data.roleKey } });
    if (!role) return res.status(400).json({ error: `Unknown role key: ${parsed.data.roleKey}` });
    data.roleId = role.id;
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    include: { role: true },
  });

  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

// ---------------------------------------------------------------------------
// Deactivate / Activate user
// ---------------------------------------------------------------------------

usersRouter.put("/:id/deactivate", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  if (id === req.auth!.userId) {
    return res.status(400).json({ error: "You cannot deactivate your own account" });
  }

  const existing = await prisma.user.findUnique({
    where: { id },
    include: { role: true },
  });
  if (!existing) return res.status(404).json({ error: "User not found" });

  if (existing.role.key === "super_admin") {
    const activeSuperAdmins = await prisma.user.count({
      where: {
        role: { key: "super_admin" },
        isActive: true,
      },
    });
    if (activeSuperAdmins <= 1) {
      return res.status(400).json({ error: "Cannot deactivate the last active Super Admin" });
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: false },
    include: { role: true },
  });

  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

usersRouter.put("/:id/activate", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.user.findUnique({
    where: { id },
    include: { role: true },
  });
  if (!existing) return res.status(404).json({ error: "User not found" });

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: true },
    include: { role: true },
  });

  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

// ---------------------------------------------------------------------------
// Reset password (generate a new temporary password)
// ---------------------------------------------------------------------------

usersRouter.post("/:id/reset-password", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "User not found" });

  const tempPassword = Math.random().toString(36).slice(2, 10);
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      mustChangePassword: true,
    },
  });

  res.json({ tempPassword });
});
