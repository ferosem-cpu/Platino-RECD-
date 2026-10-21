/**
 * User-administration policy (Requirement 10), in ONE place so the API, the web app and the tests cannot disagree.
 * Everything here is pure. The API enforces it (apps/api/src/lib/userAdmin.ts); the web app only uses it to show sensible options -
 * hiding a control is never the protection.
 *
 * POLICY (least privilege; items marked REVIEW are decisions the mentor should confirm - see docs/HANDOVER.md):
 *  1. Only a Super Admin may grant the Super Admin role, and only a Super Admin may edit, change the role of, reset the password of,
 *     deactivate or reactivate a Super Admin account. Owner/Admin accounts may only be administered by a Super Admin or an Owner/Admin
 *     (PRIVILEGED_ROLE_ADMINISTRATORS below). `manage_users` alone never reaches either (REVIEW: Management and Owner/Admin ranking is a
 *     business decision; Management accounts stay manageable by Management and Owner/Admin).
 *  2. Nobody changes their own role or their own customer / vendor link, deactivates themselves or resets their own password through the
 *     administration routes (they use "change password").
 *  3. The last active Super Admin can never be demoted or deactivated.
 *  4. customer accounts belong to exactly one customer and are never vendor-scoped; erection engineers must belong to an approved vendor;
 *     every other staff role is never customer-scoped and keeps a vendor link only if it already had one for a reason other than being an
 *     erection engineer (REVIEW: no other role is documented as vendor-scoped).
 */
import { z } from "zod";
import { ROLE_KEY } from "./constants";

/** Normal form of an e-mail identity: surrounding whitespace removed, lower case. The database enforces uniqueness on the same form. */
export const normalizeEmail = (e: string): string => e.trim().toLowerCase();

/** An e-mail field that is normalised BEFORE validation, so " Example@Company.com " and "example@company.com" are one identity. */
export const emailField = z.string().trim().toLowerCase().email();

/**
 * Privileged roles and the ONLY roles allowed to grant them or to edit / reset / (de)activate / change the role of their accounts.
 * One table, so the policy has one obvious place to change. Anything not listed here is manageable by any `manage_users` holder.
 *  - super_admin: Super Admin only.
 *  - owner_admin: Super Admin or Owner/Admin. Management does NOT administer Owner/Admin accounts (a Management user could otherwise
 *    reset an Owner/Admin password, receive the temporary password and take the account over - a privilege escalation).
 * REVIEW (business decision, see docs/HANDOVER.md): Management is described as "Owner/Proprietor/CEO/CTO" in section 4, so whether it should
 * rank below Owner/Admin is not settled by the written requirements; the restriction above is the safe reading. Management accounts
 * are still manageable by Management and Owner/Admin (peers are not ranked against each other).
 */
export const PRIVILEGED_ROLE_ADMINISTRATORS: Readonly<Record<string, readonly string[]>> = {
  [ROLE_KEY.SUPER_ADMIN]: [ROLE_KEY.SUPER_ADMIN],
  [ROLE_KEY.OWNER_ADMIN]: [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN],
};

/** Roles whose accounts only a subset of administrators may touch (kept for callers that list them). */
export const SUPER_ADMIN_PROTECTED_ROLES: readonly string[] = Object.keys(PRIVILEGED_ROLE_ADMINISTRATORS);

const mayAdminister = (actorRoleKey: string, privilegedRoleKey: string): boolean => {
  const allowed = PRIVILEGED_ROLE_ADMINISTRATORS[privilegedRoleKey];
  return !allowed || allowed.includes(actorRoleKey);
};

/** May this actor give `roleKey` to someone? */
export function canAssignRole(actorRoleKey: string, roleKey: string): boolean {
  return mayAdminister(actorRoleKey, roleKey);
}

/** May this actor edit / reset / (de)activate / change the role of an account that currently holds `targetRoleKey`? */
export function canManageAccount(actorRoleKey: string, targetRoleKey: string): boolean {
  return mayAdminister(actorRoleKey, targetRoleKey);
}

/** The roles the actor may offer in a role picker (the server repeats the check). */
export function assignableRoleKeys<T extends { key: string }>(actorRoleKey: string, roles: T[]): T[] {
  return roles.filter((r) => canAssignRole(actorRoleKey, r.key));
}

/** Roles whose account must be linked to a vendor / to a customer. */
export const VENDOR_REQUIRED_ROLES: readonly string[] = [ROLE_KEY.ERECTION_ENGINEER];
export const CUSTOMER_REQUIRED_ROLES: readonly string[] = [ROLE_KEY.CUSTOMER];

export interface AssociationPlanInput {
  /** Current role (null when creating). */
  fromRole: string | null;
  toRole: string;
  current: { vendorId: string | null; customerId: string | null };
  /** undefined = not mentioned in the request (keep), null = remove, string = set. */
  requested: { vendorId?: string | null; customerId?: string | null };
}

export type AssociationPlan =
  | { ok: true; vendorId: string | null; customerId: string | null; vendorChanged: boolean; customerChanged: boolean }
  | { ok: false; error: string };

/**
 * The customer / vendor link a user ends up with after a create or an update. Clears only links the destination role cannot have:
 *  - destination customer: vendor link cleared, a customer link is REQUIRED;
 *  - destination erection engineer: a vendor link is REQUIRED, a customer link is cleared;
 *  - any other role: a customer link is cleared; a vendor link is kept, except that LEAVING the erection-engineer role drops the vendor
 *    link that role needed (it would otherwise keep restricting the account to one vendor's sites).
 * An explicit request to set a link the destination role cannot have is refused rather than ignored.
 */
export function planAssociations(i: AssociationPlanInput): AssociationPlan {
  let vendorId = i.requested.vendorId !== undefined ? i.requested.vendorId : i.current.vendorId;
  let customerId = i.requested.customerId !== undefined ? i.requested.customerId : i.current.customerId;
  const isCustomer = CUSTOMER_REQUIRED_ROLES.includes(i.toRole);
  const needsVendor = VENDOR_REQUIRED_ROLES.includes(i.toRole);

  if (isCustomer) {
    if (i.requested.vendorId) return { ok: false, error: "A customer account cannot belong to a vendor" };
    vendorId = null;
    if (!customerId) return { ok: false, error: "A customer account must be linked to a customer" };
  } else {
    if (i.requested.customerId) return { ok: false, error: "Only a customer account can be linked to a customer" };
    customerId = null;
    const leavingVendorRole = i.fromRole !== null && VENDOR_REQUIRED_ROLES.includes(i.fromRole) && !needsVendor;
    if (leavingVendorRole && i.requested.vendorId === undefined) vendorId = null;
    if (needsVendor && !vendorId) return { ok: false, error: "An erection engineer must be assigned to a vendor" };
  }
  return {
    ok: true,
    vendorId: vendorId ?? null,
    customerId: customerId ?? null,
    vendorChanged: (vendorId ?? null) !== (i.current.vendorId ?? null),
    customerChanged: (customerId ?? null) !== (i.current.customerId ?? null),
  };
}

/** A temporary / chosen password must be at least as long as the login form requires (loginSchema: 8). */
export const MIN_PASSWORD_LENGTH = 8;
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH, `New password must be at least ${MIN_PASSWORD_LENGTH} characters long`).max(200),
});
