import { INDIAN_MOBILE_MESSAGE, normalizeIndianMobile } from "@recd/shared";

/**
 * Client-side check for a REQUIRED mobile-number field, using the same helper the API uses
 * (so the form and the server can never disagree). Returns the message to show, or null when
 * the value is acceptable. The API still validates every request on its own.
 */
export function mobileFieldError(value: string): string | null {
  if (!value.trim()) return "Mobile number is required";
  return normalizeIndianMobile(value) ? null : INDIAN_MOBILE_MESSAGE;
}

/** The 10-digit form the API stores. Only call after mobileFieldError() returned null. */
export function cleanMobile(value: string): string {
  const n = normalizeIndianMobile(value);
  if (!n) throw new Error(INDIAN_MOBILE_MESSAGE);
  return n;
}
