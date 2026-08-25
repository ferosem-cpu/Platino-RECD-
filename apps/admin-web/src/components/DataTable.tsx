"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/apiClient";

interface Company {
  legalName?: string | null;
  address?: string | null;
  city?: string | null;
  pinCode?: string | null;
  email?: string | null;
  website?: string | null;
  phone?: string | null;
  documentFooterNote?: string | null;
  logoDataUrl?: string | null;
}

/** "City, Pin Code" / "City" / "Pin Code" - whichever parts are set. */
function cityPinLine(company: Company | undefined): string {
  return [company?.city, company?.pinCode].filter(Boolean).join(" - ");
}

/** "email · website · phone" contact line - whichever parts are set. */
function contactLine(company: Company | undefined): string {
  return [company?.email, company?.website, company?.phone].filter(Boolean).join("  ·  ");
}

export interface DataTableColumn<T> {
  key: string;
  label: string;
  /** Raw value used for filtering (and as the default cell text if `render` is omitted). */
  accessor?: (row: T) => string | number | null | undefined;
  /**
   * For columns where a single row can have multiple values (e.g. several products at one
   * site via order line items) - the filter dropdown lists the union of every value across
   * all rows, and a row matches a selected filter if ANY of its values equals it. Takes
   * priority over `accessor` for filtering/dropdown options when set; `accessor` still
   * supplies the plain-text fallback for the cell and for print/CSV if no `render` is given.
   */
  accessorList?: (row: T) => (string | number | null | undefined)[];
  /** Custom cell renderer. Falls back to `accessor`'s value if omitted. */
  render?: (row: T) => React.ReactNode;
  /** Shown by default when the user has no saved preference yet. Default true. */
  defaultVisible?: boolean;
  /** Can't be hidden via the Columns menu (e.g. a primary "Name" or "Actions" column). */
  alwaysVisible?: boolean;
  /** Set false to hide the per-column filter control (e.g. an Actions column). Default true when `accessor` is set. */
  filterable?: boolean;
  /** "select" (default) shows a dropdown of the column's distinct values; "text" shows a free-text search box. */
  filterType?: "select" | "text";
  align?: "left" | "right";
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<T> {
  /** Unique id for this table, used as the localStorage key for column visibility. */
  storageKey: string;
  /** Page/table name, shown as the printed letterhead's title (e.g. "Sites"). */
  title: string;
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  /** Render prop for the mobile card list, given the same filtered rows the desktop table shows. */
  children?: (filteredRows: T[]) => React.ReactNode;
}

function defaultVisibility<T>(columns: DataTableColumn<T>[]): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  columns.forEach((c) => {
    defaults[c.key] = c.defaultVisible !== false;
  });
  return defaults;
}

