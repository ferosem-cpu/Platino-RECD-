"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/apiClient";

interface SiteDetail {
  id: string;
  address: string | null;
  confirmedExhaustHookupType: string | null;
  order: { orderNumber: string; plannedExhaustHookupType: string | null; customer: { name: string } };
  currentStage: { label: string; phase: string };
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

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SiteDetail>(`/sites/${id}`)
      .then(setSite)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load site"));
  }, [id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!site) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{site.order.orderNumber}</h1>
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
        <div className="grid grid-cols-4 gap-3">
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
