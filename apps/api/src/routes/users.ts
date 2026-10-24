import { Router, type Response } from "express";
import { createUserSchema, updateUserSchema, PERMISSION_KEY } from "@recd/shared";
import { asOptionalString, asString } from "../lib/params";
import { prisma } from "../lib/prisma";
import { UserAdminError, createUser, resetUserPassword, setUserActive, updateUser } from "../lib/userAdmin";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const usersRouter = Router();
usersRouter.use(authenticate);

/**
 * Every write below is authorised on the SERVER by lib/userAdmin.ts (role hierarchy, self rules, last active Super Admin) on top of the
 * manage_users permission - hiding a button in the web app is never the protection. Rules and the policy live in lib/userAdmin.ts and
 * packages/shared/src/userPolicy.ts.
 */
const actorOf = (req: AuthenticatedRequest) => ({ userId: req.auth!.userId, roleKey: req.auth!.roleKey });

/** Maps a policy / validation refusal to its HTTP answer; anything else is a real failure and goes to the error handler. */
function sendAdminError(res: Response, err: unknown) {
  if (err instanceof UserAdminError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
}

usersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (_req, res) => {
  const users = await prisma.user.findMany({
    include: { role: true, regionsManaged: { include: { region: { select: { id: true, name: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  // Never send the password hash or the session-revocation counter.
  res.json(users.map(({ passwordHash, tokenVersion, ...u }) => u));
});

/**
 * Adds a person and assigns a role - that role's predefined permission bundle applies. Only a Super Admin may grant the Super Admin role.
 * Customer accounts need a customerId; erection engineers need an approved vendor.
 */
usersRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { user, role, tempPassword } = await createUser(actorOf(req), parsed.data);
    // Phase 1: return the temp password in the response for the admin to relay manually.
    // Swap for a "set your password" email link once the email provider is fully wired up.
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: role.key, tempPassword });
  } catch (err) {
    return sendAdminError(res, err);
  }
});

usersRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { user } = await updateUser(actorOf(req), asString(req.params.id), parsed.data);
    const { passwordHash, tokenVersion, ...safe } = user;
    res.json(safe);
  } catch (err) {
    return sendAdminError(res, err);
  }
});

usersRouter.put("/:id/deactivate", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  try {
    const { user } = await setUserActive(actorOf(req), asString(req.params.id), false);
    const { passwordHash, tokenVersion, ...safe } = user;
    res.json(safe);
  } catch (err) {
    return sendAdminError(res, err);
  }
});

usersRouter.put("/:id/activate", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  try {
    const { user } = await setUserActive(actorOf(req), asString(req.params.id), true);
    const { passwordHash, tokenVersion, ...safe } = user;
    res.json(safe);
  } catch (err) {
    return sendAdminError(res, err);
  }
});

usersRouter.post("/:id/reset-password", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req: AuthenticatedRequest, res) => {
  try {
    res.json(await resetUserPassword(actorOf(req), asString(req.params.id)));
  } catch (err) {
    return sendAdminError(res, err);
  }
});

// Audit trail (creation, modification, role / link changes, activation, deactivation, resets, refused privileged actions)
usersRouter.get("/audit-log", requirePermission(PERMISSION_KEY.MANAGE_USERS), async (req, res) => {
  const userId = asOptionalString(req.query.userId);
  const rows = await prisma.userAuditLog.findMany({
    // By the recorded id as well, so the history of a deleted account stays reachable.
    where: userId ? { OR: [{ targetUserId: userId }, { targetIdRecorded: userId }] } : {},
    include: {
      actor: { select: { id: true, name: true } },
      target: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // A deleted account has no live row any more: show the name recorded when it was deleted.
  res.json(rows.map((r) => ({ ...r, target: r.target ?? { id: r.targetIdRecorded ?? "", name: r.targetName ?? "(deleted account)", email: null } })));
});
