"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SERVICE_REPORT_LIMITS, SERVICE_REPORT_STATUS, SERVICE_REPORT_STATUS_LABELS, serviceReportMissingFields, type ServiceReportStatus } from "@recd/shared";
import { api, apiBlob, ApiRequestError } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { useAuth } from "@/components/AuthContext";
import SignaturePad from "@/components/SignaturePad";
import { downloadReportPdf, openReportPdf } from "@/lib/reportFiles";
import { reportStatusPill } from "@/lib/serviceReportUi";

interface ReportDetail {
  id: string;
  reportNumber: string;
  kind: "ticket" | "amc";
  complaintId: string | null;
  ticketNumber: string | null;
  amc: { id: string; ref: string; poNo: string; type: string; typeLabel: string } | null;
  amcDetails: { ref: string; poNo: string; poDate: string; location: string; visitsPerYear: number } | null;
  acknowledgementRequired: boolean;
  status: ServiceReportStatus;
  version: number;
  visitDate: string;
  workPerformed: string;
  findings: string;
  resolution: string;
  partsUsed: string | null;
  remarks: string | null;
  engineer: { id: string; name: string };
  submittedAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  pdfAvailable: boolean;
  customerName: string | null;
  site: { name: string | null; address: string | null; dgModel: string | null; dgCapacityKva: string | number | null } | null;
  unit: { serialNo: string | null; model: string | null } | null;
  permissions: { canEdit: boolean; canSubmit: boolean; canReopen: boolean; canSign: boolean };
}

const SECTIONS = [
  ["workPerformed", "Work performed"],
  ["findings", "Findings / observations"],
  ["resolution", "Resolution / outcome"],
] as const;

