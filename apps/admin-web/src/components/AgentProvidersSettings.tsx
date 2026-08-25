"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface ProviderRow {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string | null;
  model: string;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ModelOption {
  id: string;
  label: string;
}

/** Curated presets so the user picks a provider by name, not by raw type+URL. "Custom" lets
 * them point at any other OpenAI-compatible endpoint not listed here. Base URLs confirmed
 * against each provider's own docs. */
const PROVIDER_PRESETS = [
  { key: "anthropic", label: "Anthropic", providerType: "anthropic", baseUrl: null as string | null },
  { key: "openai", label: "OpenAI", providerType: "openai_compatible", baseUrl: null },
  {
    key: "gemini",
    label: "Google Gemini",
    providerType: "openai_compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  { key: "groq", label: "Groq", providerType: "openai_compatible", baseUrl: "https://api.groq.com/openai/v1" },
  { key: "deepseek", label: "DeepSeek", providerType: "openai_compatible", baseUrl: "https://api.deepseek.com/v1" },
  { key: "openrouter", label: "OpenRouter", providerType: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1" },
  { key: "together", label: "Together AI", providerType: "openai_compatible", baseUrl: "https://api.together.xyz/v1" },
  { key: "custom", label: "Custom (OpenAI-compatible)", providerType: "openai_compatible", baseUrl: "" },
] as const;

const EMPTY_FORM = {
  id: null as string | null,
  presetKey: "anthropic" as string,
  name: "",
  providerType: "anthropic",
  apiKey: "",
  baseUrl: "" as string,
  model: "",
  priority: 0,
  isActive: true,
};

export default function AgentProvidersSettings() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("manage_settings");

  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelFetchState, setModelFetchState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [manualModelEntry, setManualModelEntry] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ providers: ProviderRow[] }>("/agent/providers");
      setProviders(data.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (canManage) load();
  }, [canManage, load]);

  if (!canManage) return null;

  function resetModelFetch() {
    setModelOptions([]);
    setModelFetchState("idle");
    setModelFetchError(null);
    setManualModelEntry(false);
  }

  function openAdd() {
    setForm({ ...EMPTY_FORM, priority: providers?.length ?? 0 });
    resetModelFetch();
    setShowForm(true);
  }

  function openEdit(p: ProviderRow) {
    const preset = PROVIDER_PRESETS.find((pr) => pr.providerType === p.providerType && pr.baseUrl === p.baseUrl);
    setForm({
      id: p.id,
      presetKey: preset?.key ?? "custom",
      name: p.name,
      providerType: p.providerType,
      apiKey: "",
      baseUrl: p.baseUrl ?? "",
      model: p.model,
      priority: p.priority,
      isActive: p.isActive,
    });
    resetModelFetch();
    setManualModelEntry(true); // editing: keep the existing model shown as text until they choose to re-fetch
    setShowForm(true);
  }

  function selectPreset(presetKey: string) {
    const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    setForm({
      ...form,
      presetKey,
      providerType: preset.providerType,
      baseUrl: preset.baseUrl ?? "",
      model: "",
    });
    resetModelFetch();
  }

  async function fetchModels() {
    if (!form.apiKey) {
      setModelFetchError("Paste your API key first.");
      setModelFetchState("failed");
      return;
    }
    setModelFetchState("loading");
    setModelFetchError(null);
    try {
      const result = await api<{ models: ModelOption[]; error?: string }>("/agent/providers/list-models", {
        method: "POST",
        body: JSON.stringify({ providerType: form.providerType, apiKey: form.apiKey, baseUrl: form.baseUrl || undefined }),
      });
      if (result.models.length === 0) {
        setModelFetchState("failed");
        setModelFetchError(result.error || "No models returned - you can type a model name manually.");
        setManualModelEntry(true);
      } else {
        setModelOptions(result.models);
        setModelFetchState("done");
        setManualModelEntry(false);
      }
    } catch (err) {
      setModelFetchState("failed");
      setModelFetchError(err instanceof Error ? err.message : String(err));
      setManualModelEntry(true);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        providerType: form.providerType,
        baseUrl: form.baseUrl || null,
        model: form.model,
        priority: Number(form.priority),
        isActive: form.isActive,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;

      if (form.id) {
        await api(`/agent/providers/${form.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        if (!form.apiKey) {
          setError("An API key is required when adding a new provider.");
          setSaving(false);
          return;
        }
        await api("/agent/providers", { method: "POST", body: JSON.stringify(payload) });
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this provider? This can't be undone.")) return;
    try {
      await api(`/agent/providers/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleActive(p: ProviderRow) {
    try {
      await api(`/agent/providers/${p.id}`, { method: "PUT", body: JSON.stringify({ isActive: !p.isActive }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="card p-4 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base sm:text-lg font-semibold">In-app agent - LLM providers</h2>
        <button className="btn-primary px-3 py-1.5 text-sm" onClick={openAdd}>
          + Add provider
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Add any provider&apos;s API key under your own label. The agent tries providers in
        priority order (lowest first) and automatically falls back to the next one if a call
        fails.
      </p>

      {error && (
        <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {providers === null ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : providers.length === 0 ? (
        <p className="text-sm text-gray-400">
          No providers configured yet - the agent can&apos;t run until at least one is added.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-3">Priority</th>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Model</th>
                <th className="py-2 pr-3">Active</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id} className="border-b border-gray-50">
                  <td className="py-2 pr-3">{p.priority}</td>
                  <td className="py-2 pr-3 font-medium">{p.name}</td>
                  <td className="py-2 pr-3 text-gray-500">{p.providerType}</td>
                  <td className="py-2 pr-3 text-gray-500">{p.model}</td>
                  <td className="py-2 pr-3">
                    <button onClick={() => toggleActive(p)} className={`badge ${p.isActive ? "badge-accent" : ""}`}>
                      {p.isActive ? "Active" : "Disabled"}
                    </button>
                  </td>
                  <td className="py-2 pr-3 text-right space-x-2">
                    <button className="text-xs text-gray-500 hover:text-gray-700" onClick={() => openEdit(p)}>
                      Edit
                    </button>
                    <button className="text-xs text-red-500 hover:text-red-700" onClick={() => remove(p.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <form onSubmit={save} className="mt-5 pt-5 border-t border-gray-100 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Label (your name for this key)">
              <input
                className="field w-full"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. My Gemini key, Groq fallback"
              />
            </Field>
            <Field label="Provider">
              <select className="field w-full" value={form.presetKey} onChange={(e) => selectPreset(e.target.value)}>
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {form.presetKey === "custom" && (
            <Field label="Endpoint URL">
              <input
                className="field w-full"
                required
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="https://your-provider.example.com/v1"
              />
            </Field>
          )}

          <Field label={form.id ? "API key (leave blank to keep existing)" : "API key"}>
            <div className="flex gap-2">
              <input
                type="password"
                className="field w-full"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={form.id ? "••••••••••••" : "Paste your API key"}
              />
              <button
                type="button"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg whitespace-nowrap hover:bg-gray-50"
                onClick={fetchModels}
                disabled={modelFetchState === "loading" || !form.apiKey}
              >
                {modelFetchState === "loading" ? "Loading…" : "Load models"}
              </button>
            </div>
            {modelFetchError && <p className="text-xs text-amber-600 mt-1">{modelFetchError}</p>}
          </Field>

          <Field label="Model">
            {!manualModelEntry && modelOptions.length > 0 ? (
              <select
                className="field w-full"
                required
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              >
                <option value="">Select a model…</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <div>
                <input
                  className="field w-full"
                  required
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="Paste your key and click Load models, or type a model name"
                />
                {modelOptions.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-emerald-600 mt-1"
                    onClick={() => setManualModelEntry(false)}
                  >
                    Choose from list instead
                  </button>
                )}
              </div>
            )}
          </Field>

          <div className="flex items-center gap-4">
            <Field label="Priority (lower is tried first)">
              <input
                type="number"
                className="field w-24"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm mt-5">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              Active
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="px-4 py-2 text-sm text-gray-500" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary px-4 py-2 text-sm">
              {saving ? "Saving…" : "Save provider"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
