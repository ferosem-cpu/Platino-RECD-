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
