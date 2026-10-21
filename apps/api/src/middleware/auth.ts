import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    roleKey: string;
    customerId?: string | null;
    vendorId?: string | null;
    permissions: Set<string>;
  };
}

/** Machine-readable code the web and mobile apps recognise: the account must set a new password before it may use anything else. */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

/**
 * Validates the bearer token and loads the CURRENT account (so activation, role and tokenVersion are never taken from the token alone).
 * An account flagged mustChangePassword is refused with 403 PASSWORD_CHANGE_REQUIRED on every route that uses `authenticate` - this is
 * the server-side boundary; the web AuthGuard redirect is only a convenience. The two routes that let the person actually complete the
 * change (GET /auth/me and POST /auth/change-password) use `authenticateAllowingPasswordChange` instead, which runs exactly the same
 * checks and only skips this one refusal. The flag is read from the database on every request, never from the token.
 */
export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => runAuthenticate(req, res, next, false);
export const authenticateAllowingPasswordChange = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  runAuthenticate(req, res, next, true);

async function runAuthenticate(req: AuthenticatedRequest, res: Response, next: NextFunction, allowPasswordChangePending: boolean) {
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
    // Revocation: a password reset / change, deactivation or reactivation, a role change or a customer / vendor link change bumps
    // User.tokenVersion, so every token issued before it stops working at once (a token without a version counts as 0).
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) return res.status(401).json({ error: "Your session is no longer valid - please sign in again" });

    if (user.mustChangePassword && !allowPasswordChangePending) {
      return res.status(403).json({ error: "You must change your password before continuing", code: PASSWORD_CHANGE_REQUIRED });
    }

    req.auth = {
      userId: user.id,
      roleKey: user.role.key,
      customerId: user.customerId,
      vendorId: user.vendorId,
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
