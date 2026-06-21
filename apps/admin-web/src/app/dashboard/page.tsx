"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import type { DashboardCountsDTO } from "@recd/shared";

const PHASE_LABELS: Record<string, string> = {
  SUPPLY: "Supply",
  INSTALLATION: "Installation",
  TESTING: "Testing",
  COMMISSIONING: "Commissioning",
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardCountsDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardCountsDTO>("/dashboard")
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load dashboard"));
  }, []);

  if (error) return <p className="text-sm text-red-600">{error} - visible only to Owner/Admin and Management.</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-600">Sites by SITC phase</h2>
        <div className="grid grid-cols-4 gap-4">
          {Object.entries(data.sitesByPhase).map(([phase, count]) => (
            <div key={phase} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-2xl font-semibold">{count}</div>
              <div className="text-sm text-gray-500">{PHASE_LABELS[phase] ?? phase}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-gray-600">Complaints by status</h2>
        <div className="grid grid-cols-4 gap-4">
          {Object.entries(data.complaintsByStatus).map(([status, count]) => (
            <div key={status} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-2xl font-semibold">{count}</div>
              <div className="text-sm capitalize text-gray-500">{status.replaceAll("_", " ")}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
