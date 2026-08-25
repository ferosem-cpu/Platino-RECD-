"use client";

import Link from "next/link";
import { useAuth } from "@/components/AuthContext";

interface ReportCard {
  href: string;
  title: string;
  description: string;
  permissions: string[];
}

const REPORT_CARDS: ReportCard[] = [
  {
    href: "/reports/sitc",
    title: "Sites / SITC status",
    description: "Every order & site with its current Supply–Install–Test–Commission stage. Filter by date, customer, vendor or stage.",
    permissions: ["view_site_status"],
  },
  // The upstream fork also has a "Finance summary" report (receivables/payables aging, GST,
  // revenue vs. expenses). Not ported - there is no finance module here. See HANDOVER.md §24.
  {
    href: "/reports/customer-history",
    title: "Customer / order history",
    description: "Pick a customer and get every order, site and complaint on record for them.",
    permissions: ["manage_orders"],
  },
  {
    href: "/reports/vendor-performance",
    title: "Vendor performance",
    description: "Pick a vendor and see every site assigned to them, stage breakdown and complaints raised.",
    permissions: ["manage_vendors"],
  },
];

export default function ReportsPage() {
  const { hasPermission } = useAuth();
  const visible = REPORT_CARDS.filter((c) => c.permissions.some((p) => hasPermission(p)));

  return (
    <div className="space-y-4" data-testid="reports-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>
          Reports
        </h1>
        <p className="mt-1 text-sm text-gray-500">Run a report, then print it or export the data as CSV.</p>
      </div>

      {visible.length === 0 && (
        <p className="text-sm text-gray-500">You don&apos;t have access to any reports.</p>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {visible.map((c) => (
          <Link key={c.href} href={c.href} className="card p-5 block hover:shadow-md transition-shadow" data-testid={`report-card-${c.href.split("/").pop()}`}>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-heading)" }}>{c.title}</h2>
            <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">{c.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
