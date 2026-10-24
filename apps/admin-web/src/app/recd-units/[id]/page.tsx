"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AMC_TYPE_LABELS, SERVICE_REPORT_STATUS_LABELS, type ServiceReportStatus } from "@recd/shared";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { formatDate } from "@/lib/format";
import { downloadReportPdf } from "@/lib/reportFiles";
import { reportStatusPill } from "@/lib/serviceReportUi";
import { useAuth } from "@/components/AuthContext";
import WarrantyPanel from "@/components/WarrantyPanel";
import type { UnitWarranty } from "@/lib/warrantyUi";

/** Shape of GET /recd-units/:id/history (apps/api/src/routes/recdUnits.ts). */
interface UnitHistory {
  unit: {
    id: string;
    serialNo: string | null;
    status: string;
    /** Computed by the API from the unit's own warranty columns (shared status rules). */
    warranty: UnitWarranty;
    product: { name: string; model: string; warrantyMonths: number | null };
    order: { id: string; orderNumber: string; poNumber: string | null; customer: { id: string; name: string } };
    site: {
      id: string;
      companyName: string | null;
      address: string | null;
      dgModel: string | null;
      dgCapacityKva: string | number | null;
      region: { name: string } | null;
    } | null;
  };
  /** False when the viewer's role cannot see tickets / AMC (the lists are then empty, not "none"). */
  complaintsVisible: boolean;
  amcVisible: boolean;
  complaints: Array<{
    id: string;
    ticketNumber: string;
    category: string;
    issueCategory: string | null;
    description: string;
    severity: string;
    status: string;
    rootCause: string | null;
    resolutionNotes: string | null;
    remarks: string | null;
    serviceReportUrl: string | null;
    createdAt: string;
    closedAt: string | null;
    assignedTo: { id: string; name: string } | null;
    events: Array<{ id: string; type: string; fromValue: string | null; toValue: string | null; actorLabel: string | null; createdAt: string; actor: { name: string } | null }>;
  }>;
  /** Digital service reports that have left draft (signed ones have a downloadable PDF). */
  /** AMC visit reports for this unit that have left draft (only for roles that can see the unit's AMC). */
  amcServiceReports?: Array<{ id: string; reportNumber: string; amcOrderId: string | null; unitSerialNo: string | null; status: ServiceReportStatus; visitDate: string; signedAt: string | null; signerName: string | null; pdfAvailable: boolean }>;
  serviceReports?: Array<{ id: string; reportNumber: string; complaintId: string; status: ServiceReportStatus; visitDate: string; signedAt: string | null; signerName: string | null; pdfAvailable: boolean }>;
  amcOrders: Array<{
    id: string;
    poNo: string;
    poDate: string;
    amcType: string;
    amcFrequencyPerYear: number;
    status: string;
    expiresOn: string;
    expiryReminderClearedAt: string | null;
  }>;
}

const pretty = (s: string) => s.replace(/_/g, " ");

function reportFileName(ticketNumber: string, dataUrl: string): string {
  const ext = /^data:application\/pdf/.test(dataUrl) ? "pdf" : /^data:image\/png/.test(dataUrl) ? "png" : /^data:image\/jpe?g/.test(dataUrl) ? "jpg" : "bin";
  return `service-report-${ticketNumber}.${ext}`;
}

function statusPill(status: string) {
  if (status === "resolved" || status === "closed" || status === "completed") return "status-pill status-pill-success";
  if (status === "open" || status === "escalated") return "status-pill status-pill-error";
  return "status-pill status-pill-warning";
}

