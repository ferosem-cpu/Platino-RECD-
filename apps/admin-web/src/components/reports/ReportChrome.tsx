"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";

interface Company {
  legalName?: string | null;
  logoDataUrl?: string | null;
}

/** Fetches company settings once, shared by every report's print header. */
export function useCompany(): Company | undefined {
  const [company, setCompany] = useState<Company | undefined>(undefined);
  useEffect(() => {
    api<Company>("/settings").then(setCompany).catch(() => {});
  }, []);
  return company;
}

/**
 * Only visible when printing (`hidden print:block`) — the on-screen page already has its own
 * h1/filters, but a printed page needs its own letterhead-style header since the sidebar and
 * on-screen filter controls are hidden (`print:hidden`) at print time.
 */
export function ReportPrintHeader({ company, title, subtitle }: { company: Company | undefined; title: string; subtitle: string }) {
  return (
    <div className="hidden print:flex items-start justify-between border-b border-gray-300 pb-3 mb-4">
      <div>
        {company?.logoDataUrl ? <img src={company.logoDataUrl} alt="logo" className="h-8 object-contain mb-1" /> : null}
        <div className="text-base font-semibold">{company?.legalName ?? "Company"}</div>
      </div>
      <div className="text-right">
        <div className="text-base font-semibold">{title}</div>
        <div className="text-xs text-gray-500">{subtitle}</div>
        <div className="text-xs text-gray-500">Generated {new Date().toLocaleString()}</div>
      </div>
    </div>
  );
}

/** Print / CSV export toolbar shown at the top of every report — hidden on the printed page itself. */
export function ReportToolbar({ onExportCsv, exportDisabled, backHref = "/reports" }: { onExportCsv?: () => void; exportDisabled?: boolean; backHref?: string }) {
  return (
    <div className="flex items-center justify-between print:hidden">
      <Link href={backHref} className="text-xs text-gray-500 hover:underline">&larr; All reports</Link>
      <div className="flex items-center gap-2">
        {onExportCsv && (
          <button
            onClick={onExportCsv}
            disabled={exportDisabled}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="report-export-csv"
          >
            Export CSV
          </button>
        )}
        <button onClick={() => window.print()} className="btn-primary px-3 py-1.5 text-xs" data-testid="report-print">
          Print
        </button>
      </div>
    </div>
  );
}
