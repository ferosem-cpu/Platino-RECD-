"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";
import { COMPLAINT_STATUS } from "@recd/shared";

interface ComplaintRow {
  id: string;
  ticketNumber: string;
  category: string;
  severity: string;
  status: string;
  description: string;
  rootCause: string | null;
  resolutionNotes: string | null;
  remarks: string | null;
  serviceReportUrl: string | null;
  attachmentUrl: string | null;
  createdAt: string;
  assignedTo: { id: string; name: string } | null;
  site: { order: { customer: { name: string } } } | null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface Assignee {
  id: string;
  name: string;
  role: { name: string };
}

interface Overview {
  countsByStatus: Record<string, number>;
}

const STATUS_VALUES = Object.values(COMPLAINT_STATUS);

/** Display-only label overrides - underlying status keys are unchanged. */
const STATUS_LABEL_OVERRIDES: Record<string, string> = {
  waiting_for_customer: "Waiting for Customer Approval",
};

function pretty(s: string) {
  if (STATUS_LABEL_OVERRIDES[s]) return STATUS_LABEL_OVERRIDES[s];
  return s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusBadge(status: string) {
  if (status === "open" || status === "escalated") return "status-pill status-pill-error";
  if (status === "resolved" || status === "closed") return "status-pill status-pill-success";
  return "status-pill status-pill-warning";
}

/** Icon + color per status for the company-wide overview tiles. */
const STATUS_TILE_STYLE: Record<string, { bg: string; fg: string; icon: string }> = {
  open: { bg: "#FEE2E2", fg: "#DC2626", icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" },
  acknowledged: { bg: "#FFEDD5", fg: "#EA580C", icon: "M4.5 12.75l6 6 9-13.5" },
  assigned: { bg: "#DBEAFE", fg: "#2563EB", icon: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" },
  in_progress: { bg: "#EDE9FE", fg: "#7C3AED", icon: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" },
  waiting_for_customer: { bg: "#FEF3C7", fg: "#D97706", icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" },
  waiting_for_part: { bg: "#FEF3C7", fg: "#D97706", icon: "M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" },
  escalated: { bg: "#FCE7F3", fg: "#DB2777", icon: "M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" },
  resolved: { bg: "#DCFCE7", fg: "#16A34A", icon: "M4.5 12.75l6 6 9-13.5" },
  closed: { bg: "#F3F4F6", fg: "#6B7280", icon: "M6 18L18 6M6 6l12 12" },
};

export default function ComplaintsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_complaints");

  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Editor modal
  const [editing, setEditing] = useState<ComplaintRow | null>(null);
  const [form, setForm] = useState({ status: "", rootCause: "", resolutionNotes: "", remarks: "", assignedToId: "" });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [serviceReportFile, setServiceReportFile] = useState<File | null>(null);

  function load() {
    api<ComplaintRow[]>("/complaints").then(setComplaints).catch(() => {});
    api<Overview>("/complaints/overview").then(setOverview).catch(() => setOverview(null));
    if (canManage) api<Assignee[]>("/complaints/assignees").then(setAssignees).catch(() => {});
  }

  useEffect(load, [canManage]);

  async function rejectOrDelete(c: ComplaintRow) {
    if (!confirm(`Remove complaint ${c.ticketNumber}? This is for spam or wrong-RECD-serial-number entries and cannot be undone.`)) return;
    setDeletingId(c.id);
    try {
      await api(`/complaints/${c.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete complaint");
    } finally {
      setDeletingId(null);
    }
  }

  function openEditor(c: ComplaintRow) {
    setEditing(c);
    setEditError(null);
    setServiceReportFile(null);
    setForm({
      status: c.status,
      rootCause: c.rootCause ?? "",
      resolutionNotes: c.resolutionNotes ?? "",
      remarks: c.remarks ?? "",
      assignedToId: c.assignedTo?.id ?? "",
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {
        status: form.status,
        rootCause: form.rootCause || undefined,
        resolutionNotes: form.resolutionNotes || undefined,
        remarks: form.remarks || undefined,
      };
      if (serviceReportFile) body.serviceReportUrl = await fileToDataUrl(serviceReportFile);
      if (canManage) body.assignedToId = form.assignedToId || null;
      await api(`/complaints/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setEditing(null);
      load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update complaint");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="complaints-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Complaints</h1>
        <p className="mt-1 text-sm text-gray-500">
          {canManage
            ? "Triage, assign to an engineer, and resolve customer tickets."
            : "Tickets assigned to you. Update their status as you work them."}
        </p>
      </div>

      {overview && (
        <section className="rounded-xl border border-red-200 bg-red-50/30 p-4">
          <h2 className="mb-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-red-600">Company-wide, by status</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.entries(overview.countsByStatus).map(([status, count]) => {
              const style = STATUS_TILE_STYLE[status] ?? { bg: "#F3F4F6", fg: "#6B7280", icon: "" };
              return (
                <div key={status} className="kpi-tile bg-white">
                  <div
                    className="mb-2 flex h-9 w-9 items-center justify-center rounded-full"
                    style={{ backgroundColor: style.bg }}
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke={style.fg} strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={style.icon} />
                    </svg>
                  </div>
                  <div className="kpi-tile-value">{count}</div>
                  <div className="kpi-tile-label capitalize">{pretty(status)}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Desktop table */}
      <div className="card overflow-hidden table-desktop">
        <div className="table-scroll">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Ticket</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Assigned to</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {complaints.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3 font-mono text-xs font-semibold">{c.ticketNumber}</td>
                  <td className="px-4 py-3">{c.site?.order.customer.name ?? "—"}</td>
                  <td className="px-4 py-3 capitalize">{pretty(c.category)}</td>
                  <td className="px-4 py-3 capitalize">{c.severity}</td>
                  <td className="px-4 py-3">
                    <span className={statusBadge(c.status)}>
                      {pretty(c.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.assignedTo?.name ?? "Unassigned"}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => openEditor(c)}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
                      >
                        {canManage ? "Manage" : "Update"}
                      </button>
                      {canManage && (
                        <button
                          onClick={() => rejectOrDelete(c)}
                          disabled={deletingId === c.id}
                          className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          {deletingId === c.id ? "Removing…" : "Reject or delete"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {complaints.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No complaints to show.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {canManage && complaints.length > 0 && (
          <div className="flex items-start gap-2 border-t border-gray-100 bg-gray-50/60 px-4 py-3 text-xs text-gray-500">
            <svg className="h-4 w-4 shrink-0 mt-0.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            <p>The <strong>Reject or delete</strong> button removes unwanted customer complaint entries — ones raised with the wrong RECD serial number, or spam customers.</p>
          </div>
        )}
      </div>

      {/* Mobile cards */}
      <div className="cards-mobile" data-testid="complaints-mobile-cards">
        {complaints.length === 0 ? (
          <div className="card p-6 text-center text-sm text-gray-400">No complaints to show.</div>
        ) : (
          complaints.map((c) => (
            <div key={c.id} className="data-card" data-testid={`complaint-card-${c.ticketNumber}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="font-mono text-xs font-semibold text-gray-900">{c.ticketNumber}</span>
                <span className={statusBadge(c.status)}>
                  {pretty(c.status)}
                </span>
              </div>
              <p className="text-sm font-semibold text-gray-900 truncate">{c.site?.order.customer.name ?? "—"}</p>
              <p className="text-xs text-gray-500 capitalize">{pretty(c.category)} · {c.severity}</p>
              <p className="text-xs text-gray-500 mt-1">Assigned: {c.assignedTo?.name ?? "Unassigned"}</p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => openEditor(c)}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold hover:bg-gray-50"
                  data-testid={`complaint-action-${c.ticketNumber}`}
                >
                  {canManage ? "Manage" : "Update"}
                </button>
                {canManage && (
                  <button
                    onClick={() => rejectOrDelete(c)}
                    disabled={deletingId === c.id}
                    className="flex-1 rounded-lg border border-red-300 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {deletingId === c.id ? "Removing…" : "Reject or delete"}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">{editing.ticketNumber}</h3>
                <p className="text-xs text-gray-500 capitalize">{pretty(editing.category)} · {editing.severity}</p>
              </div>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <p className="mb-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 border border-gray-100">{editing.description}</p>

            {editing.attachmentUrl && (
              <a href={editing.attachmentUrl} target="_blank" rel="noreferrer" className="mb-4 block">
                <img src={editing.attachmentUrl} alt="Customer attachment" className="h-28 rounded-lg border border-gray-200 object-cover" />
                <p className="mt-1 text-[11px] text-gray-400">Customer-submitted photo — click to view full size</p>
              </a>
            )}

            <form onSubmit={save} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                  <select
                    className="field w-full"
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                  >
                    {STATUS_VALUES.map((s) => (
                      <option key={s} value={s}>{pretty(s)}</option>
                    ))}
                  </select>
                </div>
                {canManage && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Assign to</label>
                    <select
                      className="field w-full"
                      value={form.assignedToId}
                      onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
                    >
                      <option value="">Unassigned</option>
                      {assignees.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} ({a.role.name})</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Root cause</label>
                <input
                  className="field w-full"
                  value={form.rootCause}
                  onChange={(e) => setForm({ ...form, rootCause: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Resolution notes</label>
                <textarea
                  rows={3}
                  className="field w-full"
                  value={form.resolutionNotes}
                  onChange={(e) => setForm({ ...form, resolutionNotes: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Remarks</label>
                <textarea
                  rows={2}
                  placeholder="Enter remarks"
                  className="field w-full"
                  value={form.remarks}
                  onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Service report Attachment</label>
                {editing.serviceReportUrl && !serviceReportFile && (
                  <a href={editing.serviceReportUrl} target="_blank" rel="noreferrer" className="mb-1.5 inline-block text-xs font-medium text-[var(--theme-accent)]">
                    View current attachment
                  </a>
                )}
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  className="field w-full text-xs"
                  onChange={(e) => setServiceReportFile(e.target.files?.[0] ?? null)}
                />
                <p className="mt-1 text-[10px] text-gray-400">PDF, JPG, PNG (Max. 10MB)</p>
              </div>

              {editError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{editError}</p>}

              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? "Saving…" : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
