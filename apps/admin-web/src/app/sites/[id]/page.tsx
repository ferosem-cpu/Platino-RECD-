"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface Lookup {
  id: string;
  key: string;
  label: string;
  phase?: string;
  sequenceOrder?: number;
}

interface SiteDetail {
  id: string;
  address: string | null;
  confirmedExhaustHookupType: string | null;
  order: { orderNumber: string; plannedExhaustHookupType: string | null; customer: { name: string } };
  currentStage: { id: string; label: string; phase: string };
  assignedEngineer: { name: string } | null;
  stageEvents: Array<{
    id: string;
    comment: string;
    createdAt: string;
    stageDefinition: { label: string };
    statusOption: { label: string };
    createdBy: { name: string };
  }>;
  photos: Array<{ id: string; photoUrl: string; checkpoint: { label: string }; uploadedAt: string }>;
  pendingActions: Array<{ id: string; description: string; status: string; category: string }>;
}

const EXHAUST_OPTIONS = [
  { value: "replace_existing_silencer", label: "Replace existing silencer with RECD" },
  { value: "add_after_existing_exhaust", label: "Add RECD after existing exhaust" },
];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("change_site_status");

  const [site, setSite] = useState<SiteDetail | null>(null);
  const [stages, setStages] = useState<Lookup[]>([]);
  const [statusOptions, setStatusOptions] = useState<Lookup[]>([]);
  const [checkpoints, setCheckpoints] = useState<Lookup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Update form
  const [stageId, setStageId] = useState("");
  const [statusId, setStatusId] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Exhaust confirm
  const [exhaustType, setExhaustType] = useState(EXHAUST_OPTIONS[0].value);
  const [matchesPlan, setMatchesPlan] = useState(true);
  const [submittingExhaust, setSubmittingExhaust] = useState(false);

  // Photos
  const [uploadingCheckpoint, setUploadingCheckpoint] = useState<string | null>(null);
  const photoInputRef = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const detail = await api<SiteDetail>(`/sites/${id}`);
      setSite(detail);
      setStageId((prev) => prev || detail.currentStage.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load site");
    }
  }, [id]);

  useEffect(() => {
    load();
    api<Lookup[]>("/meta/stages").then(setStages).catch(() => {});
    api<Lookup[]>("/meta/status-options").then((opts) => {
      setStatusOptions(opts);
      if (opts.length) setStatusId((prev) => prev || opts[0].id);
    }).catch(() => {});
    api<Lookup[]>("/meta/photo-checkpoints").then(setCheckpoints).catch(() => {});
  }, [load]);

  function flash(message: string) {
    setBanner(message);
    setTimeout(() => setBanner(null), 4000);
  }

  async function submitUpdate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/sites/${id}/stage-events`, {
        method: "POST",
        body: JSON.stringify({ stageDefinitionId: stageId, statusOptionId: statusId, comment }),
      });
      setComment("");
      flash("Update posted.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post update");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitExhaust(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingExhaust(true);
    setError(null);
    try {
      const res = await api<{ pendingAction: unknown | null }>(`/sites/${id}/confirm-exhaust-hookup`, {
        method: "POST",
        body: JSON.stringify({ confirmedExhaustHookupType: exhaustType, matchesPlan }),
      });
      flash(
        res.pendingAction
          ? "Mismatch recorded - sent to the customer to decide."
          : "Exhaust hookup confirmed.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm exhaust hookup");
    } finally {
      setSubmittingExhaust(false);
    }
  }

  async function uploadPhoto(checkpointId: string, file: File) {
    setUploadingCheckpoint(checkpointId);
    setError(null);
    try {
      const photoUrl = await fileToDataUrl(file);
      await api(`/sites/${id}/photos`, {
        method: "POST",
        body: JSON.stringify({ checkpointId, photoUrl }),
      });
      flash("Photo uploaded.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload photo");
    } finally {
      setUploadingCheckpoint(null);
    }
  }

  if (error && !site) return <p className="text-sm text-red-600">{error}</p>;
  if (!site) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-6 max-w-4xl" data-testid="site-detail-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold">{site.order.orderNumber}</h1>
        <p className="text-sm text-gray-500">
          {site.order.customer.name} · {site.address ?? "No address on file"}
        </p>
        <p className="text-sm text-gray-500">
          Current stage: <span className="font-medium">{site.currentStage.label}</span> ({site.currentStage.phase}) ·
          Engineer: {site.assignedEngineer?.name ?? "Unassigned"}
        </p>
        <p className="text-sm text-gray-500">
          Exhaust hookup - planned: {site.order.plannedExhaustHookupType ?? "-"}, confirmed:{" "}
          {site.confirmedExhaustHookupType ?? "awaiting confirmation"}
        </p>
      </div>

      {banner && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{banner}</div>
      )}
      {error && site && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}

      {site.pendingActions.filter((p) => p.status === "open").length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-sm font-medium text-amber-800">Open pending actions</h2>
          <ul className="space-y-1 text-sm text-amber-900">
            {site.pendingActions
              .filter((p) => p.status === "open")
              .map((p) => (
                <li key={p.id}>· {p.description}</li>
              ))}
          </ul>
        </section>
      )}

      {/* ── Field actions (only roles that can change site status) ──────────── */}
      {canEdit && (
        <section className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Post a status update</h2>
          <form onSubmit={submitUpdate} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Stage</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Status</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={statusId}
                  onChange={(e) => setStatusId(e.target.value)}
                >
                  {statusOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Comment</label>
              <textarea
                required
                rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="What happened on site?"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
            <button type="submit" disabled={submitting} className="btn-primary px-4 py-2 text-sm">
              {submitting ? "Posting…" : "Post update"}
            </button>
          </form>
        </section>
      )}

      {/* ── Exhaust hookup confirmation ─────────────────────────────────────── */}
      {canEdit && !site.confirmedExhaustHookupType && (
        <section className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold">Confirm exhaust hookup</h2>
          <p className="text-xs text-gray-500">
            Confirm what works on site. If it doesn&apos;t match the sales plan, it&apos;s sent to the
            customer to decide (keep existing exhaust, or replace with the RECD).
          </p>
          <form onSubmit={submitExhaust} className="space-y-3">
            <select
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={exhaustType}
              onChange={(e) => setExhaustType(e.target.value)}
            >
              {EXHAUST_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={matchesPlan} onChange={(e) => setMatchesPlan(e.target.checked)} />
              This matches the planned hookup
            </label>
            <button type="submit" disabled={submittingExhaust} className="btn-primary px-4 py-2 text-sm">
              {submittingExhaust ? "Saving…" : "Confirm hookup"}
            </button>
          </form>
        </section>
      )}

      {/* ── Photo checkpoints ───────────────────────────────────────────────── */}
      {canEdit && checkpoints.length > 0 && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold mb-3">Upload checkpoint photos</h2>
          <div className="flex flex-wrap gap-3">
            {checkpoints.map((c) => (
              <div key={c.id}>
                <input
                  ref={(el) => { photoInputRef.current[c.id] = el; }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadPhoto(c.id, f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current[c.id]?.click()}
                  disabled={uploadingCheckpoint === c.id}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  {uploadingCheckpoint === c.id ? "Uploading…" : `+ ${c.label}`}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-600">Stage timeline</h2>
        <ol className="space-y-3">
          {site.stageEvents.map((e) => (
            <li key={e.id} className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
              <div className="font-medium">
                {e.stageDefinition.label} - {e.statusOption.label}
              </div>
              <div className="text-gray-600">{e.comment}</div>
              <div className="mt-1 text-xs text-gray-400">
                {e.createdBy.name} · {new Date(e.createdAt).toLocaleString()}
              </div>
            </li>
          ))}
          {site.stageEvents.length === 0 && <p className="text-sm text-gray-400">No updates yet.</p>}
        </ol>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-600">Photos</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {site.photos.map((p) => (
            <a key={p.id} href={p.photoUrl} target="_blank" rel="noreferrer" className="block">
              <img src={p.photoUrl} alt={p.checkpoint.label} className="h-24 w-full rounded object-cover" />
              <div className="mt-1 text-xs text-gray-500">{p.checkpoint.label}</div>
            </a>
          ))}
          {site.photos.length === 0 && <p className="text-sm text-gray-400">No photos uploaded yet.</p>}
        </div>
      </section>
    </div>
  );
}