function loadVisibility<T>(storageKey: string, columns: DataTableColumn<T>[]): Record<string, boolean> {
  const defaults = defaultVisibility(columns);
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(`zan-app:columns:${storageKey}`);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Record<string, boolean>;
    const merged = { ...defaults };
    for (const c of columns) {
      if (c.key in saved) merged[c.key] = saved[c.key];
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function DataTable<T>({ storageKey, title, columns, rows, rowKey, emptyMessage = "No records.", children }: DataTableProps<T>) {
  const [visible, setVisible] = useState<Record<string, boolean>>(() => loadVisibility(storageKey, columns));
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [company, setCompany] = useState<Company | undefined>(undefined);

  useEffect(() => {
    api<Company>("/settings").then(setCompany).catch(() => {});
  }, []);

  // The browser's own print header/footer prints document.title (top-centre) - set it to
  // this table's title while mounted so a printed page reads "Sites" instead of the app's
  // generic name. Doesn't remove the browser's
  // date/URL/page-number lines - only turning off "Headers and footers" in the print dialog
  // does that, which is a browser setting outside what page CSS can control.
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setColMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(`zan-app:columns:${storageKey}`, JSON.stringify(visible));
    } catch {
      // localStorage unavailable (private browsing, storage full) - visibility just won't persist
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, visible]);

  function toggleColumn(key: string) {
    setVisible((v) => ({ ...v, [key]: !(v[key] !== false) }));
  }

  const visibleColumns = columns.filter((c) => c.alwaysVisible || visible[c.key] !== false);
  const hasActiveFilters = Object.values(filters).some((v) => v && v.trim() !== "");

  const filteredRows = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v && v.trim() !== "");
    if (active.length === 0) return rows;
    return rows.filter((row) =>
      active.every(([key, val]) => {
        const col = columns.find((c) => c.key === key);
        if (!col?.accessor && !col?.accessorList) return true;
        if (col.accessorList) {
          const values = col.accessorList(row).map((v) => String(v ?? ""));
          return (col.filterType ?? "select") === "select"
            ? values.includes(val)
            : values.some((v) => v.toLowerCase().includes(val.trim().toLowerCase()));
        }
        const raw = String(col.accessor!(row) ?? "");
        if ((col.filterType ?? "select") === "select") {
          return raw === val;
        }
        return raw.toLowerCase().includes(val.trim().toLowerCase());
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, columns]);

  const columnOptions = useMemo(() => {
    const map: Record<string, string[]> = {};
    columns.forEach((c) => {
      if ((!c.accessor && !c.accessorList) || (c.filterType ?? "select") !== "select") return;
      const values = new Set<string>();
      rows.forEach((row) => {
        const raw = c.accessorList ? c.accessorList(row) : [c.accessor!(row)];
        raw.forEach((v) => {
          if (v === null || v === undefined || v === "") return;
          values.add(String(v));
        });
      });
      map[c.key] = Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns]);

  const printSubtitle = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v && v.trim() !== "");
    const countNote = `${filteredRows.length} of ${rows.length} row${rows.length === 1 ? "" : "s"}`;
    if (active.length === 0) return countNote;
    const parts = active.map(([key, val]) => `${columns.find((c) => c.key === key)?.label ?? key}: ${val}`);
    return `Filtered by ${parts.join(" · ")} — ${countNote}`;
  }, [filters, columns, filteredRows.length, rows.length]);

  const printColumns = visibleColumns.filter((c) => c.accessor || c.accessorList);

  function cellText(c: DataTableColumn<T>, row: T): string {
    if (c.accessorList) return c.accessorList(row).filter((v) => v !== null && v !== undefined && v !== "").join(", ") || "-";
    return String(c.accessor?.(row) ?? "-");
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-3 print:hidden">
        {hasActiveFilters && (
          <button onClick={() => setFilters({})} className="text-xs font-medium text-gray-500 hover:text-gray-700">
            Clear filters
          </button>
        )}
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          Print
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setColMenuOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
            Columns
          </button>
          {colMenuOpen && (
            <div className="absolute right-0 z-20 mt-1.5 w-56 rounded-lg border border-gray-200 bg-white py-1.5 shadow-lg">
              {columns.map((c) => (
                <label
                  key={c.key}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs ${c.alwaysVisible ? "opacity-50" : "cursor-pointer hover:bg-gray-50"}`}
                >
                  <input
                    type="checkbox"
                    checked={c.alwaysVisible || visible[c.key] !== false}
                    disabled={c.alwaysVisible}
                    onChange={() => toggleColumn(c.key)}
                    className="h-3.5 w-3.5 rounded border-gray-300"
                  />
                  {c.label}
                </label>
              ))}
              <div className="mt-1 border-t border-gray-100 pt-1">
                <button
                  onClick={() => setVisible(defaultVisibility(columns))}
                  className="w-full px-3 py-1.5 text-left text-xs font-medium hover:bg-gray-50"
                  style={{ color: "var(--theme-primary)" }}
                >
                  Reset to default
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="table-desktop print:hidden">
        <div className="table-scroll card overflow-hidden">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <tr>
                {visibleColumns.map((c) => (
                  <th key={c.key} className={`px-4 py-3 ${c.align === "right" ? "text-right" : ""} ${c.headerClassName ?? ""}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
              <tr className="border-b border-gray-100 bg-white">
                {visibleColumns.map((c) => (
                  <th key={c.key} className="px-4 py-1.5 font-normal">
                    {(c.accessor || c.accessorList) && c.filterable !== false ? (
                      (c.filterType ?? "select") === "select" ? (
                        <select
                          value={filters[c.key] ?? ""}
                          onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))}
                          className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-normal normal-case tracking-normal text-gray-700 focus:border-transparent focus:outline-none focus:ring-1"
                        >
                          <option value="">All</option>
                          {(columnOptions[c.key] ?? []).map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={filters[c.key] ?? ""}
                          onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))}
                          placeholder="Filter…"
                          className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-normal normal-case tracking-normal text-gray-700 focus:border-transparent focus:outline-none focus:ring-1"
                        />
                      )
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRows.map((row) => (
                <tr key={rowKey(row)} className="hover:bg-gray-50/60">
                  {visibleColumns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-3 ${c.align === "right" ? "whitespace-nowrap text-right" : ""} ${c.className ?? ""}`}
                    >
                      {c.render ? c.render(row) : cellText(c, row)}
                    </td>
                  ))}
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length || 1} className="px-4 py-8 text-center text-gray-400">
                    {rows.length === 0 ? emptyMessage : "No rows match the current filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="print:hidden">{children ? children(filteredRows) : null}</div>

      <div className="hidden print:block print-doc datatable-print">
        <div className="print-header">
          <div className="print-co-block">
            {company?.logoDataUrl ? <img src={company.logoDataUrl} alt="logo" className="h-9 object-contain mb-1.5" /> : null}
            <div className="print-co-name">{company?.legalName ?? "Your Company"}</div>
            <address>
              {company?.address}
              {cityPinLine(company) && <><br />{cityPinLine(company)}</>}
              {contactLine(company) && <><br />{contactLine(company)}</>}
            </address>
          </div>
          <div className="print-title-block">
            <div className="print-doc-title">{title}</div>
            <div className="print-meta">
              <div>{printSubtitle}</div>
              <div>Generated: <b>{new Date().toLocaleString()}</b></div>
            </div>
          </div>
        </div>

        <table className="print-table compact">
          <thead>
            <tr>
              {printColumns.map((c) => (
                <th key={c.key} className={c.align === "right" ? "num" : undefined}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={rowKey(row)}>
                {printColumns.map((c) => (
                  <td key={c.key} className={c.align === "right" ? "num" : undefined}>
                    {cellText(c, row)}
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={printColumns.length || 1}>{rows.length === 0 ? emptyMessage : "No rows match the current filters."}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="print-footer">
          <div className="print-footer-info">
            {company?.documentFooterNote && <div className="note">{company.documentFooterNote}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
