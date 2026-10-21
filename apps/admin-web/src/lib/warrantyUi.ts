import { WARRANTY_SOURCE_LABELS, WARRANTY_STATUS_LABELS } from "@recd/shared";

/** The warranty block the API attaches to a unit (apps/api/src/lib/warranty.ts describeWarranty). Dates are calendar days "YYYY-MM-DD". */
export interface UnitWarranty {
  startDate: string | null;
  endDate: string | null;
  durationMonths: number | null;
  source: string | null;
  status: "unknown" | "upcoming" | "active" | "expiring_soon" | "expired";
  daysRemaining: number | null;
  daysUntilStart: number | null;
  daysSinceExpiry: number | null;
}

export interface WarrantyHistoryRow {
  id: string;
  kind: "established" | "correction";
  previousStartDate: string | null;
  previousEndDate: string | null;
  previousMonths: number | null;
  newStartDate: string;
  newEndDate: string;
  newMonths: number | null;
  newSource: string;
  at: string;
  /** Staff only. */
  by?: string | null;
  reason?: string | null;
}

export function warrantyStatusLabel(status: string): string {
  return WARRANTY_STATUS_LABELS[status] ?? status;
}

export function warrantyStatusPill(status: string): string {
  if (status === "active") return "status-pill status-pill-success";
  if (status === "expiring_soon") return "status-pill status-pill-warning";
  if (status === "expired") return "status-pill status-pill-error";
  return "status-pill";
}

export function warrantySourceLabel(source: string | null): string {
  return source ? WARRANTY_SOURCE_LABELS[source] ?? source : "-";
}

/** The sentence beside the dates. An unknown warranty never gets a countdown; an expired one never a positive one. */
export function warrantyDaysText(w: Pick<UnitWarranty, "status" | "daysRemaining" | "daysUntilStart" | "daysSinceExpiry">): string {
  switch (w.status) {
    case "unknown": return "No warranty period has been recorded for this unit";
    case "upcoming": return w.daysUntilStart != null ? `starts in ${w.daysUntilStart} day${w.daysUntilStart === 1 ? "" : "s"}` : "not started yet";
    case "expired": return w.daysSinceExpiry != null ? `expired ${w.daysSinceExpiry} day${w.daysSinceExpiry === 1 ? "" : "s"} ago` : "expired";
    default:
      if (w.daysRemaining == null) return "";
      if (w.daysRemaining === 0) return "expires today";
      return `${w.daysRemaining} day${w.daysRemaining === 1 ? "" : "s"} left`;
  }
}

/** The session key under which the login-time warranty notice remembers what it has already shown. */
export const WARRANTY_NOTICE_STORAGE_KEY = "recd_warranty_notice_seen";

/** Notice text for the date range, used by the list, the portal and the notice. */
export function warrantyRange(w: Pick<UnitWarranty, "startDate" | "endDate">, fmt: (iso: string | null) => string): string {
  return w.startDate && w.endDate ? `${fmt(w.startDate)} to ${fmt(w.endDate)}` : "Not recorded";
}

/** Client-side check before submitting; the server repeats every rule. Returns a message or null. */
export function warrantyFormError(f: { startDate: string; endDate: string; months: string; reason: string; hasExisting: boolean }): string | null {
  if (!f.startDate) return "Enter the warranty start date";
  if (f.endDate && f.endDate < f.startDate) return "The warranty expiry date cannot be before the start date";
  if (f.months !== "") {
    const n = Number(f.months);
    if (!Number.isInteger(n) || n < 1 || n > 120) return "The duration must be a whole number of months from 1 to 120";
  }
  if (f.hasExisting && f.reason.trim().length < 3) return "Give a reason for changing the warranty dates";
  return null;
}
