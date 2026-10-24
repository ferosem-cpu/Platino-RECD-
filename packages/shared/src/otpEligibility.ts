import { PERMISSION_KEY, ROLE_KEY } from "./constants";

/**
 * Who may sign in with a mobile number and a WhatsApp code ALONE (POST /auth/otp/request and /auth/otp/verify, used by the mobile app).
 *
 * A code sent to a phone is a weaker proof than a password, and it also skips the forced password change flow and any password
 * hygiene. So the accounts that can administer the system must not be reachable that way: they keep email + password and Google sign-in.
 * This is the ONE place the rule lives; the API consults it both when a code is requested (no code is created or sent for a denied
 * account) and when one is verified (so a code created before a role change cannot open a privileged session).
 *
 * Denied, conservatively:
 *  - the three administrative roles by key, and
 *  - ANY role that holds one of the administrative permissions below (so a custom or renamed role with equivalent power is covered).
 * Everyone else keeps the existing behaviour (customer contacts, vendors, engineers, sales, finance ...). Roles that hold only
 * business permissions (manage_orders, manage_vendors, manage_amc_orders, manage_complaints) are allowed for now; whether any of them
 * should also be denied is a decision for the mentor (docs/HANDOVER.md).
 */
export const PHONE_OTP_DENIED_ROLE_KEYS: readonly string[] = [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT];

export const PHONE_OTP_DENIED_PERMISSION_KEYS: readonly string[] = [
  PERMISSION_KEY.MANAGE_USERS,
  PERMISSION_KEY.MANAGE_SETTINGS,
  PERMISSION_KEY.MANAGE_REGIONS,
  PERMISSION_KEY.MANAGE_WARRANTY,
];

export interface PhoneOtpSubject {
  role?: { key?: string | null; permissions?: Array<{ permission?: { key?: string | null } | null }> | null } | null;
}

export function isPhoneOtpLoginAllowed(subject: PhoneOtpSubject | null | undefined): boolean {
  const role = subject?.role;
  if (!role?.key) return false; // an account whose role cannot be established is never eligible
  if (PHONE_OTP_DENIED_ROLE_KEYS.includes(role.key)) return false;
  const held = (role.permissions ?? []).map((rp) => rp?.permission?.key);
  return !held.some((k) => !!k && PHONE_OTP_DENIED_PERMISSION_KEYS.includes(k));
}