export default function RecdUnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<UnitHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { hasPermission } = useAuth();

  const load = () => {
    api<UnitHistory>(`/recd-units/${id}/history`)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(apiErrorMessage(e, "Failed to load this RECD unit")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <p className="text-sm text-gray-500" data-testid="unit-loading">Loading…</p>;
  if (error || !data) {
    return (
      <div className="space-y-3 max-w-5xl">
        <Link href="/recd-units" className="text-xs font-medium text-gray-400 hover:text-gray-600">← RECD units</Link>
        <p className="text-sm text-red-600" data-testid="unit-error">{error ?? "RECD unit not found"}</p>
      </div>
    );
  }

  const { unit, complaints, amcOrders, complaintsVisible, amcVisible } = data;
  const dg = [unit.site?.dgModel, unit.site?.dgCapacityKva != null ? `${unit.site.dgCapacityKva} kVA` : null].filter(Boolean).join(" · ");

  return (
    <div className="space-y-6 max-w-5xl" data-testid="recd-unit-detail-page">
      <div>
        <Link href="/recd-units" className="text-xs font-medium text-gray-400 hover:text-gray-600">← RECD units</Link>
        <h1 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight font-mono" style={{ color: "var(--text-heading)" }}>
          {unit.serialNo ?? "Serial number not recorded"}
          {unit.status === "retired" && <span className="badge ml-2 font-sans">retired</span>}
        </h1>
        <p className="mt-1 text-sm text-gray-500">{unit.product.name} ({unit.product.model})</p>
      </div>

      {!unit.serialNo && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700" data-testid="unit-serial-pending">
          This is a legacy unit with no serial number on file. Enter it from the{" "}
          <Link href={`/orders/${unit.order.id}`} className="underline">order page</Link> so its service history and AMC can be tracked.
        </p>
      )}

      <div className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field label="Customer">{unit.order.customer.name}</Field>
        <Field label="Site">
          {unit.site ? <Link href={`/sites/${unit.site.id}`} className="hover:underline">{unit.site.companyName ?? "Not set"}</Link> : "—"}
        </Field>
        <Field label="Site address">{unit.site?.address ?? "—"}</Field>
        <Field label="Region">{unit.site?.region?.name ?? "—"}</Field>
        <Field label="DG set">{dg || "Not recorded"}</Field>
        <Field label="Order / PO">
          <Link href={`/orders/${unit.order.id}`} className="font-mono text-xs hover:underline">{unit.order.orderNumber}</Link>
          {unit.order.poNumber && <span className="text-xs text-gray-400"> · PO {unit.order.poNumber}</span>}
        </Field>
        <Field label="Product warranty (default duration)">{unit.product.warrantyMonths != null ? `${unit.product.warrantyMonths} months` : "—"}</Field>
      </div>

      <WarrantyPanel unitId={unit.id} warranty={unit.warranty} productMonths={unit.product.warrantyMonths} canEdit={hasPermission("manage_warranty")} onChanged={load} />

      <section className="card overflow-hidden" data-testid="unit-tickets">
        <div className="px-4 py-3 border-b"><h2 className="text-sm font-semibold">Service history</h2></div>
        {!complaintsVisible ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">Your role does not have access to service tickets.</p>
        ) : complaints.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">No service tickets have been raised for this unit.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {complaints.map((c) => (
              <div key={c.id} className="px-4 py-3 space-y-1.5 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-xs font-semibold">{c.ticketNumber}</span>
                  <span className={statusPill(c.status)}>{pretty(c.status)}</span>
                  <span className="text-xs capitalize text-gray-500">{c.severity} · {pretty(c.category)}</span>
                  <span className="text-xs text-gray-400">
                    Raised {formatDate(c.createdAt)}{c.closedAt ? ` · Closed ${formatDate(c.closedAt)}` : ""}
                  </span>
                  {c.assignedTo && <span className="text-xs text-gray-400">Assigned to {c.assignedTo.name}</span>}
                </div>
                <p className="text-gray-700">{c.description}</p>
                {c.rootCause && <p className="text-xs text-gray-500"><strong>Root cause:</strong> {c.rootCause}</p>}
                {c.resolutionNotes && <p className="text-xs text-gray-500"><strong>Resolution:</strong> {c.resolutionNotes}</p>}
                {c.remarks && <p className="text-xs text-gray-500"><strong>Remarks:</strong> {c.remarks}</p>}
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  {c.serviceReportUrl ? (
                    <a
                      href={c.serviceReportUrl}
                      download={reportFileName(c.ticketNumber, c.serviceReportUrl)}
                      className="font-medium hover:underline"
                      style={{ color: "var(--theme-primary)" }}
                    >
                      Download service report
                    </a>
                  ) : (
                    <span className="text-gray-400">No service report uploaded</span>
                  )}
                  <Link href={`/service-reports?complaintId=${c.id}`} className="font-medium hover:underline" style={{ color: "var(--theme-primary)" }}>
                    Digital service reports
                  </Link>
                </div>
                {(data.serviceReports ?? []).filter((r) => r.complaintId === c.id).map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-3 text-xs" data-testid={`unit-report-${r.reportNumber}`}>
                    <Link href={`/service-reports/${r.id}`} className="font-mono font-semibold hover:underline">{r.reportNumber}</Link>
                    <span className={reportStatusPill(r.status)}>{SERVICE_REPORT_STATUS_LABELS[r.status] ?? r.status}</span>
                    {r.signedAt && <span className="text-gray-500">Signed by {r.signerName} on {formatDate(r.signedAt)}</span>}
                    {r.pdfAvailable && (
                      <button onClick={() => downloadReportPdf(r.id, r.reportNumber).catch(() => alert("The signed report could not be downloaded."))} className="font-medium hover:underline" style={{ color: "var(--theme-primary)" }}>
                        Download signed PDF
                      </button>
                    )}
                  </div>
                ))}
                {c.events.length > 0 && (
                  <details className="text-xs text-gray-500">
                    <summary className="cursor-pointer">Ticket timeline ({c.events.length})</summary>
                    <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                      {c.events.map((ev) => (
                        <li key={ev.id}>
                          {formatDate(ev.createdAt)} — {pretty(ev.type)}
                          {ev.toValue ? `: ${ev.fromValue ? `${pretty(ev.fromValue)} → ` : ""}${pretty(ev.toValue)}` : ""}
                          {(ev.actor?.name ?? ev.actorLabel) ? ` (${ev.actor?.name ?? ev.actorLabel})` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card overflow-hidden" data-testid="unit-amc">
        <div className="px-4 py-3 border-b"><h2 className="text-sm font-semibold">AMC</h2></div>
        {!amcVisible ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">Your role does not have access to AMC details.</p>
        ) : amcOrders.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">This unit is not covered by any AMC order.</p>
        ) : (
          <div className="table-scroll">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">PO No</th>
                  <th className="px-4 py-3">PO date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Visits / year</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {amcOrders.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-mono text-xs font-semibold">{a.poNo}</td>
                    <td className="px-4 py-3">{formatDate(a.poDate)}</td>
                    <td className="px-4 py-3">{AMC_TYPE_LABELS[a.amcType] ?? a.amcType}</td>
                    <td className="px-4 py-3">{a.amcFrequencyPerYear}</td>
                    <td className="px-4 py-3"><span className={statusPill(a.status)}>{pretty(a.status)}</span></td>
                    <td className="px-4 py-3">
                      {formatDate(a.expiresOn)}
                      {a.expiryReminderClearedAt && <div className="text-[10px] font-semibold text-emerald-600">AMC Acquired</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {amcVisible && (data.amcServiceReports ?? []).length > 0 && (
          <div className="border-t border-gray-100 px-4 py-3 space-y-2" data-testid="unit-amc-reports">
            <h3 className="text-xs font-semibold text-gray-600">AMC service reports for this unit</h3>
            {(data.amcServiceReports ?? []).map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 text-xs" data-testid={`unit-amc-report-${r.reportNumber}`}>
                <Link href={`/service-reports/${r.id}`} className="font-mono font-semibold hover:underline">{r.reportNumber}</Link>
                <span className={reportStatusPill(r.status)}>{SERVICE_REPORT_STATUS_LABELS[r.status] ?? r.status}</span>
                <span className="text-gray-500">Visit {formatDate(r.visitDate)}{r.unitSerialNo ? ` · S/N ${r.unitSerialNo}` : ""}</span>
                {r.signedAt && <span className="text-gray-500">Signed by {r.signerName}</span>}
                {r.pdfAvailable && (
                  <button onClick={() => downloadReportPdf(r.id, r.reportNumber).catch(() => alert("The report could not be downloaded."))} className="font-medium hover:underline" style={{ color: "var(--theme-primary)" }}>
                    {r.status === "signed" ? "Download signed PDF" : "Download PDF"}
                  </button>
                )}
                {r.amcOrderId && <Link href={`/service-reports?amcOrderId=${r.amcOrderId}`} className="text-gray-500 hover:underline">All reports for this AMC</Link>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
