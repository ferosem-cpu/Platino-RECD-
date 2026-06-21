import { Router } from "express";
import bcrypt from "bcryptjs";
import { createUserSchema, PERMISSION_KEY } from "@recd/shared";
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
