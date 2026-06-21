"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

interface ComplaintRow {
  id: string;
  ticketNumber: string;
  category: string;
  severity: string;
  status: string;
  createdAt: string;
}

interface Overview {
  countsByStatus: Record<string, number>;
}

export default function ComplaintsPage() {
  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ComplaintRow[]>("/complaints").then(setComplaints).catch(() => {});
    api<Overview>("/complaints/overview")
      .then(setOverview)
      .catch((err) => setError(err instanceof Error ? err.message : "Overview unavailable"));
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Complaints</h1>

      {overview && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-gray-600">Company-wide, by status</h2>
          <div className="grid grid-cols-4 gap-3">
            {Object.entries(overview.countsByStatus).map(([status, count]) => (
              <div key={status} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="text-xl font-semibold">{count}</div>
                <div className="text-xs capitalize text-gray-500">{status.replaceAll("_", " ")}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      {error && <p className="text-sm text-gray-400">{error} (visible to Owner/Admin and Management only)</p>}

      <table className="w-full border-collapse overflow-hidden rounded-lg border border-gray-200 bg-white text-sm">
        <thead className="bg-gray-100 text-left text-gray-600">
          <tr>
            <th className="px-4 py-2">Ticket</th>
            <th className="px-4 py-2">Category</th>
            <th className="px-4 py-2">Severity</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Raised</th>
          </tr>
        </thead>
        <tbody>
          {complaints.map((c) => (
            <tr key={c.id} className="border-t border-gray-100">
              <td className="px-4 py-2 font-medium">{c.ticketNumber}</td>
              <td className="px-4 py-2 capitalize">{c.category.replaceAll("_", " ")}</td>
              <td className="px-4 py-2 capitalize">{c.severity}</td>
              <td className="px-4 py-2 capitalize">{c.status.replaceAll("_", " ")}</td>
              <td className="px-4 py-2">{new Date(c.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
