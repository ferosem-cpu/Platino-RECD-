"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/apiClient";

interface SiteRow {
  id: string;
  address: string | null;
  currentStage: { label: string; phase: string };
  assignedEngineer: { name: string } | null;
  updatedAt: string;
  order: { orderNumber: string; customer: { name: string } };
}

function daysSince(updatedAt: string) {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000);
}
function isStuck(updatedAt: string) {
  return daysSince(updatedAt) > 2;
}

function LastUpdate({ updatedAt }: { updatedAt: string }) {
  if (isStuck(updatedAt)) {
    return (
      <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 text-xs whitespace-nowrap">
        Stuck {daysSince(updatedAt)}d
      </span>
    );
  }
  return <span className="text-sm text-gray-600">{new Date(updatedAt).toLocaleDateString()}</span>;
}

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
      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Sites</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Desktop table */}
      <div className="table-desktop">
        <div className="table-scroll overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2">Order #</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Stage</th>
                <th className="px-4 py-2">Engineer</th>
                <th className="px-4 py-2">Last update</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium">
                    <Link href={`/sites/${s.id}`} className="text-blue-600 hover:underline">
                      {s.order.orderNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{s.order.customer.name}</td>
                  <td className="px-4 py-2">{s.currentStage.label}</td>
                  <td className="px-4 py-2">{s.assignedEngineer?.name ?? "Unassigned"}</td>
                  <td className="px-4 py-2">
                    <LastUpdate updatedAt={s.updatedAt} />
                  </td>
                </tr>
              ))}
              {sites.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">No sites.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="cards-mobile" data-testid="sites-mobile-cards">
        {sites.length === 0 ? (
          <div className="card p-6 text-center text-sm text-gray-400">No sites.</div>
        ) : (
          sites.map((s) => (
            <Link
              key={s.id}
              href={`/sites/${s.id}`}
              className="data-card block hover:border-gray-300 transition-colors"
              data-testid={`site-card-${s.order.orderNumber}`}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="font-mono text-xs font-semibold text-blue-600">{s.order.orderNumber}</span>
                <LastUpdate updatedAt={s.updatedAt} />
              </div>
              <p className="text-sm font-semibold text-gray-900 truncate">{s.order.customer.name}</p>
              <p className="text-xs text-gray-500 mb-2">{s.currentStage.label} · {s.currentStage.phase}</p>
              <div className="data-card-row">
                <span className="label">Engineer</span>
                <span className="value">{s.assignedEngineer?.name ?? "Unassigned"}</span>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
