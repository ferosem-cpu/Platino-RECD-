/**
 * User administration (Requirement 10): create, update, (de)activate and reset the password of an account. The routes in routes/users.ts
 * are thin; the rules live here and in packages/shared/src/userPolicy.ts (the policy), and every operation follows the same pattern:
 *  1. server-side authorisation against the actor's role (hierarchy, self rules) - a refusal is a 403 and is recorded as a DENIED event
 *     (never as a change);
 *  2. ONE transaction containing the change, the revocation of old sessions where the change is security-sensitive (tokenVersion + 1) and the
 *     MANDATORY audit row - if any of them fails, none of them happens;
 *  3. the checks that protect the last active Super Admin run in that transaction behind a database advisory lock, so two simultaneous
 *     requests cannot both pass the count and then each remove "another" administrator.
 * Nothing external (e-mail, network) happens inside a transaction; password hashing is done before it.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import {
  ROLE_KEY,
  USER_AUDIT_ACTION,
  VENDOR_STATUS,
  canAssignRole,
  canManageAccount,
  normalizeEmail,
  planAssociations,
  type UserAuditAction,
} from "@recd/shared";
import { prisma } from "./prisma";
import { diffFields, logUserAudit, logUserAuditStrict } from "./audit";
import { phoneHeldByAnother } from "./userPhone";
import { isUserEmailConflict, isUserPhoneConflict } from "./uniqueViolations";

export class UserAdminError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code?: string) {
    super(message);
    this.name = "UserAdminError";
  }
}

export const PHONE_IN_USE = "That mobile number is already used by another user";
export const EMAIL_IN_USE = "That email address is already used by another user (email addresses are not case-sensitive)";
const FORBIDDEN_SUPER_ADMIN = "Only a Super Admin can grant the Super Admin role or manage a Super Admin account; only a Super Admin or Owner/Admin can grant or manage an Owner/Admin account";

export interface Actor {
  userId: string;
  roleKey: string;
}

/** Cryptographically-secure temp password (96 bits). Math.random() must never be used for anything credential-shaped. */
export function generateTempPassword(): string {
  return crypto.randomBytes(12).toString("base64url");
}

