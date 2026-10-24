import { VENDOR_REQUIRED_ROLES, assignableRoleKeys, canManageAccount } from "@recd/shared";
import { apiErrorMessage } from "./apiError";

/**
 * Users page helpers (Requirement 10). They only decide what to SHOW: every rule is enforced by the API (apps/api/src/lib/userAdmin.ts) and
 * uses the same shared policy (packages/shared/src/userPolicy.ts), so a stale or hand-built request is refused regardless of this screen.
 */

/** The roles to offer in a role picker: what the signed-in person may assign, plus the account's current role so an edit never loses it. */
export function roleOptionsFor<T extends { key: string }>(actorRoleKey: string, roles: T[], currentRoleKey?: string): T[] {
  return roles.filter((r) => r.key === currentRoleKey || assignableRoleKeys(actorRoleKey, [r]).length > 0);
}

export interface RowActions {
  edit: boolean;
  reset: boolean;
  toggleActive: boolean;
  /** Why something is unavailable (shown as a tooltip), or null when everything is. */
  reason: string | null;
}

export const SUPER_ADMIN_ONLY_REASON = "Only a Super Admin can manage a Super Admin account, and only a Super Admin or Owner/Admin an Owner/Admin account";
export const OWN_ACCOUNT_REASON = "Use your own profile to change your password; you cannot deactivate yourself";

/** Which row actions to enable for the signed-in person. Self-service limits mirror the server's (no self reset / deactivation). */
export function rowActionsFor(actor: { id: string; roleKey: string } | null, row: { id: string; role: { key: string } }): RowActions {
  if (!actor) return { edit: false, reset: false, toggleActive: false, reason: null };
  if (!canManageAccount(actor.roleKey, row.role.key)) return { edit: false, reset: false, toggleActive: false, reason: SUPER_ADMIN_ONLY_REASON };
  const self = row.id === actor.id;
  return { edit: true, reset: !self, toggleActive: !self, reason: self ? OWN_ACCOUNT_REASON : null };
}

/** Does this role need a vendor to be chosen? */
export const roleNeedsVendor = (roleKey: string): boolean => VENDOR_REQUIRED_ROLES.includes(roleKey);

/**
 * Must the Vendor box be filled in the EDIT dialog? Yes when the person is being moved into a vendor-scoped role or already has a vendor (it
 * may be changed, not left empty). No for an existing internal erection engineer with no vendor whose role is unchanged: a name or phone edit must
 * not force a vendor on them (the server applies the same rule - planAssociations).
 */
export const vendorRequiredOnEdit = (current: { roleKey: string; vendorId?: string | null }, formRoleKey: string): boolean =>
  roleNeedsVendor(formRoleKey) && (formRoleKey !== current.roleKey || !!current.vendorId);

/** Message for a failed administrative request: the server's own wording for refusals (it never contains secrets), a short lead for sign-in problems. */
export function userAdminErrorMessage(err: unknown, fallback: string): string {
  const status = (err as { status?: unknown } | null)?.status;
  const base = apiErrorMessage(err, fallback);
  if (status === 403) return `Not allowed: ${base}`;
  if (status === 409) return base;
  if (status === 401) return "Your session is no longer valid - please sign in again.";
  return base;
}

/** Client-side email check before submit (the server normalises and repeats it); returns the address as it will be stored, or an error. */
export function checkEmailInput(raw: string): { ok: true; email: string } | { ok: false; error: string } {
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, error: "Enter an email address" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address" };
  return { ok: true, email };
}
