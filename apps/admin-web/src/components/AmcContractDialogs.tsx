"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { apiErrorMessage } from "@/lib/apiError";
import { formatDay, type AmcHistoryRow } from "@/lib/amcUi";

/** What the dialogs need to know about a contract; `basePath` is "/amc-orders" or "/vendor-amcs" (the two kinds never share rows). */
export interface ContractTarget {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
}

function Modal({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-label={title} data-testid={testId} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** RENEW: the same contract continues into a new period. Blank dates = start the day after the current end, for the default duration. */
export function RenewDialog({ target, basePath, defaultMonths, onClose, onDone }: { target: ContractTarget; basePath: string; defaultMonths: number; onClose: () => void; onDone: (msg: string) => void }) {
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [months, setMonths] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return; // a double click must not send two renewals
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { expectedEndDate: target.endDate };
      if (newStart) body.newStartDate = newStart;
      if (newEnd) body.newEndDate = newEnd;
      else if (months) body.durationMonths = Number(months);
      if (note.trim()) body.note = note.trim();
      const r = await api<{ newStartDate: string; newEndDate: string }>(`${basePath}/${target.id}/renew`, { method: "POST", body: JSON.stringify(body) });
      onDone(`Renewed: ${formatDay(r.newStartDate)} to ${formatDay(r.newEndDate)}.`);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not renew this contract"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Renew ${target.label}`} onClose={onClose} testId="amc-renew-dialog">
      <p className="mb-3 text-sm text-gray-600">Current period: {formatDay(target.startDate)} to {formatDay(target.endDate)}. The old period stays in the history.</p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-gray-500">New start date
            <input type="date" className="field w-full mt-1" value={newStart} onChange={(e) => setNewStart(e.target.value)} data-testid="renew-start" />
            <span className="text-[11px] text-gray-400">Blank = the day after the current end</span>
          </label>
          <label className="block text-xs font-medium text-gray-500">New end date
            <input type="date" className="field w-full mt-1" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} data-testid="renew-end" />
            <span className="text-[11px] text-gray-400">Blank = start + duration</span>
          </label>
        </div>
        <label className="block text-xs font-medium text-gray-500">Duration in months (when no end date is given)
          <input type="number" min={1} max={120} className="field w-full mt-1" placeholder={String(defaultMonths)} value={months} onChange={(e) => setMonths(e.target.value)} disabled={!!newEnd} data-testid="renew-months" />
        </label>
        <label className="block text-xs font-medium text-gray-500">Note (optional)
          <input className="field w-full mt-1" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="renew-note" />
        </label>
        {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" data-testid="renew-error">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm" data-testid="renew-submit">{saving ? "Renewing…" : "Renew contract"}</button>
        </div>
      </form>
    </Modal>
  );
}

export interface EditField {
  key: string;
  label: string;
  value: string;
  type?: "text" | "number";
  required?: boolean;
}

/** EDIT: plain details change directly; changing a date is a correction that needs a reason and is kept in the history. */
export function EditDialog({ target, basePath, fields, onClose, onDone }: { target: ContractTarget; basePath: string; fields: EditField[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [start, setStart] = useState(target.startDate);
  const [end, setEnd] = useState(target.endDate);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const datesChanged = start !== target.startDate || end !== target.endDate;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        if (values[f.key] === f.value) continue;
        body[f.key] = f.type === "number" ? Number(values[f.key]) : values[f.key];
      }
      if (datesChanged) {
        if (start !== target.startDate) body.startDate = start;
        if (end !== target.endDate) body.endDate = end;
        body.reason = reason;
      }
      if (Object.keys(body).length === 0) throw new Error(JSON.stringify("Nothing was changed"));
      await api(`${basePath}/${target.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onDone(datesChanged ? "Saved. The date change is recorded in the history." : "Saved.");
    } catch (err) {
      setError(apiErrorMessage(err, "Could not save the changes"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit ${target.label}`} onClose={onClose} testId="amc-edit-dialog">
      <form onSubmit={submit} className="space-y-3">
        {fields.map((f) => (
          <label key={f.key} className="block text-xs font-medium text-gray-500">{f.label}
            <input required={f.required} type={f.type ?? "text"} className="field w-full mt-1" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} data-testid={`edit-${f.key}`} />
          </label>
        ))}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-gray-500">Start date
            <input type="date" required className="field w-full mt-1" value={start} onChange={(e) => setStart(e.target.value)} data-testid="edit-start" />
          </label>
          <label className="block text-xs font-medium text-gray-500">End date
            <input type="date" required className="field w-full mt-1" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="edit-end" />
          </label>
        </div>
        {datesChanged && (
          <label className="block text-xs font-medium text-gray-500">Reason for changing the dates (kept in the history)
            <input required minLength={3} maxLength={500} className="field w-full mt-1" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="edit-reason" />
          </label>
        )}
        {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" data-testid="edit-error">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm" data-testid="edit-submit">{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** HISTORY: every renewal and date correction, newest first. Loading, empty and error states are all shown. */
export function HistoryDialog({ target, basePath, onClose }: { target: ContractTarget; basePath: string; onClose: () => void }) {
  const [rows, setRows] = useState<AmcHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<AmcHistoryRow[]>(`${basePath}/${target.id}/renewals`)
      .then((r) => live && setRows(r))
      .catch((err) => live && setError(apiErrorMessage(err, "Could not load the history")));
    return () => { live = false; };
  }, [basePath, target.id]);

  return (
    <Modal title={`History of ${target.label}`} onClose={onClose} testId="amc-history-dialog">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!error && rows === null && <p className="text-sm text-gray-400">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-sm text-gray-400" data-testid="history-empty">No renewals or date changes yet. Current period: {formatDay(target.startDate)} to {formatDay(target.endDate)}.</p>}
      {rows && rows.length > 0 && (
        <ol className="space-y-3 max-h-80 overflow-y-auto" data-testid="history-list">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-gray-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={r.kind === "renewal" ? "status-pill status-pill-success" : "status-pill status-pill-warning"}>{r.kind === "renewal" ? "Renewal" : "Date correction"}</span>
                <span className="text-xs text-gray-500">{new Date(r.at).toLocaleString()} · {r.by ?? "removed user"}</span>
              </div>
              <div className="mt-2 text-xs text-gray-600">Before: {formatDay(r.previousStartDate)} to {formatDay(r.previousEndDate)}</div>
              <div className="text-xs font-medium">After: {formatDay(r.newStartDate)} to {formatDay(r.newEndDate)}</div>
              {r.note && <div className="mt-1 text-xs text-gray-500">Note: {r.note}</div>}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4 flex justify-end"><button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Close</button></div>
    </Modal>
  );
}
