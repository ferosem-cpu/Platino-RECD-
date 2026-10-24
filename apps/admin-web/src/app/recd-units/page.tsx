"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { formatDay } from "@/lib/amcUi";
import { warrantyStatusLabel, warrantyStatusPill, type UnitWarranty } from "@/lib/warrantyUi";

interface UnitRow {
  id: string;
  serialNo: string | null;
  status: string;
  product: { name: string; model: string };
  order: { id: string; orderNumber: string; poNumber: string | null; customer: { name: string } };
  site: { id: string; companyName: string | null; dgModel: string | null; dgCapacityKva: string | number | null; region: { name: string } | null } | null;
  warranty: UnitWarranty;
}

export default function RecdUnitsPage() {
  return (
    <Suspense fallback={null}>
      <RecdUnitsInner />
    </Suspense>
  );
}

function RecdUnitsInner() {
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Debounce the search box so we don't hit the API on every keystroke.
    const t = setTimeout(() => {
      const q = new URLSearchParams();
      if (search.trim()) q.set("search", search.trim());
      if (pendingOnly) q.set("pending", "1");
      setLoading(true);
      api<UnitRow[]>(`/recd-units?${q.toString()}`)
        .then((rows) => { setUnits(rows); setError(null); })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load units"))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search, pendingOnly]);

  return (
    <div className="space-y-6 max-w-5xl" data-testid="recd-units-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>RECD units</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every physical RECD by its unique serial number, with the customer, site, DG set and region it belongs to. Open a unit for its service history, reports and AMC.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          className="field w-full sm:w-72 font-mono"
          placeholder="Search serial number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="recd-unit-search"
        />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
          Serial pending only
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
              <th className="px-3 py-2">Serial no.</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Site</th>
              <th className="px-3 py-2">DG set</th>
              <th className="px-3 py-2">Region</th>
              <th className="px-3 py-2">Order / PO</th>
              <th className="px-3 py-2">Warranty</th>
            </tr>
          </thead>
          <tbody>
            {units.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">{loading ? "Loading…" : "No units found."}</td></tr>
            )}
            {units.map((u) => (
              <tr key={u.id} className="border-b border-gray-50 last:border-0">
                <td className="px-3 py-2 font-mono text-xs font-semibold">
                  {u.serialNo ? (
                    <Link href={`/recd-units/${u.id}`} className="hover:underline">{u.serialNo}</Link>
                  ) : (
                    <Link href={`/recd-units/${u.id}`} className="text-amber-600 font-sans font-medium hover:underline" title="Legacy unit - the serial number has not been entered yet">
                      Serial not entered
                    </Link>
                  )}
                  {u.status === "retired" && <span className="badge ml-1">retired</span>}
                </td>
                <td className="px-3 py-2">{u.product.name} ({u.product.model})</td>
                <td className="px-3 py-2">{u.order.customer.name}</td>
                <td className="px-3 py-2">
                  {u.site ? <Link href={`/sites/${u.site.id}`} className="hover:underline">{u.site.companyName ?? "Not set"}</Link> : "—"}
                </td>
                <td className="px-3 py-2 text-xs">
                  {u.site?.dgModel || u.site?.dgCapacityKva != null
                    ? [u.site?.dgModel, u.site?.dgCapacityKva != null ? `${u.site.dgCapacityKva} kVA` : null].filter(Boolean).join(" · ")
                    : <span className="text-gray-400">Not recorded</span>}
                </td>
                <td className="px-3 py-2">{u.site?.region?.name ?? "—"}</td>
                <td className="px-3 py-2">
                  <Link href={`/orders/${u.order.id}`} className="font-mono text-xs hover:underline">{u.order.orderNumber}</Link>
                  {u.order.poNumber && <span className="text-xs text-gray-400"> · PO {u.order.poNumber}</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap" data-testid={`unit-warranty-${u.serialNo ?? u.id}`}>
                  <span className={warrantyStatusPill(u.warranty.status)}>{warrantyStatusLabel(u.warranty.status)}</span>
                  {u.warranty.endDate && <div className="text-[11px] text-gray-500 mt-0.5">to {formatDay(u.warranty.endDate)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
