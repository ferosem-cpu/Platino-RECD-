/**
 * The API refuses every route except GET /auth/me and POST /auth/change-password with 403 and this code while the signed-in account is flagged
 * mustChangePassword (apps/api/src/middleware/auth.ts). Web and mobile use these helpers so they all recognise it the same way and send the
 * person to the password-change screen instead of retrying calls that can only fail.
 */
export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";

/** True for a failed-request body or an error object (with `status` / `body`) that carries the forced-change code. */
export function isPasswordChangeRequired(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const o = input as { code?: unknown; status?: unknown; body?: unknown };
  if (o.code === PASSWORD_CHANGE_REQUIRED_CODE) return true;
  return o.status === 403 && isPasswordChangeRequired(o.body) && (o.body as { code?: unknown }).code === PASSWORD_CHANGE_REQUIRED_CODE;
}
