"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";
import { downloadCsv } from "@/lib/csvExport";
import { ReportPrintHeader, ReportToolbar, useCompany } from "@/components/reports/ReportChrome";
import { formatDate, formatINR } from "@/lib/format";
import { HISTORY_CSV_HEADERS, SERIAL_MISSING_LABEL, complaintsOfCustomer, customerHistoryCsvRows, unitSerialLabel } from "@/lib/customerHistory";

interface CustomerListRow { id: string; name: string; }

interface CustomerDetail {
  id: string;
  name: string;
  address?: string | null;
  contacts: { name: string; phone: string | null; email: string | null }[];
  orders: {
    id: string;
    orderNumber: string;
    orderDate: string | null;
    value: string | null;
    product: { name: string };
    /** RECD units on the order (GET /customers/:id). A null serial is a legacy unit awaiting entry. */
    units: { id: string; serialNo: string | null; status: string }[];
    site: { id: string; companyName: string | null; currentStage: { label: string }; assignedEngineer: { name: string } | null; vendor: { name: string } | null } | null;
  }[];
}

interface ComplaintRow {
  id: string;
  ticketNumber: string;
  customerId: string;
  siteId: string | null;
  category: string;
  status: string;
  severity: string;
  createdAt: string;
  site: { companyName: string | null; order: { orderNumber: string } } | null;
  /** The RECD the ticket was raised against (GET /complaints); null on legacy tickets. */
  unit?: { id: string; serialNo: string | null } | null;
}

export default function CustomerHistoryReportPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("manage_orders");
  const canSeeComplaints = hasPermission("manage_complaints") || hasPermission("view_complaints_overview") || hasPermission("act_assigned_complaints") || hasPermission("raise_complaint");
  const company = useCompany();

  const [customers, setCustomers] = useState<CustomerListRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canView) return;
    api<CustomerListRow[]>("/customers").then(setCustomers).catch((e) => setError(e instanceof Error ? e.message : "Failed to load customers"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  useEffect(() => {
    if (!customerId) {
      setDetail(null);
      setComplaints([]);
      return;
    }
    setLoading(true);
    setError(null);
    const tasks: Promise<unknown>[] = [
      api<CustomerDetail>(`/customers/${customerId}`).then(setDetail),
    ];
    if (canSeeComplaints) {
      tasks.push(api<ComplaintRow[]>("/complaints").then((all) => setComplaints(complaintsOfCustomer(all, customerId))));
    } else setComplaints([]);
    Promise.all(tasks)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load customer history"))
      .finally(() => setLoading(false));
  }, [customerId, canSeeComplaints]);

  const totalOrderValue = useMemo(
    () => (detail?.orders ?? []).reduce((sum, o) => sum + (o.value ? Number(o.value) : 0), 0),
    [detail],
  );

  function exportCsv() {
    if (!detail) return;
    downloadCsv(`customer-history-${detail.name}`, HISTORY_CSV_HEADERS, customerHistoryCsvRows(detail.orders, complaints));
  }

  if (!canView) return <p className="text-sm text-gray-500 p-4">You don&apos;t have access to this report.</p>;
  if (error) return <p className="text-sm text-red-600 p-4">{error}</p>;

  return (
    <div className="space-y-4" data-testid="customer-history-report-page">
      <ReportToolbar onExportCsv={exportCsv} exportDisabled={!detail} />
      <ReportPrintHeader company={company} title="Customer / Order History Report" subtitle={detail?.name ?? "No customer selected"} />

      <div className="print:hidden">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>
          Customer / order history
        </h1>
        <p className="mt-1 text-sm text-gray-500">Pick a customer to see every order, site and complaint on record for them.</p>
      </div>

      <div className="card p-4 print:hidden max-w-md">
        <label className="text-xs font-medium text-gray-500">Customer</label>
        <select className="field w-full mt-1" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">Select a customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {detail && (
        <>
          <div className="card p-4">
            <h2 className="text-base font-semibold">{detail.name}</h2>
            <div className="mt-1 text-xs text-gray-500 space-y-0.5">
              {detail.address && <div>{detail.address}</div>}
              {detail.contacts.map((c, i) => (
                <div key={i}>{c.name}{c.phone ? ` · ${c.phone}` : ""}{c.email ? ` · ${c.email}` : ""}</div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 print:grid-cols-2">
            <Kpi label="Orders" value={String(detail.orders.length)} />
            <Kpi label="Total order value" value={formatINR(totalOrderValue)} />
          </div>

          <ReportTable title="Orders & sites" emptyLabel="No orders on record." rowCount={detail.orders.length}>
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 print:bg-transparent">
                <th className="px-4 py-3">Order #</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">RECD serial no.</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Order date</th>
                <th className="px-4 py-3 text-right">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {detail.orders.map((o) => (
                <tr key={o.id}>
                  <td className="px-4 py-3 font-mono text-xs">
                    {o.site ? (
                      <Link href={`/sites/${o.site.id}`} className="hover:underline print:no-underline print:text-inherit" style={{ color: "var(--theme-primary)" }}>{o.orderNumber}</Link>
                    ) : o.orderNumber}
                  </td>
                  <td className="px-4 py-3">{o.product.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {o.units.length === 0 ? "-" : o.units.map((u) => (
                      <div key={u.id}>
                        {u.serialNo ? (
                          <Link href={`/recd-units/${u.id}`} className="hover:underline print:no-underline print:text-inherit">{u.serialNo}</Link>
                        ) : <span className="text-amber-600 print:text-inherit">{SERIAL_MISSING_LABEL}</span>}
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-3">{o.site?.companyName ?? "-"}</td>
                  <td className="px-4 py-3">{o.site?.currentStage.label ?? "-"}</td>
                  <td className="px-4 py-3">{o.site?.vendor?.name ?? "-"}</td>
                  <td className="px-4 py-3">{o.orderDate ? formatDate(o.orderDate) : "-"}</td>
                  <td className="px-4 py-3 text-right">{o.value ? formatINR(o.value) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>

          {canSeeComplaints && (
            <ReportTable title="Complaints" emptyLabel="No complaints on record." rowCount={complaints.length}>
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 print:bg-transparent">
                  <th className="px-4 py-3">Ticket #</th>
                  <th className="px-4 py-3">RECD serial no.</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Raised</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {complaints.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 font-mono text-xs">{c.ticketNumber}</td>
                    <td className="px-4 py-3 font-mono text-xs">{c.unit ? unitSerialLabel(c.unit) : "-"}</td>
                    <td className="px-4 py-3">{c.site?.companyName ?? c.site?.order.orderNumber ?? "-"}</td>
                    <td className="px-4 py-3">{c.category.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 capitalize">{c.severity}</td>
                    <td className="px-4 py-3 capitalize">{c.status.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          )}
        </>
      )}
    </div>
  );
}

function ReportTable({ title, emptyLabel, rowCount, children }: { title: string; emptyLabel: string; rowCount: number; children: React.ReactNode }) {
  return (
    <div className="card overflow-hidden print:border-0 print:shadow-none print:break-inside-avoid">
      <div className="px-4 py-3 border-b"><h2 className="text-sm font-semibold">{title}</h2></div>
      <div className="table-scroll">
        <table className="w-full border-collapse text-sm">
          {children}
        </table>
        {rowCount === 0 && <p className="px-4 py-8 text-center text-sm text-gray-400">{emptyLabel}</p>}
      </div>
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="kpi-tile">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${warn ? "text-red-600" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}
