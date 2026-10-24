import { AMC_CONTRACT_STATUS_LABELS } from "@recd/shared";

/** An AMC date arrives as a calendar day ("2027-01-14", UTC). Show it as that same day in every time zone - never shifted by the browser's. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
}

export function contractStatusLabel(status: string): string {
  return (AMC_CONTRACT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function contractStatusPill(status: string): string {
  if (status === "active" || status === "renewed") return "status-pill status-pill-success";
  if (status === "expiring_soon") return "status-pill status-pill-warning";
  if (status === "expired") return "status-pill status-pill-error";
  return "status-pill";
}

/** "12 days left", "ends today", "3 days ago" - the sentence beside the dates. */
export function daysText(status: string, daysRemaining: number): string {
  if (status === "upcoming") return "not started yet";
  if (status === "renewed") return "renewed - the new period has not started yet";
  if (daysRemaining === 0) return "ends today";
  if (daysRemaining > 0) return `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`;
  const ago = Math.abs(daysRemaining);
  return `expired ${ago} day${ago === 1 ? "" : "s"} ago`;
}

export interface AmcHistoryRow {
  id: string;
  kind: "renewal" | "correction";
  previousStartDate: string;
  previousEndDate: string;
  newStartDate: string;
  newEndDate: string;
  at: string;
  by: string | null;
  note: string | null;
}

/** The session key under which a login-time notice remembers what it has already shown. */
export const AMC_NOTICE_STORAGE_KEY = "recd_amc_notice_seen";

/** Alerts whose key has not been shown in this browser session yet (a renewed contract has a new key, so it is new again). */
export function unseenAlerts<T extends { key: string }>(alerts: T[], seen: string[]): T[] {
  const s = new Set(seen);
  return alerts.filter((a) => !s.has(a.key));
}
