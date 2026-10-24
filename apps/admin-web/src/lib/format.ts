/**
 * Shared display formatters for money and dates (Indian locale conventions).
 *
 * The upstream fork kept these in a larger `lib/finance.ts` alongside invoice/quotation/PO
 * status labels and a number-to-words helper for printed invoices. Only these two generic
 * helpers are relevant here - this app has no finance module. See HANDOVER.md §24.
 */

export function formatINR(n: string | number | { toString(): string }): string {
  const num = typeof n === "object" ? parseFloat(n.toString()) : typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return "₹0.00";
  return "₹" + num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** Shown in place of a date that was never recorded (never a fabricated one such as 1/1/1970). */
export const DATE_NOT_RECORDED = "Date not recorded";
/** Shown in place of an amount that was never recorded; a genuine 0 is still shown as ₹0. */
export const VALUE_NOT_RECORDED = "—";

/** Same display as before (`toLocaleDateString()`), but a missing or unparsable date reads "Date not recorded". */
export function formatOptionalDate(d: string | Date | null | undefined, missing: string = DATE_NOT_RECORDED): string {
  if (d === null || d === undefined || d === "") return missing;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? missing : date.toLocaleDateString();
}

/** "₹8,50,000" for a recorded amount (including a genuine 0); "—" when the value was never recorded. */
export function formatOptionalRupees(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return VALUE_NOT_RECORDED;
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : VALUE_NOT_RECORDED;
}