const GUARD_LOCK = "platino:user-admin-guard";
/** Serialises every transaction that could remove an administrator. Released automatically at commit / rollback. */
async function lockAdminGuard(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${GUARD_LOCK}))`;
}
const activeSuperAdmins = (tx: Prisma.TransactionClient) => tx.user.count({ where: { role: { key: ROLE_KEY.SUPER_ADMIN }, isActive: true } });

/**
 * A refused privileged action is recorded as ACTION_DENIED (who tried what, why) - best effort and separate from the (rolled back) change,
 * so a rejection is never mistaken for a change. It never carries anything but operation names and the policy reason.
 */
async function recordDenied(actor: Actor, targetUserId: string | null, operation: string, reason: string, attempted?: Record<string, unknown>) {
  await logUserAudit(actor.userId, targetUserId ?? actor.userId, USER_AUDIT_ACTION.ACTION_DENIED, { operation, reason, ...(attempted ?? {}) });
}

async function denyIfNeeded<T>(actor: Actor, targetUserId: string | null, operation: string, run: () => Promise<T>, attempted?: Record<string, unknown>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UserAdminError && err.status === 403) await recordDenied(actor, targetUserId, operation, err.message, attempted);
    throw err;
  }
}

async function requireAssociationTargets(tx: Prisma.TransactionClient | typeof prisma, vendorId: string | null, customerId: string | null) {
  if (vendorId) {
    const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new UserAdminError(400, "Unknown vendor");
    if (vendor.status !== VENDOR_STATUS.APPROVED) throw new UserAdminError(400, "Vendor is not approved yet");
  }
  if (customerId) {
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new UserAdminError(400, "Unknown customer");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------------------------

export interface CreateUserInput {
  name: string;
  email: string;
  phone: string;
  roleKey: string;
  title?: string;
  vendorId?: string;
  customerId?: string;
}

export async function createUser(actor: Actor, input: CreateUserInput) {
  return denyIfNeeded(actor, null, "create_user", async () => {
    const role = await prisma.role.findUnique({ where: { key: input.roleKey } });
    if (!role) throw new UserAdminError(400, `Unknown role key: ${input.roleKey}`);
    if (!canAssignRole(actor.roleKey, role.key)) throw new UserAdminError(403, FORBIDDEN_SUPER_ADMIN);

    const plan = planAssociations({ fromRole: null, toRole: role.key, current: { vendorId: null, customerId: null }, requested: { vendorId: input.vendorId, customerId: input.customerId } });
    if (!plan.ok) throw new UserAdminError(400, plan.error);
    await requireAssociationTargets(prisma, plan.vendorId, plan.customerId);

    // Any user holding this number in any accepted stored format counts (staff, customer contact, vendor login).
    if (await phoneHeldByAnother(input.phone)) throw new UserAdminError(409, PHONE_IN_USE, "PHONE_IN_USE");

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const email = normalizeEmail(input.email);

    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: input.name,
            email,
            phone: input.phone,
            title: input.title?.trim() || null,
            roleId: role.id,
            vendorId: plan.vendorId,
            customerId: plan.customerId,
            passwordHash,
            // Force a change on first sign-in so the admin-relayed temp password can't linger as a permanent credential.
            mustChangePassword: true,
            createdById: actor.userId,
          },
        });
        await logUserAuditStrict(tx, actor.userId, created.id, USER_AUDIT_ACTION.CREATED, {
          role: role.key, email: created.email, phone: created.phone, vendorId: created.vendorId ?? null, customerId: created.customerId ?? null,
        });
        return created;
      });
      return { user, role, tempPassword };
    } catch (err) {
      // Two requests raced past the checks above: the unique indexes (phone; case-insensitive email) rejected the second.
      if (isUserPhoneConflict(err)) throw new UserAdminError(409, PHONE_IN_USE, "PHONE_IN_USE");
      if (isUserEmailConflict(err)) throw new UserAdminError(409, EMAIL_IN_USE, "EMAIL_IN_USE");
      throw err;
    }
  }, { role: input.roleKey });
}

// ---------------------------------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------------------------------

export interface UpdateUserInput {
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  roleKey?: string;
  vendorId?: string | null;
  customerId?: string | null;
}

export async function updateUser(actor: Actor, id: string, input: UpdateUserInput) {
  return denyIfNeeded(actor, id, "update_user", async () => {
    // The phone pre-check reads outside the transaction (the unique index is the final word, see the catch below).
    if (input.phone !== undefined && (await phoneHeldByAnother(input.phone, id))) throw new UserAdminError(409, PHONE_IN_USE, "PHONE_IN_USE");

    try {
      return await prisma.$transaction(async (tx) => {
        await lockAdminGuard(tx);
        const existing = await tx.user.findUnique({ where: { id }, include: { role: true } });
        if (!existing) throw new UserAdminError(404, "User not found");
        if (!canManageAccount(actor.roleKey, existing.role.key)) throw new UserAdminError(403, FORBIDDEN_SUPER_ADMIN);
        const self = id === actor.userId;

        // ---- role
        let role = existing.role;
        const roleChanging = input.roleKey !== undefined && input.roleKey !== existing.role.key;
        if (roleChanging) {
          const wanted = await tx.role.findUnique({ where: { key: input.roleKey! } });
          if (!wanted) throw new UserAdminError(400, `Unknown role key: ${input.roleKey}`);
          // The hierarchy is checked first, so an attempt to grant oneself (or anyone) a role above one's own is a refusal that is recorded.
          if (!canAssignRole(actor.roleKey, wanted.key)) throw new UserAdminError(403, FORBIDDEN_SUPER_ADMIN);
          if (self) throw new UserAdminError(400, "You cannot change your own role");
          if (existing.role.key === ROLE_KEY.SUPER_ADMIN && existing.isActive && (await activeSuperAdmins(tx)) <= 1) {
            throw new UserAdminError(400, "Cannot demote the last active Super Admin", "LAST_SUPER_ADMIN");
          }
          role = wanted;
        }

        // ---- customer / vendor links
        const plan = planAssociations({
          fromRole: existing.role.key,
          toRole: role.key,
          current: { vendorId: existing.vendorId, customerId: existing.customerId },
          requested: { vendorId: input.vendorId, customerId: input.customerId },
        });
        if (!plan.ok) throw new UserAdminError(400, plan.error);
        const associationChanged = plan.vendorChanged || plan.customerChanged;
        if (associationChanged && self) throw new UserAdminError(400, "You cannot change your own customer or vendor assignment");
        if (associationChanged) await requireAssociationTargets(tx, plan.vendorChanged ? plan.vendorId : null, plan.customerChanged ? plan.customerId : null);

        // ---- plain fields. Re-saving the same address in another spelling keeps the stored form (same identity, nothing to record).
        const data: Record<string, unknown> = {};
        if (input.name !== undefined && input.name !== existing.name) data.name = input.name;
        if (input.email !== undefined) {
          const email = normalizeEmail(input.email);
          if (!existing.email || normalizeEmail(existing.email) !== email) data.email = email;
        }
        if (input.phone !== undefined && input.phone !== existing.phone) data.phone = input.phone;
        // A blank title is "no title": the edit form always sends the field, so an untouched empty box must not look like a change.
        if (input.title !== undefined) {
          const title = input.title.trim() || null;
          if (title !== (existing.title ?? null)) data.title = title;
        }
        if (roleChanging) data.roleId = role.id;
        if (plan.vendorChanged) data.vendorId = plan.vendorId;
        if (plan.customerChanged) data.customerId = plan.customerId;
        if (Object.keys(data).length === 0) return { user: existing, changed: false as const };

        // A role or link change revokes the account's existing sessions at once.
        if (roleChanging || associationChanged) data.tokenVersion = { increment: 1 };
        const updated = await tx.user.update({ where: { id }, data, include: { role: true } });

        const changes = diffFields(
          { name: existing.name, email: existing.email, phone: existing.phone, title: existing.title, role: existing.role.key },
          { name: updated.name, email: updated.email, phone: updated.phone, title: updated.title, role: updated.role.key },
          ["name", "email", "phone", "title", "role"],
        );
        if (changes) await logUserAuditStrict(tx, actor.userId, id, roleChanging ? USER_AUDIT_ACTION.ROLE_CHANGED : USER_AUDIT_ACTION.UPDATED, changes);
        if (associationChanged) {
          const links = diffFields(
            { vendorId: existing.vendorId, customerId: existing.customerId },
            { vendorId: updated.vendorId, customerId: updated.customerId },
            ["vendorId", "customerId"],
          );
          if (links) await logUserAuditStrict(tx, actor.userId, id, USER_AUDIT_ACTION.ASSOCIATION_CHANGED, links);
        }
        return { user: updated, changed: true as const };
      });
    } catch (err) {
      if (isUserPhoneConflict(err)) throw new UserAdminError(409, PHONE_IN_USE, "PHONE_IN_USE");
      if (isUserEmailConflict(err)) throw new UserAdminError(409, EMAIL_IN_USE, "EMAIL_IN_USE");
      throw err;
    }
  }, input.roleKey !== undefined ? { requestedRole: input.roleKey } : undefined);
}

// ---------------------------------------------------------------------------------------------------------------------
// Deactivate / reactivate / reset password
// ---------------------------------------------------------------------------------------------------------------------

/** Deactivation and reactivation both revoke old sessions: a reactivated account must not resurrect tokens issued before it was switched off. */
export async function setUserActive(actor: Actor, id: string, active: boolean) {
  const operation = active ? "activate_user" : "deactivate_user";
  return denyIfNeeded(actor, id, operation, () =>
    prisma.$transaction(async (tx) => {
      await lockAdminGuard(tx);
      const existing = await tx.user.findUnique({ where: { id }, include: { role: true } });
      if (!existing) throw new UserAdminError(404, "User not found");
      if (!canManageAccount(actor.roleKey, existing.role.key)) throw new UserAdminError(403, FORBIDDEN_SUPER_ADMIN);
      if (!active) {
        if (id === actor.userId) throw new UserAdminError(400, "You cannot deactivate your own account");
        if (existing.role.key === ROLE_KEY.SUPER_ADMIN && existing.isActive && (await activeSuperAdmins(tx)) <= 1) {
          throw new UserAdminError(400, "Cannot deactivate the last active Super Admin", "LAST_SUPER_ADMIN");
        }
      }
      if (existing.isActive === active) return { user: existing, changed: false as const };
      const updated = await tx.user.update({ where: { id }, data: { isActive: active, tokenVersion: { increment: 1 } }, include: { role: true } });
      await logUserAuditStrict(tx, actor.userId, id, active ? USER_AUDIT_ACTION.ACTIVATED : USER_AUDIT_ACTION.DEACTIVATED);
      return { user: updated, changed: true as const };
    }),
  );
}

/** Generates a new temporary password, forces a change at next sign-in and revokes every existing session of that account. */
export async function resetUserPassword(actor: Actor, id: string) {
  return denyIfNeeded(actor, id, "reset_password", async () => {
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id }, include: { role: true } });
      if (!existing) throw new UserAdminError(404, "User not found");
      if (!canManageAccount(actor.roleKey, existing.role.key)) throw new UserAdminError(403, FORBIDDEN_SUPER_ADMIN);
      if (id === actor.userId) throw new UserAdminError(400, "Use Change password to change your own password");
      await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, tokenVersion: { increment: 1 } } });
      // The event records THAT a reset happened - never the password, the hash or a token.
      await logUserAuditStrict(tx, actor.userId, id, USER_AUDIT_ACTION.PASSWORD_RESET);
    });
    return { tempPassword };
  });
}

export type { UserAuditAction };
