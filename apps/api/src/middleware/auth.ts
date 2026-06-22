import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    roleKey: string;
    customerId?: string | null;
    permissions: Set<string>;
  };
}

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = verifyToken(header.slice("Bearer ".length));
    // Load the user (not just the role) so we can (a) reject deactivated accounts whose
    // tokens are still valid, and (b) reflect role/permission changes immediately rather
    // than trusting the role baked into the token at sign-in time.
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    if (!user) return res.status(401).json({ error: "Unknown user" });
    if (!user.isActive) return res.status(401).json({ error: "Account is inactive" });

    req.auth = {
      userId: user.id,
      roleKey: user.role.key,
      customerId: user.customerId,
      permissions: new Set(user.role.permissions.map((rp) => rp.permission.key)),
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requirePermission(...permissionKeys: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Not authenticated" });
    const hasAny = permissionKeys.some((p) => req.auth!.permissions.has(p));
    if (!hasAny) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

export function requireRole(...roleKeys: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Not authenticated" });
    if (!roleKeys.includes(req.auth.roleKey)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}
