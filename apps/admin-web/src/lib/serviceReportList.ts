import { SERVICE_REPORT_KIND, SERVICE_REPORT_STATUS } from "@recd/shared";

export const REPORT_LIST_PAGE_SIZE = 25;

export interface ReportListFilters {
  status: string;
  kind: string;
  q: string;
  offset: number;
}

export const EMPTY_REPORT_FILTERS: ReportListFilters = { status: "", kind: "", q: "", offset: 0 };

/** The query string for GET /service-reports (staff list). Empty / unknown filter values are left out; the API narrows by the caller's own scope on top. */
export function reportListQuery(f: ReportListFilters): string {
  const p = new URLSearchParams();
  if ((Object.values(SERVICE_REPORT_STATUS) as string[]).includes(f.status)) p.set("status", f.status);
  if ((Object.values(SERVICE_REPORT_KIND) as string[]).includes(f.kind)) p.set("kind", f.kind);
  const q = f.q.trim();
  if (q) p.set("q", q.slice(0, 100));
  p.set("limit", String(REPORT_LIST_PAGE_SIZE));
  p.set("offset", String(Math.max(0, Math.floor(f.offset) || 0)));
  return p.toString();
}

export interface ReportListRow {
  kind: "ticket" | "amc";
  ticketNumber: string | null;
  amc: { ref: string } | null;
}

/** What the row belongs to: the ticket number, or the AMC reference. */
export function reportSource(r: ReportListRow): string {
  if (r.kind === "amc") return r.amc?.ref ? `AMC ${r.amc.ref}` : "AMC";
  return r.ticketNumber ?? "Ticket";
}

/** "1-25 of 60", "0 of 0" - the range shown under the list. */
export function pageRange(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return "0 of 0";
  return `${offset + 1}-${offset + shown} of ${total}`;
}
