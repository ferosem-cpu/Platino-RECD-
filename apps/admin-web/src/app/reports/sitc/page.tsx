"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";
import { downloadCsv } from "@/lib/csvExport";
import { ReportPrintHeader, ReportToolbar, useCompany } from "@/components/reports/ReportChrome";
import { formatDate } from "@/lib/format";

const SITC_PHASE_LABEL: Record<string, string> = {
  SUPPLY: "Supply",
  INSTALLATION: "Installation",
  TESTING: "Testing",
  COMMISSIONING: "Commissioning",
};

interface SiteRow {
  id: string;
  address: string | null;
  companyName: string | null;
  currentStage: { label: string; phase: string };
  assignedEngineer: { name: string } | null;
  vendor: { id: string; name: string } | null;
  updatedAt: string;
  order: { orderNumber: string; orderDate: string | null; customer: { id: string; name: string } };
}

interface Customer { id: string; name: string; }
interface Vendor { id: string; name: string; }

export default function SitcStatusReportPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("view_site_status");
  const company = useCompany();

  const [sites, setSites] = useState<SiteRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [phase, setPhase] = useState("");

  useEffect(() => {
    if (!canView) return;
    api<SiteRow[]>("/sites").then(setSites).catch((e) => setError(e instanceof Error ? e.message : "Failed to load sites"));
    api<Customer[]>("/customers").then(setCustomers).catch(() => {});
    if (hasPermission("manage_vendors")) api<Vendor[]>("/vendors").then(setVendors).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  const rows = useMemo(() => {
    return sites.filter((s) => {
      if (customerId && s.order.customer.id !== customerId) return false;
      if (vendorId && s.vendor?.id !== vendorId) return false;
      if (phase && s.currentStage.phase !== phase) return false;
      if (from || to) {
        if (!s.order.orderDate) return false;
        const d = s.order.orderDate.slice(0, 10);
        if (from && d < from) return false;
        if (to && d > to) return false;
      }
      return true;
    });
  }, [sites, customerId, vendorId, phase, from, to]);

  const filterSummary = [
    from && `From ${from}`,
    to && `To ${to}`,
    customerId && `Customer: ${customers.find((c) => c.id === customerId)?.name ?? ""}`,
    vendorId && `Vendor: ${vendors.find((v) => v.id === vendorId)?.name ?? ""}`,
    phase && `Stage: ${SITC_PHASE_LABEL[phase] ?? phase}`,
  ].filter(Boolean).join(" · ") || "All sites";

  function exportCsv() {
    downloadCsv(
      "sitc-status-report",
      ["Order #", "Site name", "Address", "Customer", "Stage", "Phase", "Vendor", "Engineer", "Order date", "Last update"],
      rows.map((s) => [
        s.order.orderNumber,
        s.companyName ?? "",
        s.address ?? "",
        s.order.customer.name,
        s.currentStage.label,
        SITC_PHASE_LABEL[s.currentStage.phase] ?? s.currentStage.phase,
        s.vendor?.name ?? "",
        s.assignedEngineer?.name ?? "Unassigned",
        s.order.orderDate ? formatDate(s.order.orderDate) : "",
        formatDate(s.updatedAt),
      ]),
    );
  }

  if (!canView) return <p className="text-sm text-gray-500 p-4">You don&apos;t have access to this report.</p>;
  if (error) return <p className="text-sm text-red-600 p-4">{error}</p>;

  return (
    <div className="space-y-4" data-testid="sitc-report-page">
      <ReportToolbar onExportCsv={exportCsv} exportDisabled={rows.length === 0} />
      <ReportPrintHeader company={company} title="Sites / SITC Status Report" subtitle={filterSummary} />

      <div className="print:hidden">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>
          Sites / SITC status
        </h1>
        <p className="mt-1 text-sm text-gray-500">{rows.length} of {sites.length} sites</p>
      </div>

      <div className="card p-4 print:hidden grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div>
          <label className="text-xs font-medium text-gray-500">From (order date)</label>
          <input type="date" className="field w-full mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">To (order date)</label>
          <input type="date" className="field w-full mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">Customer</label>
          <select className="field w-full mt-1" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {vendors.length > 0 && (
          <div>
            <label className="text-xs font-medium text-gray-500">Vendor</label>
            <select className="field w-full mt-1" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">All vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="text-xs font-medium text-gray-500">Stage / phase</label>
          <select className="field w-full mt-1" value={phase} onChange={(e) => setPhase(e.target.value)}>
            <option value="">All phases</option>
            {Object.entries(SITC_PHASE_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      </div>

      <div className="card overflow-hidden print:border-0 print:shadow-none">
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 print:bg-transparent">
                <th className="px-4 py-3">Order #</th>
                <th className="px-4 py-3">Site name</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Engineer</th>
                <th className="px-4 py-3">Order date</th>
                <th className="px-4 py-3">Last update</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/sites/${s.id}`} className="hover:underline print:no-underline print:text-inherit" style={{ color: "var(--theme-primary)" }}>
                      {s.order.orderNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{s.companyName ?? "-"}</td>
                  <td className="px-4 py-3">{s.order.customer.name}</td>
                  <td className="px-4 py-3">{s.currentStage.label}</td>
                  <td className="px-4 py-3">{s.vendor?.name ?? "-"}</td>
                  <td className="px-4 py-3">{s.assignedEngineer?.name ?? "Unassigned"}</td>
                  <td className="px-4 py-3">{s.order.orderDate ? formatDate(s.order.orderDate) : "-"}</td>
                  <td className="px-4 py-3">{formatDate(s.updatedAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No sites match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
