"use client";

import { useEffect, useState } from "react";
import { Bar, Doughnut } from "react-chartjs-2";
import {
  Chart as ChartJS,
  BarElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from "chart.js";
import { api } from "@/lib/apiClient";
import type { DashboardCountsDTO } from "@recd/shared";

ChartJS.register(BarElement, ArcElement, CategoryScale, LinearScale, Tooltip);

const PHASE_META: Record<string, { label: string; color: string; bg: string; icon: JSX.Element }> = {
  SUPPLY: {
    label: "Supply",
    color: "#0F4C81",
    bg: "#E8F0F8",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.83H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
      </svg>
    ),
  },
  INSTALLATION: {
    label: "Installation",
    color: "#F58220",
    bg: "#FDEDDF",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
  },
  TESTING: {
    label: "Testing",
    color: "#D97706",
    bg: "#FDF3DA",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
      </svg>
    ),
  },
  COMMISSIONING: {
    label: "Commissioning",
    color: "#22C55E",
    bg: "#E3F9EA",
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
};

function complaintColor(status: string): string {
  if (status === "resolved" || status === "closed") return "#22C55E";
  if (status === "escalated") return "#E24B4A";
  return "#F58220";
}

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

  const phaseEntries = Object.entries(data.sitesByPhase);
  const complaintEntries = Object.entries(data.complaintsByStatus);
  const complaintTotal = complaintEntries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="space-y-6" data-testid="dashboard-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: "var(--text-heading)" }}>
          Operations dashboard
        </h1>
        <p className="mt-1 text-sm text-gray-500">SITC pipeline and complaint status across all sites</p>
      </div>

      <section>
        <h2 className="mb-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-gray-500">
          Sites by SITC phase
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-3.5">
          {phaseEntries.map(([phase, count]) => {
            const meta = PHASE_META[phase];
            return (
              <div key={phase} className="kpi-tile">
                <div className="kpi-tile-icon" style={{ background: meta?.bg ?? "#E8F0F8", color: meta?.color ?? "#0F4C81" }}>
                  {meta?.icon}
                </div>
                <div className="kpi-tile-value">{count}</div>
                <div className="kpi-tile-label">{meta?.label ?? phase}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-3.5">
        <div className="card p-4 sm:p-5">
          <h2 className="text-[0.8125rem] font-semibold mb-3" style={{ color: "var(--text-heading)" }}>
            Sites by phase
          </h2>
          <div className="relative h-48">
            <Bar
              data={{
                labels: phaseEntries.map(([phase]) => PHASE_META[phase]?.label ?? phase),
                datasets: [
                  {
                    data: phaseEntries.map(([, count]) => count),
                    backgroundColor: phaseEntries.map(([phase]) => PHASE_META[phase]?.color ?? "#0F4C81"),
                    borderRadius: 6,
                    maxBarThickness: 40,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                  x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                  y: { display: false, beginAtZero: true },
                },
              }}
            />
          </div>
        </div>

        <div className="card p-4 sm:p-5 flex flex-col">
          <h2 className="text-[0.8125rem] font-semibold mb-3" style={{ color: "var(--text-heading)" }}>
            Complaints by status
          </h2>
          <div className="relative h-36 my-2">
            <Doughnut
              data={{
                labels: complaintEntries.map(([status]) => status.replaceAll("_", " ")),
                datasets: [
                  {
                    data: complaintEntries.map(([, count]) => count),
                    backgroundColor: complaintEntries.map(([status]) => complaintColor(status)),
                    borderWidth: 0,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                cutout: "68%",
                plugins: { legend: { display: false } },
              }}
            />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 justify-center mt-1">
            {complaintEntries.map(([status, count]) => (
              <span key={status} className="text-[0.625rem] text-gray-500 flex items-center gap-1.5 capitalize">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: complaintColor(status) }} />
                {status.replaceAll("_", " ")} {count}
              </span>
            ))}
            {complaintTotal === 0 && <span className="text-[0.625rem] text-gray-400">No complaints yet</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
