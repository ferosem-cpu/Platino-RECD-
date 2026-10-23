"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SERVICE_REPORT_KIND, SERVICE_REPORT_STATUS, SERVICE_REPORT_STATUS_LABELS, type ServiceReportStatus } from "@recd/shared";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { downloadReportPdf } from "@/lib/reportFiles";
import { reportStatusPill } from "@/lib/serviceReportUi";
import { useAuth } from "@/components/AuthContext";
import { EMPTY_REPORT_FILTERS, REPORT_LIST_PAGE_SIZE, pageRange, reportListQuery, reportSource, type ReportListFilters } from "@/lib/serviceReportList";

interface Row {
  id: string;
  reportNumber: string;
  kind: "ticket" | "amc";
  ticketNumber: string | null;
  amc: { ref: string } | null;
  customerName?: string;
  siteName?: string | null;
  unitSerial?: string | null;
  unitSerialNo: string | null;
  status: ServiceReportStatus;
  visitDate: string;
  engineer: { name: string };
  pdfAvailable: boolean;
}

/**
 * All service reports the signed-in user may see. Staff: the scoped list from GET /service-reports (their role and region / vendor / assignment
 * decide the rows, on the server), with status, kind and free-text filters. A customer: their own reports that have left draft (GET /mine).
 * Nothing here widens access - the API authorises every row.
 */
export default function AllServiceReports() {
  const { user } = useAuth();
  const isCustomer = user?.role.key === "customer";
  const [filters, setFilters] = useState<ReportListFilters>(EMPTY_REPORT_FILTERS);
  const [typed, setTyped] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!user) return;
    setError(null);
    const request = isCustomer
      ? api<{ reports: Row[] }>("/service-reports/mine").then((r) => ({ reports: r.reports, total: r.reports.length }))
      : api<{ reports: Row[]; total: number }>(`/service-reports?${reportListQuery(filters)}`);
    request
      .then((r) => {
        setRows(r.reports);
        setTotal(r.total);
      })
      .catch((err) => {
        setRows([]);
        setTotal(0);
        setError(apiErrorMessage(err, "Could not load the service reports."));
      });
  }, [user, isCustomer, filters]);
  useEffect(load, [load]);

  async function download(r: Row) {
    setDownloadError(null);
    try {
      await downloadReportPdf(r.id, r.reportNumber);
    } catch (err) {
      setDownloadError(apiErrorMessage(err, "Could not download the report."));
    }
  }

  const set = (patch: Partial<ReportListFilters>) => setFilters((f) => ({ ...f, offset: 0, ...patch }));

  return (
    <div className="space-y-5 max-w-5xl" data-testid="all-service-reports">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Service reports</h1>
        <p className="mt-1 text-sm text-gray-500">
          {isCustomer
            ? "Your service reports. Open one to review it and, where asked, sign it."
            : "Service reports on tickets and AMC visits that you are allowed to see. Start a new report from the ticket or the AMC order."}
        </p>
      </div>

      {!isCustomer && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-200 bg-white p-3"
          data-testid="report-filters"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: typed });
          }}
        >
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Search</label>
            <input
              className="field"
              placeholder="Report, ticket, serial, customer, site"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Search service reports"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Status</label>
            <select className="field" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
              <option value="">All</option>
              {Object.values(SERVICE_REPORT_STATUS).map((s) => (
                <option key={s} value={s}>{SERVICE_REPORT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Type</label>
            <select className="field" value={filters.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Type">
              <option value="">Tickets and AMC</option>
              <option value={SERVICE_REPORT_KIND.TICKET}>Ticket reports</option>
              <option value={SERVICE_REPORT_KIND.AMC}>AMC reports</option>
            </select>
          </div>
          <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50">Search</button>
          {(filters.q || filters.status || filters.kind) && (
            <button type="button" className="text-xs font-medium text-gray-500 hover:underline" onClick={() => { setTyped(""); setFilters(EMPTY_REPORT_FILTERS); }}>
              Clear filters
            </button>
          )}
        </form>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {downloadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{downloadError}</p>}
      {rows === null && <p className="text-sm text-gray-500" data-testid="reports-loading">Loading service reports…</p>}
      {rows && rows.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500" data-testid="reports-empty">
          No service reports found.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm" data-testid="reports-table">
            <thead className="bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">Report</th>
                <th className="px-3 py-2">For</th>
                {!isCustomer && <th className="px-3 py-2">Customer / site</th>}
                <th className="px-3 py-2">RECD serial</th>
                <th className="px-3 py-2">Visit</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100" data-testid={`report-row-${r.reportNumber}`}>
                  <td className="px-3 py-2">
                    <Link href={`/service-reports/${r.id}`} className="font-mono font-bold text-[var(--theme-primary)] hover:underline">{r.reportNumber}</Link>
                  </td>
                  <td className="px-3 py-2">{reportSource(r)}</td>
                  {!isCustomer && (
                    <td className="px-3 py-2">
                      <div>{r.customerName ?? "-"}</div>
                      <div className="text-xs text-gray-500">{r.siteName ?? "No site"}</div>
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono text-xs">{r.unitSerial ?? r.unitSerialNo ?? "Serial not entered"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.visitDate}<div className="text-xs text-gray-500">{r.engineer.name}</div></td>
                  <td className="px-3 py-2"><span className={reportStatusPill(r.status)}>{SERVICE_REPORT_STATUS_LABELS[r.status] ?? r.status}</span></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.pdfAvailable && (
                      <button onClick={() => download(r)} className="mr-3 text-xs font-medium text-[var(--theme-accent)] hover:underline">
                        PDF
                      </button>
                    )}
                    <Link href={`/service-reports/${r.id}`} className="text-xs font-medium text-gray-600 hover:underline">Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isCustomer && rows && total > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-500" data-testid="reports-paging">
          <span>{pageRange(filters.offset, rows.length, total)}</span>
          <span className="flex gap-3">
            <button disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - REPORT_LIST_PAGE_SIZE) }))} className="font-medium disabled:opacity-40">Previous</button>
            <button disabled={filters.offset + rows.length >= total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + REPORT_LIST_PAGE_SIZE }))} className="font-medium disabled:opacity-40">Next</button>
          </span>
        </div>
      )}
    </div>
  );
}
