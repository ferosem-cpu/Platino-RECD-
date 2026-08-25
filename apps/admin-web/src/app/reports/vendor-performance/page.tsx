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

interface VendorRow {
  id: string;
  name: string;
  status: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string | null;
  _count: { members: number; sites: number };
}

interface SiteRow {
  id: string;
  companyName: string | null;
  currentStage: { label: string; phase: string };
  assignedEngineer: { name: string } | null;
  vendor: { id: string } | null;
  updatedAt: string;
  order: { orderNumber: string; orderDate: string | null; customer: { name: string } };
}

interface ComplaintRow {
  id: string;
  ticketNumber: string;
  siteId: string | null;
  category: string;
  status: string;
  severity: string;
  createdAt: string;
  site: { companyName: string | null; order: { orderNumber: string } } | null;
}

export default function VendorPerformanceReportPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("manage_vendors");
  const company = useCompany();

  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    api<VendorRow[]>("/vendors").then(setVendors).catch((e) => setError(e instanceof Error ? e.message : "Failed to load vendors"));
    api<SiteRow[]>("/sites").then(setSites).catch(() => {});
    api<ComplaintRow[]>("/complaints").then(setComplaints).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  const vendor = vendors.find((v) => v.id === vendorId) ?? null;
  const vendorSites = useMemo(() => sites.filter((s) => s.vendor?.id === vendorId), [sites, vendorId]);
  const vendorSiteIds = useMemo(() => new Set(vendorSites.map((s) => s.id)), [vendorSites]);
  const vendorComplaints = useMemo(() => complaints.filter((c) => c.siteId && vendorSiteIds.has(c.siteId)), [complaints, vendorSiteIds]);

  const stageBreakdown = useMemo(() => {
    const counts: Record<string, number> = { SUPPLY: 0, INSTALLATION: 0, TESTING: 0, COMMISSIONING: 0 };
    for (const s of vendorSites) counts[s.currentStage.phase] = (counts[s.currentStage.phase] ?? 0) + 1;
    return counts;
  }, [vendorSites]);

  function exportCsv() {
    if (!vendor) return;
    downloadCsv(`vendor-performance-${vendor.name}`, ["Order #", "Customer", "Site", "Stage", "Engineer", "Order date", "Last update"], vendorSites.map((s) => [
      s.order.orderNumber, s.order.customer.name, s.companyName ?? "", s.currentStage.label, s.assignedEngineer?.name ?? "Unassigned",
      s.order.orderDate ? formatDate(s.order.orderDate) : "", formatDate(s.updatedAt),
    ]));
  }

  if (!canView) return <p className="text-sm text-gray-500 p-4">You don&apos;t have access to this report.</p>;
  if (error) return <p className="text-sm text-red-600 p-4">{error}</p>;

  return (
    <div className="space-y-4" data-testid="vendor-performance-report-page">
      <ReportToolbar onExportCsv={exportCsv} exportDisabled={!vendor} />
      <ReportPrintHeader company={company} title="Vendor Performance Report" subtitle={vendor?.name ?? "No vendor selected"} />

      <div className="print:hidden">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>
          Vendor performance
        </h1>
        <p className="mt-1 text-sm text-gray-500">Pick a vendor to see every site assigned to them, stage breakdown and complaints raised.</p>
      </div>

      <div className="card p-4 print:hidden max-w-md">
        <label className="text-xs font-medium text-gray-500">Vendor</label>
        <select className="field w-full mt-1" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          <option value="">Select a vendor…</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.status !== "approved" ? ` (${v.status})` : ""}</option>)}
        </select>
      </div>

      {vendor && (
        <>
          <div className="card p-4">
            <h2 className="text-base font-semibold">{vendor.name}</h2>
            <div className="mt-1 text-xs text-gray-500 space-y-0.5">
              {vendor.address && <div>{vendor.address}</div>}
              <div>{vendor.contactName} · {vendor.contactEmail}{vendor.contactPhone ? ` · ${vendor.contactPhone}` : ""}</div>
              <div className="capitalize">Status: {vendor.status}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 print:grid-cols-4">
            {Object.entries(SITC_PHASE_LABEL).map(([key, label]) => (
              <Kpi key={key} label={label} value={String(stageBreakdown[key] ?? 0)} />
            ))}
          </div>

          <div className="card overflow-hidden print:border-0 print:shadow-none print:break-inside-avoid">
            <div className="px-4 py-3 border-b"><h2 className="text-sm font-semibold">Assigned sites ({vendorSites.length})</h2></div>
            <div className="table-scroll">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 print:bg-transparent">
                    <th className="px-4 py-3">Order #</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Site</th>
                    <th className="px-4 py-3">Stage</th>
                    <th className="px-4 py-3">Engineer</th>
                    <th className="px-4 py-3">Order date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {vendorSites.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link href={`/sites/${s.id}`} className="hover:underline print:no-underline print:text-inherit" style={{ color: "var(--theme-primary)" }}>{s.order.orderNumber}</Link>
                      </td>
                      <td className="px-4 py-3">{s.order.customer.name}</td>
                      <td className="px-4 py-3">{s.companyName ?? "-"}</td>
                      <td className="px-4 py-3">{s.currentStage.label}</td>
                      <td className="px-4 py-3">{s.assignedEngineer?.name ?? "Unassigned"}</td>
                      <td className="px-4 py-3">{s.order.orderDate ? formatDate(s.order.orderDate) : "-"}</td>
                    </tr>
                  ))}
                  {vendorSites.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No sites assigned to this vendor.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card overflow-hidden print:border-0 print:shadow-none print:break-inside-avoid">
            <div className="px-4 py-3 border-b"><h2 className="text-sm font-semibold">Complaints on their sites ({vendorComplaints.length})</h2></div>
            <div className="table-scroll">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 print:bg-transparent">
                    <th className="px-4 py-3">Ticket #</th>
                    <th className="px-4 py-3">Site</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Severity</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Raised</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {vendorComplaints.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3 font-mono text-xs">{c.ticketNumber}</td>
                      <td className="px-4 py-3">{c.site?.companyName ?? c.site?.order.orderNumber ?? "-"}</td>
                      <td className="px-4 py-3">{c.category.replace(/_/g, " ")}</td>
                      <td className="px-4 py-3 capitalize">{c.severity}</td>
                      <td className="px-4 py-3 capitalize">{c.status.replace(/_/g, " ")}</td>
                      <td className="px-4 py-3">{formatDate(c.createdAt)}</td>
                    </tr>
                  ))}
                  {vendorComplaints.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No complaints on this vendor&apos;s sites.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi-tile">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold mt-1 text-gray-900">{value}</p>
    </div>
  );
}
