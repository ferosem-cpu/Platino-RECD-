"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SERVICE_REPORT_STATUS, SERVICE_REPORT_STATUS_LABELS, SERVICE_REPORT_LIMITS, type ServiceReportStatus } from "@recd/shared";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { downloadReportPdf } from "@/lib/reportFiles";
import { reportStatusPill } from "@/lib/serviceReportUi";

interface ReportRow {
  id: string;
  reportNumber: string;
  kind: "ticket" | "amc";
  ticketNumber: string | null;
  amc: { id: string; ref: string; poNo: string; typeLabel: string } | null;
  unitId: string | null;
  unitSerialNo: string | null;
  acknowledgementRequired: boolean;
  status: ServiceReportStatus;
  version: number;
  visitDate: string;
  engineer: { id: string; name: string };
  signedAt: string | null;
  signerName: string | null;
  pdfAvailable: boolean;
}

interface VisitRow { id: string; unitId: string; serialNo: string | null; dueDate: string; status: string }

interface AmcContext {
  kind: "amc";
  amc: { id: string; ref: string; poNo: string; poDate: string; typeLabel: string; location: string; visitsPerYear: number; customerName: string };
  units: Array<{ id: string; serialNo: string | null; status: string; siteName: string | null; address: string | null }>;
}

const today = () => new Date().toISOString().slice(0, 10);
const OPEN: ServiceReportStatus[] = [SERVICE_REPORT_STATUS.DRAFT, SERVICE_REPORT_STATUS.AWAITING_SIGNATURE];

