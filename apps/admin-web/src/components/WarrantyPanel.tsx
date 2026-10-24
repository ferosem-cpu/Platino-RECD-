"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { formatDay } from "@/lib/amcUi";
import {
  warrantyDaysText,
  warrantyFormError,
  warrantySourceLabel,
  warrantyStatusLabel,
  warrantyStatusPill,
  type UnitWarranty,
  type WarrantyHistoryRow,
} from "@/lib/warrantyUi";

/**
 * Warranty of ONE unit on the unit detail page: recorded dates, status, effective duration and provenance, the history, and (only for
 * users holding manage_warranty - the server enforces it too) the form to establish or correct the period.
 */
export default function WarrantyPanel({ unitId, warranty, productMonths, canEdit, onChanged }: { unitId: string; warranty: UnitWarranty; productMonths: number | null; canEdit: boolean; onChanged: () => void }) {
  const [history, setHistory] = useState<WarrantyHistoryRow[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    api<WarrantyHistoryRow[]>(`/recd-units/${unitId}/warranty-history`)
      .then((r) => { setHistory(r); setHistoryError(null); })
      .catch((err) => setHistoryError(apiErrorMessage(err, "Could not load the warranty history")));
  }, [unitId]);
  useEffect(loadHistory, [loadHistory]);

  const recorded = warranty.status !== "unknown";
  return (
    <section className="card p-4 space-y-3" data-testid="unit-warranty">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Warranty</h2>
        {canEdit && (
          <button onClick={() => { setNotice(null); setEditing(true); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid="warranty-edit-button">
            {recorded ? "Correct warranty" : "Record warranty"}
          </button>
        )}
      </div>
      {notice && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2" data-testid="warranty-notice">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <span className={warrantyStatusPill(warranty.status)} data-testid="warranty-status">{warrantyStatusLabel(warranty.status)}</span>
        <span className="text-xs text-gray-500" data-testid="warranty-days">{warrantyDaysText(warranty)}</span>
      </div>
      {recorded ? (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm" data-testid="warranty-dates">
          <div><dt className="text-xs text-gray-400">Start date</dt><dd>{formatDay(warranty.startDate)}</dd></div>
          <div><dt className="text-xs text-gray-400">Expiry date (inclusive)</dt><dd>{formatDay(warranty.endDate)}</dd></div>
          <div><dt className="text-xs text-gray-400">Duration</dt><dd>{warranty.durationMonths != null ? `${warranty.durationMonths} months` : "Custom period"}</dd></div>
          <div><dt className="text-xs text-gray-400">Recorded as</dt><dd className="text-xs">{warrantySourceLabel(warranty.source)}</dd></div>
        </dl>
      ) : (
        <p className="text-xs text-gray-500" data-testid="warranty-unknown">
          The product&apos;s standard warranty is {productMonths != null ? `${productMonths} months` : "not configured"}, but this unit&apos;s own start and expiry dates have not been recorded, so its warranty is not treated as active.
        </p>
      )}

      <div>
        <h3 className="text-xs font-semibold text-gray-500 mb-1">Warranty history</h3>
        {historyError && <p role="alert" className="text-xs text-red-600">{historyError}</p>}
        {!historyError && history === null && <p className="text-xs text-gray-400">Loading…</p>}
        {history && history.length === 0 && <p className="text-xs text-gray-400" data-testid="warranty-history-empty">No warranty changes have been recorded.</p>}
        {history && history.length > 0 && (
          <ol className="space-y-2" data-testid="warranty-history">
            {history.map((h) => (
              <li key={h.id} className="rounded-lg border border-gray-200 p-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={h.kind === "established" ? "status-pill status-pill-success" : "status-pill status-pill-warning"}>{h.kind === "established" ? "Recorded" : "Corrected"}</span>
                  <span className="text-gray-500">{new Date(h.at).toLocaleString()}{h.by ? ` · ${h.by}` : ""}</span>
                </div>
                {h.previousStartDate && <div className="mt-1 text-gray-600">Before: {formatDay(h.previousStartDate)} to {formatDay(h.previousEndDate)}{h.previousMonths != null ? ` (${h.previousMonths} months)` : ""}</div>}
                <div className="font-medium">{h.previousStartDate ? "After" : "Recorded"}: {formatDay(h.newStartDate)} to {formatDay(h.newEndDate)}{h.newMonths != null ? ` (${h.newMonths} months)` : ""}</div>
                {h.reason && <div className="text-gray-500">Reason: {h.reason}</div>}
              </li>
            ))}
          </ol>
        )}
      </div>

      {editing && (
        <WarrantyEditDialog
          unitId={unitId}
          warranty={warranty}
          productMonths={productMonths}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setNotice("Warranty saved and recorded in the history."); loadHistory(); onChanged(); }}
        />
      )}
    </section>
  );
}

function WarrantyEditDialog({ unitId, warranty, productMonths, onClose, onSaved }: { unitId: string; warranty: UnitWarranty; productMonths: number | null; onClose: () => void; onSaved: () => void }) {
  const hasExisting = warranty.status !== "unknown";
  const [startDate, setStartDate] = useState(warranty.startDate ?? "");
  const [endDate, setEndDate] = useState(warranty.endDate ?? "");
  const [months, setMonths] = useState(warranty.durationMonths != null ? String(warranty.durationMonths) : "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const problem = warrantyFormError({ startDate, endDate, months, reason, hasExisting });
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await api(`/recd-units/${unitId}/warranty`, {
        method: "PUT",
        body: JSON.stringify({
          startDate,
          expectedEndDate: warranty.endDate,
          ...(endDate ? { endDate } : {}),
          ...(months !== "" ? { durationMonths: Number(months) } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not save the warranty"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-label="Record warranty" data-testid="warranty-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{hasExisting ? "Correct warranty" : "Record warranty"}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Enter the start date, then either the expiry date or a duration. With only a start date the product&apos;s standard duration ({productMonths != null ? `${productMonths} months` : "not configured - enter an expiry date or duration"}) is used and stored on this unit. The expiry date is inclusive.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs font-medium text-gray-500">Start date
              <input type="date" className="field w-full mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="warranty-start" />
            </label>
            <label className="block text-xs font-medium text-gray-500">Expiry date
              <input type="date" className="field w-full mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} data-testid="warranty-end" />
            </label>
            <label className="block text-xs font-medium text-gray-500">Duration (months)
              <input type="number" min={1} max={120} className="field w-full mt-1" value={months} onChange={(e) => setMonths(e.target.value)} placeholder={productMonths != null ? String(productMonths) : ""} data-testid="warranty-months" />
            </label>
          </div>
          <label className="block text-xs font-medium text-gray-500">{hasExisting ? "Reason for the correction (kept in the history)" : "Note (optional)"}
            <input className="field w-full mt-1" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="warranty-reason" />
          </label>
          {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" data-testid="warranty-error">{error}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm" data-testid="warranty-submit">{saving ? "Saving…" : "Save warranty"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
