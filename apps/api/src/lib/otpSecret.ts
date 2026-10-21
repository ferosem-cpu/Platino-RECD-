/**
 * The key the OTP hashes (login and public) are computed with.
 *
 * OTP_HMAC_SECRET is OPTIONAL. When it is set the codes are keyed with it, so rotating the JWT signing secret no longer voids pending codes and a
 * leak of one secret does not hand over the other. When it is not set the key is JWT_SECRET exactly as before, so existing deployments keep
 * working with no change. A value that is set but shorter than 16 characters is refused outright (a weak key must never be used silently).
 *
 * Rotation: set or change OTP_HMAC_SECRET and every code that is pending at that moment stops verifying (codes live 5-10 minutes; people simply
 * request a new one). Nothing else is affected. Never put the value in source control or in logs.
 */
export const OTP_SECRET_MIN_LENGTH = 16;

export function otpHmacSecret(): string {
  const dedicated = process.env.OTP_HMAC_SECRET;
  if (dedicated !== undefined && dedicated !== "") {
    if (dedicated.length < OTP_SECRET_MIN_LENGTH) throw new Error(`OTP_HMAC_SECRET is set but shorter than ${OTP_SECRET_MIN_LENGTH} characters - refusing to hash codes with it.`);
    return dedicated;
  }
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("Neither OTP_HMAC_SECRET nor JWT_SECRET is set - cannot hash one-time codes.");
  return s;
}