export default function ServiceReportPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ visitDate: "", workPerformed: "", findings: "", resolution: "", partsUsed: "", remarks: "" });
  const [ackRequired, setAckRequired] = useState(true);
  const [busy, setBusy] = useState<null | "save" | "submit" | "reopen" | "sign" | "download">(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);

  const sync = useCallback((r: ReportDetail) => {
    setReport(r);
    setAckRequired(r.acknowledgementRequired);
    setForm({ visitDate: r.visitDate, workPerformed: r.workPerformed, findings: r.findings, resolution: r.resolution, partsUsed: r.partsUsed ?? "", remarks: r.remarks ?? "" });
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api<ReportDetail>(`/service-reports/${id}`)
      .then(sync)
      .catch((err) => setLoadError(apiErrorMessage(err, "This report could not be loaded.")));
  }, [id, sync]);

  useEffect(load, [load]);
  useEffect(() => {
    if (user?.name && !signerName) setSignerName(user.name);
  }, [user, signerName]);

  // The saved signature image is a protected file: fetch it with the login token and show it from a blob URL.
  useEffect(() => {
    if (!report || report.status !== SERVICE_REPORT_STATUS.SIGNED) return;
    let url: string | null = null;
    let cancelled = false;
    apiBlob(`/service-reports/${report.id}/signature`)
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setSignatureUrl(url);
      })
      .catch(() => setSignatureUrl(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [report]);

  async function run<T>(kind: NonNullable<typeof busy>, work: () => Promise<T>, okText?: string): Promise<T | undefined> {
    setBusy(kind);
    setMessage(null);
    try {
      const result = await work();
      if (okText) setMessage({ kind: "ok", text: okText });
      return result;
    } catch (err) {
      const stale = err instanceof ApiRequestError && (err.body.code === "STALE_VERSION" || err.body.code === "ALREADY_SIGNED");
      setMessage({ kind: "error", text: apiErrorMessage(err, "Something went wrong. Nothing was changed.") });
      if (stale) load();
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const payload = () => ({
    expectedVersion: report!.version,
    visitDate: form.visitDate,
    workPerformed: form.workPerformed,
    findings: form.findings,
    resolution: form.resolution,
    partsUsed: form.partsUsed,
    remarks: form.remarks,
    ...(report!.kind === "amc" ? { acknowledgementRequired: ackRequired } : {}),
  });

  const save = () => run("save", async () => sync(await api<ReportDetail>(`/service-reports/${id}`, { method: "PATCH", body: JSON.stringify(payload()) }).then(() => api<ReportDetail>(`/service-reports/${id}`))), "Draft saved.");

  async function submit() {
    const missing = serviceReportMissingFields(form);
    if (missing.length) return setMessage({ kind: "error", text: `Complete these before submitting: ${missing.join(", ")}.` });
    await run("submit", async () => {
      await api(`/service-reports/${id}`, { method: "PATCH", body: JSON.stringify(payload()) });
      const fresh = await api<ReportDetail>(`/service-reports/${id}`);
      await api(`/service-reports/${id}/submit`, { method: "POST", body: JSON.stringify({ expectedVersion: fresh.version }) });
      sync(await api<ReportDetail>(`/service-reports/${id}`));
    }, ackRequired ? "Submitted. The customer can now review and sign this report." : "Submitted and finalised. This report carries no customer signature, as its acknowledgement was marked not required.");
  }

  const reopen = () =>
    run("reopen", async () => {
      await api(`/service-reports/${id}/reopen`, { method: "POST", body: JSON.stringify({ expectedVersion: report!.version }) });
      sync(await api<ReportDetail>(`/service-reports/${id}`));
    }, "Taken back to draft. The customer can no longer sign the earlier version.");

  const signNow = () =>
    run("sign", async () => {
      await api(`/service-reports/${id}/sign`, {
        method: "POST",
        body: JSON.stringify({ signerName, signatureImage, version: report!.version, confirm: true }),
      });
      sync(await api<ReportDetail>(`/service-reports/${id}`));
    }, "Thank you - the report is signed and final. You can download the signed PDF below.");

  async function download(open: boolean) {
    setMessage(null);
    setBusy("download");
    try {
      if (open) await openReportPdf(report!.id);
      else await downloadReportPdf(report!.id, report!.reportNumber);
    } catch (err) {
      setMessage({ kind: "error", text: apiErrorMessage(err, "The signed report could not be downloaded.") });
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="max-w-3xl space-y-3" data-testid="report-error">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{loadError}</p>
        <button onClick={load} className="text-sm font-medium text-[var(--theme-accent)]">Try again</button>
      </div>
    );
  }
  if (!report) return <p className="text-sm text-gray-500" data-testid="report-loading">Loading report…</p>;

  const p = report.permissions;
  const editable = p.canEdit;
  const canFinishSigning = !!signatureImage && signerName.trim().length >= SERVICE_REPORT_LIMITS.SIGNER_NAME_MIN && confirm && busy === null;

  return (
    <div className="space-y-6 max-w-3xl" data-testid="service-report-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={report.kind === "amc" && report.amc ? `/service-reports?amcOrderId=${report.amc.id}` : `/service-reports?complaintId=${report.complaintId}`}
            className="text-xs text-gray-500 hover:underline"
          >
            ← All reports for {report.kind === "amc" ? `AMC ${report.amc?.ref ?? ""}` : report.ticketNumber}
          </Link>
          <h1 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>
            {report.kind === "amc" ? "AMC service report" : "Service report"} {report.reportNumber}
          </h1>
        </div>
        <span className={reportStatusPill(report.status)} data-testid="report-status">{SERVICE_REPORT_STATUS_LABELS[report.status]}</span>
      </div>

      {message && (
        <p role="status" data-testid="report-message" className={`rounded-lg px-3 py-2 text-sm ${message.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
          {message.text}
        </p>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-4 text-sm">
        {[
          ["Customer", report.customerName],
          ...(report.kind === "amc"
            ? [
                ["AMC order", report.amcDetails ? `${report.amcDetails.ref} (PO ${report.amcDetails.poNo}, ${report.amcDetails.poDate})` : report.amc?.ref ?? null],
                ["AMC type", report.amc?.typeLabel ?? null],
                ["AMC location", report.amcDetails?.location ?? null],
                ["Contracted visits per year", report.amcDetails ? String(report.amcDetails.visitsPerYear) : null],
              ]
            : [["Service ticket", report.ticketNumber]]),
          ["Site", [report.site?.name, report.site?.address].filter(Boolean).join(", ") || null],
          ["RECD serial number", report.unit?.serialNo ?? null],
          ["RECD model", report.unit?.model ?? null],
          ["DG", [report.site?.dgModel, report.site?.dgCapacityKva ? `${report.site.dgCapacityKva} kVA` : null].filter(Boolean).join(", ") || null],
          ["Engineer", report.engineer.name],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-xs text-gray-500">{label}</dt>
            <dd className="font-medium text-gray-800">{value || "-"}</dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-gray-500">Service visit date</dt>
          <dd>
            {editable ? (
              <input type="date" className="field" max={new Date().toISOString().slice(0, 10)} value={form.visitDate} onChange={(e) => setForm({ ...form, visitDate: e.target.value })} />
            ) : (
              <span className="font-medium text-gray-800">{report.visitDate}</span>
            )}
          </dd>
        </div>
      </dl>

      {SECTIONS.map(([key, label]) => (
        <section key={key} className="space-y-1">
          <h2 className="text-sm font-semibold">{label}</h2>
          {editable ? (
            <textarea rows={4} maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} className="field w-full" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          ) : (
            <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-700">{report[key] || "-"}</p>
          )}
        </section>
      ))}
      {(editable || report.partsUsed) && (
        <section className="space-y-1">
          <h2 className="text-sm font-semibold">Parts used</h2>
          {editable ? (
            <input className="field w-full" maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} value={form.partsUsed} onChange={(e) => setForm({ ...form, partsUsed: e.target.value })} />
          ) : (
            <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-700">{report.partsUsed}</p>
          )}
        </section>
      )}
      {(editable || report.remarks) && (
        <section className="space-y-1">
          <h2 className="text-sm font-semibold">Remarks</h2>
          {editable ? (
            <textarea rows={2} maxLength={SERVICE_REPORT_LIMITS.TEXT_MAX} className="field w-full" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          ) : (
            <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-700">{report.remarks}</p>
          )}
        </section>
      )}

      {editable && report.kind === "amc" && (
        <label className="flex items-start gap-2 rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-700">
          <input type="checkbox" className="mt-1" checked={ackRequired} onChange={(e) => setAckRequired(e.target.checked)} data-testid="ack-required-toggle" />
          <span>
            The customer must review and sign this report.
            <span className="block text-[11px] text-gray-400">If unticked, submitting finalises the report without a customer signature (it is then marked &ldquo;not signed&rdquo;).</span>
          </span>
        </label>
      )}
      {!editable && report.kind === "amc" && (
        <p className="text-xs text-gray-500" data-testid="ack-rule">
          {report.acknowledgementRequired ? "Customer acknowledgement and signature are required for this report." : "Customer acknowledgement is not required for this report."}
        </p>
      )}

      {/* Staff actions */}
      {editable && (
        <div className="flex flex-wrap gap-3" data-testid="staff-actions">
          <button onClick={save} disabled={busy !== null} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button onClick={submit} disabled={busy !== null || !p.canSubmit} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy === "submit" ? "Submitting…" : ackRequired || report.kind !== "amc" ? "Submit for customer signature" : "Finalise without customer signature"}
          </button>
        </div>
      )}
      {p.canReopen && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 space-y-2">
          <p>Submitted on {report.submittedAt ? new Date(report.submittedAt).toLocaleString() : "-"}. Waiting for the customer to review and sign.</p>
          <button onClick={reopen} disabled={busy !== null} className="font-medium underline disabled:opacity-50">
            {busy === "reopen" ? "Working…" : "Take back to draft to edit"}
          </button>
        </div>
      )}

      {/* Customer signing */}
      {p.canSign && (
        <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4" data-testid="sign-section">
          <h2 className="text-base font-semibold">Review and sign</h2>
          <p className="text-sm text-gray-600">Please read the report above. By signing you confirm that the work and findings described are correct. A signed report is final and cannot be changed.</p>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Your full name</label>
            <input className="field w-full" maxLength={SERVICE_REPORT_LIMITS.SIGNER_NAME_MAX} value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>
          <SignaturePad onChange={setSignatureImage} disabled={busy === "sign"} />
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>I have reviewed this report and approve it.</span>
          </label>
          <button onClick={signNow} disabled={!canFinishSigning} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {busy === "sign" ? "Signing…" : "Sign and finalise"}
          </button>
        </section>
      )}
      {report.status === SERVICE_REPORT_STATUS.AWAITING_SIGNATURE && !p.canSign && !p.canReopen && (
        <p className="text-sm text-gray-500">This report is waiting for the customer&apos;s signature.</p>
      )}

      {/* Submitted and final, but NOT signed (AMC, acknowledgement not required) */}
      {report.status === SERVICE_REPORT_STATUS.SUBMITTED && (
        <section className="space-y-3 rounded-xl border border-gray-300 bg-gray-50 p-4" data-testid="submitted-section">
          <h2 className="text-base font-semibold text-gray-800">Submitted and final - not signed</h2>
          <p className="text-sm text-gray-700">
            Finalised on {report.submittedAt ? new Date(report.submittedAt).toLocaleString() : "-"}. Customer acknowledgement was not required, so this report carries no signature and cannot be changed.
          </p>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => download(false)} disabled={busy !== null || !report.pdfAvailable} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {busy === "download" ? "Preparing…" : "Download PDF"}
            </button>
            <button onClick={() => download(true)} disabled={busy !== null || !report.pdfAvailable} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
              Open in a new tab
            </button>
          </div>
        </section>
      )}

      {/* Signed */}
      {report.status === SERVICE_REPORT_STATUS.SIGNED && (
        <section className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4" data-testid="signed-section">
          <h2 className="text-base font-semibold text-emerald-800">Signed and final</h2>
          <p className="text-sm text-emerald-900">
            Signed by <strong>{report.signerName}</strong> on {report.signedAt ? new Date(report.signedAt).toLocaleString() : "-"}.
          </p>
          {signatureUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={signatureUrl} alt={`Signature of ${report.signerName}`} className="h-24 rounded border border-emerald-200 bg-white p-1" />
          )}
          <div className="flex flex-wrap gap-3">
            <button onClick={() => download(false)} disabled={busy !== null || !report.pdfAvailable} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {busy === "download" ? "Preparing…" : "Download signed PDF"}
            </button>
            <button onClick={() => download(true)} disabled={busy !== null || !report.pdfAvailable} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
              Open in a new tab
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
