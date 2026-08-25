"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

const ROLE_OPTIONS: { key: string; label: string }[] = [
  { key: "super_admin", label: "Super Admin" },
  { key: "owner_admin", label: "Owner / Admin" },
  { key: "management", label: "Management" },
  { key: "sales", label: "Sales" },
  { key: "operations_pm", label: "Operations / Project Manager" },
  { key: "erection_engineer", label: "Erection Engineer" },
  { key: "commissioning_engineer", label: "Commissioning Engineer" },
  { key: "service_team", label: "Service Team" },
  { key: "finance", label: "Finance" },
  { key: "customer", label: "Customer" },
];

export default function AgentVisibilitySettings() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_settings");

  const [selected, setSelected] = useState<string[] | null>(null);
  const [customInstructions, setCustomInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ agentVisibleRoleKeys?: string[]; agentCustomInstructions?: string | null }>("/settings");
      setSelected(data.agentVisibleRoleKeys ?? []);
      setCustomInstructions(data.agentCustomInstructions ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (canManage) load();
  }, [canManage, load]);

  if (!canManage || selected === null) return null;

  function toggle(key: string) {
    setSelected((prev) => (prev!.includes(key) ? prev!.filter((k) => k !== key) : [...prev!, key]));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ agentVisibleRoleKeys: selected, agentCustomInstructions: customInstructions }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-4 sm:p-6">
      <h2 className="text-base sm:text-lg font-semibold mb-1">In-app agent - visibility &amp; behavior</h2>
      <p className="text-sm text-gray-500 mb-4">
        Choose which roles see the floating chat assistant across the app. Nobody sees it
        until at least one role is selected here.
      </p>

      {error && (
        <p className="mb-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        {ROLE_OPTIONS.map((r) => (
          <label key={r.key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(r.key)} onChange={() => toggle(r.key)} />
            {r.label}
          </label>
        ))}
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium mb-1" htmlFor="agent-custom-instructions">
          Custom instructions
        </label>
        <p className="text-sm text-gray-500 mb-2">
          Free-text guidance appended to the assistant&apos;s instructions on every chat turn,
          e.g. &quot;always ask for the delivery address before drafting an invoice&quot;.
        </p>
        <textarea
          id="agent-custom-instructions"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          rows={4}
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          placeholder="e.g. Always confirm the delivery address before drafting an invoice."
        />
      </div>

      <button className="btn-primary px-4 py-2 text-sm" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </section>
  );
}
