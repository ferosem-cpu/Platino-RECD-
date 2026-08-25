"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { DataTable, DataTableColumn } from "@/components/DataTable";

interface SiteRow {
  id: string;
  address: string | null;
  companyName: string | null;
  currentStage: { label: string; phase: string };
  assignedEngineer: { name: string } | null;
  vendor: { name: string } | null;
  updatedAt: string;
  order: {
    orderNumber: string;
    customer: { name: string };
    product: { name: string; model: string } | null;
    lineItems: { product: { name: string; model: string } }[];
  };
  stageEvents: { statusOption: { label: string } }[];
}

/** All RECDs at this site's order - the base product plus any extra units added as
 * order line items (the "add another RECD unit -> same order" path). A site can have
 * more than one product this way without a second order, so any column/filter over
 * "which product is at this site" has to look at both, not just `order.product`. */
function allProducts(s: SiteRow): { name: string; model: string }[] {
  const base = s.order.product ? [s.order.product] : [];
  return [...base, ...s.order.lineItems.map((li) => li.product)];
}

function daysSince(updatedAt: string) {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000);
}
function isStuck(updatedAt: string) {
  return daysSince(updatedAt) > 2;
}

function updateStatus(s: SiteRow) {
  return s.stageEvents[0]?.statusOption.label ?? "No updates yet";
}

function LastUpdate({ updatedAt }: { updatedAt: string }) {
  if (isStuck(updatedAt)) {
    return (
      <span className="status-pill status-pill-error">
        Stuck {daysSince(updatedAt)}d
      </span>
    );
  }
  return (
    <span className="status-pill status-pill-success">
      {new Date(updatedAt).toLocaleDateString()}
    </span>
  );
}

const columns: DataTableColumn<SiteRow>[] = [
  {
    key: "orderNumber",
    label: "Order #",
    accessor: (s) => s.order.orderNumber,
    filterType: "text",
    render: (s) => (
      <Link href={`/sites/${s.id}`} className="font-mono text-xs font-semibold hover:underline" style={{ color: "var(--theme-primary)" }}>
        {s.order.orderNumber}
      </Link>
    ),
    alwaysVisible: true,
  },
  { key: "siteName", label: "Site name", accessor: (s) => s.companyName ?? "", filterType: "text" },
  { key: "address", label: "Address", accessor: (s) => s.address ?? "", filterType: "text" },
  { key: "customer", label: "Customer", accessor: (s) => s.order.customer.name },
  {
    key: "product",
    label: "Product",
    accessorList: (s) => allProducts(s).map((p) => `${p.name} (${p.model})`),
    render: (s) => {
      const products = allProducts(s);
      if (products.length === 0) return "-";
      return (
        <>
          {products.map((p, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {p.name} <span className="text-gray-400 font-mono text-xs">{p.model}</span>
            </span>
          ))}
        </>
      );
    },
  },
  { key: "stage", label: "Stage", accessor: (s) => s.currentStage.label },
  { key: "updateStatus", label: "Update status", accessor: (s) => updateStatus(s) },
  { key: "engineer", label: "Engineer", accessor: (s) => s.assignedEngineer?.name ?? "Unassigned" },
  { key: "vendor", label: "Vendor", accessor: (s) => s.vendor?.name ?? "Unassigned" },
  {
    key: "lastUpdate",
    label: "Last update",
    accessor: (s) => new Date(s.updatedAt).toLocaleDateString(),
    filterType: "text",
    render: (s) => <LastUpdate updatedAt={s.updatedAt} />,
  },
];

export default function SitesPage() {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SiteRow[]>("/sites")
      .then(setSites)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load sites"));
  }, []);

  return (
    <div className="space-y-4" data-testid="sites-page">
      <div className="print:hidden">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>
          Sites
        </h1>
        <p className="mt-1 text-sm text-gray-500">{sites.length} active sites</p>
      </div>
      {error && <p className="text-sm text-red-600 print:hidden">{error}</p>}

      <DataTable storageKey="sites" title="Sites" columns={columns} rows={sites} rowKey={(s) => s.id} emptyMessage="No sites.">
        {(filteredSites) => (
          <div className="cards-mobile" data-testid="sites-mobile-cards">
            {filteredSites.length === 0 ? (
              <div className="card p-6 text-center text-sm text-gray-400">
                {sites.length === 0 ? "No sites." : "No rows match the current filters."}
              </div>
            ) : (
              filteredSites.map((s) => (
                <Link
                  key={s.id}
                  href={`/sites/${s.id}`}
                  className="data-card block"
                  data-testid={`site-card-${s.order.orderNumber}`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <span className="font-mono text-xs font-semibold" style={{ color: "var(--theme-primary)" }}>{s.order.orderNumber}</span>
                    <LastUpdate updatedAt={s.updatedAt} />
                  </div>
                  <p className="text-sm font-semibold text-gray-900 truncate">{s.companyName ?? "Unnamed site"}</p>
                  <p className="text-xs text-gray-500 truncate">{s.order.customer.name}</p>
                  <p className="text-xs text-gray-500 mb-2">{s.currentStage.label} · {updateStatus(s)}</p>
                  {s.address && (
                    <div className="data-card-row">
                      <span className="label">Address</span>
                      <span className="value">{s.address}</span>
                    </div>
                  )}
                  <div className="data-card-row">
                    <span className="label">Product</span>
                    <span className="value">{allProducts(s).map((p) => `${p.name} (${p.model})`).join(", ") || "-"}</span>
                  </div>
                  <div className="data-card-row">
                    <span className="label">Engineer</span>
                    <span className="value">{s.assignedEngineer?.name ?? "Unassigned"}</span>
                  </div>
                  <div className="data-card-row">
                    <span className="label">Vendor</span>
                    <span className="value">{s.vendor?.name ?? "Unassigned"}</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        )}
      </DataTable>
    </div>
  );
}
