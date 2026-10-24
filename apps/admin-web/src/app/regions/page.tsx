"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface Manager {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}

interface RegionRow {
  id: string;
  name: string;
  isActive: boolean;
  siteCount: number;
  managers: Manager[];
}

interface UserOption {
  id: string;
  name: string;
  isActive: boolean;
  role: { key: string; name?: string };
}

interface AuditRow { id: string; at: string; by: string; before: string[]; after: string[] }

const MAPPABLE_ROLES = ["regional_manager", "service_manager"];
const ROLE_LABEL: Record<string, string> = { regional_manager: "Regional Manager", service_manager: "Service Manager" };

export default function RegionsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_regions");
  const [regions, setRegions] = useState<RegionRow[]>([]);
  const [managerCandidates, setManagerCandidates] = useState<UserOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [managersFor, setManagersFor] = useState<RegionRow | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);

  const load = useCallback(() => {
    api<RegionRow[]>("/regions").then(setRegions).catch((e) => setError(e instanceof Error ? e.message : "Failed to load regions"));
  }, []);

  useEffect(() => {
    load();
    if (canManage && hasPermission("manage_users")) {
      api<UserOption[]>("/users")
        .then((us) => setManagerCandidates(us.filter((u) => u.isActive && MAPPABLE_ROLES.includes(u.role.key))))
        .catch(() => {});
    }
  }, [load, canManage, hasPermission]);

  function flash(msg: string) {
    setBanner(msg);
    setTimeout(() => setBanner(null), 3000);
  }

  async function createRegion(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api("/regions", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
      setNewName("");
      flash("Region added.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add region");
    } finally {
      setCreating(false);
    }
  }

  async function renameRegion(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/regions/${editing.id}`, { method: "PUT", body: JSON.stringify({ name: editing.name.trim() }) });
      setEditing(null);
      flash("Region renamed.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename region");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(r: RegionRow) {
    setError(null);
    try {
      await api(`/regions/${r.id}`, { method: "PUT", body: JSON.stringify({ isActive: !r.isActive }) });
      flash(r.isActive ? "Region deactivated." : "Region reactivated.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update region");
    }
  }

  function openManagers(r: RegionRow) {
    setManagersFor(r);
    setSelected(r.managers.map((m) => m.id));
    setAudit(null);
    api<AuditRow[]>(`/regions/${r.id}/audit`).then(setAudit).catch(() => setAudit([]));
  }

  async function saveManagers() {
    if (!managersFor) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/regions/${managersFor.id}/managers`, { method: "PUT", body: JSON.stringify({ userIds: selected }) });
      setManagersFor(null);
      flash("Managers saved.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save managers");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl" data-testid="regions-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: "var(--text-heading)" }}>Regions</h1>
        <p className="mt-1 text-sm text-gray-500">
          Service regions and the Service Managers and Regional Managers responsible for them. Assign a region to each site from its page; reminders and escalations go to that region&apos;s managers.
        </p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}
      {banner && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">{banner}</div>}

      {canManage && (
        <form onSubmit={createRegion} className="card p-4 flex flex-wrap items-end gap-3" data-testid="region-add-form">
          <div className="flex-1 min-w-[12rem]">
            <label className="block text-xs text-gray-500 mb-1">New region</label>
            <input
              required
              minLength={2}
              maxLength={80}
              placeholder="e.g. Chennai, Coimbatore, Karnataka"
              className="field w-full"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="region-name-input"
            />
          </div>
          <button type="submit" disabled={creating} className="btn-primary px-4 py-2 text-sm">
            {creating ? "Adding…" : "+ Add region"}
          </button>
        </form>
      )}

      <div className="space-y-3">
        {regions.length === 0 && <p className="text-sm text-gray-400">No regions yet.</p>}
        {regions.map((r) => (
          <section key={r.id} className={`card p-4 space-y-2 ${r.isActive ? "" : "opacity-70"}`} data-testid={`region-${r.name}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">
                  {r.name}
                  {!r.isActive && <span className="ml-2 badge">inactive</span>}
                </h2>
                <p className="text-xs text-gray-400">{r.siteCount} site(s)</p>
              </div>
              {canManage && (
                <div className="flex gap-3 text-xs font-medium">
                  <button type="button" className="text-[var(--theme-accent)]" onClick={() => openManagers(r)}>Managers</button>
                  <button type="button" className="text-[var(--theme-accent)]" onClick={() => setEditing({ id: r.id, name: r.name })}>Rename</button>
                  <button type="button" className={r.isActive ? "text-red-600" : "text-green-700"} onClick={() => toggleActive(r)}>
                    {r.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-600">
              {r.managers.length === 0
                ? <span className="text-amber-600">No manager mapped yet - reminders for this region have no recipient</span>
                : r.managers.map((m) => `${m.name}${m.phone ? ` (${m.phone})` : ""}`).join(", ")}
            </p>
          </section>
        ))}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-3">Rename region</h3>
            <form onSubmit={renameRegion} className="space-y-4">
              <input required minLength={2} maxLength={80} className="field w-full" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? "Saving…" : "Save"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {managersFor && (
        <div className="modal-backdrop" onClick={() => setManagersFor(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-1">Managers - {managersFor.name}</h3>
            <p className="text-xs text-gray-500 mb-3">
              Only active users with the Service Manager or Regional Manager role can be mapped. Reminders go to the region&apos;s Service Managers first (Regional Managers if there are none). Add people on the Users page first.
            </p>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {managerCandidates.length === 0 && <p className="text-sm text-gray-400">No Service Manager or Regional Manager users yet.</p>}
              {managerCandidates.map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(u.id)}
                    onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, u.id] : prev.filter((x) => x !== u.id)))}
                  />
                  {u.name} <span className="text-xs text-gray-400">({ROLE_LABEL[u.role.key] ?? u.role.key})</span>
                </label>
              ))}
            </div>
            <div className="mt-4 border-t border-gray-100 pt-3" data-testid="region-audit">
              <h4 className="text-xs font-semibold text-gray-600 mb-1">Change history</h4>
              {audit === null && <p className="text-xs text-gray-400">Loading…</p>}
              {audit && audit.length === 0 && <p className="text-xs text-gray-400">No changes recorded yet.</p>}
              <ul className="max-h-32 overflow-y-auto space-y-1 text-xs text-gray-600">
                {audit?.map((a) => (
                  <li key={a.id}>{new Date(a.at).toLocaleString()} - {a.by}: {a.before.join(", ") || "nobody"} → {a.after.join(", ") || "nobody"}</li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button type="button" onClick={() => setManagersFor(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={saveManagers} disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? "Saving…" : "Save managers"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
