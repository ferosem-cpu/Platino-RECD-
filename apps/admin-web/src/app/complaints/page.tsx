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
  createdAt: string;
  assignedTo: { id: string; name: string } | null;
  site: { order: { customer: { name: string } } } | null;
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

function pretty(s: string) {
  return s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusBadge(status: string) {
  if (status === "open" || status === "escalated") return "status-pill status-pill-error";
  if (status === "resolved" || status === "closed") return "status-pill status-pill-success";
  return "status-pill status-pill-warning";
}

export default function ComplaintsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_complaints");

  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Editor modal
  const [editing, setEditing] = useState<ComplaintRow | null>(null);
  const [form, setForm] = useState({ status: "", rootCause: "", resolutionNotes: "", assignedToId: "" });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function load() {
    api<ComplaintRow[]>("/complaints").then(setComplaints).catch(() => {});
    api<Overview>("/complaints/overview").then(setOverview).catch(() => setOverview(null));
    if (canManage) api<Assignee[]>("/complaints/assignees").then(setAssignees).catch(() => {});
  }

  useEffect(load, [canManage]);

  function openEditor(c: ComplaintRow) {
    setEditing(c);
    setEditError(null);
    setForm({
      status: c.status,
      rootCause: c.rootCause ?? "",
      resolutionNotes: c.resolutionNotes ?? "",
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
      };
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
        <section>
          <h2 className="mb-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-gray-500">Company-wide, by status</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.entries(overview.countsByStatus).map(([status, count]) => (
              <div key={status} className="kpi-tile">
                <div className="kpi-tile-value">{count}</div>
                <div className="kpi-tile-label capitalize">{pretty(status)}</div>
              </div>
            ))}
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
                    <button
                      onClick={() => openEditor(c)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
                    >
                      {canManage ? "Manage" : "Update"}
                    </button>
                  </td>
                </tr>
              ))}
              {complaints.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No complaints to show.</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
              <button
                onClick={() => openEditor(c)}
                className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold hover:bg-gray-50"
                data-testid={`complaint-action-${c.ticketNumber}`}
              >
                {canManage ? "Manage" : "Update"}
              </button>
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