function ReportsForTicketOrAmc() {
  const params = useSearchParams();
  const router = useRouter();
  const complaintId = params.get("complaintId");
  const amcOrderId = params.get("amcOrderId");

  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [context, setContext] = useState<AmcContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [unitId, setUnitId] = useState("");
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [visitUnit, setVisitUnit] = useState("");
  const [visitDue, setVisitDue] = useState("");
  const [visitError, setVisitError] = useState<string | null>(null);
  const [acknowledgementRequired, setAcknowledgementRequired] = useState(true);
  const [form, setForm] = useState({ visitDate: today(), workPerformed: "", findings: "", resolution: "", partsUsed: "", remarks: "" });

  const load = useCallback(() => {
    const query = amcOrderId ? `amcOrderId=${encodeURIComponent(amcOrderId)}` : complaintId ? `complaintId=${encodeURIComponent(complaintId)}` : null;
    if (!query) return;
    setError(null);
    api<{ canWrite: boolean; reports: ReportRow[]; context?: AmcContext }>(`/service-reports?${query}`)
      .then((r) => {
        setReports(r.reports);
        setCanWrite(r.canWrite);
        setContext(r.context ?? null);
      })
      .catch((err) => {
        setReports([]);
        setError(apiErrorMessage(err, "Could not load the service reports."));
      });
  }, [amcOrderId, complaintId]);

  useEffect(load, [load]);

  const loadVisits = useCallback(() => {
    if (!amcOrderId) return;
    api<VisitRow[]>(`/amc-visits?amcOrderId=${encodeURIComponent(amcOrderId)}`).then(setVisits).catch(() => setVisits([]));
  }, [amcOrderId]);
  useEffect(() => { if (canWrite) loadVisits(); }, [canWrite, loadVisits]);

  async function scheduleVisit(e: React.FormEvent) {
    e.preventDefault();
    setVisitError(null);
    try {
      await api("/amc-visits", { method: "POST", body: JSON.stringify({ amcOrderId, unitId: visitUnit, dueDate: visitDue }) });
      setVisitDue("");
      loadVisits();
    } catch (err) {
      setVisitError(apiErrorMessage(err, "Could not schedule the visit."));
    }
  }

  async function finishVisit(id: string, status: "completed" | "cancelled") {
    setVisitError(null);
    try {
      await api(`/amc-visits/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      loadVisits();
    } catch (err) {
      setVisitError(apiErrorMessage(err, "Could not update the visit."));
      loadVisits();
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const body = amcOrderId ? { amcOrderId, unitId, acknowledgementRequired, ...form } : { complaintId, ...form };
      const created = await api<{ id: string }>("/service-reports", { method: "POST", body: JSON.stringify(body) });
      router.push(`/service-reports/${created.id}`);
    } catch (err) {
      setCreateError(apiErrorMessage(err, "Could not start the report."));
    } finally {
      setCreating(false);
    }
  }

  async function download(r: ReportRow) {
    setDownloadError(null);
    try {
      await downloadReportPdf(r.id, r.reportNumber);
    } catch (err) {
      setDownloadError(apiErrorMessage(err, "Could not download the report."));
    }
  }

  if (!complaintId && !amcOrderId) return <p className="text-sm text-gray-500">Open a service ticket or an AMC order and choose &ldquo;Service reports&rdquo;.</p>;
  if (reports === null) return <p className="text-sm text-gray-500" data-testid="reports-loading">Loading service reports…</p>;

  const isAmc = !!amcOrderId;
  const openFor = (uid: string | null) => reports.find((r) => OPEN.includes(r.status) && (!isAmc || r.unitId === uid));
  const eligibleUnits = (context?.units ?? []).filter((u) => u.status === "active" && u.serialNo);
  const selectedOpen = isAmc ? openFor(unitId || null) : openFor(null);
  const title = isAmc ? `AMC service reports${context ? ` · ${context.amc.ref}` : ""}` : `Service reports${reports[0]?.ticketNumber ? ` · ${reports[0].ticketNumber}` : ""}`;

  return (
    <div className="space-y-6 max-w-3xl" data-testid="service-reports-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>{title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {isAmc
            ? "One report per AMC visit to one RECD unit. The report is written by Platino staff, then either signed by the customer or - where acknowledgement is not required - finalised without a signature."
            : "A digital report is written by the service engineer, reviewed and signed by the customer, then kept as a signed PDF."}
        </p>
      </div>

      {isAmc && context && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-4 text-sm" data-testid="amc-context">
          {[
            ["AMC order", `${context.amc.ref} (PO ${context.amc.poNo}, ${context.amc.poDate})`],
            ["AMC type", context.amc.typeLabel],
            ["Customer", context.amc.customerName],
            ["Location", context.amc.location],
            ["Contracted visits per year", String(context.amc.visitsPerYear)],
            ["Reports written so far", String(reports.length)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="font-medium text-gray-800">{value}</dd>
            </div>
          ))}
          <p className="sm:col-span-2 text-[11px] text-gray-400">
            The contracted visits per year is the schedule. Each report below records one visit that actually happened; the number of reports is not limited by it.
          </p>
        </dl>
      )}

      {isAmc && canWrite && (
        <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3" data-testid="amc-visits">
          <h2 className="text-sm font-semibold">Scheduled visits (due dates for reminders)</h2>
          <p className="text-[11px] text-gray-400">
            A visit only exists when you add it here with a due date; it is not created from the contracted visits per year and is unrelated to the contract expiry. Scheduled visits appear on the Reminders page and are reminded according to the reminder policy in Settings.
          </p>
          {visits.length === 0 && <p className="text-xs text-gray-500">No visits scheduled.</p>}
          <ul className="space-y-1 text-sm">
            {visits.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2" data-testid={`visit-${v.dueDate}`}>
                <span>{v.dueDate} · S/N {v.serialNo ?? "not recorded"} · <span className="text-gray-500">{v.status}</span></span>
                {v.status === "scheduled" && (
                  <span className="flex gap-3 text-xs">
                    <button type="button" onClick={() => finishVisit(v.id, "completed")} className="font-medium text-emerald-700 hover:underline">Mark completed</button>
                    <button type="button" onClick={() => finishVisit(v.id, "cancelled")} className="font-medium text-gray-500 hover:underline">Cancel</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <form onSubmit={scheduleVisit} className="flex flex-wrap items-end gap-2">
            <select required className="field" value={visitUnit} onChange={(e) => setVisitUnit(e.target.value)} aria-label="Unit for the visit">
              <option value="">Unit…</option>
              {eligibleUnits.map((u) => <option key={u.id} value={u.id}>{u.serialNo}</option>)}
            </select>
            <input type="date" required className="field" value={visitDue} onChange={(e) => setVisitDue(e.target.value)} aria-label="Visit due date" />
            <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50">Schedule visit</button>
          </form>
          {visitError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{visitError}</p>}
        </section>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {downloadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{downloadError}</p>}

      {reports.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500" data-testid="reports-empty">
          {canWrite ? "No service report has been written yet." : "No service report is available yet."}
        </div>
      )}

      <ul className="space-y-3">
        {reports.map((r) => (
          <li key={r.id} className="rounded-xl border border-gray-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <Link href={`/service-reports/${r.id}`} className="font-mono text-sm font-bold text-[var(--theme-primary)] hover:underline">
                {r.reportNumber}
              </Link>
              <p className="text-xs text-gray-500">
                Visit {r.visitDate} · {r.engineer.name}
                {r.kind === "amc" && r.unitSerialNo ? ` · S/N ${r.unitSerialNo}` : ""}
                {r.kind === "amc" && !r.acknowledgementRequired ? " · no customer signature required" : ""}
                {r.signedAt ? ` · signed by ${r.signerName} on ${new Date(r.signedAt).toLocaleString()}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={reportStatusPill(r.status)}>{SERVICE_REPORT_STATUS_LABELS[r.status] ?? r.status}</span>
              {r.pdfAvailable && (
                <button onClick={() => download(r)} className="text-xs font-medium text-[var(--theme-accent)] hover:underline">
                  {r.status === SERVICE_REPORT_STATUS.SIGNED ? "Download signed PDF" : "Download PDF"}
                </button>
              )}
              <Link href={`/service-reports/${r.id}`} className="text-xs font-medium text-gray-600 hover:underline">
                {r.status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE && !canWrite ? "Review & sign" : "Open"}
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {canWrite && (isAmc || !selectedOpen) && (
        <form onSubmit={create} className="rounded-xl border border-gray-200 bg-white p-4 space-y-3" data-testid="new-report-form">
          <h2 className="text-sm font-semibold">{isAmc ? "Start a report for an AMC visit" : "Start a new service report"}</h2>
          {isAmc && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">RECD unit visited</label>
                <select required className="field w-full" value={unitId} onChange={(e) => setUnitId(e.target.value)} data-testid="amc-unit-select">
                  <option value="">Choose a unit covered by this AMC…</option>
                  {eligibleUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.serialNo}{u.siteName ? ` - ${u.siteName}` : ""}
                    </option>
                  ))}
                </select>
                {eligibleUnits.length === 0 && <p className="mt-1 text-[11px] text-amber-600">This AMC order covers no active unit with a serial number, so no report can be written.</p>}
                {selectedOpen && <p className="mt-1 text-[11px] text-amber-600">Report {selectedOpen.reportNumber} for this unit is still {SERVICE_REPORT_STATUS_LABELS[selectedOpen.status].toLowerCase()}. Finish it first.</p>}
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" className="mt-1" checked={acknowledgementRequired} onChange={(e) => setAcknowledgementRequired(e.target.checked)} data-testid="ack-required" />
                <span>
                  The customer must review and sign this report.
                  <span className="block text-[11px] text-gray-400">Untick only when no acknowledgement is needed; the report is then finalised by staff, marked &ldquo;not signed&rdquo;. You can change this while it is a draft.</span>
                </span>
              </label>
            </>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Service visit date</label>
            <input type="date" required max={today()} className="field" value={form.visitDate} onChange={(e) => setForm({ ...form, visitDate: e.target.value })} />
          </div>
          {([
            ["workPerformed", "Work performed"],
            ["findings", "Findings / observations"],
            ["resolution", "Resolution / outcome"],
          ] as const).map(([key, label]) => (
            <div key={key}>
              <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
              <textarea rows={3} maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} className="field w-full" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            </div>
          ))}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Parts used (optional)</label>
            <input className="field w-full" maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} value={form.partsUsed} onChange={(e) => setForm({ ...form, partsUsed: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Remarks (optional)</label>
            <textarea rows={2} maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} className="field w-full" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </div>
          {createError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{createError}</p>}
          <p className="text-[11px] text-gray-400">Saved as a draft first. You can review it and submit it on the next screen.</p>
          <button type="submit" disabled={creating || (isAmc && (!unitId || !!selectedOpen))} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {creating ? "Saving…" : "Save draft"}
          </button>
        </form>
      )}
      {canWrite && !isAmc && selectedOpen && (
        <p className="text-sm text-gray-500">
          Report {selectedOpen.reportNumber} is still {SERVICE_REPORT_STATUS_LABELS[selectedOpen.status].toLowerCase()}. Finish it before starting another visit&apos;s report.
        </p>
      )}
    </div>
  );
}

export default function ServiceReportsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
      <ReportsForTicketOrAmc />
    </Suspense>
  );
}
