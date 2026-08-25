"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { DataTable, DataTableColumn } from "@/components/DataTable";

interface Vendor {
  id: string;
  name: string;
  status: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string | null;
  approvedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  _count: { members: number; sites: number };
}

function statusBadge(status: string) {
  if (status === "approved") return "bg-green-100 text-green-800";
  if (status === "rejected") return "bg-red-100 text-red-800";
  if (status === "archived") return "bg-gray-200 text-gray-600";
  return "bg-amber-100 text-amber-800";
}

const emptyForm = { name: "", address: "", contactName: "", contactEmail: "", contactPhone: "" };

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ name: string; email: string; tempPassword?: string; created: boolean } | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const [archiveTarget, setArchiveTarget] = useState<Vendor | null>(null);
  const [archiveReassignTo, setArchiveReassignTo] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveResult, setArchiveResult] = useState<{ name: string; reassignedCount: number; reassignedToName: string | null } | null>(null);

  function load() {
    api<Vendor[]>("/vendors").then(setVendors).catch((e) => setError(e instanceof Error ? e.message : "Failed to load vendors"));
  }
  useEffect(load, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const res = await api<{ contactLoginCreated: boolean; contactEmail: string; tempPassword?: string; name: string }>("/vendors", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          address: form.address || undefined,
          contactName: form.contactName,
          contactEmail: form.contactEmail,
          contactPhone: form.contactPhone || undefined,
        }),
      });
      setApproval({ name: res.name, email: res.contactEmail, tempPassword: res.tempPassword, created: res.contactLoginCreated });
      setOpen(false);
      setForm(emptyForm);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to add vendor");
    } finally {
      setSaving(false);
    }
  }

  async function approve(v: Vendor) {
    setBusy(v.id);
    setError(null);
    try {
      const res = await api<{ contactLoginCreated: boolean; contactEmail: string; tempPassword?: string }>(`/vendors/${v.id}/approve`, { method: "POST" });
      setApproval({ name: v.name, email: res.contactEmail, tempPassword: res.tempPassword, created: res.contactLoginCreated });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve vendor");
    } finally {
      setBusy(null);
    }
  }

  async function reject(v: Vendor) {
    setBusy(v.id);
    setError(null);
    try {
      await api(`/vendors/${v.id}/reject`, { method: "POST" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reject vendor");
    } finally {
      setBusy(null);
    }
  }

  function openArchive(v: Vendor) {
    setArchiveTarget(v);
    setArchiveReassignTo("");
    setArchiveError(null);
  }

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const res = await api<{ sitesReassignedTo: string | null; sitesReassignedCount: number }>(
        `/vendors/${archiveTarget.id}/archive`,
        { method: "POST", body: JSON.stringify({ reassignSitesToVendorId: archiveReassignTo || undefined }) },
      );
      const reassignedToName = res.sitesReassignedTo ? vendors.find((v) => v.id === res.sitesReassignedTo)?.name ?? null : null;
      setArchiveResult({ name: archiveTarget.name, reassignedCount: res.sitesReassignedCount, reassignedToName });
      setArchiveTarget(null);
      load();
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : "Failed to archive vendor");
    } finally {
      setArchiveBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Vendors</h1>
          <p className="mt-1 text-sm text-gray-500">
            External erection subcontractors. Review a registration, run due diligence, then approve — approval creates the vendor&apos;s first engineer login. Or add a known vendor directly below.
          </p>
        </div>
        <button
          onClick={() => { setForm(emptyForm); setFormError(null); setOpen(true); }}
          className="btn-primary px-4 py-2 text-sm self-start sm:self-auto whitespace-nowrap"
        >
          + Add vendor
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 print:hidden">{error}</div>
      )}

      {approval && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 print:hidden">
          <p><strong>{approval.name}</strong> approved.</p>
          {approval.created ? (
            <p className="mt-1">
              Login created for <span className="font-mono">{approval.email}</span>
              {approval.tempPassword && (
                <> — temporary password: <code className="rounded bg-green-100 px-2 py-0.5 font-mono font-semibold">{approval.tempPassword}</code></>
              )}
            </p>
          ) : (
            <p className="mt-1">A user with that email already exists, so no new login was created.</p>
          )}
          <button onClick={() => setApproval(null)} className="mt-2 text-xs text-green-700 underline">Dismiss</button>
        </div>
      )}

      {archiveResult && (
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700 print:hidden">
          <p><strong>{archiveResult.name}</strong> archived — its history (sites, complaints, work orders) is untouched, and it no longer appears in any active selection.</p>
          {archiveResult.reassignedCount > 0 && (
            <p className="mt-1">{archiveResult.reassignedCount} site(s) reassigned to <strong>{archiveResult.reassignedToName ?? "the selected vendor"}</strong>.</p>
          )}
          <button onClick={() => setArchiveResult(null)} className="mt-2 text-xs text-gray-500 underline">Dismiss</button>
        </div>
      )}

      <DataTable
        title="Vendors"
        storageKey="vendors"
        rows={vendors}
        rowKey={(v) => v.id}
        emptyMessage="No vendors registered yet."
        columns={[
          {
            key: "name",
            label: "Vendor",
            accessor: (v) => v.name,
            filterType: "text",
            alwaysVisible: true,
            render: (v) => (
              <>
                <div className="font-medium">{v.name}</div>
                <div className="text-xs text-gray-400">{v.address ?? "—"}</div>
              </>
            ),
          },
          {
            key: "contact",
            label: "Contact",
            accessor: (v) => `${v.contactName} ${v.contactEmail} ${v.contactPhone ?? ""}`,
            filterType: "text",
            render: (v) => (
              <>
                <div>{v.contactName}</div>
                <div className="text-xs text-gray-400">{v.contactEmail}{v.contactPhone ? ` · ${v.contactPhone}` : ""}</div>
              </>
            ),
          },
          {
            key: "status",
            label: "Status",
            accessor: (v) => v.status,
            render: (v) => <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusBadge(v.status)}`}>{v.status}</span>,
          },
          { key: "engineers", label: "Engineers", accessor: (v) => v._count.members },
          { key: "sites", label: "Sites", accessor: (v) => v._count.sites },
          {
            key: "action",
            label: "Action",
            align: "right",
            alwaysVisible: true,
            filterable: false,
            render: (v) => (
              <div className="flex items-center justify-end gap-2">
                {v.status === "pending" ? (
                  <>
                    <button
                      onClick={() => approve(v)}
                      disabled={busy === v.id}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {busy === v.id ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => reject(v)}
                      disabled={busy === v.id}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                ) : v.status === "rejected" ? (
                  <button
                    onClick={() => approve(v)}
                    disabled={busy === v.id}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Reconsider
                  </button>
                ) : v.status === "archived" ? (
                  <span className="text-xs text-gray-400">Archived {v.archivedAt ? new Date(v.archivedAt).toLocaleDateString() : ""}</span>
                ) : (
                  <>
                    <span className="text-xs text-gray-400">Approved {v.approvedAt ? new Date(v.approvedAt).toLocaleDateString() : ""}</span>
                    <button
                      onClick={() => openArchive(v)}
                      disabled={busy === v.id}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Archive
                    </button>
                  </>
                )}
              </div>
            ),
          },
        ]}
      >
        {(filteredVendors) => (
          <div className="cards-mobile" data-testid="vendors-mobile-cards">
            {filteredVendors.length === 0 ? (
              <div className="card p-6 text-center text-sm text-gray-400">
                {vendors.length === 0 ? "No vendors registered yet." : "No rows match the current filters."}
              </div>
            ) : (
              filteredVendors.map((v) => (
            <div key={v.id} className="data-card" data-testid={`vendor-card-${v.id}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{v.name}</p>
                  <p className="text-xs text-gray-500 truncate">{v.address ?? "—"}</p>
                </div>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize whitespace-nowrap ${statusBadge(v.status)}`}>
                  {v.status}
                </span>
              </div>
              <div className="data-card-row">
                <span className="label">Contact</span>
                <span className="value truncate">{v.contactName}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Email</span>
                <span className="value truncate">{v.contactEmail}</span>
              </div>
              {v.contactPhone && (
                <div className="data-card-row">
                  <span className="label">Phone</span>
                  <span className="value">{v.contactPhone}</span>
                </div>
              )}
              <div className="data-card-row">
                <span className="label">Engineers</span>
                <span className="value">{v._count.members}</span>
              </div>
              <div className="data-card-row">
                <span className="label">Sites</span>
                <span className="value">{v._count.sites}</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                {v.status === "pending" ? (
                  <>
                    <button
                      onClick={() => approve(v)}
                      disabled={busy === v.id}
                      className="flex-1 rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {busy === v.id ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => reject(v)}
                      disabled={busy === v.id}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                ) : v.status === "rejected" ? (
                  <button
                    onClick={() => approve(v)}
                    disabled={busy === v.id}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Reconsider
                  </button>
                ) : v.status === "archived" ? (
                  <span className="text-xs text-gray-400">Archived {v.archivedAt ? new Date(v.archivedAt).toLocaleDateString() : ""}</span>
                ) : (
                  <>
                    <span className="text-xs text-gray-400">Approved {v.approvedAt ? new Date(v.approvedAt).toLocaleDateString() : ""}</span>
                    <button
                      onClick={() => openArchive(v)}
                      disabled={busy === v.id}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Archive
                    </button>
                  </>
                )}
              </div>
            </div>
              ))
            )}
          </div>
        )}
      </DataTable>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Add vendor</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={submit} className="space-y-3">
              <input required placeholder="Vendor / company name" className="field w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <textarea placeholder="Address (optional)" rows={2} className="field w-full" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input required placeholder="Contact name" className="field" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                <input required type="email" placeholder="Contact email (login)" className="field" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              </div>
              <input placeholder="Contact phone (optional)" className="field w-full" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
              <p className="text-[11px] text-gray-400">Added directly by staff, this vendor is approved immediately - no due-diligence review needed. Their contact gets an erection-engineer login right away.</p>

              {formError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{formError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? "Adding…" : "Add vendor"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {archiveTarget && (
        <div className="modal-backdrop" onClick={() => !archiveBusy && setArchiveTarget(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Archive {archiveTarget.name}</h3>
              <button onClick={() => setArchiveTarget(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="space-y-3 text-sm">
              <p className="text-gray-600">
                This removes {archiveTarget.name} from every active selection (new site assignments, new engineer
                logins) and signs out its {archiveTarget._count.members} engineer login(s). Nothing is deleted — every
                site, complaint, and work order it was ever tied to stays exactly as it is, still attributed to this
                vendor.
              </p>
              {archiveTarget._count.sites > 0 && (
                <>
                  <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    {archiveTarget.name} currently has {archiveTarget._count.sites} site(s) assigned. If any are still
                    in progress, move them to another approved vendor now so the work doesn&apos;t stall.
                  </p>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Reassign its sites to (optional)</label>
                    <select
                      className="field w-full"
                      value={archiveReassignTo}
                      onChange={(e) => setArchiveReassignTo(e.target.value)}
                    >
                      <option value="">Leave sites as-is</option>
                      {vendors.filter((v) => v.status === "approved" && v.id !== archiveTarget.id).map((v) => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {archiveError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{archiveError}</p>}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setArchiveTarget(null)}
                  disabled={archiveBusy}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmArchive}
                  disabled={archiveBusy}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {archiveBusy ? "Archiving…" : "Archive vendor"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
