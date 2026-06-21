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

function isStuck(updatedAt: string) {
  const days = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  return days > 2;
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
    <div>
      <h1 className="mb-4 text-xl font-semibold">Sites</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border-collapse overflow-hidden rounded-lg border border-gray-200 bg-white text-sm">
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
                {isStuck(s.updatedAt) ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
                    Stuck {Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 86400000)}d
                  </span>
                ) : (
                  new Date(s.updatedAt).toLocaleDateString()
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
