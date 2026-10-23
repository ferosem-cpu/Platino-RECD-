"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

/** Ticket SLA windows: when an unresolved ticket alerts the Regional Manager, then Management. */
export default function SlaSettings() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_settings");
  const [rm, setRm] = useState("24");
  const [mg, setMg] = useState("48");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!canManage) return;
    api<{ slaRegionalManagerHours?: number; slaManagementHours?: number }>("/settings")
      .then((s) => {
        setRm(String(s.slaRegionalManagerHours ?? 24));
        setMg(String(s.slaManagementHours ?? 48));
      })
      .catch(() => undefined);
  }, [canManage]);

  if (!canManage) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api("/settings/sla", {
        method: "PUT",
        body: JSON.stringify({ slaRegionalManagerHours: Number(rm), slaManagementHours: Number(mg) }),
      });
      setMsg({ ok: true, text: "Saved" });
    } catch (err) {
      setMsg({ ok: false, text: "Could not save — management hours must be at or after the Regional Manager hours (1–720 / 1–1440)." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 sm:p-6" data-testid="sla-settings">
      <h2 className="text-base font-semibold text-gray-900">Ticket SLA escalation</h2>
      <p className="mt-1 mb-4 text-sm text-gray-500">
        An unresolved service ticket alerts the Regional Manager of its region after the first window, then Management after the
        second. Tickets that are resolved, closed or waiting for the customer are not escalated. Checked daily.
      </p>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Regional Manager after (hours)</label>
            <input type="number" min={1} max={720} required value={rm} onChange={(e) => setRm(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Management after (hours)</label>
            <input type="number" min={1} max={1440} required value={mg} onChange={(e) => setMg(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>
        {msg && <p className={`text-sm ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</p>}
        <button type="submit" disabled={saving} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ backgroundColor: "var(--theme-primary)" }}>
          {saving ? "Saving…" : "Save SLA"}
        </button>
      </form>
    </section>
  );
}
